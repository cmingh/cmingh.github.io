// js/ui.js
// ─────────────────────────────────────────────────────────────
// Navigation, modals, tabs, toasts, mobile drawer, trade page,
// profile page, wishlist, discover page, and add-item modal flow.
//
// FIXES vs original:
//   - _updateCoverTabUI() now correctly updates the "Cover/Scan"
//     tab button label AND the drop-zone text/icon for every
//     media type, not just books.
//   - selectType() reliably calls _updateCoverTabUI() every time.
//   - openAddModal(item) also calls _updateCoverTabUI() on edit.
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES } from './state.js';
import { saveState } from './storage.js';
import { buildThemePickers } from './theme.js';
import { buildManualForm, resetComicTags, populateManualForm } from './forms.js';

// FIX: stopCamera is imported lazily inside navigate() / closeModal() to avoid a
// circular dependency (scanner.js → lookup.js → ui.js → scanner.js).
// Do NOT import stopCamera at the top level here.

const PAGES = ['home', 'login', 'signup', 'collection', 'artists', 'discover', 'trade', 'profile'];

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════

let _currentPage = 'home';
window._currentPage = _currentPage;
let _tradeUnsubscribe = null;

export function navigate(page) {
  if (page !== _currentPage) {
    import('./scanner.js').then(s => s.stopCamera()).catch(() => {});
  }

  PAGES.forEach(p => {
    document.getElementById('page-' + p)?.classList.toggle('active', p === page);
    document.getElementById('nb-' + p)?.classList.toggle('active', p === page);
    document.getElementById('mbnb-' + p)?.classList.toggle('active', p === page);
  });

  _currentPage = page;
  window._currentPage = page;

  if (page === 'collection') window.renderCollection?.();
  if (page === 'artists') {
    // Dynamically import artist module if needed
    import('./artist.js').then(m => m.initArtistView()).catch(() => {});
  }
  if (page === 'discover')   renderDiscover();
  if (page === 'trade')      renderTrade();
  if (page === 'profile')    renderProfile();

  window.scrollTo(0, 0);
}
window.goToView = navigate;

// ── Mobile drawer ─────────────────────────────────────────────
export function toggleMobileDrawer() {
  const drawer = document.getElementById('mobile-drawer');
  const ham    = document.getElementById('hamburger');
  drawer.classList.toggle('open');
  ham.classList.toggle('open', drawer.classList.contains('open'));
}
export function closeMobileDrawer() {
  document.getElementById('mobile-drawer').classList.remove('open');
  document.getElementById('hamburger').classList.remove('open');
}
window.toggleMobileDrawer = toggleMobileDrawer;
window.closeMobileDrawer  = closeMobileDrawer;

// ═══════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════

export function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
export function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
  if (id === 'modal-add') {
    import('./scanner.js').then(s => s.stopCamera()).catch(() => {});
  }
}

document.querySelectorAll('.modal-overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); })
);

window.openModal  = openModal;
window.closeModal = closeModal;

