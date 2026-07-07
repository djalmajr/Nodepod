/**
 * Nodepod Service Worker - proxies requests to virtual servers.
 * Version: 8 (multi-tab)
 *
 * Intercepts:
 *   /__virtual__/{instanceId}/{port}/{path}  virtual server API (new)
 *   /__preview__/{instanceId}/{port}/{path}  preview iframe navigation (new)
 *   /__virtual__/{port}/{path}               legacy, routes to DEFAULT_INSTANCE
 *   /__preview__/{port}/{path}               legacy, routes to DEFAULT_INSTANCE
 *   Any request from a client loaded via /__preview__/ (module imports etc)
 *
 * When an iframe navigates to /__preview__/{instanceId}/{port}/, the SW records
 * the resulting clientId with its (instanceId, port). All subsequent requests
 * from that client (including ES module imports like /@react-refresh) are
 * intercepted and routed through the right instance's virtual server.
 *
 * Multi-tab: one SW serves every tab at this scope, but each tab has its own
 * RequestProxy and its own MessageChannel. we hold a map of MessagePorts
 * (one per tab) and route each fetch to whichever port claimed the fetch's
 * instanceId. without this a second tab's init would overwrite the first
 * tab's port and you'd get "No server on {instanceId}/{port}" 503s.
 */

const SW_VERSION = 8;
const DEFAULT_INSTANCE = "default";

let nextId = 1;
// id -> { resolve, reject, port }
const pending = new Map();

// one entry per connected tab. MessagePort -> { token, instances: Set<string> }
const ports = new Map();

// routing table for fetches. instanceId -> MessagePort
const instancePorts = new Map();

// clientId -> { instanceId, serverPort } for preview iframes
const previewClients = new Map();

// The browser terminates idle service workers and this in-memory map dies
// with them, which strands already-open preview iframes (their relative
// fetches stop routing to the pod). Entries are mirrored into the Cache API
// so a freshly restarted worker can lazily restore them on first miss.
const SW_STATE_CACHE = "nodepod-sw-state-v1";
const PREVIEW_CLIENT_KEY_PREFIX = "https://nodepod.sw/preview-client/";

// clientIds already checked against the persisted state with no hit, so
// ordinary page clients only pay the cache lookup once.
const restoreMisses = new Set();

function persistPreviewClient(clientId, pod) {
  if (!clientId) return;
  caches
    .open(SW_STATE_CACHE)
    .then((cache) =>
      cache.put(
        new Request(PREVIEW_CLIENT_KEY_PREFIX + encodeURIComponent(clientId)),
        new Response(JSON.stringify(pod)),
      ),
    )
    .catch(() => {});
}

function forgetPreviewClient(clientId) {
  if (!clientId) return;
  caches
    .open(SW_STATE_CACHE)
    .then((cache) =>
      cache.delete(new Request(PREVIEW_CLIENT_KEY_PREFIX + encodeURIComponent(clientId))),
    )
    .catch(() => {});
}

async function restorePreviewClient(clientId) {
  try {
    const cache = await caches.open(SW_STATE_CACHE);
    const stored = await cache.match(
      new Request(PREVIEW_CLIENT_KEY_PREFIX + encodeURIComponent(clientId)),
    );
    if (!stored) return null;
    const pod = await stored.json();
    if (pod && pod.instanceId && typeof pod.serverPort === "number") {
      previewClients.set(clientId, pod);
      return pod;
    }
  } catch {
    // fall through to null
  }
  return null;
}

function trackPreviewClient(clientId, pod) {
  previewClients.set(clientId, pod);
  restoreMisses.delete(clientId);
  persistPreviewClient(clientId, pod);
}

// stripped path -> pod. iframes claim their path so a reload that lands on
// the stripped url (no prefix, new clientId) can still be routed. bounded.
const pathToPodMap = new Map();
const PATH_MAP_MAX = 512;

// per-instance script injected into preview iframe HTML
const previewScripts = new Map();

// global watermark toggle, last writer across tabs wins
let watermarkEnabled = true;

// per-instance ws bridge tokens
const wsTokens = new Map();

// any token from any currently connected tab is accepted. used for control
// messages that aren't tied to a specific instance (set-watermark etc)
function isValidToken(t) {
  if (!t) return false;
  for (const info of ports.values()) {
    if (info.token === t) return true;
  }
  return false;
}

// for per-instance messages the token must match the tab that claimed the
// instance. if no one claimed it yet any valid token passes
function isValidTokenForInstance(token, instanceId) {
  const mp = instancePorts.get(instanceId);
  if (mp) {
    const info = ports.get(mp);
    return info ? info.token === token : false;
  }
  return isValidToken(token);
}

// exact match first, then fall back to whoever owns DEFAULT_INSTANCE (legacy
// single-tenant callers), then any connected port
function getPortForInstance(instanceId) {
  const mp = instancePorts.get(instanceId);
  if (mp) return mp;
  const def = instancePorts.get(DEFAULT_INSTANCE);
  if (def) return def;
  if (ports.size > 0) return ports.keys().next().value;
  return null;
}

