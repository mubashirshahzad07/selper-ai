// backend/src/services/ai.js
// Gemini is the sole AI provider (PRD 6.1). No multi-provider abstraction.
// Every function here does ONE narrowly scoped task and returns structured data.

import fetch from "node-fetch";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error(
      "GEMINI_API_KEY is not set. Add it to your .env file — see .env.example."
    );
    err.code = "NO_API_KEY";
    throw err;
  }
  return key;
}

/**
 * Low-level call to a Gemini model. Returns the raw text of the first candidate.
 * imageData (optional): { mimeType, data (base64) } — sent as an inline vision
 * part alongside the text prompt, for OCR / image transcription calls.
 */
async function callGemini(model, { systemInstruction, prompt, jsonMode = false, imageData = null }) {
  const url = `${API_BASE}/${model}:generateContent?key=${apiKey()}`;

  const parts = imageData
    ? [{ inlineData: { mimeType: imageData.mimeType, data: imageData.data } }, { text: prompt }]
    : [{ text: prompt }];

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      // Gemini 3.x docs recommend NOT overriding temperature/top_p/top_k — its
      // reasoning is tuned for the defaults, so we no longer set temperature here.
      maxOutputTokens: 2048,
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Gemini ${model} request failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("") ?? "";
  if (!text) {
    const err = new Error(`Gemini ${model} returned no content (possibly blocked).`);
    err.code = "EMPTY_RESPONSE";
    throw err;
  }
  return text;
}

/**
 * Try a primary model, then a fallback model, on failure or timeout.
 */
