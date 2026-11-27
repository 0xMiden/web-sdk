const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("module");
const ts = require("typescript");
const React = require("react");
const renderer = require("react-test-renderer");

const { act } = renderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flushPromises = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const loadUseParaMiden = (mocks = {}) => {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (mocks[request]) return mocks[request];
    if (request.startsWith("@miden-sdk/miden-sdk")) {
      return mocks["@miden-sdk/miden-sdk"];
    }
    if (request.startsWith("@miden-sdk/para")) {
      return mocks["@miden-sdk/para"];
    }
    if (request.startsWith("@getpara/react-sdk-lite")) {
      return mocks["@getpara/react-sdk-lite"];
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    const filePath = path.resolve(__dirname, "../../react/src/useParaMiden.ts");
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
      useParaMiden: compiledModule.exports.useParaMiden,
      restore: () => {
        Module._load = originalLoad;
      },
    };
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  }
};

const renderHook = async (useParaMiden, args) => {
  let latest;
  const renders = [];
  const Harness = ({ hookArgs }) => {
    latest = useParaMiden(...hookArgs);
    renders.push(latest);
    return null;
  };

  let testRenderer;
  await act(async () => {
    testRenderer = renderer.create(
      React.createElement(Harness, { hookArgs: args })
    );
    await flushPromises();
    await flushPromises();
  });

  const rerender = async (nextArgs) => {
    await act(async () => {
      testRenderer.update(React.createElement(Harness, { hookArgs: nextArgs }));
      await flushPromises();
      await flushPromises();
    });
  };

  const unmount = async () => {
    await act(async () => {
      testRenderer.unmount();
      await flushPromises();
    });
  };

  return {
    getLatest: () => latest,
    getRenders: () => renders,
    rerender,
    unmount,
  };
};

const createClientFactory = ({ mode = "resolve", error, events } = {}) => {
  const calls = [];
  const clients = [];
  const pending = [];
  let currentMode = mode;
  let currentError = error;

  const createParaMidenClient = (...args) => {
    calls.push(args);
    const walletId = args[1]?.[0]?.id ?? "default";
    if (events) events.push(`start:${walletId}`);
    if (currentMode === "reject") {
      return Promise.reject(currentError ?? new Error("create failed"));
    }
    const client = {
      id: `client-${walletId}`,
      terminate: test.mock.fn(() => {
        if (events) events.push(`terminate:${walletId}`);
      }),
    };
    clients.push(client);
    const result = { client, accountId: `acc-${walletId}` };
    if (currentMode === "defer") {
      return new Promise((resolve, reject) => {
        pending.push({
          args,
          client,
          resolve: () => resolve(result),
          reject,
        });
      });
    }
    return Promise.resolve(result);
  };

  return {
    createParaMidenClient,
    calls,
    clients,
    pending,
    setMode: (nextMode, nextError) => {
      currentMode = nextMode;
      currentError = nextError;
    },
  };
};

const buildMocks = (state, factory) => ({
  "@getpara/react-sdk-lite": {
    useClient: () => state.para,
    useAccount: () => ({
      isConnected: state.isConnected,
      embedded: { wallets: state.wallets },
    }),
  },
  "@miden-sdk/para": {
    createParaMidenClient: factory.createParaMidenClient,
  },
  "@miden-sdk/miden-sdk": {},
});

test("useParaMiden returns defaults when disconnected", async () => {
  const state = {
    para: null,
    isConnected: false,
    wallets: [],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );

  try {
    const { getLatest } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "public",
    ]);

    assert.strictEqual(factory.calls.length, 0);
    const latest = getLatest();
    assert.strictEqual(latest.client, null);
    assert.strictEqual(latest.accountId, "");
    assert.strictEqual(latest.error, "");
    assert.deepEqual(latest.evmWallets, []);
  } finally {
    restore();
  }
});

test("useParaMiden filters EVM wallets and forwards options", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [
      { id: "evm-1", type: "EVM" },
      { id: "sol-1", type: "SOLANA" },
    ],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const opts = {
    accountSeed: "seed",
    noteTransportUrl: "https://transport.miden.io",
  };
  const confirmStep = test.mock.fn();

  try {
    const { getLatest } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "private",
      opts,
      false,
      confirmStep,
    ]);

    assert.strictEqual(factory.calls.length, 1);
    const [paraArg, walletsArg, optsArg, showSigningModalArg, confirmArg] =
      factory.calls[0];
    assert.strictEqual(paraArg, state.para);
    assert.strictEqual(walletsArg.length, 1);
    assert.strictEqual(walletsArg[0].id, "evm-1");
    assert.strictEqual(optsArg.endpoint, "https://rpc.testnet.miden.io");
    assert.strictEqual(optsArg.storageMode, "private");
    assert.strictEqual(optsArg.accountSeed, "seed");
    assert.strictEqual(optsArg.noteTransportUrl, "https://transport.miden.io");
    assert.strictEqual(showSigningModalArg, false);
    assert.strictEqual(typeof confirmArg, "function");
    const summary = { inputNotes: [], outputNotes: [] };
    await confirmArg(summary);
    assert.strictEqual(confirmStep.mock.callCount(), 1);
    assert.strictEqual(confirmStep.mock.calls[0].arguments[0], summary);

    const latest = getLatest();
    assert.strictEqual(latest.client, factory.clients[0]);
    assert.strictEqual(latest.accountId, "acc-evm-1");
  } finally {
    restore();
  }
});

