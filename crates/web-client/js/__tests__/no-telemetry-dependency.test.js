import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Standing guard over the two properties that let a consumer claim this SDK
 * cannot phone home:
 *
 *   1. The core package declares no telemetry vendor, in any dependency
 *      field. The core is what wallets bundle, so a vendor declared here
 *      lands in every consumer's tree whether or not they asked for it.
 *   2. The core observability module has no network capability and invokes
 *      nothing but the callback the consumer registered. The SDK hands an
 *      observation over; it never transports one.
 *
 * SCOPE — read before extending. Every assertion here is about the single
 * package `@miden-sdk/miden-sdk`, whose manifest sits two directories up.
 * The opt-in binding packages (`@miden-sdk/telemetry-sentry`,
 * `@miden-sdk/telemetry-otel`) exist precisely so a consumer who wants a
 * vendor can take the dependency deliberately, and they are expected to name
 * their vendor. Nothing below reads their manifests, and the classifier
 * judges a scoped package by its scope alone so a first-party binding's own
 * name can never match. A guard that fires on a legitimate binding package
 * gets deleted by whoever hits it, which leaves the core unguarded.
 */

const CORE_PACKAGE_NAME = "@miden-sdk/miden-sdk";
const CORE_MANIFEST_PATH = fileURLToPath(
  new URL("../../package.json", import.meta.url)
);
const OBSERVABILITY_MODULE_PATH = fileURLToPath(
  new URL("../observability.js", import.meta.url)
);

const coreManifest = JSON.parse(readFileSync(CORE_MANIFEST_PATH, "utf8"));

/**
 * Scopes a telemetry vendor owns outright: nothing published under them is
 * anything other than telemetry, so the scope alone decides and the local
 * name is never inspected. This is what keeps a first-party binding package
 * such as `@miden-sdk/telemetry-sentry` from matching — its scope is ours.
 */
const VENDOR_SCOPES = new Set([
  "@sentry",
  "@sentry-internal",
  "@opentelemetry",
  "@datadog",
  "@amplitude",
  "@segment",
  "@newrelic",
  "@bugsnag",
  "@honeycombio",
  "@posthog",
  "@highlight-run",
]);

/**
 * Vendors that publish with no scope, or under a scope they share with
 * unrelated packages, are listed by exact full name so the shared scope is
 * never condemned wholesale.
 */
const VENDOR_PACKAGES = new Set([
  "opentelemetry",
  "posthog-js",
  "posthog-node",
  "mixpanel",
  "mixpanel-browser",
  "amplitude-js",
  "analytics-node",
  "logrocket",
  "logrocket-react",
  "rollbar",
  "raven",
  "raven-js",
  "newrelic",
  "bugsnag-js",
  "hotjar",
  "react-ga",
  "react-ga4",
  "@fullstory/browser",
  "@vercel/analytics",
  "@grafana/faro-web-sdk",
  "@microsoft/applicationinsights-web",
]);

/**
 * Coined brand words that belong to no package that is not telemetry. They
 * are matched only against the unscoped part of a name, and only as a whole
 * separator-delimited token, so a descriptive name that happens to contain
 * one as a substring is left alone.
 *
 * Deliberately absent: the words "telemetry", "analytics", "metrics",
 * "observability" and "sentry". Each of them appears in package names that
 * are not a telemetry vendor — `vite-plugin-telemetry`, `sentry-testkit`,
 * and this repo's own `@miden-sdk/telemetry-*` bindings — and a guard that
 * fires on those is a guard someone deletes.
 */
const VENDOR_NAME_TOKENS = new Set([
  "posthog",
  "mixpanel",
  "logrocket",
  "bugsnag",
  "rollbar",
  "fullstory",
  "newrelic",
]);

/** Fields whose contents ship to a consumer that installs the core. */
const SHIPPED_DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

const ALL_DEPENDENCY_FIELDS = [...SHIPPED_DEPENDENCY_FIELDS, "devDependencies"];

function splitPackageName(name) {
  const scoped = /^(@[^/]+)\/(.+)$/.exec(name);
  return scoped
    ? { scope: scoped[1], local: scoped[2] }
    : { scope: null, local: name };
}

/**
 * Split a package name into whole tokens on the separators npm names
 * actually use. The character class is spelled out rather than leaning on a
 * `\b` anchor: `\b` finds no boundary between a letter and an underscore, so
 * `/\bposthog\b/` does not match `posthog_js`.
 */
function nameTokens(local) {
  return local.split(/[-_.]+/).filter(Boolean);
}