function claimInstance(mp, instanceId) {
  if (!mp || !ports.has(mp)) return;
  instancePorts.set(instanceId, mp);
  ports.get(mp).instances.add(instanceId);
}

// Sweep the persisted preview-client mirror for a released instance. The
// in-memory maps below are wiped whenever the browser recycles an idle worker,
// but the Cache API copy survives — so a reopened project would otherwise
// inherit the stale dead-pod route from the cache alone. Enumerate by
// instanceId (the key is the clientId, the instanceId lives in the value) so
// the sweep works even with an empty in-memory map. Fire-and-forget.
function forgetPersistedInstanceRoutes(instanceId) {
  caches
    .open(SW_STATE_CACHE)
    .then(async (cache) => {
      const keys = await cache.keys();
      for (const req of keys) {
        if (!req.url.startsWith(PREVIEW_CLIENT_KEY_PREFIX)) continue;
        const stored = await cache.match(req);
        if (!stored) continue;
        const pod = await stored.json().catch(() => null);
        if (pod && pod.instanceId === instanceId) await cache.delete(req);
      }
    })
    .catch(() => {});
}

// Drop every routing reference to an instance that is being released: the
// preview-client map (in-memory + persisted cache) and the path-claim map.
// releaseInstance/cleanupPort already forget instancePorts/scripts/tokens but
// left these dangling, so a torn-down pod's routes survived teardown. On
// project reopen a boot-time fetch could then route at the dead instance and
// wedge the preview (surfaced as "exited 137"). Clearing them here — instead of
// lazily on the next fetch miss — keeps the persisted state from accumulating
// stale dead-pod routes across sessions.
function forgetInstanceRoutes(instanceId) {
  for (const [clientId, pod] of previewClients) {
    if (pod && pod.instanceId === instanceId) previewClients.delete(clientId);
  }
  for (const [path, pod] of pathToPodMap) {
    if (pod && pod.instanceId === instanceId) pathToPodMap.delete(path);
  }
  forgetPersistedInstanceRoutes(instanceId);
}

// only release the in-memory port claim if this port still owns it (a newer tab
// may have reclaimed it). instanceIds are unique per pod boot, so an explicit
// release means this id is gone for good — forget its routes unconditionally,
// even when a recycled worker no longer has it in instancePorts (the ownership
// check would skip the whole cleanup otherwise and strand the persisted route).
function releaseInstance(mp, instanceId) {
  if (instancePorts.get(instanceId) === mp) {
    instancePorts.delete(instanceId);
    previewScripts.delete(instanceId);
    wsTokens.delete(instanceId);
  }
  forgetInstanceRoutes(instanceId);
  const info = ports.get(mp);
  if (info) info.instances.delete(instanceId);
}

// drop every reference to a port so stale entries don't route fetches nowhere
function cleanupPort(mp) {
  const info = ports.get(mp);
  if (info) {
    for (const id of info.instances) {
      if (instancePorts.get(id) === mp) {
        instancePorts.delete(id);
        previewScripts.delete(id);
        wsTokens.delete(id);
        forgetInstanceRoutes(id);
      }
    }
  }
  ports.delete(mp);
}

// Extract (instanceId, port, restPath) from a /__virtual__/... or /__preview__/... pathname.
// Returns null if no match. Handles both the new 3-segment form and the legacy
// 2-segment form (falls back to DEFAULT_INSTANCE).
function matchPreviewOrVirtualPath(pathname, kind /* "virtual" | "preview" */) {
  const prefix = kind === "virtual" ? "__virtual__" : "__preview__";
  // New: /__{kind}__/{instanceId}/{port}[/rest]
  // Require non-digit in first segment so we don't swallow legacy ports.
  const newRe = new RegExp(
    "^\\/" + prefix + "\\/([A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*)\\/(\\d+)(\\/.*)?$"
  );
  const m1 = pathname.match(newRe);
  if (m1) {
    return {
      instanceId: m1[1],
      port: parseInt(m1[2], 10),
      rest: m1[3] || "/",
    };
  }
  // Legacy: /__{kind}__/{port}[/rest]
  const oldRe = new RegExp("^\\/" + prefix + "\\/(\\d+)(\\/.*)?$");
  const m2 = pathname.match(oldRe);
  if (m2) {
    return {
      instanceId: DEFAULT_INSTANCE,
      port: parseInt(m2[1], 10),
      rest: m2[2] || "/",
    };
  }
  return null;
}

// Strip the /__{kind}__/{instanceId}/{port} or /__{kind}__/{port} prefix from
// a pathname when a client was loaded via a preview URL and the browser
// resolved a relative URL against it. Returns the unprefixed path or the
// original if no prefix was found.
function stripPreviewPrefix(pathname) {
  const m = pathname.match(
    /^\/__(?:preview|virtual)__\/(?:[A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*\/\d+|\d+)(\/.*)?$/
  );
  if (m) {
    let stripped = m[1] || "/";
    if (stripped[0] !== "/") stripped = "/" + stripped;
    return stripped;
  }
  return pathname;
}

// Standard MIME types by file extension — used as a safety net when
// the virtual server returns text/html (SPA fallback) or omits Content-Type
// for paths that are clearly not HTML.
const MIME_TYPES = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".ts": "application/javascript",
  ".tsx": "application/javascript",
  ".jsx": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".md": "text/markdown",
};

