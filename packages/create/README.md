# @miden-sdk/create

Points your AI coding agent at version-matched Miden SDK guidance.

```bash
npm create @miden-sdk@latest
```

Run it in a project that already uses (or is about to use) the Miden web SDK.
It is safe to re-run, and it never overwrites content it did not write.

## Why this is needed

Every published `@miden-sdk/*` package ships an `AGENTS.md` and a `skills/`
directory inside its tarball. That documentation is version-matched to the code
you installed, which makes it strictly better than an agent's training data for
a pre-1.0 SDK whose API still moves.

The catch is that **no coding agent reads instruction files from
`node_modules`.** Claude Code walks up from the working directory looking for
`CLAUDE.md`; Cursor and Codex read `AGENTS.md` from the project root. None of
them descend into dependencies. Shipping the docs is necessary but not
sufficient - something has to tell the agent they exist.

That is all this command does.

## What it changes

| File | Change |
|---|---|
| `AGENTS.md` | Adds a marker-delimited block pointing at the installed packages' guides. Existing content is preserved; re-running updates the block in place. |
| `CLAUDE.md` | Created as `@AGENTS.md` so Claude Code picks up the same file. An existing `CLAUDE.md` is left alone if it already imports `AGENTS.md`. |
| `package.json` | Adds `"prepare": "miden-skills sync \|\| true"`, chained onto any existing `prepare`. |
| `.gitignore` | Ignores `.claude/skills/`, which is generated rather than committed. |
| `.claude/skills/` | Skills copied out of `node_modules`. |

Commit the first four. The fifth is regenerated.

## Why `prepare` rather than committing the skills

`prepare` runs after every `npm install`, including a fresh clone by a
teammate who has never run this command. So the skills are rebuilt from
whatever the lockfile resolved, and cannot drift from the SDK the project
actually uses. Committing them would freeze a snapshot that silently goes stale
on the next upgrade - which is exactly how the previous copies of this content
drifted apart.

This is the same mechanism husky uses. It is unaffected by pnpm's blocking of
dependency lifecycle scripts, because it is *your* project's script rather than
a dependency's.

The `|| true` is deliberate: `pnpm prune --prod` runs `prepare` after removing
devDependencies, so the sync has to tolerate its own absence rather than break
the build.

Even if `prepare` never runs - `--ignore-scripts`, a production install - the
committed block still names the paths under `node_modules`, which exist after
any install. The agent finds the guidance either way.

## Commands

```bash
npm create @miden-sdk@latest   # set up this project
miden-skills sync              # re-sync skills only (what "prepare" runs)
miden-skills --help
```

## Starting from scratch instead

If there is no project yet, [`0xMiden/agentic-template`](https://github.com/0xMiden/agentic-template)
scaffolds the whole stack - Rust contracts, MockChain tests, local-node
validation, and a React frontend wired to this SDK. It uses this same command
internally, so both routes end up with the same skills at the same version.

## License

MIT
