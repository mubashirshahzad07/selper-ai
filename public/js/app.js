// public/js/app.js
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const state = {
  documentId: null,
  filename: null,
  isPdf: false,
  extractedText: "",
  pendingSelection: null, // { type: 'word'|'passage', text, context, rect }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------- guest session
// Every request carries x-study-session so the backend can scope documents,
// doubts, quizzes, and attempts to this browser only. The server issues one
// on the first request; we cache it in localStorage for return visits.
const SESSION_KEY = "studyHelperSessionId";

function getStoredSessionId() {
  return localStorage.getItem(SESSION_KEY);
}
function storeSessionId(id) {
  if (id) localStorage.setItem(SESSION_KEY, id);
}

/** api() wrapper: attaches the session header and captures any new session id. */
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const existing = getStoredSessionId();
  if (existing) headers.set("x-study-session", existing);

  const res = await fetch(url, { ...options, headers });
  const issued = res.headers.get("x-study-session");
  if (issued) storeSessionId(issued);
  return res;
}

// ---------------------------------------------------------------- upload
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) handleUpload(file);
});
fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleUpload(file);
});

async function handleUpload(file) {
  setStatus(`Uploading ${file.name}…`);
  const form = new FormData();
  form.append("file", file);

  const res = await api("/api/documents", { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setStatus(`Upload failed: ${err.error || res.statusText}`);
    return;
  }
  const doc = await res.json();
  state.documentId = doc.id;
  state.filename = doc.filename;
  state.isPdf = doc.isPdf;

  $("#uploadStage").classList.add("hidden");
  $("#readerStage").classList.remove("hidden");
  $("#docTitle").textContent = doc.filename;
  setStatus(`${doc.filename} · original layout`);

  if (doc.isPdf) {
    await renderPdf(doc.url);
    const full = await api(`/api/documents/${doc.id}`).then((r) => r.json());
    state.extractedText = full.extractedText || "";
    $("#textView").textContent = state.extractedText || "(No extractable text found in this PDF.)";
  } else {
    $("#pdfPages").innerHTML = `<img src="${doc.url}" style="max-width:100%;border-radius:8px;box-shadow:0 4px 24px -8px rgba(0,0,0,.15)" />`;

    // Images go through OCR (Gemini vision) server-side — pull the transcribed
    // text the same way PDFs do, so key terms/quiz/define all work on photos
    // of notes, whiteboards, textbook pages, etc., not just clean PDFs.
    const full = await api(`/api/documents/${doc.id}`).then((r) => r.json());
    state.extractedText = full.extractedText || "";
    $("#textView").textContent = state.extractedText || "(No text could be extracted from this image.)";

    if (doc.ocrApplied && state.extractedText) {
      setStatus(`${doc.filename} · text extracted from image`);
    } else if (doc.ocrError) {
      setStatus(`${doc.filename} · text extraction failed: ${doc.ocrError}`);
    } else {
      setStatus(`${doc.filename} · original layout`);
    }
  }
}

function setStatus(text) {
  $("#statusLine").textContent = text;
}

// ---------------------------------------------------------------- PDF rendering with word-level text layer
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.15;

let pdfDoc = null;
let baseScale = 1; // scale that fits the current container width at zoom 1.0
state.zoom = 1;

async function renderPdf(url) {
  const pagesEl = $("#pdfPages");
  pagesEl.innerHTML = "";
  pdfDoc = await pdfjsLib.getDocument(url).promise;

  // Fit the first page's natural width to the available reading column instead
  // of using a fixed scale — a wide slide-deck PDF was rendering enormous.
  const firstPage = await pdfDoc.getPage(1);
  const naturalWidth = firstPage.getViewport({ scale: 1 }).width;
  const available = $("#pdfScroll").clientWidth - 56; // minus scroll padding
  baseScale = Math.min(Math.max(available / naturalWidth, 0.4), 1.6);

  await renderAllPages();
}

async function renderAllPages() {
  const pagesEl = $("#pdfPages");
  pagesEl.innerHTML = "";
  const effectiveScale = baseScale * state.zoom;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: effectiveScale });

    const wrap = document.createElement("div");
    wrap.className = "pdf-page-wrap";
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    wrap.appendChild(canvas);

    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-layer";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    wrap.appendChild(textLayer);

    pagesEl.appendChild(wrap);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const textContent = await page.getTextContent();
    buildWordLayer(textLayer, textContent, viewport);
  }
}