/**
 * Decide whether an extracted package NAME belongs to a telemetry vendor.
 *
 * Takes a name, never a line of source: matching raw manifest or source text
 * would fire on a comment or a description string, and a guard with false
 * positives does not survive contact with the next contributor.
 */
function isTelemetryPackage(name) {
  const lower = name.toLowerCase();
  if (VENDOR_PACKAGES.has(lower)) return true;
  const { scope, local } = splitPackageName(lower);
  if (scope !== null) return VENDOR_SCOPES.has(scope);
  return nameTokens(local).some((token) => VENDOR_NAME_TOKENS.has(token));
}

/** Package names declared under one manifest field. */
function declaredNames(manifest, field) {
  const value = manifest[field];
  // `bundledDependencies` is an array of names; the rest are objects.
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.keys(value);
  return [];
}

/** Offending declarations as `field: name`, so a failure names both. */
function telemetryOffenders(manifest, fields) {
  return fields.flatMap((field) =>
    declaredNames(manifest, field)
      .filter(isTelemetryPackage)
      .map((name) => `${field}: ${name}`)
  );
}

function why(headline, ...rest) {
  return [headline, ...rest].join("\n");
}

describe("the core package declares no telemetry dependency", () => {
  it("guards the core manifest, and no other package's", () => {
    // If this file is ever copied or the manifest moves, the guard must stop
    // rather than silently pass over some other package's dependencies.
    expect(
      CORE_MANIFEST_PATH.endsWith("crates/web-client/package.json"),
      why(
        `The manifest under guard should be crates/web-client/package.json,`,
        `but resolved to ${CORE_MANIFEST_PATH}.`
      )
    ).toBe(true);
    expect(
      coreManifest.name,
      why(
        `The manifest at ${CORE_MANIFEST_PATH} is not the core SDK.`,
        `Every assertion in this file is scoped to ${CORE_PACKAGE_NAME}; if the`,
        `core moved, point the guard at its new home rather than deleting it.`
      )
    ).toBe(CORE_PACKAGE_NAME);
  });

  it("declares no telemetry vendor in any field that ships", () => {
    const offenders = telemetryOffenders(
      coreManifest,
      SHIPPED_DEPENDENCY_FIELDS
    );
    expect(
      offenders,
      why(
        `${CORE_PACKAGE_NAME} declares a telemetry vendor: ${offenders.join(", ")}`,
        `The core is the package wallets bundle. A vendor declared here — as a`,
        `regular, peer, optional or bundled dependency alike — reaches every`,
        `consumer's tree, and the SDK can no longer claim it is incapable of`,
        `sending anything anywhere. Vendors belong in an opt-in binding package`,
        `under packages/telemetry-*, which a consumer installs deliberately.`
      )
    ).toEqual([]);
  });

  it("declares no telemetry vendor as a devDependency either", () => {
    const offenders = telemetryOffenders(coreManifest, ["devDependencies"]);
    expect(
      offenders,
      why(
        `${CORE_PACKAGE_NAME} declares a telemetry vendor in devDependencies:`,
        `${offenders.join(", ")}`,
        `A devDependency does not ship on install, but it is resolvable from`,
        `js/ and from the rollup build, so it is one import away from shipping`,
        `inside dist/. Keep the vendor out of the core entirely.`
      )
    ).toEqual([]);
  });

  it("inspects every field that reaches a consumer", () => {
    // Applies the real offender scan to a synthetic manifest declaring a
    // vendor in each shipping field in turn. The field list is spelled out
    // again here rather than read from SHIPPED_DEPENDENCY_FIELDS on purpose:
    // driving the check from the list it is checking would pass happily with
    // an entry deleted, and the real manifest declares neither
    // peerDependencies nor optionalDependencies today, so nothing else would
    // notice for as long as that stays true.
    const INSTALLED_FIELDS = [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundledDependencies",
      "bundleDependencies",
    ];
    for (const field of INSTALLED_FIELDS) {
      const bundled = field.toLowerCase().startsWith("bundle");
      const synthetic = {
        name: CORE_PACKAGE_NAME,
        [field]: bundled
          ? ["@sentry/browser"]
          : { "@sentry/browser": "^8.0.0" },
      };
      expect(
        telemetryOffenders(synthetic, SHIPPED_DEPENDENCY_FIELDS),
        why(
          `A vendor declared under "${field}" goes unreported.`,
          `That field installs into a consumer just like "dependencies", so`,
          `the scan has to read it whether or not the core uses it today.`
        )
      ).toEqual([`${field}: @sentry/browser`]);
    }
  });

  it("covers every dependency field the manifest actually uses", () => {
    // Stops the guard from going stale if a new kind of dependency field
    // appears: the fields checked above must be a superset of what is there.
    const present = Object.keys(coreManifest).filter((key) =>
      /[Dd]ependencies$/.test(key)
    );
    const unchecked = present.filter(
      (field) => !ALL_DEPENDENCY_FIELDS.includes(field)
    );
    expect(
      unchecked,
      why(
        `${CORE_PACKAGE_NAME} declares dependencies in a field this guard does`,
        `not read: ${unchecked.join(", ")}. Add it to ALL_DEPENDENCY_FIELDS —`,
        `an unread field is a hole a telemetry vendor fits through.`
      )
    ).toEqual([]);
  });
});

