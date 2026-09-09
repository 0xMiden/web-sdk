import { describe, it, expect, vi, afterEach } from "vitest";
import type { MidenObservation } from "@miden-sdk/miden-sdk";
import {
  createOtelObserver,
  type OtelObserverOptions,
  type SpanLike,
  type TracerLike,
} from "../index";

/**
 * A stand-in for the consumer's OpenTelemetry tracer. The binding is defined
 * against the `startSpan` shape rather than an `@opentelemetry/api` import,
 * so the double is the real contract and not an approximation of one.
 */
const fakeTracer = () => {
  const span = {
    setAttribute: vi.fn<SpanLike["setAttribute"]>(),
    setStatus: vi.fn<SpanLike["setStatus"]>(),
    end: vi.fn<SpanLike["end"]>(),
  };
  const startSpan = vi.fn<TracerLike["startSpan"]>(() => span);
  const tracer: TracerLike = { startSpan };
  return { tracer, startSpan, span };
};

type Fake = ReturnType<typeof fakeTracer>;

/** The last `startSpan` call, failing loudly if there wasn't one. */
const lastSpan = ({ startSpan }: Fake) => {
  const calls = startSpan.mock.calls;
  expect(
    calls.length,
    "expected the binding to have started at least one span"
  ).toBeGreaterThan(0);
  const [name, options] = calls[calls.length - 1]!;
  return { name, options };
};

/**
 * Attribute keys in the order they were recorded. Asserted as a list rather
 * than by stringifying the calls: a `setAttribute(key, undefined)` disappears
 * from a `JSON.stringify` comparison while a tracer still records the key and
 * the vendor UI still renders it as an empty row.
 */
const attributeKeys = ({ span }: Fake) =>
  span.setAttribute.mock.calls.map(([key]) => key);

const attributes = (fake: Fake) => {
  expect(
    attributeKeys(fake).length,
    "expected the binding to have recorded at least one attribute"
  ).toBeGreaterThan(0);
  return Object.fromEntries(fake.span.setAttribute.mock.calls) as Record<
    string,
    unknown
  >;
};

/** The attributes every observation carries, regardless of configuration. */
const BASE_ATTRIBUTES = ["miden.duration_ms", "miden.outcome"];

/**
 * An observation as the SDK delivers it by default: the `sensitive` key is
 * ABSENT, not present-and-undefined. Spelling it as a literal without the key
 * is the point — a test that passed `sensitive: undefined` would not exercise
 * the shape the SDK actually emits.
 */
const observation = (
  fields: Pick<MidenObservation, "op" | "outcome" | "durationMs">
): MidenObservation => ({ ...fields });

/** An observation from a client built with `observeSensitive: true`. */
const sensitiveObservation = (
  fields: Pick<MidenObservation, "op" | "outcome" | "durationMs">,
  sensitive: MidenObservation["sensitive"]
): MidenObservation => ({ ...fields, sensitive });

afterEach(() => {
  vi.useRealTimers();
});

