#!/usr/bin/env node
// Resolve the published entry points the way a downstream consumer does.
//
// Packs the SDK and React packages, unpacks the tarballs into a throwaway
// node_modules, then checks every symbol this monorepo's packages import from
// them against (a) the declaration file the consumer's TypeScript resolves and
// (b) the export names of the built JavaScript entry. An export missing from an
// entry otherwise surfaces only as a module-evaluation error in a consumer.
//
// Run after `pnpm run build:web-client && pnpm run build:react-sdk`.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Packages whose tarballs are exercised, by directory.
const PACKAGES = ["crates/web-client", "packages/react-sdk"];

// Symbols that downstream code must always find, whether or not a source file
// here happens to import them today.
const PINNED = {
  "@miden-sdk/miden-sdk": ["WasmWebClient", "BasicFungibleFaucetComponent"],
  "@miden-sdk/react": ["useMultiSigner"],
};

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "test",
  "tests",
  "__tests__",
  "examples",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.|\.d\.ts$/.test(entry.name)
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// spec -> { types: Set (every imported name), values: Set (runtime names) }
export function collectImports(files, packageNames) {
  const wanted = new Map();
  const slot = (spec) => {
    if (!wanted.has(spec)) {
      wanted.set(spec, { types: new Set(), values: new Set() });
    }
    return wanted.get(spec);
  };
  const isOurs = (spec) =>
    packageNames.some((n) => spec === n || spec.startsWith(`${n}/`));
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    for (const stmt of sf.statements) {
      if (
        !(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) ||
        !stmt.moduleSpecifier ||
        !ts.isStringLiteral(stmt.moduleSpecifier) ||
        !isOurs(stmt.moduleSpecifier.text)
      ) {
        continue;
      }
      const clause = ts.isImportDeclaration(stmt)
        ? stmt.importClause
        : stmt.exportClause;
      const bindings = ts.isImportDeclaration(stmt)
        ? clause?.namedBindings
        : clause;
      if (!bindings || !ts.isNamedImportsOrExports(bindings)) continue;
      const declTypeOnly = ts.isImportDeclaration(stmt)
        ? clause.isTypeOnly
        : stmt.isTypeOnly;
      const entry = slot(stmt.moduleSpecifier.text);
      for (const el of bindings.elements) {
        const name = (el.propertyName ?? el.name).text;
        entry.types.add(name);
        if (!declTypeOnly && !el.isTypeOnly) entry.values.add(name);
      }
    }
    // `const { A, B: b } = await import(spec)` needs A and B at runtime too.
    ts.forEachChild(sf, function visit(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]) &&
        isOurs(node.arguments[0].text) &&
        ts.isAwaitExpression(node.parent)
      ) {
        let decl = node.parent.parent;
        while (ts.isParenthesizedExpression(decl)) decl = decl.parent;
        if (
          ts.isVariableDeclaration(decl) &&
          ts.isObjectBindingPattern(decl.name)
        ) {
          const entry = slot(node.arguments[0].text);
          for (const el of decl.name.elements) {
            const key = el.propertyName ?? el.name;
            if (el.dotDotDotToken || !ts.isIdentifier(key)) continue;
            entry.types.add(key.text);
            entry.values.add(key.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return wanted;
}

// Export names of a built ES module, following relative `export *` chains.
// A name that is only a type has no runtime export, so callers pass value names.
export function exportNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const names = new Set();
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier?.text;
      if (!stmt.exportClause) {
        if (spec?.startsWith(".")) {
          for (const n of exportNames(resolve(dirname(file), spec), seen)) {
            if (n !== "default") names.add(n);
          }
        }
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) names.add(el.name.text);
      } else {
        names.add(stmt.exportClause.name.text);
      }
    } else if (ts.isExportAssignment(stmt)) {
      names.add("default");
    } else if (
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const isDefault = ts
        .getModifiers(stmt)
        .some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault) names.add("default");
      else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.add(d.name.text);
        }
      } else if (stmt.name) names.add(stmt.name.text);
    }
  }
  return names;
}

// Flatten an exports-map entry to the file a given condition set resolves to.
function resolveTarget(target, conditions) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolveTarget(t, conditions);
      if (r) return r;
    }
    return undefined;
  }
  for (const [cond, next] of Object.entries(target ?? {})) {
    if (cond === "default" || conditions.includes(cond)) {
      const r = resolveTarget(next, conditions);
      if (r) return r;
    }
  }
  return undefined;
}