function setZoom(next) {
  state.zoom = Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX);
  $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
  closeAssistCard();
  if (pdfDoc) renderAllPages();
}

$("#zoomIn")?.addEventListener("click", () => setZoom(state.zoom + ZOOM_STEP));
$("#zoomOut")?.addEventListener("click", () => setZoom(state.zoom - ZOOM_STEP));
$("#zoomReset")?.addEventListener("click", () => setZoom(1));

// Build one absolutely-positioned span PER WORD, so right-click always
// targets a single word (PRD 5.2 / "Low interaction cost").
function buildWordLayer(layerEl, textContent, viewport) {
  for (const item of textContent.items) {
    const str = item.str;
    if (!str || !str.trim()) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const x0 = tx[4];
    const y0 = tx[5] - fontHeight;
    const totalWidth = item.width * viewport.scale;

    // Split into words, distributing width proportionally by character count
    // (a reasonable approximation without per-glyph metrics).
    const words = str.split(/(\s+)/).filter((w) => w.length > 0);
    let cursor = 0;
    const totalChars = str.length || 1;

    for (const word of words) {
      const wStart = cursor / totalChars;
      const wWidth = (word.length / totalChars) * totalWidth;
      cursor += word.length;

      if (!word.trim()) continue; // skip whitespace runs

      const span = document.createElement("span");
      span.textContent = word;
      span.style.left = `${x0 + wStart * totalWidth}px`;
      span.style.top = `${y0}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.width = `${wWidth}px`;
      span.dataset.word = word.replace(/[^\w'-]/g, "");

      span.addEventListener("contextmenu", (e) => onWordContextMenu(e, span, textContent));
      layerEl.appendChild(span);
    }
  }
}

function surroundingContextFor(word, layerEl) {
  // Grab nearby word spans' text as a crude context window.
  const spans = Array.from(layerEl.parentElement.querySelectorAll(".pdf-text-layer span"));
  return spans.map((s) => s.textContent).join(" ").slice(0, 3000);
}

function onWordContextMenu(e, span, textContent) {
  e.preventDefault();

  const word = span.dataset.word;
  if (!word) return;

  paintHighlight(span);

  const context = surroundingContextFor(word, span.parentElement);

  // Store the live span, not a one-time rect — Range/Element.getBoundingClientRect()
  // stays accurate as the page scrolls, letting the popup track the word.
  state.pendingSelection = { type: "word", text: word, context, anchorEl: span };
  openContextMenu(e.clientX, e.clientY, { showSummarize: false });
}

/** Draws the rounded-corner highlight and remembers it so it can be cleared later. */
function paintHighlight(span) {
  clearHighlights();
  const rect = document.createElement("div");
  rect.className = "word-highlight-rect";
  const wrap = span.closest(".pdf-page-wrap");
  const spanRect = span.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  rect.style.left = `${spanRect.left - wrapRect.left - 3}px`;
  rect.style.top = `${spanRect.top - wrapRect.top - 2}px`;
  rect.style.width = `${spanRect.width + 6}px`;
  rect.style.height = `${spanRect.height + 4}px`;
  wrap.appendChild(rect);
}

function clearHighlights() {
  $$(".word-highlight-rect").forEach((el) => el.remove());
}

// Text-mode selection (study text tab) — supports word or passage selection.
$("#textView").addEventListener("contextmenu", (e) => {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim();
  if (!selectedText) return;
  e.preventDefault();

  const isSingleWord = !/\s/.test(selectedText);
  const full = state.extractedText;
  const idx = full.indexOf(selectedText);
  const context = idx >= 0 ? full.slice(Math.max(0, idx - 800), idx + selectedText.length + 800) : full.slice(0, 2000);
  // Range objects (unlike a snapshot rect) keep returning a live, scroll-accurate
  // bounding box for as long as the underlying text nodes stay in the DOM —
  // cloning it means we don't depend on the browser Selection staying intact.
  const anchorEl = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

  state.pendingSelection = {
    type: isSingleWord ? "word" : "passage",
    text: selectedText,
    context,
    anchorEl,
  };
  openContextMenu(e.clientX, e.clientY, { showSummarize: !isSingleWord });
});

// ---------------------------------------------------------------- context menu
const contextMenu = $("#contextMenu");

function openContextMenu(x, y, { showSummarize }) {
  $("#ctxSummarize").style.display = showSummarize ? "block" : "none";
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
  contextMenu.classList.remove("hidden");
}
function closeContextMenu() {
  contextMenu.classList.add("hidden");
}
document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) closeContextMenu();
  const clickedInsideAssistCard = assistCard.contains(e.target);
  const clickedContextMenuItem = contextMenu.contains(e.target);
  const assistCardOpen = !assistCard.classList.contains("hidden");
  if (assistCardOpen && !clickedInsideAssistCard && !clickedContextMenuItem) {
    closeAssistCard();
  }
});

contextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !state.pendingSelection) return;
  closeContextMenu();

  if (action === "define") runDefine();
  if (action === "summarize") runSummarize();
  if (action === "translate") runTranslate();
  if (action === "doubt") openDoubtModal();
});

// ---------------------------------------------------------------- assist card
const assistCard = $("#assistCard");
const assistBody = $("#assistBody");

$("#assistClose").addEventListener("click", closeAssistCard);

function closeAssistCard() {
  assistCard.classList.add("hidden");
  clearHighlights();
}

const TOPBAR_HEIGHT = 60;

/** Anchors the card next to the highlighted word/passage rather than the raw click point. */
function positionAssistCard() {
  // anchorEl is either a live DOM element (word span) or a cloned Range — both
  // expose getBoundingClientRect() and stay accurate as the page scrolls.
  const anchorEl = state.pendingSelection?.anchorEl;
  const anchorRect = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
  const w = 380;
  let left, top;

  if (anchorRect && anchorRect.width > 0) {
    left = anchorRect.left;
    top = anchorRect.bottom + 10;
    // Flip above the word if there isn't room below.
    if (top + 220 > window.innerHeight) top = anchorRect.top - 230;
  } else {
    // Anchor scrolled out of view (or no anchor at all) — park it, don't vanish.
    left = window.innerWidth / 2 - w / 2;
    top = window.innerHeight / 2 - 150;
  }

  left = Math.min(Math.max(16, left), window.innerWidth - w - 16);
  // Never render under/over the fixed topbar — clamp below it. Combined with
  // a lower z-index than .topbar in CSS, the card stays visually beneath the
  // header instead of floating on top of it near the top of the page.
  top = Math.min(Math.max(TOPBAR_HEIGHT + 16, top), window.innerHeight - 16);
  assistCard.style.left = `${left}px`;
  assistCard.style.top = `${top}px`;
}

// Keep the card glued to its word/passage while the reader pane scrolls or
// the window resizes, instead of freezing at its original screen position.
function trackAnchorOnScroll() {
  if (!assistCard.classList.contains("hidden")) positionAssistCard();
}
$("#pdfScroll").addEventListener("scroll", trackAnchorOnScroll, { passive: true });
window.addEventListener("scroll", trackAnchorOnScroll, { passive: true });
window.addEventListener("resize", trackAnchorOnScroll);

async function runDefine() {
  const { text, context } = state.pendingSelection;
  positionAssistCard();
  assistBody.innerHTML = `<div class="assist-loading"><span class="spinner"></span> Resolving “${escapeHtml(text)}” from context…</div>`;
  assistCard.classList.remove("hidden");

  try {
    const res = await api("/api/assist/define", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: text, context }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    const defBlock = data.definition
      ? `<p>${escapeHtml(data.definition.extract)}</p>
         <a class="assist-ref" href="${data.definition.url}" target="_blank" rel="noopener">Open Wikipedia reference →</a>`
      : `<p>${escapeHtml(data.resolvedSense || "No matching reference article was found.")}</p>`;

    assistBody.innerHTML = `
      <div class="assist-label">Definition</div>
      <h4>${escapeHtml(data.definition?.title || text)}</h4>
      ${defBlock}
    `;
  } catch (err) {
    assistBody.innerHTML = errorBlock(err);
  }
}

async function runSummarize() {
  const { text, context } = state.pendingSelection;
  positionAssistCard();
  assistBody.innerHTML = `<div class="assist-loading"><span class="spinner"></span> Summarizing from source context…</div>`;
  assistCard.classList.remove("hidden");

  try {
    const res = await api("/api/assist/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passage: text, context }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    assistBody.innerHTML = `
      <div class="assist-label">Summary</div>
      <p>${escapeHtml(data.summary)}</p>
    `;
  } catch (err) {
    assistBody.innerHTML = errorBlock(err);
  }
}

async function runTranslate() {
  const { text } = state.pendingSelection;
  positionAssistCard();
  assistBody.innerHTML = `<div class="assist-loading"><span class="spinner"></span> Translating to Urdu…</div>`;
  assistCard.classList.remove("hidden");

  try {
    const res = await api("/api/assist/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    assistBody.innerHTML = `
      <div class="assist-label">Urdu translation</div>
      <div class="assist-urdu">${escapeHtml(data.urdu || "—")}</div>
    `;
  } catch (err) {
    assistBody.innerHTML = errorBlock(err);
  }
}

function errorBlock(err) {
  const needsKey = /GEMINI_API_KEY/i.test(err.message);
  return `
    <div class="assist-label" style="color:var(--wrong)">Couldn't complete this</div>
    <p>${escapeHtml(err.message)}</p>
    ${needsKey ? `<p style="color:var(--ink-soft)">Add your key to <code>.env</code> and restart the server.</p>` : ""}
  `;
}

function escapeHtml(str = "") {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------- doubt notebook
const doubtModal = $("#doubtModal");

function openDoubtModal() {
  $("#doubtModalPassage").textContent = state.pendingSelection.text;
  $("#doubtNote").value = "";
  doubtModal.classList.remove("hidden");
}
$("#doubtCancel").addEventListener("click", () => { doubtModal.classList.add("hidden"); clearHighlights(); });
$("#doubtSave").addEventListener("click", async () => {
  const note = $("#doubtNote").value.trim();
  const { text } = state.pendingSelection;
  await api("/api/doubts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: state.documentId, passage: text, note }),
  });
  doubtModal.classList.add("hidden");
  clearHighlights();
  setStatus("Doubt saved to notebook.");
});

// ---------------------------------------------------------------- drawers
function openDrawer(el) {
  $("#scrim").classList.remove("hidden");
  el.classList.remove("hidden");
}
function closeDrawers() {
  $("#scrim").classList.add("hidden");
  $$(".drawer").forEach((d) => d.classList.add("hidden"));
}
$("#scrim").addEventListener("click", closeDrawers);
$$("[data-close-drawer]").forEach((btn) => btn.addEventListener("click", closeDrawers));

$("#btnDoubts").addEventListener("click", async () => {
  const list = state.documentId
    ? await api(`/api/doubts?documentId=${state.documentId}`).then((r) => r.json())
    : [];
  const container = $("#doubtList");
  container.innerHTML = list.length
    ? list.map((d) => `
        <div class="doubt-item">
          <div class="doubt-passage">"${escapeHtml(d.passage)}"</div>
          ${d.note ? `<div class="doubt-note">${escapeHtml(d.note)}</div>` : ""}
        </div>`).join("")
    : `<div class="empty-note">No doubts saved yet. Right-click a passage and choose “Save as doubt.”</div>`;
  openDrawer($("#doubtDrawer"));
});

$("#btnReview").addEventListener("click", async () => {
  await loadAndRenderReviewQueue();
  openDrawer($("#reviewDrawer"));
});

async function loadAndRenderReviewQueue() {
  const qs = state.documentId ? `?documentId=${state.documentId}` : "";
  const queue = await api(`/api/review-queue${qs}`).then((r) => r.json());
  const container = $("#reviewList");

  if (!queue.length) {
    container.innerHTML = `<div class="empty-note">Nothing to review yet. Take a quiz or save a doubt.</div>`;
    return;
  }

  const dueItems = queue.filter((i) => i.due);
  const upcomingItems = queue.filter((i) => !i.due);

  const renderItem = (item, { showActions }) => {
    const groupClass = `g${item.priorityGroup}`;
    const text = item.type === "doubt"
      ? `"${escapeHtml(item.data.passage)}"${item.data.note ? ` — ${escapeHtml(item.data.note)}` : ""}`
      : `${escapeHtml(item.data.question)} — you answered "${escapeHtml(item.data.selectedOption || "")}" (correct: "${escapeHtml(item.data.correctOption || "")}")`;

    const actions = showActions
      ? `
        <div class="review-actions">
          <button class="btn btn-ghost review-mark" data-key="${escapeHtml(item.key)}" data-remembered="true">Got it</button>
          <button class="btn btn-ghost review-mark" data-key="${escapeHtml(item.key)}" data-remembered="false">Missed it</button>
        </div>`
      : `<div class="review-upcoming-badge">Due in ${item.dueInDays} day${item.dueInDays === 1 ? "" : "s"}</div>`;

    return `
      <div class="review-item">
        <span class="review-badge ${groupClass}">${escapeHtml(item.groupLabel)}</span>
        <div class="review-text">${text}</div>
        <div class="review-meta">${new Date(item.createdAt).toLocaleString()}</div>
        ${actions}
      </div>`;
  };

  let html = "";
  if (dueItems.length) {
    html += `<div class="review-section-label">Due now</div>`;
    html += dueItems.map((i) => renderItem(i, { showActions: true })).join("");
  }
  if (upcomingItems.length) {
    html += `<div class="review-section-label">Upcoming</div>`;
    html += upcomingItems.map((i) => renderItem(i, { showActions: false })).join("");
  }
  container.innerHTML = html;

  container.querySelectorAll(".review-mark").forEach((btn) => {
    btn.addEventListener("click", async () => {
      container.querySelectorAll(".review-mark").forEach((b) => (b.disabled = true));
      await api("/api/review-queue/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: btn.dataset.key, remembered: btn.dataset.remembered === "true" }),
      });
      // Re-fetch so the item moves from "Due now" to "Upcoming" (or resets to
      // day 1 if forgotten) — simplest way to stay in sync with the schedule.
      loadAndRenderReviewQueue();
    });
  });
}

// ---------------------------------------------------------------- confidence calibration
// Not another score — whether "I know this" actually tracks being right.
$("#btnCalibration").addEventListener("click", async () => {
  const qs = state.documentId ? `?documentId=${state.documentId}` : "";
  const data = await api(`/api/calibration${qs}`).then((r) => r.json());
  $("#calibrationBody").innerHTML = renderCalibration(data);
  openDrawer($("#calibrationDrawer"));
});

function renderCalibration(data) {
  if (data.totalAnswered === 0) {
    return `<div class="empty-note">Take a quiz first — this fills in once you've answered some questions.</div>`;
  }

  const pct = (n) => (n === null ? "—" : `${Math.round(n * 100)}%`);

  const headline = data.confidentWrongRate === null
    ? ""
    : `
      <div class="calibration-headline">
        <div class="calibration-headline-number">${pct(data.confidentWrongRate)}</div>
        <div class="calibration-headline-label">
          of the time you were <strong>confident</strong>, you were actually wrong
        </div>
      </div>`;

  const levels = ["confident", "unsure", "guessing"];
  const bars = levels.map((level) => {
    const b = data.byConfidence[level];
    const widthPct = b.accuracy === null ? 0 : Math.round(b.accuracy * 100);
    return `
      <div class="calibration-row">
        <div class="calibration-row-label">
          <span class="calibration-level">${level}</span>
          <span class="calibration-count">${b.total} answered</span>
        </div>
        <div class="calibration-bar-track">
          <div class="calibration-bar-fill level-${level}" style="width:${widthPct}%"></div>
        </div>
        <div class="calibration-bar-pct">${pct(b.accuracy)} correct</div>
      </div>`;
  }).join("");

  const misses = data.confidentMisses.length
    ? `
      <div class="calibration-misses-title">Recent confident misses</div>
      <div class="calibration-misses-list">
        ${data.confidentMisses.map((m) => `
          <div class="review-item">
            <div class="review-text">
              ${escapeHtml(m.question)}<br>
              <span style="color:var(--ink-soft)">You answered "${escapeHtml(m.selectedOption || "")}" — correct: "${escapeHtml(m.correctOption || "")}"</span>
            </div>
            <div class="review-meta">${new Date(m.createdAt).toLocaleString()}</div>
          </div>
        `).join("")}
      </div>`
    : "";

  return `
    ${headline}
    <div class="calibration-bars">${bars}</div>
    ${misses}
  `;
}

// ---------------------------------------------------------------- reader tabs
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.mode;
    $("#pdfPages").classList.toggle("hidden", mode !== "original");
    $("#textView").classList.toggle("hidden", mode !== "text");
  });
});

