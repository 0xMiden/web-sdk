import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountsResource } from "../../resources/accounts.js";

function makeWasm(overrides = {}) {
  const accountTypeEnum = { RegularAccountImmutableCode: 0, RegularAccountUpdatableCode: 1 };
  const fakeBuilderInstance = {
    accountType: vi.fn().mockReturnThis(),
    storageMode: vi.fn().mockReturnThis(),
    withAuthComponent: vi.fn().mockReturnThis(),
    withComponent: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnValue({ account: { id: () => "builtAccountId" } }),
  };
  return {
    AccountId: {
      fromHex: vi.fn((hex) => ({ hex, toString: () => hex })),
      fromBech32: vi.fn((b) => ({ bech32: b, toString: () => b })),
    },
    AccountStorageMode: {
      public: vi.fn().mockReturnValue("public"),
      private: vi.fn().mockReturnValue("private"),
      network: vi.fn().mockReturnValue("network"),
    },
    AuthScheme: {
      AuthEcdsaK256Keccak: 1,
      AuthRpoFalcon512: 2,
    },
    AccountType: accountTypeEnum,
    AccountComponent: {
      createAuthComponentFromSecretKey: vi.fn().mockReturnValue("authComp"),
    },
    AccountBuilder: vi.fn().mockReturnValue(fakeBuilderInstance),
    Address: {
      fromBech32: vi.fn((b) => ({ bech32: b })),
      fromAccountId: vi.fn((id, _) => ({ accountId: id })),
    },
    ...overrides,
  };
}

function makeInner(overrides = {}) {
  return {
    newFaucet: vi.fn().mockResolvedValue("newFaucetResult"),
    newWallet: vi.fn().mockResolvedValue("newWalletResult"),
    newAccount: vi.fn().mockResolvedValue(undefined),
    newAccountWithSecretKey: vi.fn().mockResolvedValue(undefined),
    getAccount: vi.fn().mockResolvedValue("accountResult"),
    getAccounts: vi.fn().mockResolvedValue(["acc1", "acc2"]),
    importAccountById: vi.fn().mockResolvedValue(undefined),
    importAccountFile: vi.fn().mockResolvedValue(undefined),
    importPublicAccountFromSeed: vi.fn().mockResolvedValue("seedImportResult"),
    exportAccountFile: vi.fn().mockResolvedValue("exportedFile"),
    insertAccountAddress: vi.fn().mockResolvedValue(undefined),
    removeAccountAddress: vi.fn().mockResolvedValue(undefined),
    accountReader: vi.fn().mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(BigInt(100)),
    }),
    keystore: {
      getCommitments: vi.fn().mockResolvedValue(["key1"]),
    },
    ...overrides,
  };
}

function makeClient() {
  return { assertNotTerminated: vi.fn() };
}

