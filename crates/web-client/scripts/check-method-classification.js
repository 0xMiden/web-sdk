#!/usr/bin/env node

/**
 * CI lint script that verifies every async method on the WASM WebClient class
 * is explicitly classified in one of: SYNC_METHODS, WRITE_METHODS,
 * READ_METHODS, or as an explicit wrapper method on the JS WebClient class.
 *
 * This prevents new write methods from silently defaulting to read-only
 * (WASM-lock-only) wrapping in the Proxy fallback.
 *
 * It also enforces the safety invariant SYNC_METHODS carries. Membership there
 * means "bound raw by the Proxy, bypassing `_serializeWasmCall`", so an entry
 * must take no borrow of the client's `AsyncCell`. The borrow is not
 * re-entrant — a `RefCell` on browser, where `panic = "abort"` turns a second
 * borrow into a trap, and a tokio `Mutex` on node, where it deadlocks — so a
 * borrowing method bound raw is a live crash, not a style problem.
 *
 * The crate borrows in three shapes, and the check below recognises all three:
 * the `get_mut_inner` accessor, a direct `self.inner.lock()` /
 * `self.inner.borrow()`, and a call to a helper that does one of those —
 * `get_keystore` being the one with real reach. Transitive borrows are resolved
 * to a fixed point, so a helper chain of any depth still counts. Recognising
 * only `get_mut_inner` would leave `storeIdentifier`, `createCodeBuilder`,
 * `accountReader` and every keystore-backed method invisible here, which is
 * exactly the set a reader would most expect this check to cover.
 *
 * This is a textual scan, not a call graph, and it is deliberately not claimed
 * to be complete. It follows `self.<helper>()` and nothing else, so a borrow
 * reached through a free function taking `&WebClient`, a trait method, or an
 * alias is invisible to it. Writing one of those and calling it from a
 * SYNC_METHODS entry would defeat the check — the guard is against the ordinary
 * mistake of adding or moving a method, not against a determined workaround.
 * Closing that would take real Rust parsing; if it ever seems worth it, the
 * cheaper move is forcing every borrow through the accessors and linting direct
 * `self.inner` access outside lib.rs.
 */

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
// Use dist/st/ as the canonical published layout — bindgen type
// declarations are identical between ST and MT variants.
const wasmTypesPath = path.join(
  rootDir,
  "dist",
  "st",
  "crates",
  "miden_client_web.d.ts"
);
const indexJsPath = path.join(rootDir, "js", "index.js");

// Verify required files exist
const requiredFiles = [wasmTypesPath, indexJsPath];
const missingFiles = [];

for (const filePath of requiredFiles) {
  try {
    await access(filePath);
  } catch {
    missingFiles.push(filePath);
  }
}

