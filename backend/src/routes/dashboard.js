// backend/src/routes/dashboard.js
import express from "express";

import { db } from "../repositories/store.js";
import { buildDashboardInsights } from "../services/dashboard.js";
import { asyncRoute } from "./asyncRoute.js";

export function dashboardRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Dashboard insights — aggregates attempts, follow-ups, calibration, and
  // review queue into actionable learning insights. Pure computation, no AI.
  // ---------------------------------------------------------------------------
  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const insights = buildDashboardInsights(database, req.sessionId);
      res.json(insights);
    })
  );

  return router;
}
