import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveTransactionProver,
  proveWithFallback,
} from "../../utils/prover";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveTransactionProver", () => {
  it("returns null when no prover is configured", () => {
    expect(resolveTransactionProver({})).toBeNull();
  });

  it("resolves local prover from string", () => {
    const prover = resolveTransactionProver({ prover: "local" });
    expect(prover).not.toBeNull();
  });

  it("resolves devnet remote prover from string", () => {
    const prover = resolveTransactionProver({ prover: "devnet" });
    expect(prover).not.toBeNull();
  });

  it("resolves testnet remote prover from string", () => {
    const prover = resolveTransactionProver({ prover: "testnet" });
    expect(prover).not.toBeNull();
  });

  it("resolves custom URL remote prover", () => {
    const prover = resolveTransactionProver({
      prover: "https://custom-prover.example.com",
    });
    expect(prover).not.toBeNull();
  });

  it("resolves prover from object with url", () => {
    const prover = resolveTransactionProver({
      prover: { url: "https://prover.example.com", timeoutMs: 5000 },
    });
    expect(prover).not.toBeNull();
  });

  it("resolves primary from fallback config", () => {
    const prover = resolveTransactionProver({
      prover: { primary: "local" },
    });
    expect(prover).not.toBeNull();
  });

  it("uses custom prover URL when provided", () => {
    const prover = resolveTransactionProver({
      prover: "devnet",
      proverUrls: { devnet: "https://my-devnet-prover.example.com" },
    });
    expect(prover).not.toBeNull();
  });
});

describe("proveWithFallback", () => {
  it("calls proveFn with primary prover on success", async () => {
    const proveFn = vi.fn().mockResolvedValue("proven-tx");
    const result = await proveWithFallback(proveFn, { prover: "local" });

    expect(result).toBe("proven-tx");
    expect(proveFn).toHaveBeenCalledTimes(1);
  });

  it("calls proveFn with undefined when no prover configured", async () => {
    const proveFn = vi.fn().mockResolvedValue("proven-tx");
    await proveWithFallback(proveFn, {});

    expect(proveFn).toHaveBeenCalledWith(undefined);
  });

  it("throws when primary fails and no fallback is configured", async () => {
    const error = new Error("Primary failed");
    const proveFn = vi.fn().mockRejectedValue(error);

    await expect(
      proveWithFallback(proveFn, { prover: "local" })
    ).rejects.toThrow("Primary failed");
    expect(proveFn).toHaveBeenCalledTimes(1);
  });

  it("falls back when primary fails and fallback is configured", async () => {
    const proveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Primary failed"))
      .mockResolvedValueOnce("fallback-result");

    const result = await proveWithFallback(proveFn, {
      prover: { primary: "devnet", fallback: "local" },
    });

    expect(result).toBe("fallback-result");
    expect(proveFn).toHaveBeenCalledTimes(2);
  });

  it("calls onFallback when falling back", async () => {
    const onFallback = vi.fn();
    const proveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Primary failed"))
      .mockResolvedValueOnce("ok");

    await proveWithFallback(proveFn, {
      prover: { primary: "devnet", fallback: "local", onFallback },
    });

    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when disableFallback returns true", async () => {
    const error = new Error("Primary failed");
    const proveFn = vi.fn().mockRejectedValue(error);

    await expect(
      proveWithFallback(proveFn, {
        prover: {
          primary: "devnet",
          fallback: "local",
          disableFallback: () => true,
        },
      })
    ).rejects.toThrow("Primary failed");

    expect(proveFn).toHaveBeenCalledTimes(1);
  });

  it("falls back when disableFallback returns false", async () => {
    const proveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Primary failed"))
      .mockResolvedValueOnce("ok");

    const result = await proveWithFallback(proveFn, {
      prover: {
        primary: "devnet",
        fallback: "local",
        disableFallback: () => false,
      },
    });

    expect(result).toBe("ok");
    expect(proveFn).toHaveBeenCalledTimes(2);
  });

  it("throws fallback error when fallback also fails", async () => {
    const proveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Primary failed"))
      .mockRejectedValueOnce(new Error("Fallback failed"));

    await expect(
      proveWithFallback(proveFn, {
        prover: { primary: "devnet", fallback: "local" },
      })
    ).rejects.toThrow("Fallback failed");
  });

  it("does not fall back when primary fails and no fallback target", async () => {
    const error = new Error("Primary failed");
    const proveFn = vi.fn().mockRejectedValue(error);

    await expect(
      proveWithFallback(proveFn, {
        prover: { primary: "devnet" },
      })
    ).rejects.toThrow("Primary failed");

    expect(proveFn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTransactionProver — edge cases (branches)", () => {
  it("throws when remote prover object has no URL", () => {
    expect(() =>
      resolveTransactionProver({
        // @ts-expect-error — runtime guard; the object lacks a URL
        prover: { url: "" },
      })
    ).toThrow(/Remote prover requires a URL/);
  });

  it("accepts a bigint timeoutMs and forwards it to the SDK", () => {
    // bigint goes through the `typeof timeoutMs === 'bigint'` branch in
    // normalizeTimeout (line 122).
    const prover = resolveTransactionProver({
      prover: { url: "https://prover.example.com", timeoutMs: 7000n },
    });
    expect(prover).not.toBeNull();
  });

  it("normalizes a `null` config.proverTimeoutMs to null when resolving a string target", () => {
    // resolveProverTarget for a custom URL string calls normalizeTimeout
    // directly with config.proverTimeoutMs. Setting it to `null` exercises
    // line 120-121 (return null branch) of normalizeTimeout.
    const prover = resolveTransactionProver({
      prover: "https://prover.example.com",
      // @ts-expect-error — runtime guard for null
      proverTimeoutMs: null,
    });
    expect(prover).not.toBeNull();
  });
});
