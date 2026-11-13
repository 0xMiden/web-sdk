const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("module");
const ts = require("typescript");

/**
 * Transpiles src/midenClient.ts and loads it with the given module mocks. The
 * creator imports the SDK lazily, so the mocks stay installed until restore().
 */
const loadMidenClient = (mocks) => {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (mocks[request]) return mocks[request];
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    const filePath = path.resolve(__dirname, "../src/midenClient.ts");
    const source = fs.readFileSync(filePath, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: filePath,
    });

    const compiledModule = new Module(filePath, module);
    compiledModule.filename = filePath;
    compiledModule.paths = Module._nodeModulePaths(path.dirname(filePath));
    compiledModule._compile(outputText, filePath);
    return {
      createParaMidenClient: compiledModule.exports.createParaMidenClient,
      restore: () => {
        Module._load = originalLoad;
      },
    };
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  }
};

const makeClient = (sync) => ({
  sync,
  terminate: test.mock.fn(),
  accounts: {
    import: async () => {},
    get: async () => ({ id: "existing" }),
    insert: async () => {},
  },
});

const buildMocks = (client) => {
  const account = { id: () => ({ toString: () => "0xaccount" }) };
  const builder = {
    withAuthComponent: () => builder,
    storageMode: () => builder,
    withBasicWalletComponent: () => builder,
    build: () => ({ account }),
  };
  return {
    "@miden-sdk/miden-sdk": {
      MidenClient: { create: async () => client },
      AccountBuilder: function AccountBuilder() {
        return builder;
      },
      AccountComponent: { createAuthComponentFromCommitment: () => ({}) },
      AccountStorageMode: { private: () => ({}), public: () => ({}) },
    },
    "@getpara/web-sdk": { hexStringToBase64: (hex) => hex },
    "@noble/hashes/sha3.js": { keccak_256: () => new Uint8Array() },
    "@noble/hashes/utils.js": {
      bytesToHex: () => "",
      hexToBytes: () => new Uint8Array(),
    },
    "./modalClient.js": {
      accountSelectionModal: async () => 0,
      signingModal: async () => true,
    },
    "./utils.js": {
      accountSeedFromStr: () => undefined,
      evmPkToCommitment: async () => ({}),
      fromHexSig: () => new Uint8Array(),
      getUncompressedPublicKeyFromWallet: async () => "0xpublickey",
      resolveEvmWallets: (_para, wallets) => wallets,
      txSummaryToJson: () => ({}),
    },
  };
};

const create = (createParaMidenClient) =>
  createParaMidenClient(
    { id: "para" },
    [{ id: "evm-1", type: "EVM" }],
    { endpoint: "https://rpc.testnet.miden.io", storageMode: "public" },
    false
  );

test("createParaMidenClient terminates its client when account setup fails", async () => {
  const failure = new Error("sync failed");
  const client = makeClient(async () => {
    throw failure;
  });
  const { createParaMidenClient, restore } = loadMidenClient(
    buildMocks(client)
  );

  try {
    await assert.rejects(create(createParaMidenClient), (error) => {
      assert.strictEqual(error, failure);
      return true;
    });
    assert.strictEqual(client.terminate.mock.callCount(), 1);
  } finally {
    restore();
  }
});

test("createParaMidenClient leaves the client it returns alive", async () => {
  const client = makeClient(async () => {});
  const { createParaMidenClient, restore } = loadMidenClient(
    buildMocks(client)
  );

  try {
    const result = await create(createParaMidenClient);
    assert.strictEqual(result.client, client);
    assert.strictEqual(result.accountId, "0xaccount");
    assert.strictEqual(client.terminate.mock.callCount(), 0);
  } finally {
    restore();
  }
});
