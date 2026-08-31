import { vi } from "vitest";
import type {
  AdviceMap,
  BlockHeader,
  TransactionRequest,
} from "@miden-sdk/miden-sdk";

// Mock AccountId
export const createMockAccountId = (id: string = "0x1234567890abcdef") => ({
  toString: vi.fn(() => id),
  toHex: vi.fn(() => id),
  isFaucet: vi.fn(() => id.startsWith("0x2")),
  isRegularAccount: vi.fn(() => !id.startsWith("0x2")),
  free: vi.fn(),
});

// Mock Account
export const createMockAccount = (
  overrides: Partial<ReturnType<typeof createMockAccountBase>> = {}
) => {
  const base = createMockAccountBase();
  return { ...base, ...overrides };
};

const createMockAccountBase = () => ({
  id: vi.fn(() => createMockAccountId()),
  nonce: vi.fn(() => ({ toString: () => "1" })),
  commitment: vi.fn(() => ({ toString: () => "0xcommitment" })),
  vault: vi.fn(() => createMockVault()),
  storage: vi.fn(() => ({})),
  code: vi.fn(() => ({})),
  isFaucet: vi.fn(() => false),
  isRegularAccount: vi.fn(() => true),
  isUpdatable: vi.fn(() => true),
  isPublic: vi.fn(() => false),
  isPrivate: vi.fn(() => true),
  isNetwork: vi.fn(() => false),
  isNew: vi.fn(() => false),
  getPublicKeys: vi.fn(() => []),
  free: vi.fn(),
});

// Mock AccountHeader
export const createMockAccountHeader = (id: string = "0x1234567890abcdef") => ({
  id: vi.fn(() => createMockAccountId(id)),
  commitment: vi.fn(() => ({ toString: () => "0xcommitment" })),
  nonce: vi.fn(() => ({ toString: () => "1" })),
  vaultCommitment: vi.fn(() => ({ toString: () => "0xvault" })),
  storageCommitment: vi.fn(() => ({ toString: () => "0xstorage" })),
  codeCommitment: vi.fn(() => ({ toString: () => "0xcode" })),
  free: vi.fn(),
});

// Mock AccountFile
export const createMockAccountFile = (account = createMockAccount()) => ({
  accountId: vi.fn(() => account.id()),
  account: vi.fn(() => account),
  authSecretKeyCount: vi.fn(() => 1),
  serialize: vi.fn(() => new Uint8Array()),
  free: vi.fn(),
});

// Mock AssetVault
export const createMockVault = (
  assets: Array<{ faucetId: string; amount: bigint }> = []
) => ({
  fungibleAssets: vi.fn(() =>
    assets.map((a) => ({
      faucetId: vi.fn(() => createMockAccountId(a.faucetId)),
      amount: vi.fn(() => a.amount),
      free: vi.fn(),
    }))
  ),
  root: vi.fn(() => ({ toString: () => "0xroot" })),
  free: vi.fn(),
});

// Mock Note
export const createMockNote = (id: string = "0xnote1") => ({
  id: vi.fn(() => ({ toString: () => id })),
  free: vi.fn(),
});

const createMockOutputNote = (note = createMockNote()) => ({
  intoFull: vi.fn(() => note),
});

export const createMockTransactionResult = (
  id: string = "0xtx123",
  note = createMockNote()
) => ({
  id: vi.fn(() => createMockTransactionId(id)),
  executedTransaction: vi.fn(() => ({
    outputNotes: vi.fn(() => ({
      notes: vi.fn(() => [createMockOutputNote(note)]),
    })),
  })),
  serialize: vi.fn(() => new Uint8Array()),
});

// Mock InputNoteRecord
export const createMockInputNoteRecord = (
  id: string = "0xnote1",
  consumed: boolean = false,
  noteOverride?: ReturnType<typeof createMockNote>
) => {
  const note = noteOverride ?? createMockNote(id);

  return {
    id: vi.fn(() => ({ toString: () => id, toHex: () => id })),
    state: vi.fn(() => (consumed ? "consumed" : "committed")),
    details: vi.fn(() => ({})),
    metadata: vi.fn(() => ({})),
    commitment: vi.fn(() => ({ toString: () => "0xcommitment" })),
    inclusionProof: vi.fn(() => null),
    consumerTransactionId: vi.fn(() => (consumed ? "0xtx" : null)),
    nullifier: vi.fn(() => "0xnullifier"),
    isAuthenticated: vi.fn(() => true),
    isConsumed: vi.fn(() => consumed),
    isProcessing: vi.fn(() => false),
    toNote: vi.fn(() => note),
    free: vi.fn(),
  };
};

