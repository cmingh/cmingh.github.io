// js/lookup.js  (v4 — per-type API routing, fixed timeout & undefined refs)
// ─────────────────────────────────────────────────────────────
// API lookups: barcode → Open Library / UPCitemdb / Internet Archive / MusicBrainz
// and title search → Open Library for book cover scan
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES } from './state.js';
import { toast, switchTab } from './ui.js';
import { showScanStatus, showCoverScanStatus } from './scanner.js';
import { buildManualForm } from './forms.js';

// ── Helper: get the currently selected media type id ───────────
function _currentTypeId() {
  return _state.selectedType?.id || '';
}

// ═══════════════════════════════════════════════════════════════
// BARCODE LOOKUP — the main entry point called by scanner.js
// ═══════════════════════════════════════════════════════════════

export async function lookupBarcode(codeOverride) {
  const inputEl = document.getElementById('barcode-manual');
  const raw = codeOverride || (inputEl ? inputEl.value.trim() : '');

  if (!raw) {
    toast('Enter a barcode or ISBN first', 'error');
    return;
  }

  // Sanitise — strip spaces and hyphens
  const code = raw.replace(/[\s\-]/g, '');
  console.log('[lookup] barcode:', code, '| type:', _currentTypeId());

  // Validate: must be 8–14 digits
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

  const selectedType = _state.selectedType?.id || '';
  const isMusicType  = ['cd','vinyl','cassette'].includes(selectedType);

  // 6. Try sources in priority order with overall timeout.
  //    Fire book/music sources in parallel buckets to reduce latency.
  let result = null;
  try {
    const lookupPromise = (async () => {
      // ── For ISBNs: try book databases first ────────────────
      if (isISBN) {
        result = await _lookupOpenLibrary(code);
        if (!result) result = await _lookupGoogleBooks(code);
        if (!result) result = await _lookupInternetArchive(code);
      }

      // ── For music types: try MusicBrainz first ─────────────
      if (isMusicType) {
        result = await _lookupMusicBrainz(code);
      }

      // ── Universal fallback: UPCitemdb ──────────────────────
      if (!result) result = await _lookupUPCitemdb(code);

      // ── If still not found and not ISBN/not music: IA ──────
      if (!result && !isISBN && !isMusicType) {
        result = await _lookupInternetArchive(code);
      }

      return result;
    })();

    // 12-second overall timeout for the entire chain
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Lookup timeout')), 12000)
    );
    result = await Promise.race([lookupPromise, timeoutPromise]);
  } catch (e) {
    console.warn('[lookup] chain timeout or error:', e.message);
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
      const isbnF = document.querySelector('[data-field="isbn"]');
      const catF  = document.querySelector('[data-field="catalog"]');
      if (isbnF && isISBN) isbnF.value = code;
      else if (catF) catF.value = code;
      else if (isbnF) isbnF.value = code;
    }, 1400);
  }
}

// Apply a barcode lookup result to the manual form
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
// MEDIA TITLE SEARCH (generic, for all media types with OpenLibrary)
// ═══════════════════════════════════════════════════════════════

export async function searchMediaByTitle(queryOverride) {
  const query = queryOverride || document.getElementById('cover-title-input')?.value.trim();
  if (!query) { toast('Enter a title, artist, or name to search', 'error'); return; }
  return searchBookByTitle(query);
}
window.searchMediaByTitle = searchMediaByTitle;

// ═══════════════════════════════════════════════════════════════
// BOOK TITLE SEARCH (used by book-cover scan tab)
// ═══════════════════════════════════════════════════════════════

let __bookSearchResults = [];

