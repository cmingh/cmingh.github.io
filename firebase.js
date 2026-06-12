// js/firebase.js  (v2 — adds queryUserByIdentifier for username/phone login)
// ─────────────────────────────────────────────────────────────
// Firebase initialisation. Loaded as a <script type="module">
// BEFORE main.js so that window._fb and window._fbReady are set
// before the app boots.
//
// NEW: window._fb.queryUserByIdentifier(identifier)
//   Looks up a user document by 'username' or 'phone' field and
//   returns their email — used by auth.js so users can sign in
//   with a username or phone number instead of their email.
//
// FIX (from v1): getAllUsers() correctly queries each user's
// 'collection' *subcollection* with a count query instead of
// trying to read a 'collection' field off the user document.
// ─────────────────────────────────────────────────────────────

import './state.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

const FIREBASE_ENABLED =
  !!FIREBASE_CONFIG.apiKey &&
  !FIREBASE_CONFIG.apiKey.startsWith('YOUR_') &&
  FIREBASE_CONFIG.apiKey.length > 10 &&
  !!FIREBASE_CONFIG.projectId &&
  !FIREBASE_CONFIG.projectId.startsWith('YOUR_');

function signalReady() {
  window._fbReady = true;
  if (typeof window._fbReadyCb === 'function') window._fbReadyCb();
}

