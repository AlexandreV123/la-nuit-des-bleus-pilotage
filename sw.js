/* Garde l'interface en cache pour qu'elle s'ouvre comme une appli.
 * Rien venant de GitHub (contenus, code d'accès) n'est jamais mis en cache ici. */
const CACHE = "ndb-pilotage-v3";
const COQUILLE = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest",
  "icones/icone-192.png", "icones/icone-512.png",
  "polices/Archivo-800.woff2", "polices/Archivo-900.woff2",
  "polices/Inter-400.woff2", "polices/Inter-600.woff2", "polices/Inter-700.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// réseau d'abord, pour recevoir les mises à jour ; le cache ne sert que hors connexion
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request)
    .then((r) => { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copie)); return r; })
    .catch(() => caches.match(e.request)));
});
