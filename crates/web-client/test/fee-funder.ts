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
  payload: string;
  claimed: ClaimedFunder;
}

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_FUNDER_DIR = path.join(
  REPO_ROOT,
  "target/test-node/data/funders"
);
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_INTERVAL_MS = 250;
const STALE_EMPTY_LOCK_GRACE_MS = 10_000;
export const REMOTE_TX_PROVER_PORT = 50051;
export const DEFAULT_LOCAL_TX_PROVER_URL = `http://localhost:${REMOTE_TX_PROVER_PORT}`;

let _activeLock: ActiveLock | null = null;
let _exitHookRegistered = false;
let _lockSeq = 0;
const _exposedFunderPages = new WeakSet<Page>();
const _sharedNodeStates = new Map<string, () => Promise<any>>();
const _nodeFunderClients = new Set<any>();

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

function parseLockPid(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const colonIdx = trimmed.indexOf(":");
  const pidPart = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
  if (!/^[1-9]\d*$/.test(pidPart)) return null;
  const pid = Number(pidPart);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isLockStale(raw: string, mtimeMs: number): boolean {
  const pid = parseLockPid(raw);
  if (pid !== null) {
    return !isPidAlive(pid);
  }
  return Date.now() - mtimeMs >= STALE_EMPTY_LOCK_GRACE_MS;
}

function ownsActiveLock(lock: ActiveLock): boolean {
  try {
    return fs.readFileSync(lock.lockPath, "utf8") === lock.payload;
  } catch {
    return false;
  }
}

function publishLockFile(lockPath: string, payload: string): boolean {
  const tmpPath = `${lockPath}.${process.pid}.${++_lockSeq}.tmp`;
  const fd = fs.openSync(tmpPath, "wx");
  try {
    fs.writeFileSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmpPath, lockPath);
    return true;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "EEXIST") {
      return false;
    }
    throw err;
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function tryReapStaleLock(lockPath: string): boolean {
  let content: string;
  let stat: fs.Stats;
  try {
    content = fs.readFileSync(lockPath, "utf8");
    stat = fs.statSync(lockPath);
  } catch {
    return false;
  }

  if (!isLockStale(content, stat.mtimeMs)) {
    return false;
  }

  const reapDir = `${lockPath}.reap`;
  try {
    fs.mkdirSync(reapDir);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "EEXIST") {
      try {
        const reapStat = fs.statSync(reapDir);
        if (Date.now() - reapStat.mtimeMs >= STALE_EMPTY_LOCK_GRACE_MS) {
          fs.rmSync(reapDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore concurrent reap cleanup.
      }
      return false;
    }
    throw err;
  }

  try {
    const current = fs.readFileSync(lockPath, "utf8");
    const currentStat = fs.statSync(lockPath);
    if (current !== content || !isLockStale(current, currentStat.mtimeMs)) {
      return false;
    }
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(reapDir, { recursive: true, force: true });
  }
}

function tryAcquireLock(lockPath: string, payload: string): boolean {
  if (publishLockFile(lockPath, payload)) {
    return true;
  }
  if (!tryReapStaleLock(lockPath)) {
    return false;
  }
  return publishLockFile(lockPath, payload);
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

export function releaseWorkerFunderLock(): void {
  const lock = _activeLock;
  _activeLock = null;
  _sharedNodeStates.clear();
  for (const client of _nodeFunderClients) {
    try {
      void client?.terminate?.()?.catch?.(() => {});
    } catch {
      // Best-effort cleanup on worker exit.
    }
  }
  _nodeFunderClients.clear();
  if (!lock) return;
  try {
    if (ownsActiveLock(lock)) {
      fs.rmSync(lock.lockPath, { force: true });
    }
  } catch {
    // Best-effort cleanup on worker exit.
  }
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
  if (
    _activeLock &&
    fs.existsSync(_activeLock.claimed.path) &&
    ownsActiveLock(_activeLock)
  ) {
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
      const payload = `${process.pid}:${crypto.randomUUID()}\n`;
      if (tryAcquireLock(lockPath, payload)) {
        const bytes = Array.from(fs.readFileSync(macPath));
        const claimed = { path: macPath, bytes };
        _activeLock = { lockPath, payload, claimed };
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
    localTxProverUrl?: string;
    feeFaucetId: string | undefined;
  }
): Promise<void> {
  const { rpcUrl, feeFaucetId } = options;
  const localTxProverUrl =
    options.localTxProverUrl ?? DEFAULT_LOCAL_TX_PROVER_URL;

  if (
    typeof (page as { exposeFunction?: unknown }).exposeFunction ===
      "function" &&
    !_exposedFunderPages.has(page)
  ) {
    await page.exposeFunction(
      "__midenClaimFunderMacBytes",
      (targetRpcUrl: string) => claimFunderMacBytes(targetRpcUrl)?.bytes ?? null
    );
    _exposedFunderPages.add(page);
  }

  await page.evaluate(
    ({ rpcUrl, localTxProverUrl, feeFaucetId, runtimeFactorySource }) => {
      const w = window as unknown as Record<string, any>;
      w.helpers = w.helpers || {};

      let cachedFunderState: any = null;
      let funderStatePromise: Promise<any> | null = null;
      let localProverOnly = !(
        rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")
      );

      const getFunderState = async () => {
        if (cachedFunderState) {
          return cachedFunderState;
        }
        if (!funderStatePromise) {
          funderStatePromise = (async () => {
            let client: any = null;
            try {
              const macBytes =
                typeof w.__midenClaimFunderMacBytes === "function"
                  ? await w.__midenClaimFunderMacBytes(rpcUrl)
                  : null;
              if (!macBytes || macBytes.length === 0) {
                funderStatePromise = null;
                return null;
              }
              const funderStoreName = `funder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              client = await w.WasmWebClient.createClient(
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
                new Uint8Array(macBytes)
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
            } catch (err) {
              funderStatePromise = null;
              await client?.terminate?.().catch(() => {});
              throw err;
            }
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

      const factory = new Function(`return (${runtimeFactorySource});`)();
      const runtime = factory({
        sdk: w,
        getDefaultClient: () => w.client,
        getFunderState,
        proveTransactionWithFallback,
      });

      w.helpers.sendFundingNotes = runtime.sendFundingNotes;
      w.helpers.fundAccounts = runtime.fundAccounts;
      w.helpers.ensureFunded = runtime.ensureFunded;
    },
    {
      rpcUrl,
      localTxProverUrl,
      feeFaucetId,
      runtimeFactorySource: createFundingRuntime.toString(),
    }
  );
}

interface NodeFunderRuntimeOptions {
  sdk: any;
  rpcUrl: string;
  feeFaucetId?: string;
  createFunderClient: (rpcUrl: string, feeFaucetId?: string) => Promise<any>;
  getDefaultClient?: () => any;
}

function createNodeFunderStateGetter(options: {
  sdk: any;
  rpcUrl: string;
  feeFaucetId?: string;
  createFunderClient: (rpcUrl: string, feeFaucetId?: string) => Promise<any>;
}): () => Promise<any> {
  const { sdk, rpcUrl, feeFaucetId, createFunderClient } = options;
  let cachedState: any = null;
  let statePromise: Promise<any> | null = null;

  return async () => {
    const claimed = claimFunderMacBytes(rpcUrl);
    if (!claimed) {
      return null;
    }
    if (cachedState) {
      return cachedState;
    }
    if (!statePromise) {
      statePromise = (async () => {
        let client: any = null;
        try {
          client = await createFunderClient(rpcUrl, feeFaucetId);
          const accountFile = sdk.AccountFile.deserialize(
            new Uint8Array(claimed.bytes)
          );
          const funderHex = accountFile.accountId().toString();
          await client.importAccountFile(accountFile);
          await client.syncState();
          const resolvedFeeFaucet =
            feeFaucetId ?? (await client.feeFaucetId())?.toString();
          _nodeFunderClients.add(client);
          cachedState = {
            client,
            funderHex,
            feeFaucetHex: resolvedFeeFaucet,
            queue: Promise.resolve(),
          };
          return cachedState;
        } catch (err) {
          statePromise = null;
          await client?.terminate?.().catch(() => {});
          throw err;
        }
      })();
    }
    return await statePromise;
  };
}

function buildNodeFundingRuntime(
  sdk: any,
  getFunderState: () => Promise<any>,
  getDefaultClient?: () => any
) {
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
  });
}

export function createNodeFunderRuntime(options: NodeFunderRuntimeOptions) {
  return buildNodeFundingRuntime(
    options.sdk,
    createNodeFunderStateGetter(options),
    options.getDefaultClient
  );
}

export function getSharedNodeFunderRuntime(options: NodeFunderRuntimeOptions) {
  const cacheKey = `${options.rpcUrl}::${options.feeFaucetId ?? ""}`;
  let getFunderState = _sharedNodeStates.get(cacheKey);
  if (!getFunderState) {
    getFunderState = createNodeFunderStateGetter(options);
    _sharedNodeStates.set(cacheKey, getFunderState);
  }
  return buildNodeFundingRuntime(
    options.sdk,
    getFunderState,
    options.getDefaultClient
  );
}