if (missingFiles.length > 0) {
  console.error(
    "Method classification check failed because expected files are missing. Run `make build-web-client` first."
  );
  for (const filePath of missingFiles) {
    console.error(`- ${filePath}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Extract all method names from the WASM WebClient class in the .d.ts file
// ---------------------------------------------------------------------------

function extractWasmMethods(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const methods = new Set();

  const visit = (node) => {
    // Find `export class WebClient`
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      node.name.text === "WebClient"
    ) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          ts.isIdentifier(member.name)
        ) {
          methods.add(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return methods;
}

// ---------------------------------------------------------------------------
// 2. Extract classified sets and explicit methods from index.js
// ---------------------------------------------------------------------------

// Reads the three sets through the TypeScript parser rather than by regex over
// the text. A regex counts a commented-out entry as present, so the check would
// validate a classification the runtime does not have — and since the long
// comment above SYNC_METHODS names methods in quotes, a text scan can also pick
// up names that are prose rather than membership. Comments are not AST nodes.
function extractClassifications(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  const wanted = new Set(["SYNC_METHODS", "WRITE_METHODS", "READ_METHODS"]);
  const sets = {};

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      wanted.has(node.name.text) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "Set" &&
      node.initializer.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(node.initializer.arguments[0])
    ) {
      const entries = new Set();
      for (const element of node.initializer.arguments[0].elements) {
        if (ts.isStringLiteral(element)) {
          entries.add(element.text);
          continue;
        }
        // Anything else — a spread, an identifier, a computed name — means the
        // real membership is not what this scan can see. Skipping it would let
        // `...["someMethod"]` put a borrow-holding method into SYNC_METHODS
        // with the check still reporting green, so refuse to run instead.
        console.error(
          `${node.name.text} in ${filePath} contains an entry that is not a ` +
            `plain string literal: ${element.getText(sourceFile)}\n\n` +
            "This check reads the three sets statically, so it cannot see the " +
            "real membership of a spread or a computed entry. Skipping it " +
            'would let `...["someMethod"]` place a borrow-holding method in ' +
            "SYNC_METHODS with this check still reporting green. List every " +
            "entry as a literal."
        );
        process.exit(1);
      }
      sets[node.name.text] = entries;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    syncMethods: sets.SYNC_METHODS || new Set(),
    writeMethods: sets.WRITE_METHODS || new Set(),
    readMethods: sets.READ_METHODS || new Set(),
  };
}

// ---------------------------------------------------------------------------
// 2b. Extract, from the Rust sources, which exported methods borrow the client
// ---------------------------------------------------------------------------

const rustSrcDir = path.join(rootDir, "src");

// A body that matches this borrows the client outright, with no helper in
// between: the shared accessor, or a direct lock/borrow of the cell itself.
// `self.inner` is only reachable from inside `impl WebClient`, so matching it
// textually cannot collide with an unrelated field of the same name.
const DIRECT_BORROW =
  /get_mut_inner|self\s*\.\s*inner\s*\.\s*(?:lock|borrow(?:_mut)?)\s*\(/;

// A borrow of one of WebClient's *other* `AsyncCell`s — `mock_rpc_api` and
// `mock_note_transport_api` — rather than of the client. The panic is the same
// shape if two callers overlap, but the resource is not, so these get their own
// allowlist rather than being folded into the client invariant: a method here
// cannot alias the client, and the mock methods that do this are called from
// inside `_serializeWasmCall` and would deadlock if serialized again.
const SIBLING_BORROW =
  /self\s*\.\s*(?!inner\b)[a-z_][a-z0-9_]*\s*\.\s*(?:lock|borrow(?:_mut)?)\s*\(/i;

// `self.foo(` / `self.foo()` — the shape a method uses to reach a helper on the
// same impl. Used to propagate borrowing through helpers like `get_keystore`.
const SELF_CALL = /self\s*\.\s*([a-z_][a-z0-9_]*)\s*\(/gi;

async function collectRustFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRustFiles(full)));
    } else if (entry.name.endsWith(".rs")) {
      files.push(full);
    }
  }
  return files;
}

// Returns the source span of the block that starts at the first `{` at or after
// `from`, or null when there is none. Skips over string, char and comment
// contents so a brace inside them cannot unbalance the count.
function extractBlock(source, from) {
  const open = source.indexOf("{", from);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      // Rust raw strings (r"…", r#"…"#) would need their own handling; the
      // crate has none inside exported method bodies, and a missed raw string
      // could only make the scan bail out, never pass a borrowing method.
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "'") {
      // Lifetimes (`'a`) are far more common here than char literals, and a
      // lifetime has no closing quote — only treat this as a literal when it
      // looks like one.
      const isCharLiteral = /^'(\\.|[^\\'])'/.test(source.slice(i));
      if (isCharLiteral) {
        i += source[i + 1] === "\\" ? 3 : 2;
      }
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

// Names every helper the body calls as `self.<name>(`.
function selfCallees(body) {
  const callees = new Set();
  SELF_CALL.lastIndex = 0;
  let match;
  while ((match = SELF_CALL.exec(body)) !== null) callees.add(match[1]);
  return callees;
}

// Whether the `fn` starting at `start` has a body, rather than being a bodyless
// trait declaration (`fn foo(&self);`). Without this, `extractBlock` would hand
// back whichever unrelated block came next and attribute its borrows to this
// name. Nothing in the crate declares one today, so this is insurance against a
// future one turning into a confusing CI failure.
//
// Depth-tracked rather than a plain `indexOf(";")` because a parameter can
// legitimately contain one: `fn read(buf: [u8; 32])` has a semicolon inside
// brackets, and skipping that function would silently stop checking it — the
// under-reporting this whole check exists to prevent.
function hasBody(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0) {
      if (char === "{") return true;
      if (char === ";") return false;
    }
  }
  return false;
}

// Every `fn name(…) { … }` in the crate, mapped to its bodies. A name can be
// defined on more than one impl, so the value is a list and any borrowing
// definition makes the name count as borrowing — the same over-report-rather-
// than-under-report rule applied below.
function collectFnBodies(sources) {
  const bodies = new Map();
  for (const source of sources) {
    const fnPattern = /\bfn\s+([a-z_][a-z0-9_]*)\s*[(<]/gi;
    let match;
    while ((match = fnPattern.exec(source)) !== null) {
      const from = match.index + match[0].length;
      if (!hasBody(source, match.index)) continue;

      const body = extractBlock(source, from);
      if (body === null) continue;
      if (!bodies.has(match[1])) bodies.set(match[1], []);
      bodies.get(match[1]).push(body);
    }
  }
  return bodies;
}

// The set of function names matching `directRegex`, directly or through any
// depth of `self.<helper>()` calls. Iterated to a fixed point so a helper chain
// is followed all the way down rather than one level, which is what makes
// `get_keystore` — and anything later written in terms of it — count.
function resolveBorrowingFns(fnBodies, directRegex) {
  const borrowing = new Set();
  for (const [name, bodies] of fnBodies) {
    if (bodies.some((body) => directRegex.test(body))) borrowing.add(name);
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, bodies] of fnBodies) {
      if (borrowing.has(name)) continue;
      const reachesBorrower = bodies.some((body) =>
        [...selfCallees(body)].some((callee) => borrowing.has(callee))
      );
      if (reachesBorrower) {
        borrowing.add(name);
        changed = true;
      }
    }
  }

  return borrowing;
}

