import Dexie from "dexie";
import type { IPartialBlockchainNode } from "./schema.js";
// Helper for undefined values, like map for Option<T> in Rust.
// A better name for this is welcome.
export const mapOption = <T, U>(
  value: T | null | undefined,
  func: (value: T) => U
): U | undefined => {
  return value != undefined ? func(value) : undefined;
};

// Anything can be thrown as an error in raw JS (also the TS compiler can't type-check exceptions),
// so we allow it here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const logWebStoreError = (error: any, errorContext?: string) => {
  if (error instanceof Dexie.DexieError) {
    if (errorContext) {
      console.error(
        `${errorContext}: Indexdb error (${error.name}): ${error.message}`
      );
    } else {
      console.error(`Indexdb error: (${error.name}): ${error.message}`);
    }
    mapOption(error.stack, (stack) => {
      console.error(`Stacktrace: \n ${stack}`);
    });
    mapOption(error.inner, (innerException) =>
      logWebStoreError(innerException as Error)
    );
  } else if (error instanceof Error) {
    console.error(
      `Unexpected error while accessing indexdb: ${error.toString()}`
    );
    mapOption(error.stack, (stack) => {
      console.error(`Stacktrace: ${stack}`);
    });
  } else {
    console.error(
      `Got an exception with a non-error value, as JSON: \n ${JSON.stringify(error)}. As String \n ${String(error)} `
    );
    console.trace();
  }
  throw error;
};

// Partial blockchain (MMR) authentication nodes are part of the local
// `PartialMmr` state. Once a node index is known its value is fixed, so a
// later write with the same index but a different value indicates a buggy or
// malicious sync path. Insert nodes that are missing, accept writes that match
// the stored value, and reject conflicting writes so the known-good value is
// never silently overwritten.
export const putPartialBlockchainNodesNoOverwrite = async (
  table: Dexie.Table<IPartialBlockchainNode, number>,
  data: IPartialBlockchainNode[]
) => {
  // Collapse duplicate indexes within the same batch up front: identical
  // copies are deduplicated (a repeated index would otherwise make `bulkAdd`
  // throw a key-collision error), and copies that disagree are rejected.
  const unique = new Map<number, IPartialBlockchainNode>();
  for (const entry of data) {
    const seen = unique.get(entry.id);
    if (seen !== undefined && seen.node !== entry.node) {
      throw new Error(
        `Conflicting partial blockchain node ${entry.id} within the same write`
      );
    }
    unique.set(entry.id, entry);
  }
  const records = [...unique.values()];

  const existing = await table.bulkGet(records.map((entry) => entry.id));
  const toAdd: IPartialBlockchainNode[] = [];
  for (let i = 0; i < records.length; i++) {
    const current = existing[i];
    if (current === undefined) {
      toAdd.push(records[i]);
    } else if (current.node !== records[i].node) {
      throw new Error(
        `Refusing to overwrite partial blockchain node ${records[i].id}: ` +
          `stored value differs from the new value`
      );
    }
    // current.node === records[i].node: already stored, nothing to do.
  }
  if (toAdd.length > 0) {
    await table.bulkAdd(toAdd);
  }
};

export const uint8ArrayToBase64 = (bytes: Uint8Array) => {
  const binary = bytes.reduce(
    (acc, byte) => acc + String.fromCharCode(byte),
    ""
  );
  return btoa(binary);
};
