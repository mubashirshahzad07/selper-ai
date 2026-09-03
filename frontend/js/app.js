// frontend/js/app.js
pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const state = {
    documentId: null,
    filename: null,
    isPdf: false,
    extractedText: "",
    pendingSelection: null, // { type: 'word'|'passage', text, context, rect }
};

// ---------------------------------------------------------------- debug log
// In-memory ring buffer of API calls for the Debug drawer. Keeps last 200 entries.
const DEBUG_LOG = [];
const DEBUG_LOG_MAX = 200;
function pushDebugLog(entry) {
    DEBUG_LOG.push(entry);
    if (DEBUG_LOG.length > DEBUG_LOG_MAX) DEBUG_LOG.shift();
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------- theme (light / dark)
const THEME_KEY = "studyHelperTheme";
function applyTheme(theme) {
    const t = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    const btn = $("#btnThemeToggle");
    if (btn) {
        btn.textContent = t === "dark" ? "☀" : "☾";
        btn.title = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
    try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* ignore */ }
}
function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (_) { /* ignore */ }
    if (stored === "dark" || stored === "light") {
        applyTheme(stored);
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
        applyTheme("dark");
    } else {
        applyTheme("light");
    }
}
initTheme();
document.addEventListener("click", (e) => {
    if (e.target.closest("#btnThemeToggle")) {
        const current = document.documentElement.getAttribute("data-theme") || "light";
        applyTheme(current === "dark" ? "light" : "dark");
    }
});

// ---------------------------------------------------------------- backend origin
// The backend is a separate app/origin now (see frontend/js/config.js). Every
// backend-bound URL — API calls AND asset URLs like uploaded file paths —
// needs this prefix; a bare "/api/..." or "/uploads/..." would otherwise
// resolve against the frontend's own origin instead.
const API_BASE = window.STUDY_HELPER_API_BASE || "";
function backendUrl(path) {
    if (/^https?:\/\//i.test(path)) return path; // already absolute
    return `${API_BASE}${path}`;
}

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

/** api() wrapper: resolves against the backend origin, attaches the session
 *  header, captures any new session id from the response, and logs to debug. */
async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    const existing = getStoredSessionId();
    if (existing) headers.set("x-study-session", existing);

    const fullUrl = backendUrl(url);
    const t0 = Date.now();
    pushDebugLog({ time: new Date().toISOString(), method: options.method || "GET", url: fullUrl, body: options.body ? String(options.body).slice(0, 300) : null });

    try {
        const res = await fetch(fullUrl, { ...options, headers });
        const issued = res.headers.get("x-study-session");
        if (issued) storeSessionId(issued);
        pushDebugLog({ time: new Date().toISOString(), status: res.status, ms: Date.now() - t0, url: fullUrl });
        return res;
    } catch (err) {
        pushDebugLog({ time: new Date().toISOString(), error: err.message, ms: Date.now() - t0, url: fullUrl });
        const msg = /Failed to fetch|NetworkError|Load failed/i.test(err.message)
            ? `Cannot reach the backend at ${API_BASE || "(no API base set)"}. Is it running?`
            : err.message;
        const e = new Error(msg);
        e.cause = err;
        throw e;
    }
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
        await renderPdf(backendUrl(doc.url));
        const full = await api(`/api/documents/${doc.id}`).then((r) => r.json());
        state.extractedText = full.extractedText || "";
        $("#textView").textContent = state.extractedText || "(No extractable text found in this PDF.)";

        // Scanned PDFs carry per-page OCR word boxes (object keyed by page number),
        // unlike images (flat array). Apply them to pages that have no native text.
        state.pdfOcr = full.ocrData && !Array.isArray(full.ocrData) ? full.ocrData : null;
        if (state.pdfOcr) applyPdfOcrLayers();
        maybeLoadScannedOcr(doc.id);
    } else {
        // Images go through OCR (Gemini vision) server-side — pull the transcribed
        // text the same way PDFs do, so key terms/quiz/define all work on photos
        // of notes, whiteboards, textbook pages, etc., not just clean PDFs.
        const full = await api(`/api/documents/${doc.id}`).then((r) => r.json());
        state.extractedText = full.extractedText || "";
        $("#textView").textContent = state.extractedText || "(No text could be extracted from this image.)";

        const imageUrl = backendUrl(doc.url);

        // Show the image immediately (upload stays fast). Server OCR now runs in the
        // background, so ocrData may be empty at first — the word layer is upgraded
        // asynchronously by client-side Tesseract below.
        renderImageWithOcr(imageUrl, full.ocrData);
        setStatus(`${doc.filename} · original layout`);
        
        // Set page progress to 1/1 for images
        setPageProgressForImage();

        // Client-side Tesseract fills the selectable word layer without blocking.
        ocrImageClientSide(imageUrl).then((words) => {
            if (words && words.length > 0) {
                renderImageWithOcr(imageUrl, words);
                setStatus(`${doc.filename} · text extracted from image · right-click any word`);
            } else if (state.extractedText) {
                setStatus(`${doc.filename} · text extracted from image`);
            }
        });
    }
}

function setStatus(text) {
    $("#statusLine").textContent = text;
}

