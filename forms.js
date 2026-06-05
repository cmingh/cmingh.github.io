// js/forms.js
// ─────────────────────────────────────────────────────────────
// Manual-entry form builder for the Add Item modal.
// Handles all media types including the comic book specialised UI.
// Also owns the _comicTagSelected mutable state object.
// ─────────────────────────────────────────────────────────────

import { _state, MEDIA_TYPES, COMIC_SPECIAL, CONDITION_OPTIONS, BINDING_OPTIONS } from './state.js';

// ── Comic tag selection state ─────────────────────────────────
// Exported as a plain object so mutations are visible to importers.
export const _comicTagSelected = {};

export function resetComicTags() {
  // Clear all own properties without replacing the reference
  // (importers hold a reference to this exact object)
  for (const key of Object.keys(_comicTagSelected)) {
    delete _comicTagSelected[key];
  }
}

// ═══════════════════════════════════════════════════════════════
// MANUAL FORM BUILDER
// ═══════════════════════════════════════════════════════════════

export function buildManualForm() {
  const mt   = _state.selectedType;
  const wrap = document.getElementById('manual-form-fields');
  if (!mt || !wrap) return;
  wrap.innerHTML = '';

  // Cover image picker (all types)
  wrap.innerHTML += `
    <div class="form-group">
      <label class="form-label">Cover image (optional)</label>
      <div style="display:flex;gap:10px;align-items:center">
        <div id="cover-preview"
             style="width:48px;height:64px;background:var(--bg3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden;border:1px solid var(--border)">
          ${mt.icon}
        </div>
        <button class="btn-ghost" onclick="document.getElementById('cover-file').click()" type="button">Upload cover</button>
        <input type="file" id="cover-file" accept="image/*" style="display:none" onchange="window.previewCover(event)">
      </div>
    </div>`;

  if (mt.isComic) {
    _buildComicForm(wrap);
    return;
  }

  // Generic fields
  mt.fields.forEach(f => {
    const label = _fieldLabel(f);
    if (f === 'condition') {
      wrap.innerHTML += _selectField(f, label, CONDITION_OPTIONS);
    } else if (f === 'binding') {
      wrap.innerHTML += _selectField(f, label, BINDING_OPTIONS);
    } else if (f === 'complete') {
      wrap.innerHTML += _selectField(f, label, ['No', 'Yes']);
    } else if (f === 'notes' || f === 'description') {
      wrap.innerHTML += `
        <div class="form-group">
          <label class="form-label">${label}</label>
          <textarea class="form-input" data-field="${f}" rows="2" style="resize:vertical" placeholder="Additional notes…"></textarea>
        </div>`;
    } else {
      wrap.innerHTML += `
        <div class="form-group">
          <label class="form-label">${label}</label>
          <input class="form-input" data-field="${f}" placeholder="${label}">
        </div>`;
    }
  });
}