describe("the telemetry classifier", () => {
  // Self-tests. Without them the guard above passes just as happily with an
  // emptied vendor list, and nobody finds out until a vendor has shipped.

  it("flags a vendor scope whatever the local name is", () => {
    for (const name of [
      "@sentry/browser",
      "@sentry/react",
      "@sentry-internal/tracing",
      "@opentelemetry/api",
      "@opentelemetry/sdk-trace-web",
      "@datadog/browser-rum",
      "@amplitude/analytics-browser",
      "@segment/analytics-next",
      "@posthog/react",
    ]) {
      expect(isTelemetryPackage(name), `${name} should be flagged`).toBe(true);
    }
  });

  it("flags unscoped vendor packages", () => {
    for (const name of [
      "posthog-js",
      "mixpanel-browser",
      "amplitude-js",
      "logrocket",
      "rollbar",
      "raven-js",
      "analytics-node",
      "@vercel/analytics",
      "@fullstory/browser",
    ]) {
      expect(isTelemetryPackage(name), `${name} should be flagged`).toBe(true);
    }
  });

  it("flags a vendor token however it is separated", () => {
    // The underscore case is the one a `\b`-anchored regex misses: `_` is a
    // word character, so `/\bposthog\b/` finds no boundary in `posthog_js`.
    expect(/\bposthog\b/.test("posthog_js")).toBe(false);
    for (const name of ["posthog_js", "posthog.js", "posthog-node"]) {
      expect(isTelemetryPackage(name), `${name} should be flagged`).toBe(true);
    }
  });

  it("ignores case", () => {
    for (const name of ["@Sentry/Browser", "PostHog-JS"]) {
      expect(isTelemetryPackage(name), `${name} should be flagged`).toBe(true);
    }
  });

  it("leaves the first-party binding packages alone", () => {
    // Plan tasks 5 and 6 add these. They name a vendor in their own
    // peerDependencies, which is the whole point of an opt-in binding, and
    // this guard must never be the reason someone cannot land them.
    for (const name of [
      "@miden-sdk/telemetry-sentry",
      "@miden-sdk/telemetry-otel",
      "@miden-sdk/miden-sdk",
      "@miden-sdk/react",
      "@miden-sdk/vite-plugin",
    ]) {
      expect(isTelemetryPackage(name), `${name} should not be flagged`).toBe(
        false
      );
    }
  });

  it("does not flag a name that merely mentions the subject", () => {
    for (const name of [
      "vite-plugin-telemetry",
      "telemetry-utils",
      "observability",
      "web-vitals",
      "performance-now",
      "@acme/opentelemetry-shim",
      "@acme/sentry-testkit",
    ]) {
      expect(isTelemetryPackage(name), `${name} should not be flagged`).toBe(
        false
      );
    }
  });

  it("does not flag anything the core already depends on", () => {
    const declared = ALL_DEPENDENCY_FIELDS.flatMap((field) =>
      declaredNames(coreManifest, field)
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(
        isTelemetryPackage(name),
        why(
          `The classifier flags ${name}, an existing core dependency.`,
          `If the check above is failing too, a vendor really did land in the`,
          `core and that is the failure to read. If this is the only failure,`,
          `the matching rules have grown broad enough to catch an innocent`,
          `package — narrow them before anyone starts ignoring this file.`
        )
      ).toBe(false);
    }
  });
});

/**
 * `observability.test.js` already greps the module's text for five egress
 * primitives, and over a module this small that bluntness is a feature —
 * even a comment mentioning `fetch` fails it. What follows complements it
 * rather than repeating it, by parsing the module and asserting properties
 * text matching cannot express: that it imports nothing, reaches for no
 * global object, builds no code at runtime, constructs nothing, and calls
 * exactly one function.
 *
 * Each check is a function of source text, so the checks are themselves
 * testable: the synthetic cases below prove a check still detects what it
 * claims to. Without those, emptying any of these lists would leave a guard
 * that passes forever and catches nothing.
 */

