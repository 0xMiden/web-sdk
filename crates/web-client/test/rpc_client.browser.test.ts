// @ts-nocheck
import { test, expect, type Route } from "@playwright/test";

// Exercise the published WASM binding and its real gRPC-web transport without
// creating a WebClient, opening a store, or requiring a running Miden node.
// The fixture implements the GetLimits and SyncNullifiers wire contracts from
// miden-node-proto's rpc.proto and primitives.proto.
const rpcUrl = "http://localhost:8080";
const rpcRoutes = `${rpcUrl}/miden.node.v1.NodeService/*`;

function varint(value: number): Buffer {
  const bytes = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function fixed32Field(field: number, value: number): Buffer {
  const bytes = Buffer.alloc(5);
  bytes[0] = (field << 3) | 5;
  bytes.writeUInt32LE(value, 1);
  return bytes;
}

function readVarint(bytes: Buffer, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  while (cursor.offset < bytes.length) {
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  throw new Error("Truncated protobuf varint");
}

function fields(bytes: Buffer): Map<number, (Buffer | number)[]> {
  const result = new Map<number, (Buffer | number)[]>();
  const cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor);
    let value: Buffer | number;
    switch (tag & 7) {
      case 0:
        value = readVarint(bytes, cursor);
        break;
      case 2: {
        const length = readVarint(bytes, cursor);
        value = bytes.subarray(cursor.offset, cursor.offset + length);
        cursor.offset += length;
        break;
      }
      case 5:
        value = bytes.readUInt32LE(cursor.offset);
        cursor.offset += 4;
        break;
      default:
        throw new Error(`Unexpected protobuf wire type ${tag & 7}`);
    }
    const field = tag >>> 3;
    result.set(field, [...(result.get(field) ?? []), value]);
  }
  return result;
}

function syncRequest(body: Buffer) {
  expect(body[0]).toBe(0);
  expect(body.readUInt32BE(1)).toBe(body.length - 5);
  const request = fields(body.subarray(5));
  const range = fields(request.get(1)![0] as Buffer);
  const prefixes = (request.get(3) ?? []).flatMap((value) => {
    if (typeof value === "number") return [value];
    const result = [];
    const cursor = { offset: 0 };
    while (cursor.offset < value.length) {
      result.push(readVarint(value, cursor));
    }
    return result;
  });
  return {
    blockFrom: range.get(1)?.[0] ?? 0,
    blockTo: range.get(2)?.[0] ?? 0,
    prefixLength: request.get(2)?.[0] ?? 0,
    prefixes,
  };
}

const limits = Buffer.concat(
  [
    ["GetNotesById", "note_id"],
    ["SyncNullifiers", "nullifier_prefix"],
    ["SyncTransactions", "account_id"],
    ["SyncNotes", "note_tag"],
  ].map(([endpoint, parameter]) =>
    bytesField(
      1,
      Buffer.concat([
        bytesField(1, Buffer.from(endpoint)),
        bytesField(
          2,
          bytesField(
            1,
            Buffer.concat([
              bytesField(1, Buffer.from(parameter)),
              Buffer.from([0x10, 1]),
            ])
          )
        ),
      ])
    )
  )
);

function nullifierPage(prefix: number, blockNum: number): Buffer {
  const word = Buffer.alloc(32);
  word.writeBigUInt64LE(BigInt(blockNum), 0);
  word.writeBigUInt64LE(BigInt(prefix) << 48n, 24);
  return Buffer.concat([
    bytesField(
      1,
      Buffer.concat([fixed32Field(1, 12), fixed32Field(2, blockNum)])
    ),
    bytesField(
      2,
      Buffer.concat([
        bytesField(1, bytesField(1, word)),
        fixed32Field(2, blockNum),
      ])
    ),
  ]);
}

async function respond(route: Route, message: Buffer) {
  const frame = (body: Buffer, type = 0) => {
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(body.length, 1);
    return Buffer.concat([header, body]);
  };
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

test("syncNullifiers returns every prefix chunk and block page", async ({
  page,
}) => {
  await page.route(rpcRoutes, async (route) => {
    if (route.request().url().endsWith("/GetLimits")) {
      await respond(route, limits);
      return;
    }
    expect(route.request().url()).toMatch(/\/SyncNullifiers$/);
    const request = syncRequest(route.request().postDataBuffer()!);
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
    const updates = await rpc.syncNullifiers(new Uint16Array([1, 2]), 10, 12);
    return updates.map((update) => ({
      blockNum: update.blockNum(),
      word: Array.from(update.nullifier().toU64s(), String),
    }));
  });

  expect(result).toHaveLength(4);
  expect(result).toEqual(
    expect.arrayContaining([
      { blockNum: 11, word: ["11", "0", "0", "281474976710656"] },
      { blockNum: 12, word: ["12", "0", "0", "281474976710656"] },
      { blockNum: 11, word: ["11", "0", "0", "562949953421312"] },
      { blockNum: 12, word: ["12", "0", "0", "562949953421312"] },
    ])
  );
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