$$(".tools-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tools-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $("#panelTerms").classList.toggle("hidden", tab.dataset.panel !== "terms");
    $("#panelQuiz").classList.toggle("hidden", tab.dataset.panel !== "quiz");
  });
});

// ---------------------------------------------------------------- key terms
$("#btnKeyTerms").addEventListener("click", async () => {
  if (!state.documentId) return;
  const list = $("#termList");
  list.innerHTML = `<div class="empty-note">Extracting key terms…</div>`;
  try {
    const res = await api(`/api/documents/${state.documentId}/key-terms`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    list.innerHTML = data.terms.map((t, i) => `
      <li style="animation-delay:${i * 40}ms">
        <div class="term-word">${escapeHtml(t.term)}</div>
        <div class="term-why">${escapeHtml(t.why)}</div>
      </li>`).join("") || `<div class="empty-note">No key terms returned.</div>`;
  } catch (err) {
    list.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
  }
});

// ---------------------------------------------------------------- quiz
// Distraction-free, full-screen, one-question-at-a-time — the source PDF is
// never visible during the quiz, so answering it isn't just "read the slide."
let currentQuiz = null; // { id, questions: [{question, options}] }
let currentQuestionIndex = 0;
let currentAttempt = null; // set once results come back
const quizAnswers = new Map(); // questionIndex -> { selectedIndex, confidence }

const quizOverlay = $("#quizOverlay");
const quizOverlayBody = $("#quizOverlayBody");

$("#btnGenQuiz").addEventListener("click", async () => {
  if (!state.documentId) return;
  $("#quizSummaryArea").innerHTML = `<div class="empty-note">Generating a 5-question quiz from this document…</div>`;
  quizAnswers.clear();
  currentQuestionIndex = 0;
  currentAttempt = null;

  try {
    const res = await api(`/api/documents/${state.documentId}/quiz`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    currentQuiz = data;
    $("#quizSummaryArea").innerHTML = "";
    openQuizOverlay();
    renderQuizQuestion();
  } catch (err) {
    $("#quizSummaryArea").innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
  }
});

function openQuizOverlay() {
  quizOverlay.classList.remove("hidden");
}
function closeQuizOverlay() {
  quizOverlay.classList.add("hidden");
}
$("#quizOverlayClose").addEventListener("click", closeQuizOverlay);

function updateProgress() {
  const total = currentQuiz.questions.length;
  const pct = ((currentQuestionIndex) / total) * 100;
  $("#quizProgressFill").style.width = `${pct}%`;
  $("#quizProgressLabel").textContent = `${Math.min(currentQuestionIndex + 1, total)} / ${total}`;
}

function renderQuizQuestion() {
  const q = currentQuiz.questions[currentQuestionIndex];
  const saved = quizAnswers.get(currentQuestionIndex) || {};
  updateProgress();

  const isLast = currentQuestionIndex === currentQuiz.questions.length - 1;

  quizOverlayBody.innerHTML = `
    <div class="quiz-overlay-inner">
      <div class="quiz-overlay-question">${escapeHtml(q.question)}</div>
      <div class="quiz-overlay-options">
        ${q.options.map((opt, oi) => `
          <button class="quiz-overlay-option${saved.selectedIndex === oi ? " selected" : ""}" data-oi="${oi}">
            ${escapeHtml(opt)}
          </button>
        `).join("")}
      </div>
      <div class="quiz-overlay-confidence">
        <div class="quiz-overlay-confidence-label">How confident are you?</div>
        <div class="quiz-overlay-confidence-row">
          ${["confident", "unsure", "guessing"].map((c) => `
            <button data-conf="${c}" class="${saved.confidence === c ? "selected" : ""}">${c}</button>
          `).join("")}
        </div>
      </div>
      <div class="quiz-overlay-nav">
        <button class="btn btn-ghost" id="quizPrevBtn" ${currentQuestionIndex === 0 ? "disabled" : ""}>Back</button>
        <button class="btn btn-primary" id="quizNextBtn">${isLast ? "Submit quiz" : "Next"}</button>
      </div>
    </div>
  `;

  quizOverlayBody.querySelectorAll(".quiz-overlay-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      quizOverlayBody.querySelectorAll(".quiz-overlay-option").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      const prev = quizAnswers.get(currentQuestionIndex) || {};
      quizAnswers.set(currentQuestionIndex, { ...prev, selectedIndex: Number(btn.dataset.oi) });
    });
  });

  quizOverlayBody.querySelectorAll(".quiz-overlay-confidence-row button").forEach((btn) => {
    btn.addEventListener("click", () => {
      quizOverlayBody.querySelectorAll(".quiz-overlay-confidence-row button").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      const prev = quizAnswers.get(currentQuestionIndex) || {};
      quizAnswers.set(currentQuestionIndex, { ...prev, confidence: btn.dataset.conf });
    });
  });

  $("#quizPrevBtn").addEventListener("click", () => {
    currentQuestionIndex = Math.max(0, currentQuestionIndex - 1);
    renderQuizQuestion();
  });
  $("#quizNextBtn").addEventListener("click", () => {
    if (isLast) { submitQuiz(); return; }
    currentQuestionIndex++;
    renderQuizQuestion();
  });
}

