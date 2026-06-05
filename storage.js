// js/storage.js
// ─────────────────────────────────────────────────────────────
// localStorage helpers — only used when Firebase is not configured.
// Firebase users get real-time Firestore sync instead.
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';

export function saveState() {
  if (window._fb?.enabled) return; // Firestore handles persistence
  try {
    localStorage.setItem('mn_state', JSON.stringify({
      user:       _state.user,
      theme:      _state.theme,
      collection: _state.collection,
      wishlist:   _state.wishlist,
      messages:   _state.messages,
      trades:     _state.trades,
    }));
  } catch (e) {
    console.warn('saveState failed:', e);
  }
}

export function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('mn_state') || 'null');
    if (s) Object.assign(_state, s);
  } catch (e) {
    console.warn('loadState failed:', e);
  }
}

// ── Local "users" store (only used in local mode) ─────────────
const DEMO_USERS = [
  { id:'u1', username:'jane_collects', email:'jane@example.com',  firstName:'Jane',   lastName:'Doe',  password:'password', joined:'2024-03-10' },
  { id:'u2', username:'vinyl_king',    email:'vinyl@example.com', firstName:'Marcus', lastName:'Hall', password:'password', joined:'2024-01-05' },
];

export function getUsers() {
  try { return JSON.parse(localStorage.getItem('mn_users') || JSON.stringify(DEMO_USERS)); }
  catch (e) { return DEMO_USERS; }
}

export function saveUsers(u) {
  localStorage.setItem('mn_users', JSON.stringify(u));
}