import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrivateDataPermission,
  WalletAdapterNetwork,
  WalletNotReadyError,
  WalletReadyState,
} from "@miden-sdk/miden-wallet-adapter-base";

vi.mock("@miden-sdk/miden-sdk", () => ({
  Note: { deserialize: vi.fn() },
}));

import {
  BREAD_OPEN_LINK_BASE,
  MidenWalletAdapter,
  getBreadOpenLink,
} from "../adapter";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const PAGE_URL = "https://dapp.example/swap?amount=1&to=mtst1abc#review";
const OPEN_LINK = `${BREAD_OPEN_LINK_BASE}#url=https%3A%2F%2Fdapp.example%2Fswap%3Famount%3D1%26to%3Dmtst1abc%23review`;
const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/Bread/coajhopfooegmaifelglfboehacldcbo";

function stubBrowser(
  userAgent: string,
  maxTouchPoints = 0,
  userActivation: { isActive: boolean } | null = { isActive: true }
) {
  vi.stubGlobal("navigator", {
    userAgent,
    maxTouchPoints,
    userActivation: userActivation ?? undefined,
  });
  vi.stubGlobal("location", { href: PAGE_URL, assign: vi.fn() });
}

function connect(adapter: MidenWalletAdapter) {
  return adapter.connect(
    PrivateDataPermission.UponRequest,
    WalletAdapterNetwork.Testnet
  );
}