// Mock ConsumableNoteRecord
export const createMockConsumableNoteRecord = (noteId: string = "0xnote1") => ({
  inputNoteRecord: vi.fn(() => createMockInputNoteRecord(noteId)),
  noteConsumability: vi.fn(() => [
    {
      accountId: vi.fn(() => createMockAccountId()),
      consumableAfterBlock: vi.fn(() => null),
    },
  ]),
  free: vi.fn(),
});

// Mock SyncSummary
export const createMockSyncSummary = (blockNum: number = 100) => ({
  blockNum: vi.fn(() => blockNum),
  committedNotes: vi.fn(() => []),
  consumedNotes: vi.fn(() => []),
  updatedAccounts: vi.fn(() => []),
  committedTransactions: vi.fn(() => []),
  free: vi.fn(),
});

// Mock TransactionId
const createMockWord = (hex: string = "0xword") => ({
  free: vi.fn(),
  toHex: vi.fn(() => hex),
  serialize: vi.fn(() => new Uint8Array()),
  toU64s: vi.fn(() => new BigUint64Array()),
  toFelts: vi.fn(() => []),
  [Symbol.dispose]: vi.fn(),
});

// Real WASM `TransactionId` exposes only `toHex()` (no `to_string` binding) —
// callers that reach for `.toString()` hit Object.prototype's default and get
// "[object Object]" (issue #83). Mirror that here so any future hook that
// regresses to `.toString()` fails the unit tests instead of silently passing.
export const createMockTransactionId = (id: string = "0xtx123") => ({
  toString: vi.fn(() => "[object Object]"),
  toHex: vi.fn(() => id),
  asElements: vi.fn(() => []),
  asBytes: vi.fn(() => new Uint8Array()),
  inner: vi.fn(() => createMockWord(id)),
  free: vi.fn(),
  // TS 5.2+ ships [Symbol.dispose] on Disposable WASM bindings; tsc requires
  // mocks to expose it even if tests never invoke it.
  [Symbol.dispose]: vi.fn(),
});

// Mock TransactionRecord
const createMockTransactionRecord = (
  status: "committed" | "pending" | "discarded" = "committed"
) => ({
  id: vi.fn(() => createMockTransactionId()),
  transactionStatus: vi.fn(() => ({
    isPending: vi.fn(() => status === "pending"),
    isCommitted: vi.fn(() => status === "committed"),
    isDiscarded: vi.fn(() => status === "discarded"),
  })),
});

// Mock TransactionRequest
export const createMockTransactionRequest = () => ({
  expectedOutputOwnNotes: vi.fn(() => []),
  expectedFutureNotes: vi.fn(() => []),
  scriptArg: vi.fn(() => undefined),
  authArg: vi.fn(() => undefined),
  // Returns a request rather than mutating, like `extendAdviceMap`: the real
  // `withAuthArg` clones and is chained, so a mock returning undefined would
  // make any chained call in a test read as a null deref rather than a
  // missing mock.
  withAuthArg: vi.fn(
    () => createMockTransactionRequest() as unknown as TransactionRequest
  ),
  adviceMap: vi.fn(() => ({}) as unknown as AdviceMap),
  extendAdviceMap: vi.fn(
    () => createMockTransactionRequest() as unknown as TransactionRequest
  ),
  serialize: vi.fn(() => new Uint8Array()),
  free: vi.fn(),
  [Symbol.dispose]: vi.fn(),
});

// Mock ChainAnchor. The real binding takes the anchor by reference, so a single
// handle survives the capture → preview → execute sequence; the mock is
// deliberately reusable to match.
export const createMockChainAnchor = (blockNum: number = 100) => ({
  blockNum: vi.fn(() => blockNum),
  commitment: vi.fn(() => createMockWord(`0xanchor${blockNum}`)),
  blockHeader: vi.fn(
    () => ({ blockNum: vi.fn(() => blockNum) }) as unknown as BlockHeader
  ),
  serialize: vi.fn(() => new Uint8Array()),
  free: vi.fn(),
  [Symbol.dispose]: vi.fn(),
});

