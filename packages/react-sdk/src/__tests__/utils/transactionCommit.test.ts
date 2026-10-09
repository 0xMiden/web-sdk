import { describe, it, expect, vi } from "vitest";
import { TransactionFilter, TransactionId } from "@miden-sdk/miden-sdk";
import { waitForTransactionCommit } from "../../utils/transactionCommit";

// Real timers with very short delays: fake timers fight the Date.now() deadline.

type Status = "pending" | "committed" | "discarded" | "absent";

const makeClient = (statuses: Status[]) => {
  let call = 0;
  return {
    syncState: vi.fn().mockResolvedValue(undefined),
    getTransactions: vi.fn().mockImplementation(() => {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call += 1;
      if (status === "absent") return Promise.resolve([]);
      return Promise.resolve([
        {
          transactionStatus: () => ({
            isPending: () => status === "pending",
            isCommitted: () => status === "committed",
            isDiscarded: () => status === "discarded",
          }),
        },
      ]);
    }),
  };
};

const passthrough = <T>(fn: () => Promise<T>) => fn();

describe("waitForTransactionCommit", () => {
  it("resolves when the transaction is committed on the first poll", async () => {
    const client = makeClient(["committed"]);
    await waitForTransactionCommit(client, passthrough, "0xtx", 5_000, 10);
    expect(client.syncState).toHaveBeenCalledTimes(1);
    expect(client.getTransactions).toHaveBeenCalledTimes(1);
  });

  it("polls until the transaction is committed", async () => {
    const client = makeClient(["pending", "pending", "committed"]);
    await waitForTransactionCommit(client, passthrough, "0xtx", 5_000, 10);
    expect(client.syncState).toHaveBeenCalledTimes(3);
    expect(client.getTransactions).toHaveBeenCalledTimes(3);
  });

  it("polls until the record appears", async () => {
    const client = makeClient(["absent", "absent", "committed"]);
    await waitForTransactionCommit(client, passthrough, "0xtx", 5_000, 10);
    expect(client.getTransactions).toHaveBeenCalledTimes(3);
  });

  it("throws when the transaction is discarded", async () => {
    const client = makeClient(["discarded"]);
    await expect(
      waitForTransactionCommit(client, passthrough, "0xtx", 5_000, 10)
    ).rejects.toThrow("Transaction was discarded before commit");
  });

  it("throws when the transaction stays pending past the deadline", async () => {
    const client = makeClient(["pending"]);
    await expect(
      waitForTransactionCommit(client, passthrough, "0xtx", 100, 10)
    ).rejects.toThrow("Timeout waiting for transaction commit");
  });

  it("counts the time spent in each poll against the deadline", async () => {
    const client = makeClient(["pending"]);
    client.syncState.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 30))
    );
    await expect(
      waitForTransactionCommit(client, passthrough, "0xtx", 150, 10)
    ).rejects.toThrow("Timeout waiting for transaction commit");
    // ~40 ms per poll (30 ms sync + 10 ms delay) fits far fewer than 150 / 10.
    expect(client.syncState.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("runs the sync and the lookup of every poll through runExclusiveSafe", async () => {
    const client = makeClient(["committed"]);
    const exclusiveMock = vi.fn((fn: () => Promise<unknown>) => fn());
    const exclusive = exclusiveMock as unknown as <T>(
      fn: () => Promise<T>
    ) => Promise<T>;
    await waitForTransactionCommit(client, exclusive, "0xtx", 50, 10);
    expect(exclusiveMock).toHaveBeenCalledTimes(2);
  });

  it("filters every poll by a fresh TransactionId built from the hex", async () => {
    const client = makeClient(["pending", "committed"]);
    await waitForTransactionCommit(client, passthrough, "0xabc", 5_000, 1);

    expect(vi.mocked(TransactionId.fromHex).mock.calls).toEqual([
      ["0xabc"],
      ["0xabc"],
    ]);
    const polled = vi
      .mocked(TransactionFilter.ids)
      .mock.calls.map(([ids]) => ids[0]);
    expect(polled).toHaveLength(2);
    expect(polled[0]).not.toBe(polled[1]);
  });

  it("adds the 0x prefix fromHex requires and lower-cases the hex", async () => {
    const client = makeClient(["committed"]);
    await waitForTransactionCommit(client, passthrough, " ABC123 ", 5_000, 1);
    expect(TransactionId.fromHex).toHaveBeenCalledWith("0xabc123");
  });
});
