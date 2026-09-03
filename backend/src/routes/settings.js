// backend/src/routes/settings.js
import express from "express";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { db } from "../repositories/store.js";
import { asyncRoute } from "./asyncRoute.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function settingsRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // GET /api/settings — return current runtime config (read-only, no secrets)
  // ---------------------------------------------------------------------------
  router.get(
    "/",
    asyncRoute(async (_req, res) => {
      res.json({
        // Gemini — OCR + Definitions (translate/summarize/key-terms/grading)
        geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
        geminiApiBase: process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta",
        geminiApiKeySet: !!process.env.GEMINI_API_KEY,
        geminiApiKeyLength: (process.env.GEMINI_API_KEY || "").length,

        // Manus — Quiz Generation
        manusAgentProfile: process.env.MANUS_AGENT_PROFILE || "lite",
        manusMaxConcurrentTasks: Number(process.env.MANUS_MAX_CONCURRENT_TASKS) || 2,
        manusApiBase: process.env.MANUS_API_BASE || "https://api.manus.ai/v2",
        manusApiKeySet: !!process.env.MANUS_API_KEY,
        manusApiKeyLength: (process.env.MANUS_API_KEY || "").length,
      });
    })
  );

  // ---------------------------------------------------------------------------
  // POST /api/settings/gemini-api-key — override the Gemini API key at
  // runtime (stored in-memory only; does NOT persist to .env).
  // ---------------------------------------------------------------------------
  router.post(
    "/gemini-api-key",
    asyncRoute(async (req, res) => {
      const { apiKey } = req.body || {};
      if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
        return res.status(400).json({ error: "A valid GEMINI_API_KEY string is required." });
      }
      process.env.GEMINI_API_KEY = apiKey.trim();
      res.json({ ok: true, keyLength: apiKey.trim().length });
    })
  );

  // ---------------------------------------------------------------------------
  // POST /api/settings/manus-api-key — override the Manus API key at runtime
  // (stored in-memory only; does NOT persist to .env). Useful for testing or
  // when the user wants to swap keys without restarting.
  // ---------------------------------------------------------------------------
  router.post(
    "/manus-api-key",
    asyncRoute(async (req, res) => {
      const { apiKey } = req.body || {};
      if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
        return res.status(400).json({ error: "A valid MANUS_API_KEY string is required." });
      }
      process.env.MANUS_API_KEY = apiKey.trim();
      res.json({ ok: true, keyLength: apiKey.trim().length });
    })
  );

  // ---------------------------------------------------------------------------
  // POST /api/settings/clear — clear session-scoped data.
  // Body: { scope: "documents" | "quizzes" | "doubts" | "all" }
  // ---------------------------------------------------------------------------
  router.post(
    "/clear",
    asyncRoute(async (req, res) => {
      const { scope } = req.body || {};
      if (!["documents", "quizzes", "doubts", "all"].includes(scope)) {
        return res.status(400).json({ error: "scope must be one of: documents, quizzes, doubts, all" });
      }

      const database = await db.get();
      const sid = req.sessionId;

      if (scope === "documents" || scope === "all") {
        // Collect upload file paths to delete, then remove document records.
        const docsToDelete = Object.values(database.documents).filter((d) => d.sessionId === sid);
        for (const doc of docsToDelete) {
          if (doc.storedPath) {
            // storedPath is like "/uploads/abc123" — resolve relative to backend root (2 levels up from src/routes).
            const filePath = path.join(__dirname, "..", "..", doc.storedPath.replace(/^\//, ""));
            await fs.unlink(filePath).catch(() => {});
          }
          delete database.documents[doc.id];
        }
        // Also remove review schedules tied to deleted documents.
        for (const key of Object.keys(database.reviewSchedules)) {
          if (key.startsWith(`${sid}::`)) delete database.reviewSchedules[key];
        }
      }

      if (scope === "quizzes" || scope === "all") {
        const quizIds = new Set();
        for (const [id, quiz] of Object.entries(database.quizzes)) {
          if (quiz.sessionId === sid) {
            quizIds.add(id);
            delete database.quizzes[id];
          }
        }
        const attemptIds = new Set();
        for (const [aId, attempt] of Object.entries(database.attempts)) {
          if (attempt.sessionId === sid || quizIds.has(attempt.quizId)) {
            attemptIds.add(aId);
            delete database.attempts[aId];
          }
        }
        for (const [fId, fu] of Object.entries(database.followUps)) {
          if (fu.sessionId === sid || (fu.attemptId && attemptIds.has(fu.attemptId))) {
            delete database.followUps[fId];
          }
        }
      }

      if (scope === "doubts" || scope === "all") {
        for (const [id, doubt] of Object.entries(database.doubts)) {
          if (doubt.sessionId === sid) delete database.doubts[id];
        }
      }

      await db.save();
      res.json({ ok: true, scope });
    })
  );

  return router;
}
