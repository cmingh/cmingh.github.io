// js/scanner.js  (v3 — robust multi-engine barcode detection)
// ─────────────────────────────────────────────────────────────
// Decode pipeline for static images:
//   1. Native BarcodeDetector  (Chrome/Edge 83+, Android WebView)
//   2. ZXing via blob URL      (decodeFromImageUrl — the reliable path)
//   3. ZXing multi-attempt     (preprocessed crops, contrast, threshold)
//
// Live camera:
//   1. Native BarcodeDetector per-frame
//   2. ZXing canvas fallback per-frame
//
// Cover OCR:
//   Tesseract.js v4 with correct load/loadLanguage/initialize sequence.
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { toast, switchTab } from './ui.js';
import { lookupBarcode, searchBookByTitle, searchMediaByTitle } from './lookup.js';

// ── Camera state ──────────────────────────────────────────────
let _cameraStream  = null;
let _cameraRunning = false;

// ── ZXing reader singleton ────────────────────────────────────
let _zxingReader   = null;    // BrowserMultiFormatReader instance
let _zxingLoaded   = false;

// ─────────────────────────────────────────────────────────────
// ZXing loader  — we keep the existing script tag from index.html
// (ZXing 0.19.1 UMD) but use decodeFromImageUrl instead of
// decodeFromCanvas to get reliable decoding.
// ─────────────────────────────────────────────────────────────
async function _getZxingReader() {
  if (_zxingReader) return _zxingReader;

  // ZXing may already be loaded from the index.html <script> tag
  if (!window.ZXing) {
    await new Promise((res, rej) => {
      const s   = document.createElement('script');
      s.src     = 'https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js';
      s.onload  = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  const hints = new Map();
  // TRY_HARDER is essential for real-world photos
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  // All 1-D retail formats
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
    ZXing.BarcodeFormat.CODE_128,
    ZXing.BarcodeFormat.CODE_39,
    ZXing.BarcodeFormat.ITF,
  ]);

  _zxingReader = new ZXing.BrowserMultiFormatReader(hints);
  _zxingLoaded = true;
  return _zxingReader;
}

// ─────────────────────────────────────────────────────────────
// MASTER DECODE — tries every engine in order
// Returns the barcode string or null.
// ─────────────────────────────────────────────────────────────
async function _decodeBarcodeFromDataUrl(dataUrl) {

  // ── Engine 1: Native BarcodeDetector ─────────────────────
  // Fastest, most reliable when available (Chrome/Edge 83+, Android)
  if (window.BarcodeDetector) {
    try {
      const detector = new BarcodeDetector({
        formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf'],
      });
      const img    = await _dataUrlToImage(dataUrl);
      const bitmap = await createImageBitmap(img);
      const codes  = await detector.detect(bitmap);
      bitmap.close();
      if (codes?.length) {
        console.log('[scanner] BarcodeDetector hit:', codes[0].rawValue);
        return codes[0].rawValue;
      }
    } catch (e) {
      console.warn('[scanner] BarcodeDetector failed:', e.message);
    }
  }

  // ── Engine 2: ZXing via blob URL (most reliable ZXing path) ──
  // decodeFromImageUrl works correctly; decodeFromCanvas does NOT
  // reliably in many browser/ZXing version combinations.
  let blobUrl = null;
  try {
    const reader = await _getZxingReader();
    blobUrl = await _dataUrlToBlobUrl(dataUrl);
    const result = await Promise.race([
      reader.decodeFromImageUrl(blobUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ZXing timeout')), 6000)),
    ]);
    if (result?.getText()) {
      console.log('[scanner] ZXing blob URL hit:', result.getText());
      return result.getText();
    }
  } catch (e) {
    if (!e.message?.includes('No MultiFormat') && !e.message?.includes('timeout')) {
      console.warn('[scanner] ZXing blob URL error:', e.message);
    }
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }

  // ── Engine 3: ZXing multi-attempt with preprocessing ─────
  // For real-world photos: try different crops, contrast boost,
  // binarization, and upscaling to find the barcode.
  try {
    const result = await _zxingMultiAttempt(dataUrl);
    if (result) {
      console.log('[scanner] ZXing multi-attempt hit:', result);
      return result;
    }
  } catch (e) {
    console.warn('[scanner] ZXing multi-attempt error:', e.message);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// ZXing multi-attempt — tries preprocessed canvas variants
// ─────────────────────────────────────────────────────────────
async function _zxingMultiAttempt(dataUrl) {
  const reader = await _getZxingReader();
  const img    = await _dataUrlToImage(dataUrl);
  const W = img.naturalWidth, H = img.naturalHeight;

  // Regions to try: [x, y, w, h] as fractions of image dimensions
  const regions = [
    [0,   0,   1,   1  ],  // full image
    [0,   0.5, 1,   0.5],  // bottom half  (most barcodes on back covers)
    [0,   0.6, 0.5, 0.4],  // bottom-left
    [0.5, 0.6, 0.5, 0.4],  // bottom-right
    [0.1, 0.1, 0.8, 0.8],  // center crop
    [0,   0.7, 1,   0.3],  // bottom strip
  ];

  // Preprocessing modes applied to each region
  const modes = ['original', 'contrast', 'threshold'];

  for (const [rx, ry, rw, rh] of regions) {
    for (const mode of modes) {
      const canvas = _buildProcessedCanvas(img, W, H, rx, ry, rw, rh, mode);
      // Try at 1× and 2× scale for small/low-res barcodes
      for (const scale of [1, 2]) {
        let blobUrl2 = null;
        try {
          const scaled = _scaleCanvas(canvas, scale);
          blobUrl2 = await _canvasToBlobUrl(scaled);
          const result = await Promise.race([
            reader.decodeFromImageUrl(blobUrl2),
            new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), 3000)),
          ]);
          if (result?.getText()) return result.getText();
        } catch (_) { /* try next */ }
        finally { if (blobUrl2) URL.revokeObjectURL(blobUrl2); }
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Canvas preprocessing helpers
// ─────────────────────────────────────────────────────────────

function _buildProcessedCanvas(img, W, H, rx, ry, rw, rh, mode) {
  const sw = Math.round(W * rw), sh = Math.round(H * rh);
  const sx = Math.round(W * rx), sy = Math.round(H * ry);

  const canvas = document.createElement('canvas');
  canvas.width  = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');

  // Draw the selected region
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  if (mode === 'original') return canvas;

  const imageData = ctx.getImageData(0, 0, sw, sh);
  const data      = imageData.data;

  if (mode === 'contrast') {
    // Convert to grayscale + stretch histogram
    let minL = 255, maxL = 0;
    for (let i = 0; i < data.length; i += 4) {
      const g = Math.round(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
      if (g < minL) minL = g;
      if (g > maxL) maxL = g;
    }
    const range = maxL - minL || 1;
    for (let i = 0; i < data.length; i += 4) {
      const g  = Math.round(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
      const gs = Math.round(((g - minL) / range) * 255);
      data[i] = data[i+1] = data[i+2] = gs;
    }
  } else if (mode === 'threshold') {
    // Otsu-like binarization — great for crisp barcode lines
    const hist = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const g = Math.round(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
      hist[g]++;
    }
    const total = sw * sh;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) ** 2;
      if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
    }
    for (let i = 0; i < data.length; i += 4) {
      const g  = Math.round(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
      const bw = g > threshold ? 255 : 0;
      data[i] = data[i+1] = data[i+2] = bw;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function _scaleCanvas(src, scale) {
  if (scale === 1) return src;
  const dst = document.createElement('canvas');
  dst.width  = src.width  * scale;
  dst.height = src.height * scale;
  const ctx  = dst.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return dst;
}

// ─────────────────────────────────────────────────────────────
// URL / Image helpers
// ─────────────────────────────────────────────────────────────

function _dataUrlToImage(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error('Image load failed'));
    img.src     = dataUrl;
  });
}

function _dataUrlToBlobUrl(dataUrl) {
  return new Promise((res, rej) => {
    try {
      const [header, b64] = dataUrl.split(',');
      const mime = header.match(/:(.*?);/)[1];
      const bin  = atob(b64);
      const arr  = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: mime });
      res(URL.createObjectURL(blob));
    } catch (e) { rej(e); }
  });
}

function _canvasToBlobUrl(canvas) {
  return new Promise((res, rej) => {
    canvas.toBlob(blob => {
      if (!blob) { rej(new Error('toBlob failed')); return; }
      res(URL.createObjectURL(blob));
    }, 'image/png');
  });
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: decode a data URL and trigger lookup
// ─────────────────────────────────────────────────────────────
async function _decodeAndLookup(dataUrl) {
  showScanStatus('loading', '<span class="spin">⏳</span> Scanning barcode (trying multiple methods)…');

  const code = await _decodeBarcodeFromDataUrl(dataUrl);

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
    } catch (_) {
      showScanStatus('no-match',
        `<strong>⚠ Lookup timed out for <span class="mono">${code}</span>.</strong>
         <br><span style="color:var(--text2);font-size:12px">The barcode was read correctly — try typing it in the field below and pressing Look up.</span>`
      );
    }
  } else {
    showScanStatus('no-match',
      `<strong>⚠ No barcode found in this photo.</strong>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:6px">
         Tips: ensure the barcode is in focus, well-lit, and not at a steep angle.
         <br>You can also type the number printed below the barcode in the field below.
       </span>`
    );
  }
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
    _startLiveScan();
  } catch (e) {
    toast('Camera access denied or unavailable', 'error');
    console.error('Camera error:', e);
  }
}

export function stopCamera() {
  _cameraRunning = false;

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
  await _decodeAndLookup(dataUrl);
}

// ── Live scan loop ────────────────────────────────────────────
function _startLiveScan() {
  const video  = document.getElementById('camera-video');
  const canvas = document.createElement('canvas');

  // Prefer native BarcodeDetector for live video (much faster)
  const useNative = !!window.BarcodeDetector;
  let detector   = null;
  let zxingReader = null;

  (async () => {
    if (useNative) {
      try {
        detector = new BarcodeDetector({
          formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf'],
        });
      } catch (_) { /* fallback to ZXing below */ }
    }
    if (!detector) {
      try { zxingReader = await _getZxingReader(); } catch (_) {}
    }
  })();

  const tick = async () => {
    if (!_cameraRunning || !video?.videoWidth) {
      if (_cameraRunning) setTimeout(() => requestAnimationFrame(tick), 100);
      return;
    }

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    let code = null;

    try {
      if (detector) {
        const bitmap = await createImageBitmap(canvas);
        const codes  = await detector.detect(bitmap);
        bitmap.close();
        if (codes?.length) code = codes[0].rawValue;
      } else if (zxingReader) {
        let blobUrl3 = null;
        try {
          blobUrl3 = await _canvasToBlobUrl(canvas);
          const r  = await Promise.race([
            zxingReader.decodeFromImageUrl(blobUrl3),
            new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), 800)),
          ]);
          code = r?.getText() || null;
        } catch (_) {} finally { if (blobUrl3) URL.revokeObjectURL(blobUrl3); }
      }
    } catch (_) {}

    if (code) {
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

    if (_cameraRunning) setTimeout(() => requestAnimationFrame(tick), 200); // ~5 fps
  };

  setTimeout(() => requestAnimationFrame(tick), 800); // let video stabilise
}

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD HANDLERS
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
  reader.onload = async ev => {
    const dataUrl = ev.target.result;
    const img = document.getElementById('scan-preview-img');
    if (img) { img.src = dataUrl; img.style.display = ''; }
    _state.editingItem._coverData = null;
    const resultEl = document.getElementById('scan-result');
    if (resultEl) resultEl.style.display = '';
    await _decodeAndLookup(dataUrl);
  };
  reader.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════════════════