/** The module-local binding holding the consumer's callback. */
const OBSERVER_BINDING = "currentObserver";

const GLOBAL_OBJECTS = ["globalThis", "window", "self", "global", "process"];

const CODE_EVALUATORS = ["eval", "Function"];

const EGRESS_PRIMITIVES = [
  // The five observability.test.js also matches textually.
  "fetch",
  "XMLHttpRequest",
  "sendBeacon",
  "WebSocket",
  "EventSource",
  // And the ones it does not.
  "WebTransport",
  "RTCPeerConnection",
  "RTCDataChannel",
  "navigator",
  "importScripts",
  "Worker",
  "SharedWorker",
  "ServiceWorker",
  "BroadcastChannel",
  "Image",
  "Request",
  "Response",
  "Headers",
];

function analyse(source) {
  const sourceFile = ts.createSourceFile(
    "module.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const imports = [];
  const calls = [];
  const constructions = [];
  const names = new Set();

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      imports.push(node.moduleSpecifier.getText(sourceFile));
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        imports.push(node.arguments[0]?.getText(sourceFile) ?? "<computed>");
      } else {
        calls.push(node.expression.getText(sourceFile));
      }
    }
    if (ts.isNewExpression(node)) {
      constructions.push(node.expression.getText(sourceFile));
    }
    // Every identifier, wherever it sits. The member in `navigator.sendBeacon`
    // and the source name in `const { fetch: send } = globalThis` are both
    // identifier nodes, so an alias is seen under the name it really binds.
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { imports, calls, constructions, names };
}

const importsIn = (source) => analyse(source).imports;

const constructionsIn = (source) => analyse(source).constructions;

const globalsIn = (source) =>
  GLOBAL_OBJECTS.filter((name) => analyse(source).names.has(name));

const evaluatorsIn = (source) => {
  const { calls, constructions } = analyse(source);
  return [...calls, ...constructions].filter((callee) =>
    CODE_EVALUATORS.includes(callee)
  );
};

const egressPrimitivesIn = (source) =>
  EGRESS_PRIMITIVES.filter((name) => analyse(source).names.has(name));

const foreignCallsIn = (source) =>
  analyse(source).calls.filter((callee) => callee !== OBSERVER_BINDING);

describe("the core observability module has no network capability", () => {
  const moduleSource = readFileSync(OBSERVABILITY_MODULE_PATH, "utf8");

  it("parses as the module it is meant to guard", () => {
    // A path that stopped resolving to the observability module, or a parse
    // that yielded nothing, would make every check below pass vacuously.
    expect(
      analyse(moduleSource).names.has("emitObservation"),
      why(
        `Parsed ${OBSERVABILITY_MODULE_PATH} without finding emitObservation.`,
        `Everything below is only meaningful if this really is the`,
        `observability module and it really parsed.`
      )
    ).toBe(true);
  });

  it("imports nothing at all", () => {
    const imports = importsIn(moduleSource);
    expect(
      imports,
      why(
        `observability.js imports ${imports.join(", ")}.`,
        `The module is deliberately dependency-free, so its capabilities are`,
        `exactly what it can reach with no import: nothing. An import is how`,
        `a transport arrives — directly, or by way of a module that has one.`,
        `If one is genuinely needed, prove here that what it pulls in cannot`,
        `reach the network rather than dropping this check.`
      )
    ).toEqual([]);
  });

  it("reaches for no global object", () => {
    const globals = globalsIn(moduleSource);
    expect(
      globals,
      why(
        `observability.js references ${globals.join(", ")}.`,
        `Every egress primitive hangs off a global object, and a computed`,
        `access such as globalThis["fet" + "ch"] defeats any check that looks`,
        `for the primitive by name. Touching no global at all is what makes`,
        `the rest of these checks worth anything.`
      )
    ).toEqual([]);
  });

  it("builds no code at runtime", () => {
    const evaluators = evaluatorsIn(moduleSource);
    expect(
      evaluators,
      why(
        `observability.js evaluates constructed code via`,
        `${evaluators.join(", ")}. Code assembled from strings escapes every`,
        `other check here: it can name any global and reach any primitive`,
        `without either appearing in the source.`
      )
    ).toEqual([]);
  });

  it("names no egress primitive anywhere in its syntax", () => {
    const found = egressPrimitivesIn(moduleSource);
    expect(
      found,
      why(
        `observability.js names the egress primitive(s) ${found.join(", ")}.`,
        `The SDK hands an observation to the consumer's callback and stops`,
        `there. It must not be able to send one anywhere itself — that is the`,
        `guarantee a wallet repeats to its own users.`
      )
    ).toEqual([]);
  });

  it("constructs nothing", () => {
    const constructions = constructionsIn(moduleSource);
    expect(
      constructions,
      why(
        `observability.js constructs ${constructions.join(", ")}.`,
        `A transport is nearly always a constructed object — new WebSocket,`,
        `new XMLHttpRequest, new Image. This module needs none, so it builds`,
        `none.`
      )
    ).toEqual([]);
  });

  it("calls nothing but the observer the consumer registered", () => {
    const foreign = foreignCallsIn(moduleSource);
    expect(
      foreign,
      why(
        `observability.js calls ${foreign.join(", ")}.`,
        `Delivery is meant to be one thing: invoke the callback the consumer`,
        `registered, synchronously, and return. Anything else called from`,
        `here — a scheduler, a serialiser, a storage write — is the start of a`,
        `transport, and buffering would break the synchronous-delivery`,
        `guarantee emitObservation is tested on as well.`
      )
    ).toEqual([]);
  });

  it("still calls the observer at all", () => {
    // Positive control: without it, deleting the delivery call would satisfy
    // every check above.
    expect(
      analyse(moduleSource).calls,
      why(
        `observability.js no longer calls ${OBSERVER_BINDING}.`,
        `Delivering to the registered observer is the module's entire job. If`,
        `the call was renamed or moved, move this guard with it.`
      )
    ).toContain(OBSERVER_BINDING);
  });
});

