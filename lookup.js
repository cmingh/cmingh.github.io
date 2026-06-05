// js/lookup.js
// ─────────────────────────────────────────────────────────────
// API lookups: barcode → Open Library / UPCitemdb / Internet Archive
// and title search → Open Library for book cover scan
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES } from './state.js';
import { toast, switchTab } from './ui.js';
import { showScanStatus, showCoverScanStatus } from './scanner.js';
import { buildManualForm } from './forms.js';

// ═══════════════════════════════════════════════════════════════
// BARCODE LOOKUP — the main entry point called by scanner.js
// ═══════════════════════════════════════════════════════════════

/**
 * Look up a barcode/ISBN via available APIs.
 * @param {string} [codeOverride] - Pass directly from camera scan; otherwise reads the manual input.
 */
export async function lookupBarcode(codeOverride) {
  // 1. Resolve the raw value
  const inputEl = document.getElementById('barcode-manual');
  const raw = codeOverride || (inputEl ? inputEl.value.trim() : '');

  if (!raw) {
    toast('Enter a barcode or ISBN first', 'error');
    return;
  }

  // 2. Sanitise — strip spaces and hyphens
  const code = raw.replace(/[\s\-]/g, '');
  console.log('[lookup] Checking barcode:', code);

  // 3. Validate: must be 8–14 digits
  if (!/^\d{8,14}$/.test(code)) {
    showScanStatus('no-match',
      `<strong>⚠ "${raw}" doesn't look like a valid barcode.</strong>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">
         Barcodes are 8–14 digits. Check the number and try again, or use Manual entry.
       </span>`
    );
    return;
  }

  // 4. Show loading state
  showScanStatus('loading', `<span class="spin">⏳</span> Looking up <span class="mono">${code}</span>…`);
  const resultEl = document.getElementById('scan-result');
  if (resultEl) resultEl.style.display = '';

  // 5. Determine ISBN vs generic UPC
  const isISBN = code.length === 10 ||
    (code.length === 13 && (code.startsWith('978') || code.startsWith('979')));

  // 6. Try sources in priority order
  let result = null;
  if (isISBN) {
    result = await _lookupOpenLibrary(code);
    if (!result) result = await _lookupInternetArchive(code);
  }
  if (!result) result = await _lookupUPCitemdb(code);
  if (!result && !isISBN) result = await _lookupInternetArchive(code);

  // 7. Render result or failure
  if (result) {
    _state.lookupResult = { ...result, barcode: code };
    _renderLookupResult(result, code);
  } else {
    showScanStatus('no-match',
      `<strong>ℹ No match found for <span class="mono">${code}</span>.</strong>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">
         Switching to Manual entry — fill in the details yourself.
       </span>`
    );
    // Auto-switch to manual and pre-fill whatever field makes sense
    setTimeout(() => {
      switchTab('manual-tab', 'add');
      const isbnF = document.querySelector('[data-field="isbn"]');
      const catF  = document.querySelector('[data-field="catalog"]');
      if (isbnF) isbnF.value = code;
      else if (catF) catF.value = code;
    }, 1400);
  }
}

// Apply a barcode lookup result to the manual form
export function applyLookupResult() {
  const r = _state.lookupResult;
  if (!r) return;

  // Switch to the suggested media type if different from current
  if (r.suggestedType && _state.selectedType?.id !== r.suggestedType) {
    const suggested = MEDIA_TYPES.find(m => m.id === r.suggestedType);
    if (suggested) { _state.selectedType = suggested; buildManualForm(); }
  }

  switchTab('manual-tab', 'add');
  _applyResultToForm(r);
  if (r.coverUrl) _fetchCoverAsDataUrl(r.coverUrl);
  toast('Details applied! Review and save.', 'success');
}

// ═══════════════════════════════════════════════════════════════
// BOOK TITLE SEARCH (used by book-cover scan tab)
// ═══════════════════════════════════════════════════════════════