// COVER SCAN — file upload → OCR → title/artist search
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
    const dataUrl = ev.target.result;
    const img = document.getElementById('cover-scan-preview');
    if (img) {
      img.src = dataUrl;
      img.style.display = '';
      img.onload = () => {
        if (_state.editingItem) _state.editingItem._coverData = dataUrl;
        showCoverScanStatus('loading', '<span class="spin">⏳</span> Extracting text from cover image…');
        _extractTextFromCoverImage(dataUrl);
      };
    } else {
      if (_state.editingItem) _state.editingItem._coverData = dataUrl;
      showCoverScanStatus('loading', '<span class="spin">⏳</span> Extracting text from cover image…');
      _extractTextFromCoverImage(dataUrl);
    }
  };
  reader.readAsDataURL(file);
}

// ── OCR via Tesseract.js v4 ───────────────────────────────────
async function _extractTextFromCoverImage(dataUrl) {
  let worker = null;
  try {
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

    showCoverScanStatus('loading', '<span class="spin">⏳</span> Running OCR… (may take a moment)');

    // Tesseract v4: createWorker → load → loadLanguage → initialize → recognize
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

    const ocrResult = await Promise.race([
      worker.recognize(dataUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), 30000)),
    ]);

    await worker.terminate();
    worker = null;

    const rawText = ocrResult?.data?.text || '';

    if (!rawText.trim()) {
      showCoverScanStatus('info',
        `<strong>ℹ OCR found no readable text.</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a clearer photo, or type the title below.</span>`
      );
      return;
    }

    const lines = rawText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && /[a-zA-Z]{3,}/.test(l));

    if (!lines.length) {
      showCoverScanStatus('info',
        `<strong>ℹ OCR found no readable text.</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a clearer photo, or type the title below.</span>`
      );
      return;
    }

    const candidate = lines.slice(0, 4).sort((a, b) => b.length - a.length)[0];
    const titleInput = document.getElementById('cover-title-input');
    if (titleInput) titleInput.value = candidate;

    showCoverScanStatus('matched',
      `<strong>✓ Text detected:</strong> "${candidate}"
       <br><span style="font-size:12px;color:var(--text2);display:block;margin-top:4px">Searching…</span>`
    );

    searchMediaByTitle(candidate);

  } catch (ocrErr) {
    if (worker) { try { await worker.terminate(); } catch (_) {} }
    console.warn('OCR failed:', ocrErr);
    showCoverScanStatus('info',
      `<strong>ℹ OCR unavailable.</strong>
       <br><span style="font-size:12px;color:var(--text2)">
         Type the title or artist below and press Search.
       </span>`
    );
  }
}

// ── Status helpers ────────────────────────────────────────────
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

// Bind globals for index.html inline handlers
window.handleScanDrop      = handleScanDrop;
window.handleScanFile      = handleScanFile;
window.handleCoverScanDrop = handleCoverScanDrop;
window.handleCoverScanFile = handleCoverScanFile;