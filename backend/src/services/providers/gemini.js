// backend/src/services/providers/gemini.js
// Thin adapter around Gemini's REST `generateContent` endpoint. Exposes
// geminiComplete() / geminiCompleteWithRetry(), matching the shape of
// manusComplete() / manusCompleteWithRetry() in ./manus.js so ai.js can call
// either provider without caring which one it is.
//
// Used for: OCR (image transcription) and Definitions (word-sense
// resolution, translate, summarize, key terms, free-text grading) — see
// ai.js for the provider assignment rationale. Gemini's generateContent is a
// synchronous, low-latency completion call, which is what these
// interactive/on-demand call sites need (a right-click definition lookup
// should resolve in ~1-3s, not tens of seconds).

import fetch from "node-fetch";

const API_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

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
 * Convert our lowercase JSON-Schema-style schemas (shared with the Manus
 * provider, see manus.js) into Gemini's Schema object — an OpenAPI 3.0
 * subset that uses uppercase Type enum values (STRING, OBJECT, ARRAY, ...)
 * and doesn't support `additionalProperties`.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const out = { type: String(schema.type || "object").toUpperCase() };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;

  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(value);
    }
  }
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);

  return out;
}

/**
 * Run one Gemini generateContent call.
 * @param {string} prompt
 * @param {object} [schema] - JSON-Schema-style object. When present, Gemini
 *   is constrained to return JSON conforming to it and the parsed value is
 *   returned as `{ value }`.
 * @param {{ mimeType: string, data: string }} [imageData] - base64 image to
 *   attach as an inline vision input.
 * @returns {Promise<{ value: any } | { text: string }>}
 */
export async function geminiComplete({ prompt, schema = null, imageData = null, timeoutMs = 30000, maxOutputTokens }) {
  const parts = [{ text: prompt }];
  if (imageData) {
    parts.push({ inlineData: { mimeType: imageData.mimeType, data: imageData.data } });
  }

  const generationConfig = {};
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = toGeminiSchema(schema);
  }
  // Token budget hint — keeps responses concise and reduces cost. Defaults
  // to 2048 for plain-text calls; structured-output calls get a tighter cap
  // since the schema already constrains the shape.
  generationConfig.maxOutputTokens = maxOutputTokens ?? (schema ? 1024 : 2048);

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${API_BASE}/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Gemini ${MODEL} timed out after ${timeoutMs}ms.`);
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch { /* keep raw slice */ }
    const err = new Error(`Gemini generateContent failed (${res.status}): ${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];

  if (!candidate) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(
      block
        ? `Gemini blocked the request (${block}). Try a different selection.`
        : "Gemini returned no candidates (likely blocked by safety filters)."
    );
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
    throw new Error(`Gemini stopped early: ${candidate.finishReason}`);
  }

  const text = (candidate.content?.parts || []).map((p) => p.text).filter(Boolean).join("\n");

  if (!schema) return { text };

  try {
    return { value: JSON.parse(text) };
  } catch {
    // Some models occasionally wrap JSON in markdown fences — strip and retry once.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try {
      return { value: JSON.parse(cleaned) };
    } catch {
      throw new Error(`Gemini's structured response was not valid JSON: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Retry wrapper for Gemini calls that may fail due to transient issues
 * (5xx, timeouts). Mirrors manusCompleteWithRetry's backoff policy so both
 * providers behave consistently from the caller's perspective.
 */
export async function geminiCompleteWithRetry(opts, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await geminiComplete(opts);
    } catch (err) {
      lastErr = err;
      // Don't retry on client errors (4xx) — bad request/blocked content
      // won't fix itself, except 429 (rate limit) which is worth a backoff.
      // Also don't retry missing API key.
      if (err.code === "NO_API_KEY") throw err;
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      console.warn(`[AI] Gemini call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      if (attempt < maxRetries) {
        // Fast backoff for interactive calls: 800ms, then 2s — keeps latency low
        // while still recovering from brief rate-limits / 5xx blips.
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2.5, attempt)));
      }
    }
  }
  throw lastErr;
}
