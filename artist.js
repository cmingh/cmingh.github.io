// js/artist.js
// ─────────────────────────────────────────────────────────────
// Artist view — browse all artists in the collection and see
// their associated works (albums, books, comics, etc.)
// ─────────────────────────────────────────────────────────────
// Features:
//  - Auto-extracts artist/author/creator fields from collection items
//  - Groups items by artist with counts
//  - Shows all creations for a selected artist
//  - Links to Discogs for music artists (enrichment)
//  - Search/filter artists by name
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES, FIELD_LABELS } from './state.js';
import { toast, openModal } from './ui.js';
import { discogsSearchByTitle } from './discogs.js';

// ── Internal: extract artist-like fields from an item ─────────
function _getItemArtist(item) {
  if (!item?.fields) return null;
  const f = item.fields;
  const type = item.type || '';
  const artistKeys = {
    cd: ['artist', 'album'], vinyl: ['artist', 'album'], cassette: ['artist', 'album'],
    book: ['author'], comic: ['writer', 'author', 'cover_artist', 'penciler', 'inker', 'colorist'],
    manga: ['author'], game: ['creator', 'publisher'], dvd: ['studio', 'creator'],
    vhs: ['studio', 'creator'], magazine: ['publisher'], newspaper: ['publisher'],
    photo: ['photographer', 'creator'], map: ['creator', 'publisher'], other: ['creator', 'author'],
  };
  const keys = artistKeys[type] || ['artist', 'author', 'creator'];
  for (const k of keys) { if (f[k] && f[k].trim()) return f[k].trim(); }
  for (const k of ['artist', 'author', 'creator', 'writer', 'studio', 'photographer', 'publisher']) {
    if (f[k] && f[k].trim()) return f[k].trim();
  }
  return null;
}

// ── Build artist index from collection items ──────────────────
function _buildArtistIndex(items) {
  const index = {};
  for (const item of items) {
    const name = _getItemArtist(item);
    if (!name) continue;
    const normalised = name.replace(/\s+/g, ' ').trim();
    if (!normalised) continue;
    if (!index[normalised]) {
      index[normalised] = { name: normalised, items: [], types: new Set(), count: 0 };
    }
    index[normalised].items.push(item);
    index[normalised].types.add(item.typeLabel || item.type);
    index[normalised].count++;
  }
  for (const name of Object.keys(index)) {
    index[name].items.sort((a, b) => {
      const ta = a.fields?.title || a.fields?.album || a.fields?.artist || '';
      const tb = b.fields?.title || b.fields?.album || b.fields?.artist || '';
      return ta.localeCompare(tb);
    });
    index[name].types = Array.from(index[name].types);
  }
  return index;
}

let _artistIndex = {};
let _currentArtist = null;