function bodyBorrows(body, borrowingFns, directRegex) {
  if (directRegex.test(body)) return true;
  return [...selfCallees(body)].some((callee) => borrowingFns.has(callee));
}

// Maps every `#[js_export(js_name = "X")]` method to whether its body borrows
// the client, and separately whether it borrows one of the sibling cells.
// Methods exported without an explicit `js_name` keep their snake_case Rust
// name in JS and so can never match a classification entry, which is camelCase
// throughout; they are skipped.
async function extractBorrowingExports() {
  const files = await collectRustFiles(rustSrcDir);
  const sources = await Promise.all(
    files.map((file) => readFile(file, "utf8"))
  );
  const fnBodies = collectFnBodies(sources);
  const borrowingFns = resolveBorrowingFns(fnBodies, DIRECT_BORROW);
  const siblingBorrowingFns = resolveBorrowingFns(fnBodies, SIBLING_BORROW);
  const borrows = new Map();

  for (const [index, file] of files.entries()) {
    const source = sources[index];
    const attrPattern = /#\[js_export\([^)]*js_name\s*=\s*"([^"]+)"[^)]*\)\]/g;
    let match;
    while ((match = attrPattern.exec(source)) !== null) {
      const jsName = match[1];
      const body = extractBlock(source, match.index + match[0].length);
      if (body === null) continue;
      // A `js_name` is unique per class, not per crate, so the same name can
      // occur on a model class and on WebClient. Take the union rather than
      // the last one seen: over-reporting is a comment away from resolved,
      // while under-reporting is the panic this check exists to prevent.
      const seen = borrows.get(jsName);
      const thisBorrows = bodyBorrows(body, borrowingFns, DIRECT_BORROW);
      const thisBorrowsSibling = bodyBorrows(
        body,
        siblingBorrowingFns,
        SIBLING_BORROW
      );
      if (seen?.borrows && !thisBorrows) continue;
      borrows.set(jsName, {
        borrows: thisBorrows,
        borrowsSibling: thisBorrowsSibling,
        file: path.relative(rootDir, file),
      });
    }
  }

  return borrows;
}

