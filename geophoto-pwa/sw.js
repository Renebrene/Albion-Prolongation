/**
 * sw.js — Service Worker GeoPhoto.
 *
 * Стратегия:
 *   - статика приложения: cache-first с обновлением в фоне (stale-while-revalidate);
 *   - запросы к API (/api/, /admin/) — только сеть, без кэша;
 *   - навигация: сеть, при недоступности — закэшированный index.html.
 */

const CACHE_NAME = 'geophoto-static-v25';

const STATIC_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './db.js',
    './exif.js',
    './compression.js',
    './logger.js',
    './pairing.js',
    './manifest.json',
    './lib/piexif.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME && key.startsWith('geophoto-'))
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // API и админ-панель всегда идут в сеть: данные должны быть актуальными.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;

    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() => caches.match('./index.html'))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request)
                .then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);

            return cached || network;
        })
    );
});
