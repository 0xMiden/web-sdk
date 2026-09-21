import { Page } from "@playwright/test";
import { WebClient as WasmWebClient } from "../dist/crates/miden_client_web";
import {
  Account,
  AccountFile,
  AccountBuilder,
  AccountComponent,
  AccountDelta,
  AccountHeader,
  AccountId,
  AccountInterface,
  AccountStorageMode,
  AccountStorageRequirements,
  AccountType,
  Address,
  AddressInterface,
  AdviceMap,
  AuthFalcon512RpoMultisigConfig,
  AuthSecretKey,
  BasicFungibleFaucetComponent,
  ConsumableNoteRecord,
  Endpoint,
  Felt,
  FeltArray,
  ForeignAccount,
  FungibleAsset,
  InputNoteRecord,
  Library,
  NetworkId,
  Note,
  NoteAssets,
  NoteConsumability,
  NoteConsumptionStatus,
  NoteExecutionHint,
  NoteExportFormat,
  NoteScriptFee,
  NoteFilter,
  NoteFile,
  NoteFilterTypes,
  NoteId,
  NoteIdAndArgs,
  NoteIdAndArgsArray,
  NoteStorage,
  NoteMetadata,
  NoteRecipient,
  NoteTag,
  NoteType,
  OutputNote,
  OutputNotesArray,
  Package,
  ProcedureThreshold,
  PublicKey,
  Poseidon2,
  Rpo256,
  RpcClient,
  Signature,
  SigningInputs,
  SigningInputsType,
  SlotAndKeys,
  SlotAndKeysArray,
  StorageMap,
  StorageSlot,
  TestUtils,
  TokenSymbol,
  TransactionFilter,
  TransactionProver,
  TransactionRequest,
  TransactionStoreUpdate,
  TransactionRequestBuilder,
  TransactionScript,
  TransactionScriptInputPair,
  TransactionScriptInputPairArray,
  TransactionSummary,
  Word,
  NoteAndArgs,
  NoteAndArgsArray,
  MidenArrays,
  CodeBuilder,
  CodeBuilderMode,
  createAuthFalcon512RpoMultisig,
  MidenClient,
  WasmWebClient,
  MockWasmWebClient,
  createP2IDNote,
  createP2IDENote,
  buildSwapTag,
} from "../dist/index";

