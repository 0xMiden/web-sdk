import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Standing guard over the four properties that make this package safe to
 * depend on:
 *
 *   1. OpenTelemetry is a peer concern. It is never a hard dependency, so
 *      installing this binding never drags a vendor into a consumer's tree,
 *      and the consumer keeps sole ownership of their OTel version — which
 *      matters more here than for most vendors, since an `@opentelemetry/api`
 *      resolved twice registers two global providers.
 *   2. The core SDK is a peer too. A binding that took `@miden-sdk/miden-sdk`
 *      as a regular dependency would resolve a second copy alongside the
 *      consumer's own, and the two would disagree about every type it hands
 *      across.
 *   3. The binding has no transport of its own. It hands data to the tracer it
 *      was given and stops there — it cannot reach the network, and it does
 *      not build, register, or configure a tracer provider or an exporter.
 *   4. The published surface resolves. `exports`, `types`, and `files` have to
 *      be right or `publint` and `attw` fail, and a consumer gets a package
 *      whose types silently do not load.
 *
 * These are properties of the package as shipped, so they are asserted
 * against the manifest and the module text rather than against behaviour.
 * Every check below is a function of its input, and each is exercised on a
 * synthetic case further down: without that, emptying any of the vendor lists
 * would leave a guard that passes forever and catches nothing.
 */

const PACKAGE_NAME = "@miden-sdk/telemetry-otel";
const CORE_PACKAGE_NAME = "@miden-sdk/miden-sdk";

const MANIFEST_PATH = fileURLToPath(
  new URL("../../package.json", import.meta.url)
);
const README_PATH = fileURLToPath(new URL("../../README.md", import.meta.url));
const MODULE_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

type Manifest = {
  name?: string;
  version?: string;
  description?: string;
  type?: string;
  types?: string;
  main?: string;
  module?: string;
  license?: string;
  files?: string[];
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
} & Record<string, unknown>;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const moduleSource = readFileSync(MODULE_PATH, "utf8");

function why(headline: string, ...rest: string[]) {
  return [headline, ...rest].join("\n");
}

/**
 * Scopes a telemetry vendor owns outright. Matched on the scope alone, never
 * on the local name, so this package's own name can never match its own
 * guard — the same rule the core's guard uses, for the same reason.
 */
const VENDOR_SCOPES = new Set([
  "@opentelemetry",
  "@opentelemetry-internal",
  "@sentry",
  "@sentry-internal",
  "@datadog",
  "@amplitude",
  "@segment",
  "@newrelic",
  "@bugsnag",
  "@honeycombio",
  "@posthog",
  "@highlight-run",
]);

/** Vendors that publish unscoped, or under a scope shared with others. */
const VENDOR_PACKAGES = new Set([
  "opentelemetry",
  "opentelemetry-instrumentation-fetch",
  "posthog-js",
  "posthog-node",
  "mixpanel",
  "mixpanel-browser",
  "amplitude-js",
  "analytics-node",
  "logrocket",
  "rollbar",
  "raven",
  "raven-js",
  "newrelic",
  "bugsnag-js",
  "@fullstory/browser",
  "@vercel/analytics",
  "@grafana/faro-web-sdk",
  "@microsoft/applicationinsights-web",
]);

function isTelemetryVendor(name: string) {
  const lower = name.toLowerCase();
  if (VENDOR_PACKAGES.has(lower)) return true;
  const scoped = /^(@[^/]+)\/.+$/.exec(lower);
  return scoped !== null && VENDOR_SCOPES.has(scoped[1]!);
}

/**
 * Fields that install into a consumer's tree. `peerDependencies` is
 * deliberately absent: a peer is a declaration that the consumer supplies the
 * package themselves, which is exactly the arrangement this binding wants.
 */
const HARD_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

const ALL_DEPENDENCY_FIELDS = [
  ...HARD_DEPENDENCY_FIELDS,
  "peerDependencies",
  "devDependencies",
];

