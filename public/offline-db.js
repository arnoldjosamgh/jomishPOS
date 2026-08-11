// ============================================================
// Jomish Business Suite — Offline Database Wrapper (IndexedDB)
// ============================================================

const DB_NAME = 'JomishOfflineDB';
const DB_VERSION = 1;
const STORE_CACHE = 'api_cache';
const STORE_QUEUE = 'sync_queue';

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
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
    return _dbPromise;
}

// ─── API CACHE METHODS ──────────────────────────────────────────

async function cacheApiResponse(url, data) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_CACHE, 'readwrite');
            const store = tx.objectStore(STORE_CACHE);
            store.put({ url, data, timestamp: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to cache API response:', e);
    }
}

async function getCachedApiResponse(url) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_CACHE, 'readonly');
            const store = tx.objectStore(STORE_CACHE);
            const request = store.get(url);
            request.onsuccess = () => resolve(request.result ? request.result.data : null);
            request.onerror = () => reject(request.error);
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
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            // Save headers and body, ignore non-serializable properties
            const mutation = {
                url,
                method,
                headers: options.headers ? JSON.parse(JSON.stringify(options.headers)) : {},
                body: options.body || null,
                timestamp: Date.now()
            };
            store.add(mutation);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to queue mutation:', e);
    }
}

async function getQueuedMutations() {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readonly');
            const store = tx.objectStore(STORE_QUEUE);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
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
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[OfflineDB] Failed to remove queued mutation:', e);
    }
}

// Expose globally for app.js
window.OfflineDB = {
    cacheApiResponse,
    getCachedApiResponse,
    queueMutation,
    getQueuedMutations,
    removeQueuedMutation
};
