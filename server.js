// server.js
import "dotenv/config";
import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";

import { db } from "./lib/store.mjs";
import {
  extractKeyTerms,
  resolveWordSense,
  translateToUrdu,
  summarizePassage,
  generateQuiz,
  generateFollowUpQuestion,
  extractTextFromImage,
} from "./lib/ai.mjs";
import { fetchWikipediaDefinition } from "./lib/wikipedia.mjs";
import { buildReviewQueue, labelForGroup } from "./lib/review.mjs";
import { scheduleAfterOutcome } from "./lib/spaced-repetition.mjs";
import { computeCalibration } from "./lib/calibration.mjs";
import { sessionMiddleware, assertOwnership } from "./lib/session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Every route below is scoped to an anonymous guest session (see lib/session.mjs).
// The session id is issued on first request via the x-study-session response
// header and echoed back by the client on every subsequent request.
app.use(sessionMiddleware);

const UPLOAD_DIR = path.join(__dirname, "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message || "Something went wrong.",
      code: err.code,
    });
  });
}

// ---------------------------------------------------------------------------
// Upload + extraction
// ---------------------------------------------------------------------------
app.post(
  "/api/documents",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      const err = new Error("No file uploaded.");
      err.status = 400;
      throw err;
    }

    const isPdf = req.file.mimetype === "application/pdf";
    const isImage = req.file.mimetype.startsWith("image/");
    let extractedText = "";
    let pageCount = null;
    let ocrApplied = false;
    let ocrError = null;

    if (isPdf) {
      const buffer = await fs.readFile(req.file.path);
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text || "";
      pageCount = parsed.numpages ?? null;
    } else if (isImage) {
      // Closes the PRD's own named gap: image-only uploads previously had no
      // path to extraction, so key terms/quiz/definitions silently didn't work.
      try {
        const buffer = await fs.readFile(req.file.path);
        extractedText = await extractTextFromImage(buffer.toString("base64"), req.file.mimetype);
        ocrApplied = true;
      } catch (err) {
        // Don't fail the upload just because OCR failed (e.g. no API key) —
        // the image still displays fine, just without extraction-dependent
        // features (key terms, quiz, define/summarize).
        ocrError = err.message;
      }
    }

    const database = await db.get();
    const id = nanoid(10);
    database.documents[id] = {
      id,
      sessionId: req.sessionId,
      filename: req.file.originalname,
      storedPath: `/uploads/${req.file.filename}`,
      mimetype: req.file.mimetype,
      isPdf,
      isImage,
      uploadedAt: new Date().toISOString(),
      extractedText,
      pageCount,
      ocrApplied,
      ocrError,
      keyTerms: null, // filled lazily via /key-terms
    };
    await db.save();

    res.json({
      id,
      filename: req.file.originalname,
      url: `/uploads/${req.file.filename}`,
      isPdf,
      isImage,
      pageCount,
      hasExtractedText: extractedText.length > 0,
      ocrApplied,
      ocrError,
    });
  })
);

app.get(
  "/api/documents/:id",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    const doc = database.documents[req.params.id];
    assertOwnership(doc, req, "Document");
    res.json(doc);
  })
);

// ---------------------------------------------------------------------------
// Key-term extraction (Gemini Flash-Lite + Flash fallback)
// ---------------------------------------------------------------------------
app.post(
  "/api/documents/:id/key-terms",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    const doc = database.documents[req.params.id];
    assertOwnership(doc, req, "Document");

    if (doc.keyTerms) return res.json({ terms: doc.keyTerms, cached: true });
    if (!doc.extractedText) {
      return res.status(422).json({ error: "No extracted text available for this document." });
    }

    const terms = await extractKeyTerms(doc.extractedText);
    doc.keyTerms = terms;
    await db.save();
    res.json({ terms, cached: false });
  })
);

// ---------------------------------------------------------------------------
// Right-click: word definition (Gemini resolves sense from context -> Wikipedia
// supplies the definition). No Urdu translation here — that's a separate action.
// ---------------------------------------------------------------------------
app.post(
  "/api/assist/define",
  asyncRoute(async (req, res) => {
    const { word, context } = req.body || {};
    if (!word || !context) {
      return res.status(400).json({ error: "word and context are required." });
    }

    const sense = await resolveWordSense(word, context);
    let definition = null;
    try {
      definition = await fetchWikipediaDefinition(sense.searchTitle || word);
    } catch (e) {
      definition = null;
    }

    res.json({
      word,
      resolvedSense: sense.sense,
      searchTitle: sense.searchTitle,
      definition, // { title, extract, url } or null if Wikipedia had no match
    });
  })
);

// ---------------------------------------------------------------------------
// Right-click: sentence/passage summary. No Urdu translation here either —
// separate action, see /api/assist/translate below.
// ---------------------------------------------------------------------------
app.post(
  "/api/assist/summarize",
  asyncRoute(async (req, res) => {
    const { passage, context } = req.body || {};
    if (!passage) return res.status(400).json({ error: "passage is required." });

    const summary = await summarizePassage(passage, context || passage);
    res.json({ summary });
  })
);

