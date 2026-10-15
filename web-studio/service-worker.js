// Retire the previous PWA shell without touching projects or local storage.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith('opusloops-pwa-')||key.startsWith('opusloops-mobile-'))await caches.delete(key);
 await self.registration.unregister();
 await self.clients.claim();
})()));
