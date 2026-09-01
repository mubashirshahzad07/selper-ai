// backend/src/services/extraction.js
// Text-extraction concerns in one place, separate from raw AI calls (ai.js)
// and raw route handling. Two sources: PDF text layers (pdf-parse, no AI) and
// image OCR (Gemini vision, delegated to ai.js — returns word-level bounding
// boxes too, so the frontend can build a selectable word layer over images
// the same way it does for PDF pages).

import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { extractTextFromImage } from "./ai.js";

/**
 * Extract text + page count from a PDF buffer. No AI involved — this is the
 * PDF's own embedded text layer, if it has one (scanned PDFs won't).
 */
export async function extractPdfText(buffer) {
  const parsed = await pdfParse(buffer);
  return {
    text: parsed.text || "",
    pageCount: parsed.numpages ?? null,
  };
}

/**
 * Extract text + word bounding boxes from an image via Gemini vision OCR.
 * Returns { text, words } — words is [{ text, bbox: {x,y,w,h} }] normalised
 * 0-1 relative to the image dimensions, or [] if none were recoverable.
 * Throws on failure — callers decide whether that should fail the whole
 * request or just leave extraction empty (the upload route does the latter).
 */
export async function extractImageText(base64Data, mimeType) {
  return extractTextFromImage(base64Data, mimeType);
}