/**
 * Infer correct MIME type for a response based on the request path.
 * When a server's SPA fallback serves index.html (text/html) for paths that
 * are clearly not HTML (e.g. .js, .css, .json files), the Content-Type is
 * wrong. This corrects it based purely on the file extension in the URL.
 */
function inferMimeType(path, responseHeaders) {
  const ct =
    responseHeaders["content-type"] || responseHeaders["Content-Type"] || "";

  // If the server already set a non-HTML Content-Type, trust it
  if (ct && !ct.includes("text/html")) {
    return null; // no override needed
  }

  // Strip query string and hash for extension detection
  const cleanPath = path.split("?")[0].split("#")[0];
  const lastDot = cleanPath.lastIndexOf(".");
  const ext = lastDot >= 0 ? cleanPath.slice(lastDot).toLowerCase() : "";

  // Only override if the path has a known non-HTML extension
  if (ext && MIME_TYPES[ext]) {
    return MIME_TYPES[ext];
  }

  return null; // no override
}

const POD_ISOLATION_HEADERS = {
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function hasHeader(headers, name) {
  const needle = name.toLowerCase();
  if (typeof headers.has === "function") {
    return headers.has(name);
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

function setHeader(headers, name, value) {
  if (typeof headers.set === "function") {
    headers.set(name, value);
  } else {
    headers[name] = value;
  }
}

function addPodIsolationHeaders(headers) {
  for (const [name, value] of Object.entries(POD_ISOLATION_HEADERS)) {
    if (!hasHeader(headers, name)) {
      setHeader(headers, name, value);
    }
  }
  return headers;
}

function withPodIsolationHeaders(response) {
  const headers = new Headers(response.headers);
  addPodIsolationHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

function getHeaderValue(headers, name) {
  const needle = name.toLowerCase();
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === needle) return headers[key];
  }
  return null;
}

function makeNavigationRedirectTarget(location, request) {
  let redirectUrl;
  try {
    redirectUrl = new URL(location, request.url);
  } catch {
    return null;
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-type");

  return {
    path: stripPreviewPrefix(redirectUrl.pathname) + redirectUrl.search,
    request: {
      arrayBuffer: async () => new ArrayBuffer(0),
      headers,
      method: "GET",
      mode: request.mode,
      url: redirectUrl.toString(),
    },
  };
}

// ── Lifecycle ──

self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Message handling ──

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;

  // register a new tab's MessagePort. if the same tab reinits (same token,
  // new channel from controllerchange) drop the old port first so stale
  // entries don't accumulate. RequestProxy resends claim-instance after.
  if (data.type === "init" && data.port) {
    const mp = data.port;
    const token = data.token || null;
    if (token) {
      for (const [old, info] of [...ports.entries()]) {
        if (old !== mp && info.token === token) {
          cleanupPort(old);
        }
      }
    }
    ports.set(mp, { token, instances: new Set() });
    mp.onmessage = (ev) => onPortMessage(ev, mp);

    // claim uncontrolled clients now. the activate event's clients.claim()
    // only covers fresh install, it does NOT cover hard refresh (Ctrl+Shift+R)
    // of a page that already had this SW registered, the browser bypasses the
    // SW for the top-level nav and the page stays uncontrolled forever since
    // activate doesn't re-run. reclaiming here fires controllerchange on that
    // page so its fetches route through the SW like normal.
    if (event.waitUntil) {
      event.waitUntil(self.clients.claim());
    } else {
      self.clients.claim();
    }
    return;
  }

  // iframe claims its stripped path. we look up the pod from the sender's
  // clientId so a page can't claim for a pod it isn't already tied to.
  if (data.type === "nodepod-path-claim" && typeof data.path === "string") {
    const clientId = event.source && event.source.id;
    const pod = clientId ? previewClients.get(clientId) : null;
    if (pod) {
      if (pathToPodMap.size >= PATH_MAP_MAX) {
        const oldest = pathToPodMap.keys().next().value;
        if (oldest !== undefined) pathToPodMap.delete(oldest);
      }
      // re-insert to bump recency
      pathToPodMap.delete(data.path);
      pathToPodMap.set(data.path, pod);
    }
    return;
  }

  // everything else requires a token from some live tab
  if (!isValidToken(data.token)) return;

  if (data.type === "register-preview") {
    trackPreviewClient(data.clientId, {
      instanceId: data.instanceId || DEFAULT_INSTANCE,
      serverPort: data.serverPort,
    });
    return;
  }
  if (data.type === "unregister-preview") {
    previewClients.delete(data.clientId);
    forgetPreviewClient(data.clientId);
    return;
  }
  if (data.type === "set-preview-script") {
    const id = data.instanceId || DEFAULT_INSTANCE;
    if (!isValidTokenForInstance(data.token, id)) return;
    if (data.script === null || data.script === undefined) {
      previewScripts.delete(id);
    } else {
      previewScripts.set(id, data.script);
    }
    return;
  }
  if (data.type === "set-watermark") {
    watermarkEnabled = !!data.enabled;
    return;
  }
  if (data.type === "set-ws-token") {
    const id = data.instanceId || DEFAULT_INSTANCE;
    if (!isValidTokenForInstance(data.token, id)) return;
    if (data.wsToken === null || data.wsToken === undefined) {
      wsTokens.delete(id);
    } else {
      wsTokens.set(id, data.wsToken);
    }
    return;
  }
});

// messages over a tab's MessagePort. mp is captured at init time so we always
// know which tab spoke
function onPortMessage(event, mp) {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "response" && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error));
    else resolve(msg.data);
    return;
  }

  if (msg.type === "claim-instance" && msg.data && msg.data.instanceId) {
    claimInstance(mp, msg.data.instanceId);
    return;
  }
  if (msg.type === "release-instance" && msg.data && msg.data.instanceId) {
    releaseInstance(mp, msg.data.instanceId);
    return;
  }
  if (msg.type === "release-all") {
    cleanupPort(mp);
    return;
  }

  // server-registered implicitly claims the instance so legacy callers that
  // never sent claim-instance still route correctly
  if (msg.type === "server-registered" && msg.data && msg.data.instanceId) {
    claimInstance(mp, msg.data.instanceId);
    return;
  }
  // note: server-unregistered does NOT release. a tab may register multiple
  // servers for one instance and we only want to unclaim on explicit release

  if (msg.type === "keepalive") return;
}

