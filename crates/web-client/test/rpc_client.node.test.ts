import { test as base, expect } from "@playwright/test";
import { createServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { loadNodeSdk } from "./test-setup";
import {
  frame,
  limits,
  nullifierPage,
  syncRequest,
  transactionAccount,
  transactionAccounts,
  transactionIds,
  transactionPage,
  transactionRequest,
} from "./rpc-client-fixture";

type RpcServer = {
  url: string;
  paths: string[];
  requests: ReturnType<typeof syncRequest>[];
  transactionRequests: ReturnType<typeof transactionRequest>[];
};

const test = base.extend<{ rpcServer: RpcServer }>({
  rpcServer: async ({}, use) => {
    const paths: string[] = [];
    const requests: RpcServer["requests"] = [];
    const transactionRequests: RpcServer["transactionRequests"] = [];
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
        } else if (path.endsWith("/SyncTransactions")) {
          const request = transactionRequest(Buffer.concat(chunks));
          transactionRequests.push(request);
          expect(request.accountIds).toHaveLength(1);
          const accountIndex = transactionAccounts.findIndex((account) =>
            transactionAccount(account).equals(request.accountIds[0])
          );
          expect(accountIndex).toBeGreaterThanOrEqual(0);
          if (request.blockFrom === 12) {
            response = transactionPage(12, [
              {
                accountId: transactionAccounts[accountIndex],
                finalState: (accountIndex + 1) as 1 | 2,
                blockNum: 12,
              },
            ]);
          } else {
            response = transactionPage(
              11,
              request.blockFrom === 10 && accountIndex === 0
                ? [
                    {
                      accountId: transactionAccounts[0],
                      finalState: 2,
                      blockNum: 10,
                    },
                  ]
                : []
            );
          }
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
      await use({
        url: `http://127.0.0.1:${port}`,
        paths,
        requests,
        transactionRequests,
      });
    } finally {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  },
});

test("syncTransactions collects every account chunk and advances past empty pages", async ({
  rpcServer,
}) => {
  const sdk = loadNodeSdk();
  const rpc = new sdk.RpcClient(new sdk.Endpoint(rpcServer.url));
  const records = await rpc.syncTransactions(
    10,
    12,
    [...transactionAccounts, ...transactionAccounts].map((id) =>
      sdk.AccountId.fromHex(id)
    )
  );
  expect(records).toHaveLength(3);
  expect(
    records.map((record) => ({
      id: record.id().toHex(),
      accountId: record.accountId().toString(),
      blockNum: record.blockNum(),
      isRpcRecord: record instanceof sdk.RpcTransactionRecord,
    }))
  ).toEqual(
    expect.arrayContaining([
      {
        id: transactionIds[1],
        accountId: transactionAccounts[0],
        blockNum: 10,
        isRpcRecord: true,
      },
      ...transactionAccounts.map((accountId, index) => ({
        id: transactionIds[index],
        accountId,
        blockNum: 12,
        isRpcRecord: true,
      })),
    ])
  );
  expect(rpcServer.transactionRequests).toHaveLength(4);
  expect(rpcServer.transactionRequests).toEqual(
    expect.arrayContaining(
      transactionAccounts.flatMap((accountId) => [
        {
          blockFrom: 10,
          blockTo: 12,
          accountIds: [transactionAccount(accountId)],
        },
        {
          blockFrom: 12,
          blockTo: 12,
          accountIds: [transactionAccount(accountId)],
        },
      ])
    )
  );
  expect(
    await rpc.syncTransactions(11, 11, [
      sdk.AccountId.fromHex(transactionAccounts[0]),
    ])
  ).toEqual([]);
});

test("syncTransactions handles empty accounts and rejects an inverted range without RPC", async ({
  rpcServer,
}) => {
  const sdk = loadNodeSdk();
  const rpc = new sdk.RpcClient(new sdk.Endpoint(rpcServer.url));
  expect(await rpc.syncTransactions(12, 12, [])).toEqual([]);
  for (const accounts of [
    [],
    [sdk.AccountId.fromHex(transactionAccounts[0])],
  ]) {
    await expect(rpc.syncTransactions(12, 10, accounts)).rejects.toThrow(
      /block_from.*block_to/
    );
  }
  expect(rpcServer.paths).toEqual([]);
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
