import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { TransactionFilter, TransactionId } from "@miden-sdk/miden-sdk";
import { waitForTransactionCommit } from "../../utils/transactionCommit";
import {
  MOVED_HANDLE_ERROR,
  installMoveAwareTransactionMocks,
  moveAwareGetTransactions,
} from "../mocks/moveAware";

describe("waitForTransactionCommit", () => {
  // Uses real timers with very short delays to avoid fake-timer / Date.now()
  // interaction issues that cause unhandled rejection warnings.

  const TX_HEX = "0xtx123";

  const createMockClient = (
    statusSequence: Array<"pending" | "committed" | "discarded"> = ["committed"]
  ) => {
    let callIndex = 0;
    return {
      syncState: vi.fn().mockResolvedValue(undefined),
      getTransactions: vi.fn().mockImplementation(() => {
        const status = statusSequence[callIndex] ?? "pending";
        callIndex++;
        return Promise.resolve([
          {
            id: vi.fn(() => ({ toHex: vi.fn(() => TX_HEX) })),
            transactionStatus: vi.fn(() => ({
              isPending: vi.fn(() => status === "pending"),
              isCommitted: vi.fn(() => status === "committed"),
              isDiscarded: vi.fn(() => status === "discarded"),
            })),
          },
        ]);
      }),
    };
  };

  const mockRunExclusive = async <T>(fn: () => Promise<T>): Promise<T> => fn();

  it("should resolve when transaction is committed on first check", async () => {
    const client = createMockClient(["committed"]);

    await waitForTransactionCommit(
      client as never,
      mockRunExclusive,
      TX_HEX,
      5000,
      10
    );

    expect(client.syncState).toHaveBeenCalledTimes(1);
    expect(client.getTransactions).toHaveBeenCalledTimes(1);
  });

  it("should poll until transaction is committed", async () => {
    const client = createMockClient(["pending", "pending", "committed"]);

    await waitForTransactionCommit(
      client as never,
      mockRunExclusive,
      TX_HEX,
      5000,
      10
    );

    expect(client.syncState).toHaveBeenCalledTimes(3);
    expect(client.getTransactions).toHaveBeenCalledTimes(3);
  });

  it("should throw on discarded transaction", async () => {
    const client = createMockClient(["discarded"]);

    await expect(
      waitForTransactionCommit(
        client as never,
        mockRunExclusive,
        TX_HEX,
        5000,
        10
      )
    ).rejects.toThrow("Transaction was discarded before commit");
  });

  it("should throw on timeout", async () => {
    const client = createMockClient([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    await expect(
      waitForTransactionCommit(
        client as never,
        mockRunExclusive,
        TX_HEX,
        100,
        10
      )
    ).rejects.toThrow("Timeout waiting for transaction commit");
  });

  it("should normalize the hex it builds the TransactionId from", async () => {
    const client = createMockClient(["committed"]);

    // Uppercase hex without the 0x prefix `TransactionId.fromHex` wants.
    await waitForTransactionCommit(
      client as never,
      mockRunExclusive,
      "TX123",
      5000,
      10
    );

    expect(client.getTransactions).toHaveBeenCalledTimes(1);
    expect(TransactionId.fromHex).toHaveBeenCalledWith("0xtx123");
  });

  it("should use wall-clock time including async operation duration", async () => {
    const client = {
      syncState: vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 30))
        ),
      getTransactions: vi.fn().mockResolvedValue([
        {
          id: vi.fn(() => ({ toHex: vi.fn(() => TX_HEX) })),
          transactionStatus: vi.fn(() => ({
            isPending: vi.fn(() => true),
            isCommitted: vi.fn(() => false),
            isDiscarded: vi.fn(() => false),
          })),
        },
      ]),
    };

    await expect(
      waitForTransactionCommit(
        client as never,
        mockRunExclusive,
        TX_HEX,
        150,
        10
      )
    ).rejects.toThrow("Timeout waiting for transaction commit");

    // Each iteration takes ~40ms (30ms sync + 10ms delay), so with wall-clock
    // time we should complete fewer iterations than 150/10 = 15
    expect(client.syncState.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("gives up at maxWaitMs, not a full delay later", async () => {
    const client = createMockClient(["pending"]);

    const start = Date.now();
    await expect(
      waitForTransactionCommit(
        client as never,
        mockRunExclusive,
        TX_HEX,
        50,
        5000
      )
    ).rejects.toThrow("Timeout waiting for transaction commit");
    expect(Date.now() - start).toBeLessThan(1000);
  }, 10000);
});

const passthrough = <T>(fn: () => Promise<T>) => fn();

const makeClient = (
  status: "committed" | "pending" | "discarded",
  options: { firstCalls?: number } = {}
) => {
  let calls = 0;
  return {
    syncState: vi.fn().mockResolvedValue(undefined),
    getTransactions: vi.fn().mockImplementation(() => {
      calls += 1;
      // Optionally return no record for the first N calls (to simulate the
      // record showing up later).
      if (options.firstCalls && calls <= options.firstCalls) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          id: () => ({ toHex: () => "0xtx" }),
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

describe("waitForTransactionCommit (exclusive runner and record arrival)", () => {
  it("resolves immediately when the tx is already committed", async () => {
    const client = makeClient("committed");
    const txId = "0xtx";
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 100, 10)
    ).resolves.toBeUndefined();
    expect(client.syncState).toHaveBeenCalledTimes(1);
  });

  it("throws when the tx becomes discarded", async () => {
    const client = makeClient("discarded");
    const txId = "0xtx";
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 100, 10)
    ).rejects.toThrow("discarded before commit");
  });

  it("times out when the tx stays pending past maxWaitMs", async () => {
    const client = makeClient("pending");
    const txId = "0xtx";
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 30, 10)
    ).rejects.toThrow("Timeout waiting for transaction commit");
  });

  it("counts time spent syncing toward maxWaitMs", async () => {
    const client = makeClient("pending");
    client.syncState.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 40))
    );
    const txId = "0xtx";
    const start = Date.now();
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 50, 5)
    ).rejects.toThrow("Timeout waiting for transaction commit");
    expect(Date.now() - start).toBeLessThan(300);
  }, 10000);

  it("polls until the tx record appears, then commits", async () => {
    // First two getTransactions calls return [], third returns committed.
    const client = makeClient("committed", { firstCalls: 2 });
    const txId = "0xtx";
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 200, 10)
    ).resolves.toBeUndefined();
    expect(client.getTransactions).toHaveBeenCalledTimes(3);
  });

  it("calls runExclusiveSafe for sync + getTransactions on every tick", async () => {
    const client = makeClient("committed");
    const exclusiveMock = vi.fn((fn: () => Promise<unknown>) => fn());
    // vi.fn() can't preserve a generic signature on a single overload, so we
    // cast a separate reference for the runExclusive parameter while keeping
    // the Mock typing for the assertion below.
    const exclusive = exclusiveMock as unknown as <T>(
      fn: () => Promise<T>
    ) => Promise<T>;
    const txId = "0xtx";
    await waitForTransactionCommit(client, exclusive, txId, 50, 10);
    // One sync + one getTransactions per tick; one tick suffices.
    expect(exclusiveMock).toHaveBeenCalledTimes(2);
  });
});