export function rebuildArtistIndex() { _artistIndex = _buildArtistIndex(_state.collection); _currentArtist = null; }
export function getArtistIndex() { return _artistIndex; }
export function getArtistNames(search) {
  if (search === undefined) search = '';
  const names = Object.keys(_artistIndex);
  if (!search) return names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const q = search.toLowerCase();
  return names.filter(n => n.toLowerCase().includes(q)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
export function getArtist(name) { return _artistIndex[name] || null; }
export function getCurrentArtist() { return _currentArtist; }
export function setCurrentArtist(name) { _currentArtist = _artistIndex[name] || null; }

// ── HTML escaping ─────────────────────────────────────────────
function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&#' + '39;');
}
function escAttr(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&' + 'amp;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&#' + '39;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;');
}
REPLACE

// ── RENDER: artist list grid ──────────────────────────────────
export function renderArtistList(containerId, search) {
  if (!containerId) containerId = 'artist-grid';
  if (search === undefined) search = '';
  const container = document.getElementById(containerId);
  if (!container) return;
  rebuildArtistIndex();
  const names = getArtistNames(search);
  if (names.length === 0) {
    container.innerHTML =
      '<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text3)">' +
        '<div style="font-size:48px;margin-bottom:16px;opacity:.4">\ud83c\udfa8</div>' +
        '<div class="serif" style="font-size:20px;margin-bottom:8px">' +
        (search ? 'No artists match "' + escHtml(search) + '"' : 'No artists in your collection') +
        '</div><div style="font-size:13px;">' +
        (search ? 'Try a different name.' : 'Add items with artist, author, or creator fields to see them here.') +
        '</div></div>';
    return;
  }
  container.innerHTML = names.map(function(name) {
    var artist = _artistIndex[name];
    var typesStr = artist.types.join(' \u00b7 ');
    var itemCount = artist.count;
    var thumbItem = artist.items[artist.items.length - 1];
    var thumbHtml = thumbItem && thumbItem.coverData
      ? '<img src="' + escAttr(thumbItem.coverData) + '" alt="' + escAttr(name) + '" style="width:100%;height:100%;object-fit:cover">'
      : '<span style="font-size:28px">\ud83c\udfa8</span>';
    return '<div class="artist-card fade-in" onclick="window.selectArtist(\'' + escAttr(name) + '\')">' +
      '<div class="artist-card-thumb">' + thumbHtml + '</div>' +
      '<div class="artist-card-info">' +
        '<div class="artist-card-name truncate">' + escHtml(name) + '</div>' +
        '<div class="artist-card-count">' + itemCount + ' item' + (itemCount !== 1 ? 's' : '') + '</div>' +
        '<div class="artist-card-types text-xs text-muted truncate">' + typesStr + '</div>' +
      '</div></div>';
  }).join('');
}

// ── RENDER: single artist detail ──────────────────────────────
export function renderArtistDetail(containerId, name) {
  if (!containerId) containerId = 'artist-detail';
  var container = document.getElementById(containerId);
  if (!container) return;
  rebuildArtistIndex();
  var artist = name ? _artistIndex[name] : _currentArtist;
  if (!artist) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">' +
      '<div style="font-size:32px;margin-bottom:10px">\ud83c\udfa8</div><div>Select an artist to view their creations</div></div>';
    return;
  }
  _currentArtist = artist;
  var existingDiscogs = container.querySelector('.discogs-results-section');
  if (existingDiscogs) existingDiscogs.remove();
  var headerHtml =
    '<div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;flex-wrap:wrap">' +
      '<div><button class="btn-ghost" onclick="window.showArtistList()" style="font-size:12px;margin-bottom:8px">\u2190 Back to all artists</button>' +
        '<div class="serif" style="font-size:24px;font-weight:600">' + escHtml(artist.name) + '</div>' +
        '<div style="color:var(--text2);font-size:13px;margin-top:4px">' +
        artist.count + ' item' + (artist.count !== 1 ? 's' : '') + ' \u00b7 ' + artist.types.join(' \u00b7 ') +
        '</div></div>' +
      '<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn-ghost" onclick="window.searchArtistDiscogs(\'' + escAttr(artist.name) + '\')" style="font-size:12px" title="Search Discogs for this artist">\ud83d\udd0d Search Discogs</button>' +
      '</div></div>';
  var itemsHtml = artist.items.map(function(item) {
    var title = item.fields && (item.fields.title || item.fields.album || item.fields.artist) || 'Untitled';
    var sub = item.fields && (item.fields.year || item.fields.pub_year || item.fields.label || item.fields.publisher) || '';
    var cover = item.coverData
      ? '<img src="' + escAttr(item.coverData) + '" alt="' + escAttr(title) + '" style="width:100%;height:100%;object-fit:cover">'
      : (item.icon || '\ud83d\udce6');
    return '<div class="col-item fade-in" onclick="window.openDetail(\'' + item.id + '\')" data-id="' + item.id + '">' +
      '<div class="col-thumb">' + cover + '<div class="col-badge">' + item.typeLabel + '</div></div>' +
      '<div class="col-info"><div class="col-title truncate">' + title + '</div>' +
      '<div class="col-meta truncate">' + sub + '</div></div></div>';
  }).join('');
  container.innerHTML = headerHtml + '<div class="artist-items-grid">' + itemsHtml + '</div>';
}