export async function searchBookByTitle(queryOverride) {
  const query = queryOverride || document.getElementById('cover-title-input')?.value.trim();
  if (!query) { toast('Enter a title or author to search', 'error'); return; }

  showCoverScanStatus('loading', `<span class="spin">⏳</span> Searching for "<strong>${query}</strong>"…`);

  const resultsEl = document.getElementById('book-search-results');
  resultsEl.style.display = 'none';
  resultsEl.innerHTML = '';

  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5` +
      `&fields=title,author_name,publisher,first_publish_year,isbn,cover_i,number_of_pages,subject,language`;
    const r = await _fetchWithTimeout(url, 8000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    if (!data.docs?.length) {
      showCoverScanStatus('no-match',
        `<strong>ℹ No books found for "${query}".</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a different title, or use Manual entry.</span>`
      );
      return;
    }

    showCoverScanStatus('matched', `<strong>✓ Found ${Math.min(data.docs.length, 5)} results</strong> — tap one to apply:`);
    resultsEl.style.display = 'flex';
    resultsEl.innerHTML = data.docs.slice(0, 5).map((doc, idx) => {
      const title     = doc.title || 'Unknown Title';
      const author    = (doc.author_name || []).join(', ') || '';
      const year      = doc.first_publish_year || '';
      const publisher = (doc.publisher || [])[0] || '';
      const isbn      = (doc.isbn || [])[0] || '';
      const coverId   = doc.cover_i;
      const coverUrl  = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null;
      const thumbHtml = coverUrl
        ? `<img src="${coverUrl}" alt="${title}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📗'">`
        : '📗';

      // Encode result data as JSON in a data attribute (safe-escaped)
      const resultData = JSON.stringify({
        title, author, publisher, pub_year: year, isbn, coverUrl,
        pages:    doc.number_of_pages || '',
        language: (doc.language || [])[0] || '',
        genre:    (doc.subject || []).slice(0, 3).join(', '),
      }).replace(/'/g, '&apos;');

      return `<div class="book-scan-result-item" onclick="window.applyCoverSearchResult(${idx})"
                   data-result='${resultData}'>
        <div style="width:48px;height:68px;background:var(--bg2);border-radius:5px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:20px">${thumbHtml}</div>
        <div style="flex:1;min-width:0">
          <div class="fw-600" style="font-size:13px">${title}</div>
          ${author    ? `<div class="text-sm text-muted">${author}</div>`                         : ''}
          ${(publisher || year) ? `<div class="text-xs text-muted">${[publisher, year].filter(Boolean).join(' · ')}</div>` : ''}
          ${isbn      ? `<div class="text-xs mono" style="color:var(--text3)">ISBN ${isbn}</div>` : ''}
        </div>
        <button class="lookup-apply-btn" style="flex-shrink:0">Apply</button>
      </div>`;
    }).join('');

  } catch (e) {
    showCoverScanStatus('no-match',
      `<strong>⚠ Search failed.</strong>
       <br><span style="font-size:12px;color:var(--text2)">Check your connection, or use Manual entry.</span>`
    );
    console.error('Book search error:', e);
  }
}

export function applyCoverSearchResult(idx) {
  const items = document.querySelectorAll('.book-scan-result-item');
  if (!items[idx]) return;
  items.forEach(i => i.classList.remove('selected'));
  items[idx].classList.add('selected');

  let result;
  try {
    const raw = items[idx].dataset.result.replace(/&apos;/g, "'");
    result = JSON.parse(raw);
  } catch (e) { toast('Could not parse result', 'error'); return; }

  // Ensure we're in book mode
  if (_state.selectedType?.id !== 'book') {
    _state.selectedType = MEDIA_TYPES.find(m => m.id === 'book');
    buildManualForm();
  }

  switchTab('manual-tab', 'add');
  _state.lookupResult = { ...result, source: 'Open Library' };
  _applyResultToForm(result);
  if (result.coverUrl) _fetchCoverAsDataUrl(result.coverUrl);
  toast('Book details applied! Review and save.', 'success');
}

// Make applyCoverSearchResult available to inline onclick handlers
window.applyCoverSearchResult = applyCoverSearchResult;

// ═══════════════════════════════════════════════════════════════
// INTERNAL — API fetchers
// ═══════════════════════════════════════════════════════════════

async function _lookupOpenLibrary(isbn) {
  try {
    const r = await _fetchWithTimeout(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
    );
    if (!r.ok) return null;
    const data = await r.json();
    const key  = `ISBN:${isbn}`;
    if (!data[key]) return null;
    const b = data[key];

    // b.cover is a plain object {large, medium, small}
    const coverUrl = b.cover
      ? (b.cover.large || b.cover.medium || b.cover.small || null)
      : null;

    return {
      source:       'Open Library',
      title:        b.title || '',
      author:       b.authors   ? b.authors.map(a => a.name).join(', ') : '',
      publisher:    b.publishers ? b.publishers.map(p => p.name).join(', ') : '',
      pub_year:     b.publish_date?.match(/\d{4}/)?.[0] || '',
      isbn,
      pages:        b.number_of_pages?.toString() || '',
      language:     b.language?.key?.replace('/languages/', '').toUpperCase() || '',
      genre:        b.subjects ? b.subjects.slice(0, 3).map(s => typeof s === 'string' ? s : (s.name || '')).join(', ') : '',
      coverUrl,
      suggestedType: 'book',
      description:  b.excerpts?.[0]?.text || '',
    };
  } catch (e) { console.warn('OpenLibrary error:', e); return null; }
}

async function _lookupInternetArchive(code) {
  try {
    const r = await _fetchWithTimeout(`https://archive.org/metadata/isbn_${code}`, 5000);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.metadata) return null;
    const m = data.metadata;
    const val = v => Array.isArray(v) ? v[0] : (v || '');
    return {
      source:       'Internet Archive',
      title:        val(m.title),
      author:       Array.isArray(m.creator) ? m.creator.join(', ') : (m.creator || ''),
      publisher:    val(m.publisher),
      pub_year:     val(m.year),
      isbn:         code,
      language:     val(m.language),
      coverUrl:     null,
      suggestedType: 'book',
    };
  } catch (e) { console.warn('InternetArchive error:', e); return null; }
}

