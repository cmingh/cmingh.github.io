// js/lookup.js  (v3 — per-type API routing, no more OpenLibrary for everything)
// ─────────────────────────────────────────────────────────────
// Barcode lookup pipeline (called after the scanner decodes a code):
//
//  MUSIC  (CD / vinyl / cassette)
//    1. MusicBrainz  — release?barcode=  (best music DB, free, no key)
//    2. UPCitemdb    — universal fallback
//
//  BOOKS  (book / comic / manga / magazine / newspaper)
//    1. Open Library — ISBN API
//    2. Google Books — ISBN API
//    3. Internet Archive — ISBN metadata
//    4. UPCitemdb    — for non-ISBN barcodes
//
//  GAMES  (video game)
//    1. UPCitemdb    — covers games well (100/day free)
//    2. Internet Archive metadata fallback
//
//  VIDEO  (dvd / blu-ray / vhs)
//    1. UPCitemdb    — great movie/show coverage
//    2. Internet Archive
//
//  EVERYTHING ELSE
//    1. UPCitemdb    — 708 M+ products, covers almost anything
//    2. Internet Archive
//
// Title search (cover-scan tab):
//   MusicBrainz search for music types, Open Library for everything else.
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES } from './state.js';
import { toast, switchTab } from './ui.js';
import { showScanStatus, showCoverScanStatus } from './scanner.js';
import { buildManualForm } from './forms.js';

// ── Type-group helpers ────────────────────────────────────────
const MUSIC_TYPES  = new Set(['cd', 'vinyl', 'cassette']);
const BOOK_TYPES   = new Set(['book', 'comic', 'manga', 'magazine', 'newspaper']);
const GAME_TYPES   = new Set(['game']);
const VIDEO_TYPES  = new Set(['dvd', 'vhs']);

function _currentTypeId() {
  return _state.selectedType?.id || null;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC: lookupBarcode
// Called by scanner.js after a barcode is successfully decoded.
// ═══════════════════════════════════════════════════════════════

export async function lookupBarcode(codeOverride) {
  const inputEl = document.getElementById('barcode-manual');
  const raw     = codeOverride || (inputEl ? inputEl.value.trim() : '');

  if (!raw) { toast('Enter a barcode or ISBN first', 'error'); return; }

  // Sanitise — strip spaces and hyphens
  const code = raw.replace(/[\s\-]/g, '');
  console.log('[lookup] barcode:', code, '| type:', _currentTypeId());

  // Validate: 8–14 digits
  if (!/^\d{8,14}$/.test(code)) {
    showScanStatus('no-match',
      `<strong>⚠ "${raw}" doesn't look like a valid barcode.</strong>
       <br><span style="color:var(--text2);font-size:12px;display:block;margin-top:4px">
         Barcodes are 8–14 digits. Check the number and try again, or use Manual entry.
       </span>`
    );
    return;
  }

  showScanStatus('loading', `<span class="spin">⏳</span> Looking up <span class="mono">${code}</span>…`);
  const resultEl = document.getElementById('scan-result');
  if (resultEl) resultEl.style.display = '';

  const isISBN = code.length === 10 ||
    (code.length === 13 && (code.startsWith('978') || code.startsWith('979')));

  let result = null;
  try {
    result = await Promise.race([
      _routedLookup(code, isISBN),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Lookup timeout')), 18000)),
    ]);
  } catch (e) {
    console.warn('[lookup] chain timeout or error:', e);
    result = null;
  }

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
    setTimeout(() => {
      switchTab('manual-tab', 'add');
      // Pre-fill whichever identifier field makes sense
      const isbnF = document.querySelector('[data-field="isbn"]');
      const catF  = document.querySelector('[data-field="catalog"]');
      if (isbnF && isISBN) isbnF.value = code;
      else if (catF) catF.value = code;
      else if (isbnF) isbnF.value = code;
    }, 1400);
  }
}
window.lookupBarcode = lookupBarcode;