// ── Search Discogs for an artist ───────────────────────────────
export async function searchArtistDiscogs(artistName) {
  if (!artistName) return;
  toast('Searching Discogs for ' + artistName + '\u2026', '');
  try {
    var results = await discogsSearchByTitle(artistName);
    if (!results || results.length === 0) { toast('No Discogs results for ' + artistName, 'error'); return; }
    var detailContainer = document.getElementById('artist-detail');
    if (!detailContainer) return;
    var resultsHtml = results.slice(0, 5).map(function(r) {
      var thumb = r.coverUrl
        ? '<img src="' + escAttr(r.coverUrl) + '" alt="' + escAttr(r.album || r.title) + '" style="width:48px;height:48px;object-fit:cover;border-radius:5px">'
        : '<span style="font-size:24px">\ud83d\udcbf</span>';
      return '<div class="book-scan-result-item" style="cursor:default">' +
        '<div style="width:48px;height:48px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;border-radius:5px;background:var(--bg2)">' + thumb + '</div>' +
        '<div style="flex:1;min-width:0"><div class="fw-600" style="font-size:13px">' + escHtml(r.album || r.title) + '</div>' +
        '<div class="text-sm text-muted">' + (r.label ? escHtml(r.label) : '') + (r.year ? ' \u00b7 ' + r.year : '') + '</div>' +
        (r.format ? '<div class="text-xs text-muted">' + escHtml(r.format) + '</div>' : '') +
        '</div></div>';
    }).join('');
    var existingDiscogs = detailContainer.querySelector('.discogs-results-section');
    if (existingDiscogs) existingDiscogs.remove();
    var discogsSection = document.createElement('div');
    discogsSection.className = 'discogs-results-section';
    discogsSection.style.cssText = 'margin-top:24px;padding-top:20px;border-top:1px solid var(--border)';
    discogsSection.innerHTML =
      '<div style="font-size:13px;font-weight:600;margin-bottom:12px">\ud83d\udd0d Discogs results for <strong>' + escHtml(artistName) + '</strong></div>' +
      '<div class="flex-col gap-2">' + resultsHtml + '</div>' +
      '<div style="font-size:11px;color:var(--text3);margin-top:10px">Results from ' +
      '<a href="https://www.discogs.com" target="_blank" style="color:var(--accent)">Discogs</a> \u00b7 ' +
      '<a href="https://www.discogs.com/search/?q=' + encodeURIComponent(artistName) + '&type=artist" target="_blank" style="color:var(--accent)">View all on Discogs</a></div>';
    detailContainer.appendChild(discogsSection);
    toast('Discogs results loaded', 'success');
  } catch (e) { console.warn('[artist] Discogs search error:', e.message); toast('Discogs search failed', 'error'); }
}

// ── Global window bindings ────────────────────────────────────
window.selectArtist = function(name) {
  setCurrentArtist(name);
  var gridEl = document.getElementById('artist-grid');
  var detailEl = document.getElementById('artist-detail');
  if (gridEl) gridEl.style.display = 'none';
  if (detailEl) { detailEl.style.display = ''; detailEl.innerHTML = ''; }
  var discogsSections = document.querySelectorAll('.discogs-results-section');
  discogsSections.forEach(function(el) { el.remove(); });
  renderArtistDetail('artist-detail', name);
};

window.showArtistList = function() {
  _currentArtist = null;
  var gridEl = document.getElementById('artist-grid');
  var detailEl = document.getElementById('artist-detail');
  if (detailEl) { detailEl.style.display = 'none'; detailEl.innerHTML = ''; }
  if (gridEl) gridEl.style.display = '';
  var discogsSections = document.querySelectorAll('.discogs-results-section');
  discogsSections.forEach(function(el) { el.remove(); });
  renderArtistList('artist-grid');
};

window.searchArtistDiscogs = function(name) { searchArtistDiscogs(name); };

window.filterArtists = function() {
  var searchEl = document.getElementById('artist-search');
  var query = searchEl ? searchEl.value.trim() : '';
  var gridEl = document.getElementById('artist-grid');
  var detailEl = document.getElementById('artist-detail');
  if (gridEl) gridEl.style.display = '';
  if (detailEl) { detailEl.style.display = 'none'; detailEl.innerHTML = ''; }
  var discogsSections = document.querySelectorAll('.discogs-results-section');
  discogsSections.forEach(function(el) { el.remove(); });
  renderArtistList('artist-grid', query);
};

// ── Init ──────────────────────────────────────────────────────
export function initArtistView() {
  rebuildArtistIndex();
  renderArtistList('artist-grid');
  var detailEl = document.getElementById('artist-detail');
  if (detailEl) detailEl.style.display = 'none';
}