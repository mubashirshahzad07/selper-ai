// backend/src/routes/calibration.js
import express from "express";

import { db } from "../repositories/store.js";
import { computeCalibration } from "../services/calibration.js";
import { asyncRoute } from "./asyncRoute.js";

export function calibrationRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Confidence calibration — not just a score, but whether "I know this" tracks
  // actual accuracy. Pure computation over attempts already on file, no AI call.
  // ---------------------------------------------------------------------------
  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      let attempts = Object.values(database.attempts).filter((a) => a.sessionId === req.sessionId);

      if (req.query.documentId) {
        attempts = attempts.filter((a) => a.documentId === req.query.documentId);
      }

      res.json(computeCalibration(attempts));
    })
  );

  return router;
}
