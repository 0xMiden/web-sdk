# @miden-sdk/node-linux-x64-gnu - Agent Guide

**Audience: AI coding agents** that have landed in this directory and are
trying to work out what it is.

## This is not the SDK

This package is one prebuilt native binary, `miden_client_web.node`, for
Linux x64 against glibc. It carries no JavaScript, no type declarations and no public API.
There is nothing here to import, and nothing here to call.

The SDK is `@miden-sdk/miden-sdk`. Its guide, which is the one you want, is at
`node_modules/@miden-sdk/miden-sdk/AGENTS.md`.

## Why it is installed

`@miden-sdk/miden-sdk` lists the native packages as `optionalDependencies`, so
your package manager installs only the one matching the current platform and
silently skips the rest. On Node.js the SDK's loader resolves the binary in
this order:

1. `MIDEN_MODULE_PATH`, or an explicit `modulePath` option
2. the platform package for `linux-x64` on a glibc C library, which is this one
   (on musl it picks `@miden-sdk/node-linux-x64-musl` instead)
3. the SDK's own `prebuilds/` directory
4. the repo `target/` directory, for local development

See `node_modules/@miden-sdk/miden-sdk/js/node/loader.js` for the
implementation.

## If loading failed

Do not try to require this package directly, and do not add it to your
`dependencies` to force it. A failure here is almost always one of:

- **Platform mismatch.** The `os`, `cpu` and `libc` fields in this
  `package.json` are what make npm and pnpm skip non-matching platforms. A
  container built on one architecture or C library and run on another gets no
  binary. Install on the target platform, or set `MIDEN_MODULE_PATH` to a
  binary you supply.
  With npm, an install for Linux from another OS (`npm install --os=linux
  --cpu=x64`) must also pass `--libc=glibc`; npm cannot detect the C library of
  a foreign OS and otherwise skips this package.
- **`--no-optional`, or a lockfile pinned on another platform.** Optional
  dependencies are how this is delivered; skipping them skips the binary.
- **musl rather than glibc.** This package links against glibc and does not
  load on Alpine or other musl distributions. Those use
  `@miden-sdk/node-linux-x64-musl`.

In the browser none of this applies: the browser build runs WASM and never
loads a native module.
