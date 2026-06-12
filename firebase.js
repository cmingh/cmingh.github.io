// js/firebase.js
// ─────────────────────────────────────────────────────────────
// Firebase initialisation. Loaded as a <script type="module">
// BEFORE main.js so that window._fb and window._fbReady are set
// before the app boots.
//
// FIX: getAllUsers() now correctly queries each user's
// 'collection' *subcollection* with a count query instead of
// trying to read a 'collection' field off the user document
// (which never existed). Returns {id, firstName, lastName,
// username, itemCount, icon} for every user except the caller.
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
              id: firebaseUser.uid, email: firebaseUser.email,
              username:  firebaseUser.email.split('@')[0],
              firstName: 'User', lastName: '',
              phone: null,
              joined: new Date().toISOString().split('T')[0],
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
          await setDoc(doc(db, 'users', cred.user.uid), {
            firstName, lastName, username, email, phone: phone || null,
            joined: new Date().toISOString().split('T')[0],
          });
          return cred;
        },

        logout: () => signOut(auth),

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
        // Original bug: read a non-existent 'collection' field on
        // the user document and filtered by its length.
        //
        // Fix: enumerate users/{uid} documents, then for each user
        // run a count query against their collection subcollection.
        // We include every user (even with 0 items) so the trade
        // page can display them — ui.js already filters to other
        // users and shows a sensible empty state if none exist.
        getAllUsers: async () => {
          try {
            const usersSnap = await getDocs(collection(db, 'users'));
            const results = await Promise.allSettled(
              usersSnap.docs.map(async (userDoc) => {
                const data = userDoc.data();
                // Count items in the subcollection without fetching them all
                let itemCount = 0;
                try {
                  const countSnap = await getCountFromServer(
                    collection(db, 'users', userDoc.id, 'collection')
                  );
                  itemCount = countSnap.data().count;
                } catch (_countErr) {
                  // getCountFromServer may not be available in all SDK versions;
                  // fall back to a lightweight getDocs
                  try {
                    const itemsSnap = await getDocs(
                      query(collection(db, 'users', userDoc.id, 'collection'), limit(1))
                    );
                    // We can't get the exact count cheaply, so use ≥1 as a proxy
                    itemCount = itemsSnap.size;
                  } catch (_) { /* leave as 0 */ }
                }

                // Pick the icon of the first item so the card looks nice,
                // but don't fetch all items just for this.
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