// ── Routing: pick the right API chain for the selected type ──
async function _routedLookup(code, isISBN) {
  const typeId = _currentTypeId();
  let result   = null;

  if (MUSIC_TYPES.has(typeId)) {
    // ── Music: MusicBrainz first ──────────────────────────
    result = await _lookupMusicBrainz(code);
    if (!result) result = await _lookupUPCitemdb(code);

  } else if (BOOK_TYPES.has(typeId) || isISBN) {
    // ── Books / ISBN: Open Library → Google Books → IA → UPC
    if (isISBN) {
      result = await _lookupOpenLibrary(code);
      if (!result) result = await _lookupGoogleBooks(code);
      if (!result) result = await _lookupInternetArchive(code);
    }
    if (!result) result = await _lookupUPCitemdb(code);

  } else if (GAME_TYPES.has(typeId)) {
    // ── Games: UPCitemdb (best coverage for UPC game barcodes)
    result = await _lookupUPCitemdb(code);
    if (!result) result = await _lookupInternetArchive(code);

  } else if (VIDEO_TYPES.has(typeId)) {
    // ── DVD / VHS: UPCitemdb → IA ─────────────────────────
    result = await _lookupUPCitemdb(code);
    if (!result) result = await _lookupInternetArchive(code);

  } else {
    // ── Unknown / Other: try everything ──────────────────
    // ISBN check first since it narrows the search
    if (isISBN) {
      result = await _lookupOpenLibrary(code);
      if (!result) result = await _lookupGoogleBooks(code);
    }
    if (!result) result = await _lookupMusicBrainz(code);
    if (!result) result = await _lookupUPCitemdb(code);
    if (!result && isISBN) result = await _lookupInternetArchive(code);
  }

  return result;
}

// ── Apply a result to the manual form ────────────────────────
export function applyLookupResult() {
  const r = _state.lookupResult;
  if (!r) return;

  if (r.suggestedType && _state.selectedType?.id !== r.suggestedType) {
    const suggested = MEDIA_TYPES.find(m => m.id === r.suggestedType);
    if (suggested) { _state.selectedType = suggested; buildManualForm(); }
  }

  switchTab('manual-tab', 'add');
  _applyResultToForm(r);
  if (r.coverUrl) _fetchCoverAsDataUrl(r.coverUrl);
  toast('Details applied! Review and save.', 'success');
}
window.applyLookupResult = applyLookupResult;

// ═══════════════════════════════════════════════════════════════
// TITLE SEARCH (cover-scan tab) — routes by media type
// ═══════════════════════════════════════════════════════════════

export async function searchMediaByTitle(queryOverride) {
  const query = queryOverride || document.getElementById('cover-title-input')?.value.trim();
  if (!query) { toast('Enter a title, artist, or name to search', 'error'); return; }

  const typeId = _currentTypeId();

  if (MUSIC_TYPES.has(typeId)) {
    return _searchMusicBrainzByTitle(query, typeId);
  }
  // Everything else uses Open Library (books, comics, manga, etc.)
  return searchBookByTitle(query);
}
window.searchMediaByTitle = searchMediaByTitle;

// ═══════════════════════════════════════════════════════════════
// BOOK / OPEN LIBRARY TITLE SEARCH (unchanged, works well)
// ═══════════════════════════════════════════════════════════════

let __bookSearchResults = [];

