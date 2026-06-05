// js/auth.js
// ─────────────────────────────────────────────────────────────
// Authentication — Firebase when configured, local fallback otherwise
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { saveState, getUsers, saveUsers } from './storage.js';
import { navigate } from './ui.js';
import { toast } from './ui.js';
import { stopCamera } from './scanner.js';

// ── Helpers ───────────────────────────────────────────────────
function setAuthLoading(btnId, loading, label = '') {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spin">⏳</span> Please wait…' : label;
}

function showLoginError(msg) {
  const el = document.getElementById('login-err');
  el.textContent = msg;
  el.classList.add('show');
}

function showSignupError(msg) {
  const el = document.getElementById('su-err');
  el.textContent = msg;
  el.classList.add('show');
}

// Maps Firebase error codes → user-friendly strings
const FB_LOGIN_ERRORS = {
  'auth/invalid-credential':      'Invalid email or password.',
  'auth/user-not-found':          'No account found with that email.',
  'auth/wrong-password':          'Incorrect password. Try again.',
  'auth/invalid-email':           'Please enter a valid email address.',
  'auth/too-many-requests':       'Too many attempts. Please wait a moment and try again.',
  'auth/user-disabled':           'This account has been disabled.',
  'auth/network-request-failed':  'Network error — check your connection.',
};
const FB_SIGNUP_ERRORS = {
  'auth/email-already-in-use':    'That email is already registered. Try signing in.',
  'auth/weak-password':           'Password is too weak — use at least 8 characters.',
  'auth/invalid-email':           'Please enter a valid email address.',
  'auth/network-request-failed':  'Network error — check your connection.',
};

// ── Login ─────────────────────────────────────────────────────
export async function doLogin() {
  const email = document.getElementById('login-id').value.trim();
  const pw    = document.getElementById('login-pw').value;
  const errEl = document.getElementById('login-err');
  errEl.textContent = ''; errEl.classList.remove('show');

  if (!email || !pw) { showLoginError('Please enter your email and password.'); return; }

  setAuthLoading('login-btn', true);

  if (window._fb?.enabled) {
    try {
      await window._fb.login(email, pw);
      // onAuthStateChanged in firebase.js handles navigation
    } catch (e) {
      showLoginError(FB_LOGIN_ERRORS[e.code] || e.message || 'Sign-in failed. Please try again.');
      setAuthLoading('login-btn', false, 'Sign in');
    }
    return;
  }

  // Local fallback
  const user = getUsers().find(u => u.email === email || u.username === email);
  if (!user || user.password !== pw) {
    showLoginError('Invalid email/username or password.');
    setAuthLoading('login-btn', false, 'Sign in');
    return;
  }
  loginUser(user);
  setAuthLoading('login-btn', false, 'Sign in');
}

// ── Signup ────────────────────────────────────────────────────
export async function doSignup() {
  const first = document.getElementById('su-first').value.trim();
  const last  = document.getElementById('su-last').value.trim();
  const uname = document.getElementById('su-user').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const pw    = document.getElementById('su-pw').value;
  const errEl = document.getElementById('su-err');
  errEl.textContent = ''; errEl.classList.remove('show');

  if (!first || !last || !uname || !email || !pw) {
    showSignupError('Please fill in all fields.'); return;
  }
  if (pw.length < 8) {
    showSignupError('Password must be at least 8 characters.'); return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showSignupError('Please enter a valid email address.'); return;
  }

  setAuthLoading('signup-btn', true);

  if (window._fb?.enabled) {
    try {
      await window._fb.signup(email, pw, first, last, uname);
      toast('Welcome, ' + first + '! Your collection is ready.', 'success');
    } catch (e) {
      showSignupError(FB_SIGNUP_ERRORS[e.code] || e.message || 'Sign-up failed. Please try again.');
      setAuthLoading('signup-btn', false, 'Create account');
    }
    return;
  }

  // Local fallback
  const users = getUsers();
  if (users.find(u => u.email === email)) {
    showSignupError('That email is already registered.');
    setAuthLoading('signup-btn', false, 'Create account'); return;
  }
  if (users.find(u => u.username === uname)) {
    showSignupError('That username is already taken.');
    setAuthLoading('signup-btn', false, 'Create account'); return;
  }
  const newUser = {
    id: 'u' + Date.now(), username: uname, email,
    firstName: first, lastName: last, password: pw,
    joined: new Date().toISOString().split('T')[0],
  };
  users.push(newUser); saveUsers(users);
  loginUser(newUser);
  toast('Welcome, ' + first + '!', 'success');
  setAuthLoading('signup-btn', false, 'Create account');
}

// ── Shared post-login setup ───────────────────────────────────
export function loginUser(user) {
  _state.user = user;
  updateNavForAuth();
  navigate('collection');
  saveState();
}

// ── Logout ────────────────────────────────────────────────────
export async function logout() {
  stopCamera();
  if (window._fb?.enabled) {
    await window._fb.logout();
    return;
  }
  _state.user = null;
  _state.collection = [];
  updateNavForAuth();
  navigate('home');
  saveState();
}

// ── Nav state ─────────────────────────────────────────────────
export function updateNavForAuth() {
  const on  = !!_state.user;
  const off = !on;

  const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
  const cond = (id, condition) => condition ? show(id) : hide(id);

  cond('nav-login-desktop', off);
  cond('nav-user',          on);
  cond('nav-add',           on);
  cond('nb-collection',     on);
  cond('nb-trade',          on);
  cond('mbnb-collection',   on);
  cond('mbnb-trade',        on);
  cond('mob-add',           on);
  cond('mob-login',         off);
  cond('mob-user',          on);

  if (on) {
    const avatarEl = document.getElementById('nav-avatar');
    if (avatarEl) avatarEl.textContent = (_state.user.firstName || '?')[0].toUpperCase();

    // Show local-mode banner when not using Firebase
    const note = document.getElementById('login-firebase-note');
    if (note) note.style.display = window._fb?.enabled ? 'none' : 'block';
  }
}
window.updateNavForAuth = updateNavForAuth;