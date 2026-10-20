# Parallel release builds

Approved behavior: build WASM and React alongside all native binaries, then publish the native packages, core SDK and React as soon as all prerequisites pass. Preserve complete Node support from the first install. This change is for future releases only; v0.17.5 remains at tag69d91db7 and its retry is untouched.

## Plan

- [x] Inspect publish ordering, package dependencies, CI gates and existing static-contract test patterns.
- [ ] Add workflow contract tests and yaml2.8.3 as a direct test dependency, reusing the existing lockfile package. Commit and obtain expected red-before evidence on the PR in CI.
- [ ] Move release WASM and React builds into a separate artifact job depending only on check-version. Keep the canonical optimized build, Cargo.lock check and WASM size verification. Upload complete build inputs needed by publication.
- [ ] Make publication consume those same-ref artifacts and wait for all native builds before publishing any core package. Keep native packages before core, then React. Preserve stable/prerelease/dispatch/next events and React-only, Vite-only, adopted-only and partially published retry paths.
- [ ] Run named light checks only through ci-local. Run heavy builds/suites in PR CI. Keep all thresholds unchanged.
- [ ] Review finished code using the required Council roster and fix actionable findings. Push the completed change and wait for current-head CI.
- [ ] Deliver the future-release PR without changing the active0.17.5 tag, release workflow attempt or package publication.

## Files

- .github/workflows/publish-web-sdk.yml: parallel artifact build and guarded artifact consumption.
- crates/web-client/js/__tests__/publishWorkflow.test.js: declarative graph, artifact, ref and publication safety contracts.
- crates/web-client/package.json and pnpm-lock.yaml: explicit YAML parser dependency at already locked2.8.3.

## Review focus

- Core and React must not publish if any required native build fails.
- Every built/downloaded artifact must come from the resolved release ref and matching workflow run.
- Partial publication retries must still provision core and React dist for adopted packages.
- React-only, Vite-only and adopted-only events must retain their supported independent paths.
- A failed or skipped artifact build must not silently fall through to publication; no fast-build bytes may be published.

## Verification

Pending. Existing main69d91db7 is green across all five push workflows. Workflow comment ratio measured168/574 lines,29.3%; keep comments focused on non-obvious boundaries.
