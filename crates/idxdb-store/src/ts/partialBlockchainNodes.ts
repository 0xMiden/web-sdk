import type { Table } from "dexie";

import type { IPartialBlockchainNode } from "./schema.js";

export async function addPartialBlockchainNodes(
  table: Table<IPartialBlockchainNode, number>,
  nodes: IPartialBlockchainNode[]
): Promise<void> {
  const uniqueNodes = new Map<number, IPartialBlockchainNode>();

  for (const node of nodes) {
    const duplicate = uniqueNodes.get(node.id);
    if (duplicate && duplicate.node !== node.node) {
      throw new Error(
        `Conflicting partial blockchain node at index ${node.id}`
      );
    }
    uniqueNodes.set(node.id, node);
  }

  const records = [...uniqueNodes.values()];
  const existing = await table.bulkGet(records.map(({ id }) => id));
  const missing: IPartialBlockchainNode[] = [];

  for (const [index, record] of records.entries()) {
    const stored = existing[index];
    if (stored && stored.node !== record.node) {
      throw new Error(
        `Conflicting partial blockchain node at index ${record.id}`
      );
    }
    if (!stored) {
      missing.push(record);
    }
  }

  if (missing.length > 0) {
    await table.bulkAdd(missing);
  }
}
