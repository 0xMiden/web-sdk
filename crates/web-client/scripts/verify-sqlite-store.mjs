// Smoke test of the SQLite store in a real browser, against the built bundles
// in dist/mt and dist/st.
//
// The SQLite store keeps its files in the origin private file system through
// synchronous access handles, which only exist in a dedicated worker of a
// browser, so no unit test can reach it. This script serves dist/mt with the
// cross-origin isolation headers the MT build needs, and checks that:
//
// 1. A mock client on the SQLite store, created in a dedicated worker with a
//    Rayon thread pool, mints and consumes a note.
// 2. The same store, reopened in the same worker and then in a new worker,
//    still has the account, its balance and its key: it signs another
//    transaction. A second store opens beside it in the same worker.
// 3. A second worker cannot open the store while the first one holds it.
// 4. The page itself cannot open the store.
// 5. A client on the default IndexedDB store still works in the MT build.
// 6. The ST build, which has no SQLite store, says so.
// 7. A store whose worker was killed while writing to it opens again.
// 8. Two clients of one worker share a store, and one outlives the other.
//
// Set MIDEN_SMOKE_BROWSER_CHANNEL (for example to "chrome") to drive an
// installed browser instead of Playwright's bundled Chromium.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// The MT bundle is served from the root and the ST bundle from /st/.
const distDir = path.resolve(scriptDir, "../dist/mt");
const stDistDir = path.resolve(scriptDir, "../dist/st");

const STORE_NAME = "sqlite_smoke_store";
const MINT_AMOUNT = 1000n;
// How long the worker of step 7 writes before it is killed.
const KILL_AFTER_MS = 300;

