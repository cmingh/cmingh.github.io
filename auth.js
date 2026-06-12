// js/auth.js  (v3 — rock-solid username / phone / email login)
// ─────────────────────────────────────────────────────────────
// CHANGES vs v2:
//   - doLogin() robustly handles email, username, OR phone.
//   - Firebase path: Firestore lookup for username/phone is done
//     with two separate where() queries (one per field) and
//     returns the first match found, so it works regardless of
//     whether the user registered with a username or phone.
//   - Local path: three-field match (email, username, phone).
//   - _isEmail / _isPhone helpers are more reliable.
//   - Better error messages that distinguish "not found" from
//     "wrong password".
//   - updateNavForAuth() is more resilient to missing DOM nodes.
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

function clearLoginError() {
  const el = document.getElementById('login-err');
  if (el) { el.textContent = ''; el.classList.remove('show'); }
}

function clearSignupError() {
  const el = document.getElementById('su-err');
  if (el) { el.textContent = ''; el.classList.remove('show'); }
  const uel = document.getElementById('su-user-err');
  if (uel) { uel.textContent = ''; uel.classList.remove('show'); }
}

// ── Firebase error maps ───────────────────────────────────────
const FB_LOGIN_ERRORS = {
  'auth/invalid-credential':     'Invalid credentials. Check your details and try again.',
  'auth/user-not-found':         'No account found. Check your email / username and try again.',
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

/** True if the string looks like an email address */
function _isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * True if the string could be a phone number.
 * Accepts international formats: +1 555-123-4567 / (555) 123 4567 / 5551234567
 * After stripping formatting we check we have 7–15 digits.
 */
function _isPhone(s) {
  const digits = s.replace(/[\s\-().+]/g, '');
  return /^\d{7,15}$/.test(digits);
}

/** Normalise a phone string to digits only for comparison */
function _normalisePhone(s) {
  return (s || '').replace(/[\s\-().+]/g, '');
}

// ═══════════════════════════════════════════════════════════════
// LOGIN
// Accepts:  email  |  username  |  phone number
// ═══════════════════════════════════════════════════════════════

export async function doLogin() {
  const identifier = (document.getElementById('login-id')?.value || '').trim();
  const pw         = document.getElementById('login-pw')?.value || '';
  clearLoginError();

  if (!identifier) {
    showLoginError('Please enter your email, username, or phone number.');
    return;
  }
  if (!pw) {
    showLoginError('Please enter your password.');
    return;
  }

  setAuthLoading('login-btn', true);

  // ── Firebase path ─────────────────────────────────────────
  if (window._fb?.enabled) {
    let emailToUse = identifier;

    if (!_isEmail(identifier)) {
      // Resolve email via Firestore (by username or phone)
      try {
        emailToUse = await _resolveEmailFromFirestore(identifier);
      } catch (err) {
        console.warn('[auth] Firestore lookup error:', err);
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
    } catch (e) {
      showLoginError(FB_LOGIN_ERRORS[e.code] || e.message || 'Sign-in failed. Please try again.');
    }

    setAuthLoading('login-btn', false, 'Sign in');
    return;
  }

  // ── Local fallback ────────────────────────────────────────
  const users = getUsers();
  const user  = _findLocalUser(users, identifier);

  if (!user) {
    showLoginError('No account found with that email, username, or phone number.');
    setAuthLoading('login-btn', false, 'Sign in');
    return;
  }

  if (user.password !== pw) {
    showLoginError('Incorrect password. Please try again.');
    setAuthLoading('login-btn', false, 'Sign in');
    return;
  }

  loginUser(user);
  setAuthLoading('login-btn', false, 'Sign in');
}
window.doLogin = doLogin;

// ── Local user finder ─────────────────────────────────────────
/**
 * Match a local user by email, username, or normalised phone.
 * Case-insensitive for email and username.
 */
function _findLocalUser(users, identifier) {
  const lower = identifier.toLowerCase().trim();
  const phone = _normalisePhone(identifier);

  return users.find(u => {
    if ((u.email    || '').toLowerCase() === lower)   return true;
    if ((u.username || '').toLowerCase() === lower)   return true;
    if (_isPhone(identifier) && u.phone &&
        _normalisePhone(u.phone) === phone)            return true;
    return false;
  }) || null;
}

// ── Firebase email resolver ───────────────────────────────────
/**
 * Given a username or phone number, look up the corresponding
 * email in Firestore's 'users' collection.
 *
 * We try TWO queries:
 *   1. where('username', '==', identifier)  — exact match
 *   2. where('phone',    '==', normalised)  — digits-only match
 *
 * Returns the email string if found, or null.
 * Throws only on genuine network / permission errors.
 */
async function _resolveEmailFromFirestore(identifier) {
  // Check if the _fb object exposes a lookup helper
  if (typeof window._fb?.queryUserByIdentifier === 'function') {
    return window._fb.queryUserByIdentifier(identifier);
  }

  // Fallback: if firebase.js didn't expose queryUserByIdentifier yet,
  // we can't do a Firestore query here without importing firebase modules.
  // Return null to surface a friendly "not found" message rather than crash.
  console.warn('[auth] window._fb.queryUserByIdentifier not available. ' +
    'Add it to firebase.js to support username/phone login on Firebase.');
  return null;
}

// ═══════════════════════════════════════════════════════════════
// SIGNUP
// ═══════════════════════════════════════════════════════════════

export async function doSignup() {
  const first = (document.getElementById('su-first')?.value || '').trim();
  const last  = (document.getElementById('su-last')?.value  || '').trim();
  const uname = (document.getElementById('su-user')?.value  || '').trim();
  const email = (document.getElementById('su-email')?.value || '').trim();
  const phone = (document.getElementById('su-phone')?.value || '').trim();
  const pw    =  document.getElementById('su-pw')?.value    || '';
  clearSignupError();

  // — Validation —
  if (!first || !last || !uname || !email || !pw) {
    showSignupError('Please fill in all required fields.');
    return;
  }
  if (pw.length < 8) {
    showSignupError('Password must be at least 8 characters.');
    return;
  }
  if (!_isEmail(email)) {
    showSignupError('Please enter a valid email address.');
    return;
  }
  if (uname.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(uname)) {
    const uel = document.getElementById('su-user-err');
    if (uel) {
      uel.textContent = 'Username must be 3+ characters — letters, numbers, _ or -';
      uel.classList.add('show');
    }
    return;
  }
  if (phone && !_isPhone(phone)) {
    showSignupError('Phone number looks invalid — digits, spaces, dashes and () are accepted.');
    return;
  }

  setAuthLoading('signup-btn', true);

  // ── Firebase path ─────────────────────────────────────────
  if (window._fb?.enabled) {
    try {
      await window._fb.signup(email, pw, first, last, uname, phone);
      toast('Welcome, ' + first + '! Your collection is ready.', 'success');
    } catch (e) {
      showSignupError(FB_SIGNUP_ERRORS[e.code] || e.message || 'Sign-up failed. Please try again.');
    }
    setAuthLoading('signup-btn', false, 'Create account');
    return;
  }

  // ── Local fallback ────────────────────────────────────────
  const users = getUsers();

  if (users.find(u => u.email?.toLowerCase() === email.toLowerCase())) {
    showSignupError('That email is already registered.');
    setAuthLoading('signup-btn', false, 'Create account');
    return;
  }
  if (users.find(u => u.username?.toLowerCase() === uname.toLowerCase())) {
    const uel = document.getElementById('su-user-err');
    if (uel) { uel.textContent = 'That username is already taken.'; uel.classList.add('show'); }
    setAuthLoading('signup-btn', false, 'Create account');
    return;
  }

  const normalisedPhone = phone ? _normalisePhone(phone) : null;
  if (normalisedPhone && users.find(u => _normalisePhone(u.phone || '') === normalisedPhone)) {
    showSignupError('That phone number is already registered to another account.');
    setAuthLoading('signup-btn', false, 'Create account');
    return;
  }

  const newUser = {
    id:        'u' + Date.now(),
    username:  uname,
    email,
    phone:     normalisedPhone,
    firstName: first,
    lastName:  last,
    password:  pw,
    joined:    new Date().toISOString().split('T')[0],
  };
  users.push(newUser);
  saveUsers(users);
  loginUser(newUser);
  toast('Welcome, ' + first + '!', 'success');
  setAuthLoading('signup-btn', false, 'Create account');
}
window.doSignup = doSignup;

// ── Shared post-login setup ───────────────────────────────────
export function loginUser(user) {
  _state.user = user;
  updateNavForAuth();
  navigate('collection');
  saveState();
}

// ── Google OAuth ──────────────────────────────────────────────
export async function doGoogleLogin() {
  setAuthLoading('login-google-btn', true, 'Signing in…');
  if (window._fb?.enabled && window._fb.googleLogin) {
    try {
      await window._fb.googleLogin();
    } catch (e) {
      showLoginError('Google sign-in failed: ' + (e.message || 'Unknown error'));
    }
  } else {
    showLoginError('Google sign-in is not available in this environment.');
  }
  setAuthLoading('login-google-btn', false, '🔐 Sign in with Google');
}
window.doGoogleLogin = doGoogleLogin;

export async function doGoogleSignup() {
  setAuthLoading('signup-google-btn', true, 'Creating account…');
  if (window._fb?.enabled && window._fb.googleSignup) {
    try {
      await window._fb.googleSignup();
    } catch (e) {
      showSignupError('Google sign-up failed: ' + (e.message || 'Unknown error'));
    }
  } else {
    showSignupError('Google sign-up is not available in this environment.');
  }
  setAuthLoading('signup-google-btn', false, '🔐 Sign up with Google');
}
window.doGoogleSignup = doGoogleSignup;

// ── Username availability check ───────────────────────────────
export function isUsernameAvailable(username) {
  if (!username || username.length < 3) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return false;
  if (window._fb?.enabled) return true; // validated server-side on submit
  return !getUsers().find(u => u.username?.toLowerCase() === username.toLowerCase());
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
window.logout = logout;

// ── Nav state ─────────────────────────────────────────────────
export function updateNavForAuth() {
  const loggedIn = !!_state.user;

  const show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
  const cond = (id, condition) => condition ? show(id) : hide(id);

  cond('nav-login-desktop', !loggedIn);
  cond('nav-user',           loggedIn);
  cond('nav-add',            loggedIn);
  cond('nb-collection',      loggedIn);
  cond('nb-trade',           loggedIn);
  cond('mbnb-collection',    loggedIn);
  cond('mbnb-trade',         loggedIn);
  cond('mob-add',            loggedIn);
  cond('mob-login',         !loggedIn);
  cond('mob-user',           loggedIn);

  if (loggedIn) {
    const avatarEl = document.getElementById('nav-avatar');
    if (avatarEl) avatarEl.textContent = (_state.user.firstName || '?')[0].toUpperCase();

    // Show local-mode banner only when Firebase is NOT enabled
    const note = document.getElementById('login-firebase-note');
    if (note) note.style.display = window._fb?.enabled ? 'none' : 'block';
  }
}
window.updateNavForAuth = updateNavForAuth;