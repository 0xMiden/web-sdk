import { test as base, expect } from "@playwright/test";
import { createServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { loadNodeSdk } from "./test-setup";
import {
  frame,
  limits,
  nullifierPage,
  syncRequest,
} from "./rpc-client-fixture";

type RpcServer = {
  url: string;
  paths: string[];
  requests: ReturnType<typeof syncRequest>[];
};

const test = base.extend<{ rpcServer: RpcServer }>({
  rpcServer: async ({}, use) => {
    const paths: string[] = [];
    const requests: RpcServer["requests"] = [];
    const sessions = new Set<ServerHttp2Session>();
    const server = createServer();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    server.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const path = String(headers[":path"]);
        paths.push(path);
        let response = limits;
        if (path.endsWith("/SyncNullifiers")) {
          const request = syncRequest(Buffer.concat(chunks));
          requests.push(request);
          response = nullifierPage(request.prefixes[0], 12);
        } else {
          expect(path).toMatch(/\/GetLimits$/);
        }
        stream.respond(
          { ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true }
        );
        stream.on("wantTrailers", () =>
          stream.sendTrailers({ "grpc-status": "0" })
        );
        stream.end(frame(response));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const { port } = server.address() as AddressInfo;
      await use({ url: `http://127.0.0.1:${port}`, paths, requests });
    } finally {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  },
});

test("syncNullifiers snapshots an offset Uint16Array before returning its Promise", async ({
  rpcServer,
}) => {
  const sdk = loadNodeSdk();
  const rpc = new sdk.RpcClient(new sdk.Endpoint(rpcServer.url));
  for (let attempt = 0; attempt < 32; attempt++) {
    const backing = new Uint16Array([0xffff, 1, 0xffff]);
    const prefixes = backing.subarray(1, 2);
    const pending = rpc.syncNullifiers(prefixes, 12, 12);
    prefixes[0] = 2;
    await pending;
  }
  expect(rpcServer.requests).toHaveLength(32);
  expect(
    rpcServer.requests.map((request) => request.prefixes),
    "syncNullifiers must snapshot prefixes before returning its Promise"
  ).toEqual(Array.from({ length: 32 }, () => [1]));
});

test("syncNullifiers handles empty prefixes and rejects invalid native inputs without RPC", async ({
  rpcServer,
}) => {
  const sdk = loadNodeSdk();
  const rpc = new sdk.RpcClient(new sdk.Endpoint(rpcServer.url));
  expect(await rpc.syncNullifiers(new Uint16Array(), 12, 12)).toEqual([]);
  await expect(
    rpc.syncNullifiers(new Uint16Array([1]), 12, 10)
  ).rejects.toThrow(/block_from.*block_to/);
  for (const prefixes of [
    new Uint8Array([1]),
    new Uint16Array(new SharedArrayBuffer(2)),
  ]) {
    // NAPI argument conversion can throw synchronously before creating a Promise.
    await expect(async () =>
      rpc.syncNullifiers(prefixes, 12, 12)
    ).rejects.toThrow(/Expected|ArrayBuffer/);
  }
  expect(rpcServer.paths).toEqual([]);
});