describe("waitForTransactionCommit with by-value WASM handles", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installMoveAwareTransactionMocks();
  });

  afterEach(() => {
    restore();
  });

  const statusRecord = (status: "pending" | "committed") => ({
    transactionStatus: () => ({
      isPending: () => status === "pending",
      isCommitted: () => status === "committed",
      isDiscarded: () => false,
    }),
  });

  it("survives several polls: every poll gets a fresh TransactionId and filter", async () => {
    const statuses: Array<"pending" | "committed"> = [
      "pending",
      "pending",
      "committed",
    ];
    let poll = 0;
    const getTransactions = moveAwareGetTransactions((filter) => {
      expect(filter.ids).toEqual(["0xtx123"]);
      return [statusRecord(statuses[poll++] ?? "pending")];
    });
    const client = {
      syncState: vi.fn().mockResolvedValue(undefined),
      getTransactions,
    };

    await expect(
      waitForTransactionCommit(
        client as never,
        (fn) => fn(),
        "0xTX123",
        1000,
        1
      )
    ).resolves.toBeUndefined();

    expect(getTransactions).toHaveBeenCalledTimes(3);
    expect(TransactionId.fromHex).toHaveBeenCalledTimes(3);
    expect(TransactionFilter.ids).toHaveBeenCalledTimes(3);
  });

  it("the mock rejects a reused handle the way the binding does", () => {
    const txId = TransactionId.fromHex("0xtx123");
    TransactionFilter.ids([txId]);
    expect(() => TransactionFilter.ids([txId])).toThrow(MOVED_HANDLE_ERROR);
    expect(() => txId.toHex()).toThrow(MOVED_HANDLE_ERROR);
  });
});
