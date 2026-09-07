import { describe, it, expect, vi } from "vitest";
import type { MidenObservation } from "@miden-sdk/miden-sdk";
import {
  createSentryObserver,
  type SentryLikeClient,
  type SentryLevel,
  type SentryMessageContext,
  type SentryObserverOptions,
} from "../index";

/**
 * A stand-in for the consumer's Sentry client. The binding is defined
 * against the `captureMessage` shape rather than a Sentry import, so the
 * double is the real contract and not an approximation of one.
 */
const fakeClient = () => {
  const captureMessage = vi.fn<SentryLikeClient["captureMessage"]>();
  const client: SentryLikeClient = { captureMessage };
  return { client, captureMessage };
};

/** The last `captureMessage` call, failing loudly if there wasn't one. */
const lastCall = (
  captureMessage: ReturnType<typeof fakeClient>["captureMessage"]
) => {
  const calls = captureMessage.mock.calls;
  expect(
    calls.length,
    "expected the binding to have reported at least one observation"
  ).toBeGreaterThan(0);
  const [message, context] = calls[calls.length - 1]!;
  return { message, context };
};

/**
 * An observation as the SDK delivers it by default: the `sensitive` key is
 * ABSENT, not present-and-undefined. Spelling it as a literal without the
 * key is the point — a test that passed `sensitive: undefined` would not
 * exercise the shape the SDK actually emits.
 */
const observation = (
  fields: Pick<MidenObservation, "op" | "outcome" | "durationMs">
): MidenObservation => ({ ...fields });

/** An observation from a client built with `observeSensitive: true`. */
const sensitiveObservation = (
  fields: Pick<MidenObservation, "op" | "outcome" | "durationMs">,
  sensitive: MidenObservation["sensitive"]
): MidenObservation => ({ ...fields, sensitive });