export async function searchBookByTitle(queryOverride) {
  const query = queryOverride || document.getElementById('cover-title-input')?.value.trim();
  if (!query) { toast('Enter a title or author to search', 'error'); return; }

  showCoverScanStatus('loading', `<span class="spin">⏳</span> Searching for "<strong>${query}</strong>"…`);

  const resultsEl = document.getElementById('book-search-results');
  if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }

  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5` +
      `&fields=title,author_name,publisher,first_publish_year,isbn,cover_i,number_of_pages,subject,language`;
    const r = await _fetchWithTimeout(url, 7000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    if (!data.docs?.length) {
      showCoverScanStatus('no-match',
        `<strong>ℹ No results found for "${query}".</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a different title, or use Manual entry.</span>`
      );
      return;
    }

    __bookSearchResults = data.docs.slice(0, 5).map(doc => ({
      title:     doc.title || 'Unknown Title',
      author:    (doc.author_name || []).join(', ') || '',
      year:      doc.first_publish_year || '',
      publisher: (doc.publisher || [])[0] || '',
      isbn:      (doc.isbn || [])[0] || '',
      coverUrl:  doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
      pages:     doc.number_of_pages || '',
      language:  (doc.language || [])[0] || '',
      genre:     (doc.subject || []).slice(0, 3).join(', '),
    }));

    if (resultsEl) {
      showCoverScanStatus('matched', `<strong>✓ Found ${__bookSearchResults.length} results</strong> — tap one to apply:`);
      resultsEl.style.display = 'flex';
      resultsEl.innerHTML = __bookSearchResults.map((doc, idx) => {
        const thumbHtml = doc.coverUrl
          ? `<img src="${doc.coverUrl}" alt="${doc.title}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📗'">`
          : '📗';
        return `<div class="book-scan-result-item" onclick="window.applyCoverSearchResult(${idx})">
          <div style="width:48px;height:68px;background:var(--bg2);border-radius:5px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:20px">${thumbHtml}</div>
          <div style="flex:1;min-width:0">
            <div class="fw-600" style="font-size:13px">${doc.title}</div>
            ${doc.author    ? `<div class="text-sm text-muted">${doc.author}</div>` : ''}
            ${(doc.publisher || doc.year) ? `<div class="text-xs text-muted">${[doc.publisher, doc.year].filter(Boolean).join(' · ')}</div>` : ''}
            ${doc.isbn      ? `<div class="text-xs mono" style="color:var(--text3)">ISBN ${doc.isbn}</div>` : ''}
          </div>
          <button class="lookup-apply-btn" style="flex-shrink:0">Apply</button>
        </div>`;
      }).join('');
    }
  } catch (e) {
    showCoverScanStatus('no-match',
      `<strong>⚠ Search failed.</strong>
       <br><span style="font-size:12px;color:var(--text2)">Check your connection, or use Manual entry.</span>`
    );
    console.error('[lookup] Book search error:', e);
  }
}
window.searchBookByTitle = searchBookByTitle;

export function applyCoverSearchResult(idx) {
  const result = __bookSearchResults[idx];
  if (!result) { toast('Could not find that search result', 'error'); return; }
  switchTab('manual-tab', 'add');
  _state.lookupResult = { ...result, source: 'Open Library' };
  _applyResultToForm(result);
  if (result.coverUrl) _fetchCoverAsDataUrl(result.coverUrl);
  toast('Details applied! Review and save.', 'success');
}
window.applyCoverSearchResult = applyCoverSearchResult;

// ═══════════════════════════════════════════════════════════════
// MUSICBRAINZ TITLE SEARCH (for music cover-scan tab)
// ═══════════════════════════════════════════════════════════════

let __musicSearchResults = [];

async function _searchMusicBrainzByTitle(query, typeId) {
  showCoverScanStatus('loading', `<span class="spin">⏳</span> Searching MusicBrainz for "<strong>${query}</strong>"…`);

  const resultsEl = document.getElementById('book-search-results');
  if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }

  try {
    // Search releases by title+artist query
    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&limit=5&fmt=json`;
    const r   = await _fetchWithTimeout(url, 7000, { 'User-Agent': 'MediaNest/1.0 (collection app)' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    if (!data.releases?.length) {
      showCoverScanStatus('no-match',
        `<strong>ℹ No results found for "${query}".</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a different title or artist, or use Manual entry.</span>`
      );
      return;
    }

    __musicSearchResults = data.releases.slice(0, 5).map(rel => {
      const artistName = rel['artist-credit']?.[0]?.artist?.name ||
                         rel['artist-credit']?.[0]?.name || '';
      const label      = rel['label-info']?.[0]?.label?.name || '';
      const catNum     = rel['label-info']?.[0]?.['catalog-number'] || '';
      return {
        title:        rel.title || '',
        artist:       artistName,
        year:         (rel.date || '').substring(0, 4),
        label,
        catalog:      catNum,
        country:      rel.country || '',
        pressing:     rel.country || '',
        format:       rel.media?.[0]?.format || '',
        barcode:      rel.barcode || '',
        mbid:         rel.id,
        coverUrl:     rel.id
          ? `https://coverartarchive.org/release/${rel.id}/front-250`
          : null,
        source:       'MusicBrainz',
        suggestedType: typeId || _mbFormatToType(rel.media?.[0]?.format),
      };
    });

    if (resultsEl) {
      showCoverScanStatus('matched', `<strong>✓ Found ${__musicSearchResults.length} results</strong> — tap one to apply:`);
      resultsEl.style.display = 'flex';
      resultsEl.innerHTML = __musicSearchResults.map((rel, idx) => {
        const thumbHtml = rel.coverUrl
          ? `<img src="${rel.coverUrl}" alt="${rel.title}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='🎵'">`
          : '🎵';
        return `<div class="book-scan-result-item" onclick="window._applyMusicSearchResult(${idx})">
          <div style="width:48px;height:48px;background:var(--bg2);border-radius:5px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:20px">${thumbHtml}</div>
          <div style="flex:1;min-width:0">
            <div class="fw-600" style="font-size:13px">${rel.title}</div>
            ${rel.artist ? `<div class="text-sm text-muted">${rel.artist}</div>` : ''}
            ${(rel.label || rel.year) ? `<div class="text-xs text-muted">${[rel.label, rel.year, rel.country].filter(Boolean).join(' · ')}</div>` : ''}
            ${rel.format ? `<div class="text-xs mono" style="color:var(--text3)">${rel.format}</div>` : ''}
          </div>
          <button class="lookup-apply-btn" style="flex-shrink:0">Apply</button>
        </div>`;
      }).join('');
    }
  } catch (e) {
    showCoverScanStatus('no-match',
      `<strong>⚠ MusicBrainz search failed.</strong>
       <br><span style="font-size:12px;color:var(--text2)">Check your connection, or use Manual entry.</span>`
    );
    console.error('[lookup] MusicBrainz search error:', e);
  }
}

