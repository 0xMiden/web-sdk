import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MidenClient } from "../client.js";

// `api-types.d.ts` is the declaration consumers compile against and the source
// typedoc renders, but nothing links it to `client.js` — a method can be
// declared, documented, and shipped without ever being implemented, and both
// the type check and the whole unit suite stay green. That happened to
// `feeAwareTransactionRequestBuilder`. These tests close the loop by reading the
// declared surface and asserting the class actually provides it.

const DECL_PATH = fileURLToPath(
  new URL("../types/api-types.d.ts", import.meta.url)
);

function midenClientDeclarations() {
  const lines = readFileSync(DECL_PATH, "utf8").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("export declare class MidenClient {")
  );
  if (start === -1) {
    throw new Error("MidenClient declaration not found in api-types.d.ts");
  }
  const end = lines.findIndex((line, i) => i > start && line === "}");
  if (end === -1) {
    throw new Error("MidenClient declaration is unterminated");
  }

  const body = lines.slice(start + 1, end);
  const statics = [];
  const methods = [];
  const fields = [];

  for (const line of body) {
    // Members sit at exactly two spaces of indentation; JSDoc continuation
    // lines start with three spaces and an asterisk, so they never match.
    let match = /^ {2}static (\w+)\s*[(<]/.exec(line);
    if (match) {
      statics.push(match[1]);
      continue;
    }
    match = /^ {2}(?:readonly )?(\w+)\s*:/.exec(line);
    if (match) {
      fields.push(match[1]);
      continue;
    }
    // `[(<]`, not `[(]`: a generic method declares as `name<T>(`, which would
    // otherwise match nothing and be skipped silently rather than checked.
    match = /^ {2}(\w+)\s*[(<]/.exec(line);
    if (match) {
      methods.push(match[1]);
    }
  }

  return { statics, methods, fields };
}

describe("MidenClient declared surface", () => {
  const { statics, methods, fields } = midenClientDeclarations();

  it("parses a plausible surface out of api-types.d.ts", () => {
    // Guards the parser itself: a regex that silently stops matching would
    // otherwise turn every assertion below into a vacuous pass.
    expect(statics).toContain("create");
    expect(methods).toContain("sync");
    expect(methods).toContain("feeAwareTransactionRequestBuilder");
    expect(fields).toContain("transactions");
    expect(methods.length).toBeGreaterThan(5);
  });

  it.each(statics)("implements the declared static %s", (name) => {
    expect(typeof MidenClient[name]).toBe("function");
  });

  it.each(methods)("implements the declared method %s", (name) => {
    expect(typeof MidenClient.prototype[name]).toBe("function");
  });

  it.each(fields)("provides the declared field %s", (name) => {
    // The resource fields are assigned per-instance, so they are not on the
    // prototype and constructing a client here would need a real WASM module.
    // Either shape counts: a constructor assignment or a prototype accessor.
    const assignedInConstructor = new RegExp(`this\\.${name}\\s*=`).test(
      MidenClient.toString()
    );
    const accessor = Object.getOwnPropertyDescriptor(
      MidenClient.prototype,
      name
    );
    expect(assignedInConstructor || typeof accessor?.get === "function").toBe(
      true
    );
  });
});