// ── Fetch interception ──

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 1. explicit /__virtual__/{instanceId}/{port}/{path} or legacy /__virtual__/{port}/{path}
  const virtualHit = matchPreviewOrVirtualPath(url.pathname, "virtual");
  if (virtualHit) {
    const { instanceId, port: serverPort, rest } = virtualHit;
    const path = rest + url.search;
    if (event.request.mode === "navigate") {
      event.respondWith(
        (async () => {
          if (event.resultingClientId) {
            trackPreviewClient(event.resultingClientId, { instanceId, serverPort });
          }
          return proxyToVirtualServer(event.request, instanceId, serverPort, path);
        })(),
      );
    } else {
      event.respondWith(
        proxyToVirtualServer(event.request, instanceId, serverPort, path),
      );
    }
    return;
  }

  // 2. Explicit /__preview__/{instanceId}/{port}/{path} or legacy /__preview__/{port}/{path}
  const previewHit = matchPreviewOrVirtualPath(url.pathname, "preview");
  if (previewHit) {
    const { instanceId, port: serverPort, rest } = previewHit;
    const path = rest + url.search;

    if (event.request.mode === "navigate") {
      event.respondWith(
        (async () => {
          if (event.resultingClientId) {
            trackPreviewClient(event.resultingClientId, { instanceId, serverPort });
          }
          return proxyToVirtualServer(event.request, instanceId, serverPort, path);
        })(),
      );
    } else {
      event.respondWith(
        proxyToVirtualServer(event.request, instanceId, serverPort, path),
      );
    }
    return;
  }

  // 3. request from a tracked preview client, route through that instance's
  //    virtual server. catches module imports like /@react-refresh etc.
  //    only same-origin, let cross-origin (google fonts, CDNs) pass through
  //    form navigations that replace an iframe expose the old document as
  //    replacesClientId, not clientId.
  const clientId = event.clientId;
  const routingClientId = clientId || event.replacesClientId;
  if (routingClientId && previewClients.has(routingClientId)) {
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === self.location.hostname) {
      const { instanceId, serverPort } = previewClients.get(routingClientId);
      // Self-heal: a preview client can outlive its pod (project reopen, preview
      // restart) while still mapped to the torn-down instance. Routing to that
      // dead instance wedges the preview, so drop the stale mapping and fall
      // through to fresh routing (referer/path claims re-track the current pod).
      // Skipped when the instance is still registered.
      if (!instancePorts.has(instanceId)) {
        previewClients.delete(routingClientId);
        forgetPreviewClient(routingClientId);
      } else {
        // strip /__preview__/{instanceId}/{port} or /__virtual__/{instanceId}/{port}
        // (or legacy forms) if the browser resolved a relative URL against the
        // preview page's location.
        let path = stripPreviewPrefix(url.pathname);
        path += url.search;
        if (event.resultingClientId && event.resultingClientId !== routingClientId) {
          trackPreviewClient(event.resultingClientId, { instanceId, serverPort });
        }
        event.respondWith(
          proxyToVirtualServer(event.request, instanceId, serverPort, path, event.request),
        );
        return;
      }
    }
  }

  // 3b. clientId is unknown to this (possibly freshly restarted) worker:
  //     try the persisted preview-client state before giving up. Skipped for
  //     navigations so the referer/path-claim fallbacks below keep handling
  //     those. Ordinary page clients miss once and are then remembered.
  if (
    clientId &&
    !restoreMisses.has(clientId) &&
    event.request.mode !== "navigate"
  ) {
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === self.location.hostname) {
      event.respondWith(
        (async () => {
          const pod = await restorePreviewClient(clientId);
          if (pod) {
            let path = stripPreviewPrefix(url.pathname);
            path += url.search;
            return proxyToVirtualServer(
              event.request,
              pod.instanceId,
              pod.serverPort,
              path,
              event.request,
            );
          }
          restoreMisses.add(clientId);
          return fetch(event.request);
        })(),
      );
      return;
    }
  }

  // 4. fallback: check Referer header. Handles the Firefox race where the first
  //    subresource after a navigation arrives with event.clientId === "".
  const referer = event.request.referrer;
  if (referer) {
    try {
      const refUrl = new URL(referer);
      // Try new then legacy shape in the referer path
      const refHit =
        matchPreviewOrVirtualPath(refUrl.pathname, "preview") ||
        matchPreviewOrVirtualPath(refUrl.pathname, "virtual");
      if (refHit) {
        const host = url.hostname;
        if (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "0.0.0.0" ||
          host === self.location.hostname
        ) {
          const { instanceId, port: serverPort } = refHit;
          let path = stripPreviewPrefix(url.pathname);
          path += url.search;
          if (clientId) {
            trackPreviewClient(clientId, { instanceId, serverPort });
          }
          event.respondWith(
            proxyToVirtualServer(event.request, instanceId, serverPort, path, event.request),
          );
          return;
        }
      }
    } catch {
      // Invalid referer URL, ignore
    }
  }

  // 5. fallback: path-claim map. catches iframe reloads where the URL was
  //    stripped by the location patch, so clientId and referer are no help.
  //    gated to iframe/frame navigations so outer-page top-level nav to a
  //    path that happens to be claimed doesn't get misrouted to a pod.
  {
    const dest = event.request.destination;
    const isIframeNav = event.request.mode === "navigate" && (dest === "iframe" || dest === "frame");
    const host = url.hostname;
    const sameOrigin = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === self.location.hostname;
    if (isIframeNav && sameOrigin) {
      const pathHit = pathToPodMap.get(url.pathname);
      if (pathHit) {
        const { instanceId, serverPort } = pathHit;
        const path = url.pathname + url.search;
        if (event.resultingClientId) {
          trackPreviewClient(event.resultingClientId, { instanceId, serverPort });
        }
        event.respondWith(
          proxyToVirtualServer(event.request, instanceId, serverPort, path, event.request),
        );
        return;
      }
    }
  }

  // If nothing matched, let the browser handle it normally
});

