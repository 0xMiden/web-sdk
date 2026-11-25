import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as feeFunder from "../../test/fee-funder";

function lockDirFor(fundersDir) {
  const dirHash = crypto
    .createHash("sha256")
    .update(fundersDir)
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), "miden-web-sdk-funder-locks", dirHash);
}

describe("fee-funder worker locking", () => {
  const createdDirs = [];
  const originalEnvDir = process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof feeFunder.releaseWorkerFunderLock === "function") {
      feeFunder.releaseWorkerFunderLock();
    }
    if (originalEnvDir === undefined) {
      delete process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR;
    } else {
      process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR = originalEnvDir;
    }
    while (createdDirs.length > 0) {
      fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
    }
  });

  function setupTempFunders(count) {
    const fundersDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miden-fee-funder-test-")
    );
    const lockDir = lockDirFor(fundersDir);
    createdDirs.push(fundersDir, lockDir);
    const macFiles = [];
    for (let i = 0; i < count; i++) {
      const macPath = path.join(
        fundersDir,
        `wallet_${String(i).padStart(4, "0")}.mac`
      );
      fs.writeFileSync(macPath, Buffer.from([i + 1, i + 2, i + 3]));
      macFiles.push(macPath);
    }
    fs.mkdirSync(lockDir, { recursive: true });
    process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR = fundersDir;
    return { fundersDir, lockDir, macFiles };
  }

  it("does not evict a fresh empty or unparsable lockfile during contention", () => {
    const { lockDir, macFiles } = setupTempFunders(2);
    const firstIdx = process.pid % macFiles.length;
    const secondIdx = (firstIdx + 1) % macFiles.length;
    const contendedLock = path.join(
      lockDir,
      `${path.basename(macFiles[firstIdx])}.lock`
    );
    fs.writeFileSync(contendedLock, "");

    const claimed = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(claimed?.path).toBe(macFiles[secondIdx]);
    expect(fs.readFileSync(contendedLock, "utf8")).toBe("");
  });

  it("evicts a dead-PID stale lockfile through .reap and cleans up .reap", () => {
    const { lockDir, macFiles } = setupTempFunders(2);
    const firstIdx = process.pid % macFiles.length;
    const secondIdx = (firstIdx + 1) % macFiles.length;
    const staleLock = path.join(
      lockDir,
      `${path.basename(macFiles[firstIdx])}.lock`
    );
    const liveLock = path.join(
      lockDir,
      `${path.basename(macFiles[secondIdx])}.lock`
    );
    fs.writeFileSync(staleLock, "999999999:dead-worker\n");
    fs.writeFileSync(liveLock, `${process.pid}:other-live-claim\n`);

    const claimed = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(claimed?.path).toBe(macFiles[firstIdx]);
    expect(fs.existsSync(`${staleLock}.reap`)).toBe(false);
    const payload = fs.readFileSync(staleLock, "utf8").trim();
    expect(payload).toMatch(new RegExp(`^${process.pid}:.+`));
  });

  it("re-checks lock identity inside .reap and aborts unlink if rotated to a live owner", () => {
    const { lockDir, macFiles } = setupTempFunders(2);
    const firstIdx = process.pid % macFiles.length;
    const secondIdx = (firstIdx + 1) % macFiles.length;
    const rotatedLock = path.join(
      lockDir,
      `${path.basename(macFiles[firstIdx])}.lock`
    );
    fs.writeFileSync(rotatedLock, "999999999:dead-worker\n");

    const origMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation((target, opts) => {
      const res = origMkdirSync(target, opts);
      if (String(target) === `${rotatedLock}.reap`) {
        fs.writeFileSync(rotatedLock, `${process.pid}:winner-token\n`);
      }
      return res;
    });

    const claimed = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(claimed?.path).toBe(macFiles[secondIdx]);
    expect(fs.readFileSync(rotatedLock, "utf8")).toBe(
      `${process.pid}:winner-token\n`
    );
    expect(fs.existsSync(`${rotatedLock}.reap`)).toBe(false);
  });

  it("verifies pid:token ownership on cache reuse and releaseWorkerFunderLock", () => {
    const { lockDir } = setupTempFunders(3);
    const first = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(first).not.toBeNull();
    expect(feeFunder.claimFunderMacBytes("http://localhost:57291")).toBe(first);

    const firstLockPath = path.join(
      lockDir,
      `${path.basename(first.path)}.lock`
    );
    const otherOwner = `${process.pid}:displaced-token\n`;
    fs.writeFileSync(firstLockPath, otherOwner);

    feeFunder.releaseWorkerFunderLock();
    expect(fs.existsSync(firstLockPath)).toBe(true);
    expect(fs.readFileSync(firstLockPath, "utf8")).toBe(otherOwner);

    const second = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(second).not.toBeNull();
    const displacedLockPath = path.join(
      lockDir,
      `${path.basename(second.path)}.lock`
    );
    fs.writeFileSync(displacedLockPath, otherOwner);

    const reacquired = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(reacquired).not.toBeNull();
    expect(reacquired.path).not.toBe(second.path);
    expect(fs.readFileSync(displacedLockPath, "utf8")).toBe(otherOwner);

    const reacquiredLockPath = path.join(
      lockDir,
      `${path.basename(reacquired.path)}.lock`
    );
    feeFunder.releaseWorkerFunderLock();
    expect(fs.existsSync(reacquiredLockPath)).toBe(false);
  });
});