describe("createOtelObserver", () => {
  it("returns an observer function", () => {
    const { tracer } = fakeTracer();
    expect(typeof createOtelObserver({ tracer })).toBe("function");
  });

  it("starts and ends a span named for the operation", () => {
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 30 })
    );

    expect(fake.startSpan).toHaveBeenCalledTimes(1);
    expect(lastSpan(fake).name).toBe("miden.syncState");
    expect(fake.span.end).toHaveBeenCalledTimes(1);
  });

  it("namespaces every operation it is given", () => {
    const fake = fakeTracer();
    const observe = createOtelObserver({ tracer: fake.tracer });

    for (const op of ["syncState", "proveTransaction", "submitTransaction"]) {
      observe(observation({ op, outcome: "ok", durationMs: 1 }));
    }

    expect(fake.startSpan.mock.calls.map(([name]) => name)).toEqual([
      "miden.syncState",
      "miden.proveTransaction",
      "miden.submitTransaction",
    ]);
  });

  it("records the duration as an attribute", () => {
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 30 })
    );

    expect(fake.span.setAttribute).toHaveBeenCalledWith(
      "miden.duration_ms",
      30
    );
  });

  it("records the outcome as an attribute", () => {
    const fake = fakeTracer();
    const observe = createOtelObserver({ tracer: fake.tracer });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 1 }));
    expect(attributes(fake)["miden.outcome"]).toBe("ok");

    observe(observation({ op: "syncState", outcome: "error", durationMs: 1 }));
    expect(attributes(fake)["miden.outcome"]).toBe("error");
  });

  it("marks a failed operation with an error status", () => {
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer })(
      observation({
        op: "proveTransaction",
        outcome: "error",
        durationMs: 21_000,
      })
    );

    expect(fake.span.setStatus).toHaveBeenCalledWith({ code: 2 });
  });

  it("leaves a successful operation's status unset", () => {
    // OpenTelemetry's UNSET is the correct status for a span that did not
    // fail. Setting ERROR here — or setting any status at all — would make
    // every successful client operation look like an incident.
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 1 })
    );

    expect(fake.span.end).toHaveBeenCalledTimes(1);
    expect(fake.span.setStatus).not.toHaveBeenCalled();
  });

  it("records every observation it is given", () => {
    const fake = fakeTracer();
    const observe = createOtelObserver({ tracer: fake.tracer });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 1 }));
    observe(observation({ op: "syncChain", outcome: "error", durationMs: 2 }));

    expect(fake.startSpan).toHaveBeenCalledTimes(2);
    expect(fake.span.end).toHaveBeenCalledTimes(2);
  });

  it("records synchronously and schedules nothing", async () => {
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 1 })
    );

    // Positive fact first: the span landed before the caller's next
    // statement, so the assertions below are about a real span and not a
    // span that never happened.
    expect(fake.startSpan).toHaveBeenCalledTimes(1);
    expect(fake.span.end).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.startSpan).toHaveBeenCalledTimes(1);
    expect(fake.span.end).toHaveBeenCalledTimes(1);
  });
});

describe("createOtelObserver backdates the span it could not hold open", () => {
  // The SDK reports an operation once it has finished, so there is never a
  // live span to wrap around the work. The span is reconstructed instead:
  // it ends at the instant the observation arrived and starts one duration
  // earlier, which is the interval the operation really occupied.

  it("starts the span one duration before the observation arrived", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T09:00:00.000Z"));
    const arrived = Date.now();
    const fake = fakeTracer();

    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 30 })
    );

    expect(lastSpan(fake).options).toEqual({ startTime: arrived - 30 });
  });

  it("ends the span at the instant the observation arrived", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T09:00:00.000Z"));
    const arrived = Date.now();
    const fake = fakeTracer();

    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 30 })
    );

    // Passed explicitly rather than left to the tracer's own clock: an
    // implicit end time drifts by however long recording the attributes
    // took, which would report a duration that disagrees with the
    // `miden.duration_ms` attribute on the same span.
    expect(fake.span.end).toHaveBeenCalledWith(arrived);
  });

  it("gives the span exactly the duration the SDK measured", () => {
    const fake = fakeTracer();
    const observe = createOtelObserver({ tracer: fake.tracer });

    for (const durationMs of [0, 1, 30, 21_000, 600_000]) {
      observe(
        observation({ op: "proveTransaction", outcome: "ok", durationMs })
      );
      const { startTime } = lastSpan(fake).options;
      const endTime = fake.span.end.mock.calls.at(-1)![0];
      expect(
        typeof endTime,
        "the end time has to be passed for the interval to be checkable"
      ).toBe("number");
      expect(endTime! - startTime).toBe(durationMs);
    }
  });

  it("treats a zero duration as a measurement, not as unmeasurable", () => {
    // An operation that finished inside a millisecond reports 0. That is a
    // real measurement, and must not be mistaken for a duration the binding
    // could not read — the attribute belongs on the span either way.
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 0 })
    );

    expect(attributeKeys(fake)).toEqual(BASE_ATTRIBUTES);
    expect(attributes(fake)["miden.duration_ms"]).toBe(0);
  });

  it("timestamps the span in epoch milliseconds", () => {
    // OpenTelemetry reads a numeric `TimeInput` below the process's time
    // origin as a `performance.now()` offset, so a high-resolution clock
    // would be silently reinterpreted into 1970.
    const fake = fakeTracer();
    const before = Date.now();

    createOtelObserver({ tracer: fake.tracer })(
      observation({ op: "syncState", outcome: "ok", durationMs: 0 })
    );

    const { startTime } = lastSpan(fake).options;
    expect(startTime).toBeGreaterThanOrEqual(before);
    expect(startTime).toBeLessThanOrEqual(Date.now());
  });

  it("reports no duration it cannot vouch for", () => {
    // A duration that is not a finite, non-negative number cannot describe
    // an interval. The operation still happened and its outcome still
    // matters, so the span is recorded — as an instant at the moment the
    // observation arrived, with no fabricated duration attached.
    const fake = fakeTracer();
    const observe = createOtelObserver({ tracer: fake.tracer });

    for (const durationMs of [
      NaN,
      Number.POSITIVE_INFINITY,
      -1,
      "30",
      undefined,
    ]) {
      fake.startSpan.mockClear();
      fake.span.setAttribute.mockClear();
      fake.span.end.mockClear();

      observe(
        observation({
          op: "syncState",
          outcome: "error",
          durationMs: durationMs as unknown as number,
        })
      );

      const label = `durationMs: ${String(durationMs)}`;
      expect(fake.startSpan, label).toHaveBeenCalledTimes(1);
      expect(fake.span.end, label).toHaveBeenCalledTimes(1);
      expect(attributeKeys(fake), label).toEqual(["miden.outcome"]);
      const { startTime } = lastSpan(fake).options;
      expect(fake.span.end.mock.calls[0]![0], label).toBe(startTime);
    }
  });
});

