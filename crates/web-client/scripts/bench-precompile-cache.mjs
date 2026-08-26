// Benchmarks the precompile prover's preprocessed-table cache (issue #318).
//
// A transaction authenticated with an ECDSA/keccak key raises a precompile
// claim, so proving it runs miden-precompiles-prover's STARK session — which
// needs a preprocessed bundle (2^16-row BytePairLut table + coset LDE + Merkle
// commitment). With `std` on that crate the bundle is cached in a
// process-lifetime OnceLock; without it, every prove rebuilds it. This script
// measures that: it executes ONE ECDSA transaction against an in-browser mock
// chain (no network), then proves the same TransactionResult repeatedly in the
// same wasm instance, timing each prove. prove #1 is the cold cache, proves
// #2..M are warm. A Falcon-authenticated twin raises no precompile claim and
// serves as the control.
//
// Two traps this script deliberately avoids:
//   - On a mock client, proveTransaction without an explicit prover returns a
//     DUMMY proof (see new_transactions.rs, cfg(feature = "testing")). Every
//     prove here passes TransactionProver.newLocalProver().
//   - The mock chain's worker serialization is broken (see test-setup.ts), and
//     timings must stay on the main thread anyway — the worker is terminated.
//
// Usage:
//   node scripts/bench-precompile-cache.mjs [dist-st-dir] [--pages N] [--proves M] [--variants ecdsa,falcon] [--spans]
//
// dist-st-dir defaults to ../dist/st. Pass a saved copy of a differently-built
// dist to compare binaries (e.g. before/after the Cargo `std` fix). --spans
// enables Rust tracing ("info") so span durations land in the Performance API
// (via tracing-wasm); use it as a validity gate — the `build_session` /
// `build_trace` spans exist only when a precompile claim was actually raised —
// but read headline numbers from runs WITHOUT --spans (console logging from
// the tracing layer perturbs timings).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const USAGE =
  "  node scripts/bench-precompile-cache.mjs [dist-st-dir] " +
  "[--pages N] [--proves M] [--variants ecdsa,falcon] [--spans]";

const args = process.argv.slice(2);

const usage = (message) => {
  console.error(`${message}\n\nUsage:\n${USAGE}`);
  process.exit(2);
};

const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  // Catch `--pages` at the end of argv and `--pages --spans`, both of which
  // would otherwise parse to NaN and silently run zero iterations.
  if (value === undefined || value.startsWith("--")) {
    usage(`${name} requires a value.`);
  }
  return value;
};

const count = (name, fallback) => {
  const raw = flag(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    usage(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
};

const KNOWN_VARIANTS = new Set(["ecdsa", "falcon"]);

const distDir = path.resolve(
  args[0] && !args[0].startsWith("--")
    ? args[0]
    : path.join(scriptDir, "../dist/st")
);
const numPages = count("--pages", "3");
const numProves = count("--proves", "3");
const variants = flag("--variants", "ecdsa,falcon")
  .split(",")
  .map((variant) => variant.trim());
const withSpans = args.includes("--spans");

// An unrecognized variant would otherwise fall through to the Falcon branch
// below while keeping the caller's label, reporting the control condition as
// if it were the ECDSA measurement.
for (const variant of variants) {
  if (!KNOWN_VARIANTS.has(variant)) {
    usage(
      `Unknown variant "${variant}". Expected one of: ${[...KNOWN_VARIANTS].join(", ")}.`
    );
  }
}

const contentTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json"],
  [".wasm", "application/wasm"],
]);

