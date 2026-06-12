// js/scanner.js  (v5 — fixed timeout handling for barcode lookup)
// ─────────────────────────────────────────────────────────────
// Decode pipeline for static images:
//   1. zxing-wasm  (ZXing C++ compiled to WebAssembly — same engine as
//                  onlinebarcodereader.com; most reliable browser decoder)
//   2. Native BarcodeDetector  (Chrome/Edge 83+, Android WebView)
//
// Live camera:
//   1. Native BarcodeDetector per-frame (fastest when available)
//   2. zxing-wasm per-frame fallback
//
// Cover OCR:
//   Tesseract.js v4 with correct load/loadLanguage/initialize sequence.
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { toast, switchTab } from './ui.js';
import { lookupBarcode, searchMediaByTitle } from './lookup.js';

// ── Camera state ──────────────────────────────────────────────
let _cameraStream  = null;
let _cameraRunning = false;

// ── zxing-wasm state ──────────────────────────────────────────
let _zxingWasmReady = false;
let _zxingWasmLoading = false;
let _zxingWasmLoadCallbacks = [];

// ─────────────────────────────────────────────────────────────
// zxing-wasm loader
// Uses the IIFE CDN build which exposes window.ZXingWASM.
// The .wasm binary is served from the same CDN automatically.
// ─────────────────────────────────────────────────────────────
async function _ensureZxingWasm() {
  if (_zxingWasmReady) return true;

  // If already loading, wait for it
  if (_zxingWasmLoading) {
    return new Promise(resolve => _zxingWasmLoadCallbacks.push(resolve));
  }

  _zxingWasmLoading = true;

  try {
    await new Promise((res, rej) => {
      // Load the IIFE reader build — exposes window.ZXingWASM
      const s = document.createElement('script');
      // Version 3.x IIFE reader bundle — ~830 KB wasm, full C++ accuracy
      s.src = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.0.2/dist/iife/reader/index.js';
      s.onload = res;
      s.onerror = () => {
        // Fallback to unpkg if jsdelivr is slow
        const s2 = document.createElement('script');
        s2.src = 'https://unpkg.com/zxing-wasm@3.0.2/dist/iife/reader/index.js';
        s2.onload = res;
        s2.onerror = () => rej(new Error('zxing-wasm CDN load failed'));
        document.head.appendChild(s2);
      };
      document.head.appendChild(s);
    });

    // Verify the global is available
    if (!window.ZXingWASM?.readBarcodesFromImageFile) {
      throw new Error('ZXingWASM global not found after script load');
    }

    _zxingWasmReady = true;
    _zxingWasmLoadCallbacks.forEach(cb => cb(true));
    _zxingWasmLoadCallbacks = [];
    console.log('[scanner] zxing-wasm loaded successfully');
    return true;
  } catch (e) {
    console.error('[scanner] zxing-wasm load failed:', e.message);
    _zxingWasmLoadCallbacks.forEach(cb => cb(false));
    _zxingWasmLoadCallbacks = [];
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Read options for zxing-wasm — covers all common retail formats
// ─────────────────────────────────────────────────────────────
const ZXING_READ_OPTIONS = {
  formats: [
    'EAN-13', 'EAN-8', 'UPC-A', 'UPC-E',
    'Code128', 'Code39', 'Code93',
    'ITF', 'Codabar',
    'DataMatrix', 'QRCode', 'PDF417', 'Aztec',
  ],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
};

// ─────────────────────────────────────────────────────────────
// Decode from a Blob (the most direct zxing-wasm path)
// ─────────────────────────────────────────────────────────────
async function _decodeWithZxingWasm(blob) {
  const loaded = await _ensureZxingWasm();
  if (!loaded || !window.ZXingWASM?.readBarcodesFromImageFile) return null;

  try {
    const results = await window.ZXingWASM.readBarcodesFromImageFile(blob, ZXING_READ_OPTIONS);
    if (results && results.length > 0 && results[0].text) {
      return results[0].text;
    }
  } catch (e) {
    console.warn('[scanner] zxing-wasm readBarcodesFromImageFile failed:', e.message);
  }
  return null;
}

// Decode from ImageData (for canvas frames — live camera)
async function _decodeWithZxingWasmImageData(imageData) {
  const loaded = await _ensureZxingWasm();
  if (!loaded || !window.ZXingWASM?.readBarcodesFromImageData) return null;

  try {
    const results = await window.ZXingWASM.readBarcodesFromImageData(imageData, ZXING_READ_OPTIONS);
    if (results && results.length > 0 && results[0].text) {
      return results[0].text;
    }
  } catch (e) {
    console.warn('[scanner] zxing-wasm readBarcodesFromImageData failed:', e.message);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Convert a data URL to a Blob
// ─────────────────────────────────────────────────────────────
function _dataUrlToBlob(dataUrl) {
  try {
    const [header, b64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const bin  = atob(b64);
    const arr  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (e) {
    console.warn('[scanner] dataUrl→Blob conversion failed:', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// MASTER DECODE — tries zxing-wasm first, then native BarcodeDetector
// Returns the barcode string or null.
// ─────────────────────────────────────────────────────────────
async function _decodeBarcodeFromDataUrl(dataUrl) {
  // Engine 1: zxing-wasm (ZXing C++ — most accurate)
  const blob = _dataUrlToBlob(dataUrl);
  if (blob) {
    try {
      const code = await Promise.race([
        _decodeWithZxingWasm(blob),
        new Promise((_, rej) => setTimeout(() => rej(new Error('zxing-wasm timeout')), 15000)),
      ]);
      if (code) {
        console.log('[scanner] zxing-wasm hit:', code);
        return code;
      }
    } catch (e) {
      if (!e.message?.includes('timeout')) {
        console.warn('[scanner] zxing-wasm error:', e.message);
      }
    }
  }

  // Engine 2: Native BarcodeDetector (Chrome/Edge 83+)
  if (window.BarcodeDetector) {
    try {
      const detector = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix', 'pdf417', 'aztec'],
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
      console.warn('[scanner] BarcodeDetector fallback failed:', e.message);
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Image helper
// ─────────────────────────────────────────────────────────────
function _dataUrlToImage(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error('Image load failed'));
    img.src     = dataUrl;
  });
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: decode a data URL and trigger lookup
// FIX: lookupBarcode has its own internal timeout — do NOT add
// a second outer timeout here. Just let it run and handle the
// result gracefully.
// ─────────────────────────────────────────────────────────────
async function _decodeAndLookup(dataUrl) {
  showScanStatus('loading', '<span class="spin">⏳</span> Scanning barcode…');

  const code = await _decodeBarcodeFromDataUrl(dataUrl);

  if (code) {
    const manualEl = document.getElementById('barcode-manual');
    if (manualEl) manualEl.value = code;

    showScanStatus('matched',
      `<strong>✓ Barcode detected:</strong> <span class="mono" style="color:var(--accent)">${code}</span>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">Looking up item details…</span>`
    );
    toast('Barcode read: ' + code, 'success');

    // FIX: Don't wrap lookupBarcode in another Promise.race timeout —
    // lookupBarcode already has a 12-second timeout internally.
    // Just call it and catch any errors.
    try {
      await lookupBarcode(code);
    } catch (_) {
      // lookupBarcode already handles its own no-match display
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
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    _cameraStream = stream;

    const video = document.getElementById('camera-video');
    if (!video) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream;
    await video.play();

    document.getElementById('camera-container')?.classList.add('active');
    const scanDrop = document.getElementById('scan-drop');
    if (scanDrop) scanDrop.style.display = 'none';
    const controls = document.getElementById('camera-controls');
    if (controls) controls.style.display = 'flex';

    _cameraRunning = true;
    toast('Camera active — point at a barcode', 'success');

    // Warm up zxing-wasm in background
    _ensureZxingWasm().catch(() => {});

    _startLiveScan();
  } catch (e) {
    toast('Camera access denied or unavailable', 'error');
    console.error('[scanner] Camera error:', e);
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
  let   useNativeDetector = !!window.BarcodeDetector;
  let   nativeDetector    = null;

  if (useNativeDetector) {
    try {
      nativeDetector = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'],
      });
    } catch (_) {
      useNativeDetector = false;
    }
  }

  const tick = async () => {
    if (!_cameraRunning) return;
    if (!video?.videoWidth || video.readyState < 2) {
      setTimeout(() => requestAnimationFrame(tick), 150);
      return;
    }

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    let code = null;

    try {
      if (useNativeDetector && nativeDetector) {
        const bitmap = await createImageBitmap(canvas);
        const codes  = await nativeDetector.detect(bitmap);
        bitmap.close();
        if (codes?.length) code = codes[0].rawValue;
      } else if (_zxingWasmReady) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        code = await Promise.race([
          _decodeWithZxingWasmImageData(imageData),
          new Promise(res => setTimeout(() => res(null), 800)),
        ]);
      }
    } catch (_) { /* keep scanning */ }

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

      // FIX: Don't silently fire and forget — await the lookup so status updates work
      try {
        await lookupBarcode(code);
      } catch (_) {
        // lookupBarcode handles its own UI
      }
      return;
    }

    if (_cameraRunning) setTimeout(() => requestAnimationFrame(tick), 250);
  };

  setTimeout(() => requestAnimationFrame(tick), 800);
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
  // Show preview immediately while we decode
  const objectUrl = URL.createObjectURL(file);
  const imgEl = document.getElementById('scan-preview-img');
  if (imgEl) {
    imgEl.src = objectUrl;
    imgEl.style.display = '';
    imgEl.onload = () => URL.revokeObjectURL(objectUrl);
  }

  const resultEl = document.getElementById('scan-result');
  if (resultEl) resultEl.style.display = '';

  showScanStatus('loading', '<span class="spin">⏳</span> Scanning barcode…');

  // Warm up zxing-wasm (no-op if already loaded)
  _ensureZxingWasm().then(loaded => {
    if (!loaded) {
      // zxing-wasm failed to load, fall back to data-URL path with BarcodeDetector
      const reader = new FileReader();
      reader.onload = async ev => {
        _state.editingItem._coverData = null;
        await _decodeAndLookup(ev.target.result);
      };
      reader.readAsDataURL(file);
      return;
    }

    // Preferred path: pass Blob directly to zxing-wasm
    _decodeWithZxingWasm(file).then(async code => {
      if (code) {
        const manualEl = document.getElementById('barcode-manual');
        if (manualEl) manualEl.value = code;

        showScanStatus('matched',
          `<strong>✓ Barcode detected:</strong> <span class="mono" style="color:var(--accent)">${code}</span>
           <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">Looking up item details…</span>`
        );
        toast('Barcode read: ' + code, 'success');

        // FIX: Await the lookup with its internal timeout
        try {
          await lookupBarcode(code);
        } catch (_) {
          // lookupBarcode handles its own no-match display
        }
      } else {
        // zxing-wasm returned nothing — try BarcodeDetector via data URL
        const reader = new FileReader();
        reader.onload = async ev => {
          const dataUrl = ev.target.result;
          _state.editingItem._coverData = null;

          if (window.BarcodeDetector) {
            const blobCode = await (async () => {
              try {
                const det = new BarcodeDetector({ formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','qr_code'] });
                const img = await _dataUrlToImage(dataUrl);
                const bmp = await createImageBitmap(img);
                const res = await det.detect(bmp);
                bmp.close();
                return res?.[0]?.rawValue || null;
              } catch (_) { return null; }
            })();

            if (blobCode) {
              const manualEl = document.getElementById('barcode-manual');
              if (manualEl) manualEl.value = blobCode;
              showScanStatus('matched',
                `<strong>✓ Barcode detected:</strong> <span class="mono" style="color:var(--accent)">${blobCode}</span>
                 <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">Looking up item details…</span>`
              );
              toast('Barcode read: ' + blobCode, 'success');
              try {
                await lookupBarcode(blobCode);
              } catch (_) {}
              return;
            }
          }

          showScanStatus('no-match',
            `<strong>⚠ No barcode found in this photo.</strong>
             <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:6px">
               Tips: ensure the barcode is in focus, well-lit, and not at a steep angle.
               <br>You can also type the number printed below the barcode in the field below.
             </span>`
          );
        };
        reader.readAsDataURL(file);
      }
    });
  });
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
    console.warn('[scanner] OCR failed:', ocrErr);
    showCoverScanStatus('info',
      `<strong>ℹ OCR unavailable.</strong>
       <br><span style="font-size:12px;color:var(--text2);display:block;margin-top:6px">
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