function declaredNames(source: Manifest, field: string): string[] {
  const value = source[field];
  if (Array.isArray(value)) return value as string[];
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/** Offending declarations as `field: name`, so a failure names both. */
function vendorOffenders(source: Manifest, fields: string[]) {
  return fields.flatMap((field) =>
    declaredNames(source, field)
      .filter(isTelemetryVendor)
      .map((name) => `${field}: ${name}`)
  );
}

describe("the binding keeps its vendor at arm's length", () => {
  it("guards this package's manifest, and no other", () => {
    // If this file is copied, or the manifest moves, the guard must stop
    // rather than quietly pass over some other package's dependencies.
    expect(
      manifest.name,
      why(
        `The manifest at ${MANIFEST_PATH} is not ${PACKAGE_NAME}.`,
        `Every assertion in this file is scoped to that package; if it moved,`,
        `point the guard at its new home rather than deleting it.`
      )
    ).toBe(PACKAGE_NAME);
  });

  it("declares no telemetry vendor as a hard dependency", () => {
    const offenders = vendorOffenders(manifest, HARD_DEPENDENCY_FIELDS);
    expect(
      offenders,
      why(
        `${PACKAGE_NAME} takes a hard dependency on a vendor: ${offenders.join(", ")}`,
        `OpenTelemetry is the consumer's to own. Declared here as a regular,`,
        `optional or bundled dependency, it installs into their tree on our`,
        `schedule and at our version — and a second \`@opentelemetry/api\` in`,
        `a tree is not merely duplication: each copy carries its own global`,
        `provider registration, so spans start disappearing into whichever`,
        `one lost. A peer declaration is the most this package may ever state.`
      )
    ).toEqual([]);
  });

  it("does not depend on OpenTelemetry even to build or test", () => {
    // Structural typing is what keeps the vendor out. A devDependency would
    // not ship, but it would make `import { trace } from "@opentelemetry/api"`
    // resolve, and the first person to reach for it would not be stopped.
    const offenders = vendorOffenders(manifest, ["devDependencies"]);
    expect(
      offenders,
      why(
        `${PACKAGE_NAME} declares a vendor in devDependencies:`,
        `${offenders.join(", ")}`,
        `The binding is defined against a \`startSpan\` shape precisely so it`,
        `needs no vendor to build against. Keep it that way — an import that`,
        `resolves is an import someone writes.`
      )
    ).toEqual([]);
  });

  it("takes the core SDK as a peer and not as a dependency", () => {
    const peers = declaredNames(manifest, "peerDependencies");
    expect(
      peers,
      why(
        `${PACKAGE_NAME} does not declare ${CORE_PACKAGE_NAME} as a peer.`,
        `The binding is meaningless without the SDK that emits the`,
        `observations, and it must bind to the consumer's copy.`
      )
    ).toContain(CORE_PACKAGE_NAME);
    expect(
      declaredNames(manifest, "dependencies"),
      why(
        `${PACKAGE_NAME} depends on ${CORE_PACKAGE_NAME} directly.`,
        `That resolves a second copy of the SDK beside the consumer's own.`,
        `Two copies means two observation types, two module registries, and`,
        `an observer wired to a client that is not the one being observed.`
      )
    ).not.toContain(CORE_PACKAGE_NAME);
  });

  it("pins the peer range to a released core version", () => {
    // `workspace:*` is rewritten on publish for a dependency, but a peer
    // range that survived as a literal would be uninstallable off the
    // monorepo, so it is spelled as a real range here.
    const peer = (
      manifest.peerDependencies as Record<string, string> | undefined
    )?.[CORE_PACKAGE_NAME];
    expect(
      peer,
      why(
        `${CORE_PACKAGE_NAME} is declared as a peer at "${peer}".`,
        `A published peer range has to mean something to a consumer's package`,
        `manager, so it cannot be a workspace protocol string.`
      )
    ).toMatch(/^[\^~]?\d+\.\d+\.\d+/);
  });

  it("reads every dependency field a package manager installs from", () => {
    // Spelled out independently of HARD_DEPENDENCY_FIELDS on purpose. The
    // synthetic-case test further down iterates that list, so dropping a
    // field would shrink the test along with the guard and still pass — and
    // this manifest declares none of those fields, so nothing else would
    // notice either.
    expect([...HARD_DEPENDENCY_FIELDS].sort()).toEqual([
      "bundleDependencies",
      "bundledDependencies",
      "dependencies",
      "optionalDependencies",
    ]);
  });

  it("covers every dependency field the manifest actually uses", () => {
    const present = Object.keys(manifest).filter((key) =>
      /[Dd]ependencies$/.test(key)
    );
    const unchecked = present.filter(
      (field) => !ALL_DEPENDENCY_FIELDS.includes(field)
    );
    expect(
      unchecked,
      why(
        `${PACKAGE_NAME} declares dependencies in a field this guard does not`,
        `read: ${unchecked.join(", ")}. An unread field is a hole a vendor`,
        `fits through.`
      )
    ).toEqual([]);
  });
});

/**
 * Capability analysis of the module text. The argument is not "we looked for
 * a transport and did not find one" — it is that the module reaches for no
 * global, imports nothing at runtime, builds no code, and constructs nothing
 * but an error. A module that can do none of those things cannot open a
 * socket regardless of what it was trying to do, so the only thing it can
 * possibly do with an observation is pass it to the tracer it was handed.
 */

const GLOBAL_OBJECTS = ["globalThis", "window", "self", "global", "process"];

const CODE_EVALUATORS = ["eval", "Function"];

const EGRESS_PRIMITIVES = [
  "fetch",
  "XMLHttpRequest",
  "sendBeacon",
  "WebSocket",
  "EventSource",
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

/** Constructors the module is allowed to use. Errors carry nothing anywhere. */
const PERMITTED_CONSTRUCTIONS = ["TypeError", "Error", "RangeError"];

interface Analysis {
  valueImports: string[];
  typeImports: string[];
  calls: string[];
  constructions: string[];
  names: Set<string>;
}

function analyse(source: string): Analysis {
  const sourceFile = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const valueImports: string[] = [];
  const typeImports: string[] = [];
  const calls: string[] = [];
  const constructions: string[] = [];
  const names = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier.getText(sourceFile);
      // `import type` is erased before anything runs, so it grants the module
      // no capability at all. A value import of the same module would.
      if (node.importClause?.isTypeOnly) typeImports.push(specifier);
      else valueImports.push(specifier);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier.getText(sourceFile);
      if (node.isTypeOnly) typeImports.push(specifier);
      else valueImports.push(specifier);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        valueImports.push(
          node.arguments[0]?.getText(sourceFile) ?? "<computed>"
        );
      } else {
        calls.push(node.expression.getText(sourceFile));
      }
    }
    if (ts.isNewExpression(node)) {
      constructions.push(node.expression.getText(sourceFile));
    }
    // Every identifier, wherever it sits — the member in `navigator.sendBeacon`
    // and the source name in `const { fetch: send } = globalThis` are both
    // identifiers, so an alias is seen under the name it really binds.
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { valueImports, typeImports, calls, constructions, names };
}

