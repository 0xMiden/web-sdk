import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { MidenClient } from "../client.js";

// `api-types.d.ts` is the declaration consumers compile against and the source
// typedoc renders, but nothing links it to `client.js` — a method can be
// declared, documented, and shipped without ever being implemented, and both
// the type check and the whole unit suite stay green. That happened to
// `feeAwareTransactionRequestBuilder`. These tests close the loop in both
// directions: the class must provide everything declared, and must not carry
// public surface nothing declares.
//
// Read through the TypeScript parser rather than by matching lines. A regex
// over the text misses every declaration shape it was not written for —
// computed names like `[Symbol.dispose]()`, optional members, quoted names,
// signatures wrapped across lines — and a miss is silent, which turns the
// guard into a vacuous pass exactly where it is least obvious.

const DECL_PATH = fileURLToPath(
  new URL("../types/api-types.d.ts", import.meta.url)
);

// Implementation details that are deliberately not part of the declared API.
// Underscore-prefixed members are internal by the repo's convention; the rest
// are named individually so adding one is a decision rather than a slip.
const UNDECLARED_BY_DESIGN = new Set(["assertNotTerminated"]);

const isInternal = (name) =>
  name.startsWith("_") || UNDECLARED_BY_DESIGN.has(name);

// Resolves a member's name to the key it will have at runtime: an identifier or
// string literal to itself, and `[Symbol.x]` to the actual well-known symbol.
function memberKey(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "Symbol"
    ) {
      return Symbol[expr.name.text];
    }
  }
  return null;
}

function midenClientDeclarations() {
  const source = ts.createSourceFile(
    DECL_PATH,
    readFileSync(DECL_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let classNode = null;
  const find = (node) => {
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      node.name.text === "MidenClient"
    ) {
      classNode = node;
      return;
    }
    ts.forEachChild(node, find);
  };
  find(source);
  if (!classNode) {
    throw new Error("MidenClient declaration not found in api-types.d.ts");
  }

  const statics = [];
  const methods = [];
  const fields = [];

  for (const member of classNode.members) {
    if (!member.name) continue;
    const key = memberKey(member.name);
    // An unresolvable name means the parser met a shape this test does not
    // model. Fail loudly rather than skipping it, which is how the previous
    // regex version lost `[Symbol.dispose]` without anyone noticing.
    expect(
      key,
      `unhandled member name in the MidenClient declaration: ${member.name.getText(source)}`
    ).not.toBeNull();

    const isStatic = member.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.StaticKeyword
    );

    if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
      (isStatic ? statics : methods).push(key);
    } else if (
      ts.isPropertySignature(member) ||
      ts.isPropertyDeclaration(member) ||
      ts.isGetAccessorDeclaration(member)
    ) {
      fields.push(key);
    } else {
      // Fail rather than skip. A member kind this test does not model is a
      // declared part of the surface going unchecked, which is the exact
      // failure the regex version had.
      expect(
        null,
        `unhandled member kind in the MidenClient declaration: ${ts.SyntaxKind[member.kind]} (${member.getText(source)})`
      ).not.toBeNull();
    }
  }

  return { statics, methods, fields };
}

const describeKey = (key) =>
  typeof key === "symbol" ? key.toString() : String(key);

describe("MidenClient declared surface", () => {
  const { statics, methods, fields } = midenClientDeclarations();

  it("parses a plausible surface out of api-types.d.ts", () => {
    // Guards the parser itself: a walk that silently stopped matching would
    // otherwise turn every assertion below into a vacuous pass.
    expect(statics).toContain("create");
    expect(methods).toContain("sync");
    expect(methods).toContain("feeAwareTransactionRequestBuilder");
    expect(fields).toContain("transactions");
    expect(methods).toContain(Symbol.dispose);
    expect(methods.length).toBeGreaterThan(5);
  });

  it.each(statics.map((k) => [describeKey(k), k]))(
    "implements the declared static %s",
    (_label, key) => {
      expect(typeof MidenClient[key]).toBe("function");
    }
  );

  it.each(methods.map((k) => [describeKey(k), k]))(
    "implements the declared method %s",
    (_label, key) => {
      expect(typeof MidenClient.prototype[key]).toBe("function");
    }
  );

  it.each(fields.map((k) => [describeKey(k), k]))(
    "provides the declared field %s",
    (_label, key) => {
      // The resource fields are assigned per-instance, so they are not on the
      // prototype and constructing a client here would need a real WASM module.
      // Either shape counts: a constructor assignment or a prototype accessor.
      const assignedInConstructor = new RegExp(
        `this\\.${String(key)}\\s*=`
      ).test(MidenClient.toString());
      const accessor = Object.getOwnPropertyDescriptor(
        MidenClient.prototype,
        key
      );
      expect(assignedInConstructor || typeof accessor?.get === "function").toBe(
        true
      );
    }
  );

  // The reverse direction. Public surface that nothing declares is invisible to
  // consumers and to typedoc, and it is how an API grows by accident.
  it("declares every public method the class implements", () => {
    // Fields count as declared: `defaultProver` is declared as a property but
    // implemented as a prototype getter, which `getOwnPropertyNames` reports
    // alongside the methods.
    const declared = new Set([...methods, ...fields]);
    const implemented = [
      ...Object.getOwnPropertyNames(MidenClient.prototype),
      ...Object.getOwnPropertySymbols(MidenClient.prototype),
    ].filter(
      (key) =>
        key !== "constructor" &&
        !(typeof key === "string" && isInternal(key)) &&
        !declared.has(key)
    );

    expect(
      implemented.map(describeKey),
      "these are public on MidenClient but declared nowhere in api-types.d.ts; " +
        "declare them (with JSDoc, which is the typedoc source) or mark them internal"
    ).toEqual([]);
  });

  it("declares every public static the class implements", () => {
    const declared = new Set(statics);
    const implemented = Object.getOwnPropertyNames(MidenClient).filter(
      (name) =>
        !["length", "name", "prototype"].includes(name) &&
        !isInternal(name) &&
        !declared.has(name)
    );

    expect(
      implemented,
      "these statics are public on MidenClient but declared nowhere in api-types.d.ts"
    ).toEqual([]);
  });
});
