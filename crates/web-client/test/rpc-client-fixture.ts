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