window._applyMusicSearchResult = function(idx) {
  const result = __musicSearchResults[idx];
  if (!result) { toast('Could not find that result', 'error'); return; }
  switchTab('manual-tab', 'add');
  _state.lookupResult = result;
  _applyResultToForm(result);
  if (result.coverUrl) _fetchCoverAsDataUrl(result.coverUrl);
  toast('Details applied! Review and save.', 'success');
};

// ═══════════════════════════════════════════════════════════════
// API FETCHERS
// ═══════════════════════════════════════════════════════════════

// ── MusicBrainz — barcode lookup ─────────────────────────────
// Free, no key required. Rate limit: 1 req/sec (we stay well under).
// Returns rich data for CDs, vinyl, cassettes.
async function _lookupMusicBrainz(barcode) {
  try {
    // Search for release with this exact barcode
    const url  = `https://musicbrainz.org/ws/2/release/?query=barcode:${barcode}&limit=1&fmt=json`;
    const r    = await _fetchWithTimeout(url, 6000, { 'User-Agent': 'MediaNest/1.0 (collection app)' });
    if (!r.ok) return null;
    const data = await r.json();

    if (!data.releases?.length) return null;
    const rel  = data.releases[0];

    // Pull artist name from the first credit slot
    const artistName = rel['artist-credit']?.[0]?.artist?.name ||
                       rel['artist-credit']?.[0]?.name || '';

    // Label + catalog number
    const labelInfo  = rel['label-info']?.[0] || {};
    const labelName  = labelInfo.label?.name || '';
    const catNum     = labelInfo['catalog-number'] || '';

    // Preferred cover: Cover Art Archive (CAA) front image
    const mbid     = rel.id;
    const coverUrl = mbid
      ? `https://coverartarchive.org/release/${mbid}/front-250`
      : null;

    // Detect format → media type
    const format      = rel.media?.[0]?.format || '';
    const suggestedType = _mbFormatToType(format);

    return {
      source:        'MusicBrainz',
      title:         rel.title || '',
      album:         rel.title || '',
      artist:        artistName,
      year:          (rel.date || '').substring(0, 4),
      label:         labelName,
      catalog:       catNum,
      pressing:      rel.country || '',
      country:       rel.country || '',
      format,
      barcode,
      coverUrl,
      suggestedType,
    };
  } catch (e) {
    console.warn('[lookup] MusicBrainz error:', e.message);
    return null;
  }
}

/** Map a MusicBrainz format string to our internal type id */
function _mbFormatToType(format) {
  if (!format) return null;
  const f = format.toLowerCase();
  if (f.includes('vinyl') || f.includes('lp') || f.includes('ep') ||
      f.includes('7"') || f.includes('10"') || f.includes('12"'))  return 'vinyl';
  if (f.includes('cassette') || f.includes('tape'))                 return 'cassette';
  if (f.includes('cd') || f.includes('disc'))                       return 'cd';
  return 'cd'; // default for unrecognised music formats
}