// ---------------------------------------------------------------------------
// Right-click: Urdu translation of a word, definition, or passage — a
// standalone action instead of being bundled into every define/summarize call.
// ---------------------------------------------------------------------------
app.post(
  "/api/assist/translate",
  asyncRoute(async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required." });

    const urdu = await translateToUrdu(text);
    res.json({ urdu });
  })
);

// ---------------------------------------------------------------------------
// Doubt notebook
// ---------------------------------------------------------------------------
app.post(
  "/api/doubts",
  asyncRoute(async (req, res) => {
    const { documentId, passage, note } = req.body || {};
    if (!documentId || !passage) {
      return res.status(400).json({ error: "documentId and passage are required." });
    }
    const database = await db.get();
    assertOwnership(database.documents[documentId], req, "Document");
    const id = nanoid(10);
    database.doubts[id] = {
      id,
      sessionId: req.sessionId,
      documentId,
      passage,
      note: note || "",
      createdAt: new Date().toISOString(),
    };
    await db.save();
    res.json(database.doubts[id]);
  })
);

app.get(
  "/api/doubts",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    const mine = Object.values(database.doubts).filter((d) => d.sessionId === req.sessionId);
    const filtered = req.query.documentId
      ? mine.filter((d) => d.documentId === req.query.documentId)
      : mine;
    res.json(filtered);
  })
);

// ---------------------------------------------------------------------------
// Quiz generation (structured JSON, deterministic grading server-side)
// ---------------------------------------------------------------------------
app.post(
  "/api/documents/:id/quiz",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    const doc = database.documents[req.params.id];
    assertOwnership(doc, req, "Document");
    if (!doc.extractedText) {
      return res.status(422).json({ error: "No extracted text available for this document." });
    }

    const questions = await generateQuiz(doc.extractedText, 5);
    if (questions.length === 0) {
      return res.status(502).json({ error: "Quiz generation failed to produce valid questions." });
    }

    const id = nanoid(10);
    // Store answer keys server-side; client never receives correctIndex up front... but for a
    // hackathon-simple flow we DO send it so the UI can show explanations, and grading is
    // re-verified server-side on submit regardless of what the client sends back.
    database.quizzes[id] = {
      id,
      sessionId: req.sessionId,
      documentId: doc.id,
      questions,
      createdAt: new Date().toISOString(),
    };
    await db.save();

    res.json({
      id,
      documentId: doc.id,
      questions: questions.map((q) => ({ question: q.question, options: q.options })),
    });
  })
);

// ---------------------------------------------------------------------------
// Quiz submission: deterministic local grading, no AI call.
// ---------------------------------------------------------------------------
app.post(
  "/api/quizzes/:id/submit",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    const quiz = database.quizzes[req.params.id];
    assertOwnership(quiz, req, "Quiz");

    const { responses } = req.body || {};
    // responses: [{ questionIndex, selectedIndex, confidence: 'confident'|'unsure'|'guessing', errorCategory? }]
    if (!Array.isArray(responses)) {
      return res.status(400).json({ error: "responses array is required." });
    }

    const answers = responses.map((r) => {
      const q = quiz.questions[r.questionIndex];
      const isCorrect = q && r.selectedIndex === q.correctIndex;
      return {
        questionIndex: r.questionIndex,
        question: q?.question ?? "(unknown question)",
        options: q?.options ?? [],
        selectedOption: q?.options?.[r.selectedIndex] ?? null,
        correctOption: q?.options?.[q?.correctIndex] ?? null,
        explanation: q?.explanation ?? "",
        isCorrect: Boolean(isCorrect),
        confidence: r.confidence || "unsure",
        // Errors are self-tagged by the student at submit time (or default to Conceptual).
        errorCategory: isCorrect ? null : r.errorCategory || "Conceptual",
      };
    });

    const score = answers.filter((a) => a.isCorrect).length;

    const attemptId = nanoid(10);
    database.attempts[attemptId] = {
      id: attemptId,
      sessionId: req.sessionId,
      quizId: quiz.id,
      documentId: quiz.documentId,
      answers,
      score,
      total: answers.length,
      createdAt: new Date().toISOString(),
    };
    await db.save();

    res.json(database.attempts[attemptId]);
  })
);

// ---------------------------------------------------------------------------
// Follow-up: retest the SAME concept immediately after a wrong answer.
// Ported from selper-ai-main's review-queue follow-up. Grading is deterministic
// and re-verified server-side, same as the main quiz flow.
// ---------------------------------------------------------------------------
app.post(
  "/api/attempts/:attemptId/follow-up",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    const attempt = database.attempts[req.params.attemptId];
    assertOwnership(attempt, req, "Attempt");

    const { questionIndex } = req.body || {};
    const answer = attempt.answers.find((a) => a.questionIndex === questionIndex);
    if (!answer) return res.status(404).json({ error: "That answer wasn't found on this attempt." });
    if (answer.isCorrect) return res.status(400).json({ error: "This question was already answered correctly." });

    const quiz = database.quizzes[attempt.quizId];
    const doc = database.documents[attempt.documentId];
    assertOwnership(quiz, req, "Quiz");
    if (!doc?.extractedText) {
      return res.status(422).json({ error: "No extracted text available to generate a follow-up." });
    }

    const originalQuestion = quiz.questions[questionIndex];
    const followUp = await generateFollowUpQuestion(doc.extractedText, originalQuestion);

    const id = nanoid(10);
    database.followUps[id] = {
      id,
      sessionId: req.sessionId,
      attemptId: attempt.id,
      questionIndex,
      question: followUp,
      submitted: false,
      isCorrect: null,
      createdAt: new Date().toISOString(),
    };
    await db.save();

    res.json({
      id,
      question: followUp.question,
      options: followUp.options,
    });
  })
);

