// @ts-nocheck
import { test, expect, type Route } from "@playwright/test";
import {
  frame,
  limits,
  nullifierPage,
  syncRequest,
} from "./rpc-client-fixture";

// Exercise the published WASM binding and its real gRPC-web transport without
// creating a WebClient, opening a store, or requiring a running Miden node.
// The fixture implements the GetLimits and SyncNullifiers wire contracts from
// miden-node-proto's rpc.proto and primitives.proto.
const rpcUrl = "http://localhost:8080";
const rpcRoutes = `${rpcUrl}/miden.node.v1.NodeService/*`;

async function respond(route: Route, message: Buffer) {
  await route.fulfill({
    status: 200,
    contentType: "application/grpc-web+proto",
    body: Buffer.concat([
      frame(message),
      frame(Buffer.from("grpc-status: 0\r\n"), 0x80),
    ]),
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto(rpcUrl);
});

test("syncNullifiers scans each unique prefix across every block page", async ({
  page,
}) => {
  const syncRequests: ReturnType<typeof syncRequest>[] = [];
  await page.route(rpcRoutes, async (route) => {
    if (route.request().url().endsWith("/GetLimits")) {
      await respond(route, limits);
      return;
    }
    expect(route.request().url()).toMatch(/\/SyncNullifiers$/);
    const request = syncRequest(route.request().postDataBuffer()!);
    syncRequests.push(request);
    expect(request.prefixLength).toBe(16);
    expect(request.prefixes).toHaveLength(1);
    expect([1, 2]).toContain(request.prefixes[0]);
    expect([10, 12]).toContain(request.blockFrom);
    expect(request.blockTo).toBe(12);
    await respond(
      route,
      nullifierPage(request.prefixes[0], request.blockFrom === 10 ? 11 : 12)
    );
  });

  const result = await page.evaluate(async () => {
    const sdk = await import("./index.js");
    await sdk.MidenClient.ready();
    const rpc = new sdk.RpcClient(new sdk.Endpoint(location.origin));
    const prefixes = new Uint16Array([2, 1, 2, 1]);
    const updates = await rpc.syncNullifiers(prefixes, 10, 12);
    return {
      prefixes: Array.from(prefixes),
      updates: updates.map((update) => ({
        blockNum: update.blockNum(),
        word: Array.from(update.nullifier().toU64s(), String),
      })),
    };
  });

  expect(result.prefixes).toEqual([2, 1, 2, 1]);
  expect(result.updates).toHaveLength(4);
  expect(result.updates).toEqual(
    expect.arrayContaining([
      { blockNum: 11, word: ["11", "0", "0", "281474976710656"] },
      { blockNum: 12, word: ["12", "0", "0", "281474976710656"] },
      { blockNum: 11, word: ["11", "0", "0", "562949953421312"] },
      { blockNum: 12, word: ["12", "0", "0", "562949953421312"] },
    ])
  );
  expect(syncRequests).toHaveLength(4);
});

test("syncNullifiers handles empty prefixes and rejects an inverted range before RPC", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route(rpcRoutes, async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });

  const result = await page.evaluate(async () => {
    const sdk = await import("./index.js");
    await sdk.MidenClient.ready();
    const rpc = new sdk.RpcClient(new sdk.Endpoint(location.origin));
    const empty = await rpc.syncNullifiers(new Uint16Array(), 10, 12);
    let error;
    try {
      await rpc.syncNullifiers(new Uint16Array([1]), 12, 10);
    } catch (cause) {
      error = String(cause);
    }
    return { empty, error };
  });

  expect(result.empty).toEqual([]);
  expect(result.error).toMatch(/block.*from.*block.*to/i);
  expect(requests).toEqual([]);
});

test("syncNullifiers rejects a node response for an unrequested prefix", async ({
  page,
}) => {
  await page.route(rpcRoutes, async (route) => {
    await respond(
      route,
      route.request().url().endsWith("/GetLimits")
        ? limits
        : nullifierPage(2, 12)
    );
  });

  const error = await page.evaluate(async () => {
    const sdk = await import("./index.js");
    await sdk.MidenClient.ready();
    const rpc = new sdk.RpcClient(new sdk.Endpoint(location.origin));
    try {
      await rpc.syncNullifiers(new Uint16Array([1]), 12, 12);
    } catch (cause) {
      return String(cause);
    }
  });

  expect(error).toContain("failed to sync nullifiers");
  expect(error).toContain("prefix 2");
});

test("serialized submission artifacts reject malformed and incomplete protobuf payloads", async ({
  page,
}) => {
  const artifacts = [
    { name: "TransactionInputs", label: "transaction inputs" },
    { name: "ProposedBatch", label: "proposed batch" },
    { name: "ProvenBatch", label: "proven batch" },
  ];
  const results = await page.evaluate(async (artifacts) => {
    const sdk = await import("./index.js");
    await sdk.MidenClient.ready();
    return artifacts.flatMap(({ name, label }) =>
      [
        // An empty Protobuf message decodes, but lacks required domain data.
        { bytes: [], context: `invalid ${label}` },
        // A length-delimited field claims one byte, but contains none.
        { bytes: [0x0a, 0x01], context: `failed to decode ${label}` },
      ].map(({ bytes, context }) => {
        try {
          sdk[name].deserialize(new Uint8Array(bytes));
          return { name, context, error: null };
        } catch (cause) {
          return { name, context, error: String(cause) };
        }
      })
    );
  }, artifacts);

  for (const { name, context, error } of results) {
    expect(error, `${name}: ${context}`).toContain(context);
  }
});
