// js/main.js
// ─────────────────────────────────────────────────────────────
// App entry point. Imported as type="module" in index.html.
// Waits for Firebase module signal then boots.
// ─────────────────────────────────────────────────────────────

import { loadState } from './storage.js';
import { applyTheme, buildThemePickers, toggleThemePicker } from './theme.js';
import { buildMediaGrids, navigate } from './ui.js';
import { updateNavForAuth, doLogin, doSignup, logout } from './auth.js';
import { saveItem, deleteItem, setView, renderCollection, openDetail } from './collection.js';
import { startCamera, stopCamera, captureFrame, handleScanDrop, handleScanFile, handleCoverScanDrop, handleCoverScanFile } from './scanner.js';
import { lookupBarcode, searchBookByTitle } from './lookup.js';
import { _state } from './state.js';

// ── Expose everything that index.html inline handlers need ─────
window.applyTheme         = applyTheme;
window.toggleThemePicker  = toggleThemePicker;
window.doLogin            = doLogin;
window.doSignup           = doSignup;
window.logout             = logout;
window.saveItem           = saveItem;
window.deleteItem         = deleteItem;
window.setView            = setView;
window.renderCollection   = renderCollection;
window.startCamera        = startCamera;
window.stopCamera         = stopCamera;
window.captureFrame       = captureFrame;
window.handleScanDrop     = handleScanDrop;
window.handleScanFile     = handleScanFile;
window.handleCoverScanDrop = handleCoverScanDrop;
window.handleCoverScanFile = handleCoverScanFile;
window.lookupBarcode      = lookupBarcode;
window.searchBookByTitle  = searchBookByTitle;
window.openDetail         = openDetail;

window.openTrade = function() {
  import('./ui.js').then(ui => {
    import('./collection.js').then(() => {
      ui.closeModal('modal-detail');
      ui.openModal('modal-trade');
    });
  });
};

// ── Boot ───────────────────────────────────────────────────────
function initApp() {
  loadState();
  applyTheme(_state.theme || 'dark');
  buildThemePickers();
  buildMediaGrids();

  if (window._fb?.enabled) {
    // Firebase initialized — onAuthStateChanged in firebase.js handles nav
    updateNavForAuth();
  } else {
    // Local fallback mode
    updateNavForAuth();
    if (_state.user) navigate('collection');
    else navigate('home');
  }
}

if (window._fbReady) {
  initApp();
} else {
  window._fbReadyCb = initApp;
  // Safety timeout: if the Firebase module never fires, boot in local mode
  setTimeout(() => {
    if (!window._fbReady) {
      window._fbReady = true;
      initApp();
    }
  }, 3000);
}