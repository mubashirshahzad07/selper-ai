# Study Helper

Source-preserving AI study workspace — Gemini-only, hosted-first (Alibaba AI Hackathon, Education track).

## What's actually built and tested here

- Express + Node backend (`server.js`), file-backed JSON store (`lib/store.mjs`)
- PDF upload + text extraction (`pdf-parse`) — **tested, works**
- Doubt notebook (save/list) — **tested, works**
- **Guest sessions** (`lib/session.mjs`) — every browser gets an anonymous `x-study-session` id on
  first request (stored in `localStorage` client-side); all documents, doubts, quizzes, and
  attempts are scoped to it. **Tested**: confirmed a session with no/wrong header gets 404s on
  another session's data, and two uploads from different sessions get different session ids.
  Ported from an earlier prototype's `requireSession` pattern.
- **Wrong-answer follow-up** (`/api/attempts/:id/follow-up`, `/api/follow-ups/:id/submit`) — after
  a wrong quiz answer, the student can request one AI-generated retest of the same concept,
  graded deterministically. **Tested the guard rails**: rejects follow-up requests on an already-
  correct answer (400), rejects cross-session access (404), fails gracefully (no crash) when
  Gemini isn't reachable. The actual Gemini-backed generation is untested for the same reason as
  the rest of the AI routes — see below.
- Deterministic review-queue priority ordering (`lib/review.mjs`) — **unit-tested, confirmed correct**:
  confident-but-wrong → conceptual errors → saved doubts → careless/terminology → recency tiebreaker
- Static frontend: PDF.js page-first reader with a **word-level text layer** (every word is its own
  span so right-click always targets one word), rounded-corner highlight rect, context menu,
  floating result card, quiz UI with inline follow-up questions, drawers for doubts/review queue
- Gemini provider (`lib/ai.mjs`) — key-term extraction, word-sense resolution, Urdu translation,
  passage summarization, structured quiz JSON generation with fallback models, follow-up question
  generation
- Wikipedia definition resolver (`lib/wikipedia.mjs`)
- Deterministic server-side quiz grading — no second AI call

## What is NOT tested (and why)

I built and ran this from a sandboxed container whose network is locked to npm/pypi/github —
it cannot reach `generativelanguage.googleapis.com` or `en.wikipedia.org`. So:

- **Every Gemini-backed route** (`/api/documents/:id/key-terms`, `/api/assist/define`,
  `/api/assist/summarize`, `/api/documents/:id/quiz`) is written against Gemini's real REST API
  shape but has **not been called against the live API**.
- **The Wikipedia resolver** is written against the real MediaWiki REST endpoints but likewise
  **not live-tested**.

Everything else (upload, extraction, doubts, review queue math, static assets, PDF rendering
pipeline) I did run end-to-end against a real PDF and confirmed working.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and paste your key from https://ai.google.dev/gemini-api/docs/pricing
npm start
```

Open `http://localhost:3000`.

If a Gemini call fails, the app surfaces the actual error in the assist card / quiz panel instead
of failing silently — check your key and the browser console/server log first.

**Model names go stale — this has already happened twice while building this.** Google retires
Gemini model ids on a rolling schedule. `gemini-1.5-*` and `gemini-2.5-*` are both already retired
as of this writing (Aug 2026) — `.env.example` is now on `gemini-3.6-flash` / `gemini-3.5-flash-lite`
(GA since July 2026). If AI calls start returning 404s again, check
https://ai.google.dev/gemini-api/docs/models for current ids and update the `GEMINI_MODEL_*`
variables in `.env` — no code changes needed, the model id is fully driven by env vars.

Also worth knowing: Gemini 3.x's docs recommend against overriding `temperature`/`top_p`/`top_k` —
its reasoning is tuned for the defaults — so `lib/ai.mjs` no longer sets a custom temperature.

**Timeouts:** quiz generation and follow-up questions get 45s (structured 5-question JSON takes
longer than a one-line definition) and now genuinely fall back to a different, lighter model
(`GEMINI_MODEL_QUIZ_FALLBACK`, defaults to Flash-Lite) instead of retrying the identical model —
the earlier version retried the same model on timeout, which just meant waiting twice for the
same slow response.

**Quiz is now full-screen and distraction-free.** It used to render inline in the narrow sidebar
right next to the visible source PDF — a student could just glance left and read the answer off
the slide. Quizzes now open in a full-screen overlay (one question at a time, with a progress bar)
that hides the reader entirely until the quiz is submitted; results and follow-up retests also
happen inside that overlay.