test("useParaMiden surfaces createParaMidenClient failures", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-1", type: "EVM" }],
  };
  const factory = createClientFactory({
    mode: "reject",
    error: new Error("no evm wallets"),
  });
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );

  try {
    const { getLatest } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "public",
    ]);
    await flushPromises();
    await flushPromises();
    const latest = getLatest();
    assert.strictEqual(factory.calls.length, 1);
    assert.strictEqual(latest.accountId, "");
    assert.strictEqual(latest.error, "no evm wallets");
  } finally {
    restore();
  }
});

test("useParaMiden does not recreate client once initialized", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-1", type: "EVM" }],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );

  try {
    const { rerender } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "public",
    ]);

    assert.strictEqual(factory.calls.length, 1);
    await rerender(["https://rpc.testnet.miden.io", "public"]);
    assert.strictEqual(factory.calls.length, 1);
  } finally {
    restore();
  }
});

test("useParaMiden terminates a client created after unmount and never stores it", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-1", type: "EVM" }],
  };
  const factory = createClientFactory({ mode: "defer" });
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );

  try {
    const { getLatest, unmount } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "public",
    ]);
    assert.strictEqual(factory.calls.length, 1);
    await unmount();

    factory.pending[0].resolve();
    await flushPromises();
    await flushPromises();

    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 1);
    assert.strictEqual(getLatest().client, null);
    assert.strictEqual(getLatest().accountId, "");
  } finally {
    restore();
  }
});

test("useParaMiden drops the client on logout and rebuilds it for the next Para user", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const args = ["https://rpc.testnet.miden.io", "public"];

  try {
    const { getLatest, rerender } = await renderHook(useParaMiden, args);
    assert.strictEqual(getLatest().client.id, "client-evm-a");
    assert.strictEqual(getLatest().accountId, "acc-evm-a");

    state.isConnected = false;
    state.wallets = [];
    await rerender(args);
    assert.strictEqual(getLatest().client, null);
    assert.strictEqual(getLatest().accountId, "");
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 1);

    state.isConnected = true;
    state.wallets = [{ id: "evm-b", type: "EVM" }];
    await rerender(args);
    assert.strictEqual(factory.calls.length, 2);
    assert.strictEqual(factory.calls[1][1][0].id, "evm-b");
    assert.strictEqual(getLatest().client.id, "client-evm-b");
    assert.strictEqual(getLatest().accountId, "acc-evm-b");
  } finally {
    restore();
  }
});

test("useParaMiden rebuilds the client when the Para wallet changes without a logout", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const args = ["https://rpc.testnet.miden.io", "public"];

  try {
    const { getLatest, rerender } = await renderHook(useParaMiden, args);
    assert.strictEqual(getLatest().accountId, "acc-evm-a");

    state.wallets = [{ id: "evm-b", type: "EVM" }];
    await rerender(args);
    assert.strictEqual(factory.calls.length, 2);
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 1);
    assert.strictEqual(getLatest().client.id, "client-evm-b");
    assert.strictEqual(getLatest().accountId, "acc-evm-b");
  } finally {
    restore();
  }
});

test("useParaMiden clears error on logout after failed setup and before next attempt", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory({
    mode: "reject",
    error: new Error("no evm wallets"),
  });
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const args = ["https://rpc.testnet.miden.io", "public"];

  try {
    const { getLatest, rerender } = await renderHook(useParaMiden, args);
    assert.strictEqual(getLatest().error, "no evm wallets");
    assert.strictEqual(getLatest().client, null);

    state.isConnected = false;
    state.wallets = [];
    await rerender(args);
    assert.strictEqual(getLatest().error, "");
    assert.strictEqual(getLatest().accountId, "");
    assert.strictEqual(getLatest().client, null);

    factory.setMode("defer");
    state.isConnected = true;
    state.wallets = [{ id: "evm-b", type: "EVM" }];
    await rerender(args);
    assert.strictEqual(getLatest().error, "");
    factory.pending[0].resolve();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(getLatest().client.id, "client-evm-b");
  } finally {
    restore();
  }
});

