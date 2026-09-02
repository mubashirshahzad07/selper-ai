// backend/src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

import { sessionMiddleware } from "./middleware/session.js";
import { documentsRouter } from "./routes/documents.js";
import { assistRouter } from "./routes/assist.js";
import { doubtsRouter } from "./routes/doubts.js";
import { quizzesRouter, attemptsRouter, followUpsRouter } from "./routes/quizzes.js";
import { reviewRouter } from "./routes/review.js";
import { calibrationRouter } from "./routes/calibration.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { settingsRouter } from "./routes/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// The frontend now lives in its own folder/origin (see ../../frontend), so
// this needs real CORS instead of relying on same-origin. No cookies are
// used — just the x-study-session header — so a permissive origin is fine
// for local dev. Set FRONTEND_ORIGIN in .env to lock this down for a real
// deployment (e.g. FRONTEND_ORIGIN=https://your-frontend.example.com).
const allowedOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin,
    exposedHeaders: ["x-study-session"],
    allowedHeaders: ["Content-Type", "x-study-session"],
  })
);

app.use(express.json({ limit: "5mb" }));

// Uploaded files still live under the backend (it's the service that wrote
// them) and are served here; the frontend fetches them cross-origin via the
// full backend URL — see frontend/js/config.js. CORS is applied above this,
// so Tesseract.js's client-side OCR (which draws the uploaded image onto a
// canvas) doesn't hit a cross-origin "tainted canvas" error.
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// Every route below is scoped to an anonymous guest session (see middleware/session.js).
// The session id is issued on first request via the x-study-session response
// header and echoed back by the client on every subsequent request.
app.use(sessionMiddleware);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

app.use("/api/documents", documentsRouter(upload));
app.use("/api/assist", assistRouter());
app.use("/api/doubts", doubtsRouter());
app.use("/api/quizzes", quizzesRouter());
app.use("/api/attempts", attemptsRouter());
app.use("/api/follow-ups", followUpsRouter());
app.use("/api/review-queue", reviewRouter());
app.use("/api/calibration", calibrationRouter());
app.use("/api/dashboard", dashboardRouter());
app.use("/api/settings", settingsRouter());

app.listen(PORT, () => {
  console.log(`Study Helper backend running at http://localhost:${PORT}`);
  console.log(`CORS allowed origin: ${allowedOrigin}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("⚠️  GEMINI_API_KEY is not set — OCR/definitions/summaries/translate/key-terms/grading will fail until you add it to .env");
  }
  if (!process.env.MANUS_API_KEY) {
    console.warn("⚠️  MANUS_API_KEY is not set — quiz generation will fail until you add it to .env");
  }
});
