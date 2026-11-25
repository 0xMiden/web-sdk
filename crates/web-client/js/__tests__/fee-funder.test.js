import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as feeFunder from "../../test/fee-funder";

function lockDirFor(fundersDir) {
  const dirHash = crypto
    .createHash("sha256")
    .update(fundersDir)
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), "miden-web-sdk-funder-locks", dirHash);
}

describe("fee-funder worker locking", () => {
  const createdDirs = [];
  const originalEnvDir = process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof feeFunder.releaseWorkerFunderLock === "function") {
      feeFunder.releaseWorkerFunderLock();
    }
    if (originalEnvDir === undefined) {
      delete process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR;
    } else {
      process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR = originalEnvDir;
    }
    while (createdDirs.length > 0) {
      fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
    }
  });

  function setupTempFunders(count) {
    const fundersDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miden-fee-funder-test-")
    );
    const lockDir = lockDirFor(fundersDir);
    createdDirs.push(fundersDir, lockDir);
    const macFiles = [];
    for (let i = 0; i < count; i++) {
      const macPath = path.join(
        fundersDir,
        `wallet_${String(i).padStart(4, "0")}.mac`
      );
      fs.writeFileSync(macPath, Buffer.from([i + 1, i + 2, i + 3]));
      macFiles.push(macPath);
    }
    fs.mkdirSync(lockDir, { recursive: true });
    process.env.TEST_MIDEN_FUNDER_ACCOUNTS_DIR = fundersDir;
    return { fundersDir, lockDir, macFiles };
  }

  it("does not evict a fresh empty or unparseable lockfile during contention", () => {
    const { lockDir, macFiles } = setupTempFunders(2);
    const firstIdx = process.pid % macFiles.length;
    const secondIdx = (firstIdx + 1) % macFiles.length;
    const contendedLock = path.join(
      lockDir,
      `${path.basename(macFiles[firstIdx])}.lock`
    );
    fs.writeFileSync(contendedLock, "");

    const claimed = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(claimed?.path).toBe(macFiles[secondIdx]);
    expect(fs.readFileSync(contendedLock, "utf8")).toBe("");
  });

  it("evicts a dead-PID stale lockfile through .reap and cleans up .reap", () => {
    const { lockDir, macFiles } = setupTempFunders(2);
    const firstIdx = process.pid % macFiles.length;
    const secondIdx = (firstIdx + 1) % macFiles.length;
    const staleLock = path.join(
      lockDir,
      `${path.basename(macFiles[firstIdx])}.lock`
    );
    const liveLock = path.join(
      lockDir,
      `${path.basename(macFiles[secondIdx])}.lock`
    );
    fs.writeFileSync(staleLock, "999999999:dead-worker\n");
    fs.writeFileSync(liveLock, `${process.pid}:other-live-claim\n`);

    const claimed = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(claimed?.path).toBe(macFiles[firstIdx]);
    expect(fs.existsSync(`${staleLock}.reap`)).toBe(false);
    const payload = fs.readFileSync(staleLock, "utf8").trim();
    expect(payload).toMatch(new RegExp(`^${process.pid}:.+`));
  });

  it("re-checks lock identity inside .reap and aborts unlink if rotated to a live owner", () => {
    const { lockDir, macFiles } = setupTempFunders(2);
    const firstIdx = process.pid % macFiles.length;
    const secondIdx = (firstIdx + 1) % macFiles.length;
    const rotatedLock = path.join(
      lockDir,
      `${path.basename(macFiles[firstIdx])}.lock`
    );
    fs.writeFileSync(rotatedLock, "999999999:dead-worker\n");

    const origMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation((target, opts) => {
      const res = origMkdirSync(target, opts);
      if (String(target) === `${rotatedLock}.reap`) {
        fs.writeFileSync(rotatedLock, `${process.pid}:winner-token\n`);
      }
      return res;
    });

    const claimed = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(claimed?.path).toBe(macFiles[secondIdx]);
    expect(fs.readFileSync(rotatedLock, "utf8")).toBe(
      `${process.pid}:winner-token\n`
    );
    expect(fs.existsSync(`${rotatedLock}.reap`)).toBe(false);
  });

  it("verifies pid:token ownership on cache reuse and releaseWorkerFunderLock", () => {
    const { lockDir } = setupTempFunders(3);
    const first = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(first).not.toBeNull();
    expect(feeFunder.claimFunderMacBytes("http://localhost:57291")).toBe(first);

    const firstLockPath = path.join(
      lockDir,
      `${path.basename(first.path)}.lock`
    );
    const otherOwner = `${process.pid}:displaced-token\n`;
    fs.writeFileSync(firstLockPath, otherOwner);

    feeFunder.releaseWorkerFunderLock();
    expect(fs.existsSync(firstLockPath)).toBe(true);
    expect(fs.readFileSync(firstLockPath, "utf8")).toBe(otherOwner);

    const second = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(second).not.toBeNull();
    const displacedLockPath = path.join(
      lockDir,
      `${path.basename(second.path)}.lock`
    );
    fs.writeFileSync(displacedLockPath, otherOwner);

    const reacquired = feeFunder.claimFunderMacBytes("http://localhost:57291");
    expect(reacquired).not.toBeNull();
    expect(reacquired.path).not.toBe(second.path);
    expect(fs.readFileSync(displacedLockPath, "utf8")).toBe(otherOwner);

    const reacquiredLockPath = path.join(
      lockDir,
      `${path.basename(reacquired.path)}.lock`
    );
    feeFunder.releaseWorkerFunderLock();
    expect(fs.existsSync(reacquiredLockPath)).toBe(false);
  });
});
