// js/main.js
// ─────────────────────────────────────────────────────────────
// App entry point. Loaded as <script type="module"> AFTER
// firebase.js in index.html. Waits for window._fbReady signal.
// ─────────────────────────────────────────────────────────────

import { loadState }                                from './storage.js';
import { applyTheme, buildThemePickers, toggleThemePicker } from './theme.js';
import { buildMediaGrids, navigate, openAddModal, selectType, backToStep1, openTrade, switchTab, closeModal, openModal, toast } from './ui.js';
import { updateNavForAuth, doLogin, doSignup, logout } from './auth.js';
import { saveItem, deleteItem, setCollectionView, renderCollection, openDetail } from './collection.js';
import { startCamera, stopCamera, captureFrame, handleScanDrop, handleScanFile, handleCoverScanDrop, handleCoverScanFile } from './scanner.js';
import { lookupBarcode, searchBookByTitle, searchMediaByTitle }          from './lookup.js';
import { _state }                                    from './state.js';

// ─────────────────────────────────────────────────────────────
// Expose everything that index.html inline handlers need
// (all onclick="window.X()" attributes route through here)
// ─────────────────────────────────────────────────────────────
window.applyTheme          = applyTheme;
window.toggleThemePicker   = toggleThemePicker;
window.navigate            = navigate;
window.openAddModal        = openAddModal;
window.selectType          = selectType;
window.backToStep1         = backToStep1;
window.switchTab           = switchTab;
window.openModal           = openModal;
window.closeModal          = closeModal;
window.toast               = toast;

window.doLogin             = doLogin;
window.doSignup            = doSignup;
window.logout              = logout;
window.updateNavForAuth    = updateNavForAuth;

window.saveItem            = saveItem;
window.deleteItem          = deleteItem;
window.setCollectionView   = setCollectionView;   // grid/list toggle in collection page
window.renderCollection    = renderCollection;
window.openDetail          = openDetail;
window.openTrade           = openTrade;

window.startCamera         = startCamera;
window.stopCamera          = stopCamera;
window.captureFrame        = captureFrame;
window.handleScanDrop      = handleScanDrop;
window.handleScanFile      = handleScanFile;
window.handleCoverScanDrop = handleCoverScanDrop;
window.handleCoverScanFile = handleCoverScanFile;

window.lookupBarcode       = lookupBarcode;
window.searchBookByTitle   = searchBookByTitle;
window.searchMediaByTitle  = searchMediaByTitle;

window.renderProfile       = () => import('./ui.js').then(m => m.renderProfile());

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
function initApp() {
  loadState();
  applyTheme(_state.theme || 'dark');
  buildThemePickers();
  buildMediaGrids();

  if (window._fb?.enabled) {
    // Firebase configured — onAuthStateChanged in firebase.js drives navigation
    updateNavForAuth();
  } else {
    // Local fallback mode
    updateNavForAuth();
    navigate(_state.user ? 'collection' : 'home');
  }
}

// firebase.js sets window._fbReady and calls window._fbReadyCb when done.
// If it already fired (e.g. no Firebase config → instant), boot now.
if (window._fbReady) {
  initApp();
} else {
  window._fbReadyCb = initApp;
  // Safety net: if firebase.js never signals (network issue etc.), boot after 3 s
  setTimeout(() => {
    if (!window._fbReady) {
      window._fbReady = true;
      initApp();
    }
  }, 3000);
}