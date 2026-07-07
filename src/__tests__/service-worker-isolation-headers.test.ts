import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type ServiceWorkerListener = (event: {
  clientId?: string;
  data?: unknown;
  replacesClientId?: string;
  request?: unknown;
  respondWith?: (response: Promise<Response> | Response) => void;
  resultingClientId?: string;
  source?: { id?: string };
  waitUntil?: (promise: Promise<unknown>) => void;
}) => void;

interface ServiceWorkerSandbox extends Record<string, unknown> {
  __cacheDeletes?: string[];
  __fellThrough?: string[];
  __listeners?: Record<string, ServiceWorkerListener[]>;
  addPodIsolationHeaders?: (
    headers: Headers | Record<string, string>,
  ) => Headers | Record<string, string>;
  proxyToVirtualServer?: (
    request: Request,
    instanceId: string,
    serverPort: number,
    path: string,
    originalRequest?: Request,
    redirectDepth?: number,
  ) => Promise<Response>;
}

const PREVIEW_CLIENT_KEY_PREFIX = "https://nodepod.sw/preview-client/";

async function loadServiceWorkerSandbox(
  // Seeds the persisted SW-state cache (clientId -> pod). Simulates entries that
  // outlived an idle-recycled worker, so the in-memory maps start empty but the
  // Cache API mirror still holds routes. Keyed by clientId.
  persisted: Record<string, { instanceId: string; serverPort: number }> = {},
): Promise<ServiceWorkerSandbox> {
  const listeners: Record<string, ServiceWorkerListener[]> = {};
  const fellThrough: string[] = [];
  const cacheDeletes: string[] = [];
  // Back the Cache API stub with a real Map so keys()/match()/delete() are
  // coherent for the persisted-sweep path. put() stays a no-op so tests that
  // rely on match() missing (the lazy self-heal) keep their behaviour.
  const persistedStore = new Map<string, { instanceId: string; serverPort: number }>(
    Object.entries(persisted).map(([clientId, pod]) => [
      PREVIEW_CLIENT_KEY_PREFIX + encodeURIComponent(clientId),
      pod,
    ]),
  );
  const source = await readFile(
    resolve(process.cwd(), "static/__sw__.js"),
    "utf8",
  );
  const sandbox: ServiceWorkerSandbox = {
    __cacheDeletes: cacheDeletes,
    __fellThrough: fellThrough,
    __listeners: listeners,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
    // Requests the SW passes to the network (fall-through) instead of proxying
    // to a pod. Lets tests assert self-healing dropped a dead route.
    fetch: (request: { url?: string } | string) => {
      const requestUrl = typeof request === "string" ? request : (request.url ?? "");
      fellThrough.push(requestUrl);
      return Promise.resolve(new Response("network", { status: 200 }));
    },
    caches: {
      open: () =>
        Promise.resolve({
          keys: () =>
            Promise.resolve([...persistedStore.keys()].map((url) => ({ url }))),
          match: (request: { url?: string } | string) => {
            const url =
              typeof request === "string" ? request : (request.url ?? "");
            const pod = persistedStore.get(url);
            return Promise.resolve(
              pod ? new Response(JSON.stringify(pod)) : undefined,
            );
          },
          // Record which persisted keys the SW deletes so tests can assert the
          // proactive release-time cleanup ran, not just the lazy fetch path.
          delete: (request: { url?: string } | string) => {
            const url =
              typeof request === "string" ? request : (request.url ?? "");
            cacheDeletes.push(url);
            return Promise.resolve(persistedStore.delete(url));
          },
          // No-op: keeping the seeded set fixed preserves the match()-misses
          // behaviour the lazy self-heal test depends on.
          put: () => Promise.resolve(undefined),
        }),
    },
    clearTimeout,
    console,
    self: {
      addEventListener: (type: string, listener: ServiceWorkerListener) => {
        (listeners[type] ||= []).push(listener);
      },
      clients: {
        claim: () => Promise.resolve(),
        matchAll: () => Promise.resolve([]),
      },
      location: { hostname: "localhost" },
      skipWaiting: () => Promise.resolve(),
    },
    setTimeout,
  };

  runInNewContext(source, sandbox, { filename: "static/__sw__.js" });
  return sandbox;
}