// The module the dedicated workers run, on the SDK bundle its `sdk` query
// parameter names. Each message names one step and gets one reply,
// `{ ok: true, result }` or `{ ok: false, error }`.
const workerSource = `
const sdk = await import(
  new URL(self.location.href).searchParams.get("sdk") ?? "/index.js"
);

let client;

async function open({ storeName, storeBackend, mockChain, noteTransport }) {
  client = await sdk.MockWasmWebClient.createClient(
    mockChain,
    noteTransport,
    undefined,
    undefined,
    storeName,
    storeBackend
  );
}

async function mintAndConsume(accountId, faucetId, amount) {
  const mintRequest = await client.newMintTransactionRequest(
    accountId,
    faucetId,
    sdk.NoteType.Public,
    amount
  );
  const mintId = await client.submitNewTransaction(faucetId, mintRequest);
  await client.proveBlock();
  await client.syncState();

  const [mint] = await client.getTransactions(
    sdk.TransactionFilter.ids([mintId])
  );
  const noteId = mint.outputNotes().notes()[0].id().toString();
  const note = (await client.getInputNote(noteId)).toNote();
  const consumeRequest = await client.newConsumeTransactionRequest(
    [note],
    accountId
  );
  await client.submitNewTransaction(accountId, consumeRequest);
  await client.proveBlock();
  await client.syncState();
}

async function balance(accountId, faucetId) {
  const account = await client.getAccount(accountId);
  return account.vault().getBalance(faucetId).toString();
}

async function chain() {
  return {
    mockChain: await client.serializeMockChain(),
    noteTransport: await client.serializeMockNoteTransportNode(),
  };
}

const steps = {
  async initThreadPool({ threads }) {
    await sdk.MidenClient.ready();
    await sdk.initThreadPool(threads);
    return { threads: sdk.rayonThreadCount() };
  },

  // Creates an account and a faucet on a new store, then mints to the account.
  async create({ storeName, storeBackend, amount }) {
    await open({ storeName, storeBackend });
    await client.syncState();
    const account = await client.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.Falcon
    );
    const faucet = await client.newFaucet(
      sdk.AccountStorageMode.private(),
      false,
      "DAG",
      "DAG",
      8,
      10000000n,
      sdk.AuthScheme.Falcon
    );
    await mintAndConsume(account.id(), faucet.id(), amount);
    return {
      accountId: account.id().toString(),
      faucetId: faucet.id().toString(),
      balance: await balance(account.id(), faucet.id()),
      accounts: (await client.getAccounts()).length,
      useWorker: client.useWorker,
      storeIdentifier: await client.storeIdentifier(),
      ...(await chain()),
    };
  },

  // Opens a store that already holds the account and the faucet, reads the
  // balance, then mints to the account again, which needs the stored keys.
  async reopen({ storeName, storeBackend, mockChain, noteTransport, accountId, faucetId, amount }) {
    await open({ storeName, storeBackend, mockChain, noteTransport });
    const account = sdk.AccountId.fromHex(accountId);
    const faucet = sdk.AccountId.fromHex(faucetId);
    const accounts = (await client.getAccounts()).length;
    const balanceBefore = await balance(account, faucet);
    await client.syncState();
    await mintAndConsume(
      sdk.AccountId.fromHex(accountId),
      sdk.AccountId.fromHex(faucetId),
      amount
    );
    return {
      accounts,
      balanceBefore,
      balanceAfter: await balance(
        sdk.AccountId.fromHex(accountId),
        sdk.AccountId.fromHex(faucetId)
      ),
      ...(await chain()),
    };
  },

  // Opens a store and creates an account, without proving anything.
  async openOnly({ storeName, storeBackend }) {
    await open({ storeName, storeBackend });
    await client.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.Falcon
    );
    return {
      accounts: (await client.getAccounts()).length,
      useWorker: client.useWorker,
    };
  },

  // Opens two clients on one store, and has each read what the other wrote.
  async shareStore({ storeName }) {
    const newWallet = (c) =>
      c.newWallet(sdk.AccountStorageMode.private(), sdk.AuthScheme.Falcon);
    const first = await sdk.MockWasmWebClient.createClient(
      undefined,
      undefined,
      undefined,
      undefined,
      storeName,
      "sqlite"
    );
    await newWallet(first);
    const second = await sdk.MockWasmWebClient.createClient(
      await first.serializeMockChain(),
      await first.serializeMockNoteTransportNode(),
      undefined,
      undefined,
      storeName,
      "sqlite"
    );
    const seenBySecond = (await second.getAccounts()).length;
    await newWallet(second);
    const seenByFirst = (await first.getAccounts()).length;
    first.terminate();
    await newWallet(second);
    const afterTerminate = (await second.getAccounts()).length;
    second.terminate();
    return { seenBySecond, seenByFirst, afterTerminate };
  },

  // Creates accounts on the open store until the worker is terminated.
  async churn() {
    for (;;) {
      await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.Falcon
      );
    }
  },

  async terminate() {
    client?.terminate();
    client = undefined;
    return {};
  },
};

self.onmessage = async ({ data }) => {
  try {
    const result = await steps[data.step](data);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: String(error?.message ?? error),
    });
  }
};
self.postMessage({ ok: true, result: "loaded" });
`;

const contentTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json"],
  [".wasm", "application/wasm"],
]);

const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><meta charset=utf-8><title>SQLite store smoke</title>"
      );
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/sqlite-smoke-worker.js") {
      response.setHeader("Content-Type", contentTypes.get(".js"));
      response.end(workerSource);
      return;
    }

    const requestPath = decodeURIComponent(url.pathname);
    const [rootDir, relativePath] = requestPath.startsWith("/st/")
      ? [stDistDir, requestPath.slice("/st/".length)]
      : [distDir, requestPath.replace(/^\/+/, "")];
    const filePath = path.resolve(rootDir, relativePath);
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404).end();
      return;
    }

    response.setHeader(
      "Content-Type",
      contentTypes.get(path.extname(filePath)) ?? "application/octet-stream"
    );
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Failed to resolve SQLite smoke-test server address");
}

