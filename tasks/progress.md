# Implementation ledger: tasks/todo.md

Task1: tests added - expected red-before CI pending; implementation has not started.

| Task | Internal consistency | Shared interfaces | Result |
| --- | --- | --- | --- |
| Parallel release builds | Tests require the parallel build graph and retained publish guards that the workflow will implement | Build artifact names, same-ref checkout and dist paths shared by producer and publisher | Consistent |

The approved chat description is the specification. No plan panel is run: global instructions require planning and implementation before finished-code Council review. The task review and whole-branch review cover one cohesive diff in the same final Council loop.

## Red-before preparation

- Added 18 YAML-parsed workflow contracts covering parallel dependencies, immutable checkout refs, current-run artifact handoff, publication order, native/artifact failure gates and independent/retry paths.
- Added yaml2.8.3 to the web-client dev dependency importer; existing package and snapshot entries are reused.
- Frozen isolated dependency install passed through ci-local in21s. The initially requested filtered test command was refused before execution (exit75); the parent-authorized supported command from crates/web-client ran18 tests with11 intended failures and7 passes. Failures identify the missing parallel producer, immutable ref, artifact handoff and artifact gates.
- Source audit: core post-build.js, build-types.js, clean.js and rollup generated publication inputs live under crates/web-client/dist; React tsup and post-build variant rewrites live under packages/react-sdk/dist. Node JS exports and lazy/mt shims are checked-in inputs.
- Ruling: preserve exact-version npm hydration for adopted-only retries inside the parallel job; source-build canonical full WASM whenever web or React publishes. This retains retry support without rebuilding already-published WASM.
- Ruling: export the checked-out SHA from check-version for all downstream checkouts and artifact identity. This prevents moving next/dispatch refs from mixing sources.