describe("service worker isolation headers", () => {
  it("adds pod isolation headers to plain header maps", async () => {
    const sandbox = await loadServiceWorkerSandbox();
    const add = sandbox.addPodIsolationHeaders;
    if (!add) throw new Error("addPodIsolationHeaders was not loaded");

    const headers = add({
      "content-type": "text/html; charset=utf-8",
    }) as Record<string, string>;

    expect(headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
    expect(headers["Cross-Origin-Embedder-Policy"]).toBe("credentialless");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("does not overwrite existing isolation headers", async () => {
    const sandbox = await loadServiceWorkerSandbox();
    const add = sandbox.addPodIsolationHeaders;
    if (!add) throw new Error("addPodIsolationHeaders was not loaded");

    const headers = add({
      "cross-origin-resource-policy": "same-origin",
    }) as Record<string, string>;

    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBeUndefined();
  });

  it("follows navigation POST redirects inside the pod", async () => {
    const sandbox = await loadServiceWorkerSandbox();
    const proxy = sandbox.proxyToVirtualServer;
    if (!proxy) throw new Error("proxyToVirtualServer was not loaded");
    const messageHandler = sandbox.__listeners?.message?.[0];
    if (!messageHandler) throw new Error("message handler was not loaded");

    const requests: Array<{
      body?: ArrayBuffer;
      method: string;
      url: string;
    }> = [];
    const html = "<!doctype html><html><head></head><body>Home</body></html>";
    const responses: Array<{
      bodyBase64?: string;
      headers: Record<string, string>;
      statusCode: number;
      statusMessage: string;
    }> = [
      {
        headers: { Location: "/" },
        statusCode: 302,
        statusMessage: "Found",
      },
      {
        bodyBase64: Buffer.from(html).toString("base64"),
        headers: { "content-type": "text/html; charset=utf-8" },
        statusCode: 200,
        statusMessage: "OK",
      },
    ];
    let port: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (message: {
        data: {
          body?: ArrayBuffer;
          method: string;
          url: string;
        };
        id: number;
      }) => void;
    };
    port = {
      onmessage: null,
      postMessage: (message) => {
        requests.push(message.data);
        const responseData = responses.shift();
        if (!responseData) throw new Error("unexpected pod request");
        setTimeout(() => {
          port.onmessage?.({
            data: {
              data: responseData,
              id: message.id,
              type: "response",
            },
          });
        }, 0);
      },
    };

    messageHandler({
      data: { port, token: "token", type: "init" },
      waitUntil: () => {},
    });
    port.onmessage?.({
      data: {
        data: { instanceId: "pod" },
        type: "claim-instance",
      },
    });

    const formBody = new TextEncoder().encode("name=ada").buffer;
    const response = await proxy(
      {
        arrayBuffer: () => Promise.resolve(formBody.slice(0)),
        headers: new Headers({
          "content-type": "application/x-www-form-urlencoded",
        }),
        method: "POST",
        mode: "navigate",
        url: "http://localhost/sign",
      } as unknown as Request,
      "pod",
      5173,
      "/sign",
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/sign");
    expect(new TextDecoder().decode(requests[0].body)).toBe("name=ada");
    expect(requests[1].method).toBe("GET");
    expect(requests[1].url).toBe("/");
    expect(requests[1].body).toBeUndefined();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Home");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin",
    );
  });

  // Mutation captured: ignoring FetchEvent.replacesClientId lets iframe form
  // navigations fall through to the host network instead of the pod.
  it("routes POST navigations that replace a tracked preview client", async () => {
    const sandbox = await loadServiceWorkerSandbox();
    const messageHandler = sandbox.__listeners?.message?.[0];
    const fetchHandler = sandbox.__listeners?.fetch?.[0];
    if (!messageHandler) throw new Error("message handler was not loaded");
    if (!fetchHandler) throw new Error("fetch handler was not loaded");

    const requests: Array<{
      body?: ArrayBuffer;
      method: string;
      url: string;
    }> = [];
    const html = "<!doctype html><html><head></head><body>Home</body></html>";
    const responses: Array<{
      bodyBase64?: string;
      headers: Record<string, string>;
      statusCode: number | string;
      statusMessage: string;
    }> = [
      {
        headers: { location: "/" },
        statusCode: "302",
        statusMessage: "Found",
      },
      {
        bodyBase64: Buffer.from(html).toString("base64"),
        headers: { "content-type": "text/html; charset=utf-8" },
        statusCode: "200",
        statusMessage: "OK",
      },
      {
        bodyBase64: Buffer.from("body{}").toString("base64"),
        headers: { "content-type": "text/css" },
        statusCode: 200,
        statusMessage: "OK",
      },
    ];
    let port: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (message: {
        data: {
          body?: ArrayBuffer;
          method: string;
          url: string;
        };
        id: number;
      }) => void;
    };
    port = {
      onmessage: null,
      postMessage: (message) => {
        requests.push(message.data);
        const responseData = responses.shift();
        if (!responseData) throw new Error("unexpected pod request");
        setTimeout(() => {
          port.onmessage?.({
            data: {
              data: responseData,
              id: message.id,
              type: "response",
            },
          });
        }, 0);
      },
    };

    messageHandler({
      data: { port, token: "token", type: "init" },
      waitUntil: () => {},
    });
    port.onmessage?.({
      data: {
        data: { instanceId: "pod" },
        type: "claim-instance",
      },
    });
    messageHandler({
      data: {
        clientId: "preview-client",
        instanceId: "pod",
        serverPort: 5173,
        token: "token",
        type: "register-preview",
      },
    });
    messageHandler({
      data: { path: "/", type: "nodepod-path-claim" },
      source: { id: "preview-client" },
    });

    const formBytes = new TextEncoder().encode("name=ada");
    const formBody = formBytes.buffer.slice(
      formBytes.byteOffset,
      formBytes.byteOffset + formBytes.byteLength,
    );
    function makePostNavigationRequest() {
      return {
        arrayBuffer: () => Promise.resolve(formBody.slice(0)),
        clone: makePostNavigationRequest,
        destination: "document",
        headers: new Headers({
          "content-type": "application/x-www-form-urlencoded",
        }),
        method: "POST",
        mode: "navigate",
        referrer: "http://localhost:5173/",
        url: "http://localhost:5173/sign",
      };
    }
    function makeSubresourceRequest() {
      return {
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        clone: makeSubresourceRequest,
        destination: "style",
        headers: new Headers(),
        method: "GET",
        mode: "no-cors",
        referrer: "http://localhost:5173/",
        url: "http://localhost:5173/style.css",
      };
    }

    let responsePromise: Promise<Response> | undefined;
    fetchHandler({
      clientId: "",
      replacesClientId: "preview-client",
      request: makePostNavigationRequest(),
      respondWith: (response) => {
        responsePromise = Promise.resolve(response);
      },
      resultingClientId: "result-client",
    });
    if (!responsePromise) throw new Error("fetch listener did not call respondWith");
    const response = await responsePromise;

    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/sign");
    expect(new TextDecoder().decode(requests[0].body)).toBe("name=ada");
    expect(requests[1].method).toBe("GET");
    expect(requests[1].url).toBe("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Home");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin",
    );

    let cssResponsePromise: Promise<Response> | undefined;
    fetchHandler({
      clientId: "result-client",
      request: makeSubresourceRequest(),
      respondWith: (response) => {
        cssResponsePromise = Promise.resolve(response);
      },
    });
    if (!cssResponsePromise) throw new Error("result client was not tracked");
    const cssResponse = await cssResponsePromise;

    expect(requests).toHaveLength(3);
    expect(requests[2].method).toBe("GET");
    expect(requests[2].url).toBe("/style.css");
    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toBe("body{}");
  });

  // Mutation captured: without the dead-instance self-heal, a preview client
  // that outlived its pod (project reopen, preview restart) keeps routing to
  // the torn-down instance, wedging the preview instead of falling through.
  it("drops a preview client whose instance is no longer registered", async () => {
    const sandbox = await loadServiceWorkerSandbox();
    const messageHandler = sandbox.__listeners?.message?.[0];
    const fetchHandler = sandbox.__listeners?.fetch?.[0];
    if (!messageHandler) throw new Error("message handler was not loaded");
    if (!fetchHandler) throw new Error("fetch handler was not loaded");

    // Register a preview client pointing at an instance that was never claimed
    // (i.e. a torn-down pod): it is in previewClients but not in instancePorts.
    messageHandler({
      data: {
        clientId: "stale-client",
        instanceId: "dead-pod",
        serverPort: 3000,
        type: "register-preview",
      },
    });

    let responsePromise: Promise<Response> | undefined;
    fetchHandler({
      clientId: "stale-client",
      request: {
        headers: new Headers(),
        method: "GET",
        mode: "no-cors",
        referrer: "",
        url: "http://localhost:5173/style.css",
      } as unknown as Request,
      respondWith: (response) => {
        responsePromise = Promise.resolve(response);
      },
    });

    if (!responsePromise) throw new Error("fetch listener did not call respondWith");
    const response = await responsePromise;

    // It must fall through to the network, not proxy to the dead pod.
    expect(sandbox.__fellThrough).toContain("http://localhost:5173/style.css");
    expect(await response.text()).toBe("network");
  });

  // Mutation captured: without proactive teardown cleanup, releasing an instance
  // leaves its preview-client route in the in-memory map, so a later fetch keeps
  // routing at the torn-down pod instead of falling through.
  it("forgets a released instance's in-memory preview-client route", async () => {
    const sandbox = await loadServiceWorkerSandbox();
    const messageHandler = sandbox.__listeners?.message?.[0];
    const fetchHandler = sandbox.__listeners?.fetch?.[0];
    if (!messageHandler) throw new Error("message handler was not loaded");
    if (!fetchHandler) throw new Error("fetch handler was not loaded");

    // A live pod: the tab claims the instance and registers a preview client, so
    // it sits in instancePorts (the lazy self-heal would keep routing to it).
    const port: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: () => void;
    } = { onmessage: null, postMessage: () => {} };
    messageHandler({
      data: { port, token: "token", type: "init" },
      waitUntil: () => {},
    });
    port.onmessage?.({
      data: { data: { instanceId: "pod" }, type: "claim-instance" },
    });
    messageHandler({
      data: {
        clientId: "live-client",
        instanceId: "pod",
        serverPort: 5173,
        token: "token",
        type: "register-preview",
      },
    });

    // The tab tears the pod down: teardown() -> detach() -> release-instance.
    port.onmessage?.({
      data: { data: { instanceId: "pod" }, type: "release-instance" },
    });

    // A fetch on the released client now falls through instead of proxying.
    let responsePromise: Promise<Response> | undefined;
    fetchHandler({
      clientId: "live-client",
      request: {
        headers: new Headers(),
        method: "GET",
        mode: "no-cors",
        referrer: "",
        url: "http://localhost:5173/style.css",
      } as unknown as Request,
      respondWith: (response) => {
        responsePromise = Promise.resolve(response);
      },
    });
    if (!responsePromise) throw new Error("fetch listener did not call respondWith");
    const response = await responsePromise;

    expect(sandbox.__fellThrough).toContain("http://localhost:5173/style.css");
    expect(await response.text()).toBe("network");
  });

  // Mutation captured: the browser recycles idle workers, so the in-memory maps
  // start empty on reopen while the persisted mirror still holds the dead-pod
  // route. If release only swept the in-memory map (or skipped cleanup when the
  // recycled worker no longer had the instance claimed), the persisted route
  // would survive and wedge the reopened project ("exited 137"). Release must
  // sweep the Cache API by instanceId, unconditionally, and touch nothing else.
  it("sweeps a released instance's persisted route after a worker restart", async () => {
    const sandbox = await loadServiceWorkerSandbox({
      "dead-client": { instanceId: "dead-pod", serverPort: 3000 },
      "live-client": { instanceId: "live-pod", serverPort: 4000 },
    });
    const messageHandler = sandbox.__listeners?.message?.[0];
    if (!messageHandler) throw new Error("message handler was not loaded");

    // Freshly restarted worker: a port exists but nothing was re-claimed yet, so
    // instancePorts is empty and the ownership check inside releaseInstance fails.
    const port: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: () => void;
    } = { onmessage: null, postMessage: () => {} };
    messageHandler({
      data: { port, token: "token", type: "init" },
      waitUntil: () => {},
    });

    port.onmessage?.({
      data: { data: { instanceId: "dead-pod" }, type: "release-instance" },
    });
    // The persisted sweep is a multi-await cache chain (keys -> match -> json ->
    // delete); flush several macrotask rounds so it fully settles.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    }

    // Only the released instance's persisted route is dropped; the other pod's
    // route is untouched.
    expect(sandbox.__cacheDeletes).toContain(
      "https://nodepod.sw/preview-client/dead-client",
    );
    expect(sandbox.__cacheDeletes).not.toContain(
      "https://nodepod.sw/preview-client/live-client",
    );
  });
});
