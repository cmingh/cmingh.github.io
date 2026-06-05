// js/collection.js
// ─────────────────────────────────────────────────────────────
// Collection CRUD, rendering (grid + list), item detail modal
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES, FIELD_LABELS } from './state.js';
import { saveState } from './storage.js';
import { toast, openModal, closeModal, switchTab, openAddModal } from './ui.js';
import { _comicTagSelected, resetComicTags } from './forms.js';

// ═══════════════════════════════════════════════════════════════
// SAVE
// ═══════════════════════════════════════════════════════════════

export async function saveItem() {
  if (!_state.selectedType) { toast('Please select a media type', 'error'); return; }

  const isEdit = Boolean(_state.editingItem?.id);
  const item = {
    id:        isEdit ? _state.editingItem.id : 'i' + Date.now(),
    type:      _state.selectedType.id,
    typeLabel: _state.selectedType.label,
    icon:      _state.selectedType.icon,
    dateAdded: _state.editingItem?.dateAdded || new Date().toISOString(),
    coverData: _state.editingItem._coverData || null,
    fields:    {},
    comicTags: JSON.parse(JSON.stringify(_comicTagSelected)),
    source:    _state.lookupResult?.source || _state.editingItem?.source || 'manual',
  };

  // Collect all [data-field] inputs
  document.querySelectorAll('[data-field]').forEach(el => {
    if (el.dataset.field) item.fields[el.dataset.field] = el.value || '';
  });

  // Merge comic tag selections into fields
  Object.keys(_comicTagSelected).forEach(k => {
    item.fields[k] = Array.isArray(_comicTagSelected[k])
      ? _comicTagSelected[k].join(', ')
      : _comicTagSelected[k];
  });

  const title = item.fields.title || item.fields.album || item.fields.artist || item.fields.subject || '';
  if (!title.trim()) { toast('Please enter at least a title or artist name', 'error'); return; }

  if (window._fb?.enabled) {
    try { await window._fb.saveItem(item); }
    catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  } else {
    const idx = _state.collection.findIndex(i => i.id === item.id);
    if (idx > -1) _state.collection[idx] = item;
    else _state.collection.unshift(item);
    saveState();
  }

  closeModal('modal-add');
  renderCollection();
  toast('Added to your collection!', 'success');
  resetComicTags();
  _state.lookupResult = null;
}
window.saveItem = saveItem;

// ═══════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════

export async function deleteItem() {
  if (!_state.detailItem) return;
  if (window._fb?.enabled) {
    try { await window._fb.deleteItem(_state.detailItem.id); }
    catch (e) { toast('Delete failed: ' + e.message, 'error'); return; }
  } else {
    _state.collection = _state.collection.filter(i => i.id !== _state.detailItem.id);
    saveState();
  }
  closeModal('modal-detail');
  renderCollection();
  toast('Item removed', 'success');
}
window.deleteItem = deleteItem;

// ═══════════════════════════════════════════════════════════════
// GRID / LIST TOGGLE
// FIX: renamed from setView → setCollectionView to avoid clashing
// with old HTML `setView('login')` navigation calls.
// ═══════════════════════════════════════════════════════════════

export function setCollectionView(v) {
  _state.view = v;
  document.getElementById('vt-grid')?.classList.toggle('active', v === 'grid');
  document.getElementById('vt-list')?.classList.toggle('active', v === 'list');
  const grid = document.getElementById('col-grid');
  const list = document.getElementById('col-list');
  if (grid) grid.style.display = v === 'grid' ? '' : 'none';
  if (list) list.style.display = v === 'list' ? '' : 'none';
}
window.setCollectionView = setCollectionView;

// ═══════════════════════════════════════════════════════════════
// RENDER COLLECTION
// ═══════════════════════════════════════════════════════════════