describe("the capability checks detect what they claim to", () => {
  it("detects a static import", () => {
    expect(importsIn(`import { request } from "node:https";`)).toEqual([
      `"node:https"`,
    ]);
    expect(importsIn(`export * from "./transport.js";`)).toEqual([
      `"./transport.js"`,
    ]);
  });

  it("detects a dynamic import", () => {
    expect(
      importsIn(`async function send() { await import("node:https"); }`)
    ).toEqual([`"node:https"`]);
  });

  it("detects a global reference behind a computed lookup", () => {
    // The case that motivates the globals check: no egress primitive is
    // named anywhere, so a name-based check sees nothing at all.
    const smuggled = `const send = globalThis["fet" + "ch"];`;
    expect(egressPrimitivesIn(smuggled)).toEqual([]);
    expect(globalsIn(smuggled)).toEqual(["globalThis"]);
    expect(globalsIn(`const w = window; const p = process.env;`)).toEqual([
      "window",
      "process",
    ]);
  });

  it("detects runtime code construction", () => {
    expect(evaluatorsIn(`eval(payload);`)).toEqual(["eval"]);
    expect(evaluatorsIn(`const f = new Function("o", "return o");`)).toEqual([
      "Function",
    ]);
  });

  it("detects an egress primitive", () => {
    expect(egressPrimitivesIn(`fetch("https://example.test");`)).toEqual([
      "fetch",
    ]);
    expect(egressPrimitivesIn(`navigator.sendBeacon("/i", body);`)).toEqual([
      "sendBeacon",
      "navigator",
    ]);
    expect(egressPrimitivesIn(`const { fetch: send } = globalThis;`)).toEqual([
      "fetch",
    ]);
  });

  it("detects a construction", () => {
    expect(
      constructionsIn(`const s = new WebSocket("wss://example.test");`)
    ).toEqual(["WebSocket"]);
    expect(constructionsIn(`new Image().src = url;`)).toEqual(["Image"]);
  });

  it("detects a call that is not the observer", () => {
    expect(foreignCallsIn(`setTimeout(() => currentObserver(o), 0);`)).toEqual([
      "setTimeout",
    ]);
    expect(
      foreignCallsIn(`localStorage.setItem("o", JSON.stringify(o));`)
    ).toEqual(["localStorage.setItem", "JSON.stringify"]);
    expect(foreignCallsIn(`currentObserver(observation);`)).toEqual([]);
  });

  it("does not fire on a primitive named only in prose", () => {
    // Where this check parts company with the textual one in
    // observability.test.js: that guard fails on any mention at all, which
    // suits a module this small; this one answers a different question —
    // what the module can actually do — so a name that is only discussed
    // rather than used is not a capability.
    const prose = `
      // This module deliberately does not fetch, and never opens a WebSocket.
      const documentation = "XMLHttpRequest is not used here";
      export function noop() {}
    `;
    expect(egressPrimitivesIn(prose)).toEqual([]);
    expect(foreignCallsIn(prose)).toEqual([]);
  });
});