// Clicking the Study Helper logo returns to the home (upload) page.
function goHome() {
    closeAssistCard();
    closeContextMenu();
    closeDrawers();
    closeQuizOverlay();
    const doubtModal = $("#doubtModal");
    if (doubtModal) doubtModal.classList.add("hidden");
    $("#readerStage").classList.add("hidden");
    $("#uploadStage").classList.remove("hidden");
    $("#pdfPages").innerHTML = "";
    $("#pdfPages").classList.remove("hidden");
    $("#textView").textContent = "";
    $("#textView").classList.add("hidden");
    $("#docTitle").textContent = "—";
    $("#zoomLabel").textContent = "100%";
    // Ensure original tab is active when returning
    $$(".reader-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === "original"));
    state.documentId = null;
    state.filename = null;
    state.isPdf = false;
    state.extractedText = "";
    state.pendingSelection = null;
    state.pdfOcr = null;
    state.zoom = 1;
    state.dynamicMaxZoom = 1.6;
    state.documentTextRatio = 0.75;
    pageTextContentCache.clear();
    pageDimensions.clear();

    if (debounceRenderTimer) {
        clearTimeout(debounceRenderTimer);
        debounceRenderTimer = null;
    }

    currentRenderSeq++;
    pdfDoc = null;
    baseScale = 1;
    basePageWidth = 800;
    updateZoomButtons();
    setStatus("Source-preserving study workspace");
    // Reset file input so the same file can be re-uploaded if desired
    const fi = $("#fileInput");
    if (fi) { fi.value = ""; }
}

$(".brand")?.addEventListener("click", goHome);

// ---------------------------------------------------------------- PDF rendering with word-level text layer
// Zoom bounds: lower bound allows seeing overview, upper bound is dynamically
// calculated based on window width and actual text/word boundaries so words are
// never cut off or forced under adjacent window panes (not a static 200%).
const ZOOM_MIN = 0.5;
const ZOOM_STEP = 0.15;

let pdfDoc = null;
let basePageWidth = 800; // Uniform canonical page width at zoom 1.0 across study material
let baseScale = 1;
state.zoom = 1;
state.dynamicMaxZoom = 1.6; // Dynamically computed, never fixed at 200%
state.documentTextRatio = 0.75; // Horizontal fraction of page occupied by words

const pageTextContentCache = new Map();
const pageDimensions = new Map();
let debounceRenderTimer = null;
let currentRenderSeq = 0;

function computeTextRatioFromContent(textContent, viewport) {
    if (!textContent || !textContent.items || textContent.items.length === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const item of textContent.items) {
        if (!item.str || !item.str.trim()) continue;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const x0 = tx[4];
        const itemWidth = (item.width || 0) * (viewport.scale || 1);
        if (x0 < minX) minX = x0;
        if (x0 + itemWidth > maxX) maxX = x0 + itemWidth;
    }
    if (minX < maxX && viewport.width > 0) {
        const ratio = (maxX - minX) / viewport.width;
        if (ratio >= 0.35 && ratio <= 1.0) {
            state.documentTextRatio = Math.max(state.documentTextRatio || 0.75, ratio);
        }
    }
}

function computeDynamicMaxZoom() {
    const scrollEl = $("#pdfScroll");
    const available = Math.max(300, (scrollEl ? scrollEl.clientWidth : window.innerWidth) - 56);

    if (state.pdfOcr) {
        for (const p in state.pdfOcr) {
            const words = state.pdfOcr[p]?.words;
            if (Array.isArray(words) && words.length > 0) {
                let ocrMin = 1, ocrMax = 0;
                for (const w of words) {
                    if (w.bbox) {
                        if (w.bbox.x < ocrMin) ocrMin = w.bbox.x;
                        if (w.bbox.x + w.bbox.w > ocrMax) ocrMax = w.bbox.x + w.bbox.w;
                    }
                }
                if (ocrMin < ocrMax) {
                    const r = ocrMax - ocrMin;
                    if (r >= 0.35 && r <= 1.0) state.documentTextRatio = Math.max(state.documentTextRatio || 0.75, r);
                }
            }
        }
    }

    const textRatio = Math.min(Math.max(state.documentTextRatio || 0.75, 0.45), 0.95);
    // Upper limit ensures words never exceed available window width or go below/under adjacent panes
    const maxLimit = available / (basePageWidth * textRatio);
    state.dynamicMaxZoom = Math.max(1.0, Math.round(maxLimit * 100) / 100);

    if (state.zoom > state.dynamicMaxZoom) {
        setZoom(state.dynamicMaxZoom);
    } else {
        updateZoomButtons();
    }
    return state.dynamicMaxZoom;
}

async function renderPdf(url) {
    const pagesEl = $("#pdfPages");
    pagesEl.innerHTML = "";
    pageTextContentCache.clear();
    pageDimensions.clear();
    if (debounceRenderTimer) {
        clearTimeout(debounceRenderTimer);
        debounceRenderTimer = null; 
    }
    currentRenderSeq++;

    pdfDoc = await pdfjsLib.getDocument(url).promise;

    const scrollEl = $("#pdfScroll");
    const available = Math.max(320, (scrollEl ? scrollEl.clientWidth : window.innerWidth) - 56);

    // Sample page 1 natural width to determine uniform study material page width
    const firstPage = await pdfDoc.getPage(1);
    const firstVp = firstPage.getViewport({ scale: 1 });
    pageDimensions.set(1, { width: firstVp.width, height: firstVp.height });

    const naturalWidth = firstVp.width;
    baseScale = Math.min(Math.max(available / naturalWidth, 0.4), 1.6);
    basePageWidth = Math.round(naturalWidth * baseScale);

    try {
        const tc = await firstPage.getTextContent();
        pageTextContentCache.set(1, tc);
        computeTextRatioFromContent(tc, firstVp);
    } catch (_) {}

    computeDynamicMaxZoom();
    await renderAllPages();
    // Initialize page progress indicator
    updatePageProgress();
}

/**
 * Run client-side OCR (Tesseract.js) to get word-level bounding boxes for an
 * image. Returns normalised words [{ text, bbox: {x,y,w,h} }] or [] on failure.
 * Used when the server's Gemini OCR didn't return coordinates.
 */
async function ocrImageClientSide(url) {
    if (typeof Tesseract === "undefined") return [];
    try {
        const img = new Image();
        // Frontend and backend are separate origins now — Tesseract draws this
        // image onto a canvas internally, which throws a "tainted canvas" security
        // error on a cross-origin image unless crossOrigin is set here AND the
        // backend sends Access-Control-Allow-Origin on the image response (it
        // does, via the cors() middleware applied before /uploads in index.js).
        img.crossOrigin = "anonymous";
        img.src = url;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });
        const nw = img.naturalWidth || 1;
        const nh = img.naturalHeight || 1;

        const { data } = await Tesseract.recognize(img, "eng");
        const words = (data.words || [])
        .filter((w) => w && w.text && w.text.trim() && w.bbox)
        .map((w) => ({
            text: w.text.trim(),
            bbox: {
                x: w.bbox.x0 / nw,
                y: w.bbox.y0 / nh,
                w: (w.bbox.x1 - w.bbox.x0) / nw,
                h: (w.bbox.y1 - w.bbox.y0) / nh,
            },
        }));

        // Also surface the transcription in the Study text tab if the server
        // couldn't extract anything.
        if (data.text && !state.extractedText) {
            state.extractedText = data.text;
            $("#textView").textContent = data.text;
        }
        return words;
    } catch (err) {
        console.error("Client-side OCR failed:", err);
        return [];
    }
}

/**
 * Render an uploaded image with an invisible, selectable word layer built from
 * OCR bounding boxes. Right-clicking a word behaves the same as in a PDF.
 */
function renderImageWithOcr(url, ocrData) {
    const pagesEl = $("#pdfPages");
    pagesEl.innerHTML = "";
    if (debounceRenderTimer) { clearTimeout(debounceRenderTimer); debounceRenderTimer = null; }

    const scrollEl = $("#pdfScroll");
    const available = Math.max(320, (scrollEl ? scrollEl.clientWidth : window.innerWidth) - 56);
    basePageWidth = available;

    const wrap = document.createElement("div");
    wrap.className = "image-page-wrap";
    const uniformWidth = Math.round(basePageWidth * state.zoom);
    wrap.style.width = `${uniformWidth}px`;
    wrap.style.maxWidth = "none";

    const img = document.createElement("img");
    img.src = url;
    img.alt = state.filename || "Uploaded image";
    wrap.appendChild(img);

    const layer = document.createElement("div");
    layer.className = "image-text-layer";

    if (Array.isArray(ocrData)) {
        appendOcrSpans(layer, ocrData);
        let ocrMin = 1, ocrMax = 0;
        for (const w of ocrData) {
            if (w.bbox) {
                if (w.bbox.x < ocrMin) ocrMin = w.bbox.x;
                if (w.bbox.x + w.bbox.w > ocrMax) ocrMax = w.bbox.x + w.bbox.w;
            }
        }
        if (ocrMin < ocrMax) {
            const r = ocrMax - ocrMin;
            if (r >= 0.35 && r <= 1.0) state.documentTextRatio = Math.max(state.documentTextRatio || 0.75, r);
        }
    }

    computeDynamicMaxZoom();

    // Prevent the browser's default image/page context menu on empty areas of
    // the text layer. Word spans handle their own contextmenu. If OCR produced
    // no words, leave the default menu alone so the user still has some feedback.
    if (layer.querySelector("span")) {
        layer.addEventListener("contextmenu", (e) => {
            if (e.target.closest(".image-text-layer span")) return;
            e.preventDefault();
        });
    }

    wrap.appendChild(layer);
    pagesEl.appendChild(wrap);
}

/**
 * Append one absolutely-positioned, invisible span per OCR word into a text
 * layer. Positions are percentages of the layer box, so the same helper works
 * for image layers and per-page PDF layers. Shared with the scanned-PDF flow.
 */
function appendOcrSpans(layerEl, words) {
    for (const w of words) {
        if (!w || !w.text) continue;
        const b = w.bbox || {};
        const span = document.createElement("span");
        span.textContent = w.text;
        span.dataset.word = w.text.replace(/[^\w'-]/g, "");
        span.style.left = `${(Number(b.x) || 0) * 100}%`;
        span.style.top = `${(Number(b.y) || 0) * 100}%`;
        span.style.width = `${(Number(b.w) || 0) * 100}%`;
        span.style.height = `${(Number(b.h) || 0) * 100}%`;
        span.addEventListener("contextmenu", (e) => onOcrWordContextMenu(e, span));
        layerEl.appendChild(span);
    }

    // Add click-drag selection support for multi-word selections across spans.
    let isDragging = false;
    let dragStartSpan = null;
    const selectedSpans = new Set();

    function clearSelection() {
        selectedSpans.forEach((s) => s.classList.remove("ocr-selected"));
        selectedSpans.clear();
    }

    layerEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // only left-click
        const span = e.target.closest("span");
        if (!span) return;
        isDragging = true;
        dragStartSpan = span;
        clearSelection();
        span.classList.add("ocr-selected");
        selectedSpans.add(span);
        // Don't preventDefault — let the browser create a native text selection
        // so users see the standard blue highlight. We add our amber overlay on top.
    });

    layerEl.addEventListener("mousemove", (e) => {
        if (!isDragging || !dragStartSpan) return;
        const span = e.target.closest("span");
        if (!span) return;
        clearSelection();

        // Get all spans in reading order (DOM order matches OCR order).
        const allSpans = Array.from(layerEl.querySelectorAll("span"));
        const startIdx = allSpans.indexOf(dragStartSpan);
        const endIdx = allSpans.indexOf(span);
        if (startIdx === -1 || endIdx === -1) return;

        const min = Math.min(startIdx, endIdx);
        const max = Math.max(startIdx, endIdx);
        for (let i = min; i <= max; i++) {
            allSpans[i].classList.add("ocr-selected");
            selectedSpans.add(allSpans[i]);
        }
    });

    function finishDrag(e) {
        if (!isDragging) return;
        isDragging = false;

        if (selectedSpans.size > 0 && dragStartSpan) {
            const allSpans = Array.from(layerEl.querySelectorAll("span"));
            const startIdx = allSpans.indexOf(dragStartSpan);
            const endIdx = allSpans.indexOf(e?.target?.closest?.("span") || dragStartSpan);
            const min = Math.min(startIdx, endIdx >= 0 ? endIdx : startIdx);
            const max = Math.max(startIdx, endIdx >= 0 ? endIdx : startIdx);

            const selectedWords = [];
            for (let i = min; i <= max; i++) {
                selectedWords.push(allSpans[i].textContent);
            }
            const selectedText = selectedWords.join(" ");

            // Build surrounding context from nearby words.
            const contextStart = Math.max(0, min - 30);
            const contextEnd = Math.min(allSpans.length - 1, max + 30);
            const contextWords = [];
            for (let i = contextStart; i <= contextEnd; i++) {
                contextWords.push(allSpans[i].textContent);
            }
            const context = contextWords.join(" ");

            state.pendingSelection = {
                type: "passage",
                text: selectedText,
                context,
                anchorEl: dragStartSpan,
            };
        }

        dragStartSpan = null;
    }

    layerEl.addEventListener("mouseup", finishDrag);
    layerEl.addEventListener("mouseleave", () => {
        if (isDragging) finishDrag(null);
    });
}