if (!FIREBASE_ENABLED) {
  console.log('[firebase] No valid config — running in local mode');
  signalReady();
} else {
  console.log('[firebase] Real config detected — initialising Firebase…');
  (async () => {
    try {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const {
        getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
        signOut, onAuthStateChanged, updateProfile,
      } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      const {
        getFirestore, doc, setDoc, getDoc, collection, collectionGroup,
        addDoc, deleteDoc, getDocs, onSnapshot, serverTimestamp, orderBy,
        query, where, limit, getCountFromServer,
      } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

      const app  = initializeApp(FIREBASE_CONFIG);
      const auth = getAuth(app);
      const db   = getFirestore(app);

      let unsubscribeCollection = null;

      onAuthStateChanged(auth, async (firebaseUser) => {
        if (firebaseUser) {
          try {
            const profSnap = await getDoc(doc(db, 'users', firebaseUser.uid));
            const prof = profSnap.exists() ? profSnap.data() : {};
            window._state.user = {
              id:        firebaseUser.uid,
              email:     firebaseUser.email,
              username:  prof.username  || firebaseUser.email.split('@')[0],
              firstName: prof.firstName || firebaseUser.displayName?.split(' ')[0] || 'User',
              lastName:  prof.lastName  || firebaseUser.displayName?.split(' ').slice(1).join(' ') || '',
              phone:     prof.phone     || null,
              joined:    prof.joined    || new Date().toISOString().split('T')[0],
            };
          } catch (profileErr) {
            console.warn('[firebase] Could not load profile:', profileErr);
            window._state.user = {
              id:        firebaseUser.uid,
              email:     firebaseUser.email,
              username:  firebaseUser.email.split('@')[0],
              firstName: 'User',
              lastName:  '',
              phone:     null,
              joined:    new Date().toISOString().split('T')[0],
            };
          }

          if (unsubscribeCollection) unsubscribeCollection();
          const colRef = collection(db, 'users', firebaseUser.uid, 'collection');
          unsubscribeCollection = onSnapshot(
            query(colRef, orderBy('dateAdded', 'desc')),
            (snap) => {
              window._state.collection = snap.docs.map(d => ({ id: d.id, ...d.data() }));
              if (window._currentPage === 'collection') window.renderCollection?.();
              if (window._currentPage === 'profile')    window.renderProfile?.();
            }
          );

          window.updateNavForAuth?.();
          window.navigate?.('collection');
        } else {
          window._state.user = null;
          if (unsubscribeCollection) { unsubscribeCollection(); unsubscribeCollection = null; }
          window._state.collection = [];
          window.updateNavForAuth?.();
          window.navigate?.('home');
        }
      });

      window._fb = {
        enabled: true,

        login:  (email, pw) => signInWithEmailAndPassword(auth, email, pw),

        signup: async (email, pw, firstName, lastName, username, phone) => {
          const cred = await createUserWithEmailAndPassword(auth, email, pw);
          await updateProfile(cred.user, { displayName: firstName + ' ' + lastName });
          // Normalise phone to digits-only for consistent lookups
          const normPhone = phone ? phone.replace(/[\s\-().+]/g, '') : null;
          await setDoc(doc(db, 'users', cred.user.uid), {
            firstName, lastName, username, email,
            phone: normPhone,
            joined: new Date().toISOString().split('T')[0],
          });
          return cred;
        },

        logout: () => signOut(auth),

        // ── queryUserByIdentifier ─────────────────────────────
        // Used by auth.js to resolve a username or phone number
        // to an email address so we can call signInWithEmailAndPassword.
        //
        // Runs two parallel Firestore queries (username and phone)
        // and returns whichever resolves first with a match.
        // Returns null (not throws) when the user simply doesn't exist.
        queryUserByIdentifier: async (identifier) => {
          const trimmed = identifier.trim();
          // Normalise phone (digits only) for comparison
          const normPhone = trimmed.replace(/[\s\-().+]/g, '');
          const usersRef  = collection(db, 'users');

          // Run both queries in parallel for speed
          const [byUsername, byPhone] = await Promise.allSettled([
            getDocs(query(usersRef, where('username', '==', trimmed),      limit(1))),
            getDocs(query(usersRef, where('phone',    '==', normPhone),     limit(1))),
          ]);

          // Check username result
          if (byUsername.status === 'fulfilled' && !byUsername.value.empty) {
            const data = byUsername.value.docs[0].data();
            if (data.email) return data.email;
          }

          // Check phone result
          if (byPhone.status === 'fulfilled' && !byPhone.value.empty) {
            const data = byPhone.value.docs[0].data();
            if (data.email) return data.email;
          }

          // Also try case-insensitive username by fetching a broader set
          // (Firestore doesn't support ILIKE, but usernames should be unique
          // so an exact lowercase match is good enough for most cases).
          const lowerTrimmed = trimmed.toLowerCase();
          if (lowerTrimmed !== trimmed) {
            try {
              const snap = await getDocs(
                query(usersRef, where('username', '==', lowerTrimmed), limit(1))
              );
              if (!snap.empty) {
                const data = snap.docs[0].data();
                if (data.email) return data.email;
              }
            } catch (_) {}
          }

          return null; // not found — not an error
        },

        saveItem: async (item) => {
          if (!window._state.user) return null;
          const uid      = window._state.user.id;
          const username = window._state.user.username || window._state.user.email || 'anonymous';
          const { id, ...data } = item;
          const payload  = { ...data, username, ownerId: uid };
          if (id && !id.startsWith('i')) {
            await setDoc(doc(db, 'users', uid, 'collection', id), payload, { merge: true });
            return id;
          }
          const ref = await addDoc(collection(db, 'users', uid, 'collection'), {
            ...payload,
            dateAdded: serverTimestamp(),
          });
          return ref.id;
        },

        deleteItem: async (itemId) => {
          if (!window._state.user) return;
          await deleteDoc(doc(db, 'users', window._state.user.id, 'collection', itemId));
        },

        updateProfile: async (uid, data) =>
          setDoc(doc(db, 'users', uid), data, { merge: true }),

        saveWishlist: async (list) => {
          if (!window._state.user) return;
          await setDoc(doc(db, 'users', window._state.user.id), { wishlist: list }, { merge: true });
        },

        saveMessages: async (msgs) => {
          if (!window._state.user) return;
          await setDoc(doc(db, 'users', window._state.user.id), { messages: msgs }, { merge: true });
        },

        loadUserExtra: async () => {
          if (!window._state.user) return;
          const snap = await getDoc(doc(db, 'users', window._state.user.id));
          if (snap.exists()) {
            const d = snap.data();
            if (d.wishlist) window._state.wishlist = d.wishlist;
            if (d.messages) window._state.messages = d.messages;
            if (d.trades)   window._state.trades   = d.trades;
          }
        },

        getCommunityItems: async () => {
          const q = query(
            collectionGroup(db, 'collection'),
            orderBy('dateAdded', 'desc'),
            limit(24)
          );
          const snap = await getDocs(q);
          return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        },

        sendMessage: async (to, text) => {
          if (!window._state.user) return null;
          const from = window._state.user.username || window._state.user.email || 'unknown';
          return addDoc(collection(db, 'messages'), {
            from, to, text,
            participants: [from, to],
            createdAt: serverTimestamp(),
          });
        },

        subscribeToMessages: (username, cb) => {
          const q = query(
            collection(db, 'messages'),
            where('participants', 'array-contains', username),
            orderBy('createdAt', 'asc')
          );
          return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
        },

        // Google OAuth stubs — require GoogleAuthProvider setup in Firebase Console
        googleLogin:  async () => { throw new Error('Google Sign-In requires additional Firebase configuration'); },
        googleSignup: async () => { throw new Error('Google Sign-Up requires additional Firebase configuration'); },

        // ── getAllUsers — FIXED ────────────────────────────────
        // Enumerates users/{uid} documents, then for each user runs a
        // count query against their collection subcollection.
        getAllUsers: async () => {
          try {
            const usersSnap = await getDocs(collection(db, 'users'));
            const results = await Promise.allSettled(
              usersSnap.docs.map(async (userDoc) => {
                const data = userDoc.data();
                let itemCount = 0;
                try {
                  const countSnap = await getCountFromServer(
                    collection(db, 'users', userDoc.id, 'collection')
                  );
                  itemCount = countSnap.data().count;
                } catch (_countErr) {
                  try {
                    const itemsSnap = await getDocs(
                      query(collection(db, 'users', userDoc.id, 'collection'), limit(1))
                    );
                    itemCount = itemsSnap.size;
                  } catch (_) {}
                }

                let icon = '📦';
                try {
                  const firstSnap = await getDocs(
                    query(collection(db, 'users', userDoc.id, 'collection'), limit(1))
                  );
                  if (!firstSnap.empty) icon = firstSnap.docs[0].data().icon || '📦';
                } catch (_) {}

                return {
                  id:        userDoc.id,
                  firstName: data.firstName || '',
                  lastName:  data.lastName  || '',
                  username:  data.username  || '',
                  itemCount,
                  icon,
                };
              })
            );

            return results
              .filter(r => r.status === 'fulfilled')
              .map(r => r.value);
          } catch (e) {
            console.warn('[firebase] getAllUsers failed:', e);
            return [];
          }
        },
      };

    } catch (err) {
      console.error('[firebase] Failed to initialise:', err);
    }

    signalReady();
  })();
}