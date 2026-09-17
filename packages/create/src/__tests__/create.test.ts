import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../cli";
import {
  ensureGitignore,
  ensurePrepareScript,
  init,
  MARKER_BEGIN,
  MARKER_END,
  PREPARE_COMMAND,
  renderBlock,
  upsertBlock,
} from "../init";
import { discoverSkills, MANIFEST, SKILLS_DIR, sync } from "../sync";

let root: string;

/** Writes a fake installed package that ships the given skills. */
function installPackage(name: string, version: string, skills: string[]): void {
  const pkgDir = join(root, "node_modules", "@miden-sdk", name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: `@miden-sdk/${name}`, version })
  );

  for (const skill of skills) {
    const dir = join(pkgDir, "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${skill}\n`);
  }
}

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miden-create-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("discoverSkills", () => {
  it("returns nothing when no packages are installed", () => {
    expect(discoverSkills(root)).toEqual([]);
  });

  it("finds skills across every installed @miden-sdk package", () => {
    installPackage("miden-sdk", "0.16.0", [
      "web-client-usage",
      "frontend-pitfalls",
    ]);
    installPackage("react", "0.16.0", ["react-sdk-patterns"]);

    expect(discoverSkills(root).map((skill) => skill.name)).toEqual([
      "frontend-pitfalls",
      "web-client-usage",
      "react-sdk-patterns",
    ]);
  });

  it("records the package and version each skill came from", () => {
    installPackage("react", "0.16.0-rc.3", ["react-sdk-patterns"]);

    expect(discoverSkills(root)[0]).toMatchObject({
      package: "@miden-sdk/react",
      version: "0.16.0-rc.3",
    });
  });

  it("ignores packages without a skills directory", () => {
    mkdirSync(join(root, "node_modules", "@miden-sdk", "vite-plugin"), {
      recursive: true,
    });
    expect(discoverSkills(root)).toEqual([]);
  });

  it("ignores skill directories with no SKILL.md", () => {
    installPackage("miden-sdk", "0.16.0", ["real"]);
    mkdirSync(
      join(root, "node_modules", "@miden-sdk", "miden-sdk", "skills", "empty"),
      { recursive: true }
    );

    expect(discoverSkills(root).map((skill) => skill.name)).toEqual(["real"]);
  });

  it("falls back to a derived name when package.json is unreadable", () => {
    installPackage("react", "0.16.0", ["react-sdk-patterns"]);
    writeFileSync(
      join(root, "node_modules", "@miden-sdk", "react", "package.json"),
      "{ not json"
    );

    expect(discoverSkills(root)[0]).toMatchObject({
      package: "@miden-sdk/react",
      version: "unknown",
    });
  });
});

describe("sync", () => {
  it("reports empty when nothing is installed, without creating anything", () => {
    expect(sync(root)).toMatchObject({ empty: true, written: [], removed: [] });
    expect(existsSync(join(root, SKILLS_DIR))).toBe(false);
  });

  it("copies skills and their nested files into .claude/skills", () => {
    installPackage("miden-sdk", "0.16.0", ["web-client-usage"]);
    const nested = join(
      root,
      "node_modules",
      "@miden-sdk",
      "miden-sdk",
      "skills",
      "web-client-usage",
      "ref"
    );
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "extra.md"), "extra\n");

    sync(root);

    expect(read(SKILLS_DIR, "web-client-usage", "SKILL.md")).toBe(
      "# web-client-usage\n"
    );
    expect(read(SKILLS_DIR, "web-client-usage", "ref", "extra.md")).toBe(
      "extra\n"
    );
  });

  it("is idempotent", () => {
    installPackage("miden-sdk", "0.16.0", ["web-client-usage"]);

    sync(root);
    const first = read(SKILLS_DIR, "web-client-usage", "SKILL.md");
    sync(root);

    expect(read(SKILLS_DIR, "web-client-usage", "SKILL.md")).toBe(first);
    expect(JSON.parse(read(MANIFEST))).toEqual({
      skills: ["web-client-usage"],
    });
  });

  it("overwrites local edits so the skills match the installed version", () => {
    installPackage("miden-sdk", "0.16.0", ["web-client-usage"]);
    sync(root);
    writeFileSync(
      join(root, SKILLS_DIR, "web-client-usage", "SKILL.md"),
      "stale\n"
    );

    sync(root);

    expect(read(SKILLS_DIR, "web-client-usage", "SKILL.md")).toBe(
      "# web-client-usage\n"
    );
  });

  it("removes skills it previously wrote that are no longer shipped", () => {
    installPackage("miden-sdk", "0.16.0", ["kept", "dropped"]);
    sync(root);

    rmSync(
      join(
        root,
        "node_modules",
        "@miden-sdk",
        "miden-sdk",
        "skills",
        "dropped"
      ),
      { recursive: true }
    );
    const result = sync(root);

    expect(result.removed).toEqual(["dropped"]);
    expect(existsSync(join(root, SKILLS_DIR, "dropped"))).toBe(false);
    expect(existsSync(join(root, SKILLS_DIR, "kept"))).toBe(true);
  });

  it("leaves skills it did not write alone", () => {
    installPackage("miden-sdk", "0.16.0", ["web-client-usage"]);
    const mine = join(root, SKILLS_DIR, "my-own-skill");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "mine\n");

    sync(root);

    expect(read(SKILLS_DIR, "my-own-skill", "SKILL.md")).toBe("mine\n");
  });
});

