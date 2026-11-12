import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { GuardianInfo } from "../types";

describe("GuardianInfo", () => {
  it("has the agreed shape", () => {
    const g: GuardianInfo = {
      isGuardianAccount: false,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: null,
    };

    expect(Object.keys(g).sort()).toEqual([
      "guardianEndpoint",
      "guardianProvider",
      "guardianSyncStatus",
      "isGuardianAccount",
    ]);
  });
});

// The adapter returns only the signature, so its docs are the only place a
// dApp learns which commitment to verify.
describe("signBytes verification docs", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");

  for (const [name, path] of [
    ["signer.ts JSDoc", "../signer.ts"],
    [
      "wallet-adapter-integration skill",
      "../skills/wallet-adapter-integration/SKILL.md",
    ],
  ]) {
    it(`${name} says the result carries no scheme signal and how to verify`, () => {
      const text = read(path);
      expect(text).toContain("no scheme signal");
      expect(text).toContain(
        "publicKey.verify(domainSeparatedSignCommitment(data, kind), signature)"
      );
      expect(text).toContain("Word.deserialize");
      expect(text).toContain("SigningInputs.deserialize");
      expect(text).toContain("verifyData");
      expect(text).not.toContain("when the wallet is known to be older");
    });
  }
});
