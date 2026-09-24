import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

it("type-checks visibility and faucet selectors through the public declarations", () => {
  const consumer = fileURLToPath(
    new URL("../types/consumer.ts", import.meta.url)
  );
  const native = fileURLToPath(
    new URL("../types/native.d.ts", import.meta.url)
  );
  // Unit tests do not require a WASM build. Stub only its declarations; the
  // public index and resource types are the actual files shipped by this repo.
  const virtual = new Map([
    [
      native,
      `
      export enum AccountType { Private = 0, Public = 1 }
      export class AccountBuilder {
        constructor(seed: Uint8Array);
        accountType(type: AccountType): AccountBuilder;
      }
    `,
    ],
    [
      consumer,
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
      // @ts-expect-error The faucet-kind aliases were removed with the rename.
      import type { FaucetTypeValue, AccountTypeValue } from "./index";
      // @ts-expect-error Faucet kinds are no longer members of AccountType.
      AccountType.FungibleFaucet;
      // @ts-expect-error FaucetType does not select visibility.
      FaucetType.Public;
    `,
    ],
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
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      )
  ).toEqual([]);
});
