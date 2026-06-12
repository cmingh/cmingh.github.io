// js/scanner.js
// ─────────────────────────────────────────────────────────────
// Barcode scanning (camera + file upload) and media cover OCR.
//
// CHANGES vs original:
//   - Replaced ZXing with QuaggaJS (more reliable UPC/EAN/ISBN
//     detection from still images and live video).
//   - Fixed Tesseract.js v4 createWorker() — load/loadLanguage/
//     initialize calls are required in sequence.
//   - Cover-tab label + icon already driven by ui.js
//     _updateCoverTabUI(); no changes needed here.
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { toast, switchTab } from './ui.js';
import { lookupBarcode, searchBookByTitle, searchMediaByTitle } from './lookup.js';

// ── Camera state ──────────────────────────────────────────────
let _cameraStream   = null;
let _cameraRunning  = false;
let _quaggaLive     = false;   // true while Quagga is scanning live video

// ═══════════════════════════════════════════════════════════════
// QUAGGA LOADER  — lazy-load once from CDN
// ═══════════════════════════════════════════════════════════════

let _quaggaReady = false;

async function _loadQuagga() {
  if (_quaggaReady && window.Quagga) return;
  if (!window.Quagga) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src     = 'https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js';
      s.onload  = res;
      s.onerror = () => rej(new Error('Quagga CDN load failed'));
      document.head.appendChild(s);
    });
  }
  _quaggaReady = true;
}

// ═══════════════════════════════════════════════════════════════
// CAMERA — start / stop / capture
// ═══════════════════════════════════════════════════════════════

export async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera not supported in this browser', 'error');
    return;
  }

  try {
    await _loadQuagga();
  } catch (e) {
    toast('Could not load barcode library — try typing the barcode manually', 'error');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    _cameraStream = stream;

    const video = document.getElementById('camera-video');
    video.srcObject = stream;
    await video.play();

    document.getElementById('camera-container')?.classList.add('active');
    const scanDrop = document.getElementById('scan-drop');
    if (scanDrop) scanDrop.style.display = 'none';
    const controls = document.getElementById('camera-controls');
    if (controls) controls.style.display = 'flex';

    _cameraRunning = true;
    toast('Camera active — point at a barcode', 'success');
    _startQuaggaLive();
  } catch (e) {
    toast('Camera access denied or unavailable', 'error');
    console.error('Camera error:', e);
  }
}

export function stopCamera() {
  _cameraRunning  = false;

  // Stop Quagga live scanning first
  if (_quaggaLive && window.Quagga) {
    try { Quagga.stop(); } catch (_) {}
    _quaggaLive = false;
  }

  if (_cameraStream) {
    _cameraStream.getTracks().forEach(t => t.stop());
    _cameraStream = null;
  }

  const video = document.getElementById('camera-video');
  if (video) video.srcObject = null;

  document.getElementById('camera-container')?.classList.remove('active');

  const scanDrop = document.getElementById('scan-drop');
  if (scanDrop) scanDrop.style.display = '';

  const controls = document.getElementById('camera-controls');
  if (controls) controls.style.display = 'none';
}

export async function captureFrame() {
  const video = document.getElementById('camera-video');
  if (!video?.videoWidth) { toast('Camera not ready yet', 'error'); return; }

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
  const preview = document.getElementById('scan-preview-img');
  if (preview) { preview.src = dataUrl; preview.style.display = ''; }

  stopCamera();
  showScanStatus('loading', '<span class="spin">⏳</span> Reading barcode from captured frame…');
  await _decodeImageWithQuagga(dataUrl);
}

