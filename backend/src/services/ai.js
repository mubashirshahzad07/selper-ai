// backend/src/services/ai.js
// Every function here does ONE narrowly scoped task and returns structured
// data. The actual provider call is delegated to ./providers/{gemini,manus}.js
// — this file just owns the prompts, schemas, and per-function validation.
//
// PROVIDER SPLIT:
//   Gemini -> extractTextFromImage (OCR), resolveWordSense (Definitions),
//             translateToUrdu, summarizePassage, extractKeyTerms,
//             gradeFreeTextAnswer
//   Manus  -> generateQuiz, generateFollowUpQuestion (Quiz Generation)
//
// This was requested as "Gemini for OCR and Definitions, Manus for Quiz
// Generation." The four functions above that aren't literally OCR or
// word-Definitions (translate/summarize/key-terms/grading) are grouped with
// Gemini rather than Manus, since they're all fast, on-demand/interactive
// calls in the same latency class as OCR and Definitions — the same reason
// quiz generation fits Manus's slower agent-task model but a right-click
// lookup doesn't. If you'd rather any of those ride on Manus instead, they're
// a one-line change (swap the `geminiComplete`/`geminiCompleteWithRetry` call
// for `manusComplete`/`manusCompleteWithRetry`, same schema/prompt).
//
// Gemini's generateContent is a synchronous completion call — fast (~1-3s),
// schema-guaranteed JSON via responseSchema, inline base64 for vision.
// Manus's API is agent-task based — task.create -> poll task.listMessages
// until the agent stops, which is much slower (seconds to a couple of
// minutes) but fine for quiz generation, which already runs after a
// deliberate "generate my quiz" click rather than needing a snappy response.

import { geminiComplete, geminiCompleteWithRetry } from "./providers/gemini.js";
import { manusComplete, manusCompleteWithRetry } from "./providers/manus.js";

// ---------------------------------------------------------------------------
// 1. Key-term extraction — Gemini
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
      },
    },
  },
  required: ["terms"],
};

export async function extractKeyTerms(sourceText) {
  const prompt = `From the following study material, extract the 6-10 most important key terms a student should know.
Be concise — each "why" explanation should be one short sentence (max 15 words).

MATERIAL:
"""${sourceText.slice(0, 8000)}"""`;

  const { value } = await geminiComplete({ prompt, schema: KEY_TERMS_SCHEMA, timeoutMs: 20000, maxOutputTokens: 512 });
  return value.terms ?? [];
}

// ---------------------------------------------------------------------------
// 2. Word sense resolution (Definitions) — Gemini
// ---------------------------------------------------------------------------
const WORD_SENSE_SCHEMA = {
  type: "object",
  properties: {
    searchTitle: { type: "string" },
    sense: { type: "string" },
    definition: { type: "string" },
  },
  required: ["searchTitle", "sense", "definition"],
};

export async function resolveWordSense(word, surroundingContext) {
  const prompt = `A student right-clicked the word "${word}" while reading the passage below.
1. Determine the single most likely intended sense of this word IN THIS CONTEXT, phrased as a
   short Wikipedia-searchable article title (e.g. "Return statement" not "return").
2. Write a concise definition — 1-2 sentences max, no essay.

PASSAGE:
"""${surroundingContext.slice(0, 1500)}"""`;

  const { value } = await geminiComplete({ prompt, schema: WORD_SENSE_SCHEMA, timeoutMs: 15000, maxOutputTokens: 256 });
  return value;
}

// ---------------------------------------------------------------------------
// 3. Urdu translation — Gemini
// ---------------------------------------------------------------------------
const URDU_SCHEMA = {
  type: "object",
  properties: { urdu: { type: "string" } },
  required: ["urdu"],
};

export async function translateToUrdu(text) {
  const prompt = `Translate the following text into natural, academically appropriate Urdu.
Keep the translation concise — match the original length closely.

TEXT:
"""${text.slice(0, 3000)}"""`;

  const { value } = await geminiComplete({ prompt, schema: URDU_SCHEMA, timeoutMs: 20000, maxOutputTokens: 512 });
  return value.urdu ?? "";
}

// ---------------------------------------------------------------------------
// 4. Sentence / passage summary — Gemini
// ---------------------------------------------------------------------------
const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};

