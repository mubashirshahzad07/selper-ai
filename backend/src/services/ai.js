// backend/src/services/ai.js
// Manus is the sole AI provider. Every function here does ONE narrowly scoped
// task and returns structured data.
//
// IMPORTANT ARCHITECTURAL NOTE (read before touching this file):
// Manus's API is agent-task based, not a synchronous completion API like
// Gemini's generateContent. Every call here does task.create -> poll
// task.listMessages until the agent stops -> read the result. That means:
//   - Calls are slow relative to a raw LLM completion (agent-task latency,
//     often many seconds to a couple of minutes), not "type a prompt, get
//     text back in 1-2s". Interactive call sites (e.g. right-click word
//     definitions) will feel this.
//   - There's no native "JSON mode" — instead we use Manus's
//     `structured_output_schema` (see https://open.manus.im/docs/v2/structured-output),
//     which guarantees the result conforms to a JSON Schema (or reports
//     success:false with a zero-value fallback). This is *more* reliable
//     than the old parseJsonLoose() recovery hacks, so those are gone.
//   - There's no per-minute rate limit to throttle against like Gemini's
//     free tier; instead Manus caps *concurrent* tasks per account
//     (MANUS_MAX_CONCURRENT_TASKS below), so we use a small concurrency
//     pool instead of a fixed inter-call delay.
//   - Vision/OCR (extractTextFromImage) is done by attaching the image as a
//     file part on the task instead of calling a model built specifically
//     for OCR. Word-level bounding-box accuracy is unverified — test this
//     against real scanned pages before trusting it the way the old Gemini
//     vision OCR was trusted.

import fetch from "node-fetch";

const API_BASE = process.env.MANUS_API_BASE || "https://api.manus.ai/v2";

// "lite" is Manus's stable alias for its lightweight agent tier — currently
// Manus Lite 1.6. Versioned aliases like "1.6-lite" are also accepted by the
// API but the version segment is ignored (you can't pin a specific point
// version independently), so "lite" is the correct, forward-compatible value.
const DEFAULT_AGENT_PROFILE = process.env.MANUS_AGENT_PROFILE || "lite";

function apiKey() {
  const key = process.env.MANUS_API_KEY;
  if (!key) {
    const err = new Error(
      "MANUS_API_KEY is not set. Add it to your .env file — see .env.example."
    );
    err.code = "NO_API_KEY";
    throw err;
  }
  return key;
}

function authHeaders() {
  return { "Content-Type": "application/json", "x-manus-api-key": apiKey() };
}

// ---------------------------------------------------------------------------
// Concurrency pool — Manus caps concurrent tasks per account (commonly 20),
// not requests-per-minute. We serialize through a small pool so loops like
// the sequential free-text grading in quizzes.js, or a burst of key-term /
// summary calls, never pile up more in-flight tasks than the account allows.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_TASKS = Number(process.env.MANUS_MAX_CONCURRENT_TASKS) || 2;
let activeTasks = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeTasks < MAX_CONCURRENT_TASKS) {
    activeTasks++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve)).then(() => {
    activeTasks++;
  });
}

