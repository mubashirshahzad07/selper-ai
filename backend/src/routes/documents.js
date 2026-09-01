// backend/src/routes/documents.js
import express from "express";
import { nanoid } from "nanoid";
import { promises as fs } from "fs";

import { db } from "../repositories/store.js";
import { extractPdfText, extractImageText } from "../services/extraction.js";
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
        // OCR is intentionally NOT awaited here — running Gemini vision inline made
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

      // Kick off image OCR in the background so the upload response returns fast.
      if (isImage) runBackgroundOcr(id, req.file.path, req.file.mimetype);

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
  // Key-term extraction (Gemini Flash-Lite + Flash fallback)
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

  return router;
}