async function submitQuiz() {
  const responses = currentQuiz.questions.map((_, qi) => {
    const a = quizAnswers.get(qi) || {};
    return { questionIndex: qi, selectedIndex: a.selectedIndex ?? -1, confidence: a.confidence || "unsure" };
  });

  quizOverlayBody.innerHTML = `<div class="empty-note">Grading…</div>`;
  updateProgressComplete();

  const res = await api(`/api/quizzes/${currentQuiz.id}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ responses }),
  });
  const attempt = await res.json();
  if (!res.ok) {
    quizOverlayBody.innerHTML = `<div class="empty-note">${escapeHtml(attempt.error)}</div>`;
    return;
  }
  currentAttempt = attempt;
  renderQuizResults();
}

function updateProgressComplete() {
  $("#quizProgressFill").style.width = "100%";
  $("#quizProgressLabel").textContent = `${currentQuiz.questions.length} / ${currentQuiz.questions.length}`;
}

function renderQuizResults() {
  const attempt = currentAttempt;
  quizOverlayBody.innerHTML = `
    <div class="quiz-overlay-inner quiz-results">
      <div class="quiz-results-score">${attempt.score} / ${attempt.total}</div>
      <div class="quiz-results-sub">Weak items were added to your review queue.</div>
      <div class="quiz-results-list">
        ${attempt.answers.map((ans, qi) => `
          <div class="quiz-results-item ${ans.isCorrect ? "right" : "wrong"}" data-qi="${qi}">
            <div class="qr-q">${qi + 1}. ${escapeHtml(ans.question)}</div>
            <div class="qr-answer">
              Your answer: ${escapeHtml(ans.selectedOption || "(skipped)")}
              ${ans.isCorrect ? "" : ` — correct: ${escapeHtml(ans.correctOption || "")}`}
            </div>
            ${!ans.isCorrect ? `
              <button class="btn btn-ghost follow-up-trigger" data-qi="${qi}" style="margin-top:10px;font-size:12.5px">
                Try a similar question
              </button>
              <div class="follow-up-area" data-qi="${qi}"></div>
            ` : ""}
          </div>
        `).join("")}
      </div>
      <div class="quiz-overlay-nav" style="justify-content:center">
        <button class="btn btn-primary" id="quizDoneBtn">Done</button>
      </div>
    </div>
  `;

  quizOverlayBody.querySelectorAll(".follow-up-trigger").forEach((btn) => {
    btn.addEventListener("click", () => loadFollowUp(attempt.id, Number(btn.dataset.qi), btn));
  });

  $("#quizDoneBtn").addEventListener("click", () => {
    closeQuizOverlay();
    $("#quizSummaryArea").innerHTML = `
      <div class="quiz-summary-card">
        Last attempt: ${attempt.score} / ${attempt.total}. Generate a new quiz to try again.
      </div>
    `;
  });
}

async function loadFollowUp(attemptId, questionIndex, triggerBtn) {
  const area = quizOverlayBody.querySelector(`.follow-up-area[data-qi="${questionIndex}"]`);
  triggerBtn.disabled = true;
  area.innerHTML = `<div class="empty-note">Generating a similar question…</div>`;

  try {
    const res = await api(`/api/attempts/${attemptId}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionIndex }),
    });
    const followUp = await res.json();
    if (!res.ok) throw new Error(followUp.error);

    area.innerHTML = `
      <div class="qr-q" style="margin-top:10px">${escapeHtml(followUp.question)}</div>
      <div class="quiz-overlay-options" style="margin-top:8px">
        ${followUp.options.map((opt, oi) => `
          <button class="quiz-overlay-option follow-up-option" data-oi="${oi}" style="font-size:13px;padding:10px 14px">
            ${escapeHtml(opt)}
          </button>
        `).join("")}
      </div>
    `;

    area.querySelectorAll(".follow-up-option").forEach((optBtn) => {
      optBtn.addEventListener("click", async () => {
        area.querySelectorAll(".follow-up-option").forEach((b) => b.disabled = true);
        const oi = Number(optBtn.dataset.oi);
        const gradeRes = await api(`/api/follow-ups/${followUp.id}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectedIndex: oi }),
        });
        const grade = await gradeRes.json();
        optBtn.classList.add(grade.isCorrect ? "correct" : "incorrect");
        area.insertAdjacentHTML("beforeend", `
          <div class="quiz-overlay-explanation ${grade.isCorrect ? "correct-note" : "incorrect-note"}">
            ${grade.isCorrect ? "Correct — nice, that concept's solid now." : `Not quite. Correct answer: ${escapeHtml(grade.correctOption)}`}
          </div>
        `);
      });
    });
  } catch (err) {
    area.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    triggerBtn.disabled = false;
  }
}
