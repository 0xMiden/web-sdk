import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_BUILD,
  MIDEN_WALLET_METHODS,
  getBehaviorCases,
  getSurfaceCases,
  runConformance,
  type ProviderLike,
} from "../conformance";

/**
 * A provider that implements the whole interface.
 *
 * This is deliberately NOT the thing under test. A reference provider authored
 * in this repo gets updated in the same commit that adds a method, so it can
 * never catch a real provider missing one — that is exactly how `createAccount`
 * shipped broken for six months.
 *
 * What is under test is the *instrument*: the tests below delete methods from
 * this provider and assert the suite notices. If the suite cannot detect a
 * deletion here, it cannot detect a gap in the wallet either.
 */
const completeProvider = (): ProviderLike => {
  const provider: ProviderLike = {};
  for (const method of MIDEN_WALLET_METHODS) {
    provider[method] = () => Promise.resolve({});
  }
  return provider;
};

describe("MIDEN_WALLET_METHODS", () => {
  it("names every method the interface declares", () => {
    // The type lock in conformance.ts is the real guard — it fails to compile
    // if the interface drifts. This asserts the count so an accidental
    // duplicate or deletion is visible in test output too.
    expect(new Set(MIDEN_WALLET_METHODS).size).toBe(
      MIDEN_WALLET_METHODS.length
    );
    expect(MIDEN_WALLET_METHODS).toContain("createAccount");
  });

  it("identifies itself so a mocked module cannot pass silently", () => {
    expect(CONFORMANCE_BUILD.real).toBe(true);
    expect(CONFORMANCE_BUILD.methodCount).toBe(MIDEN_WALLET_METHODS.length);
  });
});

describe("getSurfaceCases", () => {
  it("passes a provider that implements everything", async () => {
    const { passed, failed } = await runConformance(
      getSurfaceCases(completeProvider())
    );
    expect(failed).toEqual([]);
    expect(passed).toHaveLength(MIDEN_WALLET_METHODS.length);
  });

  // The load-bearing test. Deleting any single method must produce exactly one
  // failure naming that method. Parameterised over all of them so a method
  // added later is covered without anyone remembering to add a case.
  it.each(MIDEN_WALLET_METHODS)("fails when %s is missing", async (missing) => {
    const provider = completeProvider();
    delete provider[missing];

    const { failed } = await runConformance(getSurfaceCases(provider));

    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe(`implements ${missing}()`);
    expect(failed[0].error).toContain(`MidenWallet.${missing} is missing`);
  });

  it("reports every gap in one run rather than stopping at the first", async () => {
    const provider = completeProvider();
    delete provider.createAccount;
    delete provider.requestGuardianInfo;

    const { failed } = await runConformance(getSurfaceCases(provider));

    // These two are precisely the real-world gaps: createAccount is absent from
    // all three wallet providers, requestGuardianInfo from the Tauri one.
    expect(failed.map((f) => f.name).sort()).toEqual([
      "implements createAccount()",
      "implements requestGuardianInfo()",
    ]);
  });

  it("rejects a non-function property, not merely an absent one", async () => {
    const provider = completeProvider();
    provider.signBytes = "nope";

    const { failed } = await runConformance(getSurfaceCases(provider));

    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("is a string");
  });
});

describe("getBehaviorCases", () => {
  it("fails a provider whose methods resolve to the wrong shape", async () => {
    const provider = completeProvider(); // every method resolves to {}
    const { failed } = await runConformance(getBehaviorCases(provider));

    expect(failed.map((f) => f.name)).toEqual([
      "requestAssets() resolves to { assets: [...] }",
      "requestConsumableNotes() resolves to { consumableNotes: [...] }",
      "requestGuardianInfo() resolves to { guardianInfo }",
    ]);
  });

  it("passes a provider that returns the documented shapes", async () => {
    const provider = completeProvider();
    provider.requestAssets = () => Promise.resolve({ assets: [] });
    provider.requestConsumableNotes = () =>
      Promise.resolve({ consumableNotes: [] });
    provider.requestGuardianInfo = () =>
      Promise.resolve({ guardianInfo: { operator: "x" } });

    const { failed } = await runConformance(getBehaviorCases(provider));

    expect(failed).toEqual([]);
  });

  it("surfaces a rejected call as a failure rather than escaping", async () => {
    const provider = completeProvider();
    provider.requestAssets = () => Promise.reject(new Error("wallet locked"));

    const { failed } = await runConformance(getBehaviorCases(provider));

    expect(failed[0].error).toBe("wallet locked");
  });
});
