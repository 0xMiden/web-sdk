import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Page } from "@playwright/test";
import { createFundingRuntime } from "./fee-funder-core";

interface ClaimedFunder {
  path: string;
  bytes: number[];
}

interface ActiveLock {
  lockPath: string;
  claimed: ClaimedFunder;
}

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_FUNDER_DIR = path.join(
  REPO_ROOT,
  "target/test-node/data/funders"
);
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_INTERVAL_MS = 250;

let _activeLock: ActiveLock | null = null;
let _exitHookRegistered = false;

function isLocalhostRpc(rpcUrl: string): boolean {
  return rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1");
}

function listFunderFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mac"))
    .sort()
    .map((name) => path.join(dir, name));
}

function resolveFunderAccountsDir(rpcUrl: string): string | null {
  const envDir =
    process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR?.trim() ||
    process.env.MIDEN_FUNDER_ACCOUNTS_DIR?.trim();
  if (envDir) {
    const resolved = path.resolve(envDir);
    return listFunderFiles(resolved).length > 0 ? resolved : null;
  }

  if (isLocalhostRpc(rpcUrl)) {
    return listFunderFiles(DEFAULT_FUNDER_DIR).length > 0
      ? DEFAULT_FUNDER_DIR
      : null;
  }

  return null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    return code === "EPERM";
  }
}

function tryAcquireLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "EEXIST") {
      throw err;
    }

    try {
      const content = fs.readFileSync(lockPath, "utf8").trim();
      const holderPid = Number.parseInt(content, 10);
      if (!isPidAlive(holderPid)) {
        fs.rmSync(lockPath, { force: true });
        return tryAcquireLockRetryOnce(lockPath);
      }
    } catch {
      // Another worker may have rotated the lockfile simultaneously.
    }
    return false;
  }
}

function tryAcquireLockRetryOnce(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function releaseWorkerFunderLock(): void {
  if (!_activeLock) return;
  try {
    fs.rmSync(_activeLock.lockPath, { force: true });
  } catch {
    // Best-effort cleanup on worker exit.
  }
  _activeLock = null;
}

function registerExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;
  process.once("exit", releaseWorkerFunderLock);
}

/**
 * Claims one genesis funder wallet `.mac` exclusively for this Node worker
 * process so concurrent Playwright workers never race on the same funder nonce.
 */
