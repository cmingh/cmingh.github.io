// js/theme.js
// ─────────────────────────────────────────────────────────────
// Theme switching and picker rendering
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { saveState } from './storage.js';

export const THEMES = [
  { t:'dark',   label:'Dark'   },
  { t:'dawn',   label:'Dawn'   },
  { t:'slate',  label:'Slate'  },
  { t:'forest', label:'Forest' },
  { t:'rose',   label:'Rose'   },
  { t:'ink',    label:'Ink'    },
];

export function applyTheme(t) {
  _state.theme = t;
  document.documentElement.removeAttribute('data-theme');
  if (t !== 'dark') document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('.theme-dot').forEach(d =>
    d.classList.toggle('active', d.dataset.t === t)
  );
  saveState();
}

export function buildThemePickers() {
  ['theme-picker', 'settings-theme-picker', 'mobile-theme-picker'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = THEMES.map(({ t, label }) =>
      `<div class="theme-dot${_state.theme === t ? ' active' : ''}" data-t="${t}" title="${label}"
            onclick="window.applyTheme('${t}')"></div>`
    ).join('');
  });
}

// ── Theme dropdown toggle ──────────────────────────────────────
let _themeOpen = false;

export function toggleThemePicker() {
  _themeOpen = !_themeOpen;
  document.getElementById('theme-picker').style.display = _themeOpen ? 'flex' : 'none';
}

// Close picker when clicking outside
document.addEventListener('click', e => {
  if (_themeOpen &&
      !e.target.closest('[onclick*="toggleThemePicker"]') &&
      !e.target.closest('#theme-picker')) {
    _themeOpen = false;
    document.getElementById('theme-picker').style.display = 'none';
  }
});