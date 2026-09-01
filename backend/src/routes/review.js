// backend/src/routes/review.js
import express from "express";

import { db } from "../repositories/store.js";
import { buildReviewQueue, labelForGroup } from "../services/reviewQueue.js";
import { scheduleAfterOutcome } from "../services/spacedRepetition.js";
import { assertOwnership } from "../middleware/session.js";
import { asyncRoute } from "./asyncRoute.js";

export function reviewRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Review queue — combines doubts + weak attempts, priority-ordered (PRD 5.5),
  // with a spaced-repetition schedule layered on top: due items sort first,
  // not-yet-due items show separately as "upcoming."
  // ---------------------------------------------------------------------------
  router.get(
    "/",
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
  router.post(
    "/mark",
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

  return router;
}