async function withFallback(primaryModel, fallbackModel, opts, timeoutMs = 30000) {
  const attempt = (model) =>
    Promise.race([
      callGemini(model, opts),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Gemini ${model} timed out`)), timeoutMs)
      ),
    ]);

  try {
    return await attempt(primaryModel);
  } catch (primaryErr) {
    if (!fallbackModel || fallbackModel === primaryModel) throw primaryErr;
    try {
      return await attempt(fallbackModel);
    } catch (fallbackErr) {
      fallbackErr.primaryError = primaryErr.message;
      throw fallbackErr;
    }
  }
}

/** Strip ```json fences etc. and parse. Throws with recovery attempts. */
function parseJsonLoose(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Recovery: grab the first {...} or [...] block
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const candidate = objMatch?.[0] ?? arrMatch?.[0];
    if (candidate) {
      return JSON.parse(candidate);
    }
    throw new Error("Could not parse structured JSON from Gemini response.");
  }
}

// ---------------------------------------------------------------------------
// 1. Key-term extraction — Flash-Lite preference, Flash fallback (PRD 6.1)
// ---------------------------------------------------------------------------
export async function extractKeyTerms(sourceText) {
  const primary = process.env.GEMINI_MODEL_KEYTERMS || "gemini-3.5-flash-lite";
  const fallback = process.env.GEMINI_MODEL_KEYTERMS_FALLBACK || "gemini-3.6-flash";

  const prompt = `From the following study material, extract the 6-10 most important key terms a student should know.
Return ONLY JSON: {"terms": [{"term": "...", "why": "one short sentence on why it matters"}]}

MATERIAL:
"""${sourceText.slice(0, 12000)}"""`;

  const raw = await withFallback(primary, fallback, { prompt, jsonMode: true });
  const parsed = parseJsonLoose(raw);
  return parsed.terms ?? [];
}

// ---------------------------------------------------------------------------
// 2. Word sense resolution (for Wikipedia lookup) + Urdu translation
// ---------------------------------------------------------------------------
export async function resolveWordSense(word, surroundingContext) {
  const model = process.env.GEMINI_MODEL_DEFINE || "gemini-3.6-flash";
  const prompt = `A student right-clicked the word "${word}" while reading the passage below.
1. Determine the single most likely intended sense of this word IN THIS CONTEXT, phrased as a
   short Wikipedia-searchable article title (e.g. "Return statement" not "return").
2. Write a concise, plain-language definition of the word AS USED HERE — 2 to 3 short sentences,
   like a helpful chat answer. Do not write an essay.
Return ONLY JSON: {"searchTitle": "...", "sense": "one sentence describing the intended meaning", "definition": "2-3 sentence definition"}

PASSAGE:
"""${surroundingContext.slice(0, 2000)}"""`;

  const raw = await withFallback(model, model, { prompt, jsonMode: true });
  return parseJsonLoose(raw);
}

export async function translateToUrdu(text) {
  const model = process.env.GEMINI_MODEL_DEFINE || "gemini-3.6-flash";
  const prompt = `Translate the following text into natural, academically appropriate Urdu.
Return ONLY JSON: {"urdu": "..."}

TEXT:
"""${text.slice(0, 4000)}"""`;

  const raw = await withFallback(model, model, { prompt, jsonMode: true });
  const parsed = parseJsonLoose(raw);
  return parsed.urdu ?? "";
}

// ---------------------------------------------------------------------------
// 3. Sentence / passage summary — Flash preference, Flash-Lite fallback
// ---------------------------------------------------------------------------
export async function summarizePassage(passage, surroundingContext) {
  const primary = process.env.GEMINI_MODEL_SUMMARY || "gemini-3.6-flash";
  const fallback = process.env.GEMINI_MODEL_SUMMARY_FALLBACK || "gemini-3.5-flash-lite";

  const prompt = `Summarize the SELECTED passage below in 2-3 clear sentences, grounded strictly in the
source material. Do not introduce outside facts. Use the surrounding context only to disambiguate meaning.
Return ONLY JSON: {"summary": "..."}

SURROUNDING CONTEXT:
"""${surroundingContext.slice(0, 3000)}"""

SELECTED PASSAGE:
"""${passage.slice(0, 3000)}"""`;

  const raw = await withFallback(primary, fallback, { prompt, jsonMode: true });
  const parsed = parseJsonLoose(raw);
  return parsed.summary ?? "";
}

// ---------------------------------------------------------------------------
// 4. Structured quiz generation — resilient JSON parsing + fallback
// ---------------------------------------------------------------------------
export async function generateQuiz(sourceText, count = 5) {
  const model = process.env.GEMINI_MODEL_QUIZ || "gemini-3.6-flash";
  // Real fallback (not the same model twice) — Flash-Lite is smaller and
  // typically responds faster, giving the timeout retry an actual chance.
  const fallback = process.env.GEMINI_MODEL_QUIZ_FALLBACK || process.env.GEMINI_MODEL_KEYTERMS || "gemini-3.5-flash-lite";

  const prompt = `Create a ${count}-question multiple-choice quiz grounded ONLY in the study material below.
Each question needs exactly 4 options and one correct answer. Vary difficulty. Avoid trivial phrasing matches.
Return ONLY JSON in this exact shape:
{"questions": [
  {"question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "why this is correct, one sentence"}
]}

MATERIAL:
"""${sourceText.slice(0, 12000)}"""`;

  // Quiz generation asks for more output tokens than other calls, so give it
  // more time before giving up — 30s was too tight for a 5-question JSON payload.
  const raw = await withFallback(model, fallback, { prompt, jsonMode: true }, 45000);
  const parsed = parseJsonLoose(raw);
  const questions = parsed.questions ?? [];

  // Validate shape defensively — grading must never depend on a second AI call.
  return questions
    .filter(
      (q) =>
        q &&
        typeof q.question === "string" &&
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
// Ported from selper-ai-main's review-queue follow-up idea: turn a miss into
// an immediate second attempt instead of just logging it and moving on.
// ---------------------------------------------------------------------------
export async function generateFollowUpQuestion(sourceText, originalQuestion) {
  const model = process.env.GEMINI_MODEL_QUIZ || "gemini-3.6-flash";
  const fallback = process.env.GEMINI_MODEL_QUIZ_FALLBACK || process.env.GEMINI_MODEL_KEYTERMS || "gemini-3.5-flash-lite";

  const prompt = `A student answered this quiz question incorrectly:
"${originalQuestion.question}"
(Correct answer was: "${originalQuestion.options[originalQuestion.correctIndex]}")

Write ONE new multiple-choice question that retests the SAME underlying concept from the study
material below, using different wording or a different example so it isn't just a repeat.
Exactly 4 options, one correct.
Return ONLY JSON: {"question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "..."}

MATERIAL:
"""${sourceText.slice(0, 8000)}"""`;

  const raw = await withFallback(model, fallback, { prompt, jsonMode: true }, 45000);
  const parsed = parseJsonLoose(raw);

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
// 6. Image transcription (OCR) — closes the PRD's own named gap: "Image-only
// documents: stored, but no OCR or vision reasoning is complete." Uses
// Gemini's vision input directly instead of a separate OCR library, since the
// Gemini client is already wired up here.
// ---------------------------------------------------------------------------
/**
 * Image transcription with word-level bounding boxes so the frontend can
 * build a selectable text layer over the original image. Returns:
 *   { text: "full plain text", words: [{ text: "...", bbox: {x,y,w,h} }] }
 * where bbox coordinates are normalised 0-1 relative to the image dimensions.
 */
export async function extractTextFromImage(base64Data, mimeType) {
  const model = process.env.GEMINI_MODEL_OCR || process.env.GEMINI_MODEL_DEFINE || "gemini-3.6-flash";
  const fallback = process.env.GEMINI_MODEL_QUIZ_FALLBACK || "gemini-3.5-flash-lite";

  const prompt = `Transcribe every readable word in this image with its position. Return ONLY a single
JSON object, no markdown, no bullet points, no code fences, no commentary. Exact shape:
{"text":"the full plain transcription","words":[{"text":"word1","bbox":{"x":0.12,"y":0.34,"w":0.08,"h":0.03}},{"text":"word2","bbox":{"x":0.2,"y":0.34,"w":0.08,"h":0.03}}]}
Rules:
- "x" and "y" are the top-left corner of the word's bounding box; "w" and "h" are width and height.
- All bbox values are normalised 0-1 relative to the image width/height.
- Include every readable word, in reading order.
- If nothing is legible, return {"text":"","words":[]}.`;

  const raw = await withFallback(
    model,
    fallback,
    { prompt, imageData: { mimeType, data: base64Data }, jsonMode: true },
    45000
  );

  let parsed = null;
  try {
    parsed = parseJsonLoose(raw);
  } catch (err) {
    parsed = null;
  }

  // Prefer the JSON words array; recover from a markdown word list otherwise.
  let words = normaliseWords(parsed?.words);
  if (words.length === 0) {
    words = parseMarkdownWordList(raw);
  }

  const text =
    typeof parsed?.text === "string" && parsed.text.trim()
      ? parsed.text
      : words.map((w) => w.text).join(" ") || raw.trim();

  return { text, words };
}

/** Validate a parsed `words` array from the JSON shape. */
function normaliseWords(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => w && typeof w.text === "string" && w.bbox)
    .map((w) => ({
      text: w.text,
      bbox: {
        x: Number(w.bbox.x) ?? 0,
        y: Number(w.bbox.y) ?? 0,
        w: Number(w.bbox.w) ?? 0,
        h: Number(w.bbox.h) ?? 0,
      },
    }));
}

/**
 * Recovery parser for models that ignore the JSON instruction and emit a
 * markdown list such as:
 *   * `AI`: x: 0.057, y: 0.350, w: 0.010, h: 0.016
 * Extracts the word and its normalised bounding box from each line.
 */
function parseMarkdownWordList(raw) {
  const words = [];
  const lineRe =
    /[`"']?([^`"'\n:]+)[`"']?\s*:\s*x\s*[:=]\s*([\d.]+)\s*,\s*y\s*[:=]\s*([\d.]+)\s*,\s*w\s*[:=]\s*([\d.]+)\s*,\s*h\s*[:=]\s*([\d.]+)/gi;
  let m;
  while ((m = lineRe.exec(raw)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    words.push({
      text,
      bbox: {
        x: parseFloat(m[2]),
        y: parseFloat(m[3]),
        w: parseFloat(m[4]),
        h: parseFloat(m[5]),
      },
    });
  }
  return words;
}