// Mock TransactionSummary
export const createMockTransactionSummary = (
  commitment: string = "0xsummary",
  blockCommitment: string = "0xblock"
) => ({
  toCommitment: vi.fn(() => createMockWord(commitment)),
  blockCommitment: vi.fn(() => createMockWord(blockCommitment)),
  expirationDelta: vi.fn(() => 256),
  accountDelta: vi.fn(() => ({})),
  inputNotes: vi.fn(() => ({})),
  outputNotes: vi.fn(() => ({})),
  userParams: vi.fn(() => []),
  serialize: vi.fn(() => new Uint8Array()),
  free: vi.fn(),
  [Symbol.dispose]: vi.fn(),
});

// Mock PswapLineageRecord
export const createMockPswapLineageRecord = (
  orderId: string = "42",
  overrides: Record<string, unknown> = {}
) => ({
  orderId: vi.fn(() => orderId),
  creatorAccountId: vi.fn(() => createMockAccountId()),
  remainingOffered: vi.fn(() => 100n),
  remainingRequested: vi.fn(() => 50n),
  currentDepth: vi.fn(() => 0),
  currentTipNoteId: vi.fn(() => ({ toString: () => "0xtip" })),
  state: vi.fn(() => 0),
  free: vi.fn(),
  ...overrides,
});

// Mock FeltArray
export const createMockFeltArray = (length: number = 16) => ({
  length: vi.fn(() => length),
  get: vi.fn((i: number) => ({
    asInt: vi.fn(() => BigInt(i)),
  })),
});

/**
 * Rejects a thenable where a `TransactionRequest` is expected.
 *
 * Every `new*TransactionRequest` binding is `async fn` in Rust, so a caller that
 * forgets the `await` passes a Promise on to the next WASM call. Real
 * wasm-bindgen rejects that ("expected instance of TransactionRequest"); a mock
 * that resolves but accepts anything downstream does not, which let a dropped
 * `await` in `useConsume` and `useSessionAccount` reach production unnoticed.
 * Mirror the real failure so the suite can see it.
 */
const assertIsRequest = (request: unknown, method: string) => {
  if (request && typeof (request as { then?: unknown }).then === "function") {
    throw new Error(
      `${method}: expected instance of TransactionRequest, got a Promise — ` +
        `the request constructor's result was not awaited`
    );
  }
};

/**
 * Every method that takes a `TransactionRequest`, and the argument position the
 * request sits in.
 */
const REQUEST_ARG_POSITION: Record<string, number> = {
  submitNewTransaction: 1,
  submitNewTransactionWithProver: 1,
  executeTransaction: 1,
  executeTransactionAt: 1,
  executeForSummary: 1,
  executeForSummaryAt: 1,
  chainAnchorForRequest: 0,
};

/**
 * Every binding that is `async fn` in Rust and hands back something a later
 * WASM call consumes, so a caller who drops the `await` passes on a Promise.
 */
const ASYNC_IN_RUST = [
  "newMintTransactionRequest",
  "newSendTransactionRequest",
  "newB2AggTransactionRequest",
  "newConsumeTransactionRequest",
  "newSwapTransactionRequest",
  "newPswapCreateTransactionRequest",
  "newPswapConsumeTransactionRequest",
  "newPswapCancelTransactionRequest",
  "buildPswapCancelByOrder",
  "feeAwareTransactionRequestBuilder",
];

/**
 * Re-applies the dropped-`await` guards after overrides are merged in.
 *
 * Guarding only the defaults is not enough, because the merge is a spread, and
 * the two halves fail independently:
 *
 * - A test supplying its own `executeTransaction` / `submitNewTransaction`
 *   replaces the guarded implementation with a permissive one, so a Promise
 *   reaching it is accepted again.
 * - A test supplying a *synchronous* constructor mock means a dropped `await`
 *   never produces a Promise in the first place, so there is nothing for the
 *   consumer guard to reject. Production returns one; the mock has to as well or
 *   the test is exercising a different program.
 *
 * Wrapping both families post-merge covers whichever implementation won. Each
 * wrapper is itself a `vi.fn` delegating to that implementation, so assertions
 * and `mock.calls` on the returned client keep working.
 */
