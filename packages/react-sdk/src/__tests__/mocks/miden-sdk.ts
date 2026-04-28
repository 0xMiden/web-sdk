import { vi } from "vitest";

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

export const createMockTransactionId = (id: string = "0xtx123") => ({
  toString: vi.fn(() => id),
  toHex: vi.fn(() => id),
  asElements: vi.fn(() => []),
  asBytes: vi.fn(() => new Uint8Array()),
  inner: vi.fn(() => createMockWord(id)),
  free: vi.fn(),
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
  serialize: vi.fn(() => new Uint8Array()),
  free: vi.fn(),
  [Symbol.dispose]: vi.fn(),
});

// Mock FeltArray
export const createMockFeltArray = (length: number = 16) => ({
  length: vi.fn(() => length),
  get: vi.fn((i: number) => ({
    asInt: vi.fn(() => BigInt(i)),
  })),
});

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

    // Transaction methods
    newMintTransactionRequest: vi
      .fn()
      .mockReturnValue(createMockTransactionRequest()),
    newSendTransactionRequest: vi
      .fn()
      .mockReturnValue(createMockTransactionRequest()),
    newConsumeTransactionRequest: vi
      .fn()
      .mockReturnValue(createMockTransactionRequest()),
    newSwapTransactionRequest: vi
      .fn()
      .mockReturnValue(createMockTransactionRequest()),
    submitNewTransaction: vi.fn().mockResolvedValue(createMockTransactionId()),
    submitNewTransactionWithProver: vi
      .fn()
      .mockResolvedValue(createMockTransactionId()),
    executeTransaction: vi
      .fn()
      .mockResolvedValue(createMockTransactionResult()),
    proveTransaction: vi.fn().mockResolvedValue({}),
    proveTransactionWithProver: vi.fn().mockResolvedValue({}),
    submitProvenTransaction: vi.fn().mockResolvedValue(0),
    applyTransaction: vi.fn().mockResolvedValue({}),
    sendPrivateNote: vi.fn().mockResolvedValue(undefined),
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

  return { ...defaultClient, ...overrides };
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
  newConsumeTransactionRequest: ReturnType<typeof vi.fn>;
  newSwapTransactionRequest: ReturnType<typeof vi.fn>;
  submitNewTransaction: ReturnType<typeof vi.fn>;
  submitNewTransactionWithProver: ReturnType<typeof vi.fn>;
  executeTransaction: ReturnType<typeof vi.fn>;
  proveTransaction: ReturnType<typeof vi.fn>;
  proveTransactionWithProver: ReturnType<typeof vi.fn>;
  submitProvenTransaction: ReturnType<typeof vi.fn>;
  applyTransaction: ReturnType<typeof vi.fn>;
  sendPrivateNote: ReturnType<typeof vi.fn>;
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