describe("AccountsResource", () => {
  let inner;
  let client;
  let wasm;
  let getWasm;

  beforeEach(() => {
    inner = makeInner();
    client = makeClient();
    wasm = makeWasm();
    getWasm = vi.fn().mockResolvedValue(wasm);
  });

  function makeResource() {
    return new AccountsResource(inner, getWasm, client);
  }

  describe("create — faucet", () => {
    it("creates fungible faucet when type=0", async () => {
      const resource = makeResource();
      const result = await resource.create({
        type: 0,
        storage: "public",
        auth: "falcon",
        symbol: "USD",
        decimals: 2,
        maxSupply: 1000000,
      });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.newFaucet).toHaveBeenCalledWith(
        "public",
        false, // not NonFungibleFaucet for type=0
        "USD",
        2,
        BigInt(1000000),
        2 // falcon auth scheme
      );
      expect(result).toBe("newFaucetResult");
    });

    it("creates fungible faucet when type='FungibleFaucet'", async () => {
      const resource = makeResource();
      await resource.create({
        type: "FungibleFaucet",
        storage: "public",
        auth: "falcon",
        symbol: "FOO",
        decimals: 0,
        maxSupply: 500,
      });
      expect(inner.newFaucet).toHaveBeenCalledWith(
        "public",
        false,
        "FOO",
        0,
        BigInt(500),
        2
      );
    });

    it("creates non-fungible faucet when type=1", async () => {
      const resource = makeResource();
      await resource.create({
        type: 1,
        storage: "public",
        auth: "falcon",
        symbol: "NFT",
        decimals: 0,
        maxSupply: 1,
      });
      expect(inner.newFaucet).toHaveBeenCalledWith(
        "public",
        true, // NonFungibleFaucet
        "NFT",
        0,
        BigInt(1),
        2
      );
    });

    it("creates non-fungible faucet when type='NonFungibleFaucet'", async () => {
      const resource = makeResource();
      await resource.create({
        type: "NonFungibleFaucet",
        storage: "public",
        auth: "falcon",
        symbol: "NFT",
        decimals: 0,
        maxSupply: 1,
      });
      expect(inner.newFaucet).toHaveBeenCalledWith(
        "public",
        true,
        "NFT",
        0,
        BigInt(1),
        2
      );
    });

    it("defaults storage to 'public' when not specified for faucet", async () => {
      const resource = makeResource();
      await resource.create({
        type: 0,
        auth: "falcon",
        symbol: "T",
        decimals: 0,
        maxSupply: 1,
        // no storage specified — should default to "public"
      });
      expect(wasm.AccountStorageMode.public).toHaveBeenCalled();
    });

    it("uses ecdsa auth scheme when auth='ecdsa'", async () => {
      const resource = makeResource();
      await resource.create({
        type: 0,
        storage: "public",
        auth: "ecdsa",
        symbol: "T",
        decimals: 0,
        maxSupply: 1,
      });
      expect(inner.newFaucet).toHaveBeenCalledWith(
        "public",
        false,
        "T",
        0,
        BigInt(1),
        1 // ecdsa
      );
    });
  });

  describe("create — wallet", () => {
    it("creates a mutable wallet by default (no type)", async () => {
      const resource = makeResource();
      const result = await resource.create({});
      expect(inner.newWallet).toHaveBeenCalledWith("private", true, 2, undefined);
      expect(result).toBe("newWalletResult");
    });

    it("creates a mutable wallet when type='MutableWallet'", async () => {
      const resource = makeResource();
      await resource.create({ type: "MutableWallet" });
      expect(inner.newWallet).toHaveBeenCalledWith("private", true, 2, undefined);
    });

    it("creates an immutable wallet when type='ImmutableWallet'", async () => {
      const resource = makeResource();
      await resource.create({ type: "ImmutableWallet" });
      expect(inner.newWallet).toHaveBeenCalledWith("private", false, 2, undefined);
    });

    it("hashes string seed and passes it to newWallet", async () => {
      const resource = makeResource();
      await resource.create({ seed: "my seed" });
      const callArgs = inner.newWallet.mock.calls[0];
      // 4th arg should be a Uint8Array (hashed seed)
      expect(callArgs[3]).toBeInstanceOf(Uint8Array);
      expect(callArgs[3]).toHaveLength(32);
    });

    it("passes through Uint8Array seed unchanged", async () => {
      const seed = new Uint8Array(32).fill(5);
      const resource = makeResource();
      await resource.create({ seed });
      expect(inner.newWallet.mock.calls[0][3]).toBe(seed);
    });

    it("uses public storage when specified", async () => {
      const resource = makeResource();
      await resource.create({ storage: "public" });
      expect(wasm.AccountStorageMode.public).toHaveBeenCalled();
      expect(inner.newWallet).toHaveBeenCalledWith("public", true, 2, undefined);
    });

    it("creates mutable wallet when type=3", async () => {
      const resource = makeResource();
      await resource.create({ type: 3 });
      expect(inner.newWallet).toHaveBeenCalledWith("private", true, 2, undefined);
    });

    it("creates immutable wallet when type=2", async () => {
      const resource = makeResource();
      await resource.create({ type: 2 });
      expect(inner.newWallet).toHaveBeenCalledWith("private", false, 2, undefined);
    });
  });

  describe("create — contract", () => {
    it("throws when seed is missing", async () => {
      const resource = makeResource();
      await expect(
        resource.create({
          type: "ImmutableContract",
          auth: "authKey",
          components: [],
        })
      ).rejects.toThrow("Contract creation requires a 'seed'");
    });

    it("throws when auth is missing", async () => {
      const resource = makeResource();
      await expect(
        resource.create({
          type: "ImmutableContract",
          seed: new Uint8Array(32),
          components: [],
        })
      ).rejects.toThrow("Contract creation requires an 'auth'");
    });

    it("creates immutable contract", async () => {
      const resource = makeResource();
      const seed = new Uint8Array(32).fill(1);
      const result = await resource.create({
        type: "ImmutableContract",
        seed,
        auth: "authKey",
        components: [],
      });
      expect(wasm.AccountComponent.createAuthComponentFromSecretKey).toHaveBeenCalledWith("authKey");
      expect(wasm.AccountBuilder).toHaveBeenCalledWith(seed);
      const builderInstance = wasm.AccountBuilder.mock.results[0].value;
      expect(builderInstance.accountType).toHaveBeenCalledWith(0); // ImmutableCode
      expect(inner.newAccountWithSecretKey).toHaveBeenCalled();
      expect(result).toEqual({ id: expect.any(Function) });
    });

    it("creates mutable contract when type='MutableContract'", async () => {
      const resource = makeResource();
      const seed = new Uint8Array(32).fill(2);
      await resource.create({
        type: "MutableContract",
        seed,
        auth: "authKey",
        components: [],
      });
      const builderInstance = wasm.AccountBuilder.mock.results[0].value;
      expect(builderInstance.accountType).toHaveBeenCalledWith(1); // UpdatableCode
    });

    it("creates contract when opts.components is present (no type)", async () => {
      const resource = makeResource();
      await resource.create({
        seed: new Uint8Array(32),
        auth: "authKey",
        components: ["comp1"],
      });
      const builderInstance = wasm.AccountBuilder.mock.results[0].value;
      expect(builderInstance.withComponent).toHaveBeenCalledWith("comp1");
    });

    it("defaults opts.components to [] when not specified", async () => {
      const resource = makeResource();
      // ImmutableContract with no components — tests the `opts.components ?? []` branch
      await resource.create({
        type: "ImmutableContract",
        seed: new Uint8Array(32),
        auth: "authKey",
        // no components specified
      });
      const builderInstance = wasm.AccountBuilder.mock.results[0].value;
      expect(builderInstance.withComponent).not.toHaveBeenCalled();
    });
  });

  describe("insert", () => {
    it("calls assertNotTerminated and newAccount", async () => {
      const account = { id: () => "accId" };
      const resource = makeResource();
      await resource.insert({ account, overwrite: true });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.newAccount).toHaveBeenCalledWith(account, true);
    });

    it("defaults overwrite to false", async () => {
      const account = { id: () => "accId" };
      const resource = makeResource();
      await resource.insert({ account });
      expect(inner.newAccount).toHaveBeenCalledWith(account, false);
    });
  });

  describe("get", () => {
    it("resolves hex account ref and returns account", async () => {
      inner.getAccount.mockResolvedValue("accountObj");
      const resource = makeResource();
      const result = await resource.get("0xaccHex");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0xaccHex");
      expect(result).toBe("accountObj");
    });

    it("returns null when account not found", async () => {
      inner.getAccount.mockResolvedValue(undefined);
      const resource = makeResource();
      const result = await resource.get("0xmissing");
      expect(result).toBeNull();
    });

    it("resolves Account object with .id() method", async () => {
      const accountObj = { id: vi.fn().mockReturnValue("resolvedId") };
      inner.getAccount.mockResolvedValue("found");
      const resource = makeResource();
      await resource.get(accountObj);
      expect(accountObj.id).toHaveBeenCalledOnce();
    });
  });

  describe("list", () => {
    it("calls assertNotTerminated and returns all accounts", async () => {
      const resource = makeResource();
      const result = await resource.list();
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.getAccounts).toHaveBeenCalledOnce();
      expect(result).toEqual(["acc1", "acc2"]);
    });
  });

  describe("getDetails", () => {
    it("returns account details with keys, vault, storage, code", async () => {
      const fakeAccount = {
        vault: vi.fn().mockReturnValue("vault"),
        storage: vi.fn().mockReturnValue("storage"),
        code: vi.fn().mockReturnValue("code"),
      };
      inner.getAccount.mockResolvedValue(fakeAccount);
      inner.keystore.getCommitments.mockResolvedValue(["key1"]);
      const resource = makeResource();
      const result = await resource.getDetails("0xaccHex");
      expect(result).toEqual({
        account: fakeAccount,
        vault: "vault",
        storage: "storage",
        code: "code",
        keys: ["key1"],
      });
    });

    it("returns null for code when account.code() returns null", async () => {
      const fakeAccount = {
        vault: vi.fn().mockReturnValue("vault"),
        storage: vi.fn().mockReturnValue("storage"),
        code: vi.fn().mockReturnValue(null),
      };
      inner.getAccount.mockResolvedValue(fakeAccount);
      const resource = makeResource();
      const result = await resource.getDetails("0xaccHex");
      expect(result.code).toBeNull();
    });

    it("throws when account not found", async () => {
      inner.getAccount.mockResolvedValue(undefined);
      const resource = makeResource();
      await expect(resource.getDetails("0xmissing")).rejects.toThrow(
        "Account not found"
      );
    });
  });

  describe("getBalance", () => {
    it("resolves both account and faucet refs and calls accountReader", async () => {
      const reader = { getBalance: vi.fn().mockResolvedValue(BigInt(50)) };
      inner.accountReader.mockReturnValue(reader);
      const resource = makeResource();
      const result = await resource.getBalance("0xaccHex", "0xfaucetHex");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(reader.getBalance).toHaveBeenCalled();
      expect(result).toBe(BigInt(50));
    });
  });

  describe("getOrImport", () => {
    it("returns account from get() if found", async () => {
      inner.getAccount.mockResolvedValue("existing");
      const resource = makeResource();
      const result = await resource.getOrImport("0xaccHex");
      expect(result).toBe("existing");
    });

    it("falls back to import() when get() returns null", async () => {
      inner.getAccount
        .mockResolvedValueOnce(undefined) // get() call
        .mockResolvedValueOnce("imported"); // import() -> get() call
      inner.importAccountById.mockResolvedValue(undefined);
      const resource = makeResource();
      const result = await resource.getOrImport("0xaccHex");
      expect(inner.importAccountById).toHaveBeenCalledOnce();
      expect(result).toBe("imported");
    });
  });

  describe("import", () => {
    it("imports by string ref (non-hex = bech32)", async () => {
      inner.getAccount.mockResolvedValue("found");
      const resource = makeResource();
      const result = await resource.import("mBech32Account");
      expect(wasm.AccountId.fromBech32).toHaveBeenCalledWith("mBech32Account");
      expect(inner.importAccountById).toHaveBeenCalledOnce();
      expect(result).toBe("found");
    });

    it("imports by hex string", async () => {
      inner.getAccount.mockResolvedValue("found");
      const resource = makeResource();
      await resource.import("0xaccHex");
      expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0xaccHex");
      expect(inner.importAccountById).toHaveBeenCalledOnce();
    });

    it("imports by Account object (has .id() method)", async () => {
      const accountObj = {
        id: vi.fn().mockReturnValue({ hex: "0xid", toString: () => "0xid" }),
      };
      inner.getAccount.mockResolvedValue("found");
      const resource = makeResource();
      await resource.import(accountObj);
      expect(accountObj.id).toHaveBeenCalledOnce();
      expect(inner.importAccountById).toHaveBeenCalledOnce();
    });

    it("imports AccountFile via importAccountFile when input.file provided", async () => {
      const accountId = { toString: () => "0xaccId" };
      const file = {
        accountId: vi.fn().mockReturnValue(accountId),
      };
      inner.getAccount.mockResolvedValue("imported");
      const resource = makeResource();
      const result = await resource.import({ file });
      expect(inner.importAccountFile).toHaveBeenCalledWith(file);
      expect(inner.getAccount).toHaveBeenCalledWith(accountId);
      expect(result).toBe("imported");
    });

    it("throws when AccountFile has no accountId method", async () => {
      const file = {}; // no accountId()
      const resource = makeResource();
      await expect(resource.import({ file })).rejects.toThrow(
        "Could not determine account ID"
      );
    });

    it("imports public account from seed", async () => {
      inner.importPublicAccountFromSeed.mockResolvedValue("seedImport");
      const seed = new Uint8Array(32);
      const resource = makeResource();
      const result = await resource.import({ seed });
      expect(inner.importPublicAccountFromSeed).toHaveBeenCalledWith(
        seed,
        true, // mutable default
        2 // falcon
      );
      expect(result).toBe("seedImport");
    });

    it("imports seed with explicit ImmutableWallet type", async () => {
      inner.importPublicAccountFromSeed.mockResolvedValue("seedImport");
      const seed = new Uint8Array(32);
      const resource = makeResource();
      await resource.import({ seed, type: "ImmutableWallet" });
      expect(inner.importPublicAccountFromSeed).toHaveBeenCalledWith(
        seed,
        false,
        2
      );
    });

    it("fallback: imports plain object as AccountRef", async () => {
      // A plain AccountId-like object (no .id() method, no .file, no .seed)
      const plainId = { toString: () => "0xplain" };
      inner.getAccount.mockResolvedValue("found");
      const resource = makeResource();
      // Need to give it something that resolveAccountRef will handle as AccountId pass-through
      await resource.import(plainId);
      expect(inner.importAccountById).toHaveBeenCalledOnce();
    });
  });

  describe("export", () => {
    it("resolves account ref and exports file", async () => {
      inner.exportAccountFile.mockResolvedValue("file");
      const resource = makeResource();
      const result = await resource.export("0xaccHex");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.exportAccountFile).toHaveBeenCalled();
      expect(result).toBe("file");
    });
  });

  describe("addAddress", () => {
    it("resolves account and address, then inserts", async () => {
      const resource = makeResource();
      await resource.addAddress("0xaccHex", "mBech32Addr");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(wasm.Address.fromBech32).toHaveBeenCalledWith("mBech32Addr");
      expect(inner.insertAccountAddress).toHaveBeenCalled();
    });
  });

  describe("removeAddress", () => {
    it("resolves account and address, then removes", async () => {
      const resource = makeResource();
      await resource.removeAddress("0xaccHex", "mBech32Addr");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(wasm.Address.fromBech32).toHaveBeenCalledWith("mBech32Addr");
      expect(inner.removeAccountAddress).toHaveBeenCalled();
    });
  });
});
