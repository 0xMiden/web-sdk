//@ts-nocheck
import { test as base, TestInfo } from "@playwright/test";
import {
  setupNodeGlobals,
  createFakePage,
  WasmWebClient,
} from "./node-adapter.ts";

// Unique per test run so concurrent suites don't share IndexedDB stores.
export const RUN_ID = crypto.randomUUID().slice(0, 8);

function generateStoreName(testInfo: TestInfo): string {
  return `test_${RUN_ID}_${testInfo.testId}`;
}

const TEST_SERVER_PORT = 8080;
const MIDEN_NODE_PORT = 57291;
const REMOTE_TX_PROVER_PORT = 50051;

// Check if running against localhost (vs devnet/testnet)
export function isLocalhost(): boolean {
  if (process.env.TEST_MIDEN_RPC_URL) {
    return process.env.TEST_MIDEN_RPC_URL.includes("localhost");
  }
  const network = process.env.TEST_MIDEN_NETWORK?.toLowerCase();
  return !network || network === "localhost";
}

// Fee faucet of the chain under test. Since 0.17 the fee asset lives in the
// protocol configuration rather than the block header, so a client cannot execute
// until it is told which faucet issues it, and a local node mints a fresh one at
// each genesis. `scripts/start-test-node.sh` reports it as
// "Native faucet account id:" in its bootstrap log; CI reads that line into this
// variable. Left unset, the SDK falls back to what it knows for the network.
export function getFeeFaucetId(): string | undefined {
  return process.env.TEST_MIDEN_FEE_FAUCET_ID || undefined;
}

// Determine RPC URL from environment or default to localhost
export function getRpcUrl(): string {
  if (process.env.TEST_MIDEN_RPC_URL) {
    return process.env.TEST_MIDEN_RPC_URL;
  }

  const network = process.env.TEST_MIDEN_NETWORK?.toLowerCase();
  switch (network) {
    case "devnet":
      return "https://rpc.devnet.miden.io";
    case "testnet":
      return "https://rpc.testnet.miden.io";
    case "localhost":
    default:
      return `http://localhost:${MIDEN_NODE_PORT}`;
  }
}

// Determine remote prover URL from environment or default based on network.
// TEST_MIDEN_PROVER_URL overrides the network preset. If neither is set, returns undefined
// (local prover). The "local" value explicitly forces local proving.
export function getProverUrl(): string | undefined {
  if (process.env.TEST_MIDEN_PROVER_URL) {
    const url = process.env.TEST_MIDEN_PROVER_URL;
    if (url.toLowerCase() === "local") return undefined;
    if (url.toLowerCase() === "devnet")
      return "https://tx-prover.devnet.miden.io";
    if (url.toLowerCase() === "testnet")
      return "https://tx-prover.testnet.miden.io";
    if (url.toLowerCase() === "localhost")
      return `http://localhost:${REMOTE_TX_PROVER_PORT}`;
    return url;
  }

  // Network preset defaults
  const network = process.env.TEST_MIDEN_NETWORK?.toLowerCase();
  switch (network) {
    case "devnet":
      return "https://tx-prover.devnet.miden.io";
    case "testnet":
      return "https://tx-prover.testnet.miden.io";
    default:
      return undefined;
  }
}