function releaseSlot() {
  activeTasks--;
  const next = waitQueue.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Rate limiter for task.create — Manus limits this to 10/min. We track
// timestamps of recent task.create calls and delay if we'd exceed the limit.
// ---------------------------------------------------------------------------
const TASK_CREATE_LIMIT_PER_MIN = 10;
const taskCreateTimestamps = [];

async function waitForRateLimit() {
  const now = Date.now();
  // Remove timestamps older than 60 seconds
  while (taskCreateTimestamps.length > 0 && taskCreateTimestamps[0] < now - 60000) {
    taskCreateTimestamps.shift();
  }
  // If we're at the limit, wait until the oldest timestamp expires
  if (taskCreateTimestamps.length >= TASK_CREATE_LIMIT_PER_MIN) {
    const waitMs = taskCreateTimestamps[0] + 60000 - now;
    if (waitMs > 0) {
      console.warn(`[AI] Rate limit: waiting ${Math.ceil(waitMs / 1000)}s before next task.create`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  taskCreateTimestamps.push(Date.now());
}

/**
 * Create a Manus task. `imageData` (optional): { mimeType, data (base64) },
 * attached as a file content part for vision/OCR calls. `schema` (optional):
 * a JSON Schema per Manus's Structured Output subset — when present, the
 * task's result is guaranteed to conform to it (or reports success:false).
 */
async function createTask({ prompt, imageData = null, schema = null, agentProfile = null }) {
  // Enforce Manus's 10/min task.create rate limit before making the call.
  await waitForRateLimit();

  const content = [{ type: "text", text: prompt }];
  if (imageData) {
    // File content part: inline base64, capped at 20MB decoded per Manus's
    // task.create docs. Larger assets would need file.upload + file_id instead.
    content.push({ type: "file", file_data: imageData.data, mime_type: imageData.mimeType });
  }

  const body = {
    message: { content },
    agent_profile: agentProfile || DEFAULT_AGENT_PROFILE,
    // These are backend-triggered utility calls, not tasks a person should
    // see cluttering their Manus task list.
    hide_in_task_list: true,
  };
  if (schema) body.structured_output_schema = schema;

  const res = await fetch(`${API_BASE}/task.create`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Manus task.create failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Manus task.create returned an error: ${data?.error?.message || "unknown error"}`);
  }
  return data.task_id;
}

/**
 * Poll task.listMessages until the agent stops (or errors/times out) and
 * return either the structured_output_result value (if a schema was passed)
 * or the plain assistant_message text.
 */
async function pollTask(taskId, { timeoutMs = 90000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${API_BASE}/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=20`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Manus task.listMessages failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const events = data.events || data.messages || [];
    const statusEvent = events.find((e) => e.type === "status_update");
    const status = statusEvent?.status_update?.agent_status;

    if (status === "error") {
      throw new Error(`Manus task ${taskId} failed: ${statusEvent?.status_update?.error_message || "unknown error"}`);
    }

    if (status === "waiting") {
      // None of these calls should ever need user confirmation (no
      // connectors/skills enabled) — if this fires, something upstream
      // changed and the caller needs to know rather than hang forever.
      throw new Error(`Manus task ${taskId} unexpectedly requested user input.`);
    }

    if (status === "stopped") {
      const structured = events.find((e) => e.type === "structured_output_result");
      if (structured) {
        const result = structured.structured_output_result;
        if (!result.success) {
          throw new Error(`Manus structured output extraction failed: ${result.error}`);
        }
        return result.value;
      }
      // No schema was requested — fall back to the plain assistant text.
      const assistantMsg = [...events].reverse().find((e) => e.type === "assistant_message");
      const parts = assistantMsg?.assistant_message?.content;
      const text = Array.isArray(parts)
        ? parts.map((p) => p.text).filter(Boolean).join("\n")
        : assistantMsg?.assistant_message?.text ?? "";
      return { __text: text };
    }

    // status === "running" (or missing while the task spins up) — keep polling.
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Manus task ${taskId} timed out after ${timeoutMs}ms.`);
}

/** Create + poll a Manus task through the concurrency pool. */
async function runManusTask(opts, pollOpts) {
  await acquireSlot();
  try {
    const taskId = await createTask(opts);
    return await pollTask(taskId, pollOpts);
  } finally {
    releaseSlot();
  }
}

/** Retry wrapper for Manus calls that may fail due to transient issues. */
async function runManusTaskWithRetry(opts, pollOpts, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runManusTask(opts, pollOpts);
    } catch (err) {
      lastErr = err;
      // Don't retry on client errors (4xx) or user-input requests.
      if (err.status && err.status < 500) throw err;
      if (err.message.includes("unexpectedly requested user input")) throw err;
      // Log retry attempt for debugging.
      console.warn(`[AI] Manus call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      if (attempt < maxRetries) {
        // Exponential backoff: 3s, 9s, 27s...
        await new Promise((r) => setTimeout(r, 3000 * Math.pow(3, attempt)));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 1. Key-term extraction
// ---------------------------------------------------------------------------
const KEY_TERMS_SCHEMA = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          why: { type: "string" },
        },
        required: ["term", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["terms"],
  additionalProperties: false,
};

export async function extractKeyTerms(sourceText) {
  const prompt = `From the following study material, extract the 6-10 most important key terms a student should know.

MATERIAL:
"""${sourceText.slice(0, 12000)}"""`;

  const value = await runManusTask(
    { prompt, schema: KEY_TERMS_SCHEMA },
    { timeoutMs: 60000 }
  );
  return value.terms ?? [];
}

// ---------------------------------------------------------------------------
// 2. Word sense resolution (for Wikipedia lookup) + Urdu translation
// ---------------------------------------------------------------------------
const WORD_SENSE_SCHEMA = {
  type: "object",
  properties: {
    searchTitle: { type: "string" },
    sense: { type: "string" },
    definition: { type: "string" },
  },
  required: ["searchTitle", "sense", "definition"],
  additionalProperties: false,
};

export async function resolveWordSense(word, surroundingContext) {
  const prompt = `A student right-clicked the word "${word}" while reading the passage below.
1. Determine the single most likely intended sense of this word IN THIS CONTEXT, phrased as a
   short Wikipedia-searchable article title (e.g. "Return statement" not "return").
2. Write a concise, plain-language definition of the word AS USED HERE — 2 to 3 short sentences,
   like a helpful chat answer. Do not write an essay.

PASSAGE:
"""${surroundingContext.slice(0, 2000)}"""`;

  return runManusTask({ prompt, schema: WORD_SENSE_SCHEMA }, { timeoutMs: 60000 });
}

const URDU_SCHEMA = {
  type: "object",
  properties: { urdu: { type: "string" } },
  required: ["urdu"],
  additionalProperties: false,
};

export async function translateToUrdu(text) {
  const prompt = `Translate the following text into natural, academically appropriate Urdu.

TEXT:
"""${text.slice(0, 4000)}"""`;

  const value = await runManusTask({ prompt, schema: URDU_SCHEMA }, { timeoutMs: 60000 });
  return value.urdu ?? "";
}

// ---------------------------------------------------------------------------
// 3. Sentence / passage summary
// ---------------------------------------------------------------------------
const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

export async function summarizePassage(passage, surroundingContext) {
  const prompt = `Summarize the SELECTED passage below in 2-3 clear sentences, grounded strictly in the
source material. Do not introduce outside facts. Use the surrounding context only to disambiguate meaning.

SURROUNDING CONTEXT:
"""${surroundingContext.slice(0, 3000)}"""

SELECTED PASSAGE:
"""${passage.slice(0, 3000)}"""`;

  const value = await runManusTask({ prompt, schema: SUMMARY_SCHEMA }, { timeoutMs: 60000 });
  return value.summary ?? "";
}

// ---------------------------------------------------------------------------
// 4. Structured quiz generation
// ---------------------------------------------------------------------------
const MCQ_QUIZ_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          topic: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctIndex: { type: "integer" },
          explanation: { type: "string" },
        },
        required: ["question", "topic", "options", "correctIndex", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

const FREE_TEXT_QUIZ_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          topic: { type: "string" },
          modelAnswer: { type: "string" },
          gradingCriteria: { type: "array", items: { type: "string" } },
        },
        required: ["question", "topic", "modelAnswer", "gradingCriteria"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

export async function generateQuiz(sourceText, count = 5, mode = "mcq") {
  if (mode === "freeText") {
    const prompt = `Create ${count} short-answer / free-text quiz questions grounded ONLY in the study material below.
Each question should test understanding of a specific concept. Provide a model answer and key grading criteria.

MATERIAL:
"""${sourceText.slice(0, 12000)}"""`;

    const value = await runManusTask(
      { prompt, schema: FREE_TEXT_QUIZ_SCHEMA },
      { timeoutMs: 120000 }
    );
    return (value.questions ?? [])
      .filter((q) => q && typeof q.question === "string" && typeof q.topic === "string")
      .slice(0, count);
  }

  // MCQ mode (default)
  const prompt = `Create a ${count}-question multiple-choice quiz grounded ONLY in the study material below.
Each question needs exactly 4 options and one correct answer. Vary difficulty. Avoid trivial phrasing matches.
Tag each question with its underlying concept/topic for learning analytics.

MATERIAL:
"""${sourceText.slice(0, 12000)}"""`;

  const value = await runManusTask({ prompt, schema: MCQ_QUIZ_SCHEMA }, { timeoutMs: 120000 });
  const questions = value.questions ?? [];

  // Validate shape defensively — grading must never depend on a second AI call.
  return questions
    .filter(
      (q) =>
        q &&
        typeof q.question === "string" &&
        typeof q.topic === "string" &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        Number.isInteger(q.correctIndex) &&
        q.correctIndex >= 0 &&
        q.correctIndex < 4
    )
    .slice(0, count);
}

// ---------------------------------------------------------------------------
// 5. Follow-up question — one retest of the SAME concept after a wrong answer.
// ---------------------------------------------------------------------------
const FOLLOW_UP_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    correctIndex: { type: "integer" },
    explanation: { type: "string" },
  },
  required: ["question", "options", "correctIndex", "explanation"],
  additionalProperties: false,
};

export async function generateFollowUpQuestion(sourceText, originalQuestion) {
  const prompt = `A student answered this quiz question incorrectly:
"${originalQuestion.question}"
(Correct answer was: "${originalQuestion.options[originalQuestion.correctIndex]}")

Write ONE new multiple-choice question that retests the SAME underlying concept from the study
material below, using different wording or a different example so it isn't just a repeat.
Exactly 4 options, one correct.

MATERIAL:
"""${sourceText.slice(0, 8000)}"""`;

  const parsed = await runManusTask({ prompt, schema: FOLLOW_UP_SCHEMA }, { timeoutMs: 90000 });

  if (
    !parsed ||
    typeof parsed.question !== "string" ||
    !Array.isArray(parsed.options) ||
    parsed.options.length !== 4 ||
    !Number.isInteger(parsed.correctIndex)
  ) {
    throw new Error("Follow-up question generation returned an invalid shape.");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 6. Image transcription (OCR) — attaches the image as a file part on the
// task instead of calling a dedicated vision-OCR model. Word-level bbox
// accuracy is NOT verified against Manus's actual behavior — test this
// against real scanned pages before relying on it the way the previous
// Gemini vision pipeline was relied on.
// ---------------------------------------------------------------------------
const OCR_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          bbox: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
            required: ["x", "y", "w", "h"],
            additionalProperties: false,
          },
        },
        required: ["text", "bbox"],
        additionalProperties: false,
      },
    },
  },
  required: ["text", "words"],
  additionalProperties: false,
};