const applyRequestGuards = (client: MockWebClientType): MockWebClientType => {
  const guarded = client as unknown as Record<string, unknown>;

  for (const method of ASYNC_IN_RUST) {
    const impl = guarded[method];
    if (typeof impl !== "function") continue;
    guarded[method] = vi.fn(async (...args: unknown[]) =>
      (impl as (...a: unknown[]) => unknown)(...args)
    );
  }

  for (const [method, argIndex] of Object.entries(REQUEST_ARG_POSITION)) {
    const impl = guarded[method];
    if (typeof impl !== "function") continue;
    guarded[method] = vi.fn(async (...args: unknown[]) => {
      assertIsRequest(args[argIndex], method);
      return (impl as (...a: unknown[]) => unknown)(...args);
    });
  }

  return client;
};

// Create a mock WebClient
export const createMockWebClient = (
  overrides: Partial<MockWebClientType> = {}
) => {
  const defaultClient: MockWebClientType = {
    // Initialization
    createClient: vi.fn().mockResolvedValue(undefined),

    // Account methods
    getAccounts: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue(null),
    newWallet: vi.fn().mockResolvedValue(createMockAccount()),
    newFaucet: vi
      .fn()
      .mockResolvedValue(createMockAccount({ isFaucet: vi.fn(() => true) })),

    // Sync methods
    syncState: vi.fn().mockResolvedValue(createMockSyncSummary()),
    getSyncHeight: vi.fn().mockResolvedValue(100),

    // Note methods
    getInputNotes: vi.fn().mockResolvedValue([]),
    getConsumableNotes: vi.fn().mockResolvedValue([]),
    getInputNote: vi.fn().mockResolvedValue(null),
    getTransactions: vi.fn().mockResolvedValue([createMockTransactionRecord()]),

    // Transaction methods. Every `new*TransactionRequest` below is an `async fn`
    // in Rust, so the mocks resolve rather than return. Resolving is not on its
    // own enough to catch a hook that drops the `await` — a permissive consumer
    // mock accepts the Promise happily — so the methods that take a request
    // (`submitNewTransaction*`, `executeTransaction*`, ...) reject a thenable
    // through `assertIsRequest` below.
    newMintTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    newSendTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    newB2AggTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    newConsumeTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    newSwapTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    newPswapCreateTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    feeAwareTransactionRequestBuilder: vi.fn().mockImplementation(async () => {
      const builder = {
        withOwnOutputNotes: vi.fn(() => builder),
        withInputNotes: vi.fn(() => builder),
        withCustomScript: vi.fn(() => builder),
        build: vi.fn(() => createMockTransactionRequest()),
      };
      return builder;
    }),
    newPswapConsumeTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    newPswapCancelTransactionRequest: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),
    submitNewTransaction: vi.fn(
      async (_accountId: unknown, request: unknown) => {
        assertIsRequest(request, "submitNewTransaction");
        return createMockTransactionId();
      }
    ),
    submitNewTransactionWithProver: vi.fn(
      async (_accountId: unknown, request: unknown) => {
        assertIsRequest(request, "submitNewTransactionWithProver");
        return createMockTransactionId();
      }
    ),

    // PSWAP lineage tracking
    getPswapLineages: vi.fn().mockResolvedValue([]),
    getPswapLineagesFor: vi.fn().mockResolvedValue([]),
    getPswapLineage: vi.fn().mockResolvedValue(null),
    buildPswapCancelByOrder: vi
      .fn()
      .mockResolvedValue(createMockTransactionRequest()),

    executeTransaction: vi.fn(async (_accountId: unknown, request: unknown) => {
      assertIsRequest(request, "executeTransaction");
      return createMockTransactionResult();
    }),
    executeTransactionAt: vi.fn(
      async (_accountId: unknown, request: unknown) => {
        assertIsRequest(request, "executeTransactionAt");
        return createMockTransactionResult();
      }
    ),
    executeForSummary: vi
      .fn()
      .mockResolvedValue(createMockTransactionSummary()),
    executeForSummaryAt: vi
      .fn()
      .mockResolvedValue(createMockTransactionSummary()),
    chainAnchorForRequest: vi.fn().mockResolvedValue(createMockChainAnchor()),
    proveTransaction: vi.fn().mockResolvedValue({}),
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
    sendPrivateOutputNote: vi.fn().mockResolvedValue(undefined),
    importAccountFile: vi.fn().mockResolvedValue("Imported account"),
    importAccountById: vi.fn().mockResolvedValue(undefined),
    importPublicAccountFromSeed: vi.fn().mockResolvedValue(createMockAccount()),
    exportAccountFile: vi.fn().mockResolvedValue(createMockAccountFile()),

    // Store operations
    storeIdentifier: vi.fn().mockReturnValue("TestStore"),

    // Note file operations
    exportNoteFile: vi
      .fn()
      .mockResolvedValue({ serialize: () => new Uint8Array([1, 2, 3]) }),
    importNoteFile: vi
      .fn()
      .mockResolvedValue({ toString: () => "0xnote_imported" }),

    // Signer
    setSignCb: vi.fn(),

    // Execute program
    executeProgram: vi.fn().mockResolvedValue(createMockFeltArray()),

    // Cleanup
    free: vi.fn(),
  };

  return applyRequestGuards({ ...defaultClient, ...overrides });
};