test("useParaMiden terminates an initialized client on unmount", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );

  try {
    const { getLatest, unmount } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "public",
    ]);
    assert.strictEqual(getLatest().client, factory.clients[0]);
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 0);

    await unmount();
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 1);
  } finally {
    restore();
  }
});

test("useParaMiden preserves resolved and pending clients across same-id reference churn", async () => {
  const state = {
    para: { id: "para-1" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory({ mode: "defer" });
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const confirmA = test.mock.fn();
  const confirmB = test.mock.fn();

  try {
    const { getLatest, rerender } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "public",
      { accountSeed: "s" },
      true,
      confirmA,
    ]);
    assert.strictEqual(factory.calls.length, 1);

    state.wallets = [
      { id: "evm-a", type: "EVM" },
      { id: "sol-1", type: "SOLANA" },
    ];
    state.para = { id: "para-2" };
    await rerender([
      "https://rpc.testnet.miden.io",
      "public",
      { accountSeed: "s" },
      true,
      confirmB,
    ]);
    assert.strictEqual(factory.calls.length, 1);

    factory.pending[0].resolve();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(getLatest().client, factory.clients[0]);

    state.wallets = [{ id: "evm-a", type: "EVM" }];
    await rerender([
      "https://rpc.testnet.miden.io",
      "public",
      { accountSeed: "s" },
      true,
      confirmB,
    ]);
    assert.strictEqual(factory.calls.length, 1);
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 0);

    const summary = { inputNotes: [], outputNotes: [] };
    await factory.calls[0][4](summary);
    assert.strictEqual(confirmA.mock.callCount(), 0);
    assert.strictEqual(confirmB.mock.callCount(), 1);
  } finally {
    restore();
  }
});

test("useParaMiden rebuilds and terminates prior client when config changes", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );

  try {
    const { getLatest, rerender } = await renderHook(useParaMiden, [
      "https://rpc.testnet.miden.io",
      "public",
      { accountSeed: "s1", noteTransportUrl: "https://t1.miden.io" },
      true,
    ]);
    assert.strictEqual(factory.calls.length, 1);

    await rerender([
      "https://rpc.devnet.miden.io",
      "public",
      { accountSeed: "s1", noteTransportUrl: "https://t1.miden.io" },
      true,
    ]);
    assert.strictEqual(factory.calls.length, 2);
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 1);
    assert.strictEqual(
      factory.calls[1][2].endpoint,
      "https://rpc.devnet.miden.io"
    );
    assert.strictEqual(getLatest().client, factory.clients[1]);

    await rerender([
      "https://rpc.devnet.miden.io",
      "private",
      { accountSeed: "s1", noteTransportUrl: "https://t1.miden.io" },
      true,
    ]);
    assert.strictEqual(factory.calls.length, 3);
    assert.strictEqual(factory.clients[1].terminate.mock.callCount(), 1);
    assert.strictEqual(factory.calls[2][2].storageMode, "private");

    await rerender([
      "https://rpc.devnet.miden.io",
      "private",
      { accountSeed: "s2", noteTransportUrl: "https://t1.miden.io" },
      false,
    ]);
    assert.strictEqual(factory.calls.length, 4);
    assert.strictEqual(factory.clients[2].terminate.mock.callCount(), 1);
    assert.strictEqual(factory.calls[3][2].accountSeed, "s2");
    assert.strictEqual(factory.calls[3][3], false);
  } finally {
    restore();
  }
});

test("useParaMiden serializes setup when wallet switches while createParaMidenClient is pending", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const events = [];
  const factory = createClientFactory({ mode: "defer", events });
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const args = ["https://rpc.testnet.miden.io", "public"];

  try {
    const { getLatest, rerender } = await renderHook(useParaMiden, args);
    assert.strictEqual(factory.calls.length, 1);
    assert.deepEqual(events, ["start:evm-a"]);

    state.wallets = [{ id: "evm-b", type: "EVM" }];
    await rerender(args);
    assert.strictEqual(factory.calls.length, 1);
    assert.strictEqual(getLatest().client, null);

    factory.pending[0].resolve();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 1);
    assert.strictEqual(factory.calls.length, 2);
    assert.deepEqual(events, ["start:evm-a", "terminate:evm-a", "start:evm-b"]);
    assert.strictEqual(getLatest().client, null);

    factory.pending[1].resolve();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(getLatest().client.id, "client-evm-b");
    assert.strictEqual(getLatest().accountId, "acc-evm-b");
  } finally {
    restore();
  }
});