// ── Continuous Quagga scan from live video ────────────────────
function _startQuaggaLive() {
  if (!window.Quagga) return;

  // We piggy-back on the existing <video> element by using a canvas
  // tick loop instead of Quagga.init() (which would create its own
  // video element). This lets us reuse our existing camera UI.
  _quaggaLive = false; // use the frame-tick approach instead

  const video  = document.getElementById('camera-video');
  const canvas = document.createElement('canvas');
  let lastCode = null;

  const tick = async () => {
    if (!_cameraRunning || !video?.videoWidth) {
      if (_cameraRunning) requestAnimationFrame(tick);
      return;
    }

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    const code = await _quaggaDecode(dataUrl);

    if (code && code !== lastCode) {
      lastCode = code;
      _cameraRunning = false;
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

    if (_cameraRunning) {
      // ~6 fps is plenty for live scanning
      setTimeout(() => requestAnimationFrame(tick), 160);
    }
  };

  // Give video a moment to stabilise before scanning
  setTimeout(() => requestAnimationFrame(tick), 600);
}

// ═══════════════════════════════════════════════════════════════
// BARCODE FILE UPLOAD
// ═══════════════════════════════════════════════════════════════

export function handleScanDrop(e) {
  e.preventDefault();
  document.getElementById('scan-drop')?.classList.remove('drag-over');
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
    if (img) { img.src = ev.target.result; img.style.display = ''; }
    _state.editingItem._coverData = null;
    showScanStatus('loading', '<span class="spin">⏳</span> Reading barcode with QuaggaJS…');
    _decodeImageWithQuagga(ev.target.result);
  };
  reader.readAsDataURL(file);
}

// ── Core Quagga decode (static image) ────────────────────────
async function _decodeImageWithQuagga(dataUrl) {
  try {
    await _loadQuagga();
  } catch (_) {
    showScanStatus('no-match', '⚠ Barcode library failed to load. Type the barcode manually below.');
    return;
  }

  const code = await _quaggaDecode(dataUrl);

  if (code) {
    const manualEl = document.getElementById('barcode-manual');
    if (manualEl) manualEl.value = code;

    showScanStatus('matched',
      `<strong>✓ Barcode detected:</strong> <span class="mono" style="color:var(--accent)">${code}</span>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">Looking up item details…</span>`
    );
    toast('Barcode read: ' + code, 'success');

    try {
      await Promise.race([
        lookupBarcode(code),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
      ]);
    } catch (err) {
      showScanStatus('no-match',
        `<strong>⚠ Lookup timed out for <span class="mono">${code}</span>.</strong>
         <br><span style="color:var(--text2);font-size:12px">Try typing it manually below.</span>`
      );
    }
  } else {
    showScanStatus('no-match',
      `<strong>⚠ No barcode found in this photo.</strong>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:6px">
         Tips: ensure the barcode is in focus, well-lit, and fills most of the frame.
         <br>Try the <strong>Cover Search</strong> tab, or type the barcode manually below.
       </span>`
    );
  }
}

// Promise wrapper around Quagga.decodeSingle
function _quaggaDecode(dataUrl) {
  return new Promise(resolve => {
    if (!window.Quagga) { resolve(null); return; }

    // Try multiple reader types for maximum barcode format coverage
    const readers = [
      'ean_reader',       // EAN-13 / EAN-8 (international retail)
      'upc_reader',       // UPC-A / UPC-E (North American retail)
      'upc_e_reader',
      'ean_8_reader',
      'code_128_reader',  // ISBN / generic
      'code_39_reader',
      'i2of5_reader',
    ];

    let resolved = false;
    const done = val => { if (!resolved) { resolved = true; resolve(val); } };

    // Safety: resolve null after 5 s so the caller never hangs
    setTimeout(() => done(null), 5000);

    Quagga.decodeSingle(
      {
        src: dataUrl,
        numOfWorkers: 0,          // synchronous in same thread (required for data URLs)
        locate: true,
        inputStream: { size: 1200 },
        decoder: { readers, multiple: false },
      },
      result => {
        const code = result?.codeResult?.code || null;
        done(code);
      }
    );
  });
}

// ═══════════════════════════════════════════════════════════════
// COVER SCAN — file upload → OCR → title search
// ═══════════════════════════════════════════════════════════════

export function handleCoverScanDrop(e) {
  e.preventDefault();
  document.getElementById('cover-drop')?.classList.remove('drag-over');
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
    if (img) {
      img.src = ev.target.result;
      img.style.display = '';
      img.onload = () => {
        if (_state.editingItem) _state.editingItem._coverData = ev.target.result;
        showCoverScanStatus('loading', '<span class="spin">⏳</span> Extracting text from cover image…');
        _extractTextFromCoverImage(ev.target.result);
      };
    } else {
      if (_state.editingItem) _state.editingItem._coverData = ev.target.result;
      showCoverScanStatus('loading', '<span class="spin">⏳</span> Extracting text from cover image…');
      _extractTextFromCoverImage(ev.target.result);
    }
  };
  reader.readAsDataURL(file);
}

