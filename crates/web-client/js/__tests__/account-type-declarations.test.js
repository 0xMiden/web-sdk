import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

// Compiles `consumerSource` against the public index and returns its
// diagnostics. Unit tests do not require a WASM build, so `nativeSource` stubs
// only the wasm-bindgen declarations; the public index and resource types are
// the actual files shipped by this repo.
function diagnostics(nativeSource, consumerSource) {
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
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
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
  const program = ts.createProgram([consumer], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    );
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