**Popup z-index fixed.** The assist card used to render above the fixed topbar when scrolled near
the top of a page. It's now z-indexed below the topbar and its vertical position is clamped so it
never renders under/over the header.

**Confidence calibration (new).** A "Confidence check" drawer next to Review queue — not another
score, but whether "I'm confident" actually tracks being right. It shows the headline
confident-wrong rate, an accuracy breakdown by confidence level (confident/unsure/guessing), and
the most recent confident misses. Pure computation over quiz attempts already on file
(`lib/calibration.mjs`) — no new AI call, no new stored data, session-scoped like everything else.
**Tested**: unit-tested the math directly (mixed confidence levels, empty-state null-safety), and
tested the live endpoint with seeded data confirming two different sessions only ever see their
own stats.

**OCR / image documents (new).** Closes a gap the PRD names explicitly ("Image-only documents:
stored, but no OCR or vision reasoning is complete"). Uploading an image (not a PDF) now runs it
through Gemini's vision input (`extractTextFromImage` in `lib/ai.mjs`) to transcribe readable
text — lecture slides, handwriting, whiteboard photos — which then feeds key terms, quizzes, and
define/summarize exactly like PDF text does. If OCR fails (no key, network issue), the upload
still succeeds — the image displays, extraction-dependent features just won't have text to work
with, and the failure reason is surfaced (`ocrError` in the upload response) instead of silently
swallowed. **Tested**: uploaded a real image with no Gemini key configured and confirmed it
degrades gracefully (200 response, `ocrApplied: false`, error message included, server stays up)
rather than crashing; confirmed PDF uploads are unaffected by the change.

**Spaced repetition on the review queue (new).** The review queue used to be a flat list with no
sense of *when* to come back to something. Each doubt/weak-quiz-answer now carries a simple
SM-2-lite interval schedule (`lib/spaced-repetition.mjs`): mark an item "Got it" and its interval
grows (1 → 3 → 7 → 14 → 30 days); mark it "Missed it" and it resets to 1 day. The drawer splits
into a "Due now" section (with the mark buttons) and an "Upcoming" section showing days until
next review. New endpoint `POST /api/review-queue/mark` advances the schedule, with ownership
checked by parsing the item's key back to the doubt/attempt it points at.
**Tested**: unit-tested the interval progression directly (climb, reset-on-miss, cap at 30 days,
due/not-due date math), unit-tested the due-first/upcoming-last sort against `buildReviewQueue`,
and ran the full live flow end-to-end — save a doubt, confirm it's due, mark it remembered,
confirm it moves to upcoming with the right day count, confirm a different session gets a 404
trying to mark it, confirm a malformed key is rejected with 400. Also confirmed the old review-
queue priority-ordering test still passes unchanged when no schedule data exists.

## Deploying (you'll need to do this part yourself)

1. Push this folder to a GitHub repo.
2. Go to vercel.com → New Project → import the repo.
3. In Vercel's project settings → Environment Variables, add `GEMINI_API_KEY`.
4. Vercel auto-detects the Node/Express entry (`server.js`). If it doesn't build cleanly as-is,
   add a minimal `vercel.json`:
   ```json
   { "builds": [{ "src": "server.js", "use": "@vercel/node" }],
     "routes": [{ "src": "/(.*)", "dest": "server.js" }] }
   ```
5. Note: Vercel's serverless filesystem is **read-only except `/tmp`**, so the JSON file store
   (`lib/store.mjs`) and `multer`'s disk uploads will NOT persist across requests once deployed —
   fine for a live demo within one request cycle, but you'll want to swap in a real database
   (Postgres/SQLite via a hosted provider, or Vercel KV) and object storage (S3/Vercel Blob)
   before this is durable in production. This wasn't in scope for what I could verify here.

## Known gaps vs. the PRD

- OCR / image-document reasoning: **now implemented** for direct image uploads via Gemini vision
  (see above). Still not implemented: rasterizing a *scanned/image-based PDF* page-by-page to run
  through the same OCR path — that requires a PDF-to-image rendering step this build doesn't have.
  A scanned PDF will still upload and display, just without text extraction.
- Focus mode: not implemented.
- Authentication: not implemented (matches PRD — "not yet required").
- The word-level PDF text layer uses proportional character-count width estimation rather than
  true per-glyph metrics — good enough for right-click targeting, not pixel-perfect at all zoom
  levels.
- No automated test suite beyond the review-queue unit check described above — I'd add API-route
  tests with a mocked Gemini client next.
