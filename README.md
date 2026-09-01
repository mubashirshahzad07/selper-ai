# Study Helper

Source-preserving AI study workspace — Gemini-only, hosted-first (Alibaba AI Hackathon, Education track).

## Layout (backend/frontend split)

This was restructured from a single Express app (serving both the API and the static frontend)
into two independently deployable pieces, for scalability:

```
study-helper/
├── backend/                 API only — no frontend files in here
│   ├── src/
│   │   ├── index.js         entry point: mounts routers, CORS, session middleware
│   │   ├── routes/          one file per resource — documents, assist, doubts, quizzes, review, calibration
│   │   ├── services/        ai.js (Gemini), wikipedia.js, extraction.js, reviewQueue.js, spacedRepetition.js, calibration.js
│   │   ├── repositories/    store.js — the JSON-file persistence layer
│   │   └── middleware/      session.js — guest session issuance/ownership checks
│   ├── data/                db.json lives here (gitignored)
│   ├── uploads/             uploaded files (gitignored)
│   └── package.json
│
└── frontend/                 Plain HTML/CSS/JS — no build step, no framework
    ├── index.html
    ├── css/style.css
    ├── js/app.js             all client logic
    ├── js/config.js          points the frontend at the backend's URL
    └── serve.js               zero-dependency static server for local dev
```

**Nothing about how the app behaves changed** — every API route, URL path, and request/response
shape is identical to the single-app version. This was a pure reorganization plus the plumbing
needed to make two separate origins talk to each other (CORS, and pointing the frontend at the
backend's URL instead of assuming same-origin). See "What changed" below for the specifics.

## Running it

Two terminals, two `npm install`s — they're independent projects now.

**Backend:**
```bash
cd backend
npm install
cp .env.example .env
# edit .env — paste your Gemini key, and (optionally) restrict FRONTEND_ORIGIN
npm start
```
Runs on `http://localhost:3000` by default.

**Frontend:**
```bash
cd frontend
npm start
```
Runs on `http://localhost:8080` by default (via the included zero-dependency `serve.js` — no
framework, no build step, just static files). If your backend isn't on `localhost:3000`, edit
`frontend/js/config.js` and change `STUDY_HELPER_API_BASE`.

Open `http://localhost:8080`.

## What changed in the restructuring

- **CORS added** (`backend/src/index.js`) — the frontend is a different origin now, so this needed
  real CORS instead of relying on same-origin. No cookies are used (just the `x-study-session`
  header), so a permissive origin (`*`) is fine for local dev; set `FRONTEND_ORIGIN` in `.env` to
  lock it down for a real deployment.
- **`frontend/js/config.js`** — new file, sets `window.STUDY_HELPER_API_BASE`. Every backend-bound
  URL in `app.js` (API calls *and* asset URLs like uploaded file paths) now resolves through a
  `backendUrl()` helper that prefixes this base — a bare `/api/...` would otherwise resolve
  against the frontend's own origin instead of the backend's.
- **Tesseract.js cross-origin fix** — the client-side OCR fallback draws the uploaded image onto a
  canvas internally, which throws a "tainted canvas" security error on a cross-origin image unless
  `crossOrigin = "anonymous"` is set on the `<img>` *and* the server sends
  `Access-Control-Allow-Origin` on that image response. Both are now in place (the crossOrigin
  attribute in `app.js`, the CORS middleware applied before the `/uploads` static route in
  `index.js`) — tested directly against a live cross-origin request.
- **`backend/src/services/extraction.js`** — new file, wraps `pdf-parse` and delegates image OCR to
  `ai.js`, so route handlers don't call extraction libraries directly.
- **One router per resource** instead of one big `server.js` — `documents.js`, `assist.js`,
  `doubts.js`, `quizzes.js` (also exports `attemptsRouter`/`followUpsRouter`), `review.js`,
  `calibration.js`. Every one of the 14 original URL paths maps to the exact same path in the new
  routers — verified directly (see testing below), not just eyeballed.

## Tested, not just restructured

I actually booted both servers on separate ports and ran real cross-origin requests against them
in this sandbox — not just a syntax check:

- CORS preflight (`OPTIONS`) from the frontend's origin to the backend — confirmed
  `Access-Control-Allow-Headers` includes `x-study-session` and `Access-Control-Expose-Headers`
  lets the frontend read it back
- A real cross-origin file upload with an `Origin: http://localhost:8080` header — confirmed the
  response carries the right CORS + session headers, and a follow-up authenticated request
  (fetching the doc back) works with that session
- The static `/uploads/*` file route sends `Access-Control-Allow-Origin` (required for the
  Tesseract canvas fix above) — confirmed directly on a real file response
- Every route family — documents, doubts, review-queue, calibration, assist (graceful failure
  without a key) — hit live and returned the expected shape
- All 16 backend files pass `node --check`; frontend `app.js`/`index.html` checked for valid JS and
  balanced markup

## What's carried over unverified

Same caveat as before the restructuring: this sandbox can't reach Google's or Wikipedia's APIs, so
the actual Gemini-backed calls (definitions, summaries, quiz generation, OCR, key terms) are
correct against their documented shape but not live-tested here. Everything AI-independent —
uploads, extraction pipeline wiring, sessions, doubts, review-queue math, spaced repetition,
calibration, and now the full cross-origin plumbing — has been.

## Known gaps

- Scanned/image-based PDFs (no embedded text layer) still don't get OCR — only direct image
  uploads do. Rasterizing PDF pages to run through the same OCR path is future work.
- No real database — `backend/data/db.json` is a flat file. Fine for a demo, not for concurrent
  production traffic; the `repositories/store.js` interface is deliberately thin so swapping in a
  real DB later shouldn't require touching the routes.
- No authentication — guest sessions only, matching the PRD's stated "not yet required."