/**
 * Image transcription with word-level bounding boxes so the frontend can
 * build a selectable text layer over the original image. Returns:
 *   { text: "full plain text", words: [{ text: "...", bbox: {x,y,w,h} }] }
 * where bbox coordinates are normalised 0-1 relative to the image dimensions.
 */
export async function extractTextFromImage(base64Data, mimeType) {
  const prompt = `Transcribe every readable word in the attached image with its position.
Rules:
- "x" and "y" are the top-left corner of the word's bounding box; "w" and "h" are width and height.
- All bbox values are normalised 0-1 relative to the image width/height.
- Include every readable word, in reading order.
- If nothing is legible, return an empty transcription and an empty words list.`;

  const value = await runManusTask(
    { prompt, imageData: { mimeType, data: base64Data }, schema: OCR_SCHEMA },
    { timeoutMs: 120000 }
  );

  const words = normaliseWords(value?.words);
  const text = typeof value?.text === "string" && value.text.trim() ? value.text : words.map((w) => w.text).join(" ");

  return { text, words };
}

/** Validate a parsed `words` array from the structured-output shape. */
function normaliseWords(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => w && typeof w.text === "string" && w.bbox)
    .map((w) => ({
      text: w.text,
      bbox: {
        x: Number(w.bbox.x) || 0,
        y: Number(w.bbox.y) || 0,
        w: Number(w.bbox.w) || 0,
        h: Number(w.bbox.h) || 0,
      },
    }));
}

