// backend/src/routes/settings.js
import express from "express";
import { asyncRoute } from "./asyncRoute.js";

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

  return router;
}
