import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerAction } from "../constants.js";
import { setObserver, __resetObserverForTest } from "../observability.js";

const fakeWasm = vi.hoisted(() => {
  class WebClient {
    constructor() {
      this.free = vi.fn();
      this.createClient = vi.fn(async () => {});
      this.createClientWithExternalKeystore = vi.fn(async () => {});
      this.createMockClient = vi.fn(async () => {});
      this.serializeMockChain = vi.fn(async () => new Uint8Array());
      this.serializeMockNoteTransportNode = vi.fn(async () => new Uint8Array());
    }
  }
  return {
    WebClient,
    resolveStoreName: (nodeUrl, storeName) =>
      storeName ?? `MidenClientDB_${nodeUrl}`,
    SyncSummary: { deserialize: (bytes) => ({ synced: true, bytes }) },
    TransactionResult: { deserialize: () => ({ id: () => "tx-id" }) },
    AuthScheme: Object.freeze({
      AuthEcdsaK256Keccak: 1,
      1: "AuthEcdsaK256Keccak",
      AuthRpoFalcon512: 2,
      2: "AuthRpoFalcon512",
    }),
  };
});

vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({
  default: async () => fakeWasm,
  resolveWasmUrl: async () => undefined,
}));

import { MidenClient } from "../client.js";
import {
  WasmWebClient,
  __createClientProxyForTest as createClientProxy,
} from "../index.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const settleState = (promise) =>
  Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", message: error.message })
    ),
    flush().then(() => ({ status: "pending" })),
  ]);

/**
 * Simulates committed store state and tracks uncommitted staged updates so
 * tests can verify that local reads return consistent committed snapshots
 * during in-flight sync/proving operations and see newly committed state once
 * sync finishes.
 */
function makeStatefulWasmClient() {
  let committed = {
    syncHeight: 1,
    balance: 100n,
    accounts: ["acct-v1"],
    inputNotes: ["in-note-v1"],
    outputNotes: ["out-note-v1"],
    transactions: ["tx-v1"],
    tags: ["tag-v1"],
    settingValue: new Uint8Array([1]),
    pswapLineages: ["lineage-v1"],
    feeFaucetId: "0xfeefaucet1",
    protocolConfig: { epoch: 1 },
  };

  class FakeWasmClient {
    constructor() {
      this.free = vi.fn();
      this.endpoint = vi.fn(() => "https://rpc.testnet.miden.io");
      this.lastAuthError = vi.fn(() => null);
      this.syncStateImpl = vi.fn(async () => "synced");
      this.proveTransaction = vi.fn(async () => "proved");
      this.submitNewTransaction = vi.fn(async () => ({
        id: () => "tx-submitted",
      }));
      this.executeProgram = vi.fn(async () => "program-out");
      this.getConsumableNotes = vi.fn(async () => ["consumable-1"]);
      this.newWallet = vi.fn(async () => "wallet-new");
      this.setSetting = vi.fn(async () => {});
      this.importNoteFile = vi.fn(async () => "note-imported");
      this.fetchPrivateNotes = vi.fn(async () => {});
    }
    storeIdentifier() {
      return Promise.resolve("test-store-db");
    }
    getSyncHeight() {
      return Promise.resolve(committed.syncHeight);
    }
    getAccounts() {
      return Promise.resolve([...committed.accounts]);
    }
    getAccount(id) {
      return Promise.resolve({
        id,
        syncHeight: committed.syncHeight,
        balance: committed.balance,
      });
    }
    getAccountVault() {
      return Promise.resolve({ balance: committed.balance });
    }
    getAccountStorage() {
      return Promise.resolve({ height: committed.syncHeight });
    }
    getAccountCode() {
      return Promise.resolve({ commitment: "0xcode" });
    }
    accountReader() {
      return Promise.resolve({
        getBalance: async () => committed.balance,
        nonce: async () => BigInt(committed.syncHeight),
        free: vi.fn(),
      });
    }
    getInputNotes() {
      return Promise.resolve([...committed.inputNotes]);
    }
    getInputNote(id) {
      return Promise.resolve({ id, height: committed.syncHeight });
    }
    getOutputNotes() {
      return Promise.resolve([...committed.outputNotes]);
    }
    getOutputNote(id) {
      return Promise.resolve({ id, height: committed.syncHeight });
    }
    getTransactions() {
      return Promise.resolve([...committed.transactions]);
    }
    listTags() {
      return Promise.resolve([...committed.tags]);
    }
    getSetting() {
      return Promise.resolve(committed.settingValue);
    }
    listSettingKeys() {
      return Promise.resolve(["k1"]);
    }
    getPswapLineages() {
      return Promise.resolve([...committed.pswapLineages]);
    }
    getPswapLineagesFor() {
      return Promise.resolve([...committed.pswapLineages]);
    }
    getPswapLineage() {
      return Promise.resolve(committed.pswapLineages[0]);
    }
    feeFaucetId() {
      return Promise.resolve(committed.feeFaucetId);
    }
    protocolConfig() {
      return Promise.resolve(committed.protocolConfig);
    }
    createCodeBuilder() {
      return Promise.resolve({ codeBuilder: true });
    }
    exportNoteFile() {
      return Promise.resolve({ noteFile: true });
    }
    exportAccountFile() {
      return Promise.resolve({ accountFile: true });
    }
    getAccountAuthByPubKeyCommitment() {
      return Promise.resolve({ auth: true });
    }
    getPublicKeyCommitmentsOfAccount() {
      return Promise.resolve(["0xpk"]);
    }
    getAccountByKeyCommitment() {
      return Promise.resolve(committed.accounts[0]);
    }
    trackedAccountWitnesses() {
      return Promise.resolve(["0xwitness"]);
    }
    syncBeforeAccountCreation() {
      return Promise.resolve();
    }
  }

  return {
    get committed() {
      return committed;
    },
    commitNextSyncState(next) {
      committed = { ...committed, ...next };
    },
    wasmClient: new FakeWasmClient(),
  };
}