// Right-click handler for image OCR word spans — prioritizes amber (yellow)
// ocr-selected spans over browser selection.
function onOcrWordContextMenu(e, span) {
    e.preventDefault();

    const layerEl = span.closest(".image-text-layer");

    // Priority 1: amber/yellow ocr-selected spans from click-drag.
    const selectedSpans = layerEl?.querySelectorAll("span.ocr-selected");
    if (selectedSpans && selectedSpans.length > 0) {
        const words = [...selectedSpans].map((s) => s.textContent);
        const selectedText = words.join(" ");
        const context = surroundingContextFor(words[0], layerEl);
        state.pendingSelection = { type: "passage", text: selectedText, context, anchorEl: selectedSpans[0] };
        openContextMenu(e.clientX, e.clientY, { showSummarize: true });
        return;
    }

    // Priority 2: browser native selection (blue box).
    const sel = window.getSelection();
    const selectedText = sel?.toString()?.trim();
    if (selectedText && selectedText.length > 0) {
        const context = surroundingContextFor(selectedText.split(/\s+/)[0], layerEl);
        state.pendingSelection = { type: "passage", text: selectedText, context, anchorEl: sel.getRangeAt(0).cloneRange() };
        openContextMenu(e.clientX, e.clientY, { showSummarize: true });
        return;
    }

    // Priority 3: single word right-click.
    const word = span.dataset.word;
    if (!word) return;

    paintHighlight(span);
    const context = surroundingContextFor(word, span.parentElement);
    state.pendingSelection = { type: "word", text: word, context, anchorEl: span };
    openContextMenu(e.clientX, e.clientY, { showSummarize: false });
}

/**
 * Attach the server's per-page OCR word boxes to the rendered pages. Handles two
 * cases: fully-scanned pages (empty native layer -> full-page words) and mixed
 * pages (native text present -> only the embedded-image words are added on top).
 * Each page's words are already normalised to the page, so they drop straight in.
 * A dataset flag prevents double-applying on re-poll / re-render.
 */
function applyPdfOcrLayers() {
    if (!state.pdfOcr) return 0;
    let added = 0;
    for (const wrap of document.querySelectorAll(".pdf-page-wrap")) {
        if (wrap.dataset.ocrApplied) continue;
        const page = Number(wrap.dataset.page);
        const layer = wrap.querySelector(".pdf-text-layer");
        if (!layer) continue;
        const words = state.pdfOcr?.[page]?.words;
        if (Array.isArray(words) && words.length > 0) {
            appendOcrSpans(layer, words);
            added++;
        }
        wrap.dataset.ocrApplied = "1";
    }
    return added;
}

/**
 * The server analyses/OCRs PDF pages in the background after the upload response,
 * so ocrData may not exist on first fetch. Poll a few times and apply the per-page
 * word layers once they arrive. Runs for every PDF (mixed or scanned); pure-text
 * PDFs simply return an empty ocrData object and nothing is applied.
 */
async function maybeLoadScannedOcr(docId) {
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const full = await api(`/api/documents/${docId}`).then((r) => r.json()).catch(() => null);
        if (!full) continue;
        const ocr = full.ocrData && !Array.isArray(full.ocrData) ? full.ocrData : null;
        if (ocr && Object.keys(ocr).length > 0) {
            state.pdfOcr = ocr;
            if (full.extractedText) {
                state.extractedText = full.extractedText;
                $("#textView").textContent = full.extractedText;
            }
            const added = applyPdfOcrLayers();
            if (added > 0) setStatus(`${state.filename} · OCR text ready · right-click any word`);
            return;
        }
    }
}

async function renderAllPages() {
    if (!pdfDoc) return;
    const pagesEl = $("#pdfPages");
    const outputScale = window.devicePixelRatio || 1;
    const uniformWidth = Math.round(basePageWidth * state.zoom);

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        let dims = pageDimensions.get(pageNum);
        if (!dims) {
            const vp1 = page.getViewport({ scale: 1 });
            dims = { width: vp1.width, height: vp1.height };
            pageDimensions.set(pageNum, dims);
        }

        // Ensure page size stays uniform across the study material
        const pageScale = uniformWidth / dims.width;
        const viewport = page.getViewport({ scale: pageScale });

        let wrap = pagesEl.querySelector(`.pdf-page-wrap[data-page="${pageNum}"]`);
        let canvas, textLayer;

        if (!wrap) {
            wrap = document.createElement("div");
            wrap.className = "pdf-page-wrap";
            wrap.dataset.page = pageNum;
            canvas = document.createElement("canvas");
            textLayer = document.createElement("div");
            textLayer.className = "pdf-text-layer";
            wrap.appendChild(canvas);
            wrap.appendChild(textLayer);
            pagesEl.appendChild(wrap);
        } else {
            canvas = wrap.querySelector("canvas");
            textLayer = wrap.querySelector(".pdf-text-layer");
        }

        wrap.style.width = `${uniformWidth}px`;
        wrap.style.height = `${Math.round(viewport.height)}px`;
        wrap.dataset.renderedZoom = state.zoom;

        canvas.width = Math.floor(uniformWidth * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${uniformWidth}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;

        textLayer.style.width = `${uniformWidth}px`;
        textLayer.style.height = `${Math.round(viewport.height)}px`;
        textLayer.style.transform = "";

        const ctx = canvas.getContext("2d");
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
        await page.render({ canvasContext: ctx, viewport, transform }).promise;

        let textContent = pageTextContentCache.get(pageNum);
        if (!textContent) {
            textContent = await page.getTextContent();
            pageTextContentCache.set(pageNum, textContent);
            computeTextRatioFromContent(textContent, viewport);
        }

        textLayer.innerHTML = "";
        buildWordLayer(textLayer, textContent, viewport);
    }

    applyPdfOcrLayers();
    computeDynamicMaxZoom();
}

function updateZoomButtons() {
    const zin = $("#zoomIn");
    const zout = $("#zoomOut");
    const maxZoom = state.dynamicMaxZoom || 1.6;
    if (zin) zin.disabled = state.zoom >= maxZoom - 1e-4;
    if (zout) zout.disabled = state.zoom <= ZOOM_MIN + 1e-4;
}

