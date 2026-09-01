// backend/src/routes/doubts.js
import express from "express";
import { nanoid } from "nanoid";

import { db } from "../repositories/store.js";
import { assertOwnership } from "../middleware/session.js";
import { asyncRoute } from "./asyncRoute.js";

export function doubtsRouter() {
  const router = express.Router();

  router.post(
    "/",
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

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const mine = Object.values(database.doubts).filter((d) => d.sessionId === req.sessionId);
      const filtered = req.query.documentId
        ? mine.filter((d) => d.documentId === req.query.documentId)
        : mine;
      res.json(filtered);
    })
  );

  return router;
}