function check(condition, message) {
  if (!condition) {
    throw new Error(`SQLite store smoke failed: ${message}`);
  }
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.MIDEN_SMOKE_BROWSER_CHANNEL || undefined,
  });
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      const { url } = message.location();
      console.error(`[browser] ${message.text()}${url ? ` (${url})` : ""}`);
    }
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);

  // Runs in the page. `workers` maps a name to a dedicated worker and
  // `step` sends one message to it and resolves with its reply.
  await page.evaluate(() => {
    const workers = new Map();
    const reply = (worker) =>
      new Promise((resolve) => {
        worker.addEventListener("message", (event) => resolve(event.data), {
          once: true,
        });
        worker.addEventListener(
          "error",
          (event) =>
            resolve({ ok: false, error: `worker error: ${event.message}` }),
          { once: true }
        );
      });
    globalThis.smoke = {
      async start(name, sdkUrl) {
        const worker = new Worker(
          `/sqlite-smoke-worker.js?sdk=${encodeURIComponent(sdkUrl)}`,
          { type: "module" }
        );
        workers.set(name, worker);
        return reply(worker);
      },
      async step(name, message) {
        const worker = workers.get(name);
        const answered = reply(worker);
        worker.postMessage(message);
        return answered;
      },
      // Sends a message without waiting for a reply.
      post(name, message) {
        workers.get(name).postMessage(message);
      },
      stop(name) {
        workers.get(name).terminate();
        workers.delete(name);
      },
    };
  });

  const start = (name, sdkUrl = "/index.js") =>
    page.evaluate(([n, u]) => globalThis.smoke.start(n, u), [name, sdkUrl]);
  const stop = (name) => page.evaluate((n) => globalThis.smoke.stop(n), name);
  const step = async (name, message) => {
    const answer = await page.evaluate(
      ([n, m]) => globalThis.smoke.step(n, m),
      [name, message]
    );
    return answer;
  };
  const mustStep = async (name, message) => {
    const answer = await step(name, message);
    check(answer.ok, `${name} failed at "${message.step}": ${answer.error}`);
    return answer.result;
  };

  check(
    await page.evaluate(() => globalThis.crossOriginIsolated),
    "the page is not cross-origin isolated"
  );

  // 1. Create, mint and consume on the SQLite store, with a thread pool.
  check((await start("first")).ok, "the first worker did not load");
  const pool = await mustStep("first", { step: "initThreadPool", threads: 2 });
  check(pool.threads === 2, `expected two Rayon threads, got ${pool.threads}`);

  const created = await mustStep("first", {
    step: "create",
    storeName: STORE_NAME,
    storeBackend: "sqlite",
    amount: MINT_AMOUNT,
  });
  check(
    created.balance === String(MINT_AMOUNT),
    `expected a balance of ${MINT_AMOUNT} after the first mint, got ${created.balance}`
  );
  check(created.accounts === 2, `expected 2 accounts, got ${created.accounts}`);
  check(
    created.useWorker === false,
    "the SQLite store did not turn the worker shim off"
  );
  check(
    created.storeIdentifier === `/${STORE_NAME}.sqlite3`,
    `unexpected store identifier: ${created.storeIdentifier}`
  );

  // 3. A second worker cannot open the store while the first one holds it.
  check((await start("second")).ok, "the second worker did not load");
  const contended = await step("second", {
    step: "openOnly",
    storeName: STORE_NAME,
    storeBackend: "sqlite",
  });
  check(
    !contended.ok,
    "a second worker opened the SQLite store while the first one held it"
  );
  check(
    /Failed to open the SQLite store/.test(contended.error),
    `unexpected error from the second worker: ${contended.error}`
  );
  await stop("second");

  // 2a. Reopen in the same worker.
  await mustStep("first", { step: "terminate" });
  const reopened = await mustStep("first", {
    step: "reopen",
    storeName: STORE_NAME,
    storeBackend: "sqlite",
    mockChain: created.mockChain,
    noteTransport: created.noteTransport,
    accountId: created.accountId,
    faucetId: created.faucetId,
    amount: MINT_AMOUNT,
  });
  check(
    reopened.accounts === 2,
    `expected 2 accounts after reopening, got ${reopened.accounts}`
  );
  check(
    reopened.balanceBefore === String(MINT_AMOUNT),
    `expected the balance ${MINT_AMOUNT} to persist, got ${reopened.balanceBefore}`
  );
  check(
    reopened.balanceAfter === String(MINT_AMOUNT * 2n),
    `expected a balance of ${MINT_AMOUNT * 2n} after the second mint, got ${reopened.balanceAfter}`
  );

  // 2b. Reopen in a new worker, after the first one is gone.
  await stop("first");
  check((await start("third")).ok, "the third worker did not load");
  const reopenedAgain = await mustStep("third", {
    step: "reopen",
    storeName: STORE_NAME,
    storeBackend: "sqlite",
    mockChain: reopened.mockChain,
    noteTransport: reopened.noteTransport,
    accountId: created.accountId,
    faucetId: created.faucetId,
    amount: MINT_AMOUNT,
  });
  check(
    reopenedAgain.balanceBefore === String(MINT_AMOUNT * 2n),
    `expected the balance ${MINT_AMOUNT * 2n} to persist across workers, got ${reopenedAgain.balanceBefore}`
  );
  check(
    reopenedAgain.balanceAfter === String(MINT_AMOUNT * 3n),
    `expected a balance of ${MINT_AMOUNT * 3n} after the third mint, got ${reopenedAgain.balanceAfter}`
  );

  // A second SQLite store opens in the worker that already holds the first.
  const secondStore = await mustStep("third", {
    step: "openOnly",
    storeName: `${STORE_NAME}_second`,
    storeBackend: "sqlite",
  });
  check(
    secondStore.accounts === 1,
    `expected 1 account on the second SQLite store, got ${secondStore.accounts}`
  );
  await stop("third");

  // 4. The page itself cannot open the store.
  const onPage = await page.evaluate(async (storeName) => {
    const sdk = await import("./index.js");
    try {
      await sdk.MockWasmWebClient.createClient(
        undefined,
        undefined,
        undefined,
        undefined,
        storeName,
        "sqlite"
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }, `${STORE_NAME}_page`);
  check(!onPage.ok, "the page opened the SQLite store outside a worker");
  check(
    /dedicated Web Worker/.test(onPage.error),
    `unexpected error from the page: ${onPage.error}`
  );

  // 5. The default IndexedDB store still works in the MT build.
  check((await start("indexeddb")).ok, "the IndexedDB worker did not load");
  const indexedDb = await mustStep("indexeddb", {
    step: "openOnly",
    storeName: `${STORE_NAME}_indexeddb`,
  });
  check(
    indexedDb.accounts === 1,
    `expected 1 account on the IndexedDB store, got ${indexedDb.accounts}`
  );
  check(
    indexedDb.useWorker === true,
    "the IndexedDB store did not keep the worker shim"
  );
  await stop("indexeddb");

  // 6. The ST build has no SQLite store, and says so.
  check(
    (await start("st", "/st/index.js")).ok,
    "the worker on the ST build did not load"
  );
  const onSt = await step("st", {
    step: "openOnly",
    storeName: `${STORE_NAME}_st`,
    storeBackend: "sqlite",
  });
  check(!onSt.ok, "the ST build opened a SQLite store");
  check(
    /no SQLite store/.test(onSt.error),
    `unexpected error from the ST build: ${onSt.error}`
  );
  await stop("st");

  // 7. A worker killed while it writes leaves a store that opens again.
  const killedStore = `${STORE_NAME}_killed`;
  check((await start("killed")).ok, "the worker to kill did not load");
  await mustStep("killed", {
    step: "openOnly",
    storeName: killedStore,
    storeBackend: "sqlite",
  });
  await page.evaluate(
    (n) => globalThis.smoke.post(n, { step: "churn" }),
    "killed"
  );
  await page.waitForTimeout(KILL_AFTER_MS);
  await stop("killed");

  check((await start("survivor")).ok, "the worker after the kill did not load");
  const survived = await mustStep("survivor", {
    step: "openOnly",
    storeName: killedStore,
    storeBackend: "sqlite",
  });
  check(
    survived.accounts >= 2,
    `expected the accounts written before the kill to survive it, got ${survived.accounts}`
  );
  await stop("survivor");

  // 8. Two clients of one worker share a store.
  check(
    (await start("shared")).ok,
    "the worker for the shared store did not load"
  );
  const shared = await mustStep("shared", {
    step: "shareStore",
    storeName: `${STORE_NAME}_shared`,
  });
  check(
    shared.seenBySecond === 1 &&
      shared.seenByFirst === 2 &&
      shared.afterTerminate === 3,
    `two clients on one store did not see each other's accounts: ${JSON.stringify(shared)}`
  );
  await stop("shared");

  console.log(
    `SQLite store smoke passed: balance ${reopenedAgain.balanceAfter} after ` +
      `three mints across two workers; second worker refused with ` +
      `"${contended.error}"; page refused with "${onPage.error}"`
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
