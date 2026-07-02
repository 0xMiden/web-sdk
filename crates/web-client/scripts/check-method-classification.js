#!/usr/bin/env node

/**
 * CI lint script that keeps the WASM WebClient surface and the JS proxy
 * classification sets in sync, in BOTH directions:
 *
 *  1. Forward: every async method on the WASM WebClient class is explicitly
 *     classified in one of SYNC_METHODS, WRITE_METHODS, READ_METHODS, or as an
 *     explicit wrapper method on the JS WebClient class. This prevents new
 *     write methods from silently defaulting to read-only (WASM-lock-only)
 *     wrapping in the Proxy fallback.
 *
 *  2. Reverse: every name listed in a classification set corresponds to a real
 *     WASM export (a WebClient class method or a module-level free function).
 *     This catches dead entries left behind after a method is removed or
 *     renamed (e.g. a `js_name` change), which would otherwise sit unnoticed.
 *
 * The pure helpers are exported so they can be unit-tested; the file only runs
 * the check against the built artifacts when invoked directly as a script.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Constructor, lifecycle, and internal methods that don't need classification.
export const allowedUnclassified = new Set([
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

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/** All method names declared on the WASM `WebClient` class (instance + static). */
export function extractWasmMethods(sourceText, filePath = "wasm.d.ts") {
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

/**
 * Module-level exported function names in the `.d.ts`. Covers both
 * `export function foo(...)` / `export declare function foo(...)` and the
 * `declare function foo2(...); export { foo2 as foo }` alias form that
 * wasm-bindgen emits for renamed free functions (e.g. `exportStore`).
 */
export function extractWasmFunctions(sourceText, filePath = "wasm.d.ts") {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const functions = new Set();

  const hasExportModifier = (node) => {
    const modifiers =
      (ts.getModifiers && ts.getModifiers(node)) || node.modifiers || [];
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      hasExportModifier(node)
    ) {
      functions.add(node.name.text);
    }
    // `export { local as public }`: record the exported (public) name.
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        if (element.name && ts.isIdentifier(element.name)) {
          functions.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return functions;
}

/** Parse the SYNC/WRITE/READ classification sets out of index.js. */
export function extractClassifications(sourceText) {
  // Match Set declarations: const SOME_METHODS = new Set([ ... ]);
  const setPattern =
    /const\s+(SYNC_METHODS|WRITE_METHODS|READ_METHODS)\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
  const sets = {};

  let match;
  while ((match = setPattern.exec(sourceText)) !== null) {
    const setName = match[1];
    const body = match[2];
    // Extract quoted strings from the set body
    const entries = new Set();
    const stringPattern = /["']([^"']+)["']/g;
    let strMatch;
    while ((strMatch = stringPattern.exec(body)) !== null) {
      entries.add(strMatch[1]);
    }
    sets[setName] = entries;
  }

  return {
    syncMethods: sets.SYNC_METHODS || new Set(),
    writeMethods: sets.WRITE_METHODS || new Set(),
    readMethods: sets.READ_METHODS || new Set(),
  };
}

/**
 * Method names declared on the JS `WebClient` / `MockWebClient` classes in
 * index.js. Uses the TS parser to avoid false positives from control-flow
 * statements or Proxy traps.
 */
export function extractExplicitMethods(sourceText, filePath = "index.js") {
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
// Checks (pure)
// ---------------------------------------------------------------------------

/** WASM methods that are neither classified nor allow-listed. */
export function computeUnclassified(wasmMethods, classified, allowed) {
  return [...wasmMethods].filter(
    (name) => !classified.has(name) && !allowed.has(name)
  );
}

/**
 * Classification-set entries that match no WASM export (class method or
 * module-level free function). These are dead/misfiled entries.
 */
export function computeUnknownClassified(classificationSets, validExports) {
  const classifiedNames = new Set([
    ...classificationSets.syncMethods,
    ...classificationSets.writeMethods,
    ...classificationSets.readMethods,
  ]);
  return [...classifiedNames].filter((name) => !validExports.has(name));
}

// ---------------------------------------------------------------------------
// Script entry point
// ---------------------------------------------------------------------------

async function main() {
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
      "Method classification check failed because expected files are missing. Run `pnpm run build` first."
    );
    for (const filePath of missingFiles) {
      console.error(`- ${filePath}`);
    }
    process.exit(1);
  }

  const wasmTypesSource = await readFile(wasmTypesPath, "utf8");
  const indexJsSource = await readFile(indexJsPath, "utf8");

  const wasmMethods = extractWasmMethods(wasmTypesSource, wasmTypesPath);
  const wasmFunctions = extractWasmFunctions(wasmTypesSource, wasmTypesPath);
  const classificationSets = extractClassifications(indexJsSource);
  const { syncMethods, writeMethods, readMethods } = classificationSets;
  const explicitMethods = extractExplicitMethods(indexJsSource, indexJsPath);

  const classified = new Set([
    ...syncMethods,
    ...writeMethods,
    ...readMethods,
    ...explicitMethods,
  ]);

  let failed = false;

  // Forward: every WASM method must be classified.
  const unclassified = computeUnclassified(
    wasmMethods,
    classified,
    allowedUnclassified
  );

  if (unclassified.length > 0) {
    failed = true;
    console.error(
      "The following WASM methods are not classified in SYNC_METHODS, WRITE_METHODS, READ_METHODS, or as explicit wrapper methods in index.js:"
    );
    unclassified.sort().forEach((name) => console.error(`  - ${name}`));
    console.error(
      "\nAdd each method to the appropriate set in js/index.js, or add an explicit wrapper method on the WebClient class."
    );
  }

  // Reverse: every classified name must be a real WASM export.
  const validExports = new Set([...wasmMethods, ...wasmFunctions]);
  const unknownClassified = computeUnknownClassified(
    classificationSets,
    validExports
  );

  if (unknownClassified.length > 0) {
    failed = true;
    console.error(
      "The following names in SYNC_METHODS / WRITE_METHODS / READ_METHODS match no WASM export (WebClient method or module-level function):"
    );
    unknownClassified.sort().forEach((name) => console.error(`  - ${name}`));
    console.error(
      "\nRemove each dead entry from its set in js/index.js (the WASM export was renamed or no longer exists)."
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    "Method classification check passed: WASM WebClient methods are classified and every classified name maps to a real WASM export."
  );
}

// Only run the check when executed directly (not when imported by tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
