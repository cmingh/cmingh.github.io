// js/scanner.js
// ─────────────────────────────────────────────────────────────
// Barcode scanning (camera + file upload) and book cover OCR.
// Uses ZXing 0.19.x (BrowserMultiFormatReader) for barcodes.
// Tesseract.js is lazy-loaded from CDN for cover OCR.
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { toast, switchTab } from './ui.js';
import { lookupBarcode, searchBookByTitle } from './lookup.js';

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

    document.getElementById('camera-container')?.classList.add('active');
    const scanDrop = document.getElementById('scan-drop');
    if (scanDrop) scanDrop.style.display = 'none';
    const controls = document.getElementById('camera-controls');
    if (controls) controls.style.display = 'flex';

    toast('Camera active — point at a barcode', 'success');
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

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const preview = document.getElementById('scan-preview-img');
  if (preview) { preview.src = dataUrl; preview.style.display = ''; }

  stopCamera();
  showScanStatus('loading', '<span class="spin">⏳</span> Reading barcode from captured frame…');
  await _runZXingOnDataUrl(dataUrl);
}

// ── Continuous ZXing scan from live video ─────────────────────
function _startContinuousZXingScan() {
  if (!window.ZXing) return;
  _cameraScanning = true;

  const codeReader = new ZXing.BrowserMultiFormatReader();
  const video  = document.getElementById('camera-video');
  const canvas = document.createElement('canvas');

  const tick = async () => {
    if (!_cameraScanning || !video?.videoWidth) {
      if (_cameraScanning) requestAnimationFrame(tick);
      return;
    }
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    try {
      // FIX: use decodeFromCanvas — the correct synchronous API in ZXing 0.19.x
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
        // FIX: call the directly-imported lookupBarcode, not window.lookupBarcode
        // (window version may not be set yet when this closure first forms)
        lookupBarcode(code);
        return;
      }
    } catch (_) { /* no barcode in this frame — keep scanning */ }

    if (_cameraScanning) setTimeout(tick, 200);
  };

  setTimeout(tick, 500); // give video a moment to stabilise
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
    showScanStatus('loading', '<span class="spin">⏳</span> Reading barcode with ZXing…');
    _runZXingOnDataUrl(ev.target.result);
  };
  reader.readAsDataURL(file);
}

// ── Bind Barcode functions to Window Global Scope so index.html can call them ──
window.handleScanDrop = handleScanDrop;
window.handleScanFile = handleScanFile;


// ═══════════════════════════════════════════════════════════════
// BOOK COVER SCAN — file upload → OCR → title search
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
    if (img) { img.src = ev.target.result; img.style.display = ''; }
    _state.editingItem._coverData = ev.target.result;
    showCoverScanStatus('loading', '<span class="spin">⏳</span> Extracting text from cover image…');
    _extractTextFromCoverImage(ev.target.result);
  };
  reader.readAsDataURL(file);
}

// ── Bind Book Cover functions to Window Global Scope so index.html can call them ──
window.handleCoverScanDrop = handleCoverScanDrop;
window.handleCoverScanFile = handleCoverScanFile;

// ── OCR via Tesseract.js (lazy-loaded from CDN) ───────────────
async function _extractTextFromCoverImage(dataUrl) {
  try {
    if (!window.Tesseract) {
      showCoverScanStatus('loading', '<span class="spin">⏳</span> Loading OCR engine…');
      await new Promise((res, rej) => {
        const s   = document.createElement('script');
        s.src     = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
        s.onload  = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    showCoverScanStatus('loading', '<span class="spin">⏳</span> Running OCR… (this may take a moment)');

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

    // Keep lines that look like real words (not pure numbers/punctuation)
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

    const candidate   = lines[0];
    const titleInput  = document.getElementById('cover-title-input');
    if (titleInput) titleInput.value = candidate;

    showCoverScanStatus('matched',
      `<strong>✓ Text detected:</strong> "${candidate}"
       <br><span style="font-size:12px;color:var(--text2);display:block;margin-top:4px">Searching Open Library…</span>`
    );
    // FIX: call directly-imported searchBookByTitle
    searchBookByTitle(candidate);

  } catch (ocrErr) {
    console.warn('OCR failed:', ocrErr);
    showCoverScanStatus('info',
      `<strong>ℹ OCR engine unavailable.</strong>
       <br><span style="font-size:12px;color:var(--text2)">
         Type the title or author below and click Search.
       </span>`
    );
  }
}