declare global {
  interface Window {
    client: WasmWebClient & WasmWebClient;
    MockWasmWebClient: typeof MockWasmWebClient;
    remoteProverUrl?: string;
    remoteProverInstance: TransactionProver;
    /** The test node's own prover, exposed whether or not the run opted into one. */
    localTxProverUrl: string;
    Account: typeof Account;
    AccountFile: typeof AccountFile;
    AccountBuilder: typeof AccountBuilder;
    AccountComponent: typeof AccountComponent;
    AccountDelta: typeof AccountDelta;
    AccountHeader: typeof AccountHeader;
    AccountId: typeof AccountId;
    AccountInterface: typeof AccountInterface;
    AccountStorageMode: typeof AccountStorageMode;
    AccountStorageRequirements: typeof AccountStorageRequirements;
    AccountType: typeof AccountType;
    AccountVaultDelta: typeof AccountVaultDelta;
    Address: typeof Address;
    AddressInterface: typeof AddressInterface;
    AdviceMap: typeof AdviceMap;
    AuthFalcon512RpoMultisigConfig: typeof AuthFalcon512RpoMultisigConfig;
    AuthSecretKey: typeof AuthSecretKey;
    BasicFungibleFaucetComponent: typeof BasicFungibleFaucetComponent;
    ConsumableNoteRecord: typeof ConsumableNoteRecord;
    Endpoint: typeof Endpoint;
    Felt: typeof Felt;
    FeltArray: typeof FeltArray;
    ForeignAccount: typeof ForeignAccount;
    FungibleAsset: typeof FungibleAsset;
    InputNoteRecord: typeof InputNoteRecord;
    Library: typeof Library;
    NetworkId: typeof NetworkId;
    Note: typeof Note;
    NoteAndArgs: typeof NoteAndArgs;
    NoteAndArgsArray: typeof NoteAndArgsArray;
    NoteAssets: typeof NoteAssets;
    NoteConsumability: typeof NoteConsumability;
    NoteConsumptionStatus: typeof NoteConsumptionStatus;
    NoteExecutionHint: typeof NoteExecutionHint;
    NoteExportFormat: typeof NoteExportFormat;
    NoteScriptFee: typeof NoteScriptFee;
    NoteFilter: typeof NoteFilter;
    NoteFile: typeof NoteFile;
    NoteFilterTypes: typeof NoteFilterTypes;
    NoteId: typeof NoteId;
    NoteIdAndArgs: typeof NoteIdAndArgs;
    NoteIdAndArgsArray: typeof NoteIdAndArgsArray;
    NoteStorage: typeof NoteStorage;
    NoteMetadata: typeof NoteMetadata;
    NoteRecipient: typeof NoteRecipient;
    NoteScript: typeof NoteScript;
    NoteTag: typeof NoteTag;
    NoteType: typeof NoteType;
    OutputNote: typeof OutputNote;
    OutputNotesArray: typeof OutputNotesArray;
    Package: typeof Package;
    ProcedureThreshold: typeof ProcedureThreshold;
    PublicKey: typeof PublicKey;
    Poseidon2: typeof Poseidon2;
    Rpo256: typeof Rpo256;
    Signature: typeof Signature;
    SigningInputs: typeof SigningInputs;
    SigningInputsType: typeof SigningInputsType;
    SlotAndKeys: typeof SlotAndKeys;
    SlotAndKeysArray: typeof SlotAndKeysArray;
    StorageMap: typeof StorageMap;
    StorageSlot: typeof StorageSlot;
    TestUtils: typeof TestUtils;
    TokenSymbol: typeof TokenSymbol;
    TransactionFilter: typeof TransactionFilter;
    TransactionProver: typeof TransactionProver;
    TransactionRequest: typeof TransactionRequest;
    TransactionStoreUpdate: typeof TransactionStoreUpdate;
    TransactionRequestBuilder: typeof TransactionRequestBuilder;
    TransactionScript: typeof TransactionScript;
    TransactionScriptInputPair: typeof TransactionScriptInputPair;
    TransactionScriptInputPairArray: typeof TransactionScriptInputPairArray;
    TransactionSummary: typeof TransactionSummary;
    RpcClient: typeof RpcClient;
    WasmWebClient: typeof WasmWebClient;
    Word: typeof Word;
    MidenArrays: typeof MidenArrays;
    CodeBuilder: typeof CodeBuilder;
    CodeBuilderMode: typeof CodeBuilderMode;
    createAuthFalcon512RpoMultisig: typeof createAuthFalcon512RpoMultisig;
    MidenClient: typeof MidenClient;
    createP2IDNote: typeof createP2IDNote;
    createP2IDENote: typeof createP2IDENote;
    buildSwapTag: typeof buildSwapTag;
    createClient: () => Promise<void>;

    rpcUrl: string;
    // The chain's fee faucet, so `refreshClient` can rebuild a client that can
    // still execute. Undefined when the SDK already knows one for the network.
    feeFaucetId: string | undefined;

    // Add the helpers namespace
    helpers: {
      waitForTransaction: (
        transactionId: string,
        maxWaitTime?: number,
        delayInterval?: number
      ) => Promise<void>;
      waitForBlocks: (amountOfBlocks: number) => Promise<void>;
      refreshClient: (initSeed?: Uint8Array) => Promise<void>;
      // Build another client against the node under test. Keeps the wrapper's
      // positional list, and the fee faucet it ends with, in one place.
      createClient: (storeName?: string, seed?: Uint8Array) => Promise<any>;
      createClientWithKeystore: (
        getKeyCb?: unknown,
        insertKeyCb?: unknown,
        signCb?: unknown,
        storeName?: string
      ) => Promise<any>;
      parseNetworkId: (networkId: string) => NetworkId;
      generateKeyWithScheme: (signatureScheme: string) => AuthSecretKey;
    };
  }
}

declare module "./playwright.global.setup" {
  export const testingPage: Page;
}
