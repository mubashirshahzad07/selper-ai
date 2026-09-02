// backend/src/services/providers/manus.js
// Thin adapter around Manus's agent-task API (task.create -> poll
// task.listMessages). Exposes manusComplete() / manusCompleteWithRetry(),
// matching the shape of geminiComplete() / geminiCompleteWithRetry() in
// ./gemini.js so ai.js can call either provider without caring which one
// it is.
//
// Used for: Quiz Generation (generateQuiz, generateFollowUpQuestion in
// ai.js) — see ai.js for the provider assignment rationale. Manus's API is
// agent-task based, not a synchronous completion API: task.create -> poll
// task.listMessages until the agent stops. That's a reasonable trade for
// quiz generation, which already runs after a deliberate "generate my quiz"
// click rather than needing sub-second response like a right-click lookup.

import fetch from "node-fetch";

const API_BASE = process.env.MANUS_API_BASE || "https://api.manus.ai/v2";

// "lite" is Manus's stable alias for its lightweight agent tier — currently
// Manus Lite 1.6. Versioned aliases like "1.6-lite" are also accepted by the
// API but the version segment is ignored (you can't pin a specific point
// version independently), so "lite" is the correct, forward-compatible value.
const DEFAULT_AGENT_PROFILE = process.env.MANUS_AGENT_PROFILE || "lite";

function apiKey() {
  const key = process.env.MANUS_API_KEY;
  if (!key) {
    const err = new Error(
      "MANUS_API_KEY is not set. Add it to your .env file — see .env.example."
    );
    err.code = "NO_API_KEY";
    throw err;
  }
  return key;
}

function authHeaders() {
  return { "Content-Type": "application/json", "x-manus-api-key": apiKey() };
}

/**
 * Convert our lowercase JSON-Schema-style schemas into Manus's expected format.
 * Manus v2 appears to use OpenAPI 3.0 Schema objects with uppercase Type enums,
 * similar to Gemini. This mirrors the toGeminiSchema() conversion.
 */
function toManusSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const out = { type: String(schema.type || "object").toUpperCase() };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;

  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toManusSchema(value);
    }
  }
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toManusSchema(schema.items);

  return out;
}

// ---------------------------------------------------------------------------
// Concurrency pool — Manus caps concurrent tasks per account (commonly 20),
// not requests-per-minute. Quiz generation + follow-ups are the only things
// routed here now, so this is mostly headroom, but it still protects against
// a burst of simultaneous "generate quiz" clicks across sessions.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_TASKS = Number(process.env.MANUS_MAX_CONCURRENT_TASKS) || 2;
let activeTasks = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeTasks < MAX_CONCURRENT_TASKS) {
    activeTasks++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve)).then(() => {
    activeTasks++;
  });
}

function releaseSlot() {
  activeTasks--;
  const next = waitQueue.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Rate limiter for task.create — Manus limits this to 10/min. We track
// timestamps of recent task.create calls and delay if we'd exceed the limit.
// ---------------------------------------------------------------------------
const TASK_CREATE_LIMIT_PER_MIN = 10;
const taskCreateTimestamps = [];

async function waitForRateLimit() {
  const now = Date.now();
  while (taskCreateTimestamps.length > 0 && taskCreateTimestamps[0] < now - 60000) {
    taskCreateTimestamps.shift();
  }
  if (taskCreateTimestamps.length >= TASK_CREATE_LIMIT_PER_MIN) {
    const waitMs = taskCreateTimestamps[0] + 60000 - now;
    if (waitMs > 0) {
      console.warn(`[AI] Rate limit: waiting ${Math.ceil(waitMs / 1000)}s before next task.create`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  taskCreateTimestamps.push(Date.now());
}

async function createTask({ prompt, schema = null, agentProfile = null }) {
  // Enforce Manus's 10/min task.create rate limit before making the call.
  await waitForRateLimit();

  const body = {
    message: { content: prompt },
    agent_profile: agentProfile || DEFAULT_AGENT_PROFILE,
  };
  if (schema) body.structured_output_schema = toManusSchema(schema);

  console.log("[Manus] task.create payload:", JSON.stringify({ ...body, message: { content: prompt.slice(0, 100) + "..." } }, null, 2));

  const res = await fetch(`${API_BASE}/task.create`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Manus task.create failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Manus task.create returned an error: ${data?.error?.message || "unknown error"}`);
  }
  return data.task_id;
}

async function pollTask(taskId, { timeoutMs = 90000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${API_BASE}/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=20`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Manus task.listMessages failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const events = data.events || data.messages || [];
    const statusEvent = events.find((e) => e.type === "status_update");
    const status = statusEvent?.status_update?.agent_status;

    if (status === "error") {
      throw new Error(`Manus task ${taskId} failed: ${statusEvent?.status_update?.error_message || "unknown error"}`);
    }

    if (status === "waiting") {
      // None of these calls should ever need user confirmation (no
      // connectors/skills enabled) — if this fires, something upstream
      // changed and the caller needs to know rather than hang forever.
      throw new Error(`Manus task ${taskId} unexpectedly requested user input.`);
    }

    if (status === "stopped") {
      const structured = events.find((e) => e.type === "structured_output_result");
      if (structured) {
        const result = structured.structured_output_result;
        if (!result.success) {
          throw new Error(`Manus structured output extraction failed: ${result.error}`);
        }
        return { value: result.value };
      }
      // No schema was requested — fall back to the plain assistant text.
      const assistantMsg = [...events].reverse().find((e) => e.type === "assistant_message");
      const parts = assistantMsg?.assistant_message?.content;
      const text = Array.isArray(parts)
        ? parts.map((p) => p.text).filter(Boolean).join("\n")
        : assistantMsg?.assistant_message?.text ?? "";
      return { text };
    }

    // status === "running" (or missing while the task spins up) — keep polling.
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Manus task ${taskId} timed out after ${timeoutMs}ms.`);
}

/**
 * Create + poll a Manus task through the concurrency pool.
 * @returns {Promise<{ value: any } | { text: string }>}
 */
export async function manusComplete({ prompt, schema = null, agentProfile = null, timeoutMs }) {
  await acquireSlot();
  try {
    const taskId = await createTask({ prompt, schema, agentProfile });
    return await pollTask(taskId, { timeoutMs: timeoutMs || 90000 });
  } finally {
    releaseSlot();
  }
}

/** Retry wrapper for Manus calls that may fail due to transient issues. */
export async function manusCompleteWithRetry(opts, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await manusComplete(opts);
    } catch (err) {
      lastErr = err;
      // Don't retry on client errors (4xx) or user-input requests.
      if (err.status && err.status < 500) throw err;
      if (err.message.includes("unexpectedly requested user input")) throw err;
      console.warn(`[AI] Manus call failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      if (attempt < maxRetries) {
        // Exponential backoff: 3s, 9s, 27s...
        await new Promise((r) => setTimeout(r, 3000 * Math.pow(3, attempt)));
      }
    }
  }
  throw lastErr;
}