const valueImportsIn = (source: string) => analyse(source).valueImports;
const typeImportsIn = (source: string) => analyse(source).typeImports;
const callsIn = (source: string) => analyse(source).calls;

const globalsIn = (source: string) =>
  GLOBAL_OBJECTS.filter((name) => analyse(source).names.has(name));

const evaluatorsIn = (source: string) => {
  const { calls, constructions } = analyse(source);
  return [...calls, ...constructions].filter((callee) =>
    CODE_EVALUATORS.includes(callee)
  );
};

const egressPrimitivesIn = (source: string) =>
  EGRESS_PRIMITIVES.filter((name) => analyse(source).names.has(name));

const disallowedConstructionsIn = (source: string) =>
  analyse(source).constructions.filter(
    (name) => !PERMITTED_CONSTRUCTIONS.includes(name)
  );

/**
 * Calls that would mean the binding had taken over the consumer's tracing
 * setup — building a provider, registering it globally, reaching for the
 * global tracer instead of the one it was handed, or driving an exporter.
 */
const providerSetupIn = (source: string) =>
  callsIn(source).filter((callee) =>
    /(^|\.)(init|setup|register|registerInstrumentations|getTracer|getTracerProvider|setGlobalTracerProvider|addSpanProcessor|forceFlush|shutdown)$/.test(
      callee
    )
  );