async function _lookupUPCitemdb(upc) {
  try {
    const r = await _fetchWithTimeout(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (data.code !== 'OK' || !data.items?.length) return null;

    const item = data.items[0];
    const cat  = (item.category || '').toLowerCase();
    let suggestedType = 'other';
    if      (cat.includes('book') || cat.includes('novel'))           suggestedType = 'book';
    else if (cat.includes('music') || cat.includes('cd'))             suggestedType = 'cd';
    else if (cat.includes('vinyl'))                                    suggestedType = 'vinyl';
    else if (cat.includes('dvd') || cat.includes('blu'))              suggestedType = 'dvd';
    else if (cat.includes('game') || cat.includes('video game'))      suggestedType = 'game';
    else if (cat.includes('cassette'))                                 suggestedType = 'cassette';
    else if (cat.includes('vhs'))                                      suggestedType = 'vhs';

    return {
      source:       'UPCitemdb',
      title:        item.title || '',
      author:       item.brand || '',
      publisher:    item.brand || '',
      pub_year:     '',
      description:  item.description || '',
      coverUrl:     item.images?.[0] || null,
      suggestedType,
      upc,
    };
  } catch (e) { console.warn('UPCitemdb error:', e); return null; }
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — helpers
// ═══════════════════════════════════════════════════════════════

// Wraps fetch with a timeout using AbortController (compatible with all modern browsers)
async function _fetchWithTimeout(url, ms = 7000) {
  const ctrl    = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timerId);
    return r;
  } catch (e) {
    clearTimeout(timerId);
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  }
}

// Render the found item card in the scan results area
function _renderLookupResult(result, code) {
  const thumbHtml = result.coverUrl
    ? `<img src="${result.coverUrl}" alt="${result.title}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📦'">`
    : (_state.selectedType?.icon || '📦');

  showScanStatus('matched',
    `<strong>✓ Found on ${result.source}</strong>
     <div class="lookup-result" onclick="window.applyLookupResult()">
       <div class="lookup-result-thumb">${thumbHtml}</div>
       <div style="flex:1;min-width:0">
         <div class="fw-600" style="margin-bottom:4px">${result.title || 'Untitled'}</div>
         ${result.author    ? `<div class="text-sm text-muted">${result.author}</div>` : ''}
         ${result.publisher ? `<div class="text-sm text-muted">${result.publisher}${result.pub_year ? ' · ' + result.pub_year : ''}</div>` : ''}
         ${result.pages     ? `<div class="text-xs text-muted">${result.pages} pages</div>` : ''}
         <button class="lookup-apply-btn" style="margin-top:10px">✓ Apply details</button>
       </div>
     </div>
     <div style="font-size:11px;color:var(--text3);margin-top:6px">Tap the card to pre-fill the form, then switch to Manual entry to review and save.</div>`
  );
}

// Populate the manual form fields from a lookup/search result
function _applyResultToForm(result) {
  const fieldMap = {
    title:'title', author:'author', publisher:'publisher', pub_year:'pub_year',
    isbn:'isbn', pages:'pages', language:'language', genre:'genre',
    artist:'artist', album:'album', year:'year',
  };
  Object.entries(fieldMap).forEach(([key, field]) => {
    if (!result[key]) return;
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el) el.value = result[key];
  });
  if (result.upc) {
    const catF = document.querySelector('[data-field="catalog"]');
    if (catF) catF.value = result.upc;
  }
}

// Fetch a cover image URL and store it as a base64 data URL
async function _fetchCoverAsDataUrl(url) {
  try {
    const res    = await fetch(url);
    const blob   = await res.blob();
    const reader = new FileReader();
    reader.onload = ev => {
      _state.editingItem._coverData = ev.target.result;
      const cp = document.getElementById('cover-preview');
      if (cp) cp.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    };
    reader.readAsDataURL(blob);
  } catch (_) { /* non-fatal: cover fetch failed silently */ }
}

// Expose to global scope for inline onclick handlers
window.applyLookupResult = applyLookupResult;