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
      createMidenTurnkeyClient: compiledModule.exports.createMidenTurnkeyClient,
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
      AccountStorageMode: {
        private: () => ({ asStr: () => "private" }),
        public: () => ({ asStr: () => "public" }),
      },
    },
    "@turnkey/http": {
      isHttpClient: () => false,
      TurnkeyActivityError: class TurnkeyActivityError extends Error {},
    },
    "./utils.js": {
      accountSeedFromStr: () => undefined,
      evmPkToCommitment: async () => ({}),
      fromTurnkeySig: () => new Uint8Array(),
    },
  };
};

const create = (createMidenTurnkeyClient) =>
  createMidenTurnkeyClient(
    {
      client: {},
      organizationId: "org",
      account: { address: "0xaddress", publicKey: "0xpublickey" },
    },
    {
      endpoint: "https://rpc.testnet.miden.io",
      storageMode: { asStr: () => "public" },
    }
  );

test("createMidenTurnkeyClient terminates its client when account setup fails", async () => {
  const failure = new Error("sync failed");
  const client = makeClient(async () => {
    throw failure;
  });
  const { createMidenTurnkeyClient, restore } = loadMidenClient(
    buildMocks(client)
  );

  try {
    await assert.rejects(create(createMidenTurnkeyClient), (error) => {
      assert.strictEqual(error, failure);
      return true;
    });
    assert.strictEqual(client.terminate.mock.callCount(), 1);
  } finally {
    restore();
  }
});

test("createMidenTurnkeyClient leaves the client it returns alive", async () => {
  const client = makeClient(async () => {});
  const { createMidenTurnkeyClient, restore } = loadMidenClient(
    buildMocks(client)
  );

  try {
    const result = await create(createMidenTurnkeyClient);
    assert.strictEqual(result.client, client);
    assert.strictEqual(result.accountId, "0xaccount");
    assert.strictEqual(client.terminate.mock.callCount(), 0);
  } finally {
    restore();
  }
});
