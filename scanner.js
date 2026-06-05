// js/scanner.js
// ─────────────────────────────────────────────────────────────
// Barcode scanning (camera + file upload) and book cover OCR.
// Uses ZXing 0.19.x (BrowserMultiFormatReader) for barcodes
// and Tesseract.js (lazy-loaded) for cover text extraction.
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { toast, switchTab } from './ui.js';
import { lookupBarcode } from './lookup.js';
import { MEDIA_TYPES } from './state.js';
import { buildManualForm } from './forms.js';
import { searchBookByTitle, applyCoverSearchResult } from './lookup.js';

// ── Camera state ──────────────────────────────────────────────
let _cameraStream   = null;
let _cameraScanning = false;

// ═══════════════════════════════════════════════════════════════
// CAMERA — start / stop / capture
// ═══════════════════════════════════════════════════════════════

export async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera not supported in this browser', 'error');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    _cameraStream = stream;

    const video = document.getElementById('camera-video');
    video.srcObject = stream;
    await video.play();

    document.getElementById('camera-container').classList.add('active');
    document.getElementById('scan-drop').style.display = 'none';
    document.getElementById('camera-controls').style.display = 'flex';

    toast('Camera active — point at a barcode and capture', 'success');
    _startContinuousZXingScan();

  } catch (e) {
    toast('Camera access denied or unavailable', 'error');
    console.error('Camera error:', e);
  }
}

export function stopCamera() {
  _cameraScanning = false;

  if (_cameraStream) {
    _cameraStream.getTracks().forEach(t => t.stop());
    _cameraStream = null;
  }

  const video = document.getElementById('camera-video');
  if (video) video.srcObject = null;

  const container = document.getElementById('camera-container');
  if (container) container.classList.remove('active');

  const drop = document.getElementById('scan-drop');
  if (drop) drop.style.display = '';

  const controls = document.getElementById('camera-controls');
  if (controls) controls.style.display = 'none';
}

// Capture a still frame from the live video and decode it
export async function captureFrame() {
  const video = document.getElementById('camera-video');
  if (!video.videoWidth) { toast('Camera not ready yet', 'error'); return; }

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const preview = document.getElementById('scan-preview-img');
  preview.src = dataUrl;
  preview.style.display = '';

  stopCamera();
  showScanStatus('loading', '<span class="spin">⏳</span> Reading barcode from captured frame…');
  await _runZXingOnDataUrl(dataUrl);
}

// ── Continuous ZXing scan from live video frames ───────────────
function _startContinuousZXingScan() {
  if (!window.ZXing) return;
  _cameraScanning = true;

  const codeReader = new ZXing.BrowserMultiFormatReader();
  const video  = document.getElementById('camera-video');
  const canvas = document.createElement('canvas');

  const tick = async () => {
    if (!_cameraScanning || !video.videoWidth) {
      if (_cameraScanning) requestAnimationFrame(tick);
      return;
    }

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    try {
      // decodeFromCanvas is the correct API in ZXing 0.19.x
      const result = codeReader.decodeFromCanvas(canvas);
      if (result) {
        const code = result.getText();
        _cameraScanning = false;
        stopCamera();

        const manualEl = document.getElementById('barcode-manual');
        if (manualEl) manualEl.value = code;

        showScanStatus('matched',
          `<strong>✓ Barcode detected:</strong> <span class="mono" style="color:var(--accent)">${code}</span>
           <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">Looking up item details…</span>`
        );
        toast('Barcode read: ' + code, 'success');
        lookupBarcode(code);
        return;
      }
    } catch (_) { /* no barcode in this frame — keep scanning */ }

    if (_cameraScanning) setTimeout(tick, 200);
  };

  setTimeout(tick, 500); // give video stream a moment to stabilise
}

// ═══════════════════════════════════════════════════════════════
// BARCODE FILE UPLOAD
// ═══════════════════════════════════════════════════════════════

export function handleScanDrop(e) {
  e.preventDefault();
  document.getElementById('scan-drop').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) processScanFile(file);
  else toast('Please drop an image file', 'error');
}

export function handleScanFile(e) {
  const f = e.target.files[0];
  if (f) processScanFile(f);
}

export function processScanFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    const img = document.getElementById('scan-preview-img');
    img.src = ev.target.result;
    img.style.display = '';
    _state.editingItem._coverData = null;
    showScanStatus('loading', '<span class="spin">⏳</span> Reading barcode with ZXing…');
    _runZXingOnDataUrl(ev.target.result);
  };
  reader.readAsDataURL(file);
}

