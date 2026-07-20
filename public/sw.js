// Minimal service worker: lets the app show notifications on platforms that
// require one (e.g. Android). Does not intercept any requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