// ── OCR via Tesseract.js v4 (lazy-loaded from CDN) ───────────
async function _extractTextFromCoverImage(dataUrl) {
  let worker = null;
  try {
    // Lazy-load Tesseract.js v4 once
    if (!window.Tesseract) {
      showCoverScanStatus('loading', '<span class="spin">⏳</span> Loading OCR engine…');
      await new Promise((res, rej) => {
        const s   = document.createElement('script');
        s.src     = 'https://unpkg.com/tesseract.js@4.0.2/dist/tesseract.min.js';
        s.onload  = res;
        s.onerror = () => rej(new Error('Tesseract CDN load failed'));
        document.head.appendChild(s);
      });
    }

    showCoverScanStatus('loading', '<span class="spin">⏳</span> Running OCR… (this may take a moment)');

    // ── Tesseract v4 worker lifecycle ─────────────────────────
    // v4 requires: createWorker → load → loadLanguage → initialize → recognize
    worker = await Tesseract.createWorker({
      workerPath: 'https://unpkg.com/tesseract.js@4.0.2/dist/worker.min.js',
      corePath:   'https://unpkg.com/tesseract.js-core@4.0.2/tesseract-core.wasm.js',
      langPath:   'https://tessdata.projectnaptha.com/4.0.0',
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round((m.progress || 0) * 100);
          showCoverScanStatus('loading', `<span class="spin">⏳</span> Recognizing text… ${pct}%`);
        }
      },
    });

    await worker.load();
    await worker.loadLanguage('eng');
    await worker.initialize('eng');

    // Wrap recognize in a 30-second timeout
    const ocrResult = await Promise.race([
      worker.recognize(dataUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), 30000)),
    ]);

    const rawText = ocrResult?.data?.text || '';

    await worker.terminate();
    worker = null;

    if (!rawText.trim()) {
      showCoverScanStatus('info',
        `<strong>ℹ OCR found no readable text.</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a clearer photo with better lighting, or type the title below.</span>`
      );
      return;
    }

    // Filter lines: keep lines with at least 3 real alphabetic characters
    const lines = rawText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && /[a-zA-Z]{3,}/.test(l));

    if (!lines.length) {
      showCoverScanStatus('info',
        `<strong>ℹ OCR found no readable text.</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a clearer photo with better lighting, or type the title below.</span>`
      );
      return;
    }

    // Pick the longest line from the top 4 — cover titles tend to be the biggest text
    const candidate = lines.slice(0, 4).sort((a, b) => b.length - a.length)[0];

    const titleInput = document.getElementById('cover-title-input');
    if (titleInput) titleInput.value = candidate;

    showCoverScanStatus('matched',
      `<strong>✓ Text detected:</strong> "${candidate}"
       <br><span style="font-size:12px;color:var(--text2);display:block;margin-top:4px">Searching…</span>`
    );

    // Use the right search for the selected media type
    searchMediaByTitle(candidate);

  } catch (ocrErr) {
    if (worker) { try { await worker.terminate(); } catch (_) {} }
    console.warn('OCR failed:', ocrErr);
    showCoverScanStatus('info',
      `<strong>ℹ OCR engine unavailable.</strong>
       <br><span style="font-size:12px;color:var(--text2)">
         Type the title or artist below and click Search.
       </span>`
    );
  }
}

// ── Scan-status helpers ───────────────────────────────────────
export function showScanStatus(type, html) {
  const el = document.getElementById('scan-result');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = `<div class="scan-status-box ${type}">${html}</div>`;
}

export function showCoverScanStatus(type, html) {
  const el = document.getElementById('cover-scan-result');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = `<div class="scan-status-box ${type}">${html}</div>`;
}

// ── Bind to global scope for index.html inline handlers ───────
window.handleScanDrop      = handleScanDrop;
window.handleScanFile      = handleScanFile;
window.handleCoverScanDrop = handleCoverScanDrop;
window.handleCoverScanFile = handleCoverScanFile;