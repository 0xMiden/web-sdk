import { test, expect, type Page } from "@playwright/test";

type ReactSdkState = {
  testAppReady: boolean;
  testAppError: string | null;
  sdkLoaded: boolean;
  sdkLoadError: string | null;
  reactSdkReady: boolean;
  hasApi: boolean;
};

async function readReactSdkState(page: Page): Promise<ReactSdkState> {
  return page.evaluate(() => ({
    testAppReady: (window as any).testAppReady === true,
    testAppError: (window as any).testAppError ?? null,
    sdkLoaded: (window as any).sdkLoaded === true,
    sdkLoadError: (window as any).sdkLoadError ?? null,
    reactSdkReady: (window as any).reactSdkReady === true,
    hasApi: typeof (window as any).__reactSdk !== "undefined",
  }));
}

async function waitForTestAppReady(
  page: Page,
  timeoutMs = 10_000
): Promise<ReactSdkState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readReactSdkState(page);
    if (state.testAppError) {
      return state;
    }
    if (state.testAppReady) {
      return state;
    }
    await page.waitForTimeout(200);
  }

  return readReactSdkState(page);
}

async function waitForReactSdkReady(
  page: Page,
  timeoutMs = 10_000
): Promise<ReactSdkState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readReactSdkState(page);
    if (state.testAppError || state.sdkLoadError) {
      return state;
    }
    if (state.reactSdkReady && state.hasApi) {
      return state;
    }
    await page.waitForTimeout(200);
  }

  return readReactSdkState(page);
}

async function waitForSdkLoaded(
  page: Page,
  timeoutMs = 15_000
): Promise<ReactSdkState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readReactSdkState(page);
    if (state.testAppError) {
      return state;
    }
    if (state.sdkLoaded || state.sdkLoadError) {
      return state;
    }
    await page.waitForTimeout(200);
  }

  return readReactSdkState(page);
}

/**
 * Waits for the test app, the WASM SDK and the React SDK test API. Throws with
 * the reason when any of them fails to come up, so a page that cannot load
 * (a missing SDK build, a broken import) fails the test instead of skipping it.
 */
async function waitForReactSdk(page: Page): Promise<void> {
  const state = await waitForTestAppReady(page);
  if (state.testAppError) {
    throw new Error(`Test app error: ${state.testAppError}`);
  }
  if (!state.testAppReady) {
    throw new Error(
      `Timed out waiting for test app to be ready: ${JSON.stringify(state)}`
    );
  }

  const sdkState = await waitForSdkLoaded(page);
  if (!sdkState.sdkLoaded) {
    throw new Error(
      `SDK not loaded: ${sdkState.sdkLoadError ?? sdkState.testAppError ?? "timed out"}`
    );
  }

  const reactState = await waitForReactSdkReady(page);
  if (!reactState.reactSdkReady || !reactState.hasApi) {
    throw new Error(
      `React SDK test API not available: ${JSON.stringify(reactState)}`
    );
  }
}

test.describe("React SDK Hooks (Playwright)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:8081/react-hooks.html");
  });

  test("useTransaction executes a transaction", async ({ page }) => {
    await waitForReactSdk(page);

    const result = await page.evaluate(async () => {
      const api = (window as any).__reactSdk;
      return await api.runTransaction();
    });

    expect(result.transactionId).toBeTruthy();

    await page.waitForFunction(
      () => (window as any).__reactSdkState().transactionStage === "complete"
    );

    const state = await page.evaluate(() => (window as any).__reactSdkState());
    expect(state.transactionStage).toBe("complete");
    expect(state.transactionError).toBeNull();
  });

  test("useImportAccount imports account from file", async ({ page }) => {
    await waitForReactSdk(page);

    const result = await page.evaluate(async () => {
      const api = (window as any).__reactSdk;
      return await api.importAccountFromFile();
    });

    expect(result.accountId).toBeTruthy();

    await page.waitForFunction(
      () => (window as any).__reactSdkState().importedAccountId
    );

    const state = await page.evaluate(() => (window as any).__reactSdkState());
    expect(state.importError).toBeNull();
    expect(state.importedAccountId).toBeTruthy();
  });
});
