// `EventEmitter` comes via the base package rather than `eventemitter3` directly:
// base re-exports it and is a declared dependency here, eventemitter3 is not.
import type { EventEmitter } from "@miden-sdk/miden-wallet-adapter-base";

import type { MidenWallet, MidenWalletEvents } from "./adapter";

/**
 * A conformance suite for `MidenWallet` implementations.
 *
 * ## Why this exists
 *
 * `createAccount` has been on the published `MidenWallet` interface since
 * adapter 0.13.2. No wallet provider implements it — not the browser
 * extension, not the mobile injection script, not the Tauri provider — and
 * there is no wire message for it. A dApp calling it gets
 * `TypeError: wallet.createAccount is not a function`.
 *
 * That shipped, and stayed shipped, because both sides of the contract were
 * green: this repo's tests inject a `vi.fn()` bag as `window.midenWallet`, and
 * the wallet's tests mock this package wholesale. Each side asserted against a
 * shape it invented.
 *
 * A suite written *here* cannot fix that. Whatever reference provider this
 * repo authors gets updated in the same commit that adds a method, so it can
 * never detect a missing one. The detection has to happen where the real
 * implementations live. So this module ships the *instrument*, and the wallet
 * runs it against its real providers.
 *
 * ## Two halves, deliberately separate
 *
 * {@link getSurfaceCases} asks only whether each method exists. It needs no
 * connection, no network and no state, so it is safe to run against providers
 * that are plain injected JavaScript — which is what the mobile and Tauri
 * providers are, and where the remaining gaps live.
 *
 * {@link getBehaviorCases} exercises round-trips and needs a live, connected
 * provider. Running it against an un-connected provider proves nothing.
 *
 * @packageDocumentation
 */

/** Members `MidenWallet` inherits from EventEmitter rather than declaring. */
type InheritedKeys = keyof EventEmitter<MidenWalletEvents>;

/** Members `MidenWallet` declares itself. */
type OwnKeys = Exclude<keyof MidenWallet, InheritedKeys>;

/** The subset of {@link OwnKeys} that are callable — i.e. not `address`/`publicKey`. */
type MethodKeys = {
  [K in OwnKeys]-?: NonNullable<MidenWallet[K]> extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[OwnKeys];

/**
 * Every method a `MidenWallet` must implement.
 *
 * Type-locked in both directions below: a method added to the interface
 * without being added here fails to compile, and a name here that is not on
 * the interface fails to compile too. The list cannot silently drift from the
 * contract it describes.
 */
export const MIDEN_WALLET_METHODS = [
  "connect",
  "disconnect",
  "signBytes",
  "requestSend",
  "requestConsume",
  "requestTransaction",
  "requestAssets",
  "requestGuardianInfo",
  "requestPrivateNotes",
  "requestConsumableNotes",
  "importPrivateNote",
  "waitForTransaction",
  "createAccount",
] as const satisfies readonly MethodKeys[];

/** Compile error if the interface gains a method this list does not name. */
type Unlisted = Exclude<MethodKeys, (typeof MIDEN_WALLET_METHODS)[number]>;
const _exhaustive: [Unlisted] extends [never]
  ? true
  : ["MIDEN_WALLET_METHODS is missing", Unlisted] = true;
void _exhaustive;

/**
 * Identifies this module as the real implementation.
 *
 * The wallet mocks this package in a dozen test files. If a conformance run
 * ever lands inside a suite that mocks it — or someone later adds a
 * `moduleNameMapper` — the imported suite would become a no-op that still
 * reports green: the identical failure mode this whole fixture exists to
 * prevent, one layer up. Assert on this before running any case.
 */
export const CONFORMANCE_BUILD = {
  real: true,
  methodCount: MIDEN_WALLET_METHODS.length,
} as const;

/** One assertion, named so a failure says what is wrong without a stack trace. */
export interface ConformanceCase {
  readonly name: string;
  /** Throws on failure; returns normally on success. */
  readonly run: () => void | Promise<void>;
}

/** Anything shaped enough to probe. Deliberately not `MidenWallet`: the point is to test providers that may not satisfy it. */
export type ProviderLike = Record<string, unknown>;

/**
 * Shape-only checks: does the provider expose every method?
 *
 * Safe against untyped, runtime-only providers — no connection or state
 * required. This is the half that catches a provider missing a method the
 * interface promises.
 */
export function getSurfaceCases(provider: ProviderLike): ConformanceCase[] {
  return MIDEN_WALLET_METHODS.map((method) => ({
    name: `implements ${method}()`,
    run: () => {
      const value = provider[method];
      if (typeof value !== "function") {
        throw new Error(
          `MidenWallet.${method} is ${value === undefined ? "missing" : `a ${typeof value}`}. ` +
            `Every method on the published MidenWallet interface must exist on the provider; ` +
            `a dApp calling this one gets "TypeError: wallet.${method} is not a function".`
        );
      }
    },
  }));
}

/**
 * Round-trip checks against a live, connected provider.
 *
 * Unlike {@link getSurfaceCases} these need real state, so a provider obtained
 * by evaluating an injection script — with no wallet behind it — will fail
 * them for reasons that say nothing about conformance. Run the surface half
 * against those.
 */
export function getBehaviorCases(provider: ProviderLike): ConformanceCase[] {
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const fn = provider[method];
    if (typeof fn !== "function") {
      throw new Error(`MidenWallet.${method} is not a function`);
    }
    return (await (fn as (...a: unknown[]) => Promise<T>).apply(
      provider,
      args
    )) as T;
  };

  return [
    {
      name: "requestAssets() resolves to { assets: [...] }",
      run: async () => {
        const result = await call<{ assets: unknown[] }>("requestAssets");
        if (!result || !Array.isArray(result.assets)) {
          throw new Error(
            `requestAssets() must resolve to { assets: Asset[] }, got ${JSON.stringify(result)}`
          );
        }
      },
    },
    {
      name: "requestConsumableNotes() resolves to { consumableNotes: [...] }",
      run: async () => {
        const result = await call<{ consumableNotes: unknown[] }>(
          "requestConsumableNotes"
        );
        if (!result || !Array.isArray(result.consumableNotes)) {
          throw new Error(
            `requestConsumableNotes() must resolve to { consumableNotes: InputNoteDetails[] }, got ${JSON.stringify(result)}`
          );
        }
      },
    },
    {
      name: "requestGuardianInfo() resolves to { guardianInfo }",
      run: async () => {
        const result = await call<{ guardianInfo: unknown }>(
          "requestGuardianInfo"
        );
        if (!result || result.guardianInfo === undefined) {
          throw new Error(
            `requestGuardianInfo() must resolve to { guardianInfo: GuardianInfo }, got ${JSON.stringify(result)}`
          );
        }
      },
    },
  ];
}

/**
 * Runs cases and collects every failure rather than stopping at the first.
 *
 * A provider missing four methods should report four failures, not one — the
 * point is to see the whole gap in a single run.
 */
export async function runConformance(
  cases: ConformanceCase[]
): Promise<{ passed: string[]; failed: { name: string; error: string }[] }> {
  const passed: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run();
      passed.push(testCase.name);
    } catch (error) {
      failed.push({
        name: testCase.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { passed, failed };
}