type MockWebClientType = {
  createClient: ReturnType<typeof vi.fn>;
  getAccounts: ReturnType<typeof vi.fn>;
  getAccount: ReturnType<typeof vi.fn>;
  newWallet: ReturnType<typeof vi.fn>;
  newFaucet: ReturnType<typeof vi.fn>;
  syncState: ReturnType<typeof vi.fn>;
  getSyncHeight: ReturnType<typeof vi.fn>;
  getInputNotes: ReturnType<typeof vi.fn>;
  getConsumableNotes: ReturnType<typeof vi.fn>;
  getInputNote: ReturnType<typeof vi.fn>;
  getTransactions: ReturnType<typeof vi.fn>;
  newMintTransactionRequest: ReturnType<typeof vi.fn>;
  newSendTransactionRequest: ReturnType<typeof vi.fn>;
  newB2AggTransactionRequest: ReturnType<typeof vi.fn>;
  newConsumeTransactionRequest: ReturnType<typeof vi.fn>;
  newSwapTransactionRequest: ReturnType<typeof vi.fn>;
  newPswapCreateTransactionRequest: ReturnType<typeof vi.fn>;
  newPswapConsumeTransactionRequest: ReturnType<typeof vi.fn>;
  newPswapCancelTransactionRequest: ReturnType<typeof vi.fn>;
  feeAwareTransactionRequestBuilder: ReturnType<typeof vi.fn>;
  submitNewTransaction: ReturnType<typeof vi.fn>;
  submitNewTransactionWithProver: ReturnType<typeof vi.fn>;
  getPswapLineages: ReturnType<typeof vi.fn>;
  getPswapLineagesFor: ReturnType<typeof vi.fn>;
  getPswapLineage: ReturnType<typeof vi.fn>;
  buildPswapCancelByOrder: ReturnType<typeof vi.fn>;
  executeTransaction: ReturnType<typeof vi.fn>;
  executeTransactionAt: ReturnType<typeof vi.fn>;
  executeForSummary: ReturnType<typeof vi.fn>;
  executeForSummaryAt: ReturnType<typeof vi.fn>;
  chainAnchorForRequest: ReturnType<typeof vi.fn>;
  proveTransaction: ReturnType<typeof vi.fn>;
  submitProvenTransaction: ReturnType<typeof vi.fn>;
  applyTransaction: ReturnType<typeof vi.fn>;
  sendPrivateNote: ReturnType<typeof vi.fn>;
  sendPrivateOutputNote: ReturnType<typeof vi.fn>;
  importAccountFile: ReturnType<typeof vi.fn>;
  importAccountById: ReturnType<typeof vi.fn>;
  importPublicAccountFromSeed: ReturnType<typeof vi.fn>;
  exportAccountFile: ReturnType<typeof vi.fn>;
  storeIdentifier: ReturnType<typeof vi.fn>;
  exportNoteFile: ReturnType<typeof vi.fn>;
  importNoteFile: ReturnType<typeof vi.fn>;
  setSignCb: ReturnType<typeof vi.fn>;
  executeProgram: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
};