test("useParaMiden gates stale client, accountId, and error on the transition render before effects run", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory();
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const args = [
    "https://rpc.testnet.miden.io",
    "public",
    {
      accountSeed: "s1",
      noteTransportUrl: "https://t1.miden.io",
      nodeTransportUrl: "https://n1.miden.io",
      seed: "seed-1",
    },
    true,
  ];

  try {
    const { getLatest, getRenders, rerender } = await renderHook(
      useParaMiden,
      args
    );
    assert.strictEqual(getLatest().client.id, "client-evm-a");
    assert.strictEqual(getLatest().accountId, "acc-evm-a");

    // Wallet change transition render must expose null client and empty accountId immediately.
    let before = getRenders().length;
    state.wallets = [{ id: "evm-b", type: "EVM" }];
    await rerender(args);
    let transition = getRenders()[before];
    assert.strictEqual(transition.client, null);
    assert.strictEqual(transition.accountId, "");
    assert.strictEqual(getLatest().client.id, "client-evm-b");

    // Config changes (nodeUrl, noteTransportUrl, nodeTransportUrl, seed, customSignConfirmStep presence)
    // must gate transition render immediately and trigger rebuilds.
    before = getRenders().length;
    await rerender([
      "https://rpc.devnet.miden.io",
      "public",
      {
        accountSeed: "s1",
        noteTransportUrl: "https://t2.miden.io",
        nodeTransportUrl: "https://n2.miden.io",
        seed: "seed-2",
      },
      true,
      () => {},
    ]);
    transition = getRenders()[before];
    assert.strictEqual(transition.client, null);
    assert.strictEqual(transition.accountId, "");
    assert.strictEqual(factory.calls.length, 3);
    assert.strictEqual(
      factory.calls[2][2].noteTransportUrl,
      "https://t2.miden.io"
    );
    assert.strictEqual(
      factory.calls[2][2].nodeTransportUrl,
      "https://n2.miden.io"
    );
    assert.strictEqual(factory.calls[2][2].seed, "seed-2");
    assert.strictEqual(typeof factory.calls[2][4], "function");

    // Toggling customSignConfirmStep back to undefined also invalidates and rebuilds.
    before = getRenders().length;
    await rerender([
      "https://rpc.devnet.miden.io",
      "public",
      {
        accountSeed: "s1",
        noteTransportUrl: "https://t2.miden.io",
        nodeTransportUrl: "https://n2.miden.io",
        seed: "seed-2",
      },
      true,
    ]);
    transition = getRenders()[before];
    assert.strictEqual(transition.client, null);
    assert.strictEqual(factory.calls.length, 4);
    assert.strictEqual(factory.calls[3][4], undefined);

    // Logout transition render must gate client and accountId immediately.
    before = getRenders().length;
    state.isConnected = false;
    state.wallets = [];
    await rerender(args);
    transition = getRenders()[before];
    assert.strictEqual(transition.client, null);
    assert.strictEqual(transition.accountId, "");

    // Failed setup -> logout transition render must clear error immediately.
    factory.setMode("reject", new Error("boom"));
    state.isConnected = true;
    state.wallets = [{ id: "evm-c", type: "EVM" }];
    await rerender(args);
    assert.strictEqual(getLatest().error, "boom");

    before = getRenders().length;
    state.isConnected = false;
    state.wallets = [];
    await rerender(args);
    transition = getRenders()[before];
    assert.strictEqual(transition.error, "");
    assert.strictEqual(transition.client, null);
    assert.strictEqual(transition.accountId, "");
  } finally {
    restore();
  }
});

test("useParaMiden does not expose terminated client on A -> B (pending) -> A transition", async () => {
  const state = {
    para: { id: "para" },
    isConnected: true,
    wallets: [{ id: "evm-a", type: "EVM" }],
  };
  const factory = createClientFactory({ mode: "defer" });
  const { useParaMiden, restore } = loadUseParaMiden(
    buildMocks(state, factory)
  );
  const args = ["https://rpc.testnet.miden.io", "public"];

  try {
    const { getLatest, getRenders, rerender } = await renderHook(
      useParaMiden,
      args
    );
    factory.pending[0].resolve();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(getLatest().client.id, "client-evm-a");

    // Switch A -> B while B is pending; A is terminated.
    state.wallets = [{ id: "evm-b", type: "EVM" }];
    await rerender(args);
    assert.strictEqual(factory.clients[0].terminate.mock.callCount(), 1);
    assert.strictEqual(getLatest().client, null);

    // Switch back B -> A while B is still pending; must never expose terminated client A.
    const before = getRenders().length;
    state.wallets = [{ id: "evm-a", type: "EVM" }];
    await rerender(args);
    assert.strictEqual(getRenders()[before].client, null);
    assert.strictEqual(getLatest().client, null);
    assert.strictEqual(getLatest().accountId, "");

    // Resolve B (superseded and terminated), then resolve the fresh A setup.
    factory.pending[1].resolve();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(factory.clients[1].terminate.mock.callCount(), 1);

    factory.pending[2].resolve();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(getLatest().client.id, "client-evm-a");
    assert.strictEqual(getLatest().client !== factory.clients[0], true);
  } finally {
    restore();
  }
});
