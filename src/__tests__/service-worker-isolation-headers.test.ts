import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type ServiceWorkerListener = (event: {
  data?: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
}) => void;

interface ServiceWorkerSandbox extends Record<string, unknown> {
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
  withPodIsolationHeaders?: (response: Response) => Response;
}

async function loadServiceWorkerSandbox(): Promise<ServiceWorkerSandbox> {
  const listeners: Record<string, ServiceWorkerListener[]> = {};
  const source = await readFile(
    resolve(process.cwd(), "static/__sw__.js"),
    "utf8",
  );
  const sandbox: ServiceWorkerSandbox = {
    __listeners: listeners,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
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

  it("wraps redirect responses with pod isolation headers", async () => {
    const sandbox = await loadServiceWorkerSandbox();
    const wrap = sandbox.withPodIsolationHeaders;
    if (!wrap) throw new Error("withPodIsolationHeaders was not loaded");

    const response = wrap(
      new Response(null, {
        status: 302,
        statusText: "Found",
        headers: { Location: "/signed-in" },
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/signed-in");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin",
    );
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      "credentialless",
    );
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin",
    );
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
});
