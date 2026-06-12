// js/auth.js  (v2 — username/phone login support)
// ─────────────────────────────────────────────────────────────
// CHANGES vs original:
//   - doLogin() accepts email, username, OR phone number.
//   - Local mode: matches against all three fields.
//   - Firebase mode: if the identifier is not an email, we first
//     look up the matching email in Firestore (users collection,
//     indexed by username or phone), then sign in with that email.
//   - Login field placeholder updated to reflect all three options.
//   - Phone validation is permissive (strips spaces/dashes/parens).
// ─────────────────────────────────────────────────────────────

import { _state } from './state.js';
import { saveState, getUsers, saveUsers } from './storage.js';
import { navigate, toast } from './ui.js';
import { stopCamera } from './scanner.js';

// ── Helpers ───────────────────────────────────────────────────
function setAuthLoading(btnId, loading, label = '') {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled  = loading;
  btn.innerHTML = loading ? '<span class="spin">⏳</span> Please wait…' : label;
}

function showLoginError(msg) {
  const el = document.getElementById('login-err');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}

function showSignupError(msg) {
  const el = document.getElementById('su-err');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}

const FB_LOGIN_ERRORS = {
  'auth/invalid-credential':     'Invalid credentials. Check your details and try again.',
  'auth/user-not-found':         'No account found with that email.',
  'auth/wrong-password':         'Incorrect password. Try again.',
  'auth/invalid-email':          'Please enter a valid email address.',
  'auth/too-many-requests':      'Too many attempts — please wait a moment and try again.',
  'auth/user-disabled':          'This account has been disabled.',
  'auth/network-request-failed': 'Network error — check your connection.',
};
const FB_SIGNUP_ERRORS = {
  'auth/email-already-in-use':   'That email is already registered. Try signing in.',
  'auth/weak-password':          'Password must be at least 8 characters.',
  'auth/invalid-email':          'Please enter a valid email address.',
  'auth/network-request-failed': 'Network error — check your connection.',
};

// ── Identifier helpers ────────────────────────────────────────
/** True if the string looks like an email */
function _isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** True if the string looks like a phone number (very permissive) */
function _isPhone(s) {
  // Strip all formatting characters and check we're left with 7–15 digits
  const digits = s.replace(/[\s\-().+]/g, '');
  return /^\d{7,15}$/.test(digits);
}

/** Normalise a phone string to digits only for comparison */
function _normalisePhone(s) {
  return s.replace(/[\s\-().+]/g, '');
}

// ═══════════════════════════════════════════════════════════════
// LOGIN
// Accepts:  email  |  username  |  phone number
// ═══════════════════════════════════════════════════════════════

export async function doLogin() {
  const identifier = document.getElementById('login-id').value.trim();
  const pw         = document.getElementById('login-pw').value;
  const errEl      = document.getElementById('login-err');
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }

  if (!identifier || !pw) {
    showLoginError('Please enter your email / username / phone and your password.');
    return;
  }

  setAuthLoading('login-btn', true);

  // ── Firebase path ─────────────────────────────────────────
  if (window._fb?.enabled) {
    let emailToUse = identifier;

    // If not an email, look up the email via Firestore
    if (!_isEmail(identifier)) {
      try {
        emailToUse = await _resolveEmailFromFirestore(identifier);
      } catch (_) {
        showLoginError('No account found with that username or phone number.');
        setAuthLoading('login-btn', false, 'Sign in');
        return;
      }
      if (!emailToUse) {
        showLoginError('No account found with that username or phone number.');
        setAuthLoading('login-btn', false, 'Sign in');
        return;
      }
    }

    try {
      await window._fb.login(emailToUse, pw);
      // onAuthStateChanged in firebase.js handles navigation
      setAuthLoading('login-btn', false, 'Sign in');
    } catch (e) {
      showLoginError(FB_LOGIN_ERRORS[e.code] || e.message || 'Sign-in failed. Please try again.');
      setAuthLoading('login-btn', false, 'Sign in');
    }
    return;
  }

  // ── Local fallback ────────────────────────────────────────
  const users = getUsers();
  const user  = _findLocalUser(users, identifier);

  if (!user || user.password !== pw) {
    showLoginError('No account matches those details, or the password is wrong.');
    setAuthLoading('login-btn', false, 'Sign in');
    return;
  }

  loginUser(user);
  setAuthLoading('login-btn', false, 'Sign in');
}

/**
 * Match a local user by email, username, or normalised phone.
 */
function _findLocalUser(users, identifier) {
  const lower = identifier.toLowerCase();
  const phone = _normalisePhone(identifier);

  return users.find(u =>
    u.email?.toLowerCase()              === lower ||
    u.username?.toLowerCase()           === lower ||
    (_isPhone(identifier) && _normalisePhone(u.phone || '') === phone)
  ) || null;
}

