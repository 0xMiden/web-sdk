import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

// Compiles `consumerSource` against the public index and returns its
// diagnostics. Unit tests do not require a WASM build, so `nativeSource` stubs
// only the wasm-bindgen declarations; the public index and resource types are
// the actual files shipped by this repo.
function diagnostics(
  nativeSource,
  consumerSource,
  {
    skipLibCheck = true,
    target = ts.ScriptTarget.ES2022,
    rootFiles = [],
    excludeFileSuffix = null,
  } = {}
) {
  const consumer = fileURLToPath(
    new URL("../types/consumer.ts", import.meta.url)
  );
  const native = fileURLToPath(
    new URL("../types/native.d.ts", import.meta.url)
  );
  const virtual = new Map([
    [native, nativeSource],
    [consumer, consumerSource],
  ]);
  const options = {
    target,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => virtual.get(file) ?? readFile(file);
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) =>
      name === "./crates/miden_client_web"
        ? { resolvedFileName: native, extension: ts.Extension.Dts }
        : ts.resolveModuleName(name, containingFile, options, host)
            .resolvedModule
    );
  const program = ts.createProgram([...rootFiles, consumer], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        !excludeFileSuffix ||
        !diagnostic.file?.fileName.endsWith(excludeFileSuffix)
    )
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    );
}

// Builds a native declaration stub covering every wasm-bindgen symbol imported
// by `files`, letting `skipLibCheck: false` inspect authored `.d.ts` files directly.
function completeNativeStub(customStub, files, customNames) {
  const names = new Set();
  for (const filePath of files) {
    const src = readFileSync(filePath, "utf8");
    for (const match of src.matchAll(
      /\{([^}]+)\}\s*from\s*"\.\/crates\/miden_client_web"/g
    )) {
      for (const entry of match[1].split(",")) {
        const trimmed = entry.trim();
        if (trimmed && !customNames.has(trimmed)) names.add(trimmed);
      }
    }
  }
  const rest = [...names]
    .map((name) => `export class ${name} { free(): void; }`)
    .join("\n");
  return `${customStub}\n${rest}\n`;
}

it("type-checks visibility and faucet selectors through the public declarations", () => {
  expect(
    diagnostics(
      `
      export enum AccountType { Private = 0, Public = 1 }
      export class AccountBuilder {
        constructor(seed: Uint8Array);
        accountType(type: AccountType): AccountBuilder;
      }
    `,
      `
      import { AccountBuilder, AccountType, FaucetType,
        type FaucetCreateOptions } from "./index";
      new AccountBuilder(new Uint8Array(32)).accountType(AccountType.Public);
      new AccountBuilder(new Uint8Array(32)).accountType(AccountType.Private);
      const visibility: AccountType = AccountType.Public;
      const kind: FaucetType = FaucetType.FungibleFaucet;
      const literal: "FungibleFaucet" = kind;
      const faucet: FaucetCreateOptions = {
        type: kind, symbol: "TOK", decimals: 8, maxSupply: 1000n
      };
      // @ts-expect-error Non-fungible faucets have no public selector.
      FaucetType.NonFungibleFaucet;
      // @ts-expect-error AccountTypeValue was removed with the rename.
      import type { AccountTypeValue } from "./index";
      // @ts-expect-error Faucet kinds are no longer members of AccountType.
      AccountType.FungibleFaucet;
      // @ts-expect-error FaucetType does not select visibility.
      FaucetType.Public;
    `
    )
  ).toEqual([]);
});