// ── WebSocket shim for preview iframes ──
//
// Injected into HTML responses to override the browser's WebSocket constructor.
// Routes localhost WebSocket connections through BroadcastChannel "nodepod-ws"
// to the main thread's request-proxy, which dispatches upgrade events on the
// virtual HTTP server. Works with any framework/library, not specific to Vite.

function getWsShimScript(instanceId, serverPort) {
  const token = wsTokens.get(instanceId);
  const tokenStr = token ? JSON.stringify(token) : "null";
  const instanceIdStr = JSON.stringify(instanceId);
  const portLiteral = Number.isFinite(serverPort) ? Number(serverPort) : 0;
  return `<script>
(function() {
  if (window.__nodepodWsShim) return;
  window.__nodepodWsShim = true;
  var NativeWS = window.WebSocket;
  var bc = new BroadcastChannel("nodepod-ws");
  var _wsToken = ${tokenStr};
  var _instanceId = ${instanceIdStr};
  var nextId = 0;
  var active = {};

  // virtual server port baked in by the SW. localhost ws connects from
  // this iframe route here, cant be read from location.pathname because
  // the location patch above already stripped the prefix
  var _previewPort = ${portLiteral};

  function NodepodWS(url, protocols) {
    var parsed;
    try { parsed = new URL(url, location.href); } catch(e) {
      return new NativeWS(url, protocols);
    }
    // Only intercept localhost connections
    var host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
      return new NativeWS(url, protocols);
    }
    var self = this;
    var uid = "ws-iframe-" + (++nextId) + "-" + Math.random().toString(36).slice(2,8);
    // Use the preview port (from /__preview__/.../{port}/) if available,
    // otherwise fall back to the port from the WebSocket URL.
    var port = _previewPort || parseInt(parsed.port) || (parsed.protocol === "wss:" ? 443 : 80);
    var path = parsed.pathname + parsed.search;

    self.url = url;
    self.readyState = 0; // CONNECTING
    self.protocol = "";
    self.extensions = "";
    self.bufferedAmount = 0;
    self.binaryType = "blob";
    self.onopen = null;
    self.onclose = null;
    self.onerror = null;
    self.onmessage = null;
    self._uid = uid;
    self._listeners = {};

    active[uid] = self;

    bc.postMessage({
      kind: "ws-connect",
      instanceId: _instanceId,
      uid: uid,
      port: port,
      path: path,
      protocols: Array.isArray(protocols) ? protocols.join(",") : (protocols || ""),
      token: _wsToken
    });

    // Timeout: if no ws-open within 5s, fire error
    self._connectTimer = setTimeout(function() {
      if (self.readyState === 0) {
        self.readyState = 3;
        var e = new Event("error");
        self.onerror && self.onerror(e);
        _emit(self, "error", e);
        delete active[uid];
      }
    }, 5000);
  }

  function _emit(ws, evt, arg) {
    var list = ws._listeners[evt];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(ws, arg); } catch(e) { /* ignore */ }
    }
  }

  NodepodWS.prototype.addEventListener = function(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = [];
    this._listeners[evt].push(fn);
  };
  NodepodWS.prototype.removeEventListener = function(evt, fn) {
    var list = this._listeners[evt];
    if (!list) return;
    this._listeners[evt] = list.filter(function(f) { return f !== fn; });
  };
  NodepodWS.prototype.dispatchEvent = function(evt) {
    _emit(this, evt.type, evt);
    return true;
  };
  NodepodWS.prototype.send = function(data) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    var type = "text";
    var payload = data;
    if (data instanceof ArrayBuffer) {
      type = "binary";
      payload = Array.from(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      type = "binary";
      payload = Array.from(data);
    }
    bc.postMessage({ kind: "ws-send", instanceId: _instanceId, uid: this._uid, data: payload, type: type, token: _wsToken });
  };
  NodepodWS.prototype.close = function(code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    bc.postMessage({ kind: "ws-close", instanceId: _instanceId, uid: this._uid, code: code || 1000, reason: reason || "", token: _wsToken });
    var self = this;
    setTimeout(function() {
      self.readyState = 3;
      var e = new CloseEvent("close", { code: code || 1000, reason: reason || "", wasClean: true });
      self.onclose && self.onclose(e);
      _emit(self, "close", e);
      delete active[self._uid];
    }, 0);
  };

  NodepodWS.CONNECTING = 0;
  NodepodWS.OPEN = 1;
  NodepodWS.CLOSING = 2;
  NodepodWS.CLOSED = 3;
  NodepodWS.prototype.CONNECTING = 0;
  NodepodWS.prototype.OPEN = 1;
  NodepodWS.prototype.CLOSING = 2;
  NodepodWS.prototype.CLOSED = 3;

  bc.onmessage = function(ev) {
    var d = ev.data;
    if (!d || !d.uid) return;
    // Filter by instance so a sibling Nodepod's chatter doesn't leak in
    if (d.instanceId && d.instanceId !== _instanceId) return;
    // check bridge token
    if (_wsToken && d.token !== _wsToken) return;
    var ws = active[d.uid];
    if (!ws) return;

    if (d.kind === "ws-open") {
      clearTimeout(ws._connectTimer);
      ws.readyState = 1;
      var e = new Event("open");
      ws.onopen && ws.onopen(e);
      _emit(ws, "open", e);
    } else if (d.kind === "ws-message") {
      var msgData;
      if (d.type === "binary") {
        msgData = new Uint8Array(d.data).buffer;
      } else {
        msgData = d.data;
      }
      var me = new MessageEvent("message", { data: msgData });
      ws.onmessage && ws.onmessage(me);
      _emit(ws, "message", me);
    } else if (d.kind === "ws-closed") {
      ws.readyState = 3;
      clearTimeout(ws._connectTimer);
      var ce = new CloseEvent("close", { code: d.code || 1000, reason: "", wasClean: true });
      ws.onclose && ws.onclose(ce);
      _emit(ws, "close", ce);
      delete active[d.uid];
    } else if (d.kind === "ws-error") {
      ws.readyState = 3;
      clearTimeout(ws._connectTimer);
      var ee = new Event("error");
      ws.onerror && ws.onerror(ee);
      _emit(ws, "error", ee);
      delete active[d.uid];
    }
  };

  window.WebSocket = NodepodWS;
})();
</script>`;
}

