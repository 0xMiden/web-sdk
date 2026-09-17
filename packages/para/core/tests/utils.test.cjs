const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("module");
const ts = require("typescript");

const loadUtils = (mocks = {}) => {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (mocks[request]) return mocks[request];
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    const filePath = path.resolve(__dirname, "../src/utils.ts");
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
    return compiledModule.exports;
  } finally {
    Module._load = originalLoad;
  }
};

test("accountSeedFromStr handles missing seeds gracefully", () => {
  const { accountSeedFromStr } = loadUtils();
  const result = accountSeedFromStr();
  assert.strictEqual(result, undefined);
});

test("accountSeedFromStr pads shorter strings and truncates longer ones", () => {
  const { accountSeedFromStr } = loadUtils();

  const short = accountSeedFromStr("abc");
  assert.ok(short, "short seed should return a buffer");
  assert.strictEqual(short.length, 32);
  assert.deepEqual([...short.slice(0, 3)], [97, 98, 99]);
  assert.strictEqual(
    [...short.slice(3)].every((byte) => byte === 0),
    true
  );

  const longSeed = "x".repeat(40);
  const truncated = accountSeedFromStr(longSeed);
  assert.ok(truncated, "long seed should return a buffer");
  assert.strictEqual(truncated.length, 32);
  assert.strictEqual(
    truncated.every((byte) => byte === 120),
    true
  );
});

test("fromHexSig prefixes auth scheme and pads trailing byte", () => {
  const { fromHexSig } = loadUtils();
  const sig = fromHexSig("deadbeef");
  assert.deepEqual(
    Array.from(sig),
    [1, 0xde, 0xad, 0xbe, 0xef, 0],
    "signature should be prefixed and suffixed as expected"
  );
});

test("fromHexSig throws on odd-length strings", () => {
  const { fromHexSig } = loadUtils();
  assert.throws(() => fromHexSig("abc"), /Invalid string len/);
});

test("hexToBytes converts hex strings to byte arrays", () => {
  const { hexToBytes } = loadUtils();
  const bytes = hexToBytes("0aff");
  assert.deepEqual(Array.from(bytes), [0x0a, 0xff]);
});

test("getUncompressedPublicKeyFromWallet returns inline publicKey when present", async () => {
  const mocks = {
    "@getpara/web-sdk": class ParaWebMock {},
  };
  const { getUncompressedPublicKeyFromWallet } = loadUtils(mocks);
  const key = await getUncompressedPublicKeyFromWallet(
    new mocks["@getpara/web-sdk"](),
    { id: "1", publicKey: "0xabc", type: "EVM" }
  );
  assert.strictEqual(key, "0xabc");
});

test("getUncompressedPublicKeyFromWallet pulls key from Para JWT payload", async () => {
  const payload = {
    data: {
      connectedWallets: [{ id: "w1", publicKey: "0xfromjwt" }],
    },
  };
  globalThis.window = {
    atob: (input) => Buffer.from(input, "base64").toString("binary"),
  };

  const token = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64"),
    Buffer.from(JSON.stringify(payload)).toString("base64"),
    "",
  ].join(".");

  class ParaWebMock {
    issueJwt() {
      return Promise.resolve({ token });
    }
  }

  const { getUncompressedPublicKeyFromWallet } = loadUtils({
    "@getpara/web-sdk": ParaWebMock,
  });
  const key = await getUncompressedPublicKeyFromWallet(new ParaWebMock(), {
    id: "w1",
    type: "EVM",
  });
  assert.strictEqual(key, "0xfromjwt");
  delete globalThis.window;
});

test("getUncompressedPublicKeyFromWallet throws when wallet missing in JWT", async () => {
  const payload = { data: { connectedWallets: [] } };
  globalThis.window = {
    atob: (input) => Buffer.from(input, "base64").toString("binary"),
  };
  const token = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64"),
    Buffer.from(JSON.stringify(payload)).toString("base64"),
    "",
  ].join(".");

  class ParaWebMock {
    issueJwt() {
      return Promise.resolve({ token });
    }
  }

  const { getUncompressedPublicKeyFromWallet } = loadUtils({
    "@getpara/web-sdk": ParaWebMock,
  });

  await assert.rejects(
    () =>
      getUncompressedPublicKeyFromWallet(new ParaWebMock(), {
        id: "missing",
        type: "EVM",
      }),
    /Wallet Not Found/
  );
  delete globalThis.window;
});

