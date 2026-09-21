import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Directory the synced skills are written to, relative to the project root. */
export const SKILLS_DIR = join(".claude", "skills");

/**
 * Records which skills this tool wrote, so a later sync can remove the ones
 * that are no longer shipped without touching skills the user added by hand.
 */
export const MANIFEST = join(SKILLS_DIR, ".miden-skills.json");

interface Manifest {
  skills: string[];
}

export interface DiscoveredSkill {
  name: string;
  sourceDir: string;
  package: string;
  version: string;
}

export interface SyncResult {
  written: DiscoveredSkill[];
  removed: string[];
  /** True when no @miden-sdk package with skills was installed. */
  empty: boolean;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds every `skills/<name>/` directory shipped by an installed `@miden-sdk/*`
 * package. Reads the installed tree rather than the network, so the result is
 * pinned to whatever the lockfile resolved.
 */
export function discoverSkills(projectRoot: string): DiscoveredSkill[] {
  const scopeDir = join(projectRoot, "node_modules", "@miden-sdk");
  if (!isDirectory(scopeDir)) return [];

  const found: DiscoveredSkill[] = [];

  for (const pkgName of readdirSync(scopeDir).sort()) {
    const pkgDir = join(scopeDir, pkgName);
    const skillsDir = join(pkgDir, "skills");
    if (!isDirectory(skillsDir)) continue;

    const manifest = readJson<{ name?: string; version?: string }>(
      join(pkgDir, "package.json")
    );

    for (const skillName of readdirSync(skillsDir).sort()) {
      const sourceDir = join(skillsDir, skillName);
      if (!isDirectory(sourceDir)) continue;
      if (!existsSync(join(sourceDir, "SKILL.md"))) continue;

      found.push({
        name: skillName,
        sourceDir,
        package: manifest?.name ?? `@miden-sdk/${pkgName}`,
        version: manifest?.version ?? "unknown",
      });
    }
  }

  return found;
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dest = join(to, entry);
    if (isDirectory(src)) {
      copyDir(src, dest);
    } else {
      writeFileSync(dest, readFileSync(src));
    }
  }
}

/**
 * Copies the shipped skills into `.claude/skills/`, replacing what a previous
 * run put there and leaving anything else in that directory alone.
 *
 * Safe to run on every install: it is idempotent, reads only from
 * `node_modules`, and no-ops when nothing is installed yet.
 */
export function sync(projectRoot: string): SyncResult {
  const discovered = discoverSkills(projectRoot);
  const targetRoot = join(projectRoot, SKILLS_DIR);
  const manifestPath = join(projectRoot, MANIFEST);
  const previous = readJson<Manifest>(manifestPath)?.skills ?? [];

  if (discovered.length === 0) {
    return { written: [], removed: [], empty: true };
  }

  const names = discovered.map((skill) => skill.name);

  // Drop skills an earlier sync wrote that the installed packages no longer
  // ship. Anything absent from the manifest was not ours to remove.
  const removed = previous.filter((name) => !names.includes(name));
  for (const name of removed) {
    rmSync(join(targetRoot, name), { recursive: true, force: true });
  }

  for (const skill of discovered) {
    const dest = join(targetRoot, skill.name);
    rmSync(dest, { recursive: true, force: true });
    copyDir(skill.sourceDir, dest);
  }

  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ skills: names }, null, 2)}\n`
  );

  return { written: discovered, removed, empty: false };
}
