// lib/store.mjs
// Minimal file-backed persistence. No real accounts (PRD 10 — "Authentication:
// not yet required"), but data IS scoped to an anonymous guest session so one
// browser can't see another's documents/doubts/quizzes. Swap for a real DB
// when accounts are added; the shape below maps cleanly onto tables.

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "db.json");

const EMPTY_DB = {
  sessions: {}, // id -> { id, createdAt, lastSeenAt }
  documents: {}, // id -> { id, sessionId, filename, uploadedAt, extractedText, keyTerms, pageCount }
  doubts: {}, // id -> { id, sessionId, documentId, passage, note, createdAt }
  quizzes: {}, // id -> { id, sessionId, documentId, questions, createdAt }
  attempts: {}, // id -> { id, sessionId, quizId, documentId, answers[], score, createdAt }
  followUps: {}, // id -> { id, sessionId, attemptId, questionIndex, question, submitted, isCorrect, createdAt }
  reviewSchedules: {}, // "${sessionId}::${key}" -> { key, sessionId, intervalDays, nextReviewAt, lastOutcome, lastReviewedAt }
};

let cache = null;
let writeQueue = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DB_PATH, "utf-8");
    cache = JSON.parse(raw);
    // Migrate older db.json files that predate a given collection.
    for (const key of Object.keys(EMPTY_DB)) {
      if (!cache[key]) cache[key] = {};
    }
  } catch {
    cache = structuredClone(EMPTY_DB);
    await persist();
  }
  return cache;
}

async function persist() {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.writeFile(DB_PATH, JSON.stringify(cache, null, 2), "utf-8");
  });
  return writeQueue;
}

export const db = {
  async get() {
    return load();
  },
  async save() {
    return persist();
  },
};