// ── Open Library — ISBN ───────────────────────────────────────
async function _lookupOpenLibrary(isbn) {
  try {
    const r = await _fetchWithTimeout(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, 5000
    );
    if (!r.ok) return null;
    const data = await r.json();
    const b    = data[`ISBN:${isbn}`];
    if (!b) return null;

    const coverUrl = b.cover
      ? (b.cover.large || b.cover.medium || b.cover.small || null)
      : null;

    const genres = (b.subjects || [])
      .slice(0, 5)
      .map(s => typeof s === 'string' ? s : (s.name || ''))
      .filter(s => s && !/^(Fiction|Biography|Juvenile|Young adult)/i.test(s))
      .slice(0, 3).join(', ');

    let language = '';
    if (b.language) {
      const lang = typeof b.language === 'string'
        ? b.language
        : (b.language.key || (Array.isArray(b.language) && b.language[0]) || '');
      language = String(lang).replace('/languages/', '').toUpperCase();
    }

    return {
      source:        'Open Library',
      title:         b.title || '',
      author:        b.authors ? b.authors.map(a => a.name).join(', ') : '',
      publisher:     b.publishers ? b.publishers.map(p => p.name).join(', ') : '',
      pub_year:      b.publish_date?.match(/\d{4}/)?.[0] || '',
      isbn,
      pages:         b.number_of_pages?.toString() || '',
      language,
      genre:         genres,
      coverUrl,
      suggestedType: 'book',
      description:   b.excerpts?.[0]?.text || '',
    };
  } catch (e) {
    console.warn('[lookup] OpenLibrary error:', e.message);
    return null;
  }
}

// ── Google Books — ISBN ───────────────────────────────────────
async function _lookupGoogleBooks(isbn) {
  try {
    const r = await _fetchWithTimeout(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, 5000
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.items?.length) return null;
    const book = data.items[0].volumeInfo;
    if (!book) return null;

    const genres = [...(book.categories || []), ...(book.subject ? [book.subject].flat() : [])]
      .filter(Boolean).slice(0, 3).join(', ');

    const langMap = { en:'ENGLISH', es:'SPANISH', fr:'FRENCH', de:'GERMAN', it:'ITALIAN',
                      pt:'PORTUGUESE', nl:'DUTCH', pl:'POLISH', ru:'RUSSIAN',
                      zh:'CHINESE', ja:'JAPANESE', ko:'KOREAN' };
    const language = book.language
      ? (langMap[book.language.toLowerCase()] || book.language.toUpperCase())
      : '';

    return {
      source:        'Google Books',
      title:         book.title || '',
      author:        book.authors ? book.authors.join(', ') : '',
      publisher:     book.publisher || '',
      pub_year:      book.publishedDate?.match(/\d{4}/)?.[0] || '',
      isbn,
      pages:         book.pageCount?.toString() || '',
      language,
      genre:         genres,
      coverUrl:      book.imageLinks?.thumbnail || null,
      suggestedType: 'book',
      description:   book.description || '',
    };
  } catch (e) {
    console.warn('[lookup] GoogleBooks error:', e.message);
    return null;
  }
}

// ── Internet Archive ──────────────────────────────────────────
async function _lookupInternetArchive(code) {
  try {
    const r = await _fetchWithTimeout(`https://archive.org/metadata/isbn_${code}`, 4000);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.metadata) return null;
    const m   = data.metadata;
    const val = v => Array.isArray(v) ? v[0] : (v || '');
    return {
      source:        'Internet Archive',
      title:         val(m.title),
      author:        Array.isArray(m.creator) ? m.creator.join(', ') : (m.creator || ''),
      publisher:     val(m.publisher),
      pub_year:      val(m.year),
      isbn:          code,
      language:      val(m.language),
      coverUrl:      null,
      suggestedType: 'book',
    };
  } catch (e) {
    console.warn('[lookup] InternetArchive error:', e.message);
    return null;
  }
}

