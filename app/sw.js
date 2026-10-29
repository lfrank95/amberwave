// Service Worker: macht die App installierbar, lädt Oberflächen-Dateien schneller und lässt sie ohne Netz starten.
// Musik und API-Antworten werden NICHT zwischengespeichert – mit einer Ausnahme: was der Nutzer ausdrücklich „offline
// gespeichert“ hat (Cache „aw-offline-v1“, verwaltet von js/offline.js). Daraus kommen ohne Netz auch die Cover.
const CACHE = 'amberwave-oberflaeche-v1';
const HUELLE = 'amberwave-huelle-v1';
const OFFLINE = 'aw-offline-v1';
const BILDER = 'aw-bilder-v1';   // Cover, die schon einmal geladen wurden: kommen danach sofort von der Platte (die URLs ändern sich nie)
const BEHALTEN = [CACHE, HUELLE, OFFLINE, BILDER];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((namen) => Promise.all(namen.filter((n) => !BEHALTEN.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Die App schickt nach dem Start die Liste ihrer Dateien (Module, CSS, Worklets): einmal holen, damit sie ohne Netz startet
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.art !== 'vorladen' || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then(async (cache) => {
    // alte Fassungen derselben Dateien (anderer ?v=) raus, sonst wächst der Speicher mit jeder Version
    const neu = new Map(d.urls.map((u) => { const x = new URL(u, self.location.origin); return [x.pathname, x.search]; }));
    for (const r of await cache.keys()) {
      const x = new URL(r.url);
      if (neu.has(x.pathname) && neu.get(x.pathname) !== x.search) await cache.delete(r);
    }
    for (const u of d.urls) {
      try {
        if (await cache.match(u)) continue;
        const r = await fetch(u, { credentials: 'same-origin' });
        if (dateiOk(r)) await cache.put(u, r);
      } catch (x) { /* beim nächsten Start */ }
    }
  }));
});

/** Eine echte Datei (kein Umweg über die Anmeldeseite, kein HTML statt Skript) – nur so etwas kommt in den Dateicache */
function dateiOk(r) {
  return r.ok && !r.redirected && r.type === 'basic' && !(r.headers.get('Content-Type') || '').includes('text/html');
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Seitenaufruf der App: immer frisch vom Server; ohne Netz die zuletzt geladene Hülle (die App startet dann offline)
  if (e.request.mode === 'navigate') {
    if (/^\/(api\/|login\.php|logout\.php|register\.php|passwort)/.test(url.pathname)) return;
    // als Hülle nur App-Routen merken – keine einzelnen Seiten wie den Cast-Empfänger (/cast/empfaenger.html) oder PHP-Seiten
    const appRoute = !/\.(html?|php)$/i.test(url.pathname) && !url.pathname.startsWith('/cast/');
    e.respondWith(fetch(e.request).then((antwort) => {
      const html = (antwort.headers.get('Content-Type') || '').includes('text/html');
      if (appRoute && antwort.ok && !antwort.redirected && antwort.type === 'basic' && html) {
        const kopie = antwort.clone();
        caches.open(HUELLE).then((c) => c.put('/__huelle', kopie)).catch(() => {});
      }
      return antwort;
    }).catch(async () => {
      // ohne Netz: die gemerkte Hülle, markiert – die App nimmt dann nicht die darin eingebetteten (alten) Nutzerdaten, sondern startet offline
      const r = await caches.match('/__huelle', { cacheName: HUELLE });
      if (!r) return Response.error();
      try {
        const text = await r.text();
        return new Response(text.replace('<html', '<html data-aw-huelle="1"'), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      } catch (x) { return r; }
    }));
    return;
  }

  // Statische Dateien (mit Versionsparameter) und Schriften (Fassung im Dateinamen) aus dem Zwischenspeicher
  const statisch = (/^\/(css|js|img)\//.test(url.pathname) && url.searchParams.has('v')) || /^\/fonts\/[^/]+\.woff2$/.test(url.pathname);
  if (statisch) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const treffer = await cache.match(e.request);
        if (treffer) return treffer;
        const antwort = await fetch(e.request);
        if (dateiOk(antwort)) cache.put(e.request, antwort.clone());
        return antwort;
      })
    );
    return;
  }

  // Bilder (Cover) und Logo: vom Server; ohne Netz aus dem Offline-Speicher
  if (url.pathname.startsWith('/api/v1/bild') || url.pathname.startsWith('/img/')) {
    if (url.pathname.startsWith('/api/v1/bild/cover/') && e.request.method === 'GET') {
      e.respondWith((async () => {
        const treffer = await caches.match(e.request);
        if (treffer) return treffer;
        const r = await fetch(e.request);
        if (r.ok && r.status === 200) {
          const kopie = r.clone();
          e.waitUntil(caches.open(BILDER).then(async (c) => {
            await c.put(e.request, kopie);
            const ks = await c.keys();
            if (ks.length > 1500) for (const k of ks.slice(0, ks.length - 1200)) await c.delete(k);   // älteste zuerst
          }).catch(() => {}));
        }
        return r;
      })().catch(() => Response.error()));
      return;
    }
    e.respondWith(fetch(e.request).catch(async () => (await caches.match(e.request)) || Response.error()));
  }
});