function setZoom(next) {
    const prevZoom = state.zoom;
    const maxZoom = state.dynamicMaxZoom || 1.6;
    state.zoom = Math.min(Math.max(next, ZOOM_MIN), maxZoom);
    $("#zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
    updateZoomButtons();
    if (Math.abs(state.zoom - prevZoom) < 1e-4) return;
    closeAssistCard();

    if (pdfDoc) {
        const scrollEl = $("#pdfScroll");
        const centerY = scrollEl.scrollTop + scrollEl.clientHeight / 2;
        const pages = [...scrollEl.querySelectorAll(".pdf-page-wrap")];
        let anchorPage = 1;
        let anchorFrac = 0;
        for (const wrap of pages) {
            const top = wrap.offsetTop;
            const h = wrap.offsetHeight || 1;
            if (centerY >= top && centerY < top + h) {
                anchorPage = parseInt(wrap.dataset.page, 10) || 1;
                anchorFrac = (centerY - top) / h;
                break;
            }
            if (wrap === pages[pages.length - 1] && centerY >= top + h) {
                anchorPage = parseInt(wrap.dataset.page, 10) || 1;
                anchorFrac = 1;
            }
        }

        // 1. Instant in-place visual zoom (0ms delay, zero flicker)
        // Enforce uniform page width across all pages of the study material
        const uniformWidth = Math.round(basePageWidth * state.zoom);

        for (const wrap of pages) {
            const pNum = parseInt(wrap.dataset.page, 10);
            const dims = pageDimensions.get(pNum) || { width: basePageWidth, height: basePageWidth * 1.3 };
            const newHeight = Math.round((uniformWidth / dims.width) * dims.height);

            wrap.style.width = `${uniformWidth}px`;
            wrap.style.height = `${newHeight}px`;

            const canvas = wrap.querySelector("canvas");
            if (canvas) {
                canvas.style.width = `${uniformWidth}px`;
                canvas.style.height = `${newHeight}px`;
            }

            const textLayer = wrap.querySelector(".pdf-text-layer");
            if (textLayer) {
                const renderedZoom = parseFloat(wrap.dataset.renderedZoom) || prevZoom;
                const scaleFactor = state.zoom / renderedZoom;
                textLayer.style.width = `${uniformWidth}px`;
                textLayer.style.height = `${newHeight}px`;
                textLayer.style.transform = `scale(${scaleFactor})`;
                textLayer.style.transformOrigin = "top left";
            }
        }

        // Restore anchor scroll center immediately
        const anchorWrap = scrollEl.querySelector(`.pdf-page-wrap[data-page="${anchorPage}"]`);
        if (anchorWrap) {
            const targetTop = anchorWrap.offsetTop + anchorFrac * anchorWrap.offsetHeight - scrollEl.clientHeight / 2;
            scrollEl.scrollTop = Math.max(0, targetTop);
        }

        // Update page progress after zoom change
        setTimeout(() => updatePageProgress(), 50);

        // 2. Background sharp re-render (non-destructive canvas swap with zero flicker)
        if (debounceRenderTimer) clearTimeout(debounceRenderTimer);
        debounceRenderTimer = setTimeout(() => {
            scheduleSharpRerender();
        }, 120);

    } else if (state.isPdf === false && state.documentId) {
        // Image document: scale uniformly so page size stays uniform and words don't cut
        const wrap = $("#pdfPages").querySelector(".image-page-wrap");
        if (wrap) {
            const uniformWidth = Math.round(basePageWidth * state.zoom);
            wrap.style.width = `${uniformWidth}px`;
            wrap.style.maxWidth = "none";
            wrap.style.transform = "";
        }
    }
}

async function scheduleSharpRerender() {
    if (!pdfDoc) return;
    const seq = ++currentRenderSeq;
    const outputScale = window.devicePixelRatio || 1;
    const uniformWidth = Math.round(basePageWidth * state.zoom);
    const scrollEl = $("#pdfScroll");

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        if (seq !== currentRenderSeq) return;
        const page = await pdfDoc.getPage(pageNum);
        if (seq !== currentRenderSeq) return;

        const wrap = scrollEl?.querySelector(`.pdf-page-wrap[data-page="${pageNum}"]`);
        if (!wrap) continue;

        const dims = pageDimensions.get(pageNum) || { width: basePageWidth, height: basePageWidth * 1.3 };
        const pageScale = uniformWidth / dims.width;
        const viewport = page.getViewport({ scale: pageScale });

        const newCanvas = document.createElement("canvas");
        newCanvas.width = Math.floor(uniformWidth * outputScale);
        newCanvas.height = Math.floor(viewport.height * outputScale);
        newCanvas.style.width = `${uniformWidth}px`;
        newCanvas.style.height = `${Math.round(viewport.height)}px`;
        const ctx = newCanvas.getContext("2d");
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        await page.render({ canvasContext: ctx, viewport, transform }).promise;
        if (seq !== currentRenderSeq) return;

        const oldCanvas = wrap.querySelector("canvas");
        if (oldCanvas) oldCanvas.replaceWith(newCanvas);
            else wrap.insertBefore(newCanvas, wrap.firstChild);

        wrap.dataset.renderedZoom = state.zoom;
        wrap.dataset.ocrApplied = "";

        const textLayer = wrap.querySelector(".pdf-text-layer");
        if (textLayer) {
            textLayer.style.transform = "";
            textLayer.style.width = `${uniformWidth}px`;
            textLayer.style.height = `${Math.round(viewport.height)}px`;
            textLayer.innerHTML = "";

            let textContent = pageTextContentCache.get(pageNum);
            if (!textContent) {
                textContent = await page.getTextContent();
                pageTextContentCache.set(pageNum, textContent);
            }
            buildWordLayer(textLayer, textContent, viewport);
        }
    }

    if (seq === currentRenderSeq) {
        applyPdfOcrLayers();
    }
}

$("#zoomIn")?.addEventListener("click", () => setZoom(state.zoom + ZOOM_STEP));
$("#zoomOut")?.addEventListener("click", () => setZoom(state.zoom - ZOOM_STEP));
$("#zoomReset")?.addEventListener("click", () => setZoom(1));
updateZoomButtons();

window.addEventListener("resize", () => {
    if (state.documentId) {
        computeDynamicMaxZoom();
    }
});

// Build one absolutely-positioned span PER WORD, so right-click always
// targets a single word (PRD 5.2 / "Low interaction cost").
// Also adds click-drag multi-word selection with amber highlight boxes (same as image OCR).
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

            layerEl.appendChild(span);
        }
    }

  // Click-drag selection support — matches image OCR appendOcrSpans pattern.
  let isDragging = false;
  let dragStartSpan = null;
  const selectedSpans = new Set();

  function clearSelection() {
    selectedSpans.forEach((s) => s.classList.remove("pdf-selected"));
    selectedSpans.clear();
  }

  layerEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const span = e.target.closest("span");
    if (!span) return;
    isDragging = true;
    dragStartSpan = span;
    clearSelection();
    span.classList.add("pdf-selected");
    selectedSpans.add(span);
  });

  layerEl.addEventListener("mousemove", (e) => {
    if (!isDragging || !dragStartSpan) return;
    const span = e.target.closest("span");
    if (!span) return;
    clearSelection();

    const allSpans = Array.from(layerEl.querySelectorAll("span"));
    const startIdx = allSpans.indexOf(dragStartSpan);
    const endIdx = allSpans.indexOf(span);
    if (startIdx === -1 || endIdx === -1) return;

    const min = Math.min(startIdx, endIdx);
    const max = Math.max(startIdx, endIdx);
    for (let i = min; i <= max; i++) {
      allSpans[i].classList.add("pdf-selected");
      selectedSpans.add(allSpans[i]);
    }
  });

  function finishDrag(e) {
    if (!isDragging) return;
    isDragging = false;

    if (selectedSpans.size > 0 && dragStartSpan) {
      const allSpans = Array.from(layerEl.querySelectorAll("span"));
      const startIdx = allSpans.indexOf(dragStartSpan);
      const endIdx = allSpans.indexOf(e?.target?.closest?.("span") || dragStartSpan);
      const min = Math.min(startIdx, endIdx >= 0 ? endIdx : startIdx);
      const max = Math.max(startIdx, endIdx >= 0 ? endIdx : startIdx);

      const selectedWords = [];
      for (let i = min; i <= max; i++) {
        selectedWords.push(allSpans[i].textContent);
      }
      const selectedText = selectedWords.join(" ");

      const contextStart = Math.max(0, min - 30);
      const contextEnd = Math.min(allSpans.length - 1, max + 30);
      const contextWords = [];
      for (let i = contextStart; i <= contextEnd; i++) {
        contextWords.push(allSpans[i].textContent);
      }
      const context = contextWords.join(" ");

      savedPdfSelection = { text: selectedText, context };
    }

    dragStartSpan = null;
  }

  layerEl.addEventListener("mouseup", finishDrag);
  layerEl.addEventListener("mouseleave", () => {
    if (isDragging) finishDrag(null);
  });
}

// ---------------------------------------------------------------------------
// Persisted PDF selection — captured on mouseup so it survives the contextmenu
// event clearing window.getSelection(). Used by onWordContextMenu to send the
// full passage text to the AI instead of just the right-clicked word.
// ---------------------------------------------------------------------------
let savedPdfSelection = null; // { text, context }

// Single global listener — clears savedPdfSelection on new left-clicks outside menus.
document.addEventListener("mousedown", (e) => {
    if (e.button === 0 && !e.target.closest(".context-menu") && !e.target.closest(".assist-card")) {
        savedPdfSelection = null;
    }
});

// Right-click context menu for PDF pages — uses savedPdfSelection (captured by
// click-drag in buildWordLayer) since native selection is disabled.
document.addEventListener("contextmenu", (e) => {
    const pageWrap = e.target.closest?.(".pdf-page-wrap");
    if (!pageWrap) return;

    // Use savedPdfSelection from drag-selection, or fall back to live browser selection.
    let selectedText = savedPdfSelection?.text || null;
    let context = savedPdfSelection?.context || null;

    if (!selectedText) {
        const sel = window.getSelection();
        selectedText = sel?.toString()?.trim() || null;
        if (selectedText) {
            const textLayer = pageWrap.querySelector(".pdf-text-layer");
            context = surroundingContextFor(selectedText.split(/\s+/)[0], textLayer);
        }
    }
    if (!selectedText) return; // no selection — let browser show its default menu

    e.preventDefault();

    state.pendingSelection = {
        type: "passage",
        text: selectedText,
        context,
        anchorEl: null,
    };
    openContextMenu(e.clientX, e.clientY, { showSummarize: true });
});

