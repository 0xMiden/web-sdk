---
title: WASM troubleshooting
sidebar_position: 80
---

# Troubleshoot browser WASM errors

React hooks can report a `MidenError` with a `code` and the original exception
in `cause`. For direct calls, check the original error message.

## `expected instance of AccountId` or `_assertClass`

`WASM_CLASS_MISMATCH` usually means an object came from a different copy or
entry point of the SDK. Use a single copy of `@miden-sdk/miden-sdk` and import
WASM types from the same entry point as the client. In Vite, the Miden plugin
configures dependency deduplication and excludes the SDK from prebundling.

## `null pointer passed to Rust` or `object has already been freed`

`WASM_POINTER_CONSUMED` can occur when code reuses a freed object or passes the
same object to a method that takes ownership. Save the source data and construct
a fresh object for each call that consumes it.

## `Client not initialized` or `Cannot read properties of undefined`

When a WASM constructor or static method fails before the lazy entry point
has loaded, await `MidenClient.ready()` before using it. In React, render code
that constructs WASM values under `MidenProvider` after `useMiden().isReady`
is true. Check the provider's `error` if initialization fails.

## `recursive use of an object detected`

Overlapping calls on the same low-level WASM `WebClient` can trigger this
error. Prefer the high-level `MidenClient` methods, which queue calls that
need exclusive access. In React, wrap direct calls in `runExclusive` from
`useMiden()` and await each call before starting the next. If the error came
from a transaction flow, check its submission status before trying again.