describe("Open in Bread", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as any).midenWallet;
    delete (window as any).miden;
    delete (window as any).bread;
  });

  describe("getBreadOpenLink", () => {
    it("percent-encodes the page URL into the link's fragment", () => {
      expect(getBreadOpenLink(PAGE_URL)).toBe(OPEN_LINK);
    });

    it("defaults to the current page", () => {
      stubBrowser(WINDOWS_UA);
      expect(getBreadOpenLink()).toBe(OPEN_LINK);
    });
  });

  describe("readyState", () => {
    it.each([
      ["an iPhone", IPHONE_UA, 5],
      ["an iPad", IPAD_UA, 5],
      ["an iPad asking for the desktop site", MAC_UA, 5],
      ["an Android phone", ANDROID_UA, 5],
    ])(
      "starts Loadable on %s with no wallet injected",
      (_, userAgent, maxTouchPoints) => {
        stubBrowser(userAgent, maxTouchPoints);
        expect(new MidenWalletAdapter().readyState).toBe(
          WalletReadyState.Loadable
        );
      }
    );

    it.each([
      ["a Mac", MAC_UA],
      ["Windows", WINDOWS_UA],
    ])("starts NotDetected on %s", (_, userAgent) => {
      stubBrowser(userAgent);
      expect(new MidenWalletAdapter().readyState).toBe(
        WalletReadyState.NotDetected
      );
    });

    it("starts NotDetected inside Bread's own browser, then Installed when Bread injects", () => {
      stubBrowser(IPHONE_UA, 5);
      (window as any).bread = { version: 1 };
      const adapter = new MidenWalletAdapter();
      expect(adapter.readyState).toBe(WalletReadyState.NotDetected);
      expect(adapter.url).toBe(CHROME_WEB_STORE_URL);

      (window as any).midenWallet = {};
      vi.advanceTimersByTime(1000);
      expect(adapter.readyState).toBe(WalletReadyState.Installed);
    });

    it("stays NotDetected on a phone browser that cannot report taps", async () => {
      stubBrowser(ANDROID_UA, 5, null);
      const adapter = new MidenWalletAdapter();
      expect(adapter.readyState).toBe(WalletReadyState.NotDetected);
      expect(adapter.url).toBe(CHROME_WEB_STORE_URL);

      await expect(connect(adapter)).rejects.toThrow(WalletNotReadyError);
      expect(location.assign).not.toHaveBeenCalled();
    });

    it("is Installed straight away when the wallet is already injected", () => {
      stubBrowser(IPHONE_UA, 5);
      (window as any).midenWallet = {};
      expect(new MidenWalletAdapter().readyState).toBe(
        WalletReadyState.Installed
      );
    });

    it("moves from Loadable to Installed when the wallet injects later", () => {
      stubBrowser(IPHONE_UA, 5);
      const adapter = new MidenWalletAdapter();
      const onReadyStateChange = vi.fn();
      adapter.on("readyStateChange", onReadyStateChange);

      (window as any).midenWallet = {};
      vi.advanceTimersByTime(1000);

      expect(adapter.readyState).toBe(WalletReadyState.Installed);
      expect(onReadyStateChange).toHaveBeenCalledWith(
        WalletReadyState.Installed
      );
      expect(adapter.url).toBe(CHROME_WEB_STORE_URL);
    });

    it("stays Unsupported without a DOM, even on a phone", () => {
      stubBrowser(IPHONE_UA, 5);
      vi.stubGlobal("document", undefined);
      expect(new MidenWalletAdapter().readyState).toBe(
        WalletReadyState.Unsupported
      );
    });
  });

  describe("url", () => {
    it("is the Open in Bread link for the current page on a phone", () => {
      stubBrowser(ANDROID_UA, 5);
      const adapter = new MidenWalletAdapter();
      expect(adapter.url).toBe(OPEN_LINK);

      location.href = "https://dapp.example/pools";
      expect(adapter.url).toBe(getBreadOpenLink("https://dapp.example/pools"));
    });

    it("stays the Chrome Web Store listing on desktop", () => {
      stubBrowser(MAC_UA);
      expect(new MidenWalletAdapter().url).toBe(CHROME_WEB_STORE_URL);
    });
  });

  describe("connect", () => {
    it("navigates to the Open in Bread link before awaiting anything", async () => {
      stubBrowser(IPHONE_UA, 5);
      const adapter = new MidenWalletAdapter();
      const onConnect = vi.fn();
      const onError = vi.fn();
      adapter.on("connect", onConnect);
      adapter.on("error", onError);

      const pending = connect(adapter);
      expect(location.assign).toHaveBeenCalledWith(OPEN_LINK);

      await expect(pending).resolves.toBeUndefined();
      expect(adapter.connected).toBe(false);
      expect(adapter.readyState).toBe(WalletReadyState.Loadable);
      expect(onConnect).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it("navigates once when a single tap reaches connect() twice", async () => {
      stubBrowser(IPHONE_UA, 5);
      const adapter = new MidenWalletAdapter();

      await connect(adapter);
      await connect(adapter);
      expect(location.assign).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      await connect(adapter);
      expect(location.assign).toHaveBeenCalledTimes(2);
    });

    it("does not navigate outside a tap", async () => {
      stubBrowser(ANDROID_UA, 5, { isActive: false });
      const adapter = new MidenWalletAdapter();

      await expect(connect(adapter)).resolves.toBeUndefined();
      expect(location.assign).not.toHaveBeenCalled();
    });

    it("connects to a wallet injected after the last poll instead of handing off", async () => {
      stubBrowser(IPHONE_UA, 5);
      const adapter = new MidenWalletAdapter();
      const wallet = {
        address: "mtst1abc",
        publicKey: new Uint8Array([1]),
        connect: vi.fn().mockResolvedValue(undefined),
      };
      (window as any).midenWallet = wallet;

      await connect(adapter);
      expect(location.assign).not.toHaveBeenCalled();
      expect(wallet.connect).toHaveBeenCalledWith(
        PrivateDataPermission.UponRequest,
        WalletAdapterNetwork.Testnet,
        undefined
      );
      expect(adapter.readyState).toBe(WalletReadyState.Installed);
      expect(adapter.address).toBe("mtst1abc");
    });

    it("still throws WalletNotReadyError on desktop without navigating", async () => {
      stubBrowser(MAC_UA);
      const adapter = new MidenWalletAdapter();

      await expect(connect(adapter)).rejects.toThrow(WalletNotReadyError);
      expect(location.assign).not.toHaveBeenCalled();
    });
  });

  describe("openInBread", () => {
    it("moves to Installed instead of navigating when the wallet was injected after the last poll", () => {
      stubBrowser(IPHONE_UA, 5);
      const adapter = new MidenWalletAdapter();
      const onReadyStateChange = vi.fn();
      adapter.on("readyStateChange", onReadyStateChange);
      (window as any).midenWallet = {};

      adapter.openInBread();
      expect(location.assign).not.toHaveBeenCalled();
      expect(adapter.readyState).toBe(WalletReadyState.Installed);
      expect(onReadyStateChange).toHaveBeenCalledWith(
        WalletReadyState.Installed
      );
    });
  });
});