function extractExplicitMethods(sourceText, filePath) {
  // Use the TypeScript parser to reliably extract method names from
  // class declarations (WebClient, MockWebClient), avoiding false
  // positives from control-flow statements or Proxy traps.
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  const methods = new Set();

  const visit = (node) => {
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      (node.name.text === "WebClient" || node.name.text === "MockWebClient")
    ) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          ts.isIdentifier(member.name)
        ) {
          methods.add(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return methods;
}

// ---------------------------------------------------------------------------
// 3. Run the check
// ---------------------------------------------------------------------------

const wasmTypesSource = await readFile(wasmTypesPath, "utf8");
const indexJsSource = await readFile(indexJsPath, "utf8");

const wasmMethods = extractWasmMethods(wasmTypesSource, wasmTypesPath);
const { syncMethods, writeMethods, readMethods } = extractClassifications(
  indexJsSource,
  indexJsPath
);
const explicitMethods = extractExplicitMethods(indexJsSource, indexJsPath);

const classified = new Set([
  ...syncMethods,
  ...writeMethods,
  ...readMethods,
  ...explicitMethods,
]);

// Constructor, lifecycle, and internal methods that don't need classification
const allowedUnclassified = new Set([
  // wasm_bindgen infrastructure
  "new",
  "free",
  "serialize",
  "deserialize",
  // Factory / init methods handled by static wrappers
  "createClient",
  "createClientWithExternalKeystore",
  "createMockClient",
  // Internal impl methods called directly by sync wrappers
  "syncStateImpl",
  "syncChainImpl",
  "syncNoteTransportImpl",
]);

const unclassified = [...wasmMethods].filter(
  (name) => !classified.has(name) && !allowedUnclassified.has(name)
);

if (unclassified.length > 0) {
  console.error(
    "The following WASM methods are not classified in SYNC_METHODS, WRITE_METHODS, READ_METHODS, or as explicit wrapper methods in index.js:"
  );
  unclassified.sort().forEach((name) => console.error(`  - ${name}`));
  console.error(
    "\nAdd each method to the appropriate set in js/index.js, or add an explicit wrapper method on the WebClient class."
  );
  process.exit(1);
}

// A name in two sets is ambiguous rather than merely redundant: only
// SYNC_METHODS is read at runtime (by `createClientProxy`), so a method listed
// in SYNC_METHODS *and* WRITE_METHODS is bound raw while the classification
// claims it is serialized. Checking only "is it classified at all" cannot see
// that, which is how a stale duplicate survives.
const membership = new Map();
for (const [setName, names] of [
  ["SYNC_METHODS", syncMethods],
  ["WRITE_METHODS", writeMethods],
  ["READ_METHODS", readMethods],
]) {
  for (const name of names) {
    if (!membership.has(name)) membership.set(name, []);
    membership.get(name).push(setName);
  }
}

const duplicates = [...membership.entries()].filter(
  ([, sets]) => sets.length > 1
);

if (duplicates.length > 0) {
  console.error(
    "The following methods appear in more than one classification set in js/index.js:"
  );
  duplicates
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, sets]) =>
      console.error(`  - ${name}: ${sets.join(", ")}`)
    );
  console.error(
    "\nEach method belongs to exactly one set. Only SYNC_METHODS is consulted at runtime, so a duplicate there silently keeps the raw binding."
  );
  process.exit(1);
}

// A SYNC_METHODS entry is bound raw by `createClientProxy`, skipping
// `_serializeWasmCall`, so it must take no borrow of the client's `AsyncCell`.
// The completeness and duplicate checks above cannot see a violation: moving a
// borrowing method from WRITE_METHODS into SYNC_METHODS leaves every method
// classified, exactly once. Decide it from the Rust source instead.
const borrowingExports = await extractBorrowingExports();

