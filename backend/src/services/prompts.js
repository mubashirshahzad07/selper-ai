// backend/src/services/prompts.js
//
// SINGLE SOURCE OF TRUTH for every prompt sent to an AI provider (Gemini and
// Manus). Nothing else in the codebase writes model instructions: the provider
// adapters in ./providers/gemini.js and ./providers/manus.js transport these
// strings verbatim and never add, wrap, or rewrite them, and the frontend sends
// plain user selections — so a wording change made here takes effect on every
// call path at once.
//
// HOW TO EDIT
//   Each export is one function that returns the exact text the model receives.
//   The only code inside them is the ${...} interpolation of study material.
//   Change the prose freely; just leave each `${...}` expression in place, since
//   that is where the runtime content (the passage, the selected word, the
//   student's answer) gets injected.
//
//   The .slice(0, N) on each interpolation is a token-budget cap — N is the
//   maximum number of characters of source material that go into the prompt.
//   Raise or lower it here if a model starts truncating or over-running.
//
// WHAT LIVES ELSEWHERE ON PURPOSE
//   Response schemas stay in ../services/ai.js next to the function that
//   consumes them: they describe the shape the model must return, not what we
//   are asking for, and each call site validates its own shape.
//
// The numbered sections below match the numbered functions in ai.js, so a
// prompt here and the code that calls it are easy to find from each other.

// ---------------------------------------------------------------------------
// 1. Key-term extraction (Gemini)
// ---------------------------------------------------------------------------
export const KEY_TERMS_PROMPT = (sourceText) => `From the following study material, extract the 6-10 most important key terms a student should know.
Be concise — each "why" explanation should be one short sentence (max 15 words).

MATERIAL:
"""${sourceText.slice(0, 6000)}"""`;

// ---------------------------------------------------------------------------
// 2. Word sense resolution / Definitions (Gemini)
// ---------------------------------------------------------------------------
export const WORD_SENSE_PROMPT = (word, surroundingContext) => `A student right-clicked the word "${word}" while reading the passage below.
1. Determine the single most likely intended sense of this word IN THIS CONTEXT, phrased as a
short Wikipedia-searchable article title (e.g. "Return statement" not "return").
2. Write a concise definition — 1-2 sentences max, no essay.

PASSAGE:
"""${surroundingContext.slice(0, 1200)}"""`;

// ---------------------------------------------------------------------------
// 3. Urdu translation (Gemini)
// ---------------------------------------------------------------------------
export const URDU_TRANSLATION_PROMPT = (text) => `Translate the following text into natural, academically appropriate Urdu.
Keep the translation concise — match the original length closely.

TEXT:
"""${text.slice(0, 2500)}"""`;

// ---------------------------------------------------------------------------
// 4. Sentence / passage summary (Gemini)
// ---------------------------------------------------------------------------
export const SUMMARY_PROMPT = (passage, surroundingContext) => `Summarize the SELECTED passage below in 2-3 clear sentences max.
Be concise — do not exceed 3 sentences. Ground strictly in the source material.

SURROUNDING CONTEXT:
"""${surroundingContext.slice(0, 1500)}"""

SELECTED PASSAGE:
"""${passage.slice(0, 1500)}"""`;

// ---------------------------------------------------------------------------
// 5. Quiz generation (Manus) — two modes, one prompt each
// ---------------------------------------------------------------------------
export const MCQ_QUIZ_PROMPT = (sourceText, count) => `Create a ${count}-question MCQ quiz grounded ONLY in the study material below.
Each question: exactly 4 options, one correct. Keep explanations to one sentence max.
Vary difficulty. Tag each with its concept/topic.

MATERIAL:
"""${sourceText.slice(0, 8000)}"""`;

export const FREE_TEXT_QUIZ_PROMPT = (sourceText, count) => `Create ${count} short-answer quiz questions grounded ONLY in the study material below.
Be concise — keep model answers to 1-2 sentences and grading criteria to 2-3 brief bullet points.

MATERIAL:
"""${sourceText.slice(0, 8000)}"""`;

// ---------------------------------------------------------------------------
// 6. Follow-up question (Manus) — retests the SAME concept the student missed
// ---------------------------------------------------------------------------
export const FOLLOW_UP_PROMPT = (sourceText, originalQuestion) => `Student got this wrong: "${originalQuestion.question}"
(Correct: "${originalQuestion.options[originalQuestion.correctIndex]}")

Write ONE new MCQ retesting the SAME concept with different wording.
Keep explanation to one sentence max. Exactly 4 options, one correct.

MATERIAL:
"""${sourceText.slice(0, 6000)}"""`;

// ---------------------------------------------------------------------------
// 7. Image transcription / OCR (Gemini vision)
// ---------------------------------------------------------------------------
// Takes no arguments — the image itself is attached alongside this text as
// inline vision input, not interpolated into it.
export const OCR_PROMPT = () => `Transcribe every readable word in the attached image with its position.
Rules:
- "x" and "y" are the top-left corner of the word's bounding box; "w" and "h" are width and height.
- All bbox values are normalised 0-1 relative to the image width/height.
- Include every readable word, in reading order.
- If nothing is legible, return an empty transcription and an empty words list.`;

// ---------------------------------------------------------------------------
// 8. Free-text answer grading (Manus)
// ---------------------------------------------------------------------------
export const GRADING_PROMPT = (studentAnswer, question) => `Grade this student's free-text answer. Be concise in feedback (2-3 sentences max).
Score 0.0-1.0 based on how well the answer matches the criteria.

QUESTION: "${question.question}"
MODEL ANSWER: "${question.modelAnswer}"
CRITERIA: ${JSON.stringify(question.gradingCriteria)}
STUDENT: "${studentAnswer}"`;