// ── Comic-specific form ───────────────────────────────────────
function _buildComicForm(wrap) {
  wrap.innerHTML += `
    <div class="form-row">
      <div class="form-group"><label class="form-label">Title</label><input class="form-input" data-field="title" placeholder="Amazing Spider-Man"></div>
      <div class="form-group"><label class="form-label">Issue #</label><input class="form-input" data-field="issue" placeholder="#129"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Publisher</label><input class="form-input" data-field="publisher" placeholder="Marvel Comics"></div>
      <div class="form-group"><label class="form-label">Publication Date</label><input class="form-input" data-field="pub_date" placeholder="Feb 1974"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Writer</label><input class="form-input" data-field="writer"></div>
      <div class="form-group"><label class="form-label">Cover Artist</label><input class="form-input" data-field="cover_artist"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Penciler</label><input class="form-input" data-field="penciler"></div>
      <div class="form-group"><label class="form-label">Inker</label><input class="form-input" data-field="inker"></div>
    </div>
    <div class="form-group">
      <label class="form-label">Edition / Copy Type</label>
      <div class="comic-tags-wrap">
        ${COMIC_SPECIAL.edition_type.map(v =>
          `<div class="comic-tag" data-field="edition_type" data-val="${v}" onclick="window.toggleComicTag(this)">${v}</div>`
        ).join('')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Variant</label>
      <div class="comic-tags-wrap">
        ${COMIC_SPECIAL.variant.map(v =>
          `<div class="comic-tag" data-field="variant" data-val="${v}" onclick="window.toggleComicTag(this)">${v}</div>`
        ).join('')}
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Condition (raw)</label>
        ${_selectFieldHtml('condition', CONDITION_OPTIONS)}
      </div>
      <div class="form-group"><label class="form-label">Printing</label><input class="form-input" data-field="printing" placeholder="1st printing"></div>
    </div>
    <div class="form-group">
      <label class="form-label">Professional Grade</label>
      <div class="comic-tags-wrap">
        ${COMIC_SPECIAL.grade.map(v =>
          `<div class="comic-tag" data-field="grade" data-val="${v}" onclick="window.toggleComicTag(this,'grade')">${v}</div>`
        ).join('')}
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Graded By</label>
        <select class="form-select" data-field="grader">
          <option value="">Not graded</option>
          ${COMIC_SPECIAL.grader.map(o => `<option>${o}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Newsstand Copy?</label>
        ${_selectFieldHtml('newsstand', ['No', 'Yes'])}
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Signed?</label>
        ${_selectFieldHtml('signed', ['No', 'Yes'])}
      </div>
      <div class="form-group"><label class="form-label">Stamp / Sticker</label><input class="form-input" data-field="stamp" placeholder="Convention stamp…"></div>
    </div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <textarea class="form-input" data-field="notes" rows="2" style="resize:vertical"></textarea>
    </div>`;
}

// ── Comic tag toggle ──────────────────────────────────────────
export function toggleComicTag(el, group) {
  const field = el.dataset.field;
  const val   = el.dataset.val;

  if (field === 'grade' || group === 'grade') {
    // Grade is single-select
    document.querySelectorAll('[data-field="grade"]').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    _comicTagSelected[field] = val;
  } else {
    // Others are multi-select
    el.classList.toggle('active');
    if (!Array.isArray(_comicTagSelected[field])) _comicTagSelected[field] = [];
    const arr = _comicTagSelected[field];
    const idx = arr.indexOf(val);
    if (idx > -1) arr.splice(idx, 1); else arr.push(val);
  }
}
window.toggleComicTag = toggleComicTag;

// ── Cover image preview (called from inline onchange) ─────────
export function previewCover(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const el = document.getElementById('cover-preview');
    if (el) el.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    _state.editingItem._coverData = ev.target.result;
  };
  reader.readAsDataURL(file);
}
window.previewCover = previewCover;

export function populateManualForm(item) {
  if (!item) return;
  const preview = document.getElementById('cover-preview');
  if (preview) {
    preview.innerHTML = item.coverData
      ? `<img src="${item.coverData}" style="width:100%;height:100%;object-fit:cover">`
      : (MEDIA_TYPES.find(m => m.id === item.type)?.icon || '📦');
  }

  if (item.fields) {
    Object.entries(item.fields).forEach(([key, value]) => {
      const el = document.querySelector(`[data-field="${key}"]`);
      if (el) el.value = value || '';
    });
  }

  if (item.comicTags && typeof item.comicTags === 'object') {
    Object.entries(item.comicTags).forEach(([field, val]) => {
      if (Array.isArray(val)) {
        _comicTagSelected[field] = [...val];
      } else if (val) {
        _comicTagSelected[field] = val;
      }
      document.querySelectorAll(`[data-field="${field}"]`).forEach(el => {
        if (Array.isArray(val) ? val.includes(el.dataset.val) : el.dataset.val === val) {
          el.classList.add('active');
        }
      });
    });
  }
}

// ── Internal helpers ──────────────────────────────────────────
function _fieldLabel(f) {
  const LABELS = {
    title:'Title', artist:'Artist / Band', author:'Author', album:'Album', year:'Year',
    pub_year:'Year', pub_date:'Publication Date', issue_date:'Issue Date', publisher:'Publisher',
    label:'Label', catalog:'Catalog #', pressing:'Pressing / Country', speed:'Speed (RPM)',
    condition:'Condition', format:'Format', notes:'Notes', isbn:'ISBN', edition:'Edition',
    binding:'Binding', genre:'Genre', language:'Language', issue:'Issue #',
    cover_artist:'Cover Artist', writer:'Writer', penciler:'Penciler', inker:'Inker',
    colorist:'Colorist', variant:'Variant', print_run:'Print Run', edition_type:'Edition Type',
    grade:'Grade', grader:'Graded By', newsstand:'Newsstand?', printing:'Printing #',
    signed:'Signed?', stamp:'Stamp / Sticker', headline:'Headline', volume:'Volume #',
    platform:'Platform', region:'Region', disc_count:'Disc Count', complete:'Complete in Box?',
    studio:'Studio', subject:'Subject', photographer:'Photographer', size:'Size / Dimensions',
    medium:'Medium', creator:'Creator', type:'Type / Category', pages:'Pages', description:'Description',
  };
  return LABELS[f] || f;
}

function _selectFieldHtml(field, options) {
  return `<select class="form-select" data-field="${field}">
    <option value="">— Select —</option>
    ${options.map(o => `<option>${o}</option>`).join('')}
  </select>`;
}

function _selectField(field, label, options) {
  return `<div class="form-group"><label class="form-label">${label}</label>${_selectFieldHtml(field, options)}</div>`;
}