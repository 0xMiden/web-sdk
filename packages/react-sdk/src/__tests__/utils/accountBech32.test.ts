import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMidenStore } from "../../store/MidenStore";
import type { MidenConfig } from "../../types";

// Network factories surfaced as spies so we can assert which network the
// bech32 path selects from the configured endpoint.
const { mockDevnet, mockTestnet, mainnetSpy } = vi.hoisted(() => ({
  mockDevnet: vi.fn(() => ({ network: "devnet" })),
  mockTestnet: vi.fn(() => ({ network: "testnet" })),
  mainnetSpy: vi.fn(() => ({ network: "mainnet" })),
}));

vi.mock("@miden-sdk/miden-sdk", () => {
  const makeId = (hex: string) => ({
    toString: () => hex,
    // Force the Address.fromAccountId path; this fallback stays unused.
    toBech32: undefined,
  });
  return {
    Account: class Account {},
    AccountId: {
      fromHex: vi.fn((hex: string) => makeId(hex)),
      fromBech32: vi.fn((b: string) => makeId(b)),
    },
    AccountInterface: { BasicWallet: 0 },
    Address: {
      // toBech32 echoes the selected network so assertions can read it back.
      fromAccountId: vi.fn(() => ({
        toBech32: (net: { network: string }) => `bech32-${net.network}`,
      })),
      fromBech32: vi.fn(),
    },
    NetworkId: {
      devnet: mockDevnet,
      testnet: mockTestnet,
      mainnet: mainnetSpy,
    },
  };
});

import { toBech32AccountId } from "../../utils/accountBech32";

const ID = "0x1234567890abcdef";

const setNetwork = (rpcUrl: string | undefined, ready: boolean) => {
  useMidenStore.getState().setConfig({ rpcUrl } as MidenConfig);
  useMidenStore.getState().setClient((ready ? {} : null) as never);
};

beforeEach(() => {
  useMidenStore.getState().reset();
  mockDevnet.mockClear();
  mockTestnet.mockClear();
  mainnetSpy.mockClear();
});

describe("accountBech32 network resolution", () => {
  it("uses devnet when configured for devnet", () => {
    setNetwork("https://rpc.devnet.miden.io", true);
    expect(toBech32AccountId(ID)).toBe("bech32-devnet");
    expect(mockDevnet).toHaveBeenCalled();
    expect(mockTestnet).not.toHaveBeenCalled();
  });

  it("uses testnet when configured for testnet", () => {
    setNetwork("https://rpc.testnet.miden.io", true);
    expect(toBech32AccountId(ID)).toBe("bech32-testnet");
    expect(mockTestnet).toHaveBeenCalled();
  });

  it("treats a localhost node as devnet", () => {
    setNetwork("http://localhost:57291", true);
    expect(toBech32AccountId(ID)).toBe("bech32-devnet");
    expect(mockDevnet).toHaveBeenCalled();
    expect(mockTestnet).not.toHaveBeenCalled();
  });

  it("falls back to the testnet default when ready with no endpoint", () => {
    setNetwork(undefined, true);
    expect(toBech32AccountId(ID)).toBe("bech32-testnet");
    expect(mockTestnet).toHaveBeenCalled();
  });

  it("returns the raw id (never testnet) before the provider is ready", () => {
    // The init window: a devnet-configured app must not get a testnet-tagged
    // address while config.rpcUrl hasn't landed in the store yet.
    setNetwork(undefined, false);
    expect(toBech32AccountId(ID)).toBe(ID);
    expect(mockDevnet).not.toHaveBeenCalled();
    expect(mockTestnet).not.toHaveBeenCalled();
    expect(mainnetSpy).not.toHaveBeenCalled();
  });

  it("returns the raw id for an unrecognized custom endpoint rather than guessing testnet", () => {
    setNetwork("https://my-private-node.example", true);
    expect(toBech32AccountId(ID)).toBe(ID);
    expect(mockTestnet).not.toHaveBeenCalled();
  });
});
