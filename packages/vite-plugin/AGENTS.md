# @miden-sdk/vite-plugin — Agent Guide

**Audience: AI coding agents** configuring a bundler for a Miden web app.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/vite-plugin/AGENTS.md` matches the version you have
installed. Prefer it over your training data.

## Load the skill

`node_modules/@miden-sdk/vite-plugin/skills/vite-wasm-setup/SKILL.md` is the
full guide: `midenVitePlugin()` options, cross-origin isolation headers, the
gRPC-web proxy, WASM deduplication, and what to do when a bundler other than
Vite is in play. Read it before hand-rolling any WASM or header configuration —
almost every "it works in dev but not in prod" report traces back to something
it documents.

## What the plugin is for

Miden runs a WASM client in the browser. Getting that to work involves three
pieces of configuration that are easy to get subtly wrong by hand: serving the
WASM asset correctly, setting COOP/COEP headers for the multi-threaded build,
and making sure a single copy of the SDK is resolved. The plugin does all
three:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  plugins: [midenVitePlugin()],
});
```

Zero-config is the intended path. Reach for options only when you have a
concrete reason, and check the skill first — several of the knobs interact.

## The trap worth stating up front

Cross-origin isolation headers are needed for the **multi-threaded** build and
change how your whole page behaves: once COOP/COEP are set, third-party
embeds, images and scripts that lack the right CORS headers stop loading.
Adding them "just in case" breaks unrelated parts of an app, and the breakage
usually shows up far from this config. Decide which build you are on first;
the skill spells out the consequences of each.

## Going deeper

- Narrative docs: <https://docs.miden.xyz/builder/tools/clients/web-client/>
- The client this configures documents itself at
  `node_modules/@miden-sdk/miden-sdk/AGENTS.md`.
