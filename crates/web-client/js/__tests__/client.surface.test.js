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
    expect(methods).toContain("withFeeAwareAuth");
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

// A public method is documented on every consumer surface the repository
// requires, and typedoc renders a WASM return type only when the curated entry
// exports it. Each listed file is one that tells a reader how to get the fee
// asset, so it names `protocolConfig()` beside `feeFaucetId()`.
const REPO_ROOT = new URL("../../../../", import.meta.url);
const PROTOCOL_CONFIG_DOCS = [
  "README.md",
  "crates/web-client/README.md",
  "crates/web-client/AGENTS.md",
  "crates/web-client/skills/web-client-usage/SKILL.md",
  "crates/web-client/skills/chain-anchored-execution/SKILL.md",
  "crates/web-client/skills/signer-integration/SKILL.md",
  "crates/web-client/skills/frontend-pitfalls/SKILL.md",
  "crates/web-client/src/models/account_component.rs",
  "docs/external/src/web-client/library/network-notes.md",
  "docs/external/src/web-client/library/transactions.md",
];

describe("protocolConfig documentation", () => {
  it("docs-entry exports ProtocolConfig", () => {
    const entry = readFileSync(
      new URL("../types/docs-entry.d.ts", import.meta.url),
      "utf8"
    );
    expect(entry).toMatch(/^\s*ProtocolConfig,/m);
  });

  it.each(PROTOCOL_CONFIG_DOCS)(
    "protocolConfig is documented on every required surface: %s",
    (file) => {
      expect(readFileSync(new URL(file, REPO_ROOT), "utf8")).toContain(
        "protocolConfig("
      );
    }
  );
});

// The web submit paths submit exactly the request they are given, so the
// registration contract of the new request builders is stated where a caller
// reads it: on the Rust doc comments that become the JSDoc and on every page.
const REQUEST_BUILDER_DOCS = [
  "crates/web-client/README.md",
  "crates/web-client/skills/web-client-usage/SKILL.md",
  "docs/external/src/web-client/library/transactions.md",
];
const rustDoc = (file, jsName) => {
  const lines = readFileSync(new URL(file, REPO_ROOT), "utf8").split("\n");
  const at = lines.findIndex((line) =>
    line.includes(`js_name = "${jsName}")]`)
  );
  expect(at, `${jsName} is exported in ${file}`).toBeGreaterThan(0);
  const doc = [];
  for (let i = at - 1; i >= 0 && lines[i].trim().startsWith("///"); i--) {
    doc.unshift(lines[i]);
  }
  return doc.join("\n");
};
const BUILDER = "crates/web-client/src/models/transaction_request/";

describe("request builder documentation", () => {
  it.each(REQUEST_BUILDER_DOCS)(
    "%s names the registration request and the 20-note limit",
    (file) => {
      const text = readFileSync(new URL(file, REPO_ROOT), "utf8");
      expect(text).toContain("newRegisterNoteScriptsTransactionRequest");
      expect(text).toContain("withExpectedNtxScripts");
      expect(text).toContain("invalid input note count");
    }
  );

  it.each(REQUEST_BUILDER_DOCS)(
    "%s documents extendMerkleStore and reading the nodes back",
    (file) => {
      const text = readFileSync(new URL(file, REPO_ROOT), "utf8");
      expect(text).toContain("extendMerkleStore");
      expect(text).toContain("InnerNodeInfoArray");
      expect(text).toContain("merkleStoreInnerNodes");
    }
  );

  it("extendMerkleStore documents that the store does not check node values", () => {
    const setterDoc = rustDoc(
      `${BUILDER}transaction_request_builder.rs`,
      "extendMerkleStore"
    );
    expect(setterDoc).toContain("InnerNodeInfo");
    expect(setterDoc).toContain("not checked");
  });

  it("withExpectedNtxScripts does not promise automatic registration", () => {
    const setterDoc = rustDoc(
      `${BUILDER}transaction_request_builder.rs`,
      "withExpectedNtxScripts"
    );
    expect(setterDoc).toContain("newRegisterNoteScriptsTransactionRequest");
    expect(setterDoc).not.toContain("registers any script");
  });

  it("ignoreInvalidInputNotes documents the 20-note checker limit", () => {
    const setterDoc = rustDoc(
      `${BUILDER}transaction_request_builder.rs`,
      "ignoreInvalidInputNotes"
    );
    expect(setterDoc).toContain("20");
    expect(setterDoc).toContain("invalid input note count");
  });

  it("expectedNtxScripts documents that standard scripts are returned", () => {
    expect(rustDoc(`${BUILDER}mod.rs`, "expectedNtxScripts")).toContain(
      "standard"
    );
  });

  it("every submit surface points at the registration request", () => {
    const types = readFileSync(
      new URL("crates/web-client/js/types/api-types.d.ts", REPO_ROOT),
      "utf8"
    );
    const block = (needle) => {
      const at = types.indexOf(needle);
      expect(at, needle).toBeGreaterThan(0);
      return types.slice(types.lastIndexOf("/**", at), at);
    };
    for (const needle of [
      "  submit(\n",
      "  executeRequest(\n",
      "  submit(): Promise<TransactionSubmission>;",
    ]) {
      expect(block(needle)).toContain(
        "newRegisterNoteScriptsTransactionRequest"
      );
    }
  });
});
