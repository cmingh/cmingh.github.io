// js/lookup.js
// ─────────────────────────────────────────────────────────────
// API lookups: barcode → Open Library / Google Books / Discogs /
//              UPCitemdb / Internet Archive / MusicBrainz
// title search → Open Library, Discogs, MusicBrainz
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES } from './state.js';
import { toast, switchTab } from './ui.js';
import { showScanStatus, showCoverScanStatus } from './scanner.js';
import { buildManualForm } from './forms.js';
import {
  discogsLookupBarcode,
  discogsSearchByTitle,
  discogsResultToFormFields,
} from './discogs.js';

// ═══════════════════════════════════════════════════════════════
// BARCODE LOOKUP
// ═══════════════════════════════════════════════════════════════

export async function lookupBarcode(codeOverride) {
  const inputEl = document.getElementById('barcode-manual');
  const raw = codeOverride || (inputEl ? inputEl.value.trim() : '');
  if (!raw) { toast('Enter a barcode or ISBN first', 'error'); return; }

  const code = raw.replace(/[\s\-]/g, '');
  console.log('[lookup] Checking barcode:', code);

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

  // Detect likely music media from currently selected type
  const selectedId = _state.selectedType?.id;
  const isMusicMedia = ['vinyl', 'cd', 'cassette'].includes(selectedId);

  let result = null;
  try {
    const lookupPromise = (async () => {
      // Route music media through Discogs first
      if (isMusicMedia || (!isISBN && code.length >= 12)) {
        result = await discogsLookupBarcode(code);
        if (result) return result;
      }

      if (isISBN) {
        result = await _lookupOpenLibrary(code);
        if (!result) result = await _lookupGoogleBooks(code);
        if (!result) result = await _lookupInternetArchive(code);
      }

      if (!result) result = await discogsLookupBarcode(code);
      if (!result) result = await _lookupUPCitemdb(code);
      if (!result && !isISBN) result = await _lookupInternetArchive(code);

      return result;
    })();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Lookup timeout')), 18000));
    result = await Promise.race([lookupPromise, timeout]);
  } catch (e) {
    console.warn('[lookup] Chain timeout or error:', e);
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
      if (isbnF) isbnF.value = code;
      else if (catF) catF.value = code;
    }, 1400);
  }
}

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

// ═══════════════════════════════════════════════════════════════
// TITLE SEARCH — routes by media type
// ═══════════════════════════════════════════════════════════════

export async function searchMediaByTitle(queryOverride) {
  const query = queryOverride || document.getElementById('cover-title-input')?.value.trim();
  if (!query) { toast('Enter a title, artist, or name to search', 'error'); return; }

  const selectedId = _state.selectedType?.id;
  const isMusicMedia = ['vinyl', 'cd', 'cassette'].includes(selectedId);

  if (isMusicMedia) {
    return searchMusicByTitle(query, selectedId);
  }
  return searchBookByTitle(query);
}

// ─────────────────────────────────────────────────────────────
// MUSIC SEARCH (Discogs + MusicBrainz fallback)
// ─────────────────────────────────────────────────────────────

let __musicSearchResults = [];