describe("createOtelObserver and the sensitive channel", () => {
  it("drops sensitive detail unless includeSensitive is set", () => {
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer })(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        { errorMessage: "mtst1secret" }
      )
    );

    expect(attributeKeys(fake)).toEqual(BASE_ATTRIBUTES);
    expect(Object.values(attributes(fake))).not.toContain("mtst1secret");
  });

  it("forwards the error message when includeSensitive is set", () => {
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer, includeSensitive: true })(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        { errorMessage: "mtst1secret" }
      )
    );

    expect(fake.span.setAttribute).toHaveBeenCalledWith(
      "miden.error_message",
      "mtst1secret"
    );
  });

  it("forwards the error stack when includeSensitive is set", () => {
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer, includeSensitive: true })(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        { errorMessage: "boom", errorStack: "at prove (miden.js:1)" }
      )
    );

    expect(attributes(fake)["miden.error_stack"]).toBe("at prove (miden.js:1)");
  });

  it("enables the sensitive channel only for a literal true", () => {
    // Mirrors the SDK's own handling of `observeSensitive`: a truthy value
    // that is not `true` must not be enough to disclose anything.
    for (const includeSensitive of [1, "true", {}, [], "yes"]) {
      const fake = fakeTracer();
      createOtelObserver({
        tracer: fake.tracer,
        includeSensitive: includeSensitive as unknown as boolean,
      })(
        sensitiveObservation(
          { op: "syncState", outcome: "error", durationMs: 1 },
          { errorMessage: "mtst1secret", accountId: "mtst1account" }
        )
      );

      const label = `includeSensitive: ${JSON.stringify(includeSensitive)}`;
      expect(attributeKeys(fake), label).toEqual(BASE_ATTRIBUTES);
    }
  });

  it("records an observation whose sensitive key is absent", () => {
    // The default shape. The span must still be recorded — dropping it
    // would make the binding useless to anyone who left `observeSensitive`
    // off, which is everyone by default.
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer, includeSensitive: true })(
      observation({ op: "syncState", outcome: "error", durationMs: 7 })
    );

    expect(fake.startSpan).toHaveBeenCalledTimes(1);
    expect(fake.span.end).toHaveBeenCalledTimes(1);
    expect(attributes(fake)["miden.duration_ms"]).toBe(7);
  });

  it("records no attribute at all in place of an absent sensitive key", () => {
    // The failure this guards against is reading `observation.sensitive`
    // without checking, which yields `undefined` and then records
    // `miden.error_message: undefined` (etc.) on every observation the SDK
    // emits by default. A stringify-based assertion would not notice: the
    // undefined disappears from the comparison while the tracer keeps the
    // key and the vendor UI renders it as an empty row.
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer, includeSensitive: true })(
      observation({ op: "syncState", outcome: "error", durationMs: 7 })
    );

    expect(attributeKeys(fake)).toEqual(BASE_ATTRIBUTES);
    expect(Object.values(attributes(fake))).not.toContain(undefined);
    for (const key of [
      "miden.error_message",
      "miden.error_stack",
      "miden.account_id",
      "miden.sensitive",
    ]) {
      expect(attributeKeys(fake), `${key} must not be recorded`).not.toContain(
        key
      );
    }
  });

  it("omits the account id the SDK declares but never populates", () => {
    // `MidenObservationSensitive.accountId` is declared optional and the
    // SDK does not populate it today, so a present `sensitive` object is
    // still normally missing the field. Its absence is the ordinary case.
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer, includeSensitive: true })(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        { errorMessage: "boom" }
      )
    );

    expect(attributeKeys(fake)).toEqual([
      ...BASE_ATTRIBUTES,
      "miden.error_message",
    ]);
    expect(Object.values(attributes(fake))).not.toContain(undefined);
  });

  it("omits an account id that is present but empty", () => {
    const fake = fakeTracer();
    const observe = createOtelObserver({
      tracer: fake.tracer,
      includeSensitive: true,
    });

    for (const accountId of [undefined, ""]) {
      fake.span.setAttribute.mockClear();
      observe(
        sensitiveObservation(
          { op: "syncState", outcome: "error", durationMs: 1 },
          { accountId }
        )
      );
      expect(
        attributeKeys(fake),
        `accountId: ${JSON.stringify(accountId)}`
      ).toEqual(BASE_ATTRIBUTES);
    }
  });

  it("forwards the account id when the SDK does populate it", () => {
    // The one binding that reads the field, per the plan. It has to work
    // the day the SDK starts populating it.
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer, includeSensitive: true })(
      sensitiveObservation(
        { op: "consume", outcome: "ok", durationMs: 4 },
        { accountId: "mtst1qqaccount" }
      )
    );

    expect(attributes(fake)["miden.account_id"]).toBe("mtst1qqaccount");
  });

  it("forwards only the fields it documents", () => {
    // The channel is read field by field rather than enumerated, so a
    // field the SDK adds later cannot start flowing to a vendor before
    // anyone has decided it should.
    const fake = fakeTracer();
    createOtelObserver({ tracer: fake.tracer, includeSensitive: true })(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        {
          errorMessage: "boom",
          seedPhrase: "correct horse battery staple",
        } as unknown as MidenObservation["sensitive"]
      )
    );

    expect(attributeKeys(fake)).toEqual([
      ...BASE_ATTRIBUTES,
      "miden.error_message",
    ]);
    expect(Object.values(attributes(fake))).not.toContain(
      "correct horse battery staple"
    );
  });

  it("tolerates a sensitive value that is not an object", () => {
    const fake = fakeTracer();
    const observe = createOtelObserver({
      tracer: fake.tracer,
      includeSensitive: true,
    });

    for (const sensitive of [null, "leaked", 7, true]) {
      fake.span.setAttribute.mockClear();
      observe(
        sensitiveObservation(
          { op: "syncState", outcome: "error", durationMs: 5 },
          sensitive as unknown as MidenObservation["sensitive"]
        )
      );
      expect(
        attributeKeys(fake),
        `sensitive: ${JSON.stringify(sensitive)}`
      ).toEqual(BASE_ATTRIBUTES);
    }
    expect(fake.span.end).toHaveBeenCalledTimes(4);
  });
});