// ---------------------------------------------------------------------------
// 7. Free-text answer grading — compares student response against model answer
// and grading criteria, returns a score (0-1) and detailed feedback.
// ---------------------------------------------------------------------------
const GRADE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    feedback: { type: "string" },
    matchedCriteria: { type: "array", items: { type: "string" } },
    missedCriteria: { type: "array", items: { type: "string" } },
  },
  required: ["score", "feedback", "matchedCriteria", "missedCriteria"],
  additionalProperties: false,
};

export async function gradeFreeTextAnswer(studentAnswer, question) {
  const prompt = `Grade this student's free-text answer against the model answer and grading criteria.
Be fair but precise — reward partial understanding with proportional credit. Score should be 0.0 to 1.0.

QUESTION: "${question.question}"
TOPIC: "${question.topic}"
MODEL ANSWER: "${question.modelAnswer}"
GRADING CRITERIA: ${JSON.stringify(question.gradingCriteria)}
STUDENT ANSWER: "${studentAnswer}"`;

  console.log(`[AI] Grading free-text answer for question: "${question.question.slice(0, 60)}..."`);
  const t0 = Date.now();

  try {
    const parsed = await runManusTaskWithRetry({ prompt, schema: GRADE_SCHEMA }, { timeoutMs: 90000 });
    console.log(`[AI] Grading completed in ${Date.now() - t0}ms`);

    if (!parsed || typeof parsed.score !== "number" || typeof parsed.feedback !== "string") {
      throw new Error("Free-text grading returned an invalid shape.");
    }

    return {
      score: Math.max(0, Math.min(1, parsed.score)),
      feedback: parsed.feedback,
      matchedCriteria: Array.isArray(parsed.matchedCriteria) ? parsed.matchedCriteria : [],
      missedCriteria: Array.isArray(parsed.missedCriteria) ? parsed.missedCriteria : [],
    };
  } catch (err) {
    console.error(`[AI] Grading failed after ${Date.now() - t0}ms: ${err.message}`);
    throw err;
  }
}
