// backend/src/services/extraction.js
// Text-extraction concerns in one place, separate from raw AI calls (ai.js)
// and raw route handling. Two sources: PDF text layers (pdf-parse, no AI) and
// image OCR (Gemini vision, delegated to ai.js — returns word-level bounding
// boxes too, so the frontend can build a selectable word layer over images
// the same way it does for PDF pages).

import pdfParse from "pdf-parse/lib/pdf-parse.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createRequire } from "module";
import { pathToFileURL } from "url";

import { extractTextFromImage } from "./ai.js";

// pdf.js in Node has no DOM worker; point it at the legacy worker module so it
// can fall back to a "fake worker" that imports the file directly.
const nodeRequire = createRequire(import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  nodeRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
).href;

// Rasterisation budget for scanned-PDF OCR. One Gemini vision call per page is
// expensive, so cap the pages we process and render at a width that is large
// enough for OCR without blowing up tokens/time.
const SCANNED_MAX_PAGES = 20;
const SCANNED_TARGET_WIDTH = 1200;

/** Minimal canvas factory backed by @napi-rs/canvas for pdf.js in Node. */
function makeCanvasFactory() {
  return {
    create(width, height) {
      const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
      return { canvas, context: canvas.getContext("2d") };
    },
    reset(pair, width, height) {
      pair.canvas = createCanvas(Math.max(1, width), Math.max(1, height));
      pair.context = pair.canvas.getContext("2d");
    },
    destroy() {},
  };
}

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

/**
 * Rasterise PDF pages to PNG base64 strings using pdf.js + @napi-rs/canvas.
 * Used as the fallback for scanned/rasterized PDFs that have no embedded text
 * layer. Returns [{ pageNumber, base64 }] (capped at SCANNED_MAX_PAGES).
 */
export async function renderPdfPagesToImages(buffer, { maxPages = SCANNED_MAX_PAGES } = {}) {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    canvasFactory: makeCanvasFactory(),
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages = [];
  try {
    const count = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, SCANNED_TARGET_WIDTH / base.width);
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      const ctx = canvas.getContext("2d");
      // White background — scanned pages can be transparent and OCR reads better
      // on white.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport, canvasFactory: makeCanvasFactory() }).promise;
      pages.push({ pageNumber: n, base64: canvas.toBuffer("image/png").toString("base64") });
      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }
  return pages;
}

/** Concatenate two PDF CTM matrices ([a,b,c,d,e,f] each). */
function mulCtm(a, b) {
  const [a1, b1, c1, d1, e1, f1] = a;
  const [a2, b2, c2, d2, e2, f2] = b;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/** Normalised (0-1) page rect for an image drawn in the unit square under ctm. */
function ctmToNormalisedRect(ctm, viewport) {
  const [a, b, c, d, e, f] = ctm;
  const x1 = e, y1 = f;
  const x2 = a + c + e, y2 = b + d + f;
  const userRect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  let vr;
  try {
    vr = viewport.convertToViewportRectangle(userRect);
  } catch {
    vr = userRect;
  }
  const [vx1, vy1, vx2, vy2] = vr;
  return {
    x: Math.max(0, Math.min(vx1, vx2) / viewport.width),
    y: Math.max(0, Math.min(vy1, vy2) / viewport.height),
    w: Math.min(1, Math.abs(vx2 - vx1) / viewport.width),
    h: Math.min(1, Math.abs(vy2 - vy1) / viewport.height),
  };
}

/**
 * Walk a page's operator list and collect embedded image XObjects with their
 * normalised page positions. Skips tiny images (icons/rules) that aren't worth
 * OCR-ing.
 */
async function collectImageBlocks(page, viewport) {
  const blocks = [];
  let ops;
  try {
    ops = await page.getOperatorList();
  } catch {
    return blocks;
  }
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === pdfjsLib.OPS.transform) {
      ctm = mulCtm(ctm, args);
    } else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintJpegXObject) {
      const rect = ctmToNormalisedRect(ctm, viewport);
      if (rect.w >= 0.08 && rect.h >= 0.05) blocks.push({ name: args[0], rect });
    } else if (fn === pdfjsLib.OPS.paintInlineImageXObject) {
      const rect = ctmToNormalisedRect(ctm, viewport);
      if (rect.w >= 0.08 && rect.h >= 0.05) blocks.push({ inline: args[0], rect });
    }
  }
  return blocks;
}

