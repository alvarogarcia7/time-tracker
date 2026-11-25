// Service worker of the time parser. scripts/build-site.mjs fills in the cache name (derived from the
// content of the build) and the list of files to keep, so each build with changed files has a new cache.
const CACHE = "__CACHE__";
const PRECACHE = __PRECACHE__;
const SCOPE = self.registration.scope;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((path) => new URL(path, SCOPE).href))),
  );
});

// The page asks a waiting worker to take over, once the user accepts the update prompt.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("time-parser-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;

  if (request.mode === "navigate") {
    // Pages are fetched first, so a new version is seen; offline, the app's start page is used.
    event.respondWith(networkFirst(request, new URL("index.html", SCOPE).href));
    return;
  }
  if (url.pathname.includes("/assets/")) {
    // The file names of the bundle contain a hash of their content, so a cached copy never goes stale.
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request, null));
});

async function networkFirst(request, fallback) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = (await cache.match(request, { ignoreSearch: true })) ?? (fallback ? await cache.match(fallback) : undefined);
    return cached ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