// Distinct files an exports-map entry serves each consumer condition set.
export function runtimeTargets(entry) {
  const sets = [["import"], ["node", "import"]];
  return [...new Set(sets.map((c) => resolveTarget(entry, c)).filter(Boolean))];
}

function main() {
  const work = mkdtempSync(join(tmpdir(), "consumer-imports-"));
  const failures = [];
  try {
    const nm = join(work, "node_modules");
    const pkgs = [];
    for (const dir of PACKAGES) {
      const abs = join(ROOT, dir);
      const manifest = JSON.parse(
        readFileSync(join(abs, "package.json"), "utf8")
      );
      const packDir = join(work, "tarballs");
      mkdirSync(packDir, { recursive: true });
      const out = execFileSync(
        "pnpm",
        ["pack", "--pack-destination", packDir, "--json"],
        { cwd: abs, encoding: "utf8" }
      );
      const tarball = resolve(abs, JSON.parse(out).filename);
      const dest = join(nm, manifest.name);
      mkdirSync(dest, { recursive: true });
      execFileSync("tar", [
        "-xzf",
        tarball,
        "-C",
        dest,
        "--strip-components=1",
      ]);
      pkgs.push({ name: manifest.name, dest, exports: manifest.exports });
    }

    const files = readdirSync(join(ROOT, "packages")).flatMap((d) =>
      walk(join(ROOT, "packages", d))
    );
    const wanted = collectImports(
      files,
      pkgs.map((p) => p.name)
    );
    for (const p of pkgs) {
      const pinned = wanted.get(p.name) ?? {
        types: new Set(),
        values: new Set(),
      };
      for (const n of PINNED[p.name] ?? []) {
        pinned.types.add(n);
        pinned.values.add(n);
      }
      wanted.set(p.name, pinned);
    }

    // Every entry point of a package must provide what the bare specifier is
    // imported for: the lazy, multithreaded and eager builds share one surface.
    const checks = [];
    for (const p of pkgs) {
      const bare = wanted.get(p.name);
      for (const sub of Object.keys(p.exports)) {
        if (sub === "./package.json") continue;
        const spec = sub === "." ? p.name : `${p.name}/${sub.slice(2)}`;
        const own = wanted.get(spec);
        const types = new Set([...bare.types, ...(own?.types ?? [])]);
        const values = new Set([...bare.values, ...(own?.values ?? [])]);
        checks.push({ p, spec, sub, types, values });
      }
    }

    // Types: a consumer file importing each name, resolved from node_modules.
    const lines = [];
    for (const c of checks) {
      lines.push(`import type {} from ${JSON.stringify(c.spec)};`);
      for (const n of [...c.types].sort()) {
        lines.push(
          `import type { ${n} as ${c.spec.replace(/\W/g, "_")}__${n} } from ${JSON.stringify(c.spec)};`
        );
      }
    }
    const consumer = join(work, "consumer.ts");
    writeFileSync(consumer, lines.join("\n") + "\nexport {};\n");
    const program = ts.createProgram([consumer], {
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      types: [],
    });
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (d.file?.fileName !== consumer) continue;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      failures.push(
        `types: ${lines[line]} -> ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`
      );
    }

    // Runtime: names exported by the JS an import or Node consumer loads. The
    // export lists are parsed, so the `node` target never loads its native addon.
    for (const c of checks) {
      const entry = c.p.exports[c.sub];
      if (!resolveTarget(entry, ["import"])) {
        failures.push(`runtime: ${c.spec} has no import target`);
      }
      for (const target of runtimeTargets(entry)) {
        const file = join(c.p.dest, target);
        if (!existsSync(file)) {
          failures.push(
            `runtime: ${c.spec} -> ${target} is not in the tarball`
          );
          continue;
        }
        const have = exportNames(file);
        for (const n of [...c.values].sort()) {
          if (!have.has(n)) {
            failures.push(
              `runtime: ${c.spec} (${target}) does not export ${n}`
            );
          }
        }
      }
    }

    console.log(
      `checked ${checks.length} entry points: ${checks
        .map(
          (c) => `${c.spec} (${c.values.size} values, ${c.types.size} names)`
        )
        .join("; ")}`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