// The wasm-bindgen output also exports an `AuthScheme` (a numeric enum) and
// types the client's scheme parameters with it; the stub reproduces both, so
// the public index has to resolve the name to the friendly const itself.
it("type-checks AuthScheme as the friendly const through the public declarations", () => {
  expect(
    diagnostics(
      `
      export enum AuthScheme { AuthEcdsaK256Keccak = 1, AuthRpoFalcon512 = 2 }
      export class Account {
        id(): string;
      }
      export class AccountStorageMode {
        static private(): AccountStorageMode;
        isPublic(): boolean;
      }
      export class WebClient {
        newWallet(storage_mode: AccountStorageMode, auth_scheme: AuthScheme, init_seed?: Uint8Array | null): Promise<Account>;
        newFaucet(storage_mode: AccountStorageMode, non_fungible: boolean, token_name: string, token_symbol: string, decimals: number, max_supply: bigint, auth_scheme: AuthScheme): Promise<Account>;
        importPublicAccountFromSeed(init_seed: Uint8Array, auth_scheme: AuthScheme): Promise<Account>;
      }
    `,
      `
      import { AccountStorageMode, AuthScheme, WasmWebClient } from "./index";
      const scheme: AuthScheme = AuthScheme.Falcon;
      const literal: "falcon" | "ecdsa" = scheme;
      declare const client: WasmWebClient;
      const mode = AccountStorageMode.private();
      const seed = new Uint8Array(32);
      client.newWallet(mode, AuthScheme.ECDSA);
      client.newWallet(mode, 2, seed);
      client.newFaucet(mode, false, "Token", "TOK", 8, 1000n, AuthScheme.ECDSA);
      client.newFaucet(mode, false, "Token", "TOK", 8, 1000n, 2);
      client.importPublicAccountFromSeed(seed, AuthScheme.ECDSA);
      client.importPublicAccountFromSeed(seed, 2);
      // @ts-expect-error Any other string is rejected.
      client.importPublicAccountFromSeed(seed, "rsa");
      // @ts-expect-error The other parameters keep their generated types.
      client.newWallet("private", AuthScheme.ECDSA);
      // @ts-expect-error The methods still resolve to an Account.
      const wrong: Promise<string> = client.newWallet(mode, 2);
      // @ts-expect-error The wasm enum's member names are not on the public AuthScheme.
      AuthScheme.AuthRpoFalcon512;
    `
    )
  ).toEqual([]);
});

it("type-checks the friendly AuthScheme in AuthGuardedMultisigConfig and createAuthComponentFromCommitment", () => {
  expect(
    diagnostics(
      `
      export enum AuthScheme { AuthEcdsaK256Keccak = 1, AuthRpoFalcon512 = 2 }
      export class Word { free(): void; }
      export class ProcedureThreshold { free(): void; }
      export class AccountComponent {
        private constructor();
        free(): void;
        static createAuthComponentFromCommitment(commitment: Word, auth_scheme: AuthScheme): AccountComponent;
        static fromLibrary(library: string): AccountComponent;
      }
      export class AuthGuardedMultisigConfig {
        free(): void;
        constructor(approvers: Word[], default_threshold: number, guardian: Word, auth_scheme: AuthScheme);
        withProcThresholds(proc_thresholds: ProcedureThreshold[]): AuthGuardedMultisigConfig;
        readonly defaultThreshold: number;
      }
      export function createAuthGuardedMultisig(config: AuthGuardedMultisigConfig): AccountComponent;
      export class Account { free(): void; }
      export class AccountStorageMode { free(): void; }
      export class AuthSecretKey { free(): void; }
      export class AccountStorage { free(): void; }
      export class Felt { free(): void; }
      export class SyncSummary { free(): void; }
      export class WebClient { free(): void; }
    `,
      `
      import { AccountComponent, AuthGuardedMultisigConfig, AuthScheme,
        createAuthGuardedMultisig, Word } from "./index";
      declare const word: Word;
      const config: AuthGuardedMultisigConfig = new AuthGuardedMultisigConfig(
        [word], 1, word, AuthScheme.ECDSA
      );
      new AuthGuardedMultisigConfig([word], 1, word, AuthScheme.Falcon);
      new AuthGuardedMultisigConfig([word], 1, word, 2);
      const tuned: AuthGuardedMultisigConfig = config.withProcThresholds([]);
      const threshold: number = tuned.defaultThreshold;
      const guarded: AccountComponent = createAuthGuardedMultisig(config);
      const single: AccountComponent =
        AccountComponent.createAuthComponentFromCommitment(word, AuthScheme.ECDSA);
      AccountComponent.createAuthComponentFromCommitment(word, 1);
      AccountComponent.fromLibrary("lib");
      const isConfig: boolean = config instanceof AuthGuardedMultisigConfig;
      const isComponent: boolean = single instanceof AccountComponent;
      // @ts-expect-error The scheme is required.
      new AuthGuardedMultisigConfig([word], 1, word);
      // @ts-expect-error Only "falcon" and "ecdsa" are friendly schemes.
      new AuthGuardedMultisigConfig([word], 1, word, "rsa");
      // @ts-expect-error Only "falcon" and "ecdsa" are friendly schemes.
      AccountComponent.createAuthComponentFromCommitment(word, "rsa");
    `
    )
  ).toEqual([]);
});