export async function searchBookByTitle(queryOverride) {
  const query = queryOverride || document.getElementById('cover-title-input')?.value.trim();
  if (!query) { toast('Enter a title or author to search', 'error'); return; }

  showCoverScanStatus('loading',
    `<span class="spin">⏳</span> Searching for "<strong>${query}</strong>"…`
  );

  const resultsEl = document.getElementById('book-search-results');
  if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }

  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5` +
      `&fields=title,author_name,publisher,first_publish_year,isbn,cover_i,number_of_pages,subject,language`;
    const r = await _fetchWithTimeout(url, 6000);
    if (!r || !r.ok) throw new Error('HTTP ' + (r?.status || 'fetch failed'));
    const data = await r.json();

    // FIX: build 'merged' from docs (was previously undefined)
    const merged = (data.docs || []).map(doc => ({
      title:     doc.title || '',
      author:    (doc.author_name || []).join(', '),
      publisher: (doc.publisher || []).join(', '),
      year:      doc.first_publish_year?.toString() || '',
      isbn:      (doc.isbn || [])[0] || '',
      coverUrl:  doc.cover_i
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
        : null,
      pages:     doc.number_of_pages?.toString() || '',
      language:  _langCodeToName((doc.language || [])[0] || ''),
      subject:   (doc.subject || []).slice(0, 3).join(', '),
    }));

    if (!merged.length) {
      showCoverScanStatus('no-match',
        `<strong>ℹ No results found for "${query}".</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a different title, or use Manual entry.</span>`
      );
      return;
    }

    __bookSearchResults = merged;

    if (resultsEl) {
      showCoverScanStatus('matched',
        `<strong>✓ Found ${merged.length} results</strong> — tap one to apply:`
      );
      resultsEl.style.display = 'flex';
      resultsEl.innerHTML = merged.map((doc, idx) => {
        const thumbHtml = doc.coverUrl
          ? `<img src="${doc.coverUrl}" alt="${doc.title}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📗'">`
          : '📗';
        return `<div class="book-scan-result-item" onclick="window.applyCoverSearchResult(${idx})">
          <div style="width:48px;height:68px;background:var(--bg2);border-radius:5px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:20px">${thumbHtml}</div>
          <div style="flex:1;min-width:0">
            <div class="fw-600" style="font-size:13px">${doc.title}</div>
            ${doc.author    ? `<div class="text-sm text-muted">${doc.author}</div>` : ''}
            ${(doc.publisher || doc.year) ? `<div class="text-xs text-muted">${[doc.publisher, doc.year].filter(Boolean).join(' · ')}</div>` : ''}
            ${doc.isbn ? `<div class="text-xs mono" style="color:var(--text3)">ISBN ${doc.isbn}</div>` : ''}
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
    console.error('[lookup] Book search error:', e.message);
  }
}
window.searchBookByTitle = searchBookByTitle;

export function applyCoverSearchResult(idx) {
  const result = __bookSearchResults[idx];
  if (!result) {
    toast('Could not find that search result', 'error');
    return;
  }

  switchTab('manual-tab', 'add');
  _state.lookupResult = { ...result };
  _applyResultToForm(result);
  if (result.coverUrl) _fetchCoverAsDataUrl(result.coverUrl);
  toast('Details applied! Review and save.', 'success');
}
window.applyCoverSearchResult = applyCoverSearchResult;

// ═══════════════════════════════════════════════════════════════
// INTERNAL — API fetchers
// ═══════════════════════════════════════════════════════════════