// `lastAuthError` is the one accepted exception, for the reason given above
// SYNC_METHODS in js/index.js: it is synchronous by contract, so it cannot be
// serialized without a breaking change. Widening this list means accepting a
// reachable panic — say why in the same place.
const allowedRawBorrowers = new Set(["lastAuthError"]);

// The mock helpers borrow `mock_rpc_api` / `mock_note_transport_api`, never the
// client, so they cannot cause the aliasing panic the list above guards. They
// must stay raw-bound for a second reason: `syncState` calls
// `serializeMockChain` and `serializeMockNoteTransportNode` from *inside*
// `_serializeWasmCall` (js/index.js), so classifying them as WRITE/READ would
// re-enter the same chain and deadlock the mock sync path. Their own overlap is
// prevented by that outer serialization, not by anything here. Add to this list
// only with the same two facts established.
const allowedSiblingBorrowers = new Set([
  "proveBlock",
  "serializeMockChain",
  "serializeMockNoteTransportNode",
  "usesMockChain",
]);

const checkableSyncMethods = [...syncMethods].filter(
  (name) => !allowedRawBorrowers.has(name)
);

// An entry the Rust scan cannot find is not a pass — the check would simply be
// inert for it, which is the failure mode that lets the invariant rot again.
const unresolvedSyncMethods = checkableSyncMethods.filter(
  (name) => !borrowingExports.has(name)
);

if (unresolvedSyncMethods.length > 0) {
  console.error(
    "The following SYNC_METHODS entries could not be found in the Rust sources, so whether they borrow the client is unknown:"
  );
  unresolvedSyncMethods.sort().forEach((name) => console.error(`  - ${name}`));
  console.error(
    `\nEach entry should correspond to a #[js_export(js_name = "...")] method under crates/web-client/src/. If one was renamed or removed, update SYNC_METHODS; if it is exported some other way, add it to \`allowedRawBorrowers\` with the reason it cannot borrow.`
  );
  process.exit(1);
}

const rawBorrowers = checkableSyncMethods
  .map((name) => [name, borrowingExports.get(name)])
  .filter(([, info]) => info.borrows);

if (rawBorrowers.length > 0) {
  console.error(
    "The following SYNC_METHODS entries borrow the client — via `get_mut_inner`, a direct `self.inner.lock()`/`borrow()`, or a helper that does one of those — but SYNC_METHODS is bound raw by the Proxy and skips serialization:"
  );
  rawBorrowers
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, info]) => console.error(`  - ${name} (${info.file})`));
  console.error(
    "\nA raw-bound method that borrows can be polled while another call holds the borrow, which aborts with `already borrowed: BorrowMutError` on browser and deadlocks on node. Move each into WRITE_METHODS or READ_METHODS — both are serialized, and the choice between them is the store-mutation annotation described above SYNC_METHODS in js/index.js."
  );
  process.exit(1);
}

const rawSiblingBorrowers = checkableSyncMethods
  .map((name) => [name, borrowingExports.get(name)])
  .filter(
    ([name, info]) => info.borrowsSibling && !allowedSiblingBorrowers.has(name)
  );

if (rawSiblingBorrowers.length > 0) {
  console.error(
    "The following SYNC_METHODS entries hold a borrow of one of WebClient's sibling `AsyncCell`s across an await, and SYNC_METHODS is bound raw by the Proxy:"
  );
  rawSiblingBorrowers
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, info]) => console.error(`  - ${name} (${info.file})`));
  console.error(
    "\nTwo overlapping calls abort with `already borrowed: BorrowMutError` on browser. Serialize the method by moving it into WRITE_METHODS or READ_METHODS, or — if it is called from inside `_serializeWasmCall` and so would deadlock if serialized again — add it to `allowedSiblingBorrowers` with that established."
  );
  process.exit(1);
}

console.log(
  `Method classification check passed: all WASM WebClient methods are classified, each in exactly one set, and no raw-bound method borrows the client (${borrowingExports.size} exported methods scanned).`
);