// ── Virtual-prefix URL patch ──
//
// iframes live at /__virtual__/{id}/{port}/ but client-side routers read
// location.pathname and want the app's real path. Location is
// [LegacyUnforgeable] so we can't override its getters. instead we strip
// the prefix from the real URL via history.replaceState before any user
// script runs. SW routes later requests via clientId, with the path-claim
// map as a fallback for force-reloads.
const LOCATION_PATCH_SCRIPT = `<script>
(function() {
  if (window.__nodepodLocPatch) return;
  window.__nodepodLocPatch = true;

  // /__virtual__/{id}/{port} (|\\d+ branch is the legacy id-less form)
  var PREFIX_RE = /^\\/__(?:preview|virtual)__\\/(?:[A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*\\/\\d+|\\d+)/;

  var m = location.pathname.match(PREFIX_RE);
  if (!m) return;
  var PREFIX = m[0];

  function strip(u) {
    if (typeof u !== 'string') return u;
    if (u === PREFIX) return '/';
    if (u.indexOf(PREFIX + '/') === 0) return u.slice(PREFIX.length);
    if (u.indexOf(PREFIX + '?') === 0) return '/' + u.slice(PREFIX.length);
    if (u.indexOf(PREFIX + '#') === 0) return '/' + u.slice(PREFIX.length);
    return u;
  }

  // let the SW know our path so a force-reload without the prefix still routes
  function claimPath() {
    try {
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: 'nodepod-path-claim', path: location.pathname });
    } catch (e) {}
  }

  // swap the visible URL to the stripped form. same document, just history.
  try {
    var newPath = strip(location.pathname);
    if (newPath !== location.pathname) {
      history.replaceState(history.state, '', newPath + location.search + location.hash);
    }
  } catch (e) {
    console.warn('[nodepod] initial URL strip failed:', e);
  }
  claimPath();

  // strip any prefix user code passes, re-claim on every nav so the SW's
  // fallback map stays current
  var origPush = history.pushState;
  var origRepl = history.replaceState;
  history.pushState = function(state, title, url) {
    if (typeof url === 'string') url = strip(url);
    var r = origPush.call(this, state, title, url);
    claimPath();
    return r;
  };
  history.replaceState = function(state, title, url) {
    if (typeof url === 'string') url = strip(url);
    var r = origRepl.call(this, state, title, url);
    claimPath();
    return r;
  };
  window.addEventListener('popstate', claimPath);

  // plain <a href="/..."> clicks resolve against the origin and drop the virtual
  // prefix, so the SW can't route them to the pod. Re-add the prefix and let the
  // browser navigate for real — SSR / multi-page apps need the server round-trip.
  // Bubble phase so framework Link handlers (which preventDefault for their own
  // client-side routing) win and keep their SPA navigation.
  document.addEventListener('click', function(ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
    var el = ev.target;
    while (el && el.nodeName !== 'A') el = el.parentNode;
    if (!el || !el.getAttribute) return;
    if (el.target && el.target !== '' && el.target !== '_self') return;
    if (el.hasAttribute('download')) return;
    var raw = el.getAttribute('href');
    if (!raw || raw.charAt(0) !== '/' || raw.charAt(1) === '/') return;
    var stripped = strip(raw);
    if (stripped !== location.pathname + location.search + location.hash) {
      ev.preventDefault();
      location.assign(PREFIX + stripped);
    }
  });

  // <form action="/..."> posts to origin. strip any prefix before submit,
  // SW handles the rest via clientId.
  document.addEventListener('submit', function(ev) {
    var form = ev.target;
    if (!form || form.nodeName !== 'FORM') return;
    var a = form.getAttribute('action');
    if (!a) return;
    var stripped = strip(a);
    if (stripped !== a) form.setAttribute('action', stripped);
  }, true);
})();
</script>`;

