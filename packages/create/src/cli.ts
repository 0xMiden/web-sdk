#!/usr/bin/env node
import { init } from "./init";
import { sync } from "./sync";

const USAGE = `miden-skills - point your AI coding agent at version-matched Miden guidance

Usage:
  npm create @miden-sdk@latest     Set up this project (writes AGENTS.md, syncs skills)
  miden-skills sync                Re-sync skills from node_modules (used by "prepare")
  miden-skills --help              Show this message
`;

function runSync(projectRoot: string, quiet: boolean): void {
  const result = sync(projectRoot);

  if (result.empty) {
    // A --prod install, or running before the SDK is installed. Not an error:
    // this runs from "prepare", and failing there would break the install.
    if (!quiet)
      console.log(
        "miden-skills: no @miden-sdk packages with skills found, nothing to sync"
      );
    return;
  }

  if (!quiet) {
    const versions = [
      ...new Set(
        result.written.map((skill) => `${skill.package}@${skill.version}`)
      ),
    ];
    console.log(
      `miden-skills: synced ${result.written.length} skill(s) from ${versions.join(", ")}`
    );
  }
}

export function main(
  argv: string[],
  projectRoot: string = process.cwd()
): number {
  const command = argv[0];

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return 0;
  }

  if (command === "sync") {
    // Quiet under "prepare" on CI, where this output is pure noise.
    runSync(projectRoot, process.env.CI === "true");
    return 0;
  }

  if (command !== undefined) {
    console.error(`miden-skills: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const result = init(projectRoot);
  runSync(projectRoot, false);

  for (const file of result.files) {
    if (file.created) console.log(`miden-skills: created ${file.path}`);
    else if (file.updated) console.log(`miden-skills: updated ${file.path}`);
  }
  if (result.prepareAdded) {
    console.log(
      'miden-skills: added a "prepare" script so skills re-sync on every install'
    );
  }
  if (result.gitignoreUpdated) {
    console.log(
      "miden-skills: gitignored the synced skills - they are regenerated, not committed"
    );
  }

  console.log(
    "\nCommit AGENTS.md, CLAUDE.md and package.json so your teammates get this too."
  );
  return 0;
}

/* c8 ignore start -- entry point, exercised by running the binary */
if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
/* c8 ignore stop */