export function claimFunderMacBytes(rpcUrl: string): ClaimedFunder | null {
  if (_activeLock && fs.existsSync(_activeLock.claimed.path)) {
    return _activeLock.claimed;
  }
  _activeLock = null;

  const fundersDir = resolveFunderAccountsDir(rpcUrl);
  if (!fundersDir) {
    return null;
  }

  const macFiles = listFunderFiles(fundersDir);
  if (macFiles.length === 0) {
    return null;
  }

  const dirHash = crypto
    .createHash("sha256")
    .update(fundersDir)
    .digest("hex")
    .slice(0, 12);
  const lockDir = path.join(os.tmpdir(), "miden-web-sdk-funder-locks", dirHash);
  fs.mkdirSync(lockDir, { recursive: true });

  const startOffset = process.pid % macFiles.length;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    for (let offset = 0; offset < macFiles.length; offset++) {
      const macPath = macFiles[(startOffset + offset) % macFiles.length];
      const lockPath = path.join(lockDir, `${path.basename(macPath)}.lock`);
      if (tryAcquireLock(lockPath)) {
        const bytes = Array.from(fs.readFileSync(macPath));
        const claimed = { path: macPath, bytes };
        _activeLock = { lockPath, claimed };
        registerExitHook();
        return claimed;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for a free funder wallet in ${fundersDir} (${macFiles.length} wallets busy)`
      );
    }
    sleepSync(LOCK_RETRY_INTERVAL_MS);
  }
}

export async function installBrowserFunderHelpers(
  page: Page,
  options: {
    rpcUrl: string;
    localTxProverUrl: string;
    feeFaucetId: string | undefined;
    funderMacBytes: number[] | null;
  }
): Promise<void> {
  await page.evaluate(
    ({
      rpcUrl,
      localTxProverUrl,
      feeFaucetId,
      funderMacBytes,
      runtimeFactorySource,
    }) => {
      const w = window as unknown as Record<string, any>;
      w.helpers = w.helpers || {};

      let cachedFunderState: any = null;
      let funderStatePromise: Promise<any> | null = null;
      let localProverOnly = !(
        rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")
      );

      const getFunderState = async () => {
        if (!funderMacBytes || funderMacBytes.length === 0) {
          return null;
        }
        if (cachedFunderState) {
          return cachedFunderState;
        }
        if (!funderStatePromise) {
          funderStatePromise = (async () => {
            const funderStoreName = `funder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const client = await w.WasmWebClient.createClient(
              rpcUrl,
              undefined,
              undefined,
              funderStoreName,
              undefined,
              undefined,
              undefined,
              feeFaucetId
            );
            const accountFile = w.AccountFile.deserialize(
              new Uint8Array(funderMacBytes)
            );
            const funderHex = accountFile.accountId().toString();
            await client.importAccountFile(accountFile);
            await client.syncState();
            const feeFaucetHex =
              feeFaucetId ?? (await client.feeFaucetId())?.toString();
            cachedFunderState = {
              client,
              funderHex,
              feeFaucetHex,
              queue: Promise.resolve(),
            };
            return cachedFunderState;
          })();
        }
        return await funderStatePromise;
      };

      const proveTransactionWithFallback = async (
        client: any,
        execResult: any,
        proverOverride: any
      ) => {
        if (proverOverride) {
          return await client.proveTransaction(execResult, proverOverride);
        }
        if (w.remoteProverUrl) {
          const remote = w.TransactionProver.newRemoteProver(
            w.remoteProverUrl,
            BigInt(120_000)
          );
          return await client.proveTransaction(execResult, remote);
        }
        if (!localProverOnly && localTxProverUrl) {
          try {
            const remote = w.TransactionProver.newRemoteProver(
              localTxProverUrl,
              BigInt(120_000)
            );
            return await client.proveTransaction(execResult, remote);
          } catch {
            localProverOnly = true;
          }
        }
        return await client.proveTransaction(
          execResult,
          w.TransactionProver.newLocalProver()
        );
      };

      const transferNoteFile = async (
        funderClient: any,
        targetClient: any,
        noteId: string
      ): Promise<boolean> => {
        try {
          const noteFile = await funderClient.exportNoteFile(
            noteId,
            w.NoteExportFormat.Full
          );
          const bytes = noteFile.serialize();
          await targetClient.importNoteFile(w.NoteFile.deserialize(bytes));
          return true;
        } catch {
          return false;
        }
      };

      const factory = new Function(`return (${runtimeFactorySource});`)();
      const runtime = factory({
        sdk: w,
        getDefaultClient: () => w.client,
        getFunderState,
        proveTransactionWithFallback,
        transferNoteFile,
      });

      w.helpers.sendFundingNotes = runtime.sendFundingNotes;
      w.helpers.fundAccounts = runtime.fundAccounts;
      w.helpers.ensureFunded = runtime.ensureFunded;
    },
    {
      ...options,
      runtimeFactorySource: createFundingRuntime.toString(),
    }
  );
}

export function createNodeFunderRuntime(options: {
  sdk: any;
  rpcUrl: string;
  feeFaucetId?: string;
  createFunderClient: (rpcUrl: string, feeFaucetId?: string) => Promise<any>;
  getDefaultClient?: () => any;
}) {
  const { sdk, rpcUrl, feeFaucetId, createFunderClient, getDefaultClient } =
    options;

  let cachedState: any = null;
  let statePromise: Promise<any> | null = null;

  const getFunderState = async () => {
    const claimed = claimFunderMacBytes(rpcUrl);
    if (!claimed) {
      return null;
    }
    if (cachedState) {
      return cachedState;
    }
    if (!statePromise) {
      statePromise = (async () => {
        const client = await createFunderClient(rpcUrl, feeFaucetId);
        const accountFile = sdk.AccountFile.deserialize(
          new Uint8Array(claimed.bytes)
        );
        const funderHex = accountFile.accountId().toString();
        await client.importAccountFile(accountFile);
        await client.syncState();
        const resolvedFeeFaucet =
          feeFaucetId ?? (await client.feeFaucetId())?.toString();
        cachedState = {
          client,
          funderHex,
          feeFaucetHex: resolvedFeeFaucet,
          queue: Promise.resolve(),
        };
        return cachedState;
      })();
    }
    return await statePromise;
  };

  return createFundingRuntime({
    sdk,
    getDefaultClient: getDefaultClient ?? (() => undefined),
    getFunderState,
    proveTransactionWithFallback: async (
      client: any,
      execResult: any,
      proverOverride: any
    ) =>
      await client.proveTransaction(
        execResult,
        proverOverride ?? sdk.TransactionProver.newLocalProver()
      ),
    transferNoteFile: async (
      funderClient: any,
      targetClient: any,
      noteId: string
    ) => {
      try {
        const noteFile = await funderClient.exportNoteFile(
          noteId,
          sdk.NoteExportFormat.Full
        );
        const bytes = noteFile.serialize();
        await targetClient.importNoteFile(sdk.NoteFile.deserialize(bytes));
        return true;
      } catch {
        return false;
      }
    },
  });
}