export async function searchMusicByTitle(query, mediaType) {
  showCoverScanStatus('loading',
    `<span class="spin">⏳</span> Searching Discogs for "<strong>${query}</strong>"…`
  );

  const resultsEl = document.getElementById('book-search-results');
  if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }

  try {
    // Try Discogs first
    let results = await discogsSearchByTitle(query, mediaType);

    // Fallback to MusicBrainz if Discogs returns nothing
    if (!results.length) {
      results = await _searchMusicBrainz(query, mediaType);
    }

    if (!results.length) {
      showCoverScanStatus('no-match',
        `<strong>ℹ No results found for "${query}".</strong>
         <br><span style="font-size:12px;color:var(--text2)">Try a different title or artist, or use Manual entry.</span>`
      );
      return;
    }

    __musicSearchResults = results;

    if (resultsEl) {
      showCoverScanStatus('matched',
        `<strong>✓ Found ${results.length} results</strong> — tap one to apply:`
      );
      resultsEl.style.display = 'flex';
      resultsEl.innerHTML = results.map((r, idx) => {
        const thumbHtml = r.coverUrl
          ? `<img src="${r.coverUrl}" alt="${r.album}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='🎵'">`
          : (r.suggestedType === 'cd' ? '💿' : r.suggestedType === 'cassette' ? '📼' : '🎵');
        const sub = [r.label, r.year, r.country].filter(Boolean).join(' · ');
        const catno = r.catalog && r.catalog !== 'none' ? r.catalog : '';
        return `<div class="book-scan-result-item" onclick="window.applyCoverSearchResult(${idx})">
          <div style="width:48px;height:48px;background:var(--bg2);border-radius:5px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:20px">${thumbHtml}</div>
          <div style="flex:1;min-width:0">
            <div class="fw-600" style="font-size:13px">${r.album || 'Unknown Title'}</div>
            ${r.artist ? `<div class="text-sm text-muted">${r.artist}</div>` : ''}
            ${sub ? `<div class="text-xs text-muted">${sub}</div>` : ''}
            ${catno ? `<div class="text-xs mono" style="color:var(--text3)">${catno}</div>` : ''}
            <div class="text-xs" style="color:var(--accent);margin-top:2px">via ${r.source}</div>
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
    console.error('Music search error:', e);
  }
}

// ─────────────────────────────────────────────────────────────
// BOOK TITLE SEARCH (Open Library + Google Books fallback)
// ─────────────────────────────────────────────────────────────

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
    // Fetch from Open Library and Google Books in parallel
    const [olDocs, gbDocs] = await Promise.allSettled([
      _searchOpenLibrary(query),
      _searchGoogleBooks(query),
    ]);

    const olResults = olDocs.status === 'fulfilled' ? olDocs.value : [];
    const gbResults = gbDocs.status === 'fulfilled' ? gbDocs.value : [];

    // Merge: prefer OL but fill gaps with GB
    const merged = _mergeBookResults(olResults, gbResults);

    if (!merged.length) {
      showCoverScanStatus('no-match',
        `<strong>ℹ No books found for "${query}".</strong>
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
            ${doc.author ? `<div class="text-sm text-muted">${doc.author}</div>` : ''}
            ${(doc.publisher || doc.year) ? `<div class="text-xs text-muted">${[doc.publisher, doc.year].filter(Boolean).join(' · ')}</div>` : ''}
            ${doc.isbn ? `<div class="text-xs mono" style="color:var(--text3)">ISBN ${doc.isbn}</div>` : ''}
            ${doc.genre ? `<div class="text-xs text-muted" style="margin-top:2px">📚 ${doc.genre}</div>` : ''}
            <div class="text-xs" style="color:var(--accent);margin-top:2px">via ${doc.source}</div>
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
    console.error('Book search error:', e);
  }
}

export function applyCoverSearchResult(idx) {
  // Determine which result set to use
  const selectedId = _state.selectedType?.id;
  const isMusicMedia = ['vinyl', 'cd', 'cassette'].includes(selectedId);
  const resultArr = isMusicMedia ? __musicSearchResults : __bookSearchResults;
  const result = resultArr[idx];

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
// OPEN LIBRARY — barcode lookup
// ═══════════════════════════════════════════════════════════════

async function _lookupOpenLibrary(isbn) {
  try {
    const r = await _fetchWithTimeout(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, 5000
    );
    if (!r.ok) return null;
    const data = await r.json();
    const key  = `ISBN:${isbn}`;
    if (!data[key]) return null;
    const b = data[key];

    const coverUrl = b.cover
      ? (b.cover.large || b.cover.medium || b.cover.small || null)
      : null;

    // Fetch additional details from works endpoint if available
    let workData = null;
    if (b.works?.length) {
      try {
        const workKey = b.works[0].key;
        const wr = await _fetchWithTimeout(`https://openlibrary.org${workKey}.json`, 3000);
        if (wr.ok) workData = await wr.json();
      } catch (_) {}
    }

    // Subjects: merge from edition + work, de-duplicate, clean
    const rawSubjects = [
      ...(b.subjects || []).map(s => typeof s === 'string' ? s : (s.name || '')),
      ...(workData?.subjects || []).map(s => typeof s === 'string' ? s : ''),
    ].filter(Boolean);
    const genre = _cleanSubjects(rawSubjects, 4);

    // Description from work or edition
    const descRaw = workData?.description
      ? (typeof workData.description === 'string' ? workData.description : workData.description.value || '')
      : (b.excerpts?.[0]?.text || '');

    // Language
    let language = '';
    const langRaw = b.languages?.[0]?.key || b.language;
    if (langRaw) {
      language = _langCodeToName(
        (typeof langRaw === 'string' ? langRaw : '').replace('/languages/', '')
      );
    }

    // Number of pages — prefer edition's value
    const pages = b.number_of_pages?.toString()
      || workData?.pagination?.toString()
      || '';

    // Physical description (dimensions etc.)
    const physDesc = b.physical_format || b.physical_dimensions || '';

    return {
      source:       'Open Library',
      title:        b.title || '',
      subtitle:     b.subtitle || '',
      author:       b.authors?.map(a => a.name).join(', ') || '',
      publisher:    b.publishers?.map(p => p.name).join(', ') || '',
      pub_year:     b.publish_date?.match(/\d{4}/)?.[0] || '',
      isbn,
      pages,
      language,
      genre,
      coverUrl,
      suggestedType: 'book',
      description:  descRaw.slice(0, 600),
      physDesc,
      edition:      b.edition_name || '',
    };
  } catch (e) { console.warn('[lookup] OpenLibrary error:', e); return null; }
}

// ═══════════════════════════════════════════════════════════════
// OPEN LIBRARY — title search (returns array)
// ═══════════════════════════════════════════════════════════════

async function _searchOpenLibrary(query) {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8` +
      `&fields=title,subtitle,author_name,publisher,first_publish_year,isbn,cover_i,number_of_pages,subject,language,edition_count,key`;
    const r = await _fetchWithTimeout(url, 7000);
    if (!r.ok) return [];
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
  } catch (e) { console.warn('[lookup] OL search error:', e); return []; }
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE BOOKS — barcode lookup
// ═══════════════════════════════════════════════════════════════

async function _lookupGoogleBooks(isbn) {
  try {
    const r = await _fetchWithTimeout(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`, 5000
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.items?.length) return null;
    return _parseGoogleBooksVolume(data.items[0], isbn);
  } catch (e) { console.warn('[lookup] Google Books error:', e); return null; }
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE BOOKS — title search
// ═══════════════════════════════════════════════════════════════

async function _searchGoogleBooks(query) {
  try {
    const r = await _fetchWithTimeout(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=8&printType=books`, 7000
    );
    if (!r.ok) return [];
    const data = await r.json();
    if (!data.items?.length) return [];
    return data.items
      .map(item => _parseGoogleBooksVolume(item, ''))
      .filter(Boolean);
  } catch (e) { console.warn('[lookup] GB search error:', e); return []; }
}

function _parseGoogleBooksVolume(item, isbnOverride) {
  const vi = item.volumeInfo;
  if (!vi) return null;

  const isbns = vi.industryIdentifiers || [];
  const isbn13 = isbns.find(i => i.type === 'ISBN_13')?.identifier || '';
  const isbn10 = isbns.find(i => i.type === 'ISBN_10')?.identifier || '';
  const isbn = isbnOverride || isbn13 || isbn10;

  // Clean categories — GB sometimes gives broad/useless ones
  const rawCats = [...(vi.categories || [])];
  const genre = _cleanSubjects(rawCats, 3);

  // Language code → name
  const language = _langCodeToName(vi.language || '');

  // Cover: prefer the largest available
  const coverUrl = vi.imageLinks?.extraLarge
    || vi.imageLinks?.large
    || vi.imageLinks?.medium
    || vi.imageLinks?.thumbnail
    || null;
  // Remove zoom=1 restriction from Google Books image URLs to get larger images
  const betterCover = coverUrl
    ? coverUrl.replace('&zoom=1', '').replace('zoom=1&', '').replace('zoom=1', '')
    : null;

  return {
    source:    'Google Books',
    title:     vi.title || '',
    subtitle:  vi.subtitle || '',
    author:    (vi.authors || []).join(', '),
    publisher: vi.publisher || '',
    pub_year:  vi.publishedDate?.match(/\d{4}/)?.[0] || '',
    year:      vi.publishedDate?.match(/\d{4}/)?.[0] || '',
    isbn,
    pages:     vi.pageCount?.toString() || '',
    language,
    genre,
    coverUrl:  betterCover,
    description: (vi.description || '').slice(0, 600),
    suggestedType: 'book',
    edition:   vi.printType || '',
  };
}

// ═══════════════════════════════════════════════════════════════
// INTERNET ARCHIVE — barcode lookup
// ═══════════════════════════════════════════════════════════════

async function _lookupInternetArchive(code) {
  try {
    const r = await _fetchWithTimeout(`https://archive.org/metadata/isbn_${code}`, 4000);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.metadata) return null;
    const m = data.metadata;
    const val = v => Array.isArray(v) ? v[0] : (v || '');

    // IA sometimes has subject data
    const rawSubjects = Array.isArray(m.subject) ? m.subject : (m.subject ? [m.subject] : []);
    const genre = _cleanSubjects(rawSubjects, 3);

    return {
      source:       'Internet Archive',
      title:        val(m.title),
      author:       Array.isArray(m.creator) ? m.creator.join(', ') : (m.creator || ''),
      publisher:    val(m.publisher),
      pub_year:     val(m.year),
      isbn:         code,
      language:     _langCodeToName(val(m.language)),
      genre,
      coverUrl:     null,
      suggestedType: 'book',
      description:  val(m.description) || '',
    };
  } catch (e) { console.warn('[lookup] InternetArchive error:', e); return null; }
}

// ═══════════════════════════════════════════════════════════════
// UPCITEMDB — generic UPC lookup
// ═══════════════════════════════════════════════════════════════

async function _lookupUPCitemdb(upc) {
  try {
    const r = await _fetchWithTimeout(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`, 4000);
    if (!r.ok) return null;
    const data = await r.json();
    if (data.code !== 'OK' || !data.items?.length) return null;

    const item = data.items[0];
    const cat  = (item.category || '').toLowerCase();
    let suggestedType = 'other';
    if      (cat.includes('book') || cat.includes('novel'))           suggestedType = 'book';
    else if (cat.includes('vinyl') || cat.includes('lp'))             suggestedType = 'vinyl';
    else if (cat.includes('music') || cat.includes('cd'))             suggestedType = 'cd';
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
  } catch (e) { console.warn('[lookup] UPCitemdb error:', e); return null; }
}

// ═══════════════════════════════════════════════════════════════
// MUSICBRAINZ — fallback music search
// ═══════════════════════════════════════════════════════════════

async function _searchMusicBrainz(query, mediaType) {
  try {
    const formatFilter = mediaType === 'vinyl'
      ? ' AND format:Vinyl'
      : mediaType === 'cd'
        ? ' AND format:CD'
        : mediaType === 'cassette'
          ? ' AND format:Cassette'
          : '';

    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query + formatFilter)}&limit=5&fmt=json`;
    const r = await _fetchWithTimeout(url, 6000);
    if (!r.ok) return [];
    const data = await r.json();
    if (!data.releases?.length) return [];

    return data.releases.slice(0, 5).map(rel => {
      const artist = rel['artist-credit']?.map(a => a.name || a.artist?.name || '').filter(Boolean).join(' & ') || '';
      const label  = rel['label-info']?.[0]?.label?.name || '';
      const catno  = rel['label-info']?.[0]?.['catalog-number'] || '';
      const year   = rel.date?.split('-')[0] || '';
      const country = rel.country || '';

      let suggestedType = 'vinyl';
      const medias = rel.media || [];
      for (const m of medias) {
        const fmt = (m.format || '').toLowerCase();
        if (fmt.includes('cd'))       { suggestedType = 'cd'; break; }
        if (fmt.includes('cassette')) { suggestedType = 'cassette'; break; }
        if (fmt.includes('vinyl'))    { suggestedType = 'vinyl'; break; }
      }

      return {
        source:       'MusicBrainz',
        artist,
        album:        rel.title || '',
        label,
        catalog:      catno,
        year,
        country,
        pressing:     [country, year].filter(Boolean).join(' '),
        coverUrl:     null, // MB doesn't return cover URLs directly
        suggestedType,
        genre:        '',
        format:       medias[0]?.format || '',
        mbid:         rel.id || '',
      };
    });
  } catch (e) {
    console.warn('[lookup] MusicBrainz search error:', e);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

// Merge book search results, de-duplicating by title+author
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

// Language code → readable name
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

// Clean and deduplicate subject tags
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
    .map(s => {
      // Capitalize each word and trim
      return s.trim().replace(/\b\w/g, c => c.toUpperCase());
    })
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

// Render found item card in scan results area
function _renderLookupResult(result, code) {
  const thumbHtml = result.coverUrl
    ? `<img src="${result.coverUrl}" alt="${result.title || result.album}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📦'">`
    : (_state.selectedType?.icon || '📦');

  const sub = result.author || result.artist || '';
  const meta = result.publisher || result.label || '';
  const year = result.pub_year || result.year || '';
  const genre = result.genre || '';
  const extra = result.source === 'Discogs'
    ? (result.format ? `<div class="text-xs text-muted">${result.format}${result.speed ? ' · ' + result.speed : ''}</div>` : '')
    : (result.pages ? `<div class="text-xs text-muted">${result.pages} pages</div>` : '');

  showScanStatus('matched',
    `<strong>✓ Found on ${result.source}</strong>
     <div class="lookup-result" onclick="window.applyLookupResult()">
       <div class="lookup-result-thumb">${thumbHtml}</div>
       <div style="flex:1;min-width:0">
         <div class="fw-600" style="margin-bottom:4px">${result.title || result.album || 'Untitled'}</div>
         ${sub    ? `<div class="text-sm text-muted">${sub}</div>` : ''}
         ${meta   ? `<div class="text-sm text-muted">${meta}${year ? ' · ' + year : ''}</div>` : ''}
         ${genre  ? `<div class="text-xs text-muted" style="margin-top:2px">📚 ${genre}</div>` : ''}
         ${extra}
         <button class="lookup-apply-btn" style="margin-top:10px">✓ Apply details</button>
       </div>
     </div>
     <div style="font-size:11px;color:var(--text3);margin-top:6px">Tap the card to pre-fill the form, then switch to Manual entry to review and save.</div>`
  );
}

// Populate manual form fields from a lookup/search result
function _applyResultToForm(result) {
  // Book fields
  const bookFieldMap = {
    title: 'title', author: 'author', publisher: 'publisher',
    pub_year: 'pub_year', isbn: 'isbn', pages: 'pages',
    language: 'language', genre: 'genre', edition: 'edition',
  };
  // Music fields
  const musicFieldMap = {
    artist: 'artist', album: 'album', label: 'label',
    catalog: 'catalog', year: 'year', pressing: 'pressing',
    format: 'format', speed: 'speed', genre: 'genre',
  };

  const fieldMap = ['vinyl', 'cd', 'cassette'].includes(_state.selectedType?.id)
    ? musicFieldMap
    : bookFieldMap;

  Object.entries(fieldMap).forEach(([key, field]) => {
    if (!result[key]) return;
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el) el.value = result[key];
  });

  // Notes field — for Discogs results include tracklist
  if (result.notes || result.tracklist) {
    const notesEl = document.querySelector('[data-field="notes"]');
    if (notesEl) {
      let notesVal = result.notes || '';
      if (result.tracklist) {
        notesVal = notesVal
          ? notesVal + '\n\nTracklist:\n' + result.tracklist
          : 'Tracklist:\n' + result.tracklist;
      }
      notesEl.value = notesVal;
    }
  }

  // Artist as author for books
  if (result.artist && !result.author) {
    const authorEl = document.querySelector('[data-field="author"]');
    if (authorEl) authorEl.value = result.artist;
  }

  if (result.upc) {
    const catF = document.querySelector('[data-field="catalog"]');
    if (catF) catF.value = result.upc;
  }
}

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
  } catch (_) { /* non-fatal */ }
}

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

window.applyLookupResult = applyLookupResult;