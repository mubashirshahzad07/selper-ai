// backend/src/routes/documents.js
import express from "express";
import { nanoid } from "nanoid";
import { promises as fs } from "fs";

import { db } from "../repositories/store.js";
import { extractPdfText, extractImageText, extractScannedPdfText } from "../services/extraction.js";
import { extractKeyTerms, generateQuiz } from "../services/ai.js";
import { assertOwnership } from "../middleware/session.js";
import { asyncRoute } from "./asyncRoute.js";

/**
 * Run image OCR after the upload response has already been sent, then persist
 * the result onto the document. Keeps uploads fast while still populating
 * extractedText / ocrData for key terms, quiz, and the word layer.
 */
function runBackgroundOcr(docId, filePath, mimetype) {
  setImmediate(async () => {
    try {
      const buffer = await fs.readFile(filePath);
      const result = await extractImageText(buffer.toString("base64"), mimetype);
      const database = await db.get();
      const doc = database.documents[docId];
      if (doc) {
        doc.extractedText = result.text;
        doc.ocrData = result.words;
        doc.ocrApplied = true;
        await db.save();
      }
    } catch (err) {
      const database = await db.get();
      const doc = database.documents[docId];
      if (doc) {
        doc.ocrError = err.message;
        await db.save();
      }
    }
  });
}

/**
 * Fallback for scanned/rasterized PDFs (no embedded text layer): rasterise each
 * page server-side and run the same Manus vision OCR pipeline as image uploads,
 * storing per-page word boxes + transcription on the document. Runs after the
 * upload response so uploads stay fast.
 */
function runBackgroundScannedOcr(docId, filePath) {
  setImmediate(async () => {
    try {
      const buffer = await fs.readFile(filePath);
      const { pages, fullText } = await extractScannedPdfText(buffer);
      const database = await db.get();
      const doc = database.documents[docId];
      if (doc) {
        doc.ocrData = pages; // { "1": { text, words, hasNativeText, images? }, ... }
        // Append (not overwrite) so mixed PDFs keep their native text alongside
        // the OCR'd image/scanned text for key terms / quiz.
        if (fullText) doc.extractedText = doc.extractedText ? `${doc.extractedText}\n\n${fullText}` : fullText;
        doc.ocrApplied = true;
        await db.save();
      }
    } catch (err) {
      const database = await db.get();
      const doc = database.documents[docId];
      if (doc) {
        doc.ocrError = err.message;
        await db.save();
      }
    }
  });
}

export function documentsRouter(upload) {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // Upload + extraction
  // -------------------------------------------------------------------------
  router.post(
    "/",
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
      let ocrData = null;

      if (isPdf) {
        const buffer = await fs.readFile(req.file.path);
        const parsed = await extractPdfText(buffer);
        extractedText = parsed.text;
        pageCount = parsed.pageCount;
      } else if (isImage) {
        // OCR is intentionally NOT awaited here — running Manus vision inline made
        // image uploads take tens of seconds. The document is saved immediately and
        // OCR runs in the background (see runBackgroundOcr below), so the upload
        // stays fast and the word layer is filled in shortly after.
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
        ocrData,
        pageCount,
        ocrApplied,
        ocrError,
        keyTerms: null, // filled lazily via /key-terms
      };
      await db.save();

      // Kick off OCR in the background so the upload response returns fast. The
      // PDF handler is hybrid: it skips native-text pages and only spends Manus
      // calls on fully-scanned pages and embedded image blocks.
      if (isImage) runBackgroundOcr(id, req.file.path, req.file.mimetype);
      else if (isPdf) runBackgroundScannedOcr(id, req.file.path);

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
        ocrData,
      });
    })
  );

  router.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const doc = database.documents[req.params.id];
      assertOwnership(doc, req, "Document");
      res.json(doc);
    })
  );

  // -------------------------------------------------------------------------
  // Key-term extraction (Manus Lite agent)
  // -------------------------------------------------------------------------
  router.post(
    "/:id/key-terms",
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

  // -------------------------------------------------------------------------
  // Quiz generation (structured JSON, deterministic grading happens in quizzes.js)
  // Supports MCQ and free-text modes, configurable question count.
  // -------------------------------------------------------------------------
  router.post(
    "/:id/quiz",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const doc = database.documents[req.params.id];
      assertOwnership(doc, req, "Document");
      if (!doc.extractedText) {
        return res.status(422).json({ error: "No extracted text available for this document." });
      }

      // Defensive: ensure count and mode are read correctly from JSON body.
      const rawCount = Number(req.body?.count);
      const count = Math.min(Math.max(Number.isFinite(rawCount) ? rawCount : 5, 3), 20);
      const mode = req.body?.mode === "freeText" ? "freeText" : "mcq";

      const questions = await generateQuiz(doc.extractedText, count, mode);
      if (questions.length === 0) {
        return res.status(502).json({ error: "Quiz generation failed to produce valid questions." });
      }

      const id = nanoid(10);
      database.quizzes[id] = {
        id,
        sessionId: req.sessionId,
        documentId: doc.id,
        questions,
        mode,
        createdAt: new Date().toISOString(),
      };
      await db.save();

      // Return questions without answers — client submits responses for server-side grading.
      const safeQuestions = questions.map((q) => {
        if (mode === "freeText") {
          return {
            questionIndex: questions.indexOf(q),
            question: q.question,
            topic: q.topic,
            mode: "freeText",
          };
        }
        return {
          questionIndex: questions.indexOf(q),
          question: q.question,
          topic: q.topic,
          options: q.options,
          mode: "mcq",
        };
      });

      res.json({
        id,
        documentId: doc.id,
        mode,
        questions: safeQuestions,
      });
    })
  );

  return router;
}
