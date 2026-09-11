// Minimal service worker: only exists so we can show/update a persistent exam-timer notification.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
