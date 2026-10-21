import { expect } from "@playwright/test";

// Minimal wire fixtures for miden-node-proto's rpc.proto and primitives.proto.
// Both gRPC-web and native HTTP/2 tests talk to the real Rust RPC client.
function varint(value: number): Buffer {
  const bytes = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function fixed32Field(field: number, value: number): Buffer {
  const bytes = Buffer.alloc(5);
  bytes[0] = (field << 3) | 5;
  bytes.writeUInt32LE(value, 1);
  return bytes;
}

function readVarint(bytes: Buffer, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  while (cursor.offset < bytes.length) {
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  throw new Error("Truncated protobuf varint");
}

function fields(bytes: Buffer): Map<number, (Buffer | number)[]> {
  const result = new Map<number, (Buffer | number)[]>();
  const cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor);
    let value: Buffer | number;
    switch (tag & 7) {
      case 0:
        value = readVarint(bytes, cursor);
        break;
      case 2: {
        const length = readVarint(bytes, cursor);
        value = bytes.subarray(cursor.offset, cursor.offset + length);
        cursor.offset += length;
        break;
      }
      case 5:
        value = bytes.readUInt32LE(cursor.offset);
        cursor.offset += 4;
        break;
      default:
        throw new Error(`Unexpected protobuf wire type ${tag & 7}`);
    }
    const field = tag >>> 3;
    result.set(field, [...(result.get(field) ?? []), value]);
  }
  return result;
}

export function syncRequest(body: Buffer) {
  expect(body[0]).toBe(0);
  expect(body.readUInt32BE(1)).toBe(body.length - 5);
  const request = fields(body.subarray(5));
  const range = fields(request.get(1)![0] as Buffer);
  const prefixes = (request.get(3) ?? []).flatMap((value) => {
    if (typeof value === "number") return [value];
    const result = [];
    const cursor = { offset: 0 };
    while (cursor.offset < value.length) {
      result.push(readVarint(value, cursor));
    }
    return result;
  });
  return {
    blockFrom: range.get(1)?.[0] ?? 0,
    blockTo: range.get(2)?.[0] ?? 0,
    prefixLength: request.get(2)?.[0] ?? 0,
    prefixes,
  };
}

export const limits = Buffer.concat(
  [
    ["GetNotesById", "note_id"],
    ["SyncNullifiers", "nullifier_prefix"],
    ["SyncTransactions", "account_id"],
    ["SyncNotes", "note_tag"],
  ].map(([endpoint, parameter]) =>
    bytesField(
      1,
      Buffer.concat([
        bytesField(1, Buffer.from(endpoint)),
        bytesField(
          2,
          bytesField(
            1,
            Buffer.concat([
              bytesField(1, Buffer.from(parameter)),
              Buffer.from([0x10, 1]),
            ])
          )
        ),
      ])
    )
  )
);

export function nullifierPage(prefix: number, blockNum: number): Buffer {
  const word = Buffer.alloc(32);
  word.writeBigUInt64LE(BigInt(blockNum), 0);
  word.writeBigUInt64LE(BigInt(prefix) << 48n, 24);
  return Buffer.concat([
    bytesField(
      1,
      Buffer.concat([fixed32Field(1, 12), fixed32Field(2, blockNum)])
    ),
    bytesField(
      2,
      Buffer.concat([
        bytesField(1, bytesField(1, word)),
        fixed32Field(2, blockNum),
      ])
    ),
  ]);
}

export function frame(body: Buffer, type = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export const transactionAccounts = [
  "0xc6da5c4573a3731151114a1aa8fe8e",
  "0x6ccbb3931bbb21910bb3018972d56d",
];

// Poseidon2 transaction IDs for zero initial state, final state [1|2, 0, 0, 0],
// and empty input/output notes. The Rust decoder verifies these header IDs.
export const transactionIds = [
  "0x1e7e9f4ff0f6f939f60a2f6d10a4fc031a64def2fc66cb968acfc004b1e2d433",
  "0x79e4476648bc2da19e8bb298ea4424ebb2d5c5bcaf1e7ab20a535f46201dd37b",
];

export function transactionAccount(hex: string): Buffer {
  const felt = (value: bigint) => {
    const bytes = Buffer.alloc(9);
    bytes[0] = 0x09; // Felt.value: fixed64 field 1.
    bytes.writeBigUInt64LE(value, 1);
    return bytes;
  };
  return bytesField(
    1,
    Buffer.concat([
      bytesField(1, felt(BigInt(`0x${hex.slice(18)}00`))),
      bytesField(2, felt(BigInt(hex.slice(0, 18)))),
    ])
  );
}

export function transactionRequest(body: Buffer) {
  expect(body[0]).toBe(0);
  expect(body.readUInt32BE(1)).toBe(body.length - 5);
  const request = fields(body.subarray(5));
  const range = fields(request.get(1)![0] as Buffer);
  return {
    blockFrom: range.get(1)?.[0] ?? 0,
    blockTo: range.get(2)?.[0] ?? 0,
    accountIds: (request.get(2) ?? []) as Buffer[],
  };
}

export function transactionPage(
  blockNum: number,
  records: { accountId: string; finalState: 1 | 2; blockNum: number }[] = []
): Buffer {
  return Buffer.concat([
    bytesField(
      1,
      Buffer.concat([fixed32Field(1, 12), fixed32Field(2, blockNum)])
    ),
    ...records.map((record) => {
      const finalState = Buffer.alloc(32);
      finalState.writeBigUInt64LE(BigInt(record.finalState));
      const header = Buffer.concat([
        bytesField(
          1,
          bytesField(
            1,
            bytesField(
              1,
              Buffer.from(transactionIds[record.finalState - 1].slice(2), "hex")
            )
          )
        ),
        bytesField(2, transactionAccount(record.accountId)),
        bytesField(3, bytesField(1, Buffer.alloc(32))),
        bytesField(4, bytesField(1, finalState)),
      ]);
      return bytesField(
        2,
        Buffer.concat([fixed32Field(1, record.blockNum), bytesField(2, header)])
      );
    }),
  ]);
}
