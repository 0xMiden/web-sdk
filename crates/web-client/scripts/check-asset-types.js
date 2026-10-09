import ts from "typescript";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/asset-types.mts", import.meta.url)
);

// Check consumer code even when declaration-file checking is disabled.
{
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      })
    );
    process.exit(1);
  }
}
console.log("Asset type imports pass for all four entry points.");