export const test = base.extend<{ forEachTest: void }>({
  // Override page for Node.js project — provide a fake page instead of a browser
  page: async ({ page }, use, testInfo) => {
    if (testInfo.project.name === "nodejs") {
      await use(createFakePage() as any);
    } else {
      await use(page);
    }
  },

  forEachTest: [
    async ({ page }, use, testInfo) => {
      const storeName = generateStoreName(testInfo);
      const isNode = testInfo.project.name === "nodejs";

      if (isNode) {
        // ── Node.js setup ──────────────────────────────────────
        const rpcUrl = getRpcUrl();
        const proverUrl = getProverUrl();
        const { setClient } = await setupNodeGlobals(
          rpcUrl,
          storeName,
          proverUrl
        );

        // Create a client and set it as window.client
        const client = await WasmWebClient.createClient(
          rpcUrl,
          undefined,
          undefined,
          storeName,
          getFeeFaucetId()
        );
        setClient(client);
      } else {
        // ── Browser setup (unchanged) ──────────────────────────
        page.on("console", (msg) => {
          if (msg.type() === "debug") {
            console.log(`PAGE DEBUG: ${msg.text()}`);
          }
        });

        page.on("pageerror", (err) => {
          console.error("PAGE ERROR:", err);
        });

        page.on("error", (err) => {
          console.error("PUPPETEER ERROR:", err);
        });

        await page.goto("http://localhost:8080");

        await page.evaluate(
          async ({ rpcUrl, proverUrl, storeName, feeFaucetId }) => {
            // Import the sdk classes and attach them
            // to the window object for testing
            const sdkExports = await import("./index.js");
            for (const [key, value] of Object.entries(sdkExports)) {
              window[key] = value;
            }
            // Restore the WASM AuthScheme enum (the JS API's string-based
            // AuthScheme constant from index.js shadows the WASM export).
            const wasm = await window.getWasmOrThrow();
            window.AuthScheme = wasm.AuthScheme;
            const client = await window.WasmWebClient.createClient(
              rpcUrl,
              undefined,
              undefined,
              storeName,
              undefined, // logLevel
              undefined, // useWorker, defaulted
              undefined, // observability
              feeFaucetId
            );
            window.rpcUrl = rpcUrl;
            window.feeFaucetId = feeFaucetId;
            window.storeName = storeName;

            window.client = client;

            // Create a namespace for helper functions
            window.helpers = window.helpers || {};

            // One place that knows the wrapper's positional list, so a test that
            // wants a second client against the same node cannot silently drop
            // the fee faucet - without it the client cannot execute or screen
            // notes, and the failure surfaces far from the call.
            window.helpers.createClient = (clientStoreName, seed) =>
              window.WasmWebClient.createClient(
                window.rpcUrl,
                undefined,
                seed,
                clientStoreName,
                undefined, // logLevel
                undefined, // useWorker, defaulted
                undefined, // observability
                window.feeFaucetId
              );

            window.helpers.createClientWithKeystore = (
              getKeyCb,
              insertKeyCb,
              signCb,
              clientStoreName
            ) =>
              window.WasmWebClient.createClientWithExternalKeystore(
                window.rpcUrl,
                undefined,
                undefined,
                clientStoreName,
                getKeyCb,
                insertKeyCb,
                signCb,
                undefined, // logLevel
                undefined, // useWorker, defaulted
                undefined, // observability
                window.feeFaucetId
              );

            // Add the remote prover url to window
            window.remoteProverUrl = proverUrl;
            if (window.remoteProverUrl) {
              window.remoteProverInstance =
                window.TransactionProver.newRemoteProver(
                  window.remoteProverUrl,
                  BigInt(120_000)
                );
            }

            window.helpers.waitForTransaction = async (
              transactionId,
              maxWaitTime = 10000,
              delayInterval = 1000
            ) => {
              const client = window.client;
              let timeWaited = 0;
              while (true) {
                if (timeWaited >= maxWaitTime) {
                  throw new Error("Timeout waiting for transaction");
                }
                await client.syncState();
                const uncommittedTransactions = await client.getTransactions(
                  window.TransactionFilter.uncommitted()
                );
                let uncommittedTransactionIds = uncommittedTransactions.map(
                  (transaction) => transaction.id().toHex()
                );
                if (!uncommittedTransactionIds.includes(transactionId)) {
                  break;
                }
                await new Promise((r) => setTimeout(r, delayInterval));
                timeWaited += delayInterval;
              }
            };

            window.helpers.executeAndApplyTransaction = async (
              accountId,
              transactionRequest,
              prover
            ) => {
              const client = window.client;
              const result = await client.executeTransaction(
                accountId,
                transactionRequest
              );

              const useRemoteProver =
                prover != null && window.remoteProverUrl != null;
              const proverToUse = useRemoteProver
                ? window.TransactionProver.newRemoteProver(
                    window.remoteProverUrl,
                    BigInt(120_000)
                  )
                : window.TransactionProver.newLocalProver();

              const proven = await client.proveTransaction(result, proverToUse);
              const submissionHeight = await client.submitProvenTransaction(
                proven,
                result
              );
              return await client.applyTransaction(result, submissionHeight);
            };

            window.helpers.waitForBlocks = async (amountOfBlocks) => {
              const client = window.client;
              let currentBlock = await client.getSyncHeight();
              let finalBlock = currentBlock + amountOfBlocks;
              console.log(
                `Current block: ${currentBlock}, waiting for ${amountOfBlocks} blocks...`
              );
              while (true) {
                let syncSummary = await client.syncState();
                console.log(
                  `Synced to block ${syncSummary.blockNum()} (syncing until ${finalBlock})`
                );
                if (syncSummary.blockNum() >= finalBlock) {
                  return;
                }
                await new Promise((r) => setTimeout(r, 1000));
              }
            };

            window.helpers.refreshClient = async (initSeed) => {
              const client = await WasmWebClient.createClient(
                rpcUrl,
                undefined,
                initSeed,
                window.storeName,
                undefined, // logLevel
                undefined, // useWorker, defaulted
                undefined, // observability
                window.feeFaucetId
              );
              window.client = client;
              await window.client.syncState();
            };

            window.helpers.parseNetworkId = (networkId) => {
              const map = {
                mm: window.NetworkId.mainnet(),
                mtst: window.NetworkId.testnet(),
                mdev: window.NetworkId.devnet(),
              };
              let parsedNetworkId = map[networkId];
              if (parsedNetworkId === undefined) {
                try {
                  parsedNetworkId = window.NetworkId.custom(networkId);
                } catch (error) {
                  throw new Error(
                    `Invalid network ID: ${networkId}. Expected one of: ${Object.keys(map).join(", ")}, or a valid custom network ID`
                  );
                }
              }
              return parsedNetworkId;
            };
          },
          {
            rpcUrl: getRpcUrl(),
            proverUrl: getProverUrl() ?? null,
            storeName,
            feeFaucetId: getFeeFaucetId(),
          }
        );
      }
      await use();
    },
    { auto: true },
  ],
});

export default test;

// Lightweight fixture for mock-only tests that don't need an RPC connection.
// Only loads the SDK exports and WASM module onto the page. Browser-only —
// used by miden_client_api.test.ts and compile_and_contract.test.ts which
// have napi-based duplicates in *.node.test.ts for Node.js coverage.
export const mockTest = base.extend<{ forEachTest: void }>({
  forEachTest: [
    async ({ page }, use, testInfo) => {
      if (testInfo.project.name === "nodejs") {
        throw new Error("mockTest is browser-only");
      }
      page.on("console", (msg) => {
        if (msg.type() === "debug") {
          console.log(`PAGE DEBUG: ${msg.text()}`);
        }
      });

      page.on("pageerror", (err) => {
        console.error("PAGE ERROR:", err);
      });

      page.on("error", (err) => {
        console.error("PUPPETEER ERROR:", err);
      });

      await page.goto("http://localhost:8080");

      await page.evaluate(async () => {
        const sdkExports = await import("./index.js");
        for (const [key, value] of Object.entries(sdkExports)) {
          window[key] = value;
        }
        const wasm = await window.getWasmOrThrow();
        window.AuthScheme = wasm.AuthScheme;
      });

      await use();
    },
    { auto: true },
  ],
});
