/* Garde l'interface en cache pour qu'elle s'ouvre comme une appli.
 * Rien venant de GitHub (contenus, code d'accès) n'est jamais mis en cache ici. */
const CACHE = "ndb-pilotage-v13";
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

// notifications envoyées par GitHub chaque matin (et à l'activation, pour essai)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { corps: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.titre || "La nuit des Bleus", {
    body: d.corps || "", icon: "icones/icone-192.png", badge: "icones/icone-192.png",
    data: { url: d.url || "#/" }, tag: "nuit-des-bleus",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const cible = new URL(`./${e.notification.data?.url || "#/"}`, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((fenetres) => {
    const ouverte = fenetres.find((f) => f.url.startsWith(self.registration.scope));
    if (ouverte) { ouverte.navigate(cible); return ouverte.focus(); }
    return self.clients.openWindow(cible);
  }));
});
