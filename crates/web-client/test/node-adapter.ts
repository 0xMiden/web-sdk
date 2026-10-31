/**
 * Node.js adapter for the Miden web-client napi SDK.
 *
 * Maps the Node.js SDK surface to match the browser's window.* interface,
 * so existing Playwright tests can run unchanged on both platforms.
 *
 * The SDK object, array containers and client proxies are the shipped ones
 * from js/node/napi-compat.js, so the Node suite tests the SDK that ships.
 * Test-only adaptations:
 * - createMockClient() with no args → createMockClient(dbPath, keystorePath, ...)
 * - Fake page.evaluate() that runs callbacks directly
 */
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";
import { FaucetType } from "../js/enums.js";
import {
  createSdkWrapper,
  normalizeArg,
  NODE_ARRAY_TYPES,
  wrapClient,
} from "../js/node/napi-compat.js";

const require = createRequire(import.meta.url);

// ── Load the napi module ──────────────────────────────────────────────

let _rawSdk: any = null;
let _sdk: any = null;

/** Loads the raw napi module, once per process. */
export function loadNodeSdk(): any {
  if (_rawSdk) return _rawSdk;

  if (process.env.MIDEN_MODULE_PATH) {
    _rawSdk = require(process.env.MIDEN_MODULE_PATH);
    return _rawSdk;
  }

  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const arch = os.arch() === "arm64" ? "aarch64" : os.arch();
  const platform =
    os.platform() === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
  const target = `${arch}-${platform}`;
  const ext = os.platform() === "darwin" ? "dylib" : "so";

  const candidates = [
    path.join(
      repoRoot,
      "target",
      target,
      "release",
      `libmiden_client_web.${ext}`
    ),
    path.join(repoRoot, "target", "release", `libmiden_client_web.${ext}`),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const nodeFile = path.join(path.dirname(p), "miden_client_web.node");
      if (
        !fs.existsSync(nodeFile) ||
        fs.statSync(p).mtimeMs > fs.statSync(nodeFile).mtimeMs
      ) {
        fs.copyFileSync(p, nodeFile);
      }
      _rawSdk = require(nodeFile);
      return _rawSdk;
    }
  }

  throw new Error(
    `napi module not found. Build with:\n` +
      `  cargo build -p miden-client-web --no-default-features --features nodejs,testing --release --target ${target}`
  );
}

/**
 * The SDK object the shipped Node entry builds. `createSdkWrapper` patches the
 * native prototypes in place, so it runs once per process, as in node-index.js.
 */
export function getNodeSdk(): any {
  if (!_sdk) _sdk = createSdkWrapper(loadNodeSdk());
  return _sdk;
}

// Lazy-load: only initialize when actually used (avoids crash on browser-only CI)
const sdk = new Proxy(
  {},
  {
    get(_target, prop) {
      return getNodeSdk()[prop];
    },
  }
) as any;

// ── Client factories ──────────────────────────────────────────────────

let testCounter = 0;

function tmpTestDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `miden-node-test-${process.pid}-${++testCounter}`
  );
  fs.mkdirSync(path.join(dir, "keystore"), { recursive: true });
  return dir;
}

/**
 * Matches the browser's `window.MockWasmWebClient` interface.
 */
const MockWasmWebClient = {
  createClient: async (
    seed?: any,
    serializedMockChain?: any,
    serializedMockNoteTransportNode?: any
  ) => {
    const dir = tmpTestDir();
    const client = new sdk.WebClient();
    // Convert Uint8Array/Buffer to plain Array for napi's Vec<u8>
    const norm = (v: any) =>
      v instanceof Uint8Array || Buffer.isBuffer(v) ? Array.from(v) : v;
    await client.createMockClient(
      path.join(dir, "store.db"),
      path.join(dir, "keystore"),
      norm(seed) ?? null,
      norm(serializedMockChain) ?? null,
      norm(serializedMockNoteTransportNode) ?? null
    );
    return wrapClient(client, "mock");
  },
};

/**
 * Matches the browser's `window.WasmWebClient` interface.
 */
export const WasmWebClient = {
  // Static method used by standalone.js buildSwapTag
  buildSwapTag: (...args: any[]) =>
    sdk.WebClient.buildSwapTag(...args.map(normalizeArg)),

  createClient: async (
    rpcUrl?: string,
    noteTransportUrl?: any,
    seed?: any,
    storeName?: string,
    feeFaucetId?: string
  ) => {
    const dir = tmpTestDir();
    const client = new sdk.WebClient();
    const normSeed =
      seed instanceof Uint8Array || Buffer.isBuffer(seed)
        ? Array.from(seed)
        : seed;
    await client.createClient(
      rpcUrl ?? null,
      noteTransportUrl ?? null,
      normSeed ?? null,
      path.join(dir, `${storeName || "store"}.db`),
      path.join(dir, "keystore"),
      feeFaucetId ?? null
    );
    return wrapClient(client, storeName);
  },
};