test("evmPkToCommitment hashes x and y as sixteen limbs", async () => {
  let capturedFelts;
  const mockSdk = {
    Felt: class Felt {
      constructor(value) {
        this.value = value;
      }
    },
    FeltArray: class FeltArray {
      constructor(elements) {
        this.elements = elements;
      }
    },
    Poseidon2: {
      hashElements(feltArray) {
        capturedFelts = feltArray.elements;
        return { mocked: true, felts: feltArray.elements };
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@miden-sdk/miden-sdk") return mockSdk;
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    const { evmPkToCommitment } = loadUtils();

    // y-coordinate ends with an odd nibble (3) to trigger odd tag
    const uncompressed =
      "0x04" +
      "12".repeat(32) + // x
      "34".repeat(31) +
      "33"; // y (odd)

    const result = await evmPkToCommitment(uncompressed);
    assert.ok(result.mocked, "should return mock hash result");
    assert.ok(Array.isArray(capturedFelts), "felts captured");
    assert.strictEqual(
      capturedFelts.length,
      16,
      "should produce 16 felts: x then y, eight 32-bit limbs each"
    );
  } finally {
    Module._load = originalLoad;
  }
});

// ---------------------------------------------------------------------------
// ECDSA public-key commitment — golden vectors (0.16 line).
//
// Generated from @miden-sdk/miden-sdk@0.16.0-rc.4. For every vector,
//   AuthSecretKey.ecdsaWithRNG(seed).publicKey().toCommitment()
//     === Poseidon2.hashElements(felts)
// where `felts` is the preimage this module builds. Both halves are pinned so
// a drift in either is caught:
//
//   * `felts`      — the preimage. 0.16 commits to the affine point as sixteen
//                    felts: x then y, each as eight 32-bit limbs in
//                    little-endian limb order. The 0.15 line hashed nine felts
//                    packed from the compressed SEC1 encoding, so these vectors
//                    differ from the ones on `main` by construction.
//   * hash family  — the protocol commits with Poseidon2. Committing with
//                    Rpo256 yields a valid-looking Word that is simply wrong
//                    and only surfaces as an auth rejection at transaction time.
//
// Vectors pin the public key rather than the RNG seed: seed -> key derivation
// is version-dependent, key -> commitment is the thing under test.
// ---------------------------------------------------------------------------

const COMMITMENT_VECTORS = [
  {
    // y-parity tag 0x02
    uncompressed:
      "0x0472629d0d7b4ba577b47a34ba093ff89329118a0e0758c0cf2bf301f3b130556f35d480a34dfbdcdaf47eb71d2433a0c2d11285f7351528151e81fe8cfdba8a48",
    felts: [
      2972734831, 737346035, 123257039, 689015310, 155187347, 3027907770,
      2068555127, 1919065357, 4256860744, 511835788, 890578965, 3507652087,
      607363266, 4101945117, 1308351706, 903119011,
    ],
    commitment:
      "0xae4ccb80c2ae474eb5d1165e4d32c0779c2f77cdb793df239efc4026b6b904c6",
  },
  {
    // y-parity tag 0x03
    uncompressed:
      "0x0420c9a32288e1624a28c120f0a730e9ce29f1c4c864db928763b1c4f089454972a7db6049c8e00874ae3258f73cb37a8accf79ea15c8cebee4dd17624f51ab353",
    felts: [
      2303019378, 1672594672, 1692111495, 703710408, 2805000654, 683745520,
      2296472138, 550085410, 4112167763, 1305572900, 1552739310, 3438780065,
      1018395274, 2922535159, 3370125428, 2816172105,
    ],
    commitment:
      "0x205560170f28e96d800b8d39fc2a91fe9153f880ca0347715a7f1d23822dea3a",
  },
  {
    // y-parity tag 0x03
    uncompressed:
      "0x046d5c9138a34bc27fdedb102c504072336d28e3e44120ece60118e01ba41a45b5828081d6a9cb2876cee6120f92cff508efc3f67f5ac41d9900bba8c434c252c3",
    felts: [
      2753185205, 18407451, 1092676838, 1831396324, 1346400819, 3738898476,
      2739651199, 1834783032, 885150403, 12298436, 1522802073, 4022597247,
      2463102216, 3471184399, 2848663670, 2189459926,
    ],
    commitment:
      "0xe35861910160e6c178c503f153c224b1cf2fff2f8a5851f00528f2e007750589",
  },
  {
    // y-parity tag 0x02
    uncompressed:
      "0x04761748840822b7eb5c93e7d86728f01a5846e06258cf14c9f5b314ede23858df69820dcd53494a6765c2643ea41e8a2225c5a7c5c982e0bd7b4c65af5f8ebab2",
    felts: [
      3795343583, 4122154221, 1489966281, 1481039970, 1730736154, 1553197016,
      136493035, 1981237380, 1603189426, 2068604335, 3380797629, 633710533,
      2753464866, 1707238462, 1397312103, 1770130893,
    ],
    commitment:
      "0xa61503e9a2dcb5621d24e30df81280001c21513544f1008d75d39613ceb9db63",
  },
];

/** Minimal stand-in for the SDK's hashing surface that records what was called. */
const makeSdkSpy = () => {
  const calls = { poseidon2: [], rpo256: [] };
  const record = (bucket) => (feltArray) => {
    calls[bucket].push(feltArray.values.map((felt) => Number(felt.value)));
    return { toHex: () => `0x${bucket}` };
  };
  return {
    calls,
    sdk: {
      Felt: class Felt {
        constructor(value) {
          this.value = value;
        }
      },
      FeltArray: class FeltArray {
        constructor(values) {
          this.values = values;
        }
      },
      Poseidon2: { hashElements: record("poseidon2") },
      Rpo256: { hashElements: record("rpo256") },
    },
  };
};

// `evmPkToCommitment` reaches the SDK through `await import(...)`, which
// TypeScript lowers to `Promise.resolve().then(() => require(...))`. That
// require therefore runs AFTER loadUtils has restored Module._load, so the
// mock has to stay installed across the await rather than only across the
// module compile.
const withMockedSdk = async (sdk, run) => {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.startsWith("@miden-sdk/miden-sdk")) return sdk;
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  try {
    return await run();
  } finally {
    Module._load = originalLoad;
  }
};

test("evmPkToCommitment builds the pinned Poseidon2 preimage", async () => {
  for (const vector of COMMITMENT_VECTORS) {
    const { sdk, calls } = makeSdkSpy();
    const { evmPkToCommitment } = loadUtils({ "@miden-sdk/miden-sdk": sdk });

    await withMockedSdk(sdk, () => evmPkToCommitment(vector.uncompressed));

    assert.deepEqual(
      calls.poseidon2[0],
      vector.felts,
      `preimage drifted for ${vector.uncompressed}`
    );
  }
});

test("evmPkToCommitment hashes with Poseidon2 and never Rpo256", async () => {
  for (const vector of COMMITMENT_VECTORS) {
    const { sdk, calls } = makeSdkSpy();
    const { evmPkToCommitment } = loadUtils({ "@miden-sdk/miden-sdk": sdk });

    await withMockedSdk(sdk, () => evmPkToCommitment(vector.uncompressed));

    assert.strictEqual(
      calls.poseidon2.length,
      1,
      "expected exactly one Poseidon2 hash"
    );
    assert.strictEqual(
      calls.rpo256.length,
      0,
      "commitments must not be hashed with Rpo256 — the protocol commits with Poseidon2"
    );
  }
});

const makeTxSummary = ({ outputAssets }) => ({
  inputNotes: () => ({ notes: () => [] }),
  outputNotes: () => ({
    notes: () => [
      {
        id: () => ({ toString: () => "0xoutputnote" }),
        assets: () => outputAssets,
        metadata: () => ({ noteType: () => 1 }),
      },
    ],
  }),
});

test("txSummaryToJson reports the assets an output note carries", () => {
  const { txSummaryToJson } = loadUtils();

  const summary = txSummaryToJson(
    makeTxSummary({
      outputAssets: {
        fungibleAssets: () => [
          {
            faucetId: () => ({ toString: () => "0xfaucet" }),
            amount: () => ({ toString: () => "42" }),
          },
        ],
      },
    })
  );

  assert.deepEqual(summary.outputNotes, [
    {
      id: "0xoutputnote",
      assets: [{ assetId: "0xfaucet", amount: "42" }],
      noteType: "public",
    },
  ]);
});

test("txSummaryToJson refuses to report unknown output assets as none", () => {
  const { txSummaryToJson } = loadUtils();

  // The signing-confirmation modal renders an empty asset list as "None", so an
  // absent NoteAssets must abort the summary rather than become `assets: []` —
  // otherwise a user is asked to approve a transaction whose assets are unknown.
  assert.throws(
    () => txSummaryToJson(makeTxSummary({ outputAssets: undefined })),
    /carries no asset data/
  );
});