// ── MusicBrainz — barcode lookup ─────────────────────────────
// Free, no key required. Rate limit: 1 req/sec (we stay well under).
// Returns rich data for CDs, vinyl, cassettes.
async function _lookupMusicBrainz(barcode) {
  try {
    const url  = `https://musicbrainz.org/ws/2/release/?query=barcode:${barcode}&limit=1&fmt=json`;
    const r    = await _fetchWithTimeout(url, 6000, { 'User-Agent': 'MediaNest/1.0 (collection app)' });
    if (!r || !r.ok) return null;
    const data = await r.json();

    if (!data.releases?.length) return null;
    const rel  = data.releases[0];

    const artistName = rel['artist-credit']?.[0]?.artist?.name ||
                       rel['artist-credit']?.[0]?.name || '';

    const labelInfo  = rel['label-info']?.[0] || {};
    const labelName  = labelInfo.label?.name || '';
    const catNum     = labelInfo['catalog-number'] || '';

    const mbid     = rel.id;
    const coverUrl = mbid
      ? `https://coverartarchive.org/release/${mbid}/front-250`
      : null;

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
  return 'cd';
}

// ── Open Library — ISBN ───────────────────────────────────────
async function _lookupOpenLibrary(isbn) {
  try {
    const r = await _fetchWithTimeout(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, 5000
    );
    if (!r || !r.ok) return null;
    const data = await r.json();
    const b    = data[`ISBN:${isbn}`];
    if (!b) return null;

    const coverUrl = b.cover
      ? (b.cover.large || b.cover.medium || b.cover.small || null)
      : null;

    const cleanGenres = b.subjects
      ? b.subjects
          .slice(0, 5)
          .map(s => typeof s === 'string' ? s : (s.name || ''))
          .filter(s => s.length > 0)
          .filter(s => !/^(\d+th century|Biography|Fiction|Young adult|Juvenile|Action|Adventure)$/i.test(s))
          .filter(s => !/^(Genre:|Category:|Tag:|Label:)/i.test(s))
          .filter(s => !/^(book|books|work|works|publication|document)$/i.test(s))
          .slice(0, 3)
          .join(', ')
      : '';

    let language = '';
    if (b.language) {
      if (typeof b.language === 'string') {
        language = b.language.replace('/languages/', '').toUpperCase();
      } else if (b.language.key) {
        language = b.language.key.replace('/languages/', '').toUpperCase();
      } else if (Array.isArray(b.language) && b.language.length > 0) {
        const lang = b.language[0];
        language = (typeof lang === 'string' ? lang : lang.key || '').replace('/languages/', '').toUpperCase();
      }
    }

    return {
      source:       'Open Library',
      title:        b.title || '',
      author:       b.authors   ? b.authors.map(a => a.name).join(', ') : '',
      publisher:    b.publishers ? b.publishers.map(p => p.name).join(', ') : '',
      pub_year:     b.publish_date?.match(/\d{4}/)?.[0] || '',
      isbn,
      pages:        b.number_of_pages?.toString() || '',
      language:     language,
      genre:        cleanGenres,
      coverUrl,
      suggestedType: 'book',
      description:  b.excerpts?.[0]?.text || '',
    };
  } catch (e) { console.warn('OpenLibrary error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════
// OPEN LIBRARY — title search (returns array)
// ═══════════════════════════════════════════════════════════════

async function _searchOpenLibrary(query) {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8` +
      `&fields=title,subtitle,author_name,publisher,first_publish_year,isbn,cover_i,number_of_pages,subject,language,edition_count,key`;
    const r = await _fetchWithTimeout(url, 7000);
    if (!r || !r.ok) return [];
    const data = await r.json();
    if (!data.docs?.length) return [];

    return data.docs.slice(0, 8).map(doc => ({
      source:    'Open Library',
      title:     doc.title || 'Unknown Title',
      subtitle:  doc.subtitle || '',
      author:    (doc.author_name || []).join(', ') || '',
      year:      doc.first_publish_year?.toString() || '',
      publisher: (doc.publisher || [])[0] || '',
      isbn:      (doc.isbn || [])[0] || '',
      coverUrl:  doc.cover_i
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
        : null,
      pages:     doc.number_of_pages?.toString() || '',
      language:  _langCodeToName((doc.language || [])[0] || ''),
      genre:     _cleanSubjects((doc.subject || []).map(s => typeof s === 'string' ? s : ''), 3),
      pub_year:  doc.first_publish_year?.toString() || '',
      editionCount: doc.edition_count || 0,
      olKey:     doc.key || '',
    }));
  } catch (e) { console.warn('[lookup] OL search error:', e.message); return []; }
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE BOOKS — barcode lookup
// ═══════════════════════════════════════════════════════════════

async function _lookupGoogleBooks(isbn) {
  try {
    const r = await _fetchWithTimeout(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, 4000);
    if (!r || !r.ok) return null;
    const data = await r.json();
    if (!data.items?.length) return null;

    const book = data.items[0].volumeInfo;
    if (!book) return null;

    const genres = [];
    if (book.categories) {
      genres.push(...book.categories.slice(0, 2));
    }
    if (book.subject) {
      genres.push(...(Array.isArray(book.subject) ? book.subject : [book.subject]).slice(0, 1));
    }
    const genreStr = genres.filter(g => g && g.length > 0).slice(0, 3).join(', ');

    let language = '';
    if (book.language) {
      language = book.language.toUpperCase();
      if (language.length === 2) {
        const langMap = { en: 'ENGLISH', es: 'SPANISH', fr: 'FRENCH', de: 'GERMAN', it: 'ITALIAN', pt: 'PORTUGUESE', nl: 'DUTCH', pl: 'POLISH', ru: 'RUSSIAN', zh: 'CHINESE', ja: 'JAPANESE', ko: 'KOREAN' };
        language = langMap[language.toLowerCase()] || language;
      }
    }

    return {
      source:       'Google Books',
      title:        book.title || '',
      author:       book.authors ? book.authors.join(', ') : '',
      publisher:    book.publisher || '',
      pub_year:     book.publishedDate?.match(/\d{4}/)?.[0] || '',
      isbn,
      pages:        book.pageCount?.toString() || '',
      language:     language,
      genre:        genreStr,
      coverUrl:     book.imageLinks?.thumbnail || null,
      suggestedType: 'book',
      description:  book.description || '',
    };
  } catch (e) { console.warn('Google Books error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════
// INTERNET ARCHIVE — barcode lookup
// ═══════════════════════════════════════════════════════════════

async function _lookupInternetArchive(code) {
  try {
    const r = await _fetchWithTimeout(`https://archive.org/metadata/isbn_${code}`, 4000);
    if (!r || !r.ok) return null;
    const data = await r.json();
    if (!data.metadata) return null;
    const m   = data.metadata;
    const val = v => Array.isArray(v) ? v[0] : (v || '');

    const rawSubjects = Array.isArray(m.subject) ? m.subject : (m.subject ? [m.subject] : []);
    const genre = _cleanSubjects(rawSubjects, 3);

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
      description:  val(m.description) || '',
    };
  } catch (e) { console.warn('InternetArchive error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════
// UPCITEMDB — generic UPC lookup
// ═══════════════════════════════════════════════════════════════

async function _lookupUPCitemdb(upc) {
  try {
    const r = await _fetchWithTimeout(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`, 5000);
    if (!r || !r.ok) return null;
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
  } catch (e) { console.warn('UPCitemdb error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════
// FETCH WITH TIMEOUT (fixed — returns null on error, not [])
// ═══════════════════════════════════════════════════════════════

async function _fetchWithTimeout(url, ms = 7000, extraHeaders = {}) {
  const ctrl    = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { ...extraHeaders },
    });
    clearTimeout(timerId);
    return r;
  } catch (e) {
    clearTimeout(timerId);
    console.warn('[lookup] fetch timeout/error:', url.split('?')[0].substring(0, 40) + '…', e.message);
    return null; // ← FIXED: was returning [] which broke callers
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function _mergeBookResults(olResults, gbResults) {
  const seen = new Set();
  const out = [];

  for (const r of [...olResults, ...gbResults]) {
    const key = (r.title + '|' + r.author).toLowerCase().replace(/\s+/g, '');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out.slice(0, 8);
}

function _langCodeToName(code) {
  if (!code) return '';
  const clean = code.replace('/languages/', '').toLowerCase().trim();
  const MAP = {
    eng: 'English', en: 'English',
    spa: 'Spanish', es: 'Spanish',
    fra: 'French',  fr: 'French',
    deu: 'German',  de: 'German',
    ita: 'Italian', it: 'Italian',
    por: 'Portuguese', pt: 'Portuguese',
    nld: 'Dutch',   nl: 'Dutch',
    pol: 'Polish',  pl: 'Polish',
    rus: 'Russian', ru: 'Russian',
    zho: 'Chinese', zh: 'Chinese',
    jpn: 'Japanese', ja: 'Japanese',
    kor: 'Korean',  ko: 'Korean',
    ara: 'Arabic',  ar: 'Arabic',
    hin: 'Hindi',   hi: 'Hindi',
    swe: 'Swedish', sv: 'Swedish',
    nor: 'Norwegian', no: 'Norwegian',
    dan: 'Danish',  da: 'Danish',
    fin: 'Finnish', fi: 'Finnish',
    lat: 'Latin',
    grc: 'Ancient Greek',
    heb: 'Hebrew',  he: 'Hebrew',
  };
  return MAP[clean] || code.toUpperCase();
}

const _SUBJECT_NOISE = new RegExp(
  '^(fiction|nonfiction|non-fiction|juvenile|young adult|biography|autobiography|' +
  'general|miscellaneous|protected daisy|accessible book|large print|' +
  'in library|overdrive|internet archive|open library|printed access code|' +
  'textbook binding|audio cd|hardcover|paperback|mass market|' +
  'book|books|work|works|publication|document|reading level|lexile|' +
  '\\d+th century|\\d{3,4}s)$',
  'i'
);

function _cleanSubjects(rawArr, max = 4) {
  const seen = new Set();
  return rawArr
    .filter(s => typeof s === 'string' && s.length > 1)
    .map(s => s.trim().replace(/\b\w/g, c => c.toUpperCase()))
    .filter(s => !_SUBJECT_NOISE.test(s.toLowerCase()))
    .filter(s => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max)
    .join(', ');
}

function _renderLookupResult(result, code) {
  const thumbHtml = result.coverUrl
    ? `<img src="${result.coverUrl}" alt="${result.title || result.album}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📦'">`
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
     <div style="font-size:11px;color:var(--text3);margin-top:6px">Tap to pre-fill the form, then switch to Manual entry to review and save.</div>`
  );
}

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
    if (catF && !catF.value) catF.value = result.upc;
  }
}

async function _fetchCoverAsDataUrl(url) {
  try {
    const res    = await fetch(url);
    if (!res.ok) return;
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

window.applyLookupResult = applyLookupResult;