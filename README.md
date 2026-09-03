# Study Helper

Source-preserving AI study workspace — hosted-first (Alibaba AI Hackathon, Education track).
Uses two AI providers: Gemini for OCR and Definitions (word lookup, translate, summarize, key
terms, free-text grading), Manus for Quiz Generation. See the top of `backend/src/services/ai.js`
for the full provider-split rationale.

## Layout (backend/frontend split)

This was restructured from a single Express app (serving both the API and the static frontend)
into two independently deployable pieces, for scalability:

```
study-helper/
├── backend/                 API only — no frontend files in here
│   ├── src/
│   │   ├── index.js         entry point: mounts routers, CORS, session middleware
│   │   ├── routes/          one file per resource — documents, assist, doubts, quizzes, review, calibration
│   │   ├── services/        ai.js (Gemini + Manus routing), providers/gemini.js, providers/manus.js, wikipedia.js, extraction.js, reviewQueue.js, spacedRepetition.js, calibration.js
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
# edit .env — paste your Gemini key AND your Manus key, and (optionally) restrict FRONTEND_ORIGIN
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
Same caveat as before the restructuring: this sandbox can't reach Google's, Manus's, or
Wikipedia's APIs, so the actual provider-backed calls — Gemini (definitions, summaries,
translation, key terms, OCR, free-text grading) and Manus (quiz generation, follow-up questions) —
are correct against their documented shapes but not live-tested here. Everything AI-independent —
uploads, extraction pipeline wiring, sessions, doubts, review-queue math, spaced repetition,
calibration, and now the full cross-origin plumbing — has been.

## Known gaps

- Scanned/image-based PDFs (no embedded text layer) still don't get OCR — only direct image
  uploads do. Rasterizing PDF pages to run through the same OCR path is future work.
- No real database — `backend/data/db.json` is a flat file. Fine for a demo, not for concurrent
  production traffic; the `repositories/store.js` interface is deliberately thin so swapping in a
  real DB later shouldn't require touching the routes.
- No authentication — guest sessions only, matching the PRD's stated "not yet required."

## Recent UI fixes

1. **Logo → home** — Clicking the Study Helper logo (brand mark + name) in the top bar now
   returns the user to the home/upload page, clearing the current document, zoom, and any open
   overlays/drawers/modals.
2. **Instant flicker-free zoom** — Zooming executes immediately in place with zero flicker or blanking. Pages scale instantly via hardware-accelerated transforms and dimensions (0ms response), while high-DPI sharp canvases render in the background using non-destructive off-screen canvas swaps and cached text extraction. The viewport center anchor is seamlessly maintained.
3. **Dynamic zoom limits** — Replaced the static 200% zoom cap with dynamic ceiling calculation based on the visible reading viewport width and actual text/word boundary bounds across pages. Zooming in allows maximum readable expansion up to the exact point where words would otherwise clip or slip under adjacent window panes.
4. **Uniform page sizing across study material** — Page widths remain strictly uniform across all pages of the study material during both zoom in and zoom out operations, eliminating variable or mismatched page widths across the document.
5. **Dark / light mode** — Theme toggle (☾ / ☀) in the top bar. Preference is saved in
   `localStorage` and falls back to the OS `prefers-color-scheme` on first visit. All CSS
   tokens are theme-aware via `html[data-theme="dark"]`.
6. **AI reliability** — Interactive Gemini calls (define / summarize / translate / key terms)
   now use a single fast retry with short backoff; clearer error messages when the API key is
   missing, the model blocks content, or the backend is unreachable; markdown-fenced JSON
   responses are unwrapped automatically.
7. **Lower latency** — Tighter prompt context windows, lower timeouts for interactive actions,
   in-memory definition cache (re-looking up the same word is instant), faster Manus task
   polling (1.5s interval), and clearer network-error messages pointing at the backend URL.
8. **UI polish** — Theme toggle control, smoother color transitions, theme-aware surfaces.
9. **Dark-mode quiz contrast** — Quiz questions, options, explanations, and results use
   theme-aware text/background tokens so content stays readable in dark mode (no more
   light-green/red washes that hide text).
10. **Vibrant green color palette & student-focused UI redesign** — Complete visual overhaul with
    a calming green/mint color scheme optimized for study focus:
    - New CSS variables: `--mint`, `--success`, `--mint-soft`, `--success-soft` alongside existing colors
    - Light mode uses forest green (`#2E7D5C`) as primary accent; dark mode uses bright mint (`#4CAF7D`)
    - Subtle gradients on backgrounds (toolbars, drawers, modals) for depth without distraction
    - Topbar navigation reorganized: primary actions (Dashboard, Review) highlighted with mint borders;
      secondary actions (Quiz, Doubts, History) smaller and less prominent; Settings restored as text button
    - Upload stage enhanced with gradient headline text, green hover effects, centered subtitle
    - Reader toolbar shows mint gradient background with green active tabs
    - Tools pane redesigned with mint-tinted backgrounds and hover glow effects on term cards
    - Quiz overlay uses calming mint gradients with thicker progress bar and green-correct feedback
    - All drawers/modals updated with consistent green theming and hover states
    - Context menu and assist card use green accents for better discoverability
11. **Page progress indicator** — Real-time reading progress displayed in reader toolbar:
    - Shows current page number / total pages + percentage complete (e.g., "12 / 45 • 27%")
    - Pill-shaped badge with gradient background positioned in center of toolbar
    - Automatically updates on scroll, zoom changes, and mode switches
    - Calculates visible page based on viewport midpoint for accurate tracking
    - For images: displays "1 / 1 • 100%" consistently
    - Resets to "0 / 0 • 0%" when clearing documents
    - Increased spacing between page numbers and percentage for better readability
    - Helps students monitor their reading progress at a glance

## Design Philosophy

The recent UI changes follow three core principles for student-focused learning:

1. **Color psychology** — Green promotes calmness, growth, and sustained focus; reduces eye strain during long study sessions
2. **Visual hierarchy** — Primary actions are more prominent than secondary ones; reduces cognitive load and decision fatigue
3. **Subtle depth** — Gradients and soft shadows add visual interest without competing for attention; maintains clean, distraction-free reading environment

All interactive elements provide consistent green-themed feedback on hover/selection. The design intentionally avoids harsh color changes or high-contrast elements that could break concentration during focused study work.
