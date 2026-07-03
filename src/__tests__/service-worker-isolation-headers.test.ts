import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface ServiceWorkerSandbox extends Record<string, unknown> {
  addPodIsolationHeaders?: (
    headers: Headers | Record<string, string>,
  ) => Headers | Record<string, string>;
  withPodIsolationHeaders?: (response: Response) => Response;
}

async function loadServiceWorkerSandbox(): Promise<ServiceWorkerSandbox> {
  const source = await readFile(
    resolve(process.cwd(), "static/__sw__.js"),
    "utf8",
  );
  const sandbox: ServiceWorkerSandbox = {
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
      addEventListener: () => {},
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
});