/**
 * Firebase: look up which email corresponds to a username or phone.
 * Queries the 'users' Firestore collection.
 * Throws if the lookup fails entirely; returns null if not found.
 */
async function _resolveEmailFromFirestore(identifier) {
  if (!window._fb?.queryUserByIdentifier) {
    // Fallback if the method hasn't been added to _fb yet
    return null;
  }
  return window._fb.queryUserByIdentifier(identifier);
}

// ═══════════════════════════════════════════════════════════════
// SIGNUP
// ═══════════════════════════════════════════════════════════════

export async function doSignup() {
  const first = document.getElementById('su-first').value.trim();
  const last  = document.getElementById('su-last').value.trim();
  const uname = document.getElementById('su-user').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const phone = document.getElementById('su-phone').value.trim();
  const pw    = document.getElementById('su-pw').value;
  const errEl      = document.getElementById('su-err');
  const unameErrEl = document.getElementById('su-user-err');
  if (errEl)      { errEl.textContent = '';      errEl.classList.remove('show'); }
  if (unameErrEl) { unameErrEl.textContent = ''; unameErrEl.classList.remove('show'); }

  if (!first || !last || !uname || !email || !pw) {
    showSignupError('Please fill in all required fields.'); return;
  }
  if (pw.length < 8) {
    showSignupError('Password must be at least 8 characters.'); return;
  }
  if (!_isEmail(email)) {
    showSignupError('Please enter a valid email address.'); return;
  }
  if (uname.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(uname)) {
    if (unameErrEl) {
      unameErrEl.textContent = 'Username must be 3+ characters — letters, numbers, _ or -';
      unameErrEl.classList.add('show');
    }
    return;
  }
  if (phone && !_isPhone(phone)) {
    showSignupError('Phone number looks invalid — digits, spaces, dashes and () are accepted.'); return;
  }

  setAuthLoading('signup-btn', true);

  if (window._fb?.enabled) {
    try {
      await window._fb.signup(email, pw, first, last, uname, phone);
      setAuthLoading('signup-btn', false, 'Create account');
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
    if (unameErrEl) {
      unameErrEl.textContent = 'That username is already taken.';
      unameErrEl.classList.add('show');
    }
    setAuthLoading('signup-btn', false, 'Create account'); return;
  }
  const newUser = {
    id: 'u' + Date.now(), username: uname, email,
    phone: phone ? _normalisePhone(phone) : null,
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

// ── Google OAuth (stubs) ──────────────────────────────────────
export async function doGoogleLogin() {
  setAuthLoading('login-google-btn', true, 'Signing in…');
  if (window._fb?.enabled && window._fb.googleLogin) {
    try {
      await window._fb.googleLogin();
      setAuthLoading('login-google-btn', false, '🔐 Sign in with Google');
    } catch (e) {
      showLoginError('Google sign-in failed: ' + (e.message || 'Unknown error'));
      setAuthLoading('login-google-btn', false, '🔐 Sign in with Google');
    }
  } else {
    showLoginError('Google sign-in is not available in this environment.');
    setAuthLoading('login-google-btn', false, '🔐 Sign in with Google');
  }
}
window.doGoogleLogin = doGoogleLogin;

export async function doGoogleSignup() {
  setAuthLoading('signup-google-btn', true, 'Creating account…');
  if (window._fb?.enabled && window._fb.googleSignup) {
    try {
      await window._fb.googleSignup();
      setAuthLoading('signup-google-btn', false, '🔐 Sign up with Google');
    } catch (e) {
      showSignupError('Google sign-up failed: ' + (e.message || 'Unknown error'));
      setAuthLoading('signup-google-btn', false, '🔐 Sign up with Google');
    }
  } else {
    showSignupError('Google sign-up is not available in this environment.');
    setAuthLoading('signup-google-btn', false, '🔐 Sign up with Google');
  }
}
window.doGoogleSignup = doGoogleSignup;

// ── Username availability check ───────────────────────────────
export function isUsernameAvailable(username) {
  if (!username || username.length < 3) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return false;
  if (window._fb?.enabled) return true; // validated server-side
  return !getUsers().find(u => u.username === username);
}
window.isUsernameAvailable = isUsernameAvailable;

// ── Logout ────────────────────────────────────────────────────
export async function logout() {
  stopCamera();
  if (window._fb?.enabled) {
    await window._fb.logout();
    return;
  }
  _state.user       = null;
  _state.collection = [];
  updateNavForAuth();
  navigate('home');
  saveState();
}

// ── Nav state ─────────────────────────────────────────────────
export function updateNavForAuth() {
  const on  = !!_state.user;
  const off = !on;

  const show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
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

    const note = document.getElementById('login-firebase-note');
    if (note) note.style.display = window._fb?.enabled ? 'none' : 'block';
  }
}
window.updateNavForAuth = updateNavForAuth;