describe("renderBlock", () => {
  it("is delimited by markers so it can be rewritten in place", () => {
    const block = renderBlock(["@miden-sdk/react"]);
    expect(block.startsWith(MARKER_BEGIN)).toBe(true);
    expect(block).toContain(MARKER_END);
  });

  it("points at every installed package", () => {
    const block = renderBlock(["@miden-sdk/miden-sdk", "@miden-sdk/react"]);
    expect(block).toContain("node_modules/@miden-sdk/miden-sdk/AGENTS.md");
    expect(block).toContain("node_modules/@miden-sdk/react/AGENTS.md");
  });

  it("falls back to the core package when nothing is installed yet", () => {
    expect(renderBlock([])).toContain(
      "node_modules/@miden-sdk/miden-sdk/AGENTS.md"
    );
  });

  // A consumer either runs this tool or pastes the block out of a package
  // README by hand. Those two paths must not hand them different guidance, and
  // nothing but this test connects them: the READMEs are markup, this is code.
  // The two differ on purpose in exactly one paragraph - the tool syncs skills
  // into .claude/skills/, the README cannot - so the opening and the closing
  // are pinned and the middle is not.
  describe("agrees with the block published in the package READMEs", () => {
    const readme = join(
      __dirname,
      "..",
      "..",
      "..",
      "vite-plugin",
      "README.md"
    );
    const published = readFileSync(readme, "utf8");
    const from = published.indexOf(MARKER_BEGIN);
    const to = published.indexOf(MARKER_END);
    const readmeBlock = published.slice(from, to + MARKER_END.length);
    const rendered = renderBlock(["@miden-sdk/react"]);

    // Everything from the marker down to the line introducing the bullet list.
    const opening = (block: string): string =>
      block.slice(0, block.indexOf("\n\n- "));
    // The final paragraph, after the last blank line before the end marker.
    const closing = (block: string): string => {
      const body = block.slice(0, block.indexOf(MARKER_END));
      return body.slice(body.lastIndexOf("\n\n") + 2).trimEnd();
    };

    it("has a byte-identical opening", () => {
      expect(opening(rendered)).toBe(opening(readmeBlock));
    });

    it("has a byte-identical closing", () => {
      expect(closing(rendered)).toBe(closing(readmeBlock));
      expect(closing(rendered)).toContain(
        "the guide is right and your assumption"
      );
    });
  });
});

describe("upsertBlock", () => {
  const block = renderBlock(["@miden-sdk/react"]);

  it("writes into an empty file without leading blank lines", () => {
    expect(upsertBlock("", block).startsWith(MARKER_BEGIN)).toBe(true);
  });

  it("appends after existing content, separated by a blank line", () => {
    expect(upsertBlock("# My rules\n", block)).toBe(`# My rules\n\n${block}`);
  });

  it("does not add a separator when one is already there", () => {
    expect(upsertBlock("# My rules\n\n", block)).toBe(`# My rules\n\n${block}`);
  });

  it("separates content that does not end in a newline", () => {
    expect(upsertBlock("# My rules", block)).toBe(`# My rules\n\n${block}`);
  });

  it("replaces an existing block in place, preserving what surrounds it", () => {
    const before = `# Top\n\n${MARKER_BEGIN}\nold content\n${MARKER_END}\n\n# Bottom\n`;
    const result = upsertBlock(before, block);

    expect(result).toContain("# Top");
    expect(result).toContain("# Bottom");
    expect(result).not.toContain("old content");
    expect(result.match(new RegExp(MARKER_BEGIN, "g"))).toHaveLength(1);
  });

  it("appends when the markers are malformed rather than corrupting the file", () => {
    const before = `${MARKER_END}\nstray\n${MARKER_BEGIN}\n`;
    expect(upsertBlock(before, block)).toContain("stray");
  });
});