/** Turn a pdf.js image object (RGB/RGBA) into an @napi-rs/canvas, or null. */
function imageObjectToCanvas(imgObj) {
  if (!imgObj || !imgObj.width || !imgObj.height || !imgObj.data) return null;
  const { width, height, data } = imgObj;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  if (data.length === width * height * 4) {
    img.data.set(data);
  } else if (data.length === width * height * 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      img.data[j] = data[i];
      img.data[j + 1] = data[i + 1];
      img.data[j + 2] = data[i + 2];
      img.data[j + 3] = 255;
    }
  } else {
    return null; // unsupported pixel format (e.g. 1bpp) — skip this block
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Scale a canvas down to ~targetWidth and return a white-backed PNG base64. */
function canvasToPngBase64(src, targetWidth = 600) {
  const scale = Math.min(1, targetWidth / src.width) || 1;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = createCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  return out.toBuffer("image/png").toString("base64");
}

async function renderPageToPngBase64(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, SCANNED_TARGET_WIDTH / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvasFactory: makeCanvasFactory() }).promise;
  return canvas.toBuffer("image/png").toString("base64");
}

async function safeOcr(base64) {
  try {
    return await extractTextFromImage(base64, "image/png");
  } catch {
    return { text: "", words: [] };
  }
}

/** Fetch a named image XObject, giving up after a timeout instead of hanging. */
function getImageObject(page, name, timeoutMs = 8000) {
  return Promise.race([
    new Promise((res) => {
      try {
        page.objs.get(name, res);
      } catch {
        res(null);
      }
    }),
    new Promise((res) => setTimeout(() => res(null), timeoutMs)),
  ]);
}

/**
 * Hybrid OCR for PDFs that mix native text, embedded images, and fully-scanned
 * pages. Per page:
 *   - no text items            -> full-page vision OCR (scanned page)
 *   - text + image XObjects    -> per-image-block vision OCR (mixed page); the
 *                                 native text stays selectable via the text layer
 *   - text only                -> skipped (nothing to OCR)
 * Returns { pages: { "1": { text, words, hasNativeText, images? } }, fullText }
 * where every word bbox is normalised 0-1 relative to the PAGE, so the frontend
 * can drop them straight into the page's text layer. Gemini calls are capped.
 */
export async function extractScannedPdfText(buffer, { maxPages = SCANNED_MAX_PAGES } = {}) {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    canvasFactory: makeCanvasFactory(),
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages = {};
  const textParts = [];
  let geminiCalls = 0;

  try {
    const count = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });

      let textItems = 0;
      try {
        const tc = await page.getTextContent();
        textItems = tc.items.filter((i) => i.str && i.str.trim()).length;
      } catch {}

      if (textItems === 0) {
        // Fully scanned/rasterized page -> one full-page vision call.
        if (geminiCalls < SCANNED_MAX_PAGES) {
          geminiCalls++;
          const r = await safeOcr(await renderPageToPngBase64(page));
          pages[n] = { text: r.text, words: r.words, hasNativeText: false };
          if (r.text) textParts.push(r.text);
        }
      } else {
        // Page has native text; OCR any embedded image blocks (mixed content).
        const blocks = await collectImageBlocks(page, viewport);
        if (blocks.length > 0) {
          const images = [];
          const pageWords = [];
          for (const b of blocks) {
            if (geminiCalls >= SCANNED_MAX_PAGES) break;
            let imgObj = b.inline || null;
            if (!imgObj && b.name) {
              imgObj = await getImageObject(page, b.name);
            }
            const canvas = imageObjectToCanvas(imgObj);
            if (!canvas) continue;
            geminiCalls++;
            const r = await safeOcr(canvasToPngBase64(canvas));
            // Map image-relative word boxes onto the page using the block rect.
            for (const w of r.words || []) {
              pageWords.push({
                text: w.text,
                bbox: {
                  x: b.rect.x + w.bbox.x * b.rect.w,
                  y: b.rect.y + w.bbox.y * b.rect.h,
                  w: w.bbox.w * b.rect.w,
                  h: w.bbox.h * b.rect.h,
                },
              });
            }
            images.push({ imageIndex: images.length, text: r.text, words: r.words, rect: b.rect });
            if (r.text) textParts.push(r.text);
          }
          if (images.length > 0) {
            pages[n] = { text: images.map((i) => i.text).join(" "), words: pageWords, hasNativeText: true, images };
          }
        }
        // text-only pages are intentionally skipped (no ocrData entry).
      }
      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }

  return { pages, fullText: textParts.join("\n\n") };
}