describe("createOtelObserver never throws into the caller", () => {
  const anObservation = observation({
    op: "syncState",
    outcome: "error",
    durationMs: 1,
  });

  it("swallows a tracer that cannot start a span", () => {
    const tracer: TracerLike = {
      startSpan: () => {
        throw new Error("no tracer provider");
      },
    };

    expect(() => createOtelObserver({ tracer })(anObservation)).not.toThrow();
  });

  it("swallows a span that throws from any of its methods", () => {
    const boom = () => {
      throw new Error("span is detached");
    };

    for (const method of ["setAttribute", "setStatus", "end"] as const) {
      const fake = fakeTracer();
      fake.span[method].mockImplementation(boom as never);

      expect(
        () => createOtelObserver({ tracer: fake.tracer })(anObservation),
        `a throwing ${method} must not reach the caller`
      ).not.toThrow();
    }
  });

  it("swallows a tracer that returns no span", () => {
    for (const returned of [undefined, null, "span", 7]) {
      const tracer: TracerLike = {
        startSpan: () => returned as unknown as SpanLike,
      };

      expect(
        () => createOtelObserver({ tracer })(anObservation),
        `startSpan returning ${JSON.stringify(returned)} must not throw`
      ).not.toThrow();
    }
  });

  it("keeps recording after a span throws", () => {
    const fake = fakeTracer();
    fake.startSpan.mockImplementationOnce(() => {
      throw new Error("no tracer provider");
    });
    const observe = createOtelObserver({ tracer: fake.tracer });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 1 }));
    observe(observation({ op: "syncChain", outcome: "ok", durationMs: 2 }));

    expect(fake.startSpan).toHaveBeenCalledTimes(2);
    expect(lastSpan(fake).name).toBe("miden.syncChain");
    expect(fake.span.end).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing getter on the observation", () => {
    const { tracer } = fakeTracer();
    const observe = createOtelObserver({ tracer, includeSensitive: true });
    const hostile = {
      op: "syncState",
      outcome: "error",
      durationMs: 1,
      get sensitive(): never {
        throw new Error("hostile getter");
      },
    } as unknown as MidenObservation;

    expect(() => observe(hostile)).not.toThrow();
  });

  it("swallows a malformed observation", () => {
    const { tracer } = fakeTracer();
    const observe = createOtelObserver({ tracer });

    for (const malformed of [undefined, null, "syncState", 7]) {
      expect(
        () => observe(malformed as unknown as MidenObservation),
        `observing ${JSON.stringify(malformed)} must not throw`
      ).not.toThrow();
    }
  });
});

