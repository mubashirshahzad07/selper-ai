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
        manusAgentProfile: process.env.MANUS_AGENT_PROFILE || "lite",
        manusMaxConcurrentTasks: Number(process.env.MANUS_MAX_CONCURRENT_TASKS) || 5,
        manusApiBase: process.env.MANUS_API_BASE || "https://api.manus.ai/v2",
        manusApiKeySet: !!process.env.MANUS_API_KEY,
        manusApiKeyLength: (process.env.MANUS_API_KEY || "").length,
      });
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
