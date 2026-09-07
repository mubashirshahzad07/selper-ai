# Study Helper

Source-preserving AI study workspace (Alibaba AI Hackathon, Education track). Upload a PDF or
image, read it with the original layout preserved, and use right-click AI tools to look things up,
quiz yourself, and review what you got wrong — all without losing your place in the source.

Two AI providers, chosen per call for latency and reliability:

- **Gemini** — fast, on-demand interactive calls: image OCR, word definitions, Urdu translation,
  passage summaries, and key-term extraction.
- **Manus** — agent-task calls where a multi-second wait is expected anyway: quiz generation,
  follow-up questions, and free-text grading.

See the top of `backend/src/services/ai.js` for the full provider-split rationale.

## Layout (backend/frontend split)

This was restructured from a single Express app (serving both the API and the static frontend)
into two independently deployable pieces, for scalability:

```
study-helper/
├── backend/                 API only — no frontend files in here
│   ├── src/
│   │   ├── index.js         entry point: mounts routers, CORS, session middleware
│   │   ├── routes/          one file per resource — documents, assist, doubts, quizzes, review, calibration, settings
│   │   ├── services/        ai.js (Gemini + Manus routing), prompts.js (all prompt wording),
│   │   │                    providers/gemini.js, providers/manus.js, wikipedia.js,
│   │   │                    extraction.js, reviewQueue.js, spacedRepetition.js, calibration.js
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
    └── serve.js              zero-dependency static server for local dev
```