function surroundingContextFor(word, layerEl) {
    // Grab nearby word spans' text as a crude context window.
    const container = layerEl?.parentElement || document;
    const spans = Array.from(container.querySelectorAll(".pdf-text-layer span, .image-text-layer span"));
    return spans.map((s) => s.textContent).join(" ").slice(0, 3000);
}

/** Draws the rounded-corner highlight and remembers it so it can be cleared later. */
function paintHighlight(span) {
    clearHighlights();
    const rect = document.createElement("div");
    rect.className = "word-highlight-rect";
    const wrap = span.closest(".pdf-page-wrap, .image-page-wrap");
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
    updatePageProgress();
}

function updatePageProgress() {
    const scrollContainer = $("#pdfScroll");
    if (!scrollContainer || !pdfDoc) return;
    
    const pages = scrollContainer.querySelectorAll(".pdf-page-wrap");
    if (pages.length === 0) return;
    
    const scrollTop = scrollContainer.scrollTop;
    const containerHeight = scrollContainer.clientHeight;
    const midpoint = scrollTop + (containerHeight / 2);
    
    let currentPageNum = 1;
    
    // Find which page is currently in view (at the midpoint of viewport)
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const pageTop = page.offsetTop;
        const pageBottom = pageTop + page.offsetHeight;
        
        if (midpoint >= pageTop && midpoint <= pageBottom) {
            currentPageNum = parseInt(page.dataset.page);
            break;
        } else if (midpoint > pageBottom) {
            currentPageNum = parseInt(page.dataset.page);
        }
    }
    
    const totalPages = pdfDoc.numPages;
    const percent = Math.round((currentPageNum / totalPages) * 100);
    
    // Update the display
    const pageCurrentEl = $("#pageCurrent");
    const pageTotalEl = $("#pageTotal");
    const pagePercentEl = $("#pagePercent");
    
    if (pageCurrentEl) pageCurrentEl.textContent = currentPageNum;
    if (pageTotalEl) pageTotalEl.textContent = totalPages;
    if (pagePercentEl) pagePercentEl.textContent = `${percent}%`;
}

function setPageProgressForImage() {
    // For images, always show 1/1 and 100%
    const pageCurrentEl = $("#pageCurrent");
    const pageTotalEl = $("#pageTotal");
    const pagePercentEl = $("#pagePercent");
    
    if (pageCurrentEl) pageCurrentEl.textContent = "1";
    if (pageTotalEl) pageTotalEl.textContent = "1";
    if (pagePercentEl) pagePercentEl.textContent = "100%";
}

