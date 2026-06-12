// js/discogs.js
// ─────────────────────────────────────────────────────────────
// Discogs API integration for music media (vinyl, CD, cassette).
// Uses the public Discogs search API (no auth required for search).
// Full release details fetched via /releases/{id} endpoint.
// ─────────────────────────────────────────────────────────────

const DISCOGS_BASE = 'https://api.discogs.com';
// User-Agent is required by Discogs API terms
const DISCOGS_HEADERS = {
  'User-Agent': 'MediaNest/1.0 +https://github.com/medianest',
};

// ─────────────────────────────────────────────────────────────
// BARCODE LOOKUP via Discogs
// ─────────────────────────────────────────────────────────────

/**
 * Look up a barcode via Discogs.
 * Returns a normalized result object or null.
 */
export async function discogsLookupBarcode(barcode) {
  try {
    // Strip non-numeric chars for Discogs barcode search
    const cleaned = barcode.replace(/[\s\-]/g, '');
    const url = `${DISCOGS_BASE}/database/search?barcode=${encodeURIComponent(cleaned)}&type=release&per_page=5`;
    const r = await _discogsGet(url);
    if (!r.results?.length) return null;

    // Grab the best match — prefer exact barcode match
    const best = r.results[0];
    return await _discogsReleaseToResult(best);
  } catch (e) {
    console.warn('[discogs] Barcode lookup failed:', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// TITLE SEARCH via Discogs
// ─────────────────────────────────────────────────────────────

/**
 * Search Discogs by title/artist query.
 * @param {string} query
 * @param {'release'|'master'} [type='release']
 * @param {string} [mediaType] - 'vinyl', 'cd', 'cassette', etc.
 * @returns {Array} Up to 8 normalized result objects
 */
export async function discogsSearchByTitle(query, mediaType = '') {
  try {
    const formatMap = {
      vinyl:    'Vinyl',
      cd:       'CD',
      cassette: 'Cassette',
    };
    const format = formatMap[mediaType] || '';
    let url = `${DISCOGS_BASE}/database/search?q=${encodeURIComponent(query)}&type=release&per_page=8`;
    if (format) url += `&format=${encodeURIComponent(format)}`;

    const r = await _discogsGet(url);
    if (!r.results?.length) return [];

    // Fetch details for top 5 results in parallel (capped to avoid rate limits)
    const top = r.results.slice(0, 5);
    const results = await Promise.allSettled(top.map(item => _discogsReleaseToResult(item)));
    return results
      .filter(p => p.status === 'fulfilled' && p.value)
      .map(p => p.value);
  } catch (e) {
    console.warn('[discogs] Search failed:', e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// FULL RELEASE DETAILS
// ─────────────────────────────────────────────────────────────

export async function discogsGetRelease(releaseId) {
  try {
    const data = await _discogsGet(`${DISCOGS_BASE}/releases/${releaseId}`);
    return _normalizeRelease(data);
  } catch (e) {
    console.warn('[discogs] Release fetch failed:', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

async function _discogsGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, {
      headers: DISCOGS_HEADERS,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/**
 * Given a search result stub, fetch full release details.
 */
async function _discogsReleaseToResult(stub) {
  if (!stub) return null;

  // If we already have a release id, fetch full data
  const resourceUrl = stub.resource_url;
  let full = null;
  if (resourceUrl) {
    try {
      full = await _discogsGet(resourceUrl);
    } catch (e) {
      // Fall back to stub data
    }
  }

  return _normalizeRelease(full || stub);
}

/**
 * Normalize Discogs release data into MediaNest field format.
 */
function _normalizeRelease(d) {
  if (!d) return null;

  // Artist name — Discogs can have multiple artists with join strings
  let artist = '';
  if (d.artists?.length) {
    artist = d.artists
      .map(a => (a.name || '').replace(/\s*\(\d+\)\s*$/, '').trim()) // strip disambiguation numbers
      .join(d.artists[0]?.join?.trim() === ',' ? ', ' : ' & ');
  } else if (Array.isArray(d.artists_sort)) {
    artist = d.artists_sort;
  } else if (typeof d.artists_sort === 'string') {
    artist = d.artists_sort.replace(/\s*\(\d+\)\s*$/, '').trim();
  } else if (d.title) {
    // search result format: "Artist – Title"
    const parts = d.title.split(' - ');
    if (parts.length >= 2) {
      artist = parts[0].trim();
    }
  }

  // Album/title
  let album = d.title || '';
  if (album.includes(' - ')) {
    // search result: "Artist - Album"
    const parts = album.split(' - ');
    album = parts.slice(1).join(' - ').trim();
  }

  // Label
  const label = d.labels?.length
    ? d.labels.map(l => l.name).join(', ')
    : (Array.isArray(d.label) ? d.label.join(', ') : (d.label || ''));

  // Catalog number
  const catalog = d.labels?.length
    ? (d.labels[0].catno !== 'none' ? d.labels[0].catno : '')
    : (d.catno !== 'none' ? (d.catno || '') : '');

  // Year
  const year = d.year?.toString() || d.released?.split('-')[0] || '';

  // Country / pressing
  const pressing = [d.country, d.released ? d.released.split('-')[0] : ''].filter(Boolean).join(' ');

  // Format details (speed, type, etc.)
  let format = '';
  let speed = '';
  let mediaType = 'vinyl'; // default

  const formats = d.formats || [];
  for (const f of formats) {
    const name = (f.name || '').toLowerCase();
    const descriptions = (f.descriptions || []).map(x => x.toLowerCase());

    if (name === 'vinyl' || name === 'lp' || name === 'ep' || name === '7"' || name === '12"' || name === '10"') {
      mediaType = 'vinyl';
      format = f.name + (f.descriptions?.length ? ' · ' + f.descriptions.join(', ') : '');
      // Detect speed
      const spdMatch = descriptions.find(d => d.includes('rpm'));
      if (spdMatch) {
        speed = spdMatch.replace('rpm', '').trim() + ' RPM';
      } else if (name.includes('7') || descriptions.includes('45 rpm')) {
        speed = '45 RPM';
      } else if (descriptions.includes('33 rpm') || name === 'lp') {
        speed = '33⅓ RPM';
      }
    } else if (name === 'cd') {
      mediaType = 'cd';
      format = f.name + (f.descriptions?.length ? ' · ' + f.descriptions.join(', ') : '');
    } else if (name === 'cassette') {
      mediaType = 'cassette';
      format = f.name + (f.descriptions?.length ? ' · ' + f.descriptions.join(', ') : '');
    } else if (format === '') {
      format = f.name;
    }
  }

  // Genres & styles — Discogs separates these
  const genres = [
    ...(d.genres || []),
    ...(d.styles || []),
  ].filter(Boolean).slice(0, 5).join(', ');

  // Track listing
  const tracklist = d.tracklist?.length
    ? d.tracklist.map(t => {
        const dur = t.duration ? ` (${t.duration})` : '';
        return `${t.position ? t.position + '. ' : ''}${t.title}${dur}`;
      }).join('\n')
    : '';

  // Cover image
  const coverUrl = d.images?.find(i => i.type === 'primary')?.uri
    || d.images?.[0]?.uri
    || d.thumb
    || d.cover_image
    || null;

  // Notes / description
  const notes = d.notes || '';

  // Extra Discogs fields
  const discogsId = d.id?.toString() || '';
  const discogsUrl = d.uri || (d.id ? `https://www.discogs.com/release/${d.id}` : '');

  return {
    source:       'Discogs',
    discogsId,
    discogsUrl,
    // Standard MediaNest fields
    artist,
    album,
    label,
    catalog,
    year,
    pressing,
    format,
    speed,
    genre:        genres,
    tracklist,
    notes,
    coverUrl,
    suggestedType: mediaType,
    // Extra Discogs-specific
    country:      d.country || '',
    released:     d.released || year,
    numTracks:    d.tracklist?.length?.toString() || '',
    condition:    '', // user fills in
    masterUrl:    d.master_url || '',
    masterId:     d.master_id?.toString() || '',
    community:    d.community ? {
      have: d.community.have,
      want: d.community.want,
      ratingAvg: d.community.rating?.average,
      ratingCount: d.community.rating?.count,
    } : null,
  };
}

// Exposed helpers for the cover-scan/title-search results UI
export function discogsResultToFormFields(result) {
  return {
    artist:   result.artist   || '',
    album:    result.album    || '',
    label:    result.label    || '',
    catalog:  result.catalog  || '',
    year:     result.year     || '',
    pressing: result.pressing || '',
    format:   result.format   || '',
    speed:    result.speed    || '',
    genre:    result.genre    || '',
    notes:    result.tracklist
      ? (result.notes ? result.notes + '\n\nTracklist:\n' + result.tracklist : 'Tracklist:\n' + result.tracklist)
      : (result.notes || ''),
  };
}