function createRuntimeSdkMock() {
  return {
    AccountFile: {
      deserialize: () => ({
        accountId: () => ({ toString: () => "0xfunder" }),
      }),
    },
    AccountId: { fromHex: (hex) => ({ toString: () => hex }) },
    FungibleAsset: class {},
    NoteAssets: class {},
    NoteAttachment: class {},
    NoteArray: class {
      constructor() {
        this.items = [];
      }
      push(n) {
        this.items.push(n);
      }
    },
    Note: {
      createP2IDNote: () => ({ id: () => ({ toString: () => "note_1" }) }),
    },
    NoteType: { Public: "Public" },
    TransactionId: { fromHex: (hex) => ({ toHex: () => hex }) },
    TransactionFilter: {
      ids: (ids) => ({ ids: ids.map((id) => id.toHex()) }),
    },
    TransactionRequestBuilder: class {
      withOwnOutputNotes() {
        return this;
      }
      build() {
        return {};
      }
    },
    TransactionProver: {
      newLocalProver: () => ({ local: true }),
      newRemoteProver: () => ({ remote: true }),
    },
  };
}

function createHealthyFunderClient() {
  return {
    importAccountFile: vi.fn(async () => {}),
    syncState: vi.fn(async () => {}),
    feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
    executeTransaction: vi.fn(async () => ({ kind: "exec" })),
    proveTransaction: vi.fn(async () => ({ proven: true })),
    submitProvenTransaction: vi.fn(async () => 1),
    applyTransaction: vi.fn(async () => ({
      executedTransaction: () => ({ id: () => ({ toHex: () => "0xtx_1" }) }),
    })),
    getTransactions: vi.fn(async (filter) =>
      (filter.ids ?? []).map((id) => ({
        id: () => ({ toHex: () => id }),
        transactionStatus: () => ({
          isCommitted: () => true,
          isDiscarded: () => false,
        }),
      }))
    ),
    terminate: vi.fn(async () => {}),
  };
}