app.post(
  "/api/follow-ups/:id/submit",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    const followUp = database.followUps[req.params.id];
    assertOwnership(followUp, req, "Follow-up question");
    if (followUp.submitted) {
      return res.status(400).json({ error: "This follow-up was already answered." });
    }

    const { selectedIndex } = req.body || {};
    const isCorrect = selectedIndex === followUp.question.correctIndex;

    followUp.submitted = true;
    followUp.isCorrect = isCorrect;
    followUp.selectedIndex = selectedIndex;
    await db.save();

    res.json({
      isCorrect,
      correctOption: followUp.question.options[followUp.question.correctIndex],
      explanation: followUp.question.explanation || "",
    });
  })
);

// ---------------------------------------------------------------------------
// Review queue — combines doubts + weak attempts, priority-ordered (PRD 5.5),
// with a spaced-repetition schedule layered on top (lib/spaced-repetition.mjs):
// due items sort first, not-yet-due items show separately as "upcoming."
// ---------------------------------------------------------------------------
app.get(
  "/api/review-queue",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    let doubts = Object.values(database.doubts).filter((d) => d.sessionId === req.sessionId);
    let attempts = Object.values(database.attempts).filter((a) => a.sessionId === req.sessionId);

    if (req.query.documentId) {
      doubts = doubts.filter((d) => d.documentId === req.query.documentId);
      attempts = attempts.filter((a) => a.documentId === req.query.documentId);
    }

    const schedulePrefix = `${req.sessionId}::`;
    const schedules = {};
    for (const [storeKey, schedule] of Object.entries(database.reviewSchedules)) {
      if (storeKey.startsWith(schedulePrefix)) {
        schedules[storeKey.slice(schedulePrefix.length)] = schedule;
      }
    }

    const queue = buildReviewQueue(doubts, attempts, schedules).map((item) => ({
      ...item,
      groupLabel: labelForGroup(item.priorityGroup),
    }));

    res.json(queue);
  })
);

// ---------------------------------------------------------------------------
// Mark a review-queue item as remembered or forgotten — advances (or resets)
// its spaced-repetition interval. Ownership is checked by parsing the item's
// key back to the doubt/attempt it points at.
// ---------------------------------------------------------------------------
app.post(
  "/api/review-queue/mark",
  asyncRoute(async (req, res) => {
    const { key, remembered } = req.body || {};
    if (!key || typeof remembered !== "boolean") {
      return res.status(400).json({ error: "key and remembered (boolean) are required." });
    }

    const database = await db.get();

    // Ownership check: parse the key back to its underlying record.
    if (key.startsWith("doubt:")) {
      const doubtId = key.slice("doubt:".length);
      assertOwnership(database.doubts[doubtId], req, "Doubt");
    } else if (key.startsWith("attempt:")) {
      const attemptId = key.split(":")[1];
      assertOwnership(database.attempts[attemptId], req, "Attempt");
    } else {
      return res.status(400).json({ error: "Unrecognized review item key." });
    }

    const storeKey = `${req.sessionId}::${key}`;
    const existing = database.reviewSchedules[storeKey];
    const { intervalDays, nextReviewAt } = scheduleAfterOutcome(
      existing?.intervalDays ?? null,
      remembered
    );

    database.reviewSchedules[storeKey] = {
      key,
      sessionId: req.sessionId,
      intervalDays,
      nextReviewAt,
      lastOutcome: remembered ? "remembered" : "forgot",
      lastReviewedAt: new Date().toISOString(),
    };
    await db.save();

    res.json(database.reviewSchedules[storeKey]);
  })
);

// ---------------------------------------------------------------------------
// Confidence calibration — not just a score, but whether "I know this" tracks
// actual accuracy. Pure computation over attempts already on file, no AI call.
// ---------------------------------------------------------------------------
app.get(
  "/api/calibration",
  asyncRoute(async (req, res) => {
    const database = await db.get();
    let attempts = Object.values(database.attempts).filter((a) => a.sessionId === req.sessionId);

    if (req.query.documentId) {
      attempts = attempts.filter((a) => a.documentId === req.query.documentId);
    }

    res.json(computeCalibration(attempts));
  })
);

app.listen(PORT, () => {
  console.log(`Study Helper running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("⚠️  GEMINI_API_KEY is not set — AI routes will fail until you add it to .env");
  }
});
