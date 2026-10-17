import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletReadyState } from "@miden-sdk/miden-wallet-adapter-base";

const walletContext = vi.hoisted(() => ({
  wallets: [] as unknown[],
  wallet: null as unknown,
  select: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@miden-sdk/miden-wallet-adapter-react", () => ({
  useWallet: () => walletContext,
}));

vi.mock("@miden-sdk/miden-wallet-adapter-miden", () => ({
  MidenWalletName: "Bread Wallet",
}));

import { WalletModal } from "../src/WalletModal";
import { WalletModalContext } from "../src/useWalletModal";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeWallet(name: string, readyState: WalletReadyState) {
  return {
    adapter: {
      name,
      url: `https://wallets.example/${encodeURIComponent(name)}`,
      icon: "data:image/svg+xml;base64,",
      connect: vi.fn().mockResolvedValue(undefined),
      openInBread: vi.fn(),
    },
    readyState,
  };
}

function listItem(name: string) {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".wallet-adapter-modal-list .wallet-adapter-button"
    )
  ).find((item) => item.textContent?.includes(name));
}

describe("WalletModal", () => {
  const setVisible = vi.fn();
  let container: HTMLDivElement;
  let root: Root;

  function renderModal(wallets: ReturnType<typeof makeWallet>[]) {
    walletContext.wallets = wallets;
    act(() => {
      root.render(
        <WalletModalContext.Provider value={{ visible: true, setVisible }}>
          <WalletModal />
        </WalletModalContext.Provider>
      );
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
    walletContext.wallet = null;
  });

  it("selects a Loadable Bread wallet and hands it off from inside the tap", () => {
    const bread = makeWallet("Bread Wallet", WalletReadyState.Loadable);
    renderModal([bread]);

    const button = document.querySelector<HTMLButtonElement>(
      ".wallet-adapter-modal-middle-button"
    );
    expect(button?.textContent).toBe("Open in Bread");
    expect(
      document.querySelector(".wallet-adapter-modal-chrome-badge")
    ).toBeNull();

    act(() => {
      button!.click();
      expect(walletContext.select).toHaveBeenCalledWith("Bread Wallet");
      expect(bread.adapter.openInBread).toHaveBeenCalledTimes(1);
    });
    expect(bread.adapter.connect).not.toHaveBeenCalled();
    expect(walletContext.connect).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(setVisible).toHaveBeenCalledWith(false);
  });

  it("hands off a Loadable Bread entry from inside the tap and still selects installed ones", () => {
    const other = makeWallet("Other Wallet", WalletReadyState.Installed);
    const bread = makeWallet("Bread Wallet", WalletReadyState.Loadable);
    renderModal([other, bread]);

    act(() => {
      listItem("Bread Wallet")!.click();
      expect(walletContext.select).toHaveBeenCalledWith("Bread Wallet");
      expect(bread.adapter.openInBread).toHaveBeenCalledTimes(1);
    });
    expect(bread.adapter.connect).not.toHaveBeenCalled();

    act(() => {
      listItem("Other Wallet")!.click();
    });
    expect(walletContext.select).toHaveBeenCalledWith("Other Wallet");
    expect(other.adapter.connect).not.toHaveBeenCalled();
  });

  it("selects a Loadable wallet that is not Bread", () => {
    const installed = makeWallet(
      "Installed Wallet",
      WalletReadyState.Installed
    );
    const other = makeWallet("Other Wallet", WalletReadyState.Loadable);
    renderModal([installed, other]);

    act(() => {
      listItem("Other Wallet")!.click();
    });
    expect(walletContext.select).toHaveBeenCalledWith("Other Wallet");
    expect(other.adapter.connect).not.toHaveBeenCalled();
    expect(other.adapter.openInBread).not.toHaveBeenCalled();
  });

  it("shows the store badge for a Loadable wallet that is not Bread", () => {
    const other = makeWallet("Other Wallet", WalletReadyState.Loadable);
    renderModal([other]);

    expect(
      document
        .querySelector(".wallet-adapter-modal-chrome-badge")
        ?.getAttribute("href")
    ).toBe(other.adapter.url);
    expect(
      document.querySelector(".wallet-adapter-modal-middle-button")
    ).toBeNull();
  });

  it("connects nothing when it opens with a Loadable Bread selected", () => {
    const bread = makeWallet("Bread Wallet", WalletReadyState.Loadable);
    walletContext.wallet = bread;
    renderModal([bread]);

    expect(walletContext.connect).not.toHaveBeenCalled();
  });

  it("keeps the Chrome Web Store badge when the wallet is not detected", () => {
    const bread = makeWallet("Bread Wallet", WalletReadyState.NotDetected);
    renderModal([bread]);

    expect(
      document
        .querySelector(".wallet-adapter-modal-chrome-badge")
        ?.getAttribute("href")
    ).toBe(bread.adapter.url);
    expect(
      document.querySelector(".wallet-adapter-modal-middle-button")
    ).toBeNull();
  });
});
