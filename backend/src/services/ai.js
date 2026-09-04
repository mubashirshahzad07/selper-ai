// backend/src/services/ai.js
// Every function here does ONE narrowly scoped task and returns structured
// data. The actual provider call is delegated to ./providers/{gemini,manus}.js
// — this file owns the response schemas and per-function validation, while all
// prompt wording lives in ./prompts.js: edit a prompt there and it applies to
// every call path at once.
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
// for `manusComplete`/`manusCompleteWithRetry`, same prompt) — with one catch:
// Manus refuses any structured_output_schema whose top-level object omits
// `additionalProperties: false`, which Gemini tolerates. Add it to the schema
// first, or task.create fails with 400 invalid_argument (see GRADE_SCHEMA).
//
// Gemini's generateContent is a synchronous completion call — fast (~1-3s),
// schema-guaranteed JSON via responseSchema, inline base64 for vision.
// Manus's API is agent-task based — task.create -> poll task.listMessages
// until the agent stops, which is much slower (seconds to a couple of
// minutes) but fine for quiz generation, which already runs after a
// deliberate "generate my quiz" click rather than needing a snappy response.

import { geminiComplete, geminiCompleteWithRetry } from "./providers/gemini.js";
import { manusComplete, manusCompleteWithRetry } from "./providers/manus.js";
import {
    KEY_TERMS_PROMPT,
    WORD_SENSE_PROMPT,
    URDU_TRANSLATION_PROMPT,
    SUMMARY_PROMPT,
    MCQ_QUIZ_PROMPT,
    FREE_TEXT_QUIZ_PROMPT,
    FOLLOW_UP_PROMPT,
    OCR_PROMPT,
    GRADING_PROMPT,
} from "./prompts.js";

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
    const prompt = KEY_TERMS_PROMPT(sourceText);

    const { value } = await geminiCompleteWithRetry({ prompt, schema: KEY_TERMS_SCHEMA, timeoutMs: 18000, maxOutputTokens: 512 }, 1);
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

// Short-lived in-memory cache for word definitions (same word + context hash).
// Avoids repeat Gemini calls when a student re-looks-up the same term.
const senseCache = new Map();
const SENSE_CACHE_MAX = 80;

function senseCacheKey(word, context) {
    return `${word.toLowerCase()}|${(context || "").slice(0, 200)}`;
}

export async function resolveWordSense(word, surroundingContext) {
    const key = senseCacheKey(word, surroundingContext);
    if (senseCache.has(key)) return senseCache.get(key);

    const prompt = WORD_SENSE_PROMPT(word, surroundingContext);

    const { value } = await geminiCompleteWithRetry({ prompt, schema: WORD_SENSE_SCHEMA, timeoutMs: 30000, maxOutputTokens: 256 }, 1);
    if (senseCache.size >= SENSE_CACHE_MAX) {
        const oldest = senseCache.keys().next().value;
        senseCache.delete(oldest);
    }
    senseCache.set(key, value);
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
    const prompt = URDU_TRANSLATION_PROMPT(text);

    const { value } = await geminiCompleteWithRetry({ prompt, schema: URDU_SCHEMA, timeoutMs: 15000, maxOutputTokens: 512 }, 1);
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
    const prompt = SUMMARY_PROMPT(passage, surroundingContext);

    const { value } = await geminiCompleteWithRetry({ prompt, schema: SUMMARY_SCHEMA, timeoutMs: 12000, maxOutputTokens: 256 }, 1);
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
        const prompt = FREE_TEXT_QUIZ_PROMPT(sourceText, count);

        const { value } = await manusCompleteWithRetry({ prompt, schema: FREE_TEXT_QUIZ_SCHEMA, timeoutMs: 90000 });
        return (value.questions ?? [])
            .filter((q) => q && typeof q.question === "string" && typeof q.topic === "string")
            .slice(0, count);
    }

    // MCQ mode (default)
    const prompt = MCQ_QUIZ_PROMPT(sourceText, count);

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
    const prompt = FOLLOW_UP_PROMPT(sourceText, originalQuestion);

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
    const prompt = OCR_PROMPT();

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
// 8. Free-text answer grading — Manus
// ---------------------------------------------------------------------------
const GRADE_SCHEMA = {
    // additionalProperties:false is mandatory here, not a strictness preference:
    // Manus answers task.create with 400 invalid_argument ("unexpected error from
    // node server") for any top-level object that omits it, so grading failed on
    // every question while the quiz schemas — which all set it — worked. Verified
    // against the live API by posting both shapes.
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
    const prompt = GRADING_PROMPT(studentAnswer, question);

    console.log(`[AI] Grading: "${question.question.slice(0, 60)}..."`);
    const t0 = Date.now();

    try {
        // Use Manus for grading instead of Gemini — more reliable for structured output.
        const { value: parsed } = await manusCompleteWithRetry({ prompt, schema: GRADE_SCHEMA, timeoutMs: 60000 });
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
