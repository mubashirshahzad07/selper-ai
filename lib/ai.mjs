// lib/ai.mjs
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
Determine the single most likely intended sense of this word IN THIS CONTEXT, phrased as a short
Wikipedia-searchable article title (e.g. "Return statement" not "return").
Return ONLY JSON: {"searchTitle": "...", "sense": "one sentence describing the intended meaning"}

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
export async function extractTextFromImage(base64Data, mimeType) {
  const model = process.env.GEMINI_MODEL_OCR || process.env.GEMINI_MODEL_DEFINE || "gemini-3.6-flash";
  const fallback = process.env.GEMINI_MODEL_QUIZ_FALLBACK || "gemini-3.5-flash-lite";

  const prompt = `Transcribe every piece of readable text in this image exactly as it appears —
lecture slides, handwritten notes, whiteboard photos, textbook pages, anything. Preserve the
original structure (headings, bullet points, line breaks) as plain text. If nothing is legible,
return an empty string. Return ONLY the transcribed text — no commentary, no markdown fences.`;

  const raw = await withFallback(
    model,
    fallback,
    { prompt, imageData: { mimeType, data: base64Data } },
    45000
  );
  return raw.trim();
}