export async function summarizePassage(passage, surroundingContext) {
  const prompt = `Summarize the SELECTED passage below in 2-3 clear sentences max.
Be concise — do not exceed 3 sentences. Ground strictly in the source material.

SURROUNDING CONTEXT:
"""${surroundingContext.slice(0, 2000)}"""

SELECTED PASSAGE:
"""${passage.slice(0, 2000)}"""`;

  const { value } = await geminiComplete({ prompt, schema: SUMMARY_SCHEMA, timeoutMs: 15000, maxOutputTokens: 256 });
  return value.summary ?? "";
}

// ---------------------------------------------------------------------------
// 5. Structured quiz generation — Manus ("Quiz Generation")
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
    const prompt = `Create ${count} short-answer quiz questions grounded ONLY in the study material below.
Be concise — keep model answers to 1-2 sentences and grading criteria to 2-3 brief bullet points.

MATERIAL:
"""${sourceText.slice(0, 8000)}"""`;

    const { value } = await manusCompleteWithRetry({ prompt, schema: FREE_TEXT_QUIZ_SCHEMA, timeoutMs: 90000 });
    return (value.questions ?? [])
      .filter((q) => q && typeof q.question === "string" && typeof q.topic === "string")
      .slice(0, count);
  }

  // MCQ mode (default)
  const prompt = `Create a ${count}-question MCQ quiz grounded ONLY in the study material below.
Each question: exactly 4 options, one correct. Keep explanations to one sentence max.
Vary difficulty. Tag each with its concept/topic.

MATERIAL:
"""${sourceText.slice(0, 8000)}"""`;

  const { value } = await manusCompleteWithRetry({ prompt, schema: MCQ_QUIZ_SCHEMA, timeoutMs: 90000 });
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
// 6. Follow-up question — Manus (retests the SAME concept; part of Quiz Generation)
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
  const prompt = `Student got this wrong: "${originalQuestion.question}"
(Correct: "${originalQuestion.options[originalQuestion.correctIndex]}")

Write ONE new MCQ retesting the SAME concept with different wording.
Keep explanation to one sentence max. Exactly 4 options, one correct.

MATERIAL:
"""${sourceText.slice(0, 6000)}"""`;

  const { value: parsed } = await manusCompleteWithRetry({ prompt, schema: FOLLOW_UP_SCHEMA, timeoutMs: 60000 });

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
// 7. Image transcription (OCR) — Gemini
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
          },
        },
        required: ["text", "bbox"],
      },
    },
  },
  required: ["text", "words"],
};

/**
 * Image transcription with word-level bounding boxes so the frontend can
 * build a selectable text layer over the original image. Returns:
 *   { text: "full plain text", words: [{ text: "...", bbox: {x,y,w,h} }] }
 * where bbox coordinates are normalised 0-1 relative to the image dimensions.
 *
 * Note: the client also runs Tesseract.js locally as a fallback for
 * bounding boxes (see frontend/index.html) since OCR coordinate accuracy
 * varies — don't remove that fallback when touching this function.
 */
export async function extractTextFromImage(base64Data, mimeType) {
  const prompt = `Transcribe every readable word in the attached image with its position.
Rules:
- "x" and "y" are the top-left corner of the word's bounding box; "w" and "h" are width and height.
- All bbox values are normalised 0-1 relative to the image width/height.
- Include every readable word, in reading order.
- If nothing is legible, return an empty transcription and an empty words list.`;

  const { value } = await geminiComplete({
    prompt,
    imageData: { mimeType, data: base64Data },
    schema: OCR_SCHEMA,
    timeoutMs: 45000,
  });

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
// 8. Free-text answer grading — Gemini
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
};

export async function gradeFreeTextAnswer(studentAnswer, question) {
  const prompt = `Grade this student's free-text answer. Be concise in feedback (2-3 sentences max).
Score 0.0-1.0 based on how well the answer matches the criteria.

QUESTION: "${question.question}"
MODEL ANSWER: "${question.modelAnswer}"
CRITERIA: ${JSON.stringify(question.gradingCriteria)}
STUDENT: "${studentAnswer}"`;

  console.log(`[AI] Grading: "${question.question.slice(0, 60)}..."`);
  const t0 = Date.now();

  try {
    const { value: parsed } = await geminiCompleteWithRetry({ prompt, schema: GRADE_SCHEMA, timeoutMs: 20000, maxOutputTokens: 512 });
    console.log(`[AI] Grade done in ${Date.now() - t0}ms`);

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