describe("the binding transports nothing itself", () => {
  it("parses as the module it is meant to guard", () => {
    // A path that stopped resolving, or a parse that yielded nothing, would
    // make every check below pass vacuously.
    expect(
      analyse(moduleSource).names.has("createOtelObserver"),
      why(
        `Parsed ${MODULE_PATH} without finding createOtelObserver.`,
        `Everything below is only meaningful if this really is the binding`,
        `and it really parsed.`
      )
    ).toBe(true);
  });

  it("imports no value at runtime", () => {
    const imports = valueImportsIn(moduleSource);
    expect(
      imports,
      why(
        `The binding imports ${imports.join(", ")} at runtime.`,
        `Its only import is a type, which is erased before anything executes,`,
        `so the module's capabilities are exactly what it can reach with no`,
        `import: nothing. A value import is how a transport arrives —`,
        `directly, or by way of a module that has one.`
      )
    ).toEqual([]);
  });

  it("takes the observation type from the core SDK, as a type only", () => {
    // Positive control. Without it, deleting the import would satisfy the
    // check above and the binding would quietly stop being typed against the
    // SDK it exists to serve.
    expect(
      typeImportsIn(moduleSource),
      why(
        `The binding no longer imports a type from ${CORE_PACKAGE_NAME}.`,
        `Its whole contract is that it consumes the SDK's own observation`,
        `shape rather than a copy that can drift from it.`
      )
    ).toContain(`"${CORE_PACKAGE_NAME}"`);
  });

  it("names no OpenTelemetry module anywhere", () => {
    const mentioned = [
      ...valueImportsIn(moduleSource),
      ...typeImportsIn(moduleSource),
    ].filter((specifier) => isTelemetryVendor(specifier.replace(/["']/g, "")));
    expect(
      mentioned,
      why(
        `The binding imports ${mentioned.join(", ")}.`,
        `It is defined against a structural \`startSpan\` shape so that no`,
        `version of OpenTelemetry is baked in — including for the one`,
        `constant it needs, \`SpanStatusCode.ERROR\`, which is inlined as the`,
        `wire value it has always had. An import here would make the vendor a`,
        `real dependency whatever the manifest says.`
      )
    ).toEqual([]);
  });

  it("reaches for no global object", () => {
    const globals = globalsIn(moduleSource);
    expect(
      globals,
      why(
        `The binding references ${globals.join(", ")}.`,
        `Every egress primitive hangs off a global, and a computed access such`,
        `as globalThis["fet" + "ch"] defeats any check that looks for the`,
        `primitive by name. Touching no global is what makes the rest of these`,
        `checks worth anything.`
      )
    ).toEqual([]);
  });

  it("builds no code at runtime", () => {
    const evaluators = evaluatorsIn(moduleSource);
    expect(
      evaluators,
      why(
        `The binding evaluates constructed code via ${evaluators.join(", ")}.`,
        `Code assembled from strings escapes every other check here: it can`,
        `name any global and reach any primitive without either appearing in`,
        `the source.`
      )
    ).toEqual([]);
  });

  it("names no egress primitive anywhere in its syntax", () => {
    const found = egressPrimitivesIn(moduleSource);
    expect(
      found,
      why(
        `The binding names the egress primitive(s) ${found.join(", ")}.`,
        `It hands an observation to the tracer the consumer configured and`,
        `stops there. An OTLP exporter is the consumer's to wire up; sending`,
        `spans anywhere itself would make this a second telemetry pipeline`,
        `that they never opted into and cannot see in their own config.`
      )
    ).toEqual([]);
  });

  it("constructs nothing but an error", () => {
    const constructions = disallowedConstructionsIn(moduleSource);
    expect(
      constructions,
      why(
        `The binding constructs ${constructions.join(", ")}.`,
        `A transport is nearly always a constructed object — new WebSocket,`,
        `new XMLHttpRequest, new OTLPTraceExporter — and a tracer provider is`,
        `one too. This package never builds one: the consumer owns their`,
        `provider, its processors, its exporters, and its sampling.`
      )
    ).toEqual([]);
  });

  it("registers no tracer provider and reaches for no global tracer", () => {
    const setup = providerSetupIn(moduleSource);
    expect(
      setup,
      why(
        `The binding calls ${setup.join(", ")}.`,
        `The tracer arrives as an argument, so there is never a reason to ask`,
        `for one: \`trace.getTracer()\` would silently bind to whatever`,
        `provider is registered globally instead of the one the consumer`,
        `passed, and registering a provider would take over an application's`,
        `tracing setup from inside a library.`
      )
    ).toEqual([]);
  });

  it("still hands the observation to the tracer it was given", () => {
    // Positive control for the whole section: without it, a binding that did
    // nothing whatsoever would satisfy every check above.
    const calls = callsIn(moduleSource);
    expect(
      calls,
      why(
        `The binding no longer calls tracer.startSpan.`,
        `Delegating to the consumer's tracer is its entire job. If the call`,
        `was renamed or moved, move this guard with it.`
      )
    ).toContain("tracer.startSpan");
    expect(
      calls,
      why(
        `The binding no longer calls span.end.`,
        `An unended span is never exported, so the whole observation is lost`,
        `— and the retroactive interval this package exists to reconstruct is`,
        `carried by the argument to that call.`
      )
    ).toContain("span.end");
  });
});

describe("the published surface resolves", () => {
  it("ships as an ES module", () => {
    expect(manifest.type).toBe("module");
  });

  it("points at built types and a built entry point", () => {
    const entry = manifest.exports?.["."] as Record<string, string> | undefined;
    expect(
      entry,
      why(
        `${PACKAGE_NAME} declares no "." export.`,
        `Without it, \`import { createOtelObserver } from "${PACKAGE_NAME}"\``,
        `does not resolve for anyone.`
      )
    ).toBeDefined();
    // `types` has to come first in the condition order or TypeScript resolves
    // `default` and reports the package as untyped — the exact drift `attw`
    // is run to catch.
    expect(Object.keys(entry!)[0]).toBe("types");
    expect(entry!.types).toBe("./dist/index.d.ts");
    expect(entry!.default).toBe("./dist/index.js");
    expect(manifest.types).toBe("dist/index.d.ts");
  });

  it("exposes its own manifest, as the sibling packages do", () => {
    expect(manifest.exports?.["./package.json"]).toBe("./package.json");
  });

  it("publishes the build output and the README, and nothing else", () => {
    expect(manifest.files).toEqual(["dist", "README.md"]);
  });

  it("can build the files it promises to publish", () => {
    expect(
      manifest.scripts?.build,
      why(
        `${PACKAGE_NAME} has no build script.`,
        `\`files\` promises a dist/ that nothing produces, so a publish would`,
        `ship an empty package.`
      )
    ).toBeTruthy();
  });

  it("carries the metadata a published package needs", () => {
    expect(manifest.description).toBeTruthy();
    expect(manifest.license).toBe("MIT");
    expect(manifest.version).toBeTruthy();
  });

  it("has a README to publish", () => {
    expect(
      existsSync(README_PATH),
      why(
        `${PACKAGE_NAME} lists README.md in "files" but has none.`,
        `It is the only documentation a consumer sees on npm, and this`,
        `package's behaviour — backdated spans, sensitive detail dropped —`,
        `is not guessable from the type signature.`
      )
    ).toBe(true);
  });

  it("documents the peer arrangement, the opt-in, and the backdating", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain(PACKAGE_NAME);
    expect(readme).toMatch(/peer/i);
    expect(readme).toContain("includeSensitive");
    expect(readme).toContain("observeSensitive");
    // A consumer reading a trace will see a span that started before the
    // process was told about it. Unexplained, that looks like a clock bug.
    expect(readme).toMatch(/retroactive|backdat/i);
  });
});

describe("the boundary checks detect what they claim to", () => {
  it("detects a vendor in each hard dependency field", () => {
    for (const field of HARD_DEPENDENCY_FIELDS) {
      const bundled = field.toLowerCase().startsWith("bundle");
      const synthetic: Manifest = {
        name: PACKAGE_NAME,
        [field]: bundled
          ? ["@opentelemetry/api"]
          : { "@opentelemetry/api": "^1.9.0" },
      };
      expect(
        vendorOffenders(synthetic, HARD_DEPENDENCY_FIELDS),
        why(
          `A vendor declared under "${field}" goes unreported.`,
          `That field installs into a consumer just like "dependencies", so`,
          `the scan has to read it whether or not this package uses it today.`
        )
      ).toEqual([`${field}: @opentelemetry/api`]);
    }
  });

  it("treats a peer declaration as acceptable", () => {
    // The distinction the whole package rests on: a peer says the consumer
    // brings their own, a dependency says we bring ours.
    const synthetic: Manifest = {
      name: PACKAGE_NAME,
      peerDependencies: { "@opentelemetry/api": "^1.9.0" },
    };
    expect(vendorOffenders(synthetic, HARD_DEPENDENCY_FIELDS)).toEqual([]);
  });

  it("classifies vendors by scope and this package by neither", () => {
    for (const name of [
      "@opentelemetry/api",
      "@opentelemetry/sdk-trace-web",
      "@opentelemetry/exporter-trace-otlp-http",
      "@sentry/browser",
      "posthog-js",
      "@vercel/analytics",
    ]) {
      expect(isTelemetryVendor(name), `${name} should be flagged`).toBe(true);
    }
    for (const name of [
      PACKAGE_NAME,
      CORE_PACKAGE_NAME,
      "@miden-sdk/telemetry-sentry",
      "@acme/otel-testkit",
      "vitest",
      "typescript",
    ]) {
      expect(isTelemetryVendor(name), `${name} should not be flagged`).toBe(
        false
      );
    }
  });

  it("does not flag anything this package already depends on", () => {
    // Scoped to the fields where a vendor is actually forbidden.
    // `peerDependencies` is excluded on purpose: naming a vendor there is
    // permitted, so scanning it here would make a legitimate peer
    // declaration fail this self-test, and the fix someone reaches for
    // first is to blunt the classifier that guards everything else.
    const declared = [...HARD_DEPENDENCY_FIELDS, "devDependencies"].flatMap(
      (field) => declaredNames(manifest, field)
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(
        isTelemetryVendor(name),
        why(
          `The classifier flags ${name}, an existing dependency of this`,
          `package. If the checks above are failing too, a vendor really did`,
          `land here. If this is the only failure, the matching rules have`,
          `grown broad enough to catch an innocent package.`
        )
      ).toBe(false);
    }
  });

  it("tells a value import from a type import", () => {
    expect(
      valueImportsIn(`import { trace } from "@opentelemetry/api";`)
    ).toEqual([`"@opentelemetry/api"`]);
    expect(
      typeImportsIn(`import type { Span } from "@opentelemetry/api";`)
    ).toEqual([`"@opentelemetry/api"`]);
    expect(
      valueImportsIn(`import type { Span } from "@opentelemetry/api";`)
    ).toEqual([]);
    expect(
      valueImportsIn(
        `async function f() { await import("@opentelemetry/api"); }`
      )
    ).toEqual([`"@opentelemetry/api"`]);
  });

  it("detects a global reference behind a computed lookup", () => {
    const smuggled = `const send = globalThis["fet" + "ch"];`;
    expect(egressPrimitivesIn(smuggled)).toEqual([]);
    expect(globalsIn(smuggled)).toEqual(["globalThis"]);
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
  });

  it("detects a construction that is not an error", () => {
    expect(
      disallowedConstructionsIn(`const p = new NodeTracerProvider(config);`)
    ).toEqual(["NodeTracerProvider"]);
    expect(disallowedConstructionsIn(`throw new TypeError("bad");`)).toEqual(
      []
    );
  });

  it("detects provider setup and a reach for the global tracer", () => {
    expect(providerSetupIn(`provider.register();`)).toEqual([
      "provider.register",
    ]);
    expect(providerSetupIn(`const t = trace.getTracer("miden");`)).toEqual([
      "trace.getTracer",
    ]);
    expect(
      providerSetupIn(`provider.addSpanProcessor(new BatchSpanProcessor(e));`)
    ).toEqual(["provider.addSpanProcessor"]);
    // The binding's own calls must not trip it.
    expect(providerSetupIn(`span.end(endTime); Date.now();`)).toEqual([]);
  });
});
