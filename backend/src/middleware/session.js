// backend/src/middleware/session.js
// Lightweight guest sessions, no passwords/accounts. A session id scopes all
// documents/doubts/quizzes/attempts so one browser's data stays private from
// another's — the same shape as selper-ai-main's requireSession, adapted to
// this project's plain-Express + JSON-store setup.

import { nanoid } from "nanoid";
import { db } from "../repositories/store.js";

const HEADER = "x-study-session";

export async function sessionMiddleware(req, res, next) {
  const database = await db.get();
  const incoming = req.header(HEADER);

  let sessionId = incoming && database.sessions[incoming] ? incoming : null;

  if (!sessionId) {
    sessionId = `guest_${nanoid(12)}`;
    database.sessions[sessionId] = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    await db.save();
  } else {
    database.sessions[sessionId].lastSeenAt = new Date().toISOString();
    // Not awaited on purpose — a lastSeen touch shouldn't slow down every request.
    db.save().catch(() => {});
  }

  req.sessionId = sessionId;
  // Expose so the browser can read it via fetch's Response.headers (same-origin).
  res.setHeader("Access-Control-Expose-Headers", HEADER);
  res.setHeader(HEADER, sessionId);
  next();
}

/** Throws a 404-shaped error if the owner field doesn't match the request's session. */
export function assertOwnership(record, req, label = "Resource") {
  if (!record || record.sessionId !== req.sessionId) {
    const err = new Error(`${label} not found.`);
    err.status = 404;
    throw err;
  }
}
