import { describe, it, expect, beforeAll, vi } from "vitest";
import { WorkerAction } from "../constants.js";

// The worker loads the built bindings from dist/; a stub stands in for them so
// the INIT handler runs in node.
const created = [];
vi.mock("../../dist/wasm.js", () => ({
  default: async () => ({
    WebClient: class {
      async createClient(...args) {
        created.push({ method: "createClient", args });
      }
      async createClientWithExternalKeystore(...args) {
        created.push({ method: "createClientWithExternalKeystore", args });
      }
    },
  }),
}));

const posted = [];

beforeAll(async () => {
  vi.stubGlobal("self", { postMessage: (message) => posted.push(message) });
  await import("../workers/web-client-methods-worker.js");
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
