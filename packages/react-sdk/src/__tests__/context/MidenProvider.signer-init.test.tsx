import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk/lazy";
import { MidenProvider, useMiden } from "../../context/MidenProvider";
import { SignerContext } from "../../context/SignerContext";
import {
  createMockSignerContext,
  createMockSignerAccountConfig,
} from "../mocks/signer-context";

/**
 * Provider-level regression guard for wallet-adapter#86: a fresh wallet's
 * signer account isn't on-chain yet, so initializeSignerAccount's fast path hits
 * "not found on the network". This must NOT put MidenProvider into its error
 * state (which renders errorComponent instead of the dApp) — the user needs the
 * dApp working to build the first transaction that registers the account.
 */
function Status() {
  const { isReady, error } = useMiden();
  return (
    <div>
      <span data-testid="ready">{String(isReady)}</span>
      <span data-testid="error">{error?.message ?? "none"}</span>
    </div>
  );
}

describe("MidenProvider fresh-account signer init (wallet-adapter#86)", () => {
  it("becomes ready without error when the signer account is not yet on the network", async () => {
    const client = await (
      WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>
    )();
    client.importAccountById.mockRejectedValue(
      new Error(
        "failed to import public account: account with id 0xfreshaccount not found on the network"
      )
    );

    try {
      const signer = createMockSignerContext({
        isConnected: true,
        storeName: "fresh_wallet",
        accountConfig: createMockSignerAccountConfig({
          importAccountId: "0xfreshaccount",
        }),
      });

      render(
        <SignerContext.Provider value={signer}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            <Status />
          </MidenProvider>
        </SignerContext.Provider>
      );

      await waitFor(() => {
        expect(screen.getByTestId("ready").textContent).toBe("true");
      });
      // The provider did NOT error out on the fresh-account import failure.
      expect(screen.getByTestId("error").textContent).toBe("none");
      expect(client.importAccountById).toHaveBeenCalled();
    } finally {
      // Restore the shared mock client's default so other suites are unaffected.
      client.importAccountById.mockResolvedValue(undefined);
    }
  });
});
