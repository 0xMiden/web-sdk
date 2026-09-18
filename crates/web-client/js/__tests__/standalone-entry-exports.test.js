import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const jsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function statements(file) {
  const filePath = path.join(jsDir, file);
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS
  ).statements;
}

function isExported(statement) {
  return statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  );
}

function standaloneHelpers() {
  return statements("standalone.js")
    .filter(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        isExported(statement) &&
        statement.name &&
        !statement.name.text.startsWith("_")
    )
    .map((statement) => statement.name.text);
}

function namedExports(file) {
  return statements(file)
    .filter(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
    )
    .flatMap((statement) =>
      statement.exportClause.elements.map((element) => element.name.text)
    );
}

describe("standalone helper entry points", () => {
  const helpers = standaloneHelpers();

  it("declares every public standalone helper", () => {
    const declarations = statements("types/api-types.d.ts")
      .filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) && isExported(statement)
      )
      .map((statement) => statement.name.text);

    expect(declarations).toEqual(expect.arrayContaining(helpers));
  });

  it.each(["index.js", "node-index.js"])(
    "exports every public standalone helper from %s",
    (entry) => {
      expect(namedExports(entry)).toEqual(expect.arrayContaining(helpers));
    }
  );
});