// ── Add-item modal lifecycle ──────────────────────────────────
export function openAddModal(item) {
  if (!_state.user) { navigate('login'); return; }

  // Reset scan state
  ['scan-result','scan-preview-img','cover-scan-result','cover-scan-preview','book-search-results'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const barcodeEl    = document.getElementById('barcode-manual');
  const coverTitleEl = document.getElementById('cover-title-input');
  if (barcodeEl)    barcodeEl.value    = '';
  if (coverTitleEl) coverTitleEl.value = '';

  if (item) {
    // ── Editing an existing item ──────────────────────────────
    _state.selectedType = MEDIA_TYPES.find(m => m.id === item.type) || _state.selectedType;
    _state.editingItem  = JSON.parse(JSON.stringify(item));
    _state.editingItem._coverData = item.coverData || item._coverData || null;
    _state.lookupResult = null;
    resetComicTags();

    document.getElementById('add-step-1').style.display = 'none';
    document.getElementById('add-step-2').style.display = '';
    document.getElementById('add-footer').style.display = 'flex';
    switchTab('manual-tab', 'add');
    buildManualForm();
    populateManualForm(item);
    _updateCoverTabUI();   // ← ensure tab label reflects correct type

    const titleEl = document.getElementById('add-modal-title');
    const saveBtn = document.getElementById('add-save-btn');
    if (titleEl) titleEl.textContent = 'Edit item';
    if (saveBtn) saveBtn.textContent = 'Save changes';
  } else {
    // ── New item ──────────────────────────────────────────────
    _state.selectedType = null;
    _state.editingItem  = {};
    _state.lookupResult = null;
    resetComicTags();

    document.getElementById('add-step-1').style.display = '';
    document.getElementById('add-step-2').style.display = 'none';
    document.getElementById('add-footer').style.display = 'none';

    const titleEl = document.getElementById('add-modal-title');
    const saveBtn = document.getElementById('add-save-btn');
    if (titleEl) titleEl.textContent = 'Add to collection';
    if (saveBtn) saveBtn.textContent = 'Save to collection';
  }

  import('./scanner.js').then(s => s.stopCamera()).catch(() => {});
  openModal('modal-add');
}
window.openAddModal = openAddModal;

export function selectType(id) {
  _state.selectedType = MEDIA_TYPES.find(m => m.id === id);
  if (!_state.editingItem) _state.editingItem = {};

  document.getElementById('add-step-1').style.display = 'none';
  document.getElementById('add-step-2').style.display = '';
  document.getElementById('add-footer').style.display = 'flex';

  // ← CRITICAL: update cover tab before switchTab so the tab is visible
  _updateCoverTabUI();
  switchTab('scan-tab', 'add');
  buildManualForm();
}
window.selectType = selectType;

export function backToStep1() {
  import('./scanner.js').then(s => s.stopCamera()).catch(() => {});
  document.getElementById('add-step-1').style.display = '';
  document.getElementById('add-step-2').style.display = 'none';
  document.getElementById('add-footer').style.display = 'none';
}
window.backToStep1 = backToStep1;

export function openTrade() {
  closeModal('modal-detail');
  openModal('modal-trade');
}
window.openTrade = openTrade;

// ─────────────────────────────────────────────────────────────
// _updateCoverTabUI()
//
// Updates the "Cover/Scan" tab button label AND the drop-zone
// text, icon, and info-banner for the currently selected media
// type.  Also shows/hides the tab if coverScan is false.
// ─────────────────────────────────────────────────────────────
function _updateCoverTabUI() {
  const mt = _state.selectedType;

  // Resolve the tab button (inside #add-step-2)
  const tabsContainer = document.querySelector('#add-step-2 .tabs[data-scope="add"]');
  const coverBtn      = tabsContainer?.querySelector('.tab-btn[data-tab="cover-tab"]');
  const coverPanel    = document.getElementById('tab-cover-tab');

  if (!mt) {
    if (coverBtn)  coverBtn.style.display  = 'none';
    if (coverPanel) coverPanel.style.display = 'none';
    return;
  }

  // Show/hide based on whether this type supports cover scanning
  const hasCoverScan = mt.coverScan !== false;
  if (coverBtn)  coverBtn.style.display  = hasCoverScan ? '' : 'none';
  if (coverPanel) coverPanel.style.display = hasCoverScan ? '' : 'none';

  if (!hasCoverScan) return;

  // ── Per-type labels ───────────────────────────────────────
  //  coverBtnLabel  : text shown on the tab button
  //  dropText       : heading inside the drop zone
  //  infoDetail     : what OCR/search does for this type
  //  icon           : emoji shown in the drop zone
  //  placeholder    : search input placeholder
  const cfg = _getCoverTabConfig(mt);

  // Tab button label
  if (coverBtn) coverBtn.textContent = cfg.coverBtnLabel;

  // Drop-zone elements
  const iconEl        = document.getElementById('cover-scanner-icon');
  const dropTextEl    = document.getElementById('cover-drop-text');
  const infoTextEl    = document.getElementById('cover-info-text');
  const searchInput   = document.getElementById('cover-title-input');

  if (iconEl)      iconEl.textContent      = cfg.icon;
  if (dropTextEl)  dropTextEl.textContent  = cfg.dropText;
  if (infoTextEl)  infoTextEl.innerHTML    =
    `<strong>${cfg.coverBtnLabel}:</strong> ${cfg.infoDetail}. Or type the ${cfg.searchLabel} below.`;
  if (searchInput) searchInput.placeholder = cfg.placeholder;
}

/** Returns per-media-type config for the cover/search tab */
function _getCoverTabConfig(mt) {
  const defaults = {
    coverBtnLabel : '📷 Cover Scan',
    icon          : mt.icon,
    dropText      : `Click or drag a photo of the ${mt.label.toLowerCase()} cover`,
    infoDetail    : 'we\'ll try OCR to extract the title and search for it',
    searchLabel   : 'title',
    placeholder   : 'Or type title / name to search…',
  };

  const overrides = {
    book: {
      coverBtnLabel : '📚 Book Cover',
      icon          : '📗',
      dropText      : 'Click or drag a photo of the book cover',
      infoDetail    : 'we\'ll try OCR to extract the title or author and search Open Library',
      searchLabel   : 'title or author',
      placeholder   : 'Or type title / author to search…',
    },
    comic: {
      coverBtnLabel : '🦸 Comic Cover',
      icon          : '🦸',
      dropText      : 'Click or drag a photo of the comic cover',
      infoDetail    : 'we\'ll try OCR to extract the title / issue and search for it',
      searchLabel   : 'title or issue',
      placeholder   : 'Or type title / issue to search…',
    },
    manga: {
      coverBtnLabel : '📘 Manga Cover',
      icon          : '📘',
      dropText      : 'Click or drag a photo of the manga cover',
      infoDetail    : 'we\'ll try OCR to extract the title and search for it',
      searchLabel   : 'title or volume',
      placeholder   : 'Or type title / volume to search…',
    },
    vinyl: {
      coverBtnLabel : '🎵 Vinyl Cover',
      icon          : '🎵',
      dropText      : 'Click or drag a photo of the album cover',
      infoDetail    : 'we\'ll try OCR to extract the artist / album and search for it',
      searchLabel   : 'artist or album',
      placeholder   : 'Or type artist / album to search…',
    },
    cd: {
      coverBtnLabel : '💿 CD Cover',
      icon          : '💿',
      dropText      : 'Click or drag a photo of the CD cover',
      infoDetail    : 'we\'ll try OCR to extract the artist / album and search for it',
      searchLabel   : 'artist or album',
      placeholder   : 'Or type artist / album to search…',
    },
    cassette: {
      coverBtnLabel : '📼 Cassette Cover',
      icon          : '📼',
      dropText      : 'Click or drag a photo of the cassette cover',
      infoDetail    : 'we\'ll try OCR to extract the artist / album and search for it',
      searchLabel   : 'artist or album',
      placeholder   : 'Or type artist / album to search…',
    },
    dvd: {
      coverBtnLabel : '📀 DVD Cover',
      icon          : '📀',
      dropText      : 'Click or drag a photo of the DVD or Blu-ray cover',
      infoDetail    : 'we\'ll try OCR to extract the title and search for it',
      searchLabel   : 'title',
      placeholder   : 'Or type movie / show title to search…',
    },
    vhs: {
      coverBtnLabel : '📹 VHS Cover',
      icon          : '📹',
      dropText      : 'Click or drag a photo of the VHS cover',
      infoDetail    : 'we\'ll try OCR to extract the title and search for it',
      searchLabel   : 'title',
      placeholder   : 'Or type movie / show title to search…',
    },
    game: {
      coverBtnLabel : '🎮 Game Cover',
      icon          : '🎮',
      dropText      : 'Click or drag a photo of the game cover',
      infoDetail    : 'we\'ll try OCR to extract the title and search for it',
      searchLabel   : 'title or platform',
      placeholder   : 'Or type game title / platform to search…',
    },
    magazine: {
      coverBtnLabel : '📖 Magazine Cover',
      icon          : '📖',
      dropText      : 'Click or drag a photo of the magazine cover',
      infoDetail    : 'we\'ll try OCR to extract the title / issue and search for it',
      searchLabel   : 'title or issue',
      placeholder   : 'Or type magazine title to search…',
    },
    newspaper: {
      coverBtnLabel : '📰 Newspaper Scan',
      icon          : '📰',
      dropText      : 'Click or drag a photo of the newspaper front page',
      infoDetail    : 'we\'ll try OCR to extract the headline / date',
      searchLabel   : 'title or headline',
      placeholder   : 'Or type newspaper name / headline to search…',
    },
    photo: {
      coverBtnLabel : '🖼 Photograph',
      icon          : '🖼',
      dropText      : 'Click or drag the photograph itself',
      infoDetail    : 'we\'ll try OCR to extract any text metadata from the image',
      searchLabel   : 'subject or photographer',
      placeholder   : 'Or type subject / photographer to search…',
    },
  };

  return { ...defaults, ...(overrides[mt.id] || {}) };
}

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════

export function switchTab(tabId, scope) {
  let tabsContainer = null;
  if      (scope === 'add')     tabsContainer = document.querySelector('#add-step-2 .tabs[data-scope="add"]');
  else if (scope === 'trade')   tabsContainer = document.querySelector('#page-trade .tabs[data-scope="trade"]');
  else if (scope === 'profile') tabsContainer = document.querySelector('#page-profile .tabs[data-scope="profile"]');

  if (tabsContainer) {
    tabsContainer.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    tabsContainer.querySelector(`.tab-btn[data-tab="${tabId}"]`)?.classList.add('active');
    tabsContainer.parentElement.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  }
  document.getElementById('tab-' + tabId)?.classList.add('active');
}
window.switchTab = switchTab;

// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════

export function toast(msg, type = '') {
  const container = document.getElementById('toast');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-msg ' + (type || '');
  el.innerHTML = (type === 'success' ? '✓ ' : type === 'error' ? '✕ ' : '') + msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
window.toast = toast;

// ═══════════════════════════════════════════════════════════════
// MEDIA GRID BUILDERS
// ═══════════════════════════════════════════════════════════════

export function buildMediaGrids() {
  const homeGrid = document.getElementById('home-media-grid');
  if (homeGrid) {
    homeGrid.innerHTML = MEDIA_TYPES.map(m =>
      `<div class="media-card"><div class="media-icon">${m.icon}</div><div class="media-label">${m.label}</div></div>`
    ).join('');
  }

  const addGrid = document.getElementById('add-media-grid');
  if (addGrid) {
    addGrid.innerHTML = MEDIA_TYPES.map(m =>
      `<div class="media-card" onclick="window.selectType('${m.id}')">
         <div class="media-icon">${m.icon}</div>
         <div class="media-label">${m.label}</div>
       </div>`
    ).join('');
  }

  ['col-filter-type', 'wish-type'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    MEDIA_TYPES.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label;
      sel.appendChild(o);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// DISCOVER PAGE
// ═══════════════════════════════════════════════════════════════

const DEMO_COLLECTION = [
  { id:'d1', type:'comic',    typeLabel:'Comic Book',  icon:'🦸', fields:{ title:'Amazing Spider-Man #129', publisher:'Marvel',        pub_date:'Feb 1974', condition:'Very Fine',  writer:'Gerry Conway', edition_type:'Newsstand' }, coverData:null, source:'manual'      },
  { id:'d2', type:'vinyl',    typeLabel:'Vinyl',        icon:'🎵', fields:{ album:'Kind of Blue',            artist:'Miles Davis',       label:'Columbia',    year:'1959',           condition:'Near Mint', pressing:'US Original'    }, coverData:null, source:'manual'      },
  { id:'d3', type:'book',     typeLabel:'Book',         icon:'📗', fields:{ title:'Dune',                    author:'Frank Herbert',     publisher:'Chilton', pub_year:'1965',       condition:'Good',      binding:'Hardcover'        }, coverData:null, source:'Open Library' },
  { id:'d4', type:'game',     typeLabel:'Video Game',   icon:'🎮', fields:{ title:'The Legend of Zelda',     platform:'NES',             publisher:'Nintendo',year:'1987',           condition:'Very Good', complete:'Yes'             }, coverData:null, source:'UPCitemdb'    },
  { id:'d5', type:'magazine', typeLabel:'Magazine',     icon:'📖', fields:{ title:'Rolling Stone',           issue:'#1',                 pub_date:'Nov 1967', publisher:'Straight Arrow', condition:'Fair'                           }, coverData:null, source:'manual'      },
  { id:'d6', type:'comic',    typeLabel:'Comic Book',   icon:'🦸', fields:{ title:'X-Men #1',                publisher:'Marvel',         pub_date:'Sep 1963', condition:'Good',      writer:'Stan Lee'                              }, coverData:null, source:'manual'      },
];

async function renderDiscover() {
  const grid = document.getElementById('discover-grid');
  if (!grid) return;

  if (window._fb?.enabled && window._fb.getCommunityItems) {
    try {
      const communityItems = await window._fb.getCommunityItems();
      if (communityItems.length) {
        grid.innerHTML = communityItems.map(i => {
          const title    = i.fields?.title || i.fields?.album || i.fields?.artist || 'Item';
          const sub      = i.fields?.author || i.fields?.artist || i.fields?.writer || i.fields?.year || '';
          const username = i.username ? `@${i.username}` : '@collector';
          return `<div class="col-item fade-in">
            <div class="col-thumb">${i.coverData ? `<img src="${i.coverData}" alt="${title}">` : (i.icon || '📦')}<div class="col-badge">${i.typeLabel}</div></div>
            <div class="col-info">
              <div class="col-title truncate">${title}</div>
              <div class="col-meta truncate">${sub}</div>
              <div class="col-meta" style="margin-top:4px;color:var(--accent);font-size:11px;font-family:var(--font-m)">${username}</div>
            </div>
          </div>`;
        }).join('');
        return;
      }
    } catch (e) {
      console.warn('Community items failed to load:', e);
    }
  }

  const all = [...DEMO_COLLECTION, ..._state.collection.slice(0, 6)];
  grid.innerHTML = all.map(i => {
    const title = i.fields?.title || i.fields?.album || i.fields?.artist || 'Item';
    const sub   = i.fields?.author || i.fields?.artist || i.fields?.writer || i.fields?.year || '';
    return `<div class="col-item fade-in">
      <div class="col-thumb">${i.coverData ? `<img src="${i.coverData}" alt="${title}">` : (i.icon || '📦')}<div class="col-badge">${i.typeLabel}</div></div>
      <div class="col-info">
        <div class="col-title truncate">${title}</div>
        <div class="col-meta truncate">${sub}</div>
        <div class="col-meta" style="margin-top:4px;color:var(--accent);font-size:11px;font-family:var(--font-m)">@community_collector</div>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// TRADE PAGE
// ═══════════════════════════════════════════════════════════════

function renderTrade() {
  _renderConvoList();

  if (window._fb?.enabled && window._fb.subscribeToMessages && _state.user?.username) {
    if (_tradeUnsubscribe) { _tradeUnsubscribe(); _tradeUnsubscribe = null; }
    _tradeUnsubscribe = window._fb.subscribeToMessages(_state.user.username, rawMessages => {
      const grouped = {};
      rawMessages.forEach(m => {
        const partner = m.from === _state.user.username ? m.to : m.from;
        if (!grouped[partner]) grouped[partner] = { to: partner, msgs: [] };
        grouped[partner].msgs.push({
          from: m.from,
          text: m.text,
          time: m.createdAt?.toDate
            ? m.createdAt.toDate().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
            : new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
        });
      });
      _state.messages = Object.values(grouped).sort((a, b) => b.msgs.length - a.msgs.length);
      _renderConvoList();
    });
  }

  _renderTradersGrid();
  renderWishlist();
}

/**
 * _renderTradersGrid — fetch all users from Firebase and show them.
 *
 * FIX: The original getAllUsers() tried to read a 'collection' field
 * from the users document, but in Firestore items live in a
 * *subcollection* (users/{uid}/collection). We now use the corrected
 * Firebase method (see firebase.js) and show a sensible empty state.
 */
async function _renderTradersGrid() {
  const tradersGrid = document.getElementById('traders-grid');
  if (!tradersGrid) return;

  // Loading state
  tradersGrid.innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text3)">
      <div class="spin" style="font-size:28px;display:inline-block;margin-bottom:10px">⏳</div>
      <div>Loading collectors…</div>
    </div>`;

  let traders = [];

  if (window._fb?.enabled && window._fb.getAllUsers) {
    try {
      traders = await window._fb.getAllUsers();
      // Remove self
      traders = traders.filter(u => u.id !== _state.user?.id);
    } catch (e) {
      console.warn('Could not load traders from Firebase:', e);
    }
  }

  if (traders.length === 0) {
    tradersGrid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text3)">
        <div style="font-size:32px;margin-bottom:10px">👥</div>
        <div style="font-weight:500;margin-bottom:6px">No other collectors found yet</div>
        <div style="font-size:12px">
          ${window._fb?.enabled
            ? 'As more users sign up and add items, they\'ll appear here.'
            : 'Enable Firebase to connect with other collectors across devices.'}
        </div>
      </div>`;
    return;
  }

  tradersGrid.innerHTML = traders.map(t => {
    const name  = t.firstName ? `${t.firstName} ${t.lastName || ''}`.trim() : t.username;
    const items = t.itemCount ?? 0;
    const icon  = t.icon || '📦';
    return `
      <div class="card"><div class="card-body flex items-center gap-3">
        <div class="avatar" style="font-size:22px;width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:var(--bg2);border-radius:50%">${icon}</div>
        <div style="flex:1;min-width:0">
          <div class="fw-500">${name}</div>
          <div class="text-muted text-xs mono">@${t.username}</div>
          <div class="text-xs" style="margin-top:4px">${items} item${items !== 1 ? 's' : ''}</div>
        </div>
        <button class="btn-ghost" style="font-size:12px" onclick="window.startMessage('${t.username}')">Message</button>
      </div></div>`;
  }).join('');
}

function _renderConvoList() {
  const cl = document.getElementById('convo-list');
  if (!cl) return;
  cl.innerHTML = _state.messages.length === 0
    ? `<div style="text-align:center;padding:20px;color:var(--text3);font-size:12px">No conversations yet</div>`
    : _state.messages.map((m, i) => `
        <div class="col-list-item" onclick="window._openConvo(${i})">
          <div class="col-list-thumb" style="background:var(--accent);color:var(--bg)">📬</div>
          <div style="flex:1;min-width:0">
            <div class="fw-500 truncate text-sm">${m.to}</div>
            <div class="text-xs text-muted truncate">${m.msgs[m.msgs.length - 1]?.text || ''}</div>
          </div>
        </div>`).join('');
}

window._openConvo = function(idx) {
  const m     = _state.messages[idx];
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div style="font-weight:600;font-size:13px;padding-bottom:10px;border-bottom:1px solid var(--border)">💬 ${m.to}</div>
    <div class="flex-col gap-2" style="flex:1;overflow-y:auto;padding:8px 0" id="chat-msgs">
      ${m.msgs.map(msg => `
        <div style="display:flex;flex-direction:column;align-items:${msg.from === _state.user?.username ? 'flex-end' : 'flex-start'}">
          <div class="msg-bubble ${msg.from === _state.user?.username ? 'me' : 'them'}">${msg.text}</div>
          <div class="msg-time">${msg.time}</div>
        </div>`).join('')}
    </div>
    <div style="display:flex;gap:8px;border-top:1px solid var(--border);padding-top:10px">
      <input class="form-input" id="chat-input" placeholder="Type a message…" style="flex:1"
             onkeydown="if(event.key==='Enter') window._sendChatMsg(${idx})">
      <button class="btn-primary" onclick="window._sendChatMsg(${idx})">Send</button>
    </div>`;
};

window._sendChatMsg = async function(idx) {
  const inp  = document.getElementById('chat-input');
  const text = inp?.value.trim();
  if (!text) return;
  const from = _state.user?.username || 'me';
  _state.messages[idx].msgs.push({
    from, text,
    time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
  });
  if (window._fb?.enabled && window._fb.sendMessage) {
    await window._fb.sendMessage(_state.messages[idx].to, text);
  } else if (window._fb?.enabled) {
    await window._fb.saveMessages(_state.messages);
  } else {
    saveState();
  }
  window._openConvo(idx);
  if (inp) inp.value = '';
};

window.sendTradeMessage = async function() {
  const to   = document.getElementById('trade-to')?.value.trim();
  const text = document.getElementById('trade-msg')?.value.trim();
  if (!to || !text) { toast('Please fill in all fields', 'error'); return; }
  const msg = {
    from: _state.user?.username || 'me', text,
    time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
  };
  const existing = _state.messages.find(m => m.to === to);
  if (existing) existing.msgs.push(msg);
  else _state.messages.push({ to, msgs: [msg] });
  _state.trades++;
  if (window._fb?.enabled && window._fb.sendMessage) {
    await window._fb.sendMessage(to, text);
  } else if (window._fb?.enabled) {
    await window._fb.saveMessages(_state.messages);
  } else {
    saveState();
  }
  closeModal('modal-trade');
  toast('Message sent to ' + to, 'success');
};

window.startMessage = function(user) {
  const toEl  = document.getElementById('trade-to');
  const msgEl = document.getElementById('trade-msg');
  if (toEl)  toEl.value  = user;
  if (msgEl) msgEl.value = '';
  openModal('modal-trade');
};

// ── Wishlist ──────────────────────────────────────────────────
window.addWish = async function() {
  const text = document.getElementById('wish-input')?.value.trim();
  const type = document.getElementById('wish-type')?.value;
  if (!text) { toast('Enter an item', 'error'); return; }
  _state.wishlist.push({ id:'w'+Date.now(), text, type, date: new Date().toLocaleDateString() });
  const inputEl = document.getElementById('wish-input');
  if (inputEl) inputEl.value = '';
  if (window._fb?.enabled) await window._fb.saveWishlist(_state.wishlist);
  else saveState();
  renderWishlist();
};

window.removeWish = async function(id) {
  _state.wishlist = _state.wishlist.filter(w => w.id !== id);
  if (window._fb?.enabled) await window._fb.saveWishlist(_state.wishlist);
  else saveState();
  renderWishlist();
};

export function renderWishlist() {
  const el = document.getElementById('wishlist-items');
  if (!el) return;
  el.innerHTML = _state.wishlist.length === 0
    ? `<div style="text-align:center;padding:30px;color:var(--text3)">Your wishlist is empty</div>`
    : _state.wishlist.map(w => `
        <div class="col-list-item">
          <div class="col-list-thumb">✨</div>
          <div style="flex:1;min-width:0">
            <div class="fw-500 truncate">${w.text}</div>
            <div class="text-xs text-muted">${w.type ? `${MEDIA_TYPES.find(m => m.id === w.type)?.label || w.type} · ` : ''}Added ${w.date}</div>
          </div>
          <button class="btn-danger" style="font-size:11px;padding:5px 10px" onclick="window.removeWish('${w.id}')">Remove</button>
        </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// PROFILE PAGE
// ═══════════════════════════════════════════════════════════════

export function renderProfile() {
  if (!_state.user) return;
  const u = _state.user;

  const profAvatar = document.getElementById('prof-avatar');
  const profName   = document.getElementById('prof-name');
  const profUser   = document.getElementById('prof-username');
  const profMember = document.getElementById('prof-member');
  if (profAvatar) profAvatar.textContent = (u.firstName || '?')[0].toUpperCase();
  if (profName)   profName.textContent   = `${u.firstName} ${u.lastName}`;
  if (profUser)   profUser.textContent   = `@${u.username}`;
  if (profMember) profMember.textContent = `Member since ${u.joined}`;

  const types = new Set(_state.collection.map(i => i.type));
  document.getElementById('pstat-items').textContent  = _state.collection.length;
  document.getElementById('pstat-types').textContent  = types.size;
  document.getElementById('pstat-trades').textContent = _state.trades;
  document.getElementById('pstat-wish').textContent   = _state.wishlist.length;

  const setName  = document.getElementById('set-name');
  const setEmail = document.getElementById('set-email');
  const setBio   = document.getElementById('set-bio');
  const setPhone = document.getElementById('set-phone');
  if (setName)  setName.value  = `${u.firstName} ${u.lastName}`;
  if (setEmail) setEmail.value = u.email  || '';
  if (setBio)   setBio.value   = u.bio    || '';
  if (setPhone) setPhone.value = u.phone  || '';

  const profGrid = document.getElementById('prof-col-grid');
  if (profGrid) {
    profGrid.innerHTML = _state.collection.slice(0, 8).map(i => {
      const title = i.fields?.title || i.fields?.album || i.fields?.artist || 'Item';
      return `<div class="col-item">
        <div class="col-thumb">${i.coverData ? `<img src="${i.coverData}" alt="${title}">` : (i.icon || '📦')}<div class="col-badge">${i.typeLabel}</div></div>
        <div class="col-info"><div class="col-title truncate">${title}</div></div>
      </div>`;
    }).join('');
  }

  buildThemePickers();
}
window.renderProfile = renderProfile;

window.saveSettings = async function() {
  const nameEl  = document.getElementById('set-name');
  const emailEl = document.getElementById('set-email');
  const bioEl   = document.getElementById('set-bio');
  const phoneEl = document.getElementById('set-phone');
  if (!_state.user) return;

  const parts = (nameEl?.value.trim() || '').split(' ');
  _state.user.firstName = parts[0]              || _state.user.firstName;
  _state.user.lastName  = parts.slice(1).join(' ') || _state.user.lastName;
  _state.user.email     = emailEl?.value.trim() || _state.user.email;
  _state.user.bio       = bioEl?.value.trim()   || _state.user.bio;
  _state.user.phone     = phoneEl?.value.trim() || null;

  const avatarEl = document.getElementById('nav-avatar');
  if (avatarEl) avatarEl.textContent = (_state.user.firstName || '?')[0].toUpperCase();

  if (window._fb?.enabled) {
    await window._fb.updateProfile(_state.user.id, {
      firstName: _state.user.firstName,
      lastName:  _state.user.lastName,
      email:     _state.user.email,
      bio:       _state.user.bio,
      phone:     _state.user.phone,
    });
  }
  saveState();
  toast('Settings saved', 'success');
};