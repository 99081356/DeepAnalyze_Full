import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Shared mock objects so we can assert against them after clearAllMocks()
const mockSettingsSet = vi.fn(async () => {});
const mockSettingsGet = vi.fn(async () => null);
const mockRepos = {
  settings: { get: mockSettingsGet, set: mockSettingsSet },
};

// Mock getRepos before importing HubClient (it's used inside methods)
vi.mock("../src/store/repos/index.js", () => ({
  getRepos: vi.fn(async () => mockRepos),
}));

import { HubClient } from "../src/services/hub/hub-client.js";

describe("HubClient extensions", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function makeClient(): HubClient {
    return new HubClient({
      runMode: "worker",
      serverUrl: "",
      workerId: "test-worker",
      workerToken: "",
    } as any);
  }

  test("connectToHub stores worker token and marks reachable", async () => {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      if (url.includes("/workers/register")) {
        return new Response(JSON.stringify({
          worker_id: "wkr_test",
          worker_token: "wkt_test",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    }) as any;

    const client = makeClient();
    const result = await client.connectToHub("http://hub:22000", "djt_xxx");

    expect(result.workerToken).toBe("wkt_test");
    expect(result.workerId).toBe("wkr_test");
    expect(client.isConnected()).toBe(true);

    // Verify settings.set was called with a JSON string containing the connection details
    expect(mockSettingsSet).toHaveBeenCalledTimes(1);
    const [key, value] = mockSettingsSet.mock.calls[0];
    expect(key).toBe("hub_connection");
    expect(typeof value).toBe("string");
    const parsed = JSON.parse(value as string);
    expect(parsed).toMatchObject({
      connected: true,
      hubUrl: "http://hub:22000",
      workerId: "wkr_test",
      workerToken: "wkt_test",
    });

    client.stopHeartbeat();
  });

  test("connectToHub throws on registration failure", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid join_token" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ) as any;

    const client = makeClient();
    await expect(client.connectToHub("http://hub:22000", "bad_token"))
      .rejects.toThrow("Hub registration failed: invalid join_token");
    expect(client.isConnected()).toBe(false);
  });

  test("disconnectFromHub clears config and marks unreachable", async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (url.includes("/deactivate")) {
        return new Response("", { status: 204 });
      }
      return new Response("", { status: 404 });
    }) as any;

    const client = makeClient();
    // Simulate connected state
    (client as any).config.serverUrl = "http://hub:22000";
    (client as any).config.workerToken = "wkt_test";
    (client as any).syncState.serverReachable = true;

    await client.disconnectFromHub();

    expect(client.isConnected()).toBe(false);

    expect(mockSettingsSet).toHaveBeenCalledWith(
      "hub_connection",
      JSON.stringify({ connected: false }),
    );
  });

  test("disconnectFromHub is safe when already disconnected", async () => {
    const client = makeClient();
    // Already disconnected (default state)
    await client.disconnectFromHub();
    expect(client.isConnected()).toBe(false);
  });

  test("fetchModelManifest returns null when not connected", async () => {
    const client = makeClient();
    const manifest = await client.fetchModelManifest("bge-m3");
    expect(manifest).toBeNull();
  });

  test("fetchModelManifest returns parsed JSON when connected", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ name: "bge-m3", size: 1024 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;

    const client = makeClient();
    (client as any).config.serverUrl = "http://hub:22000";
    (client as any).config.workerToken = "wkt_test";

    const manifest = await client.fetchModelManifest("bge-m3");
    expect(manifest).toEqual({ name: "bge-m3", size: 1024 });
  });

  test("fetchModelBlob returns null when not connected", async () => {
    const client = makeClient();
    const blob = await client.fetchModelBlob("abc123");
    expect(blob).toBeNull();
  });

  test("fetchModelBlob returns Buffer when connected", async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    globalThis.fetch = vi.fn(async () =>
      new Response(testData, { status: 200 }),
    ) as any;

    const client = makeClient();
    (client as any).config.serverUrl = "http://hub:22000";
    (client as any).config.workerToken = "wkt_test";

    const blob = await client.fetchModelBlob("abc123");
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob?.length).toBe(5);
  });
});
