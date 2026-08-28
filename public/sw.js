// ============================================================
// Jomish Business Suite — Service Worker v3
// Handles: Offline caching + Push Notifications
// ============================================================

const CACHE_NAME = 'jomish-v3';
const STATIC_ASSETS = [
    '/login.html',
    '/index.html',
    '/style.css',
    '/app.js',
    '/offline-db.js',
    '/manifest.json',
    '/favicon.png',
    '/lib/bcryptjs.min.js'
];

// ─── INSTALL: Pre-cache core assets ──────────────────────────
self.addEventListener('install', (event) => {
    console.log('[SW] Installing and pre-caching assets...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch((err) => {
                console.warn('[SW] Pre-cache partial failure (ok):', err.message);
            });
        })
    );
    self.skipWaiting();
});

// ─── ACTIVATE: Clean up old caches ───────────────────────────
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        })
    );
    self.clients.claim();
});

// ─── FETCH: Network-first with cache fallback ─────────────────
self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;
    // Skip API calls and external URLs
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Cache successful responses for static assets
                if (response && response.status === 200) {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
                }
                return response;
            })
            .catch(() => {
                // Offline fallback: serve from cache
                return caches.match(event.request).then((cached) => {
                    if (cached) return cached;
                    // If not cached, return offline page for navigation
                    if (event.request.mode === 'navigate') {
                        return caches.match('/login.html');
                    }
                });
            })
    );
});

// ─── PUSH: Receive push notifications from server ─────────────
self.addEventListener('push', (event) => {
    let data = { title: 'Jomish Business Suite', body: 'You have a new notification.', icon: '/favicon.png', badge: '/favicon.png' };
    try {
        if (event.data) data = { ...data, ...event.data.json() };
    } catch (e) {}

    console.log('[SW] Push received:', data);

    const options = {
        body:              data.body,
        icon:              data.icon || '/favicon.png',
        badge:             data.badge || '/favicon.png',
        tag:               data.tag || 'jomish-notification',
        requireInteraction: data.requireInteraction || false,
        data:              { url: data.url || '/' },
        vibrate:           [200, 100, 200]
    };

    event.waitUntil(self.registration.showNotification(data.title, options));
});

// ─── NOTIFICATION CLICK: Open or focus the app ───────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});
