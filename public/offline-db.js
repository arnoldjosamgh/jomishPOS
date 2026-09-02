// ============================================================
// Jomish Business Suite — Offline Database Wrapper (IndexedDB)
// v2 — adds auth_cache store for offline login support
// ============================================================

const DB_NAME = 'JomishOfflineDB';
const DB_VERSION = 3;          // bumped to add salesQueue
const STORE_CACHE = 'api_cache';
const STORE_QUEUE = 'sync_queue';
const STORE_AUTH  = 'auth_cache';
const STORE_SALES = 'salesQueue';

let _dbPromise = null;

function getDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains(STORE_CACHE)) {
                // Store cached API responses. URL is the key.
                db.createObjectStore(STORE_CACHE, { keyPath: 'url' });
            }
            if (!db.objectStoreNames.contains(STORE_QUEUE)) {
                // Store pending mutations. Auto-increment ID.
                db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains(STORE_AUTH)) {
                // Store offline login credentials. Username is the key.
                db.createObjectStore(STORE_AUTH, { keyPath: 'username' });
            }
            if (!db.objectStoreNames.contains(STORE_SALES)) {
                // Offline sales queue
                const store = db.createObjectStore(STORE_SALES, { keyPath: 'client_uuid' });
                store.createIndex('queued_at', 'queued_at', { unique: false });
            }
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror  = (event) => reject(event.target.error);
    });
    return _dbPromise;
}

// ─── API CACHE METHODS ──────────────────────────────────────────

async function cacheApiResponse(url, data) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_CACHE, 'readwrite');
            const store = tx.objectStore(STORE_CACHE);
            store.put({ url, data, timestamp: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to cache API response:', e);
    }
}

async function getCachedApiResponse(url) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx      = db.transaction(STORE_CACHE, 'readonly');
            const store   = tx.objectStore(STORE_CACHE);
            const request = store.get(url);
            request.onsuccess = () => resolve(request.result ? request.result.data : null);
            request.onerror   = () => reject(request.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to get cached API response:', e);
        return null;
    }
}

// ─── SYNC QUEUE METHODS (MUTATIONS) ─────────────────────────────

async function queueMutation(url, method, options = {}) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            // Save headers and body, ignore non-serializable properties
            const mutation = {
                url,
                method,
                headers:   options.headers ? JSON.parse(JSON.stringify(options.headers)) : {},
                body:      options.body || null,
                timestamp: Date.now()
            };
            store.add(mutation);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to queue mutation:', e);
    }
}

async function getQueuedMutations() {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx      = db.transaction(STORE_QUEUE, 'readonly');
            const store   = tx.objectStore(STORE_QUEUE);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror   = () => reject(request.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to get queued mutations:', e);
        return [];
    }
}

async function removeQueuedMutation(id) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to remove queued mutation:', e);
    }
}

async function getPendingSyncCount() {
    try {
        const mutations = await getQueuedMutations();
        return mutations.length;
    } catch (e) {
        return 0;
    }
}

// ─── OFFLINE SALES QUEUE METHODS ────────────────────────────────

async function queueOfflineSale(client_uuid, payload) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_SALES, 'readwrite');
            const store = tx.objectStore(STORE_SALES);
            store.put({ client_uuid, payload, queued_at: Date.now() });
            tx.oncomplete = () => {
                console.log('[OfflineDB] Sale queued:', client_uuid);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('[OfflineDB] Failed to queue sale:', e);
    }
}

async function getPendingOfflineSales() {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_SALES, 'readonly');
            const store = tx.objectStore(STORE_SALES);
            const req   = store.index('queued_at').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror   = () => reject(req.error);
        });
    } catch (e) {
        console.error('[OfflineDB] Failed to get pending sales:', e);
        return [];
    }
}

async function removeSyncedSales(uuids = []) {
    if (!uuids.length) return;
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_SALES, 'readwrite');
            const store = tx.objectStore(STORE_SALES);
            uuids.forEach(uuid => store.delete(uuid));
            tx.oncomplete = () => {
                console.log('[OfflineDB] Evicted confirmed sales:', uuids);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('[OfflineDB] Failed to evict sales:', e);
    }
}

async function getPendingCount() {
    try {
        const db = await getDB();
        return new Promise((resolve) => {
            const tx    = db.transaction(STORE_SALES, 'readonly');
            const store = tx.objectStore(STORE_SALES);
            const req   = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => resolve(0);
        });
    } catch { return 0; }
}

// ─── OFFLINE AUTH CACHE METHODS ──────────────────────────────────
// Stores a bcrypt hash of the user's password + their session data
// so they can log in when the server is unreachable.

/**
 * Save credentials after a successful online login.
 * @param {string} username   — the raw username typed by the user
 * @param {string} passwordHash — bcrypt hash of their password (from server response or local hash)
 * @param {object} userData   — { token, role, name, permissions, user_id, prefix }
 */
async function saveOfflineCredentials(username, passwordHash, userData) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_AUTH, 'readwrite');
            const store = tx.objectStore(STORE_AUTH);
            store.put({
                username:     username.toLowerCase().trim(),
                passwordHash,
                userData,
                cachedAt: Date.now()
            });
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to save offline credentials:', e);
    }
}

/**
 * Retrieve cached credentials for a given username.
 * @param {string} username
 * @returns {{ username, passwordHash, userData, cachedAt } | null}
 */
async function getOfflineCredentials(username) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx      = db.transaction(STORE_AUTH, 'readonly');
            const store   = tx.objectStore(STORE_AUTH);
            const request = store.get(username.toLowerCase().trim());
            request.onsuccess = () => resolve(request.result || null);
            request.onerror   = () => reject(request.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to get offline credentials:', e);
        return null;
    }
}

/**
 * Remove cached credentials for a user (call on explicit logout).
 * @param {string} username
 */
async function clearOfflineCredentials(username) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_AUTH, 'readwrite');
            const store = tx.objectStore(STORE_AUTH);
            store.delete(username.toLowerCase().trim());
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to clear offline credentials:', e);
    }
}

// Expose globally for app.js and login.html
window.OfflineDB = {
    cacheApiResponse,
    getCachedApiResponse,
    queueMutation,
    getQueuedMutations,
    removeQueuedMutation,
    getPendingSyncCount,
    saveOfflineCredentials,
    getOfflineCredentials,
    clearOfflineCredentials,
    queueOfflineSale,
    getPendingOfflineSales,
    removeSyncedSales,
    getPendingCount
};