// ── Core ZXing decode — loads image onto canvas then decodes ───
async function _runZXingOnDataUrl(dataUrl) {
  if (!window.ZXing) {
    showScanStatus('no-match', '⚠ ZXing library not loaded. Type the barcode manually below.');
    return;
  }

  try {
    // 1. Load image element (needed by ZXing fallback path)
    const image = new Image();
    await new Promise((res, rej) => {
      image.onload  = res;
      image.onerror = rej;
      image.src     = dataUrl;
    });

    // 2. Draw to offscreen canvas
    const canvas = document.createElement('canvas');
    canvas.width  = image.naturalWidth  || image.width;
    canvas.height = image.naturalHeight || image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);

    const codeReader = new ZXing.BrowserMultiFormatReader();
    let code;

    try {
      // Primary: canvas decode (fastest, most compatible with 0.19.x)
      const result = codeReader.decodeFromCanvas(canvas);
      code = result.getText();
    } catch (_) {
      // Fallback: decode from the image URL directly
      const result = await codeReader.decodeFromImage(undefined, dataUrl);
      code = result.getText();
    }

    const manualEl = document.getElementById('barcode-manual');
    if (manualEl) manualEl.value = code;

    showScanStatus('matched',
      `<strong>✓ Barcode detected:</strong> <span class="mono" style="color:var(--accent)">${code}</span>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">Looking up item details…</span>`
    );
    toast('Barcode read: ' + code, 'success');
    lookupBarcode(code);

  } catch (err) {
    showScanStatus('no-match',
      `<strong>⚠ No barcode found in this photo.</strong>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:6px">
         Tips: ensure the barcode is in focus, well-lit, and fills most of the frame.
         <br>Try the <strong>Book Cover Scan</strong> tab, or type the number manually below.
       </span>`
    );
  }
}

// ── Status display helpers ─────────────────────────────────────
export function showScanStatus(type, html) {
  const el = document.getElementById('scan-result');
  el.style.display = '';
  el.innerHTML = `<div class="scan-status-box ${type}">${html}</div>`;
}

export function showCoverScanStatus(type, html) {
  const el = document.getElementById('cover-scan-result');
  el.style.display = '';
  el.innerHTML = `<div class="scan-status-box ${type}">${html}</div>`;
}

// ═══════════════════════════════════════════════════════════════
// BOOK COVER SCAN — file upload → OCR → title search
// ═══════════════════════════════════════════════════════════════

export function handleCoverScanDrop(e) {
  e.preventDefault();
  document.getElementById('cover-drop').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) processCoverScanFile(file);
  else toast('Please drop an image file', 'error');
}

export function handleCoverScanFile(e) {
  const f = e.target.files[0];
  if (f) processCoverScanFile(f);
}

export function processCoverScanFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    const img = document.getElementById('cover-scan-preview');
    img.src = ev.target.result;
    img.style.display = '';
    _state.editingItem._coverData = ev.target.result;
    showCoverScanStatus('loading', '<span class="spin">⏳</span> Extracting text from cover image…');
    _extractTextFromCoverImage(ev.target.result);
  };
  reader.readAsDataURL(file);
}

// ── OCR via Tesseract.js (lazy-loaded from CDN) ────────────────
async function _extractTextFromCoverImage(dataUrl) {
  try {
    // Lazy-load Tesseract.js
    if (!window.Tesseract) {
      showCoverScanStatus('loading', '<span class="spin">⏳</span> Loading OCR engine…');
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src     = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
        s.onload  = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    showCoverScanStatus('loading', '<span class="spin">⏳</span> Running OCR on cover image… (this may take a moment)');

    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round((m.progress || 0) * 100);
          showCoverScanStatus('loading', `<span class="spin">⏳</span> Recognizing text… ${pct}%`);
        }
      },
    });

    const { data: { text } } = await worker.recognize(dataUrl);
    await worker.terminate();

    // Filter to lines that look like real words (not pure numbers/punctuation)
    const lines = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && !/^[\d\s\W]+$/.test(l));

    if (lines.length === 0) {
      showCoverScanStatus('info',
        `<strong>ℹ OCR found no readable text.</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a clearer photo, or type the title below.</span>`
      );
      return;
    }

    const candidate = lines[0];
    const titleInput = document.getElementById('cover-title-input');
    if (titleInput) titleInput.value = candidate;

    showCoverScanStatus('matched',
      `<strong>✓ Text detected:</strong> "${candidate}"
       <br><span style="font-size:12px;color:var(--text2);display:block;margin-top:4px">Searching Open Library…</span>`
    );
    searchBookByTitle(candidate);

  } catch (ocrErr) {
    console.warn('OCR failed:', ocrErr);
    showCoverScanStatus('info',
      `<strong>ℹ OCR engine unavailable.</strong>
       <br><span style="font-size:12px;color:var(--text2)">
         Type the title or author in the box below and click Search.
       </span>`
    );
  }
}