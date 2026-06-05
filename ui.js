// js/ui.js
// ─────────────────────────────────────────────────────────────
// Navigation, modals, tabs, toasts, mobile drawer, trade page,
// profile page, wishlist, discover page, and add-item modal flow.
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES } from './state.js';
import { saveState } from './storage.js';
import { buildThemePickers } from './theme.js';
import { buildManualForm, resetComicTags, populateManualForm } from './forms.js';

// FIX: stopCamera is imported lazily inside navigate() to avoid a
// circular dependency (scanner.js → lookup.js → ui.js → scanner.js).
// Do NOT import stopCamera at the top level here.

const PAGES = ['home', 'login', 'signup', 'collection', 'discover', 'trade', 'profile'];

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════

let _currentPage = 'home';
window._currentPage = _currentPage;
let _tradeUnsubscribe = null;

export function navigate(page) {
  // Stop camera when leaving the add-modal's scan tab
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

  // Use already-loaded module references (main.js puts them on window)
  if (page === 'collection') window.renderCollection?.();
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

export function openModal(id)  { document.getElementById(id)?.classList.add('open');    }
export function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
  // Stop camera when the add-modal is closed
  if (id === 'modal-add') {
    import('./scanner.js').then(s => s.stopCamera()).catch(() => {});
  }
}

// Close on backdrop click
document.querySelectorAll('.modal-overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); })
);

window.openModal  = openModal;
window.closeModal = closeModal;

