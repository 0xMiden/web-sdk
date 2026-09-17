import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { discoverSkills, SKILLS_DIR } from "./sync";

export const MARKER_BEGIN = "<!-- BEGIN:miden-agent-rules -->";
export const MARKER_END = "<!-- END:miden-agent-rules -->";

/**
 * The `prepare` script keeps `.claude/skills/` current on every install,
 * including a fresh clone by someone who never ran this tool.
 *
 * It tolerates its own absence on purpose: `pnpm prune --prod` runs `prepare`
 * *after* removing devDependencies, which is a well-known way to break Docker
 * builds, and a missing skill sync should never fail an install.
 */
export const PREPARE_COMMAND = "miden-skills sync || true";

/**
 * Parenthesized so that chaining cannot swallow the exit code of whatever came
 * before it - `a && b || true` is `(a && b) || true`, which would turn a real
 * failure in the existing script into a silent success.
 */
const PREPARE_COMMAND_CHAINED = "(miden-skills sync || true)";

/**
 * The block written into the consumer's own agent instructions. This is the
 * only thing that makes any of the shipped documentation discoverable: agents
 * load instruction files from the project root, never from `node_modules`.
 */
export function renderBlock(packages: string[]): string {
  const pointers = packages.length > 0 ? packages : ["@miden-sdk/miden-sdk"];
  const lines = pointers.map((name) => `- \`node_modules/${name}/AGENTS.md\``);

  return [
    MARKER_BEGIN,
    "## Miden",
    "",
    "This project uses the Miden web SDK. Your training data is likely out of date:",
    "Miden is pre-1.0 and its API changes between minor versions.",
    "",
    "Before writing or reviewing Miden code, read the version-matched guide that",
    "ships inside the package you are touching:",
    "",
    ...lines,
    "",
    `Task-specific skills are synced into \`${SKILLS_DIR.split(/[\\/]/).join("/")}/\` on install, and also`,
    "ship in each package's `skills/` directory. Read the relevant skill before",
    "implementing, not after.",
    "",
    "These files ship in the published tarball, so they describe the exact version",
    "you have installed. The version is in the same directory's `package.json`; if a",
    "guide disagrees with what you expected, the guide is right and your assumption",
    "is stale.",
    MARKER_END,
    "",
  ].join("\n");
}

/**
 * Inserts or refreshes the block, leaving everything around it untouched. An
 * existing block is replaced in place so the file keeps its structure.
 */
export function upsertBlock(content: string, block: string): string {
  const start = content.indexOf(MARKER_BEGIN);
  const end = content.indexOf(MARKER_END);

  if (start !== -1 && end !== -1 && end > start) {
    const before = content.slice(0, start);
    const after = content.slice(end + MARKER_END.length).replace(/^\n/, "");
    return `${before}${block}${after}`;
  }

  const separator =
    content.length === 0 || content.endsWith("\n\n")
      ? ""
      : content.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${content}${separator}${block}`;
}

export interface FileChange {
  path: string;
  created: boolean;
  updated: boolean;
}

function writeBlockTo(
  projectRoot: string,
  filename: string,
  block: string
): FileChange {
  const path = join(projectRoot, filename);
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, "utf8") : "";
  const after = upsertBlock(before, block);

  if (before === after) {
    return { path: filename, created: false, updated: false };
  }

  writeFileSync(path, after);
  return { path: filename, created: !existed, updated: existed };
}

/**
 * Claude Code reads `CLAUDE.md` rather than `AGENTS.md`, so it needs a file of
 * its own. When one already exists we leave its contents alone unless it has
 * neither an `@AGENTS.md` import nor our block.
 */
function ensureClaudeFile(projectRoot: string, block: string): FileChange {
  const path = join(projectRoot, "CLAUDE.md");

  if (!existsSync(path)) {
    writeFileSync(path, "@AGENTS.md\n");
    return { path: "CLAUDE.md", created: true, updated: false };
  }

  const content = readFileSync(path, "utf8");
  if (content.includes("@AGENTS.md")) {
    return { path: "CLAUDE.md", created: false, updated: false };
  }

  return writeBlockTo(projectRoot, "CLAUDE.md", block);
}

/**
 * Adds the `prepare` script that re-syncs skills after any install, including
 * a fresh clone by someone who never ran this tool. Chains onto an existing
 * `prepare` rather than replacing it.
 */
export function ensurePrepareScript(
  manifest: Record<string, unknown>
): boolean {
  const scripts = (manifest.scripts ??= {}) as Record<string, string>;
  const current = scripts.prepare;

  if (current === undefined || current.trim() === "") {
    scripts.prepare = PREPARE_COMMAND;
    return true;
  }

  if (current.includes("miden-skills")) return false;

  scripts.prepare = `${current} && ${PREPARE_COMMAND_CHAINED}`;
  return true;
}

export function ensureGitignore(projectRoot: string): boolean {
  const path = join(projectRoot, ".gitignore");
  const entry = `${SKILLS_DIR.split(/[\\/]/).join("/")}/`;
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";

  if (content.split("\n").some((line) => line.trim() === entry)) return false;

  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  writeFileSync(
    path,
    `${content}${separator}# Synced from node_modules by @miden-sdk/create\n${entry}\n`
  );
  return true;
}

export interface InitResult {
  files: FileChange[];
  prepareAdded: boolean;
  gitignoreUpdated: boolean;
}

/**
 * Writes everything that has to live in the consumer's repository. The synced
 * skills themselves are deliberately not committed - they are regenerated from
 * `node_modules` on every install, so they cannot go stale against the lockfile.
 */
export function init(projectRoot: string): InitResult {
  const packages = [
    ...new Set(discoverSkills(projectRoot).map((skill) => skill.package)),
  ];
  const block = renderBlock(packages);

  const files = [
    writeBlockTo(projectRoot, "AGENTS.md", block),
    ensureClaudeFile(projectRoot, block),
  ];

  const manifestPath = join(projectRoot, "package.json");
  let prepareAdded = false;

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    prepareAdded = ensurePrepareScript(manifest);
    if (prepareAdded) {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }

  return {
    files,
    prepareAdded,
    gitignoreUpdated: ensureGitignore(projectRoot),
  };
}