**Nothing about how the app behaves changed** in the restructuring — every API route, URL path,
and request/response shape is identical to the single-app version. It was a pure reorganization
plus the plumbing needed to make two separate origins talk to each other (CORS, and pointing the
frontend at the backend's URL instead of assuming same-origin). See "What changed" below.

## Running it

Two terminals, two `npm install`s — they're independent projects now.

**Backend:**
```bash
cd backend
npm install
cp .env.example .env
# edit .env — paste your Gemini key AND your Manus key, and (optionally) restrict FRONTEND_ORIGIN
npm run dev      # hot-reload during development; use npm start for a plain run
```
Runs on `http://localhost:3000` by default.

**Frontend:**
```bash
cd frontend
npm install
npm start
```
Runs on `http://localhost:8080` by default (via the included zero-dependency `serve.js` — no
framework, no build step, just static files). If your backend isn't on `localhost:3000`, edit
`frontend/js/config.js` and change `STUDY_HELPER_API_BASE`.

Open `http://localhost:8080`.

> Run the backend with `npm run dev` (not just `npm start`) while developing — it uses
> `node --watch`, so edited modules reload automatically. A plain `npm start` keeps the modules it
> loaded at boot, so a code fix won't reach the running server until you restart it.

## Secrets handling

`backend/.env` holds your live API keys and is **gitignored** (both `/.gitignore` and
`backend/.gitignore` list `.env` / `.env.*` and un-ignore only `.env.example`). Commit
`backend/.env.example` (placeholders only) — never a real `.env`. Rotate any key that has ever
been pasted into a shared channel or pushed to a remote.

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
  `Access-Control-Allow-Origin` on that image response. Both are now in place.
- **`backend/src/services/extraction.js`** — new file, wraps `pdf-parse` and delegates image OCR to
  `ai.js`, so route handlers don't call extraction libraries directly.
- **`backend/src/services/prompts.js`** — new file, the single source of truth for every prompt
  string sent to either provider. Edit wording once there and it applies to every call path.
- **One router per resource** instead of one big `server.js` — `documents.js`, `assist.js`,
  `doubts.js`, `quizzes.js` (also exports `attemptsRouter`/`followUpsRouter`), `review.js`,
  `calibration.js`, `dashboard.js`, `settings.js`. Every original URL path maps to the exact same
  path in the new routers.

## Reliability & correctness work

- **Manus task-propagation fix** — a freshly created Manus task briefly answers `404` on
  `task.listMessages` before it becomes queryable. The poller now pauses before its first read and
  tolerates `404` for a bounded grace window (`MANUS_TASK_GRACE_MS`, default 30s) instead of
  failing the whole generation, and errors carry their HTTP status so genuine failures aren't
  retried pointlessly.
- **Grading schema fix** — Manus rejects any `structured_output_schema` whose top-level object
  omits `additionalProperties: false` (Gemini tolerates its absence). All Manus-bound schemas now
  set it, so free-text grading no longer fails with `400 invalid_argument`.
- **Regrade failed items** — a grading failure is written with a canonical marker that both the
  retry filter and the frontend button recognise, so an answer that failed once stays retryable
  rather than getting stranded. History → **🔄 Regrade failed items** re-grades only those.
- **Settings screen** — API keys and model choices are editable from the UI (held in memory for the
  running process) and study data can be cleared per session.

## Recent UI fixes

1. **Logo → home** — Clicking the Study Helper logo in the top bar returns the user to the
   home/upload page, clearing the current document, zoom, and any open overlays/drawers/modals.
2. **Instant flicker-free zoom** — Zooming executes immediately in place with zero flicker. Pages
   scale via hardware-accelerated transforms while high-DPI canvases render in the background using
   off-screen swaps and cached text extraction; the viewport-center anchor is maintained.
3. **Dynamic zoom limits** — Replaced the static 200% cap with a ceiling computed from the visible
   reading width and actual word bounds, so pages expand to the maximum readable size without
   clipping under adjacent panes.
4. **Uniform page sizing** — Page widths stay strictly uniform across all pages during zoom in and
   out, eliminating mismatched page widths.
5. **Dark / light mode** — Theme toggle (☾ / ☀) in the top bar. Preference saves to `localStorage`
   and falls back to the OS `prefers-color-scheme`. Dark mode uses a neutral `#121212` base with
   green as accent only; all CSS tokens are theme-aware via `html[data-theme="dark"]`.
6. **Definition card shows the selected text** — The right-click definition popup titles itself
   with the exact word/phrase you selected (the resolved sense appears as a subtitle), not the
   broader Wikipedia article name.
7. **AI reliability** — Interactive Gemini calls use a single fast retry with short backoff; clear
   messages when the key is missing, content is blocked, or the backend is unreachable;
   markdown-fenced JSON is unwrapped automatically.
8. **Lower latency** — Tighter prompt context windows, lower timeouts for interactive actions, an
   in-memory definition cache (re-looking up a word is instant), faster Manus polling (1.5s), and
   clearer network-error messages pointing at the backend URL.
9. **Dark-mode quiz contrast** — Quiz questions, options, explanations, and results use theme-aware
   tokens so content stays readable in dark mode.
10. **Green color palette & student-focused redesign** — Calming green/mint scheme optimized for
    study focus: forest green (`#2E7D5C`) accent in light mode, bright mint (`#4CAF7D`) in dark;
    subtle gradients for depth; reorganized topbar hierarchy; consistent hover feedback.
11. **Page progress indicator** — Real-time reading progress in the reader toolbar (current page /
    total + percentage), updates on scroll, zoom, and mode switch, resets on document clear.
12. **Loading animations** — Modern loaders for every async op: dual-ring spinner (quiz), wave bars
    (key terms), pulsing dots (follow-ups), bouncing balls (define/summarize/translate), radial
    pulse (dashboard) — all in the green palette with cubic-bezier easing.

## Known gaps

- Scanned/image-based PDFs (no embedded text layer) still don't get per-page OCR — only direct
  image uploads do. Rasterizing PDF pages through the same OCR path is future work.
- No real database — `backend/data/db.json` is a flat file. Fine for a demo, not for concurrent
  production traffic; the `repositories/store.js` interface is deliberately thin so swapping in a
  real DB later shouldn't require touching the routes.
- No authentication — guest sessions only (the `x-study-session` header), matching the PRD's stated
  "not yet required."

## Design Philosophy

The UI follows three principles for student-focused learning:

1. **Color psychology** — Green promotes calmness, growth, and sustained focus; reduces eye strain
   during long study sessions.
2. **Visual hierarchy** — Primary actions read more prominently than secondary ones, reducing
   cognitive load and decision fatigue.
3. **Subtle depth** — Gradients and soft shadows add interest without competing for attention,
   keeping a clean, distraction-free reading environment.

All interactive elements give consistent green-themed feedback on hover/selection. The design
avoids harsh color changes or high-contrast elements that could break concentration.