// Small "nodepod" badge in the bottom-right corner of preview iframes.
const WATERMARK_SCRIPT = `<script>
(function() {
  if (window.__nodepodWatermark) return;
  window.__nodepodWatermark = true;
  document.addEventListener("DOMContentLoaded", function() {
    var a = document.createElement("a");
    a.href = "https://github.com/ScelarOrg/Nodepod";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "nodepod";
    a.style.cssText = "position:fixed;bottom:6px;right:8px;z-index:2147483647;"
      + "font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:11px;"
      + "color:rgba(255,255,255,0.45);background:rgba(0,0,0,0.25);padding:2px 6px;"
      + "border-radius:4px;text-decoration:none;pointer-events:auto;transition:color .15s;";
    a.onmouseenter = function() { a.style.color = "rgba(255,255,255,0.85)"; };
    a.onmouseleave = function() { a.style.color = "rgba(255,255,255,0.45)"; };
    document.body.appendChild(a);
  });
})();
</script>`;

// ── Error page generator ──

function errorPage(status, title, message) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} - ${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 2rem;
  }
  .container { max-width: 480px; text-align: center; }
  .status { font-size: 5rem; font-weight: 700; color: #555; line-height: 1; }
  .title { font-size: 1.25rem; margin-top: 0.75rem; color: #ccc; }
  .message { font-size: 0.875rem; margin-top: 1rem; color: #888; line-height: 1.5; }
  .hint { font-size: 0.8rem; margin-top: 1.5rem; color: #555; }
</style>
</head>
<body>
<div class="container">
  <div class="status">${status}</div>
  <div class="title">${title}</div>
  <div class="message">${message}</div>
  <div class="hint">Powered by Nodepod</div>
</div>
</body>
</html>`;
  return new Response(html, {
    status,
    statusText: title,
    headers: addPodIsolationHeaders({
      "content-type": "text/html; charset=utf-8",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    }),
  });
}

// ── Virtual server proxy ──

async function proxyToVirtualServer(request, instanceId, serverPort, path, originalRequest, redirectDepth = 0) {
  // route to whichever tab owns this instanceId
  let targetPort = getPortForInstance(instanceId);

  if (!targetPort) {
    // no tabs connected, poke clients to reinit and give them a moment
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      client.postMessage({ type: "sw-needs-init" });
    }
    await new Promise((r) => setTimeout(r, 200));
    targetPort = getPortForInstance(instanceId);
    if (!targetPort) {
      return errorPage(503, "Service Unavailable", "The Nodepod service worker is still initializing. Please refresh the page.");
    }
  }

  // Clone the original request before consuming the body, so we can use it
  // for the 404 fallback fetch later if needed.
  const fallbackRequest = originalRequest ? originalRequest.clone() : null;

  const headers = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  headers["host"] = `localhost:${serverPort}`;

  let body = undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await request.arrayBuffer();
    } catch {
      // body not available
    }
  }

  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, port: targetPort });
    setTimeout(() => {
      if (pending.has(id)) {
        const entry = pending.get(id);
        pending.delete(id);
        // port never answered, likely stale (tab closed without pagehide).
        // evict so the next request doesn't waste another long wait on it.
        // 300s matches HTTP_DISPATCH_SAFETY so cold WASI workers (tailwind v4,
        // rolldown) dont get cut off on first request.
        if (entry.port && ports.has(entry.port)) {
          cleanupPort(entry.port);
        }
        reject(new Error("Request timeout: " + path));
      }
    }, 300000);
  });

  try {
    targetPort.postMessage({
      type: "request",
      id,
      data: {
        instanceId,
        port: serverPort,
        method: request.method,
        url: path,
        headers,
        body,
        // original url so main thread can fall back to a network fetch if
        // the virtual server returns 404 (fonts, CDNs etc)
        originalUrl: request.url,
      },
    });
  } catch (err) {
    // port got detached between lookup and post
    pending.delete(id);
    cleanupPort(targetPort);
    return errorPage(503, "Service Unavailable", "The owning tab for this server is no longer connected.");
  }

  try {
    const data = await promise;
    let responseBody = null;
    if (data.bodyBase64) {
      const binary = atob(data.bodyBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      responseBody = bytes;
    }
    const respHeaders = Object.assign({}, data.headers || {});
    const statusCode = data.statusCode || 200;

    if (request.mode === "navigate" && isRedirectStatus(statusCode)) {
      const location = getHeaderValue(respHeaders, "Location");
      if (!location) {
        return errorPage(502, "Bad Gateway", "Pod redirect response was missing a Location header.");
      }
      if (redirectDepth >= 10) {
        return errorPage(508, "Loop Detected", "Pod navigation redirected too many times.");
      }
      const redirectTarget = makeNavigationRedirectTarget(location, request);
      if (!redirectTarget) {
        return errorPage(502, "Bad Gateway", "Pod redirect response had an invalid Location header.");
      }
      return proxyToVirtualServer(
        redirectTarget.request,
        instanceId,
        serverPort,
        redirectTarget.path,
        null,
        redirectDepth + 1,
      );
    }

    // Fix MIME type: SPA fallback middleware may serve index.html (text/html)
    // for non-HTML paths. Correct the Content-Type based on file extension.
    const overrideMime = inferMimeType(path, respHeaders);
    if (overrideMime) {
      // Replace Content-Type regardless of casing in original headers
      for (const k of Object.keys(respHeaders)) {
        if (k.toLowerCase() === "content-type") delete respHeaders[k];
      }
      respHeaders["content-type"] = overrideMime;
    }

    // Inject WebSocket shim + preview script into HTML responses so that
    // browser-side WebSocket connections are routed through nodepod, and
    // user-provided preview scripts run before any page content.
    let finalBody = responseBody;
    const ct = respHeaders["content-type"] || respHeaders["Content-Type"] || "";
    if (ct.includes("text/html") && responseBody) {
      // location patch runs first so user scripts see the stripped URL
      let injection = LOCATION_PATCH_SCRIPT + getWsShimScript(instanceId, serverPort);
      const previewScript = previewScripts.get(instanceId);
      if (previewScript) {
        injection += `<script>${previewScript}<` + `/script>`;
      }
      if (watermarkEnabled) {
        injection += WATERMARK_SCRIPT;
      }
      const html = new TextDecoder().decode(responseBody);
      // Inject before <head> or at the start of the document
      const headIdx = html.indexOf("<head");
      if (headIdx >= 0) {
        const closeAngle = html.indexOf(">", headIdx);
        if (closeAngle >= 0) {
          const injected = html.slice(0, closeAngle + 1) + injection + html.slice(closeAngle + 1);
          finalBody = new TextEncoder().encode(injected);
        }
      } else {
        // No <head> tag — prepend the shim
        finalBody = new TextEncoder().encode(injection + html);
      }
      // Update content-length if present
      for (const k of Object.keys(respHeaders)) {
        if (k.toLowerCase() === "content-length") {
          respHeaders[k] = String(finalBody.byteLength);
        }
      }
    }

    addPodIsolationHeaders(respHeaders);

    // If the virtual server returned 404 and we have the original request,
    // fall back to a real network fetch. This handles cases where the preview
    // app generates relative URLs for external resources (e.g. fonts, CDN assets)
    // that the virtual server doesn't serve.
    if ((data.statusCode === 404) && fallbackRequest) {
      try {
        const fallbackResponse = await fetch(fallbackRequest);
        return withPodIsolationHeaders(fallbackResponse);
      } catch (fetchErr) {
        // Fall through to return the original 404
      }
    }

    return new Response(finalBody, {
      status: statusCode,
      statusText: data.statusMessage || "OK",
      headers: respHeaders,
    });
  } catch (err) {
    const msg = err.message || "Proxy error";
    // If the error is a timeout, it likely means no server is listening
    if (msg.includes("timeout")) {
      return errorPage(504, "Gateway Timeout", "No server responded on port " + serverPort + ". Make sure your dev server is running.");
    }
    return errorPage(502, "Bad Gateway", msg);
  }
}