// Static server over the dist dir. No COOP/COEP: the ST build must work in
// non-cross-origin-isolated contexts, so the bench runs in one too.
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><meta charset=utf-8><title>precompile cache bench</title>"
      );
      return;
    }

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filePath = path.resolve(distDir, relativePath);
    if (!filePath.startsWith(`${distDir}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404).end();
      return;
    }

    response.setHeader(
      "Content-Type",
      contentTypes.get(path.extname(filePath)) ?? "application/octet-stream"
    );
    // `pipe` does not forward source errors, and the headers are already sent
    // by this point, so a mid-read failure can only be surfaced by tearing the
    // response down — otherwise the browser stalls on the asset forever.
    createReadStream(filePath)
      .on("error", (error) => {
        console.error(`[server] read failed for ${filePath}: ${error}`);
        response.destroy(error);
      })
      .pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve, reject) => {
  const onListenError = (error) => reject(error);
  server.once("error", onListenError);
  server.listen(0, "127.0.0.1", () => {
    // Leaving the startup listener attached would let the first post-startup
    // error settle an already-resolved promise and vanish.
    server.off("error", onListenError);
    server.on("error", (error) => console.error(`[server] ${error}`));
    resolve();
  });
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Failed to resolve bench server address");
}

// Runs inside page.evaluate. Builds a custom-component account with the given
// auth scheme, executes one state-changing custom-script transaction on the
// mock chain, then proves the same TransactionResult `proves` times with a
// fresh explicit local prover each time (the prover parameter is consumed by
// wasm-bindgen). Account/script code copied from
// test/new_transactions_mint_and_misc.test.ts (custom account component tests).
const benchInPage = async ({ variant, proves, spans }) => {
  const sdk = await import("/index.js");

  const client = await sdk.MockWasmWebClient.createClient(
    null,
    null,
    null,
    spans ? "info" : undefined
  );
  if (client.worker) {
    client.worker.terminate();
    client.worker = null;
  }

  const MAP_SLOT_NAME = "miden::testing::mapping_example_contract::map_slot";

  const accountCode = `
    use miden::protocol::active_account
    use miden::protocol::native_account
    use miden::core::word
    use miden::core::sys

    const MAP_SLOT = word("${MAP_SLOT_NAME}")

    # Inputs: [KEY, VALUE]
    # Outputs: []
    @account_procedure
    pub proc write_to_map
        push.MAP_SLOT[0..2]
        exec.native_account::set_map_item
        # => [OLD_MAP_ROOT, OLD_MAP_VALUE]

        dropw dropw dropw dropw
        # => []
    end

    # Inputs: [KEY]
    # Outputs: [VALUE]
    @account_procedure
    pub proc get_value_in_map
        push.MAP_SLOT[0..2]
        exec.active_account::get_map_item
        # => [VALUE]
    end

    # Inputs: []
    # Outputs: [CURRENT_ROOT]
    @account_procedure
    pub proc get_current_map_root
        push.MAP_SLOT[0..2] exec.active_account::get_item
        # => [CURRENT_ROOT]

        exec.sys::truncate_stack
        # => [CURRENT_ROOT]
    end
  `;
  const scriptCode = `
    use miden_by_example::mapping_example_contract
    use miden::core::sys

    @transaction_script
    pub proc main
        push.1.2.3.4
        push.0.0.0.0
        # => [KEY, VALUE]

        call.mapping_example_contract::write_to_map
        # => []

        push.0.0.0.0
        # => [KEY]

        call.mapping_example_contract::get_value_in_map
        # => [VALUE]

        dropw
        # => []

        call.mapping_example_contract::get_current_map_root
        # => [CURRENT_ROOT]

        exec.sys::truncate_stack
    end
  `;

  const builder = await client.createCodeBuilder();
  const storageMap = new sdk.StorageMap();
  const storageSlotMap = sdk.StorageSlot.map(MAP_SLOT_NAME, storageMap);

  const accountComponentCode = builder.compileAccountComponentCodeWithPath(
    "miden_by_example::mapping_example_contract",
    accountCode
  );
  const mappingAccountComponent = sdk.AccountComponent.compile(
    accountComponentCode,
    [storageSlotMap]
  ).withSupportsAllTypes();

  const walletSeed = new Uint8Array(32);
  crypto.getRandomValues(walletSeed);

  const secretKey =
    variant === "ecdsa"
      ? sdk.AuthSecretKey.ecdsaWithRNG(walletSeed)
      : sdk.AuthSecretKey.rpoFalconWithRNG(walletSeed);
  const authComponent =
    sdk.AccountComponent.createAuthComponentFromSecretKey(secretKey);

  const accountBuilderResult = new sdk.AccountBuilder(walletSeed)
    .storageMode(sdk.AccountStorageMode.public())
    .withAuthComponent(authComponent)
    .withComponent(mappingAccountComponent)
    .build();

  await client.keystore.insert(accountBuilderResult.account.id(), secretKey);
  await client.newAccount(accountBuilderResult.account, false);

  builder.linkStaticAccountComponentCode(
    mappingAccountComponent.componentCode()
  );
  const txScript = builder.compileTxScript(scriptCode);
  const request = new sdk.TransactionRequestBuilder()
    .withCustomScript(txScript)
    .build();

  // Execute once, untimed — proving is the subject, and reusing one
  // TransactionResult removes all execution variance between proves.
  const txResult = await client.executeTransaction(
    accountBuilderResult.account.id(),
    request
  );

  const proveMs = [];
  for (let i = 0; i < proves; i++) {
    const prover = sdk.TransactionProver.newLocalProver();
    const t0 = performance.now();
    await client.proveTransaction(txResult, prover);
    proveMs.push(performance.now() - t0);
  }

  const measures = spans
    ? performance
        .getEntriesByType("measure")
        .filter((e) => /prove_stark|build_session|build_trace/.test(e.name))
        .map((e) => ({ name: e.name, ms: e.duration }))
    : [];

  return { variant, proveMs, measures };
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[s.length >> 1]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (ms) => `${ms.toFixed(0)}ms`;

let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true });

  for (const variant of variants) {
    for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
      // Fresh context + page per iteration: a fresh wasm instantiation means a
      // cold OnceLock, so prove #1 measures the uncached path every time.
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        // An uncaught page error means the timings for this iteration are
        // unexplained, so fail the run rather than fold suspect numbers into
        // the medians.
        const pageErrors = [];
        page.on("pageerror", (error) => {
          console.error(`[pageerror] ${error}`);
          pageErrors.push(error);
        });
        await page.goto(`http://127.0.0.1:${address.port}/`);

        const r = await page.evaluate(benchInPage, {
          variant,
          proves: numProves,
          spans: withSpans,
        });
        if (pageErrors.length) {
          throw new Error(
            `${variant} page ${pageIdx} raised ${pageErrors.length} page error(s); first: ${pageErrors[0]}`
          );
        }
        results.push({ page: pageIdx, ...r });
        console.log(
          `${variant} page ${pageIdx}: ${r.proveMs.map(fmt).join("  ")}` +
            (r.measures.length
              ? `\n  spans: ${r.measures.map((m) => `${m.name}=${fmt(m.ms)}`).join("  ")}`
              : "")
        );
      } finally {
        await context.close();
      }
    }
  }
} finally {
  // Settle both teardowns independently: a failing browser close must not skip
  // the server close, and neither may replace the benchmark's own error.
  const teardown = await Promise.allSettled([
    browser?.close(),
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  ]);
  for (const outcome of teardown) {
    if (outcome.status === "rejected") {
      console.error(`[teardown] ${outcome.reason}`);
    }
  }
}

console.log(`\ndist: ${distDir}`);
console.log(`pages=${numPages} proves/page=${numProves} spans=${withSpans}\n`);
for (const variant of variants) {
  const rows = results.filter((r) => r.variant === variant);
  if (!rows.length) continue;
  const cold = rows.map((r) => r.proveMs[0]);
  const warm = rows.flatMap((r) => r.proveMs.slice(1));
  console.log(
    `${variant}: cold median ${fmt(median(cold))}  warm median ${
      warm.length ? fmt(median(warm)) : "n/a"
    }  (cold-warm delta ${warm.length ? fmt(median(cold) - median(warm)) : "n/a"})`
  );
}
console.log(`\nJSON: ${JSON.stringify(results)}`);
