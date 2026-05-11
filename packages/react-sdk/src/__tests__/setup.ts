import { vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Mock the entire @miden-sdk/miden-sdk module before any imports
vi.mock("@miden-sdk/miden-sdk/lazy", () => {
  const createMockAccountId = (id: string = "0x1234567890abcdef") => ({
    toString: vi.fn(() => id),
    toHex: vi.fn(() => id),
    isFaucet: vi.fn(() => id.startsWith("0x2")),
    isRegularAccount: vi.fn(() => !id.startsWith("0x2")),
    free: vi.fn(),
  });

  const mockClient = {
    getAccounts: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue(null),
    newWallet: vi.fn().mockResolvedValue({}),
    newFaucet: vi.fn().mockResolvedValue({}),
    newAccount: vi.fn().mockResolvedValue(undefined),
    syncState: vi.fn().mockResolvedValue({ blockNum: vi.fn(() => 100) }),
    getSyncHeight: vi.fn().mockResolvedValue(100),
    getInputNotes: vi.fn().mockResolvedValue([]),
    getConsumableNotes: vi.fn().mockResolvedValue([]),
    getTransactions: vi.fn().mockResolvedValue([
      {
        id: vi.fn(() => ({ toHex: vi.fn(() => "0xtx") })),
        transactionStatus: vi.fn(() => ({
          isPending: vi.fn(() => false),
          isCommitted: vi.fn(() => true),
          isDiscarded: vi.fn(() => false),
        })),
      },
    ]),
    newMintTransactionRequest: vi.fn().mockReturnValue({}),
    newSendTransactionRequest: vi.fn().mockReturnValue({}),
    newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
    newSwapTransactionRequest: vi.fn().mockReturnValue({}),
    submitNewTransaction: vi
      .fn()
      .mockResolvedValue({ toHex: vi.fn(() => "0xtx") }),
    executeTransaction: vi.fn().mockResolvedValue({}),
    proveTransaction: vi.fn().mockResolvedValue({}),
    proveTransactionWithProver: vi.fn().mockResolvedValue({}),
    submitProvenTransaction: vi.fn().mockResolvedValue(0),
    applyTransaction: vi.fn().mockResolvedValue({}),
    sendPrivateNote: vi.fn(async (note: unknown, _addr: unknown) => {
      // Any method call against a moved wasm-bindgen handle crashes with
      // "null pointer passed to rust"; mirror that here so move-after-use
      // bugs (e.g. building a NoteArray via Vec<Note> ctor then re-reading
      // the source notes) are caught in unit tests.
      if (
        note &&
        typeof note === "object" &&
        (note as { _live?: boolean })._live === false
      ) {
        throw new Error("null pointer passed to rust");
      }
      return undefined;
    }),
    exportStore: vi.fn().mockResolvedValue({ tables: {} }),
    forceImportStore: vi.fn().mockResolvedValue(undefined),
    exportNoteFile: vi
      .fn()
      .mockResolvedValue({ serialize: () => new Uint8Array([1, 2, 3]) }),
    importNoteFile: vi
      .fn()
      .mockResolvedValue({ toString: () => "0xnote_imported" }),
    importAccountFile: vi.fn().mockResolvedValue("Imported account"),
    importAccountById: vi.fn().mockResolvedValue(undefined),
    importPublicAccountFromSeed: vi.fn().mockResolvedValue({}),
    exportAccountFile: vi
      .fn()
      .mockResolvedValue({ serialize: () => new Uint8Array() }),
    signCb: null as
      | ((pubKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>)
      | null,
    setSignCb: vi.fn(),
    free: vi.fn(),
  };

  const WebClient = Object.assign(
    vi.fn().mockImplementation(() => mockClient),
    {
      createClient: vi.fn().mockResolvedValue(mockClient),
      createClientWithExternalKeystore: vi.fn().mockResolvedValue(mockClient),
    }
  );

  class Endpoint {
    constructor(_url?: string) {}
    static testnet() {
      return new Endpoint();
    }
  }

  class RpcClient {
    constructor(_endpoint: unknown) {}
    getAccountDetails = vi.fn().mockResolvedValue({ account: () => null });
  }

  return {
    AuthScheme: {
      Falcon: "falcon",
      ECDSA: "ecdsa",
    },
    resolveAuthScheme: vi.fn((scheme?: string) => {
      if (scheme === "ecdsa") return 1;
      if (scheme === "falcon" || scheme == null) return 2;
      throw new Error(`Unknown scheme: ${scheme}`);
    }),
    WebClient,
    WasmWebClient: WebClient,
    AccountId: {
      fromHex: vi.fn((hex: string) => createMockAccountId(hex)),
      fromBech32: vi.fn((bech32: string) => createMockAccountId(bech32)),
    },
    Address: {
      fromBech32: vi.fn((bech32: string) => ({
        accountId: vi.fn(() => createMockAccountId(bech32)),
        toString: vi.fn(() => bech32),
      })),
      fromAccountId: vi.fn(
        (accountId: ReturnType<typeof createMockAccountId>) => ({
          accountId: vi.fn(() => accountId),
          toString: vi.fn(() => accountId.toString()),
        })
      ),
    },
    Endpoint,
    RpcClient,
    BasicFungibleFaucetComponent: {
      fromAccount: vi.fn(() => ({
        symbol: vi.fn(() => ({ toString: () => "TKN" })),
        decimals: vi.fn(() => 0),
      })),
    },
    NoteId: {
      // Mirror the wasm-bindgen ownership model: a NoteId handle becomes
      // unusable once the underlying Rust value is moved out of it (e.g.
      // by the NoteFilter constructor's `Vec<NoteId>` ABI). Reads after
      // that point throw, matching the real WASM behavior.
      fromHex: vi.fn((hex: string) => {
        const handle = {
          _hex: hex,
          _live: true,
          toString() {
            if (!this._live) throw new Error("invalid NoteId handle");
            return this._hex;
          },
        };
        return handle;
      }),
    },
    AccountStorageMode: {
      private: vi.fn(() => ({ type: "private" })),
      public: vi.fn(() => ({ type: "public" })),
      network: vi.fn(() => ({ type: "network" })),
    },
    NoteType: {
      Private: 2,
      Public: 1,
      Encrypted: 3,
    },
    Note: {
      createP2IDNote: vi.fn(
        (
          sender: ReturnType<typeof createMockAccountId>,
          receiver: ReturnType<typeof createMockAccountId>,
          assets: unknown,
          noteType: number,
          attachment: unknown
        ) => ({
          _live: true,
          id() {
            if (!this._live) throw new Error("invalid Note handle");
            return { toString: () => "0xnote" };
          },
          sender,
          receiver,
          assets,
          noteType,
          attachment,
        })
      ),
    },
    NoteAssets: class NoteAssets {
      assets: unknown[];
      constructor(assets: unknown[]) {
        this.assets = assets;
      }
    },
    FungibleAsset: class FungibleAsset {
      faucetId: ReturnType<typeof createMockAccountId>;
      amount: bigint;
      constructor(
        faucetId: ReturnType<typeof createMockAccountId>,
        amount: bigint
      ) {
        this.faucetId = faucetId;
        this.amount = amount;
      }
    },
    NoteAttachmentKind: {
      None: 0,
      Word: 1,
      Array: 2,
    },
    NoteAttachmentScheme: {
      none: vi.fn(() => ({ type: "none" })),
    },
    Word: Object.assign(
      class Word {
        values: BigUint64Array;
        constructor(values: BigUint64Array) {
          this.values = values;
        }
        toU64s() {
          return Array.from(this.values);
        }
      },
      {
        deserialize: vi.fn(
          () =>
            new (class Word {
              values = new BigUint64Array(4);
            })()
        ),
      }
    ),
    NoteAttachment: Object.assign(class NoteAttachment {}, {
      newWord: vi.fn(
        (_scheme: unknown, _word: unknown) => new (class NoteAttachment {})()
      ),
      newArray: vi.fn(
        (_scheme: unknown, _words: unknown[]) => new (class NoteAttachment {})()
      ),
    }),
    NoteArray: class NoteArray {
      notes: unknown[];
      constructor(notes?: unknown[]) {
        // Mirror the wasm-bindgen Vec<Note> ABI: the constructor MOVES each
        // element out of its JS handle, leaving it unusable. push(&note)
        // borrows and keeps the handle valid.
        this.notes = notes ?? [];
        if (notes) {
          for (const n of notes) {
            if (n && typeof n === "object") {
              (n as { _live?: boolean })._live = false;
            }
          }
        }
      }
      push(note: unknown) {
        this.notes.push(note);
      }
    },
    NoteAndArgs: class NoteAndArgs {
      note: unknown;
      args: unknown;
      constructor(note: unknown, args: unknown) {
        this.note = note;
        this.args = args;
      }
    },
    NoteAndArgsArray: class NoteAndArgsArray {
      notes: unknown[];
      constructor(notes: unknown[]) {
        this.notes = notes;
      }
    },
    TransactionRequestBuilder: class TransactionRequestBuilder {
      withOwnOutputNotes = vi.fn(() => this);
      withInputNotes = vi.fn(() => this);
      build = vi.fn(() => ({}));
    },
    NoteFile: {
      deserialize: vi.fn(() => ({ noteId: "0xnote_deserialized" })),
    },
    NoteExportFormat: {
      Full: "Full",
      Partial: "Partial",
    },
    TransactionProver: {
      newLocalProver: vi.fn(() => ({ type: "local" })),
      newRemoteProver: vi.fn((url: string, timeout: unknown) => ({
        type: "remote",
        url,
        timeout,
      })),
    },
    AdviceInputs: class AdviceInputs {},
    ForeignAccount: Object.assign(class ForeignAccount {}, {
      public: vi.fn(
        (_id: unknown, _storage: unknown) => new (class ForeignAccount {})()
      ),
    }),
    ForeignAccountArray: class ForeignAccountArray {
      constructor(_accounts?: unknown[]) {}
    },
    AccountStorageRequirements: class AccountStorageRequirements {},
    NoteFilter: vi.fn().mockImplementation((_type: unknown, ids?: unknown) => {
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (id && typeof id === "object") {
            (id as { _live?: boolean })._live = false;
          }
        }
      }
      return { free: vi.fn() };
    }),
    NoteFilterTypes: {
      All: 0,
      Consumed: 1,
      Committed: 2,
      Expected: 3,
      Processing: 4,
      List: 5,
      Unique: 6,
      Nullifiers: 7,
      Unverified: 8,
    },
    TransactionId: {
      fromHex: vi.fn((hex: string) => ({
        toString: vi.fn(() => hex),
        toHex: vi.fn(() => hex),
        free: vi.fn(),
      })),
    },
    TransactionFilter: {
      all: vi.fn(() => ({})),
      uncommitted: vi.fn(() => ({})),
      ids: vi.fn((ids: unknown) => ({ ids })),
    },
    AccountFile: class AccountFile {
      account() {
        return {};
      }
      accountId() {
        return createMockAccountId("0ximported");
      }
      authSecretKeyCount() {
        return 1;
      }
      serialize() {
        return new Uint8Array();
      }
      static deserialize() {
        return new AccountFile();
      }
    },
    AccountType: {
      RegularAccountImmutableCode: 0,
      RegularAccountUpdatableCode: 1,
      FungibleFaucet: 2,
      NonFungibleFaucet: 3,
    },
    AccountBuilder: class AccountBuilder {
      _seed: Uint8Array;
      constructor(seed: Uint8Array) {
        this._seed = seed;
      }
      withAuthComponent() {
        return this;
      }
      accountType() {
        return this;
      }
      storageMode() {
        return this;
      }
      withBasicWalletComponent() {
        return this;
      }
      withComponent() {
        return this;
      }
      build() {
        const mockAccount = {
          id: vi.fn(() => createMockAccountId("0xsigner_account")),
        };
        return { account: mockAccount };
      }
    },
    AccountComponent: {
      createAuthComponentFromCommitment: vi.fn(() => ({})),
    },
  };
});

// Cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Reset modules before each test
beforeEach(() => {
  vi.resetModules();
});

// Mock ResizeObserver for jsdom
(globalThis as typeof globalThis & { ResizeObserver: unknown }).ResizeObserver =
  vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