export function renderCollection() {
  if (!_state.user) return;

  const search = document.getElementById('col-search')?.value?.toLowerCase() || '';
  const typeF  = document.getElementById('col-filter-type')?.value || '';
  const sortV  = document.getElementById('col-sort')?.value || 'date-added';

  let items = [..._state.collection];

  if (search) items = items.filter(i =>
    (i.fields?.title || i.fields?.album || i.fields?.artist || i.fields?.author || '')
      .toLowerCase().includes(search) ||
    (i.typeLabel || '').toLowerCase().includes(search)
  );
  if (typeF) items = items.filter(i => i.type === typeF);

  items.sort((a, b) => {
    const fa = a.fields || {}, fb = b.fields || {};
    switch (sortV) {
      case 'title':    return (fa.title || fa.album || fa.artist || '').localeCompare(fb.title || fb.album || fb.artist || '');
      case 'author':   return (fa.author || fa.artist || '').localeCompare(fb.author || fb.artist || '');
      case 'pub-date': return (fa.pub_date || fa.year || fa.pub_year || '0').localeCompare(fb.pub_date || fb.year || fb.pub_year || '0');
      case 'condition':return (fa.condition || '').localeCompare(fb.condition || '');
      case 'type':     return a.typeLabel.localeCompare(b.typeLabel);
      default: {
        // Handle Firestore Timestamps (.toDate()) vs ISO strings
        const dateA = a.dateAdded?.toDate ? a.dateAdded.toDate() : new Date(a.dateAdded || 0);
        const dateB = b.dateAdded?.toDate ? b.dateAdded.toDate() : new Date(b.dateAdded || 0);
        return dateB - dateA;
      }
    }
  });

  const grid  = document.getElementById('col-grid');
  const list  = document.getElementById('col-list');
  const empty = document.getElementById('col-empty');

  if (items.length === 0) {
    if (grid)  grid.innerHTML  = '';
    if (list)  list.innerHTML  = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  if (grid) {
    grid.innerHTML = items.map(_colItemHtml).join('');
    grid.querySelectorAll('.col-item').forEach(el =>
      el.addEventListener('click', () => openDetail(el.dataset.id))
    );
  }

  if (list) {
    list.innerHTML = items.map(_colListHtml).join('');
    list.querySelectorAll('.col-list-item').forEach(el =>
      el.addEventListener('click', () => openDetail(el.dataset.id))
    );
  }
}
window.renderCollection = renderCollection;

function _colItemHtml(i) {
  const title = i.fields?.title || i.fields?.album || i.fields?.artist || 'Untitled';
  const sub   = i.fields?.author || i.fields?.artist || i.fields?.writer || i.fields?.year || '';
  const cover = i.coverData ? `<img src="${i.coverData}" alt="${title}">` : i.icon;
  return `<div class="col-item fade-in" data-id="${i.id}">
    <div class="col-thumb">${cover}<div class="col-badge">${i.typeLabel}</div></div>
    <div class="col-info">
      <div class="col-title truncate">${title}</div>
      <div class="col-meta truncate">${sub}</div>
    </div>
  </div>`;
}

function _colListHtml(i) {
  const title = i.fields?.title || i.fields?.album || i.fields?.artist || 'Untitled';
  const sub   = i.fields?.author || i.fields?.artist || '';
  const yr    = i.fields?.year || i.fields?.pub_year || i.fields?.pub_date || '';
  const cover = i.coverData ? `<img src="${i.coverData}" alt="${title}">` : i.icon;
  const src   = i.source && i.source !== 'manual'
    ? `<span class="badge badge-success">${i.source}</span>` : '';
  return `<div class="col-list-item" data-id="${i.id}">
    <div class="col-list-thumb">${cover}</div>
    <div style="flex:1;min-width:0">
      <div class="fw-500 truncate">${title}</div>
      <div class="text-sm text-muted truncate">${sub}${sub && yr ? ' · ' : ''}${yr}</div>
    </div>
    <div class="badge badge-muted">${i.typeLabel}</div>
    ${src}
    ${i.fields?.condition ? `<div class="text-xs text-muted">${i.fields.condition}</div>` : ''}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
// DETAIL MODAL
// ═══════════════════════════════════════════════════════════════

export function openDetail(id) {
  const item = _state.collection.find(i => i.id === id);
  if (!item) return;
  _state.detailItem = item;

  const title   = item.fields?.title || item.fields?.album || item.fields?.artist || 'Untitled';
  const titleEl = document.getElementById('detail-title');
  if (titleEl) titleEl.textContent = title;

  const coverEl = document.getElementById('detail-cover');
  if (coverEl) {
    if (item.coverData) {
      coverEl.innerHTML = `<img src="${item.coverData}" alt="${title}" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`;
    } else {
      coverEl.innerHTML    = item.icon;
      coverEl.style.fontSize = '56px';
    }
  }

  const skip    = ['notes', '_coverData'];
  const metaEl  = document.getElementById('detail-meta');
  if (metaEl) {
    metaEl.innerHTML =
      `<tr><td>Type</td><td>${item.typeLabel}</td></tr>` +
      (item.source && item.source !== 'manual' ? `<tr><td>Source</td><td>${item.source}</td></tr>` : '') +
      Object.entries(item.fields || {})
        .filter(([k, v]) => v && !skip.includes(k))
        .map(([k, v]) => `<tr><td>${FIELD_LABELS[k] || k}</td><td>${v}</td></tr>`)
        .join('');
  }

  const extraEl = document.getElementById('detail-extra');
  if (extraEl) {
    extraEl.innerHTML = item.fields?.notes
      ? `<div style="font-size:12px;color:var(--text2);padding:12px;background:var(--bg3);border-radius:8px">${item.fields.notes}</div>`
      : '';
  }

  _handleDetailResponsive();
  openModal('modal-detail');
}
window.openDetail = openDetail;

export function openEditItem(id) {
  const item = _state.collection.find(i => i.id === id);
  if (!item) return;
  openAddModal(item);
}
window.openEditItem = openEditItem;

function _handleDetailResponsive() {
  const isMobile = window.innerWidth < 600;
  const sideCol  = document.getElementById('detail-cover-col');
  const mobAct   = document.getElementById('detail-actions-mobile');
  const grid     = document.getElementById('detail-inner-grid');
  if (!sideCol || !mobAct || !grid) return;
  if (isMobile) {
    sideCol.style.display      = 'none';
    mobAct.style.display       = 'flex';
    mobAct.style.flexDirection = 'column';
    mobAct.style.gap           = '8px';
    grid.style.gridTemplateColumns = '1fr';
  } else {
    sideCol.style.display  = '';
    mobAct.style.display   = 'none';
    grid.style.gridTemplateColumns = '160px 1fr';
  }
}
window.addEventListener('resize', _handleDetailResponsive);