// ── Helpers (matches window.helpers.*) ────────────────────────────────

function createHelpers(getClient: () => any, setClient: (c: any) => void) {
  return {
    waitForTransaction: async (
      transactionId: string,
      maxWaitTime = 10000,
      delayInterval = 1000
    ) => {
      const client = getClient();
      let timeWaited = 0;
      while (true) {
        if (timeWaited >= maxWaitTime)
          throw new Error("Timeout waiting for transaction");
        await client.syncState();
        const uncommitted = await client.getTransactions(
          sdk.TransactionFilter.uncommitted()
        );
        const ids = uncommitted.map((tx: any) => tx.id().toHex());
        if (!ids.includes(transactionId)) break;
        await new Promise((r) => setTimeout(r, delayInterval));
        timeWaited += delayInterval;
      }
    },

    executeAndApplyTransaction: async (
      accountId: any,
      transactionRequest: any,
      prover?: any
    ) => {
      const client = getClient();
      const result = await client.executeTransaction(
        accountId,
        transactionRequest
      );
      const proverToUse = prover ?? sdk.TransactionProver.newLocalProver();
      const proven = await client.proveTransaction(result, proverToUse);
      const submissionHeight = await client.submitProvenTransaction(
        proven,
        result
      );
      return await client.applyTransaction(result, submissionHeight);
    },

    waitForBlocks: async (amountOfBlocks: number) => {
      const client = getClient();
      let currentBlock = await client.getSyncHeight();
      let finalBlock = currentBlock + amountOfBlocks;
      while (true) {
        let syncSummary = await client.syncState();
        if (syncSummary.blockNum() >= finalBlock) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    },

    parseNetworkId: (networkId: string) => {
      const map: Record<string, any> = {
        mm: sdk.NetworkId.mainnet(),
        mtst: sdk.NetworkId.testnet(),
        mdev: sdk.NetworkId.devnet(),
      };
      let parsed = map[networkId];
      if (parsed === undefined) {
        try {
          parsed = sdk.NetworkId.custom(networkId);
        } catch {
          throw new Error(`Invalid network ID: ${networkId}`);
        }
      }
      return parsed;
    },

    refreshClient: async (initSeed?: any) => {
      // Create a new mock client (the browser version reconnects to the same IndexedDB store)
      const client = await MockWasmWebClient.createClient(
        initSeed instanceof Uint8Array ? Buffer.from(initSeed) : initSeed
      );
      setClient(client);
    },
  };
}

export async function setupNodeGlobals(
  rpcUrl: string,
  storeName: string,
  proverUrl?: string
) {
  let currentClient: any = null;

  // The shipped array containers, as node-index.js exports them.
  const arrays = Object.fromEntries(
    NODE_ARRAY_TYPES.map((name) => [name, sdk[name]])
  );

  // All SDK types go on globalThis so "window.X" works in callbacks
  const globals: Record<string, any> = {
    // Client factories
    MockWasmWebClient,
    WasmWebClient,

    // SDK types
    Account: sdk.Account,
    AccountStorageMode: sdk.AccountStorageMode,
    AuthScheme: sdk.AuthScheme,
    NoteType: sdk.NoteType,
    TransactionFilter: sdk.TransactionFilter,
    TransactionProver: sdk.TransactionProver,
    NoteFilter: sdk.NoteFilter,
    NoteFilterTypes: sdk.NoteFilterTypes,
    AccountId: sdk.AccountId,
    AccountType: sdk.AccountType,
    FaucetType,
    AccountInterface: sdk.AccountInterface,
    AccountBuilder: sdk.AccountBuilder,
    AccountComponent: sdk.AccountComponent,
    AccountFile: sdk.AccountFile,
    AccountHeader: sdk.AccountHeader,
    AccountStorageRequirements: sdk.AccountStorageRequirements,
    Address: sdk.Address,
    AdviceMap: sdk.AdviceMap,
    AuthSecretKey: sdk.AuthSecretKey,
    AuthFalcon512RpoMultisigConfig: sdk.AuthFalcon512RpoMultisigConfig,
    createAuthFalcon512RpoMultisig: sdk.createAuthFalcon512RpoMultisig,
    BasicFungibleFaucetComponent: sdk.BasicFungibleFaucetComponent,
    Endpoint: sdk.Endpoint,
    Felt: sdk.Felt,
    ForeignAccount: sdk.ForeignAccount,
    FungibleAsset: sdk.FungibleAsset,
    NetworkId: sdk.NetworkId,
    Note: sdk.Note,
    NoteAndArgs: sdk.NoteAndArgs,
    NoteAssets: sdk.NoteAssets,
    NoteAttachment: sdk.NoteAttachment,
    NoteExportFormat: sdk.NoteExportFormat,
    NoteExecutionHint: sdk.NoteExecutionHint,
    NoteFile: sdk.NoteFile,
    NoteId: sdk.NoteId,
    NoteMetadata: sdk.NoteMetadata,
    NoteRecipient: sdk.NoteRecipient,
    NoteScript: sdk.NoteScript,
    NoteStorage: sdk.NoteStorage,
    NoteTag: sdk.NoteTag,
    OutputNote: sdk.OutputNote,
    Package: sdk.Package,
    ProcedureThreshold: sdk.ProcedureThreshold,
    PublicKey: sdk.PublicKey,
    Rpo: sdk.Rpo,
    Rpo256: sdk.Rpo256,
    RpcClient: sdk.RpcClient,
    Signature: sdk.Signature,
    SigningInputs: sdk.SigningInputs,
    SlotAndKeys: sdk.SlotAndKeys,
    StorageMap: sdk.StorageMap,
    StorageSlot: sdk.StorageSlot,
    TestUtils: sdk.TestUtils,
    TokenSymbol: sdk.TokenSymbol,
    TransactionRequestBuilder: sdk.TransactionRequestBuilder,
    Word: sdk.Word,

    // Array containers
    ...arrays,
    MidenArrays: arrays,

    // Config
    rpcUrl,
    storeName,
    remoteProverUrl: proverUrl ?? null,
    remoteProverInstance: proverUrl
      ? sdk.TransactionProver.newRemoteProver(proverUrl, null)
      : null,

    // Helpers (set after client is created)
    helpers: {},

    // Browser-only stubs
    exportStore: async () => {
      throw new Error("exportStore is browser-only");
    },
    importStore: async () => {
      throw new Error("importStore is browser-only");
    },
    indexedDB: { databases: async () => [] },

    // getWasmOrThrow — the SDK object MidenClient and the standalone helpers use
    getWasmOrThrow: async () => getNodeSdk(),
  };

  // Set the client getter and helpers
  const setClientFn = (client: any) => {
    currentClient = client;
    (globalThis as any).client = client;
  };
  globals.helpers = createHelpers(() => currentClient, setClientFn);

  // Put everything on globalThis.window and globalThis directly
  const w = globalThis as any;
  w.window = w;
  for (const [key, value] of Object.entries(globals)) {
    w[key] = value;
  }

  // Load JS wrapper modules (pure JS — works with napi the same way as WASM).
  try {
    const jsDir = path.resolve(import.meta.dirname, "..", "js");

    // MidenClient high-level wrapper
    const { MidenClient } = await import(path.join(jsDir, "client.js"));
    MidenClient._WasmWebClient = WasmWebClient;
    MidenClient._MockWasmWebClient = MockWasmWebClient;
    MidenClient._getWasmOrThrow = globals.getWasmOrThrow;
    w.MidenClient = MidenClient;

    // Standalone helper functions
    const standalone = await import(path.join(jsDir, "standalone.js"));
    // Wire the standalone module's internal references
    if (standalone._setWasm)
      standalone._setWasm(await globals.getWasmOrThrow());
    if (standalone._setWebClient) standalone._setWebClient(WasmWebClient);
    if (standalone.createP2IDNote) w.createP2IDNote = standalone.createP2IDNote;
    if (standalone.createP2IDENote)
      w.createP2IDENote = standalone.createP2IDENote;
    if (standalone.buildSwapTag) w.buildSwapTag = standalone.buildSwapTag;
  } catch (e) {
    // If import fails, MidenClient and standalone tests will skip
    console.warn("Failed to load JS wrapper modules:", e);
  }

  // Function to set the current client (called after createClient)
  return {
    setClient: (client: any) => {
      currentClient = client;
      w.client = client;
    },
  };
}

// ── Fake page ─────────────────────────────────────────────────────────

/**
 * Creates a fake Playwright Page object for Node.js tests.
 * page.evaluate() just runs the callback directly.
 * window.* globals are set so callbacks work unchanged.
 */
export function createFakePage() {
  return {
    evaluate: async (fn: Function, args?: any) => fn(args),
    goto: async () => {},
    on: (..._args: any[]) => {},
  };
}