// ── Add-item modal lifecycle ──────────────────────────────────
export function openAddModal(item) {
  if (!_state.user) { navigate('login'); return; }

  // Reset all scan state
  const ids = [
    'add-step-1', 'scan-result', 'scan-preview-img',
    'cover-scan-result', 'cover-scan-preview', 'book-search-results',
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  const barcodeEl   = document.getElementById('barcode-manual');
  const coverTitleEl = document.getElementById('cover-title-input');
  if (barcodeEl)    barcodeEl.value    = '';
  if (coverTitleEl) coverTitleEl.value = '';

  if (item) {
    _state.selectedType = MEDIA_TYPES.find(m => m.id === item.type) || _state.selectedType;
    _state.editingItem = JSON.parse(JSON.stringify(item));
    _state.editingItem._coverData = item.coverData || item._coverData || null;
    _state.lookupResult = null;
    resetComicTags();

    document.getElementById('add-step-1').style.display = 'none';
    document.getElementById('add-step-2').style.display = '';
    document.getElementById('add-footer').style.display = 'flex';
    switchTab('manual-tab', 'add');
    buildManualForm();
    populateManualForm(item);

    const titleEl = document.getElementById('add-modal-title');
    const saveBtn = document.getElementById('add-save-btn');
    if (titleEl) titleEl.textContent = 'Edit item';
    if (saveBtn) saveBtn.textContent = 'Save changes';
  } else {
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
  document.getElementById('add-step-1').style.display = 'none';
  document.getElementById('add-step-2').style.display = '';
  document.getElementById('add-footer').style.display = 'flex';
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

// ── openTrade (called from detail modal) ──────────────────────
export function openTrade() {
  closeModal('modal-detail');
  openModal('modal-trade');
}
window.openTrade = openTrade;

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════

/**
 * switchTab(tabId, scope)
 * scope: 'add' | 'trade' | 'profile'
 *
 * Uses data-scope attributes on .tabs containers to avoid
 * cross-contaminating separate tab groups on the same page.
 */
export function switchTab(tabId, scope) {
  let tabsContainer = null;
  if      (scope === 'add')     tabsContainer = document.querySelector('#add-step-2 .tabs[data-scope="add"]');
  else if (scope === 'trade')   tabsContainer = document.querySelector('#page-trade .tabs[data-scope="trade"]');
  else if (scope === 'profile') tabsContainer = document.querySelector('#page-profile .tabs[data-scope="profile"]');

  if (tabsContainer) {
    tabsContainer.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    tabsContainer.querySelector(`.tab-btn[data-tab="${tabId}"]`)?.classList.add('active');
    // Deactivate sibling panels within this scope's parent
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

  // Type-filter dropdowns
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
          const title = i.fields?.title || i.fields?.album || i.fields?.artist || 'Item';
          const sub   = i.fields?.author || i.fields?.artist || i.fields?.writer || i.fields?.year || '';
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
    if (_tradeUnsubscribe) {
      _tradeUnsubscribe();
      _tradeUnsubscribe = null;
    }
    _tradeUnsubscribe = window._fb.subscribeToMessages(_state.user.username, rawMessages => {
      const grouped = {};
      rawMessages.forEach(m => {
        const partner = m.from === _state.user.username ? m.to : m.from;
        if (!grouped[partner]) grouped[partner] = { to: partner, msgs: [] };
        grouped[partner].msgs.push({
          from: m.from,
          text: m.text,
          time: m.createdAt?.toDate ? m.createdAt.toDate().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
        });
      });
      _state.messages = Object.values(grouped).sort((a, b) => b.msgs.length - a.msgs.length);
      _renderConvoList();
    });
  }

  const tradersGrid = document.getElementById('traders-grid');
  if (tradersGrid) {
    tradersGrid.innerHTML = [
      { name:'Marcus Hall', user:'vinyl_king', items:42, icon:'🎵' },
      { name:'Sara Liu',    user:'comix_sara', items:87, icon:'🦸' },
      { name:'Tom B.',      user:'retrogames', items:31, icon:'🎮' },
      { name:'Priya N.',    user:'bookstack',  items:56, icon:'📗' },
    ].map(t => `
      <div class="card"><div class="card-body flex items-center gap-3">
        <div class="avatar" style="font-size:22px">${t.icon}</div>
        <div style="flex:1">
          <div class="fw-500">${t.name}</div>
          <div class="text-muted text-xs mono">@${t.user}</div>
          <div class="text-xs" style="margin-top:4px">${t.items} items</div>
        </div>
        <button class="btn-ghost" style="font-size:12px" onclick="window.startMessage('${t.user}')">Message</button>
      </div></div>`).join('');
  }

  renderWishlist();
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
  } else saveState();
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
  _state.wishlist.push({ id: 'w' + Date.now(), text, type, date: new Date().toLocaleDateString() });
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

  const profAvatar  = document.getElementById('prof-avatar');
  const profName    = document.getElementById('prof-name');
  const profUser    = document.getElementById('prof-username');
  const profMember  = document.getElementById('prof-member');
  if (profAvatar) profAvatar.textContent  = (u.firstName || '?')[0].toUpperCase();
  if (profName)   profName.textContent    = `${u.firstName} ${u.lastName}`;
  if (profUser)   profUser.textContent    = `@${u.username}`;
  if (profMember) profMember.textContent  = `Member since ${u.joined}`;

  const types = new Set(_state.collection.map(i => i.type));
  document.getElementById('pstat-items').textContent  = _state.collection.length;
  document.getElementById('pstat-types').textContent  = types.size;
  document.getElementById('pstat-trades').textContent = _state.trades;
  document.getElementById('pstat-wish').textContent   = _state.wishlist.length;

  const setName  = document.getElementById('set-name');
  const setEmail = document.getElementById('set-email');
  const setBio   = document.getElementById('set-bio');
  if (setName)  setName.value  = `${u.firstName} ${u.lastName}`;
  if (setEmail) setEmail.value = u.email || '';
  if (setBio)   setBio.value   = u.bio || '';

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
  if (!_state.user) return;

  const parts = (nameEl?.value.trim() || '').split(' ');
  _state.user.firstName = parts[0] || _state.user.firstName;
  _state.user.lastName  = parts.slice(1).join(' ') || _state.user.lastName;
  _state.user.email     = emailEl?.value.trim() || _state.user.email;
  _state.user.bio       = bioEl?.value.trim() || _state.user.bio;

  const avatarEl = document.getElementById('nav-avatar');
  if (avatarEl) avatarEl.textContent = (_state.user.firstName || '?')[0].toUpperCase();

  if (window._fb?.enabled) {
    await window._fb.updateProfile(_state.user.id, {
      firstName: _state.user.firstName,
      lastName:  _state.user.lastName,
      email:     _state.user.email,
      bio:       _state.user.bio,
    });
  }
  saveState();
  toast('Settings saved', 'success');
};