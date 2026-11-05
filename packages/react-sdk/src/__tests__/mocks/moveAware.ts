import { vi } from "vitest";
import { TransactionFilter, TransactionId } from "@miden-sdk/miden-sdk";

/**
 * Move-aware stand-ins for the by-value WASM handles behind transaction
 * lookups.
 *
 * wasm-bindgen moves an argument the Rust side takes by value into WASM and
 * zeroes the JS wrapper's pointer, so any later use of that wrapper throws.
 * `TransactionFilter.ids` takes its `TransactionId`s by value and
 * `getTransactions` takes its `TransactionFilter` by value. The plain mocks
 * in `setup.ts` return reusable objects, which hides a handle that is passed
 * in twice; these mocks fail the way the real bindings do.
 */

export const MOVED_HANDLE_ERROR = "null pointer passed to rust";

type MoveAwareHandle = { ptr: number };

let nextPtr = 1;

function assertLive(handle: MoveAwareHandle | null | undefined): void {
  if (!handle || handle.ptr === 0) {
    throw new Error(MOVED_HANDLE_ERROR);
  }
}

/** Consume a handle the way a by-value WASM argument does. */
export function moveIntoWasm(handle: MoveAwareHandle): void {
  assertLive(handle);
  handle.ptr = 0;
}

export function createMoveAwareTransactionId(hex: string) {
  const handle = {
    ptr: nextPtr++,
    toHex: vi.fn(() => {
      assertLive(handle);
      return hex;
    }),
    free: vi.fn(),
  };
  return handle;
}

export type MoveAwareTransactionId = ReturnType<
  typeof createMoveAwareTransactionId
>;

export type MoveAwareTransactionFilter = MoveAwareHandle & {
  /** Hex of the ids the filter selects, or `null` for "all". */
  ids: string[] | null;
};

/**
 * Point `TransactionId.fromHex`, `TransactionFilter.all/uncommitted/ids` at
 * move-aware handles. Returns a function that restores the previous mocks.
 */
export function installMoveAwareTransactionMocks(): () => void {
  const fromHex = vi.mocked(TransactionId.fromHex);
  const all = vi.mocked(TransactionFilter.all);
  const uncommitted = vi.mocked(TransactionFilter.uncommitted);
  const ids = vi.mocked(TransactionFilter.ids);
  const previous = {
    fromHex: fromHex.getMockImplementation(),
    all: all.getMockImplementation(),
    uncommitted: uncommitted.getMockImplementation(),
    ids: ids.getMockImplementation(),
  };

  const makeFilter = (
    selected: string[] | null
  ): MoveAwareTransactionFilter => ({
    ptr: nextPtr++,
    ids: selected,
  });

  fromHex.mockImplementation(
    (hex: string) =>
      createMoveAwareTransactionId(hex) as unknown as TransactionId
  );
  all.mockImplementation(
    () => makeFilter(null) as unknown as TransactionFilter
  );
  uncommitted.mockImplementation(
    () => makeFilter(null) as unknown as TransactionFilter
  );
  ids.mockImplementation((list: TransactionId[]) => {
    const handles = list as unknown as MoveAwareTransactionId[];
    // Read every hex before moving anything, as the binding converts the
    // whole Vec on entry.
    const selected = handles.map((handle) => handle.toHex());
    handles.forEach((handle) => moveIntoWasm(handle));
    return makeFilter(selected) as unknown as TransactionFilter;
  });

  return () => {
    fromHex.mockImplementation(previous.fromHex as never);
    all.mockImplementation(previous.all as never);
    uncommitted.mockImplementation(previous.uncommitted as never);
    ids.mockImplementation(previous.ids as never);
  };
}

/**
 * A `getTransactions` that consumes its filter like the binding and returns
 * whatever `records` yields for it.
 */
export function moveAwareGetTransactions<R>(
  records: (filter: MoveAwareTransactionFilter) => R[]
) {
  return vi.fn(async (filter: TransactionFilter) => {
    const handle = filter as unknown as MoveAwareTransactionFilter;
    moveIntoWasm(handle);
    return records(handle);
  });
}