describe("createSentryObserver", () => {
  it("returns an observer function", () => {
    const { client } = fakeClient();
    expect(typeof createSentryObserver({ client })).toBe("function");
  });

  it("forwards a failed operation", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client });

    observe(
      observation({
        op: "proveTransaction",
        outcome: "error",
        durationMs: 21_000,
      })
    );

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const { message, context } = lastCall(captureMessage);
    expect(message).toContain("proveTransaction");
    expect(context.tags.op).toBe("proveTransaction");
    expect(context.tags.outcome).toBe("error");
    expect(context.extra.durationMs).toBe(21_000);
  });

  it("reports a failure at error severity and a success at info", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 0 });

    observe(observation({ op: "syncState", outcome: "error", durationMs: 1 }));
    expect(lastCall(captureMessage).context.level).toBe("error");

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 1 }));
    expect(lastCall(captureMessage).context.level).toBe("info");
  });

  it("names the operation and the outcome in the message", () => {
    const { client, captureMessage } = fakeClient();
    createSentryObserver({ client })(
      observation({ op: "submitTransaction", outcome: "error", durationMs: 3 })
    );

    const { message } = lastCall(captureMessage);
    expect(message).toContain("submitTransaction");
    expect(message).toContain("error");
    expect(message).not.toContain("ok");
  });

  it("ignores a successful operation below the duration threshold", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 1_000 });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 12 }));

    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("forwards a slow successful operation", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 1_000 });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 5_000 }));

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(lastCall(captureMessage).context.tags.outcome).toBe("ok");
  });

  it("treats the threshold as inclusive", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 1_000 });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 1_000 }));
    expect(captureMessage).toHaveBeenCalledTimes(1);

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 999 }));
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards failures however fast they were", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 1_000 });

    observe(observation({ op: "syncState", outcome: "error", durationMs: 0 }));

    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards no successful operation at all without a threshold", () => {
    // The default is failures-only: a binding that started shipping every
    // successful call the moment a consumer omitted `minDurationMs` would
    // bill them for the SDK's entire call volume.
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: 0 }));
    observe(
      observation({ op: "syncState", outcome: "ok", durationMs: 600_000 })
    );
    expect(captureMessage).not.toHaveBeenCalled();

    observe(observation({ op: "syncState", outcome: "error", durationMs: 0 }));
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a successful operation whose duration is not a number", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 1_000 });

    observe(observation({ op: "syncState", outcome: "ok", durationMs: NaN }));

    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("reports each observation it is given", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client });

    observe(observation({ op: "syncState", outcome: "error", durationMs: 1 }));
    observe(observation({ op: "syncChain", outcome: "error", durationMs: 2 }));
    observe(
      observation({ op: "proveTransaction", outcome: "error", durationMs: 3 })
    );

    expect(captureMessage).toHaveBeenCalledTimes(3);
    expect(
      captureMessage.mock.calls.map(([, context]) => context.tags.op)
    ).toEqual(["syncState", "syncChain", "proveTransaction"]);
  });

  it("reports synchronously and schedules nothing", async () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client });

    observe(observation({ op: "syncState", outcome: "error", durationMs: 1 }));

    // Positive fact first: the report landed before the caller's next
    // statement, so the assertion below is about a real call and not a
    // call that never happened.
    expect(captureMessage).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe("createSentryObserver and the sensitive channel", () => {
  it("drops sensitive detail unless includeSensitive is set", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client });

    observe(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        { errorMessage: "mtst1secret" }
      )
    );

    const { context } = lastCall(captureMessage);
    expect(JSON.stringify(context)).not.toContain("mtst1secret");
  });

  it("forwards sensitive detail when includeSensitive is set", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });

    observe(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        { errorMessage: "mtst1secret" }
      )
    );

    const { context } = lastCall(captureMessage);
    expect(context.extra.errorMessage).toBe("mtst1secret");
  });

  it("enables the sensitive channel only for a literal true", () => {
    // Mirrors the SDK's own handling of `observeSensitive`: a truthy value
    // that is not `true` must not be enough to disclose anything.
    for (const includeSensitive of [1, "true", {}, [], "yes"]) {
      const { client, captureMessage } = fakeClient();
      const observe = createSentryObserver({
        client,
        includeSensitive: includeSensitive as unknown as boolean,
      });

      observe(
        sensitiveObservation(
          { op: "syncState", outcome: "error", durationMs: 1 },
          { errorMessage: "mtst1secret" }
        )
      );

      const { context } = lastCall(captureMessage);
      expect(
        JSON.stringify(context),
        `includeSensitive: ${JSON.stringify(includeSensitive)} must not disclose`
      ).not.toContain("mtst1secret");
    }
  });

  it("reports an observation whose sensitive key is absent", () => {
    // The default shape. The report must still go out — dropping it would
    // make the binding useless for anyone who left `observeSensitive` off.
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });

    observe(observation({ op: "syncState", outcome: "error", durationMs: 7 }));

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(lastCall(captureMessage).context.extra.durationMs).toBe(7);
  });

  it("puts no undefined value in the payload when sensitive is absent", () => {
    // The failure this guards against is reading `observation.sensitive`
    // without checking, which yields `undefined` and then spreads
    // `errorMessage: undefined` (etc.) into `extra`. Sentry renders those
    // as empty rows, and `JSON.stringify` silently drops them, so a
    // stringify-based assertion alone would never notice.
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });

    observe(observation({ op: "syncState", outcome: "error", durationMs: 7 }));

    const { context } = lastCall(captureMessage);
    expect(Object.keys(context.extra)).toEqual(["durationMs"]);
    expect("sensitive" in context.extra).toBe(false);
    expect("errorMessage" in context.extra).toBe(false);
    expect(Object.values(context.extra)).not.toContain(undefined);
  });

  it("omits a sensitive field the SDK declared but did not populate", () => {
    // `MidenObservationSensitive.accountId` is declared optional and the
    // SDK does not populate it, so a present `sensitive` object still
    // carries absent fields.
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });

    observe(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        { errorMessage: "boom", accountId: undefined }
      )
    );

    const { context } = lastCall(captureMessage);
    expect(context.extra.errorMessage).toBe("boom");
    expect("accountId" in context.extra).toBe(false);
    expect(Object.values(context.extra)).not.toContain(undefined);
  });

  it("keeps the measured duration when sensitive carries the same key", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });

    observe(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 42 },
        { durationMs: 0 } as unknown as MidenObservation["sensitive"]
      )
    );

    expect(lastCall(captureMessage).context.extra.durationMs).toBe(42);
  });

  it("does not let a sensitive key reach the payload's prototype", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });

    observe(
      sensitiveObservation(
        { op: "syncState", outcome: "error", durationMs: 1 },
        JSON.parse('{"__proto__": {"polluted": true}}')
      )
    );

    const { context } = lastCall(captureMessage);
    expect(Object.getPrototypeOf(context.extra)).toBe(Object.prototype);
    expect((context.extra as Record<string, unknown>).polluted).toBeUndefined();
    expect({}).not.toHaveProperty("polluted");
  });

  it("tolerates a sensitive value that is not an object", () => {
    const { client, captureMessage } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });

    for (const sensitive of [null, "leaked", 7, true]) {
      observe(
        sensitiveObservation(
          { op: "syncState", outcome: "error", durationMs: 5 },
          sensitive as unknown as MidenObservation["sensitive"]
        )
      );
      const { context } = lastCall(captureMessage);
      expect(Object.keys(context.extra)).toEqual(["durationMs"]);
    }
    expect(captureMessage).toHaveBeenCalledTimes(4);
  });
});