describe("fee-funder runtime recovery and sharing", () => {
  const createdDirs = [];
  const originalEnvDir = process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR;
  const originalWindow = globalThis.window;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
    if (typeof feeFunder.releaseWorkerFunderLock === "function") {
      feeFunder.releaseWorkerFunderLock();
    }
    if (originalEnvDir === undefined) {
      delete process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR;
    } else {
      process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR = originalEnvDir;
    }
    while (createdDirs.length > 0) {
      fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
    }
  });

  function setupSingleFunder() {
    const fundersDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miden-fee-funder-rt-")
    );
    createdDirs.push(fundersDir, lockDirFor(fundersDir));
    fs.writeFileSync(
      path.join(fundersDir, "wallet_0000.mac"),
      Buffer.from([1])
    );
    process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR = fundersDir;
  }

  it("clears cached statePromise when createNodeFunderRuntime init fails and retries", async () => {
    setupSingleFunder();
    const healthyClient = createHealthyFunderClient();
    const createFunderClient = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient node rpc error"))
      .mockResolvedValueOnce(healthyClient);

    const runtime = feeFunder.createNodeFunderRuntime({
      sdk: createRuntimeSdkMock(),
      rpcUrl: "http://localhost:57291",
      feeFaucetId: "0xfee",
      createFunderClient,
    });

    await expect(runtime.sendFundingNotes(["0xaaa"])).rejects.toThrow(
      "transient node rpc error"
    );
    const res = await runtime.sendFundingNotes(["0xaaa"]);
    expect(res?.txId).toBe("0xtx_1");
    expect(createFunderClient).toHaveBeenCalledTimes(2);
  });

  it("clears cached funderStatePromise in browser helpers after init rejection and retries", async () => {
    setupSingleFunder();
    const healthyClient = createHealthyFunderClient();
    const createClient = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient browser rpc error"))
      .mockResolvedValueOnce(healthyClient);

    const fakeWindow = {
      ...createRuntimeSdkMock(),
      WasmWebClient: { createClient },
    };
    globalThis.window = fakeWindow;

    const fakePage = {
      exposeFunction: async (name, fn) => {
        fakeWindow[name] = fn;
      },
      evaluate: async (fn, arg) => await fn(arg),
    };
    await feeFunder.installBrowserFunderHelpers(fakePage, {
      rpcUrl: "http://localhost:57291",
      localTxProverUrl: "http://localhost:50051",
      feeFaucetId: "0xfee",
    });

    await expect(
      fakeWindow.helpers.sendFundingNotes(["0xaaa"])
    ).rejects.toThrow("transient browser rpc error");
    const res = await fakeWindow.helpers.sendFundingNotes(["0xaaa"]);
    expect(res?.txId).toBe("0xtx_1");
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("shares one worker-cached Node funder client across getSharedNodeFunderRuntime calls", async () => {
    setupSingleFunder();
    const healthyClient = createHealthyFunderClient();
    const createFunderClient = vi.fn(async () => healthyClient);
    const sdk = createRuntimeSdkMock();

    const makeTargetClient = () => ({
      feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee-shared" })),
      syncState: vi.fn(async () => {}),
      getInputNote: vi.fn(async () => ({ toNote: () => ({ id: "note_1" }) })),
      newConsumeTransactionRequest: vi.fn(async () => ({ kind: "consume" })),
      executeTransaction: vi.fn(async () => ({ kind: "consume-exec" })),
      proveTransaction: vi.fn(async () => ({ proven: true })),
      submitProvenTransaction: vi.fn(async () => 1),
      applyTransaction: vi.fn(async () => ({
        executedTransaction: () => ({
          id: () => ({ toHex: () => "0xtx_consume" }),
        }),
      })),
      getTransactions: vi.fn(async (filter) =>
        (filter.ids ?? []).map((id) => ({
          id: () => ({ toHex: () => id }),
          transactionStatus: () => ({
            isCommitted: () => true,
            isDiscarded: () => false,
          }),
        }))
      ),
    });

    const c1 = makeTargetClient();
    const c2 = makeTargetClient();

    expect(typeof feeFunder.getSharedNodeFunderRuntime).toBe("function");
    const r1 = feeFunder.getSharedNodeFunderRuntime({
      sdk,
      rpcUrl: "http://localhost:57291/shared-test",
      feeFaucetId: "0xfee-shared",
      createFunderClient,
      getDefaultClient: () => c1,
    });
    const r2 = feeFunder.getSharedNodeFunderRuntime({
      sdk,
      rpcUrl: "http://localhost:57291/shared-test",
      feeFaucetId: "0xfee-shared",
      createFunderClient,
      getDefaultClient: () => c2,
    });

    await r1.fundAccounts(["0xaaa"]);
    await r2.fundAccounts(["0xbbb"]);
    expect(createFunderClient).toHaveBeenCalledTimes(1);
    expect(healthyClient.importAccountFile).toHaveBeenCalledTimes(1);
    expect(c1.newConsumeTransactionRequest).toHaveBeenCalledTimes(1);
    expect(c2.newConsumeTransactionRequest).toHaveBeenCalledTimes(1);

    feeFunder.releaseWorkerFunderLock();
    expect(healthyClient.terminate).toHaveBeenCalledTimes(1);
  });

  it("defers funder lock claiming lazily via WeakSet-guarded exposeFunction and defaults local prover port", async () => {
    const fundersDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miden-fee-funder-lazy-")
    );
    const lockDir = lockDirFor(fundersDir);
    createdDirs.push(fundersDir, lockDir);
    fs.writeFileSync(
      path.join(fundersDir, "wallet_0000.mac"),
      Buffer.from([1])
    );
    process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR = fundersDir;

    expect(feeFunder.REMOTE_TX_PROVER_PORT).toBe(50051);
    expect(feeFunder.DEFAULT_LOCAL_TX_PROVER_URL).toBe(
      "http://localhost:50051"
    );

    const healthyClient = createHealthyFunderClient();
    const newRemoteProverSpy = vi.fn((url) => ({ remoteUrl: url }));
    const fakeWindow = {
      ...createRuntimeSdkMock(),
      TransactionProver: {
        newLocalProver: () => ({ local: true }),
        newRemoteProver: newRemoteProverSpy,
      },
      WasmWebClient: { createClient: vi.fn(async () => healthyClient) },
    };
    globalThis.window = fakeWindow;

    const exposeFunction = vi.fn(async (name, fn) => {
      fakeWindow[name] = fn;
    });
    const fakePage = {
      exposeFunction,
      evaluate: async (fn, arg) => await fn(arg),
    };

    await feeFunder.installBrowserFunderHelpers(fakePage, {
      rpcUrl: "http://localhost:57291",
      feeFaucetId: "0xfee",
    });

    expect(exposeFunction).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockDir)).toBe(false);

    await feeFunder.installBrowserFunderHelpers(fakePage, {
      rpcUrl: "http://localhost:57291",
      feeFaucetId: "0xfee",
    });
    expect(exposeFunction).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockDir)).toBe(false);

    const res = await fakeWindow.helpers.sendFundingNotes(["0xaaa"]);
    expect(res?.txId).toBe("0xtx_1");
    expect(fs.existsSync(path.join(lockDir, "wallet_0000.mac.lock"))).toBe(
      true
    );
    expect(newRemoteProverSpy).toHaveBeenCalledWith(
      "http://localhost:50051",
      BigInt(120_000)
    );
  });

  it("supports prover factories and clones serializable provers across browser and Node multi-target funding", async () => {
    setupSingleFunder();
    const healthyClient = createHealthyFunderClient();
    const createFunderClient = vi.fn(async () => healthyClient);
    const makeConsumingProver = (
      payload = "remote|http://localhost:50051"
    ) => ({
      payload,
      consumed: false,
      serialize() {
        if (this.consumed) throw new Error("null pointer passed to rust");
        return this.payload;
      },
    });
    const sdk = {
      ...createRuntimeSdkMock(),
      TransactionProver: {
        newLocalProver: () => makeConsumingProver("local"),
        newRemoteProver: (url) => makeConsumingProver(`remote|${url}`),
        deserialize: vi.fn((payload) => makeConsumingProver(payload)),
      },
    };

    const makeTargetClient = () => {
      let seq = 0;
      const committed = new Set();
      return {
        feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
        syncState: vi.fn(async () => {}),
        getInputNote: vi.fn(async (id) => ({ toNote: () => ({ id }) })),
        newConsumeTransactionRequest: vi.fn(async () => ({ kind: "consume" })),
        executeTransaction: vi.fn(async () => ({ kind: "exec" })),
        proveTransaction: vi.fn(async (_exec, prover) => {
          if (!prover || typeof prover === "function") {
            throw new Error("expected TransactionProver instance, not factory");
          }
          if (prover.consumed) {
            throw new Error("null pointer passed to rust");
          }
          prover.consumed = true;
          return { proven: true };
        }),
        submitProvenTransaction: vi.fn(async () => 1),
        applyTransaction: vi.fn(async () => {
          const txId = `0xtarget_${++seq}`;
          committed.add(txId);
          return {
            executedTransaction: () => ({ id: () => ({ toHex: () => txId }) }),
          };
        }),
        getTransactions: vi.fn(async (filter) =>
          (filter.ids ?? [])
            .filter((id) => committed.has(id))
            .map((id) => ({
              id: () => ({ toHex: () => id }),
              transactionStatus: () => ({
                isCommitted: () => true,
                isDiscarded: () => false,
              }),
            }))
        ),
      };
    };

    const nodeRuntime = feeFunder.createNodeFunderRuntime({
      sdk,
      rpcUrl: "http://localhost:57291/prover-node",
      feeFaucetId: "0xfee",
      createFunderClient,
    });

    const nodeTarget = makeTargetClient();
    const sharedNodeProver = makeConsumingProver("remote|http://prover");
    const nodeInstanceRes = await nodeRuntime.fundAccounts(
      ["0x1", "0x2"],
      nodeTarget,
      sharedNodeProver
    );
    expect(nodeInstanceRes?.noteIds).toHaveLength(2);
    expect(sharedNodeProver.consumed).toBe(false);

    const nodeFactory = vi.fn(() => makeConsumingProver("local"));
    const nodeFactoryRes = await nodeRuntime.fundAccounts(
      ["0x3", "0x4"],
      nodeTarget,
      nodeFactory
    );
    expect(nodeFactoryRes?.noteIds).toHaveLength(2);
    expect(nodeFactory).toHaveBeenCalledTimes(2);

    const fakeWindow = {
      ...sdk,
      WasmWebClient: { createClient: createFunderClient },
    };
    globalThis.window = fakeWindow;
    const fakePage = {
      exposeFunction: async (name, fn) => {
        fakeWindow[name] = fn;
      },
      evaluate: async (fn, arg) => await fn(arg),
    };
    await feeFunder.installBrowserFunderHelpers(fakePage, {
      rpcUrl: "http://localhost:57291/prover-browser",
      localTxProverUrl: "http://localhost:50051",
      feeFaucetId: "0xfee",
    });

    const browserTarget = makeTargetClient();
    const sharedBrowserProver = makeConsumingProver("remote|http://prover");
    const browserInstanceRes = await fakeWindow.helpers.fundAccounts(
      ["0x5", "0x6"],
      browserTarget,
      sharedBrowserProver
    );
    expect(browserInstanceRes?.noteIds).toHaveLength(2);
    expect(sharedBrowserProver.consumed).toBe(false);

    const browserFactory = vi.fn(() =>
      makeConsumingProver("remote|http://prover")
    );
    const browserFactoryRes = await fakeWindow.helpers.fundAccounts(
      ["0x7", "0x8"],
      browserTarget,
      browserFactory
    );
    expect(browserFactoryRes?.noteIds).toHaveLength(2);
    expect(browserFactory).toHaveBeenCalledTimes(2);
  });
});