function resetPageProgress() {
    // Reset to 0/0 and 0% when no document is loaded
    const pageCurrentEl = $("#pageCurrent");
    const pageTotalEl = $("#pageTotal");
    const pagePercentEl = $("#pagePercent");
    
    if (pageCurrentEl) pageCurrentEl.textContent = "0";
    if (pageTotalEl) pageTotalEl.textContent = "0";
    if (pagePercentEl) pagePercentEl.textContent = "0%";
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

        // Primary answer is the concise Gemini definition; Wikipedia is an optional
        // deep-dive reference shown only as a small link.
        const body = data.definition
            ? `<p>${escapeHtml(data.definition)}</p>`
            : `<p>${escapeHtml(data.resolvedSense || "No definition was found.")}</p>`;

        const wikiLink = data.wikipedia
            ? `<a class="assist-ref" href="${data.wikipedia.url}" target="_blank" rel="noopener">Open Wikipedia reference →</a>`
            : "";

        assistBody.innerHTML = `
<div class="assist-label">Definition</div>
<h4>${escapeHtml(data.wikipedia?.title || text)}</h4>
${body}
${wikiLink}
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
    const needsKey = /GEMINI_API_KEY|MANUS_API_KEY/i.test(err.message);
    return `
<div class="assist-label" style="color:var(--wrong)">Couldn't complete this</div>
<p>${escapeHtml(err.message)}</p>
${needsKey ? `<p style="color:var(--ink-soft)">Add your key to <code>backend/.env</code> (see <code>.env.example</code>) and restart the server.</p>` : ""}
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
// (Moved into Dashboard drawer; guarded in case old element is re-added)
$("#btnCalibration")?.addEventListener("click", async () => {
    const qs = state.documentId ? `?documentId=${state.documentId}` : "";
    const data = await api(`/api/calibration${qs}`).then((r) => r.json());
    if ($("#calibrationBody")) $("#calibrationBody").innerHTML = renderCalibration(data);
    if ($("#calibrationDrawer")) openDrawer($("#calibrationDrawer"));
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

// ---------------------------------------------------------------- quiz history
$("#btnQuizHistory").addEventListener("click", async () => {
    const history = await api("/api/quizzes/history").then((r) => r.json());
    $("#quizHistoryList").innerHTML = renderQuizHistory(history);
    openDrawer($("#quizHistoryDrawer"));
});

function renderQuizHistory(history) {
    if (!history.length) {
        return `<div class="empty-note">No quizzes taken yet. Generate a quiz to see it here.</div>`;
    }
    return history.map((h) => {
        const scoreDisplay = h.mode === "freeText" ? `${Math.round(h.score * 100)}%` : `${h.score} / ${h.total}`;
        const correctPct = Math.round((h.correctCount / h.answerCount) * 100);
        return `
<div class="review-item" style="cursor:pointer" data-attempt-id="${escapeHtml(h.id)}">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
<span style="font-weight:600;font-size:13px">${scoreDisplay}</span>
<span style="font-size:11px;color:var(--ink-soft);font-family:var(--font-mono)">${new Date(h.createdAt).toLocaleString()}</span>
</div>
<div style="font-size:12px;color:var(--ink-soft)">
${h.mode === "freeText" ? "Free-text" : "MCQ"} · ${h.correctCount}/${h.answerCount} correct (${correctPct}%)
</div>
<button class="btn btn-ghost" style="margin-top:8px;font-size:11.5px;padding:4px 10px;width:100%" data-view-results="${escapeHtml(h.id)}">View Results</button>
</div>`;
    }).join("");
}

// Click handler for quiz history items — loads the attempt and shows results in the quiz overlay.
document.addEventListener("click", async (e) => {
    const viewBtn = e.target.closest("[data-view-results]");
    if (viewBtn) {
        const attemptId = viewBtn.dataset.viewResults;
        await showHistoricQuizResults(attemptId);
    }
});

async function showHistoricQuizResults(attemptId) {
    try {
        const res = await api(`/api/quizzes/attempts/${attemptId}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(`Could not load attempt: ${err.error || res.statusText}`);
            return;
        }
        const attempt = await res.json();

        // Populate currentAttempt and currentQuiz so renderQuizResults works.
        currentAttempt = attempt;
        currentQuiz = {
            id: attempt.quizId,
            mode: attempt.mode,
            questions: attempt.quizQuestions || [],
        };

        closeDrawers();
        openQuizOverlay();
        renderQuizResults();
    } catch (err) {
        alert(`Error loading quiz results: ${err.message}`);
    }
}

// ---------------------------------------------------------------- settings
$("#btnSettings").addEventListener("click", async () => {
    const settings = await api("/api/settings").then((r) => r.json());
    $("#settingsBody").innerHTML = renderSettings(settings);
    openDrawer($("#settingsDrawer"));
});

function renderSettings(s) {
    return `
<div style="margin-bottom:20px">
<h4 style="margin:0 0 8px;font-size:14px">Gemini API Configuration</h4>
<p style="font-size:12px;color:var(--ink-soft);margin:0 0 12px">OCR, definitions, translate, summarize, key terms, and free-text grading.</p>
<div style="font-size:12.5px;line-height:1.8">
<div><strong>Model:</strong> ${escapeHtml(s.geminiModel)}</div>
<div><strong>API base:</strong> ${escapeHtml(s.geminiApiBase)}</div>
<div><strong>API key set:</strong> ${s.geminiApiKeySet ? `Yes (${s.geminiApiKeyLength} chars)` : "No"}</div>
</div>
</div>
<div style="margin-bottom:24px">
<label style="display:block;font-size:13px;margin-bottom:6px;font-weight:500">Override Gemini API Key</label>
<input id="settingsGeminiKeyInput" type="password" placeholder="Paste new key…" style="width:100%;padding:8px;border:1px solid var(--hairline);border-radius:var(--radius-sm);font-family:inherit;font-size:13px;margin-bottom:8px" />
<button class="btn btn-primary btn-block" id="settingsSaveGeminiKeyBtn" data-provider="gemini">Save Key (session only)</button>
<p style="font-size:11px;color:var(--ink-soft);margin-top:6px">This overrides the key in-memory only. It does NOT persist to .env and will be lost on server restart.</p>
</div>

<hr style="border:none;border-top:1px solid var(--hairline);margin:0 0 20px" />

<div style="margin-bottom:20px">
<h4 style="margin:0 0 8px;font-size:14px">Manus API Configuration</h4>
<p style="font-size:12px;color:var(--ink-soft);margin:0 0 12px">Quiz generation. Agent profile, concurrency limit, and API key override.</p>
<div style="font-size:12.5px;line-height:1.8">
<div><strong>Agent profile:</strong> ${escapeHtml(s.manusAgentProfile)}</div>
<div><strong>Max concurrent tasks:</strong> ${s.manusMaxConcurrentTasks}</div>
<div><strong>API base:</strong> ${escapeHtml(s.manusApiBase)}</div>
<div><strong>API key set:</strong> ${s.manusApiKeySet ? `Yes (${s.manusApiKeyLength} chars)` : "No"}</div>
</div>
</div>
<div style="margin-bottom:24px">
<label style="display:block;font-size:13px;margin-bottom:6px;font-weight:500">Override Manus API Key</label>
<input id="settingsManusKeyInput" type="password" placeholder="Paste new key…" style="width:100%;padding:8px;border:1px solid var(--hairline);border-radius:var(--radius-sm);font-family:inherit;font-size:13px;margin-bottom:8px" />
<button class="btn btn-primary btn-block" id="settingsSaveManusKeyBtn" data-provider="manus">Save Key (session only)</button>
<p style="font-size:11px;color:var(--ink-soft);margin-top:6px">This overrides the key in-memory only. It does NOT persist to .env and will be lost on server restart.</p>
</div>

<hr style="border:none;border-top:1px solid var(--hairline);margin:0 0 20px" />

<div style="margin-bottom:20px">
<h4 style="margin:0 0 8px;font-size:14px">Data Management</h4>
<p style="font-size:12px;color:var(--ink-soft);margin:0 0 12px">Clear cached data for this session. Uploaded files remain on disk until server restart.</p>
<div style="display:flex;flex-direction:column;gap:8px">
<button class="btn btn-ghost" id="settingsClearDocuments" style="text-align:left;border-color:var(--wrong);color:var(--wrong)">🗑 Clear all documents & uploads</button>
<button class="btn btn-ghost" id="settingsClearQuizzes" style="text-align:left;border-color:var(--amber);color:var(--amber)">🗑 Clear quiz history & attempts</button>
<button class="btn btn-ghost" id="settingsClearDoubts" style="text-align:left;border-color:var(--accent);color:var(--accent)">🗑 Clear doubt notebook</button>
<button class="btn btn-ghost" id="settingsClearAll" style="text-align:left;border-color:var(--ink);color:var(--ink)">🗑 Clear ALL session data</button>
</div>
<p style="font-size:11px;color:var(--ink-soft);margin-top:8px">These actions are irreversible for the current session.</p>
</div>
`;
}

// Settings button handlers are attached dynamically after render because the drawer body is rebuilt each time.
// One shared handler for both provider key inputs, keyed off data-provider.
document.addEventListener("click", async (e) => {
    const btn = e.target.closest("#settingsSaveGeminiKeyBtn, #settingsSaveManusKeyBtn");
    if (!btn) return;

    const provider = btn.dataset.provider; // "gemini" | "manus"
    const input = provider === "gemini" ? $("#settingsGeminiKeyInput") : $("#settingsManusKeyInput");
    const key = input.value.trim();
    if (!key) return;

    const originalLabel = "Save Key (session only)";
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
        const res = await api(`/api/settings/${provider}-api-key`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: key }),
        });
        const data = await res.json();
        if (res.ok) {
            btn.textContent = "✓ Key saved";
            btn.style.background = "var(--correct)";
            btn.style.borderColor = "var(--correct)";
            setTimeout(() => { btn.disabled = false; btn.textContent = originalLabel; btn.style.background = ""; btn.style.borderColor = ""; }, 2000);
        } else {
            btn.textContent = `✗ ${data.error}`;
            btn.style.background = "var(--wrong)";
            setTimeout(() => { btn.disabled = false; btn.textContent = originalLabel; btn.style.background = ""; }, 3000);
        }
    } catch (err) {
        btn.textContent = "✗ Network error";
        setTimeout(() => { btn.disabled = false; btn.textContent = originalLabel; }, 3000);
    }
});

// Data management clear buttons — also attached dynamically via delegation.
document.addEventListener("click", async (e) => {
    const clearBtn = e.target.closest("#settingsClearDocuments, #settingsClearQuizzes, #settingsClearDoubts, #settingsClearAll");
    if (!clearBtn) return;

    const scopeMap = {
        settingsClearDocuments: "documents",
        settingsClearQuizzes: "quizzes",
        settingsClearDoubts: "doubts",
        settingsClearAll: "all",
    };
    const scope = scopeMap[clearBtn.id];
    if (!scope) return;

    const labels = { documents: "documents & uploads", quizzes: "quiz history & attempts", doubts: "doubt notebook", all: "ALL session data" };
    if (!confirm(`Are you sure you want to clear ${labels[scope]}? This cannot be undone.`)) return;

    const origText = clearBtn.textContent;
    clearBtn.disabled = true;
    clearBtn.textContent = "Clearing…";
    try {
        const res = await api("/api/settings/clear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            clearBtn.textContent = "✓ Cleared";
            clearBtn.style.background = "var(--correct)";
            clearBtn.style.color = "#fff";
            setTimeout(() => {
                clearBtn.disabled = false;
                clearBtn.textContent = origText;
                clearBtn.style.background = "";
                clearBtn.style.color = "";
                // Reset reader state if documents were cleared.
                if (scope === "documents" || scope === "all") {
                    state.documentId = null;
                    state.filename = null;
                    state.isPdf = false;
                    state.extractedText = "";
                    state.pdfOcr = null;
                    $("#uploadStage").classList.remove("hidden");
                    $("#readerStage").classList.add("hidden");
                    $("#pdfPages").innerHTML = "";
                    $("#textView").textContent = "";
                    resetPageProgress();
                }
            }, 2000);
        } else {
            clearBtn.textContent = `✗ ${data.error || "Server error (" + res.status + ")"}`;
            clearBtn.style.background = "var(--wrong)";
            clearBtn.style.color = "#fff";
            setTimeout(() => {
                clearBtn.disabled = false;
                clearBtn.textContent = origText;
                clearBtn.style.background = "";
                clearBtn.style.color = "";
            }, 3000);
        }
    } catch (err) {
        clearBtn.textContent = "✗ Network error";
        clearBtn.style.background = "var(--wrong)";
        clearBtn.style.color = "#fff";
        setTimeout(() => {
            clearBtn.disabled = false;
            clearBtn.textContent = origText;
            clearBtn.style.background = "";
            clearBtn.style.color = "";
        }, 3000);
    }
});

// ---------------------------------------------------------------- debug log
$("#btnDebugLog").addEventListener("click", () => {
    renderDebugLog();
    openDrawer($("#debugLogDrawer"));
});

// Toggle PDF ghost text visibility for debugging.
let ghostTextVisible = false;
$("#btnToggleGhostText").addEventListener("click", () => {
    ghostTextVisible = !ghostTextVisible;
    document.documentElement.classList.toggle("ghost-text-visible", ghostTextVisible);
    $("#btnToggleGhostText").style.background = ghostTextVisible ? "var(--accent-ink)" : "";
});

function renderDebugLog() {
    if (!DEBUG_LOG.length) {
        $("#debugLogBody").innerHTML = `<div class="empty-note">No API calls logged yet. Make a request to see it here.</div>`;
        return;
    }
    const lines = DEBUG_LOG.map((e) => {
        if (e.method) {
            return `[${e.time}] → ${e.method} ${e.url}${e.body ? "\n  Body: " + e.body : ""}`;
        }
        if (e.error) {
            return `[${e.time}] ✗ ${e.url}\n  Error: ${e.error} (${e.ms}ms)`;
        }
        return `[${e.time}] ← ${e.status} ${e.url} (${e.ms}ms)`;
    }).join("\n\n");
    $("#debugLogBody").textContent = lines;
    // Scroll to bottom
    const body = $("#debugLogBody");
    body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------- dashboard — learning overview
$("#btnDashboard").addEventListener("click", async () => {
    try {
        // Fetch both dashboard data and confidence calibration in parallel.
        const [dashData, calData] = await Promise.all([
            api("/api/dashboard").then((r) => r.json()).catch(() => ({})),
            api("/api/calibration").then((r) => r.json()).catch(() => ({})),
        ]);
        openQuizOverlay(); // reuse the full-screen quiz overlay for dashboard
        $("#quizProgressFill").style.width = "0%";
        $("#quizProgressLabel").textContent = "";
        renderFullDashboard(dashData || {}, calData || {});
    } catch (err) {
        console.error("Dashboard error:", err);
        alert(`Failed to load dashboard: ${err.message}`);
    }
});

function renderFullDashboard(dashData, calData) {
    const weakTopics = dashData?.weakTopics || [];
    const improvement = dashData?.improvement || null;
    const reviewSummary = dashData?.reviewSummary || { dueNow: 0, upcoming: 0 };

    let html = `<div class="quiz-overlay-inner" style="max-width:800px">`;

    // Confidence section (moved from separate tab into dashboard)
    if (calData.totalAnswered > 0) {
        const pct = (n) => (n === null ? "—" : `${Math.round(n * 100)}%`);
        const confidentWrongRate = calData.confidentWrongRate;
        html += `
<div style="margin-bottom:32px">
<h3 style="font-family:var(--font-display);font-size:22px;margin:0 0 16px">Confidence Calibration</h3>
${confidentWrongRate !== null ? `
<div style="background:var(--paper);border-radius:var(--radius-lg);padding:20px;text-align:center;margin-bottom:16px">
<div style="font-family:var(--font-display);font-size:42px;font-weight:500;color:var(--wrong)">${pct(confidentWrongRate)}</div>
<div style="font-size:13px;color:var(--ink-soft)">of the time you were <strong>confident</strong>, you were actually wrong</div>
</div>
` : ""}
<div style="display:flex;gap:12px">
${["confident","unsure","guessing"].map((level) => {
const b = calData.byConfidence[level];
const widthPct = b.accuracy === null ? 0 : Math.round(b.accuracy * 100);
return `
<div style="flex:1;background:var(--paper);border-radius:var(--radius-md);padding:14px">
<div style="font-size:12px;font-weight:600;text-transform:capitalize;margin-bottom:8px">${level}</div>
<div style="height:8px;background:var(--hairline);border-radius:999px;overflow:hidden;margin-bottom:6px">
<div style="height:100%;width:${widthPct}%;background:${level === "confident" ? "var(--accent)" : level === "unsure" ? "var(--amber)" : "var(--ink-soft)"};border-radius:999px"></div>
</div>
<div style="font-size:11px;color:var(--ink-soft)">${b.total} answered · ${pct(b.accuracy)} correct</div>
</div>`;
}).join("")}
</div>
</div>
`;
    } else {
        html += `<div style="margin-bottom:32px"><h3 style="font-family:var(--font-display);font-size:22px;margin:0 0 8px">Confidence Calibration</h3><p style="color:var(--ink-soft);font-size:13px">Take a quiz first — confidence stats fill in after you answer questions.</p></div>`;
    }

    // Weak topics section
    html += `<div style="margin-bottom:32px"><h3 style="font-family:var(--font-display);font-size:22px;margin:0 0 16px">Weak Topics</h3>`;
    if (weakTopics.length) {
        html += weakTopics.map((t) => `
<div style="background:var(--paper);border-radius:var(--radius-md);padding:14px;margin-bottom:8px">
<div style="font-weight:600;font-size:14px">${escapeHtml(t.topic)}</div>
<div style="font-size:12px;color:var(--ink-soft);margin-top:4px">${t.missCount} miss${t.missCount !== 1 ? "es" : ""} · last seen ${new Date(t.lastSeen).toLocaleDateString()}</div>
</div>`).join("");
    } else {
        html += `<p style="color:var(--ink-soft);font-size:13px">No weak topics detected yet.</p>`;
    }
    html += `</div>`;

    // Review summary
    html += `<div style="margin-bottom:32px"><h3 style="font-family:var(--font-display);font-size:22px;margin:0 0 16px">Review Queue</h3>`;
    if (reviewSummary.dueNow > 0 || reviewSummary.upcoming > 0) {
        html += `<div style="display:flex;gap:12px">
<div style="flex:1;background:var(--paper);border-radius:var(--radius-md);padding:14px;text-align:center">
<div style="font-family:var(--font-display);font-size:28px;font-weight:500">${reviewSummary.dueNow}</div>
<div style="font-size:12px;color:var(--ink-soft)">Due now</div>
</div>
<div style="flex:1;background:var(--paper);border-radius:var(--radius-md);padding:14px;text-align:center">
<div style="font-family:var(--font-display);font-size:28px;font-weight:500">${reviewSummary.upcoming}</div>
<div style="font-size:12px;color:var(--ink-soft)">Upcoming</div>
</div>
</div>`;
    } else {
        html += `<p style="color:var(--ink-soft);font-size:13px">Nothing to review right now.</p>`;
    }
    html += `</div>`;

    // Improvement progress
    html += `<div><h3 style="font-family:var(--font-display);font-size:22px;margin:0 0 16px">Improvement Progress</h3>`;
    const impList = Array.isArray(improvement) ? improvement : (improvement?.topics || []);
    if (impList.length) {
        html += impList.map((i) => `
<div style="background:var(--paper);border-radius:var(--radius-md);padding:14px;margin-bottom:8px">
<div style="font-weight:600;font-size:14px">${escapeHtml(i.topic || i)}</div>
<div style="font-size:12px;color:var(--correct);margin-top:4px">✓ Improved</div>
</div>`).join("");
    } else {
        html += `<p style="color:var(--ink-soft);font-size:13px">Complete follow-up questions to see improvement tracking.</p>`;
    }
    html += `</div></div>`;

    quizOverlayBody.innerHTML = html;
}

// ---------------------------------------------------------------- reader tabs
$$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const mode = tab.dataset.mode;
        $("#pdfPages").classList.toggle("hidden", mode !== "original");
        $("#textView").classList.toggle("hidden", mode !== "text");
        
        // Update page progress when switching back to original mode
        if (mode === "original") {
            setTimeout(() => updatePageProgress(), 50);
        }
    });
});

$$(".tools-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        $$(".tools-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        $("#panelTerms")?.classList.toggle("hidden", tab.dataset.panel !== "terms");
        $("#panelQuiz")?.classList.toggle("hidden", tab.dataset.panel !== "quiz");
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
let currentQuiz = null; // { id, questions: [...], mode: 'mcq'|'freeText' }
let currentQuestionIndex = 0;
let currentAttempt = null; // set once results come back
const quizAnswers = new Map(); // questionIndex -> { selectedIndex?, text?, confidence }

const quizOverlay = $("#quizOverlay");
const quizOverlayBody = $("#quizOverlayBody");

$("#btnGenQuiz").addEventListener("click", () => {
    if (!state.documentId) return;
    openQuizConfigModal();
});

function openQuizConfigModal() {
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = "quizConfigModal";
    modal.innerHTML = `
<div class="modal-card" style="max-width:480px">
    <h3>Generate quiz</h3>
    <div style="margin-bottom:16px">
        <label style="display:block;font-size:13px;margin-bottom:6px;font-weight:500">Number of questions</label>
        <select id="quizCountSelect" style="width:100%;padding:8px;border:1px solid var(--hairline);border-radius:var(--radius-sm);font-family:inherit;font-size:14px">
            <option value="5" selected>5 questions (standard)</option>
            <option value="10">10 questions (comprehensive)</option>
            <option value="15">15 questions (thorough)</option>
            <option value="20">20 questions (deep dive)</option>
        </select>
    </div>
    <div style="margin-bottom:20px">
        <label style="display:block;font-size:13px;margin-bottom:6px;font-weight:500">Answer mode</label>
        <div style="display:flex;gap:8px">
            <button id="modeMcq" class="btn btn-primary" style="flex:1" data-mode="mcq">Multiple choice</button>
            <button id="modeFreeText" class="btn btn-ghost" style="flex:1" data-mode="freeText">Write your answer</button>
        </div>
    </div>
    <div class="modal-actions">
        <button class="btn btn-ghost" id="quizConfigCancel">Cancel</button>
        <button class="btn btn-primary" id="quizConfigStart">Start quiz</button>
    </div>
</div>
`;
    document.body.appendChild(modal);

    let selectedMode = "mcq";
    const mcqBtn = modal.querySelector("#modeMcq");
    const ftBtn = modal.querySelector("#modeFreeText");

    mcqBtn.addEventListener("click", () => {
        selectedMode = "mcq";
        mcqBtn.className = "btn btn-primary";
        ftBtn.className = "btn btn-ghost";
    });
    ftBtn.addEventListener("click", () => {
        selectedMode = "freeText";
        ftBtn.className = "btn btn-primary";
        mcqBtn.className = "btn btn-ghost";
    });

    modal.querySelector("#quizConfigCancel").addEventListener("click", () => modal.remove());
    modal.querySelector("#quizConfigStart").addEventListener("click", async () => {
        const count = Number(modal.querySelector("#quizCountSelect").value);
        modal.remove();
        startQuiz(count, selectedMode);
    });
}

async function startQuiz(count, mode) {
    quizAnswers.clear();
    currentQuestionIndex = 0;
    currentAttempt = null;

    // Show a temporary loading overlay while generating.
    openQuizOverlay();
    $("#quizProgressFill").style.width = "0%";
    $("#quizProgressLabel").textContent = "";
    quizOverlayBody.innerHTML = `<div class="empty-note">Generating a ${count}-question ${mode === "freeText" ? "free-text" : "MCQ"} quiz…</div>`;

    try {
        const res = await api(`/api/documents/${state.documentId}/quiz`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count, mode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        currentQuiz = data;
        renderQuizQuestion();
    } catch (err) {
        const needsKey = /MANUS_API_KEY/i.test(err.message);
        const hint = needsKey ? `<br><span style="color:var(--ink-soft)">Add your Manus key to <code>.env</code> and restart the server.</span>` : "";
        quizOverlayBody.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}${hint}</div>`;
    }
}

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
    const isFreeText = currentQuiz.mode === "freeText";

    if (isFreeText) {
        quizOverlayBody.innerHTML = `
<div class="quiz-overlay-inner">
    <div class="quiz-topic-badge">${escapeHtml(q.topic || "")}</div>
    <div class="quiz-overlay-question">${escapeHtml(q.question)}</div>
    <textarea id="freeTextAnswer" placeholder="Type your answer here…" style="width:100%;min-height:120px;padding:12px;border:1px solid var(--hairline);border-radius:var(--radius-md);font-family:inherit;font-size:15px;line-height:1.6;resize:vertical;margin-bottom:20px">${escapeHtml(saved.text || "")}</textarea>
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

        const textarea = quizOverlayBody.querySelector("#freeTextAnswer");
        textarea.addEventListener("input", () => {
            const prev = quizAnswers.get(currentQuestionIndex) || {};
            quizAnswers.set(currentQuestionIndex, { ...prev, text: textarea.value });
        });
    } else {
        quizOverlayBody.innerHTML = `
<div class="quiz-overlay-inner">
    <div class="quiz-topic-badge">${escapeHtml(q.topic || "")}</div>
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
    }

    quizOverlayBody.querySelectorAll(".quiz-overlay-confidence-row button").forEach((btn) => {
        btn.addEventListener("click", () => {
            quizOverlayBody.querySelectorAll(".quiz-overlay-confidence-row button").forEach((b) => b.classList.remove("selected"));
            btn.classList.add("selected");
            const prev = quizAnswers.get(currentQuestionIndex) || {};
            quizAnswers.set(currentQuestionIndex, { ...prev, confidence: btn.dataset.conf });
        });
    });

    $("#quizPrevBtn")?.addEventListener("click", () => {
        currentQuestionIndex = Math.max(0, currentQuestionIndex - 1);
        renderQuizQuestion();
    });
    $("#quizNextBtn")?.addEventListener("click", () => {
        if (isLast) { submitQuiz(); return; }
        currentQuestionIndex++;
        renderQuizQuestion();
    });
}

async function submitQuiz() {
    const responses = currentQuiz.questions.map((_, qi) => {
        const a = quizAnswers.get(qi) || {};
        if (currentQuiz.mode === "freeText") {
            return { questionIndex: qi, text: a.text || "", confidence: a.confidence || "unsure" };
        }
        return { questionIndex: qi, selectedIndex: a.selectedIndex ?? -1, confidence: a.confidence || "unsure" };
    });

    updateProgressComplete();

    // Show a compact, non-blocking grading toast so the user can keep reading.
    showGradingToast(currentQuiz.questions.length);

    const res = await api(`/api/quizzes/${currentQuiz.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses }),
    });
    const attempt = await res.json();
    if (!res.ok) {
        hideGradingToast();
        quizOverlayBody.innerHTML = `<div class="empty-note">${escapeHtml(attempt.error)}</div>`;
        return;
    }
    currentAttempt = attempt;

    // Update the toast to show grading complete + "View Full Results" button.
    showGradingCompleteToast(attempt);
}

function updateProgressComplete() {
    $("#quizProgressFill").style.width = "100%";
    $("#quizProgressLabel").textContent = `${currentQuiz.questions.length} / ${currentQuiz.questions.length}`;
}

function renderQuizResults() {
    const attempt = currentAttempt;
    const isFreeText = attempt.mode === "freeText";

    quizOverlayBody.innerHTML = `
<div class="quiz-overlay-inner quiz-results">
    <div class="quiz-results-score">${isFreeText ? `${Math.round(attempt.score * 100)}%` : `${attempt.score} / ${attempt.total}`}</div>
    <div class="quiz-results-sub">Weak items were added to your review queue.</div>
    <div class="quiz-results-list">
        ${attempt.answers.map((ans, qi) => {
        if (isFreeText) {
        return `
        <div class="quiz-results-item ${ans.isCorrect ? "right" : "wrong"}" data-qi="${qi}">
            <div class="qr-q">${qi + 1}. ${escapeHtml(ans.question)}</div>
            <div class="qr-topic" style="font-size:11px;color:var(--accent);margin-bottom:6px">${escapeHtml(ans.topic || "")}</div>
            <div class="qr-answer" style="margin-bottom:8px"><strong>Your answer:</strong><br>${escapeHtml(ans.studentAnswer || "(skipped)")}</div>
            <div class="qr-answer" style="margin-bottom:8px"><strong>Model answer:</strong><br>${escapeHtml(ans.modelAnswer || "")}</div>
            <div class="qr-feedback" style="background:var(--paper);padding:10px 12px;border-radius:var(--radius-sm);font-size:13px;line-height:1.5;margin-bottom:8px">${escapeHtml(ans.feedback || "")}</div>
            <div style="font-size:11px;color:var(--ink-soft)">Score: ${Math.round(ans.score * 100)}%</div>
            ${!ans.isCorrect ? `
            <button class="btn btn-ghost follow-up-trigger" data-qi="${qi}" style="margin-top:10px;font-size:12.5px">
                Try a similar question
            </button>
            <div class="follow-up-area" data-qi="${qi}"></div>
            ` : ""}
        </div>
        `;
        }
        return `
        <div class="quiz-results-item ${ans.isCorrect ? "right" : "wrong"}" data-qi="${qi}">
            <div class="qr-q">${qi + 1}. ${escapeHtml(ans.question)}</div>
            <div class="qr-topic" style="font-size:11px;color:var(--accent);margin-bottom:6px">${escapeHtml(ans.topic || "")}</div>
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
        `;
        }).join("")}
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
    });
}

// ---------------------------------------------------------------------------
// Grading toast — compact, non-blocking notification shown while the backend
// grades free-text answers sequentially. Lives above the quiz overlay so the
// user can dismiss the overlay and keep reading while grading proceeds.
// ---------------------------------------------------------------------------
let gradingToastEl = null;

function showGradingToast(totalQuestions) {
    if (gradingToastEl) gradingToastEl.remove();
    gradingToastEl = document.createElement("div");
    gradingToastEl.className = "grading-toast";
    gradingToastEl.innerHTML = `
<span class="spinner" style="width:14px;height:14px;border:2px solid var(--hairline);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;display:inline-block;vertical-align:middle;margin-right:8px"></span>
Grading ${totalQuestions} answer${totalQuestions > 1 ? "s" : ""}… You can keep reading.
`;
    document.body.appendChild(gradingToastEl);
}

function hideGradingToast() {
    if (gradingToastEl) { gradingToastEl.remove(); gradingToastEl = null; }
}

function showGradingCompleteToast(attempt) {
    if (!gradingToastEl) return;
    const isFreeText = attempt.mode === "freeText";
    const scoreDisplay = isFreeText ? `${Math.round(attempt.score * 100)}%` : `${attempt.score} / ${attempt.total}`;
    const correctCount = isFreeText ? attempt.answers.filter((a) => a.isCorrect).length : attempt.score;
    gradingToastEl.innerHTML = `
<div style="font-weight:600;font-size:14px;margin-bottom:4px">Grading complete — ${scoreDisplay}</div>
<div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:10px">${correctCount} of ${attempt.total} correct. Weak items added to review queue.</div>
<button class="btn btn-primary" id="viewFullResultsBtn" style="width:100%">View Full Results</button>
`;
    gradingToastEl.querySelector("#viewFullResultsBtn").addEventListener("click", () => {
        hideGradingToast();
        openQuizOverlay();
        renderQuizResults();
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