// ── UPCitemdb — universal product DB ─────────────────────────
// 100 req/day free (no key needed for the trial endpoint).
// Covers video games, DVDs, music, books, and general products.
async function _lookupUPCitemdb(upc) {
  try {
    const r = await _fetchWithTimeout(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`, 5000);
    if (!r.ok) return null;
    const data = await r.json();
    if (data.code !== 'OK' || !data.items?.length) return null;

    const item  = data.items[0];
    const title = item.title || '';
    const cat   = (item.category || '').toLowerCase();
    const brand = item.brand   || '';
    const desc  = item.description || '';

    // ── Smart type detection from category string ────────────
    let suggestedType = _currentTypeId() || _upcCategoryToType(cat, title);

    // ── Map UPCitemdb fields to our schema ───────────────────
    // We try to extract year from the description or title
    const yearMatch = (desc + ' ' + title).match(/\b(19|20)\d{2}\b/);
    const year      = yearMatch ? yearMatch[0] : '';

    const result = {
      source:        'UPCitemdb',
      title,
      coverUrl:      item.images?.[0] || null,
      suggestedType,
      upc,
      description:   desc,
      year,
    };

    // ── Attach fields based on the resolved type ─────────────
    if (MUSIC_TYPES.has(suggestedType)) {
      // For music the title often includes "Artist - Album"
      const [artistPart, albumPart] = _splitMusicTitle(title);
      result.artist  = artistPart || brand;
      result.album   = albumPart  || title;
      result.label   = brand;

    } else if (BOOK_TYPES.has(suggestedType)) {
      result.author    = brand; // brand is often the publisher for books
      result.publisher = brand;

    } else if (GAME_TYPES.has(suggestedType)) {
      result.publisher = brand;
      // Try to detect platform from title / category
      result.platform  = _detectPlatform(cat + ' ' + title);

    } else if (VIDEO_TYPES.has(suggestedType)) {
      result.studio = brand;

    } else {
      result.author    = brand;
      result.publisher = brand;
    }

    return result;
  } catch (e) {
    console.warn('[lookup] UPCitemdb error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Category → type helpers
// ─────────────────────────────────────────────────────────────

function _upcCategoryToType(cat, title) {
  const s = (cat + ' ' + title).toLowerCase();
  if (s.match(/\bvinyl|lp\b|record\b|gramoph/)) return 'vinyl';
  if (s.match(/\bcassette|tape\b/))              return 'cassette';
  if (s.match(/\bcd\b|compact.?disc/))           return 'cd';
  if (s.match(/\bvideo.?game|game.?software|xbox|playstation|nintendo|ps[1-5]|wii|steam/)) return 'game';
  if (s.match(/\bblu.?ray/))                     return 'dvd';
  if (s.match(/\bdvd\b/))                        return 'dvd';
  if (s.match(/\bvhs\b/))                        return 'vhs';
  if (s.match(/\bcomic|manga\b/))                return 'comic';
  if (s.match(/\bbook|novel|fiction|non.?fiction|isbn/)) return 'book';
  if (s.match(/\bmagazine|periodical/))          return 'magazine';
  return 'other';
}

function _detectPlatform(s) {
  const t = s.toLowerCase();
  if (t.includes('playstation 5') || t.includes('ps5'))         return 'PlayStation 5';
  if (t.includes('playstation 4') || t.includes('ps4'))         return 'PlayStation 4';
  if (t.includes('playstation 3') || t.includes('ps3'))         return 'PlayStation 3';
  if (t.includes('playstation 2') || t.includes('ps2'))         return 'PlayStation 2';
  if (t.includes('playstation'))                                 return 'PlayStation';
  if (t.includes('xbox series'))                                 return 'Xbox Series X/S';
  if (t.includes('xbox one'))                                    return 'Xbox One';
  if (t.includes('xbox 360'))                                    return 'Xbox 360';
  if (t.includes('xbox'))                                        return 'Xbox';
  if (t.includes('nintendo switch') || t.includes('switch'))    return 'Nintendo Switch';
  if (t.includes('wii u'))                                       return 'Wii U';
  if (t.includes('wii'))                                         return 'Wii';
  if (t.includes('nintendo ds') || t.includes('nds'))           return 'Nintendo DS';
  if (t.includes('game boy advance') || t.includes('gba'))      return 'Game Boy Advance';
  if (t.includes('game boy'))                                    return 'Game Boy';
  if (t.includes('gamecube'))                                    return 'GameCube';
  if (t.includes('n64') || t.includes('nintendo 64'))           return 'Nintendo 64';
  if (t.includes('snes') || t.includes('super nintendo'))       return 'SNES';
  if (t.includes('nes'))                                         return 'NES';
  if (t.includes('sega genesis') || t.includes('mega drive'))   return 'Sega Genesis';
  if (t.includes('sega'))                                        return 'Sega';
  if (t.includes('pc') || t.includes('windows'))                return 'PC';
  if (t.includes('mac'))                                         return 'Mac';
  return '';
}

/**
 * Splits a UPCitemdb title like "Miles Davis - Kind of Blue" into
 * ["Miles Davis", "Kind of Blue"].  Falls back to ["", fullTitle].
 */
function _splitMusicTitle(title) {
  // Common separators in music product titles
  const sep = [' - ', ' – ', ' — ', ' / '];
  for (const s of sep) {
    const idx = title.indexOf(s);
    if (idx > 0) {
      return [title.substring(0, idx).trim(), title.substring(idx + s.length).trim()];
    }
  }
  return ['', title];
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — helpers
// ═══════════════════════════════════════════════════════════════

async function _fetchWithTimeout(url, ms = 7000, extraHeaders = {}) {
  const ctrl    = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal:  ctrl.signal,
      headers: { Accept: 'application/json', ...extraHeaders },
    });
    clearTimeout(timerId);
    return r;
  } catch (e) {
    clearTimeout(timerId);
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  }
}

function _renderLookupResult(result, code) {
  const thumbHtml = result.coverUrl
    ? `<img src="${result.coverUrl}" alt="${result.title}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📦'">`
    : (_state.selectedType?.icon || '📦');

  const sub1 = result.artist || result.author || result.publisher || '';
  const sub2 = result.label  || result.year   || result.pub_year  || '';

  showScanStatus('matched',
    `<strong>✓ Found on ${result.source}</strong>
     <div class="lookup-result" onclick="window.applyLookupResult()">
       <div class="lookup-result-thumb">${thumbHtml}</div>
       <div style="flex:1;min-width:0">
         <div class="fw-600" style="margin-bottom:4px">${result.title || result.album || 'Untitled'}</div>
         ${sub1 ? `<div class="text-sm text-muted">${sub1}</div>` : ''}
         ${sub2 ? `<div class="text-sm text-muted">${sub2}</div>` : ''}
         ${result.format  ? `<div class="text-xs text-muted">${result.format}</div>`  : ''}
         ${result.pages   ? `<div class="text-xs text-muted">${result.pages} pages</div>` : ''}
         ${result.platform? `<div class="text-xs text-muted">${result.platform}</div>`: ''}
         <button class="lookup-apply-btn" style="margin-top:10px">✓ Apply details</button>
       </div>
     </div>
     <div style="font-size:11px;color:var(--text3);margin-top:6px">Tap to pre-fill the form, then switch to Manual entry to review and save.</div>`
  );
}

function _applyResultToForm(result) {
  // All possible field mappings — only fills fields that exist in the current form
  const fieldMap = {
    // Common
    title:      'title',
    year:       'year',
    description:'description',
    // Books
    author:     'author',
    publisher:  'publisher',
    pub_year:   'pub_year',
    isbn:       'isbn',
    pages:      'pages',
    language:   'language',
    genre:      'genre',
    // Music
    artist:     'artist',
    album:      'album',
    label:      'label',
    catalog:    'catalog',
    pressing:   'pressing',
    format:     'format',
    // Games
    platform:   'platform',
    // Video
    studio:     'studio',
  };

  Object.entries(fieldMap).forEach(([key, field]) => {
    if (!result[key]) return;
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el) el.value = result[key];
  });

  // UPC → catalog field (for games, DVDs etc.)
  if (result.upc) {
    const catF = document.querySelector('[data-field="catalog"]');
    if (catF && !catF.value) catF.value = result.upc;
  }
}

async function _fetchCoverAsDataUrl(url) {
  try {
    const res    = await fetch(url);
    if (!res.ok) return; // cover not found (e.g. CAA 404)
    const blob   = await res.blob();
    const reader = new FileReader();
    reader.onload = ev => {
      _state.editingItem._coverData = ev.target.result;
      const cp = document.getElementById('cover-preview');
      if (cp) cp.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    };
    reader.readAsDataURL(blob);
  } catch (_) { /* non-fatal */ }
}