describe("createSentryObserver never throws into the caller", () => {
  it("swallows a client that throws", () => {
    const client: SentryLikeClient = {
      captureMessage: () => {
        throw new Error("transport down");
      },
    };
    const observe = createSentryObserver({ client });

    expect(() =>
      observe(observation({ op: "syncState", outcome: "error", durationMs: 1 }))
    ).not.toThrow();
  });

  it("keeps reporting after a client throws", () => {
    const captureMessage = vi
      .fn<SentryLikeClient["captureMessage"]>()
      .mockImplementationOnce(() => {
        throw new Error("transport down");
      });
    const observe = createSentryObserver({ client: { captureMessage } });

    observe(observation({ op: "syncState", outcome: "error", durationMs: 1 }));
    observe(observation({ op: "syncChain", outcome: "error", durationMs: 2 }));

    expect(captureMessage).toHaveBeenCalledTimes(2);
    expect(lastCall(captureMessage).context.tags.op).toBe("syncChain");
  });

  it("swallows a throwing getter on the observation", () => {
    const { client } = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });
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
    const { client } = fakeClient();
    const observe = createSentryObserver({ client });

    for (const malformed of [undefined, null, "syncState", 7]) {
      expect(
        () => observe(malformed as unknown as MidenObservation),
        `observing ${JSON.stringify(malformed)} must not throw`
      ).not.toThrow();
    }
  });
});

describe("createSentryObserver rejects a misconfigured client", () => {
  // Reported at wiring time, which is the one moment a throw is useful:
  // the returned observer cannot report its own misconfiguration, so a
  // binding that accepted a clientless options object would swallow every
  // observation forever and look exactly like a working one.
  it("throws when the client cannot capture a message", () => {
    for (const client of [undefined, null, {}, { captureMessage: "nope" }, 7]) {
      expect(
        () =>
          createSentryObserver({
            client,
          } as unknown as SentryObserverOptions),
        `client ${JSON.stringify(client)} should be rejected`
      ).toThrow(TypeError);
    }
  });

  it("throws when there are no options at all", () => {
    expect(() =>
      createSentryObserver(undefined as unknown as SentryObserverOptions)
    ).toThrow(TypeError);
  });

  it("names the option at fault", () => {
    expect(() =>
      createSentryObserver({} as unknown as SentryObserverOptions)
    ).toThrow(/captureMessage/);
  });
});

describe("the public type surface", () => {
  it("describes the context the binding actually passes", () => {
    // A compile-time assertion with a runtime witness: if the emitted
    // context stopped matching `SentryMessageContext`, the assignment
    // below would stop compiling and `check:attw` would see the drift.
    const { client, captureMessage } = fakeClient();
    createSentryObserver({ client })(
      observation({ op: "syncState", outcome: "error", durationMs: 1 })
    );

    const context: SentryMessageContext = lastCall(captureMessage).context;
    const level: SentryLevel = context.level;
    expect(level).toBe("error");
    expect(typeof context.tags.op).toBe("string");
    expect(typeof context.tags.outcome).toBe("string");
  });

  it("accepts an options object typed as the exported interface", () => {
    const { client, captureMessage } = fakeClient();
    const options: SentryObserverOptions = {
      client,
      minDurationMs: 1_000,
      includeSensitive: false,
    };

    createSentryObserver(options)(
      observation({ op: "syncState", outcome: "ok", durationMs: 2_000 })
    );

    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});
