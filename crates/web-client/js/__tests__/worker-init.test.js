import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WorkerAction } from "../constants.js";

const created = [];
const posted = [];

beforeAll(async () => {
  vi.resetModules();
  vi.stubGlobal("__midenWorkerWasm", {
    WebClient: class {
      async createClient(...args) {
        created.push({ method: "createClient", args });
      }
      async createClientWithExternalKeystore(...args) {
        created.push({ method: "createClientWithExternalKeystore", args });
      }
    },
  });
  vi.stubGlobal("self", { postMessage: (message) => posted.push(message) });
  await import("../workers/web-client-methods-worker.js");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function init(args) {
  const readyBefore = posted.filter((m) => m.ready).length;
  self.onmessage({ data: { action: WorkerAction.INIT, args } });
  await vi.waitFor(() => {
    expect(posted.filter((m) => m.ready).length).toBe(readyBefore + 1);
  });
  return created.at(-1);
}

describe("worker INIT", () => {
  it("passes args 10 and 11 to createClient after feeFaucetId", async () => {
    const call = await init([
      "rpc",
      "transport",
      undefined,
      "store",
      false,
      false,
      false,
      undefined,
      1,
      "0xfee",
      3,
      250,
    ]);
    expect(call.method).toBe("createClient");
    expect(call.args).toEqual([
      "rpc",
      "transport",
      undefined,
      "store",
      "0xfee",
      3,
      250,
    ]);
  });

  it("passes args 10 and 11 to createClientWithExternalKeystore after the callbacks", async () => {
    const call = await init([
      "rpc",
      "transport",
      undefined,
      "store",
      false,
      false,
      true,
      undefined,
      1,
      "0xfee",
      0,
      60_000,
    ]);
    expect(call.method).toBe("createClientWithExternalKeystore");
    expect(call.args).toHaveLength(10);
    expect(call.args[4]).toBe("0xfee");
    expect(typeof call.args[7]).toBe("function");
    expect(call.args[8]).toBe(0);
    expect(call.args[9]).toBe(60_000);
  });
});