describe("createOtelObserver rejects a misconfigured tracer", () => {
  // Reported at wiring time, which is the one moment a throw is useful: the
  // returned observer cannot report its own misconfiguration, so a binding
  // that accepted a tracerless options object would swallow every
  // observation forever and look exactly like a working one.
  it("throws when the tracer cannot start a span", () => {
    for (const tracer of [undefined, null, {}, { startSpan: "nope" }, 7]) {
      expect(
        () => createOtelObserver({ tracer } as unknown as OtelObserverOptions),
        `tracer ${JSON.stringify(tracer)} should be rejected`
      ).toThrow(TypeError);
    }
  });

  it("throws when there are no options at all", () => {
    expect(() =>
      createOtelObserver(undefined as unknown as OtelObserverOptions)
    ).toThrow(TypeError);
  });

  it("names the option at fault", () => {
    expect(() =>
      createOtelObserver({} as unknown as OtelObserverOptions)
    ).toThrow(/startSpan/);
  });
});

describe("the public type surface", () => {
  it("describes the span the binding actually drives", () => {
    // A compile-time assertion with a runtime witness: if the binding
    // started calling a method outside `SpanLike`, the assignment below
    // would stop compiling and `check:attw` would see the drift.
    const fake = fakeTracer();
    const span: SpanLike = fake.span;
    const tracer: TracerLike = { startSpan: () => span };

    createOtelObserver({ tracer })(
      observation({ op: "syncState", outcome: "error", durationMs: 1 })
    );

    expect(fake.span.end).toHaveBeenCalledTimes(1);
  });

  it("accepts an options object typed as the exported interface", () => {
    const fake = fakeTracer();
    const options: OtelObserverOptions = {
      tracer: fake.tracer,
      includeSensitive: false,
    };

    createOtelObserver(options)(
      observation({ op: "syncState", outcome: "ok", durationMs: 2 })
    );

    expect(fake.startSpan).toHaveBeenCalledTimes(1);
  });
});
