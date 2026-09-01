// backend/src/routes/assist.js
import express from "express";

import { resolveWordSense, summarizePassage, translateToUrdu } from "../services/ai.js";
import { fetchWikipediaDefinition } from "../services/wikipedia.js";
import { asyncRoute } from "./asyncRoute.js";

export function assistRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Right-click: word definition (Gemini resolves sense from context -> Wikipedia
  // supplies the definition). No Urdu translation here — that's a separate action.
  // ---------------------------------------------------------------------------
  router.post(
    "/define",
    asyncRoute(async (req, res) => {
      const { word, context } = req.body || {};
      if (!word || !context) {
        return res.status(400).json({ error: "word and context are required." });
      }

      const sense = await resolveWordSense(word, context);

      // Wikipedia stays as an optional deep-dive reference; the primary answer is
      // the concise Gemini definition so the card reads like a chat reply.
      let wikipedia = null;
      try {
        wikipedia = await fetchWikipediaDefinition(sense.searchTitle || word);
      } catch (e) {
        wikipedia = null;
      }

      res.json({
        word,
        resolvedSense: sense.sense,
        searchTitle: sense.searchTitle,
        definition: sense.definition || sense.sense || "",
        wikipedia, // { title, extract, url } or null if Wikipedia had no match
      });
    })
  );

  // ---------------------------------------------------------------------------
  // Right-click: sentence/passage summary. No Urdu translation here either —
  // separate action, see /translate below.
  // ---------------------------------------------------------------------------
  router.post(
    "/summarize",
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
  router.post(
    "/translate",
    asyncRoute(async (req, res) => {
      const { text } = req.body || {};
      if (!text) return res.status(400).json({ error: "text is required." });

      const urdu = await translateToUrdu(text);
      res.json({ urdu });
    })
  );

  return router;
}