it("type-checks FeeSponsorshipNote, FungibleAsset, and createFeeSponsorshipNote across index, api-types, and docs-entry", () => {
  const feeSponsorshipNative = `
    export enum AuthScheme { AuthEcdsaK256Keccak = 1, AuthRpoFalcon512 = 2 }
    export class AccountId {
      free(): void;
      toString(): string;
    }
    export class AccountHeader {
      free(): void;
      id(): AccountId;
    }
    export class Account {
      free(): void;
      id(): AccountId;
    }
    export class AccountComponent { free(): void; }
    export class AccountStorage { free(): void; }
    export class AccountStorageMode { free(): void; }
    export class AuthGuardedMultisigConfig { free(): void; }
    export class AuthSecretKey { free(): void; }
    export class Felt { free(): void; }
    export class NoteId {
      free(): void;
      toString(): string;
    }
    export class NoteTag {
      free(): void;
      asU32(): number;
    }
    export class Word { free(): void; }
    export class FungibleAsset {
      free(): void;
      amount(): bigint;
      faucetId(): AccountId;
    }
    export class Note {
      free(): void;
      static createP2IDNote(...args: any[]): Note;
      static createP2IDENote(...args: any[]): Note;
      static createFeeSponsorshipNote(
        sender: AccountId,
        target: AccountId,
        feature_note_id: NoteId,
        asset: FungibleAsset,
        reclaimer?: AccountId,
        reclaim_height?: number
      ): Note;
    }
    export class FeeSponsorshipNote {
      free(): void;
      static tryFromNote(note: Note): FeeSponsorshipNote;
      sender(): AccountId;
      serialNumber(): Word;
      tag(): NoteTag;
      asset(): FungibleAsset;
      featureNoteId(): NoteId;
      reclaimer(): AccountId;
      reclaimHeight(): number | undefined;
      intoNote(): Note;
    }
    export class SyncSummary { free(): void; }
    export class WebClient {
      free(): void;
      static buildSwapTag(...args: any[]): NoteTag;
    }
  `;

  expect(
    diagnostics(
      feeSponsorshipNative,
      `
      import {
        Account,
        AccountHeader,
        AccountId,
        createFeeSponsorshipNote,
        FeeSponsorshipNote,
        type FeeSponsorshipNoteOptions,
        FungibleAsset,
        Note,
        NoteId,
      } from "./index";
      import {
        createFeeSponsorshipNote as docsCreateFeeSponsorshipNote,
        FeeSponsorshipNote as DocsFeeSponsorshipNote,
        type FeeSponsorshipNoteOptions as DocsFeeSponsorshipNoteOptions,
        FungibleAsset as DocsFungibleAsset,
        Note as DocsNote,
      } from "./docs-entry";

      declare const account: Account;
      declare const header: AccountHeader;
      declare const accountId: AccountId;
      declare const featureNoteId: NoteId;
      declare const asset: FungibleAsset;

      const withStrings: FeeSponsorshipNoteOptions = {
        from: "0xsponsor",
        to: "mtst1qtarget",
        featureNoteId,
        asset,
      };
      const withRefs: DocsFeeSponsorshipNoteOptions = {
        from: account,
        to: header,
        featureNoteId,
        asset,
        reclaimer: accountId,
        reclaimAfter: 42,
      };
      const noteFromStandalone: Note = createFeeSponsorshipNote(withStrings);
      const noteFromDocs: DocsNote = docsCreateFeeSponsorshipNote(withRefs);
      const noteFromStatic: Note = Note.createFeeSponsorshipNote(
        accountId,
        accountId,
        featureNoteId,
        asset,
        undefined,
        42
      );
      const decoded: FeeSponsorshipNote = FeeSponsorshipNote.tryFromNote(noteFromStandalone);
      const docsDecoded: DocsFeeSponsorshipNote = DocsFeeSponsorshipNote.tryFromNote(noteFromDocs);
      const decodedAsset: DocsFungibleAsset = docsDecoded.asset();
      const height: number | undefined = decoded.reclaimHeight();
      const roundTripped: Note = decoded.intoNote();
      void noteFromStatic;
      void decodedAsset;
      void height;
      void roundTripped;

      // @ts-expect-error featureNoteId is required on FeeSponsorshipNoteOptions.
      const missingFeature: FeeSponsorshipNoteOptions = { from: "0xa", to: "0xb", asset };
      // @ts-expect-error asset is required on FeeSponsorshipNoteOptions.
      const missingAsset: FeeSponsorshipNoteOptions = { from: "0xa", to: "0xb", featureNoteId };
      // @ts-expect-error reclaimAfter must be a number, not a string.
      const badReclaim: FeeSponsorshipNoteOptions = { from: accountId, to: account, featureNoteId, asset, reclaimAfter: "42" };
      // @ts-expect-error from must satisfy AccountRef.
      const badFrom: FeeSponsorshipNoteOptions = { from: 123, to: account, featureNoteId, asset };
      // @ts-expect-error featureNoteId must be a NoteId.
      const badFeatureId: FeeSponsorshipNoteOptions = { from: account, to: accountId, featureNoteId: "0x123", asset };
      // @ts-expect-error createFeeSponsorshipNote returns Note, not string.
      const badReturn: string = createFeeSponsorshipNote(withStrings);
      // @ts-expect-error reclaimHeight() can be undefined and is a number, not string.
      const badHeight: string | undefined = decoded.reclaimHeight();
      void missingFeature;
      void missingAsset;
      void badReclaim;
      void badFrom;
      void badFeatureId;
      void badReturn;
      void badHeight;
    `
    )
  ).toEqual([]);

  // Strict declaration check (skipLibCheck: false) directly over authored .d.ts files
  // so missing internal imports like FungibleAsset in api-types.d.ts fail even without consumers.
  const apiTypes = fileURLToPath(
    new URL("../types/api-types.d.ts", import.meta.url)
  );
  const docsEntry = fileURLToPath(
    new URL("../types/docs-entry.d.ts", import.meta.url)
  );
  const customNames = new Set([
    "AuthScheme",
    "AccountId",
    "AccountHeader",
    "Account",
    "AccountComponent",
    "AccountStorage",
    "AccountStorageMode",
    "AuthGuardedMultisigConfig",
    "AuthSecretKey",
    "Felt",
    "NoteId",
    "NoteTag",
    "Word",
    "FungibleAsset",
    "Note",
    "FeeSponsorshipNote",
    "SyncSummary",
    "WebClient",
  ]);
  expect(
    diagnostics(
      completeNativeStub(
        feeSponsorshipNative,
        [apiTypes, docsEntry],
        customNames
      ),
      `
      import { createFeeSponsorshipNote, FeeSponsorshipNote, FungibleAsset, Note } from "./docs-entry";
      import { type FeeSponsorshipNoteOptions } from "./api-types";
      void createFeeSponsorshipNote;
      void FeeSponsorshipNote;
      void FungibleAsset;
      void Note;
      export type OptionsCheck = FeeSponsorshipNoteOptions;
    `,
      {
        skipLibCheck: false,
        target: ts.ScriptTarget.ESNext,
        rootFiles: [apiTypes, docsEntry],
        excludeFileSuffix: "js/types/index.d.ts",
      }
    )
  ).toEqual([]);
});