describe("ensurePrepareScript", () => {
  it("adds the script when there is none", () => {
    const manifest: Record<string, unknown> = {};
    expect(ensurePrepareScript(manifest)).toBe(true);
    expect(manifest.scripts).toEqual({ prepare: PREPARE_COMMAND });
  });

  it("chains onto an existing prepare script", () => {
    const manifest = { scripts: { prepare: "husky" } };
    expect(ensurePrepareScript(manifest)).toBe(true);
    expect(manifest.scripts.prepare).toBe(
      "husky && (miden-skills sync || true)"
    );
  });

  it("groups the chained command so it cannot swallow the existing script's failure", async () => {
    const manifest = { scripts: { prepare: "false" } };
    ensurePrepareScript(manifest);

    const { promisify } = await import("node:util");
    const exec = promisify((await import("node:child_process")).exec);
    await expect(
      exec(manifest.scripts.prepare, { shell: "/bin/sh" })
    ).rejects.toThrow();
  });

  it("replaces an empty prepare script", () => {
    const manifest = { scripts: { prepare: "  " } };
    ensurePrepareScript(manifest);
    expect(manifest.scripts.prepare).toBe(PREPARE_COMMAND);
  });

  it("does nothing when already wired up", () => {
    const manifest = { scripts: { prepare: PREPARE_COMMAND } };
    expect(ensurePrepareScript(manifest)).toBe(false);
  });
});

describe("ensureGitignore", () => {
  it("creates the file when missing", () => {
    expect(ensureGitignore(root)).toBe(true);
    expect(read(".gitignore")).toContain(".claude/skills/");
  });

  it("appends to an existing file that lacks a trailing newline", () => {
    writeFileSync(join(root, ".gitignore"), "dist");
    ensureGitignore(root);

    expect(read(".gitignore")).toBe(
      "dist\n# Synced from node_modules by @miden-sdk/create\n.claude/skills/\n"
    );
  });

  it("is idempotent", () => {
    ensureGitignore(root);
    expect(ensureGitignore(root)).toBe(false);
  });
});

describe("init", () => {
  it("creates AGENTS.md and a CLAUDE.md that imports it", () => {
    const result = init(root);

    expect(read("AGENTS.md")).toContain(MARKER_BEGIN);
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(result.files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
  });

  it("leaves an existing CLAUDE.md that already imports AGENTS.md alone", () => {
    writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n\n# Extra\n");
    init(root);

    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n\n# Extra\n");
  });

  it("writes the block into a CLAUDE.md that stands on its own", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# House rules\n");
    init(root);

    expect(read("CLAUDE.md")).toContain("# House rules");
    expect(read("CLAUDE.md")).toContain(MARKER_BEGIN);
  });

  it("preserves surrounding content when run twice", () => {
    writeFileSync(join(root, "AGENTS.md"), "# House rules\n");
    init(root);
    init(root);

    const content = read("AGENTS.md");
    expect(content).toContain("# House rules");
    expect(content.match(new RegExp(MARKER_BEGIN, "g"))).toHaveLength(1);
  });

  it("adds the prepare script to an existing package.json", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    expect(init(root).prepareAdded).toBe(true);
    expect(JSON.parse(read("package.json")).scripts.prepare).toBe(
      PREPARE_COMMAND
    );
  });

  it("tolerates a project with no package.json", () => {
    expect(init(root).prepareAdded).toBe(false);
  });

  it("points the block at whatever is installed", () => {
    installPackage("react", "0.16.0", ["react-sdk-patterns"]);
    init(root);

    expect(read("AGENTS.md")).toContain(
      "node_modules/@miden-sdk/react/AGENTS.md"
    );
  });
});

describe("public surface", () => {
  it("re-exports everything consumers are expected to use", async () => {
    const api = await import("../index");

    expect(Object.keys(api).sort()).toEqual([
      "MARKER_BEGIN",
      "MARKER_END",
      "SKILLS_DIR",
      "discoverSkills",
      "ensureGitignore",
      "ensurePrepareScript",
      "init",
      "renderBlock",
      "sync",
      "upsertBlock",
    ]);
  });
});

describe("cli", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("prints usage for --help", () => {
    expect(main(["--help"], root)).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("npm create @miden-sdk@latest")
    );
  });

  it("rejects an unknown command", () => {
    expect(main(["nonsense"], root)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("unknown command")
    );
  });

  it("syncs without writing AGENTS.md", () => {
    installPackage("miden-sdk", "0.16.0", ["web-client-usage"]);

    expect(main(["sync"], root)).toBe(0);
    expect(existsSync(join(root, SKILLS_DIR, "web-client-usage"))).toBe(true);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });

  it("does not fail when there is nothing to sync", () => {
    expect(main(["sync"], root)).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("nothing to sync")
    );
  });

  it("stays quiet during CI installs", () => {
    vi.stubEnv("CI", "true");
    installPackage("miden-sdk", "0.16.0", ["web-client-usage"]);

    main(["sync"], root);

    expect(console.log).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("initializes the project when called with no arguments", () => {
    installPackage("react", "0.16.0", ["react-sdk-patterns"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));

    expect(main([], root)).toBe(0);
    expect(read("AGENTS.md")).toContain(MARKER_BEGIN);
    expect(existsSync(join(root, SKILLS_DIR, "react-sdk-patterns"))).toBe(true);
    expect(JSON.parse(read("package.json")).scripts.prepare).toBe(
      PREPARE_COMMAND
    );
    expect(read(".gitignore")).toContain(".claude/skills/");
  });

  it("reports an updated file on a second init", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
    main([], root);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("updated AGENTS.md")
    );
  });
});
