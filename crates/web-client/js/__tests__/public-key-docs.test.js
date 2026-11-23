import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const MESSAGE = "recoverFrom rustdoc must require verify() over the message";

function recoverFromRustdoc() {
  const source = readFileSync(
    new URL("../../src/models/public_key.rs", import.meta.url),
    "utf8"
  );
  const lines = source.split("\n");
  const attr = lines.findIndex((line) =>
    line.includes('#[js_export(js_name = "recoverFrom")]')
  );
  const doc = [];
  for (let i = attr - 1; i >= 0 && /^\s*\/\/\//.test(lines[i]); i--) {
    doc.unshift(lines[i]);
  }
  return doc
    .map((line) => line.replace(/^\s*\/\/\/ ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

it("requires verify() over the same message as the commitment check", () => {
  const joined = recoverFromRustdoc();
  expect(joined, MESSAGE).toMatch(
    /`recovered\.verify\(message, signature\)` returns `true` for this same message and signature/
  );
  expect(joined, MESSAGE).toMatch(
    /only when `recovered\.toCommitment\(\)` equals a commitment from a trusted source/
  );
  expect(joined, MESSAGE).toMatch(
    /Falcon recovery returns the public key embedded in the signature and does not read the message/
  );
});