function makeInstance({ useWorker = false } = {}) {
  const { wasmClient, commitNextSyncState } = makeStatefulWasmClient();
  const instance = new WasmWebClient(
    "https://rpc.testnet.miden.io",
    undefined,
    undefined,
    `concurrent-reads-${Math.random()}`,
    undefined,
    undefined,
    undefined,
    undefined,
    false
  );
  instance.wasmWebClient = wasmClient;
  instance.wasmWebClientPromise = Promise.resolve(wasmClient);

  let worker = null;
  if (useWorker) {
    worker = {
      posted: [],
      terminate: vi.fn(),
      postMessage: vi.fn((msg) => {
        worker.posted.push(msg);
      }),
    };
    instance.worker = worker;
    instance.pendingRequests = new Map();
    instance.ready = Promise.resolve();
    instance.readyRejecter = () => {};
    instance.resolvePendingRequest = (requestId, result) => {
      const entry = instance.pendingRequests.get(requestId);
      if (!entry) throw new Error(`Missing request ${requestId}`);
      instance.pendingRequests.delete(requestId);
      entry.resolve(result);
    };
  }

  const client = createClientProxy(instance);
  return { instance, client, wasmClient, worker, commitNextSyncState };
}

describe("concurrent local reads during in-flight sync and proving", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    __resetObserverForTest();
    vi.restoreAllMocks();
  });

  it("completes local reads while a worker-backed syncState is pending and observes committed state once sync finishes", async () => {
    const { instance, client, wasmClient, worker, commitNextSyncState } =
      makeInstance({ useWorker: true });

    const preSyncHeight = await client.getSyncHeight();
    const preAccount = await client.getAccount("acct-1");
    expect(preSyncHeight).toBe(1);
    expect(preAccount).toEqual({ id: "acct-1", syncHeight: 1, balance: 100n });

    // Start syncState and hold it pending inside the worker.
    const syncPromise = client.syncState();
    await vi.waitFor(() =>
      expect(
        worker.posted.filter((m) => m.action === WorkerAction.CALL_METHOD)
      ).toHaveLength(1)
    );
    const syncReq = worker.posted.find((m) => m.methodName === "syncState");
    expect(syncReq).toBeDefined();
    expect((await settleState(syncPromise)).status).toBe("pending");

    // Local reads complete promptly while syncState is in flight, seeing the
    // consistent committed pre-sync snapshot (v1).
    const [
      heightDuringSync,
      accountsDuringSync,
      accountDuringSync,
      vaultDuringSync,
      storageDuringSync,
      codeDuringSync,
      readerDuringSync,
      inputNotesDuringSync,
      inputNoteDuringSync,
      outputNotesDuringSync,
      outputNoteDuringSync,
      txsDuringSync,
      tagsDuringSync,
      settingDuringSync,
      settingKeysDuringSync,
      pswapDuringSync,
      pswapForDuringSync,
      pswapOneDuringSync,
      faucetDuringSync,
      protocolDuringSync,
      storeIdDuringSync,
      builderDuringSync,
      noteExportDuringSync,
      accountExportDuringSync,
      authKeyDuringSync,
      pkCommitmentsDuringSync,
      acctByKeyDuringSync,
      witnessesDuringSync,
    ] = await Promise.all([
      client.getSyncHeight(),
      client.getAccounts(),
      client.getAccount("acct-1"),
      client.getAccountVault("acct-1"),
      client.getAccountStorage("acct-1"),
      client.getAccountCode("acct-1"),
      client.accountReader("acct-1"),
      client.getInputNotes({}),
      client.getInputNote("in-1"),
      client.getOutputNotes({}),
      client.getOutputNote("out-1"),
      client.getTransactions({}),
      client.listTags(),
      client.getSetting("k1"),
      client.listSettingKeys(),
      client.getPswapLineages(),
      client.getPswapLineagesFor("acct-1"),
      client.getPswapLineage("1"),
      client.feeFaucetId(),
      client.protocolConfig(),
      client.storeIdentifier(),
      client.createCodeBuilder(),
      client.exportNoteFile("out-1", "Full"),
      client.exportAccountFile("acct-1"),
      client.getAccountAuthByPubKeyCommitment("0xpk"),
      client.getPublicKeyCommitmentsOfAccount("acct-1"),
      client.getAccountByKeyCommitment("0xpk"),
      client.trackedAccountWitnesses(),
    ]);

    expect(heightDuringSync).toBe(1);
    expect(accountsDuringSync).toEqual(["acct-v1"]);
    expect(accountDuringSync).toEqual({
      id: "acct-1",
      syncHeight: 1,
      balance: 100n,
    });
    expect(vaultDuringSync).toEqual({ balance: 100n });
    expect(storageDuringSync).toEqual({ height: 1 });
    expect(codeDuringSync).toEqual({ commitment: "0xcode" });
    expect(await readerDuringSync.getBalance()).toBe(100n);
    expect(inputNotesDuringSync).toEqual(["in-note-v1"]);
    expect(inputNoteDuringSync).toEqual({ id: "in-1", height: 1 });
    expect(outputNotesDuringSync).toEqual(["out-note-v1"]);
    expect(outputNoteDuringSync).toEqual({ id: "out-1", height: 1 });
    expect(txsDuringSync).toEqual(["tx-v1"]);
    expect(tagsDuringSync).toEqual(["tag-v1"]);
    expect(settingDuringSync).toEqual(new Uint8Array([1]));
    expect(settingKeysDuringSync).toEqual(["k1"]);
    expect(pswapDuringSync).toEqual(["lineage-v1"]);
    expect(pswapForDuringSync).toEqual(["lineage-v1"]);
    expect(pswapOneDuringSync).toBe("lineage-v1");
    expect(faucetDuringSync).toBe("0xfeefaucet1");
    expect(protocolDuringSync).toEqual({ epoch: 1 });
    expect(storeIdDuringSync).toBe("test-store-db");
    expect(builderDuringSync).toEqual({ codeBuilder: true });
    expect(noteExportDuringSync).toEqual({ noteFile: true });
    expect(accountExportDuringSync).toEqual({ accountFile: true });
    expect(authKeyDuringSync).toEqual({ auth: true });
    expect(pkCommitmentsDuringSync).toEqual(["0xpk"]);
    expect(acctByKeyDuringSync).toBe("acct-v1");
    expect(witnessesDuringSync).toEqual(["0xwitness"]);
    // Sync has still not settled yet!
    expect((await settleState(syncPromise)).status).toBe("pending");

    // Mutating / heavy serialized calls must still wait behind in-flight sync.
    const writeWhileSync = client.setSetting("k2", new Uint8Array([9]));
    const walletWhileSync = client.newWallet("private", "falcon");
    const consumableWhileSync = client.getConsumableNotes();
    expect(await settleState(writeWhileSync)).toEqual({ status: "pending" });
    expect(await settleState(walletWhileSync)).toEqual({ status: "pending" });
    expect(await settleState(consumableWhileSync)).toEqual({
      status: "pending",
    });
    expect(wasmClient.setSetting).not.toHaveBeenCalled();
    expect(wasmClient.newWallet).not.toHaveBeenCalled();
    expect(wasmClient.getConsumableNotes).not.toHaveBeenCalled();

    // Sync commits state changes to store and finishes.
    commitNextSyncState({
      syncHeight: 2,
      balance: 250n,
      accounts: ["acct-v1", "acct-v2"],
      inputNotes: ["in-note-v1", "in-note-v2"],
      outputNotes: ["out-note-v2"],
      transactions: ["tx-v1", "tx-v2"],
      protocolConfig: { epoch: 2 },
    });
    instance.resolvePendingRequest(syncReq.requestId, new Uint8Array([1, 2]));
    await syncPromise;

    // Queued serialized operations now drain in order.
    await expect(writeWhileSync).resolves.toBeUndefined();
    await expect(walletWhileSync).resolves.toBe("wallet-new");
    await expect(consumableWhileSync).resolves.toEqual(["consumable-1"]);

    // Subsequent local reads see the newly committed post-sync state (v2).
    expect(await client.getSyncHeight()).toBe(2);
    expect(await client.getAccounts()).toEqual(["acct-v1", "acct-v2"]);
    expect(await client.getAccount("acct-1")).toEqual({
      id: "acct-1",
      syncHeight: 2,
      balance: 250n,
    });
    const postReader = await client.accountReader("acct-1");
    expect(await postReader.getBalance()).toBe(250n);
    expect(await client.getInputNotes({})).toEqual([
      "in-note-v1",
      "in-note-v2",
    ]);
    expect(await client.getOutputNotes({})).toEqual(["out-note-v2"]);
    expect(await client.getTransactions({})).toEqual(["tx-v1", "tx-v2"]);
    expect(await client.protocolConfig()).toEqual({ epoch: 2 });
  });

  it("completes local reads while an in-realm (useWorker: false) syncState is pending", async () => {
    const { client, wasmClient, commitNextSyncState } = makeInstance({
      useWorker: false,
    });
    const syncGate = deferred();
    wasmClient.syncStateImpl = vi.fn(async () => syncGate.promise);

    const syncPromise = client.syncState();
    await vi.waitFor(() =>
      expect(wasmClient.syncStateImpl).toHaveBeenCalledTimes(1)
    );
    expect(await settleState(syncPromise)).toEqual({ status: "pending" });

    // Local reads still run concurrently off _wasmCallChain in in-realm mode.
    await expect(client.getSyncHeight()).resolves.toBe(1);
    await expect(client.getAccountVault("acct-1")).resolves.toEqual({
      balance: 100n,
    });
    await expect(client.getInputNotes({})).resolves.toEqual(["in-note-v1"]);

    // Writes still wait behind the in-realm sync.
    const writeWhileSync = client.importNoteFile("note-file");
    expect(await settleState(writeWhileSync)).toEqual({ status: "pending" });

    commitNextSyncState({ syncHeight: 5, balance: 500n });
    syncGate.resolve("synced-in-realm");
    await expect(syncPromise).resolves.toBe("synced-in-realm");
    await expect(writeWhileSync).resolves.toBe("note-imported");

    expect(await client.getSyncHeight()).toBe(5);
    expect(await client.getAccountVault("acct-1")).toEqual({
      balance: 500n,
    });
  });

  it("completes local reads while proving (worker and in-realm) is pending while keeping writes serialized", async () => {
    // Worker proving path (submitNewTransaction forwards to worker.postMessage).
    {
      const { instance, client, wasmClient, worker } = makeInstance({
        useWorker: true,
      });
      const fakeTxReq = { serialize: () => new Uint8Array([7]) };
      const proving = client.submitNewTransaction(
        { toString: () => "0xacct" },
        fakeTxReq
      );
      await vi.waitFor(() =>
        expect(
          worker.posted.filter((m) => m.methodName === "submitNewTransaction")
        ).toHaveLength(1)
      );
      const proveReq = worker.posted.find(
        (m) => m.methodName === "submitNewTransaction"
      );

      // Local reads succeed immediately while worker proving runs.
      const reader = await client.accountReader("acct-1");
      expect(await reader.getBalance()).toBe(100n);
      expect(await client.getTransactions({})).toEqual(["tx-v1"]);
      expect(await client.getOutputNotes({})).toEqual(["out-note-v1"]);
      expect(await settleState(proving)).toEqual({ status: "pending" });

      // Another proving/executing or mutating call remains serialized behind proving.
      const queuedSubmit = client.submitNewTransaction(
        { toString: () => "0xacct2" },
        fakeTxReq
      );
      const queuedWrite = client.setSetting("after-prove", new Uint8Array([2]));
      expect(await settleState(queuedSubmit)).toEqual({ status: "pending" });
      expect(await settleState(queuedWrite)).toEqual({ status: "pending" });
      expect(wasmClient.setSetting).not.toHaveBeenCalled();

      instance.resolvePendingRequest(proveReq.requestId, new Uint8Array([9]));
      await expect(proving).resolves.toBeDefined();

      await vi.waitFor(() =>
        expect(
          worker.posted.filter((m) => m.methodName === "submitNewTransaction")
        ).toHaveLength(2)
      );
      const secondReq = worker.posted.filter(
        (m) => m.methodName === "submitNewTransaction"
      )[1];
      instance.resolvePendingRequest(secondReq.requestId, new Uint8Array([8]));
      await expect(queuedSubmit).resolves.toBeDefined();
      await expect(queuedWrite).resolves.toBeUndefined();
    }

    // In-realm proving path (useWorker: false via proxy proveTransaction).
    {
      const { client, wasmClient } = makeInstance({ useWorker: false });
      const proveGate = deferred();
      wasmClient.proveTransaction = vi.fn(() => proveGate.promise);

      const proving = client.proveTransaction("tx");
      await vi.waitFor(() =>
        expect(wasmClient.proveTransaction).toHaveBeenCalledTimes(1)
      );

      // Local reads resolve immediately while proveTransaction is pending.
      await expect(client.getAccount("acct-1")).resolves.toEqual({
        id: "acct-1",
        syncHeight: 1,
        balance: 100n,
      });
      await expect(client.listTags()).resolves.toEqual(["tag-v1"]);

      // Serialized executeProgram still waits for proving.
      const queuedExec = client.executeProgram();
      expect(await settleState(queuedExec)).toEqual({ status: "pending" });

      proveGate.resolve("proven-tx");
      await expect(proving).resolves.toBe("proven-tx");
      await expect(queuedExec).resolves.toBe("program-out");
    }
  });

  it("exposes updated committed state consistently through MidenClient resource APIs during and after sync", async () => {
    const { instance, client, worker, commitNextSyncState } = makeInstance({
      useWorker: true,
    });
    const fakeWasmModule = {
      NoteFilter: class {
        constructor(type) {
          this.type = type;
        }
      },
      NoteFilterTypes: { All: 0, Expected: 1, Committed: 2 },
      TransactionFilter: { all: () => ({ all: true }) },
      AccountId: {
        fromHex: (h) => ({ toHex: () => h }),
        fromBech32: (b) => ({ toBech32: () => b }),
      },
    };
    const miden = new MidenClient(client, async () => fakeWasmModule, null);

    const syncPromise = miden.sync();
    await vi.waitFor(() =>
      expect(
        worker.posted.filter((m) => m.methodName === "syncState")
      ).toHaveLength(1)
    );
    const syncReq = worker.posted.find((m) => m.methodName === "syncState");

    // During pending sync, high-level resource reads complete and see v1.
    expect(await miden.getSyncHeight()).toBe(1);
    expect(await miden.accounts.getBalance("acct-1", "0xfeefaucet1")).toBe(
      100n
    );
    expect(await miden.transactions.list()).toEqual(["tx-v1"]);

    commitNextSyncState({
      syncHeight: 3,
      balance: 420n,
      transactions: ["tx-v1", "tx-v3"],
    });
    instance.resolvePendingRequest(syncReq.requestId, new Uint8Array([3]));
    await syncPromise;

    // After sync resolves, resource reads immediately reflect committed v3 state.
    expect(await miden.getSyncHeight()).toBe(3);
    expect(await miden.accounts.getBalance("acct-1", "0xfeefaucet1")).toBe(
      420n
    );
    expect(await miden.transactions.list()).toEqual(["tx-v1", "tx-v3"]);
  });

  it("preserves terminate() freeing order, _withInnerWebClient re-entrancy, worker failure handling, and sync coalescing", async () => {
    // 1. terminate() waits for an in-flight local read before calling free(), and rejects reads after terminate().
    {
      const { instance, client, wasmClient } = makeInstance({
        useWorker: false,
      });
      const readGate = deferred();
      wasmClient.getAccountVault = vi.fn(() => readGate.promise);

      const inFlightRead = client.getAccountVault("acct-1");
      await vi.waitFor(() =>
        expect(wasmClient.getAccountVault).toHaveBeenCalledTimes(1)
      );

      client.terminate();
      await flush();
      expect(wasmClient.free).not.toHaveBeenCalled();
      await expect(client.getAccountVault("acct-1")).rejects.toThrow(
        /WebClient terminated/
      );

      readGate.resolve({ balance: 99n });
      await expect(inFlightRead).resolves.toEqual({ balance: 99n });
      await client.waitForIdle();
      expect(wasmClient.free).toHaveBeenCalledTimes(1);
    }

    // 2. _withInnerWebClient re-entrancy still permits nested reads and serialized calls after terminate() starts.
    {
      const { client } = makeInstance({ useWorker: false });
      const miden = new MidenClient(client, async () => ({}), null);
      const innerEntered = deferred();
      const allowExit = deferred();

      const outer = miden._withInnerWebClient(async (inner) => {
        innerEntered.resolve();
        await allowExit.promise;
        const height = await inner.getSyncHeight();
        const setRes = await inner.setSetting("reentrant", new Uint8Array([1]));
        return { height, setRes };
      });

      await innerEntered.promise;
      client.terminate();
      allowExit.resolve();
      await expect(outer).resolves.toEqual({ height: 1, setRes: undefined });
    }

    // 3. Interleaved local reads emit observations and do not break syncState coalescing or worker failure recovery.
    {
      const seen = [];
      setObserver((obs) => seen.push(obs));

      const { instance, client, wasmClient } = makeInstance({
        useWorker: true,
      });
      const syncGate = deferred();
      wasmClient.syncStateImpl = vi.fn(() => syncGate.promise);
      // Force in-realm sync gate for testing coalescing via _syncRuns.
      instance.worker.postMessage = vi.fn((msg) => {
        setTimeout(() => {
          if (msg.methodName === "syncState") {
            syncGate.promise.then((res) =>
              instance.resolvePendingRequest(msg.requestId, res)
            );
          }
        }, 0);
      });

      const s1 = client.syncState();
      const localRead = await client.getAccount("acct-1");
      expect(localRead).toEqual({ id: "acct-1", syncHeight: 1, balance: 100n });
      // Local read does not increment _queuedCalls, so second syncState joins s1.
      const s2 = client.syncState();

      syncGate.resolve(new Uint8Array([1]));
      const [r1, r2] = await Promise.all([s1, s2]);
      expect(r1).toEqual(r2);
      expect(
        seen.some((e) => e.op === "getAccount" && e.outcome === "ok")
      ).toBe(true);

      // Worker failure rejects queued worker requests without breaking local reads or throwing on terminate.
      instance._failWorker("worker crashed");
      await expect(client.syncState()).rejects.toThrow("worker crashed");
      await expect(client.getSyncHeight()).resolves.toBe(1);
    }
  });
});
