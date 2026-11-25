import { afterEach, expect, it, vi } from "vitest";

const { resolvedWasmUrl } = vi.hoisted(() => ({
  resolvedWasmUrl: new URL(
    "https://fixture.invalid/assets/miden_client_web-7c0d.wasm"
  ),
}));

vi.mock("../../Cargo.toml", () => ({
  // eslint-disable-next-line camelcase -- wasm-bindgen export name
  __wasm_url: resolvedWasmUrl,
}));

import { MockWebClient, WasmWebClient } from "../index.js";
import { WorkerAction } from "../constants.js";

const originalWorkerMode = WasmWebClient.workerMode;

afterEach(() => {
  WasmWebClient.workerMode = originalWorkerMode;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("passes a string when the actual resolver receives a URL object", async () => {
  const posted = [];
  let receive;
  WasmWebClient.workerMode = "classic";
  vi.stubEnv("SSR", false);
  vi.stubGlobal(
    "Worker",
    class {
      addEventListener(event, callback) {
        if (event === "message") receive = callback;
      }

      postMessage(message) {
        posted.push(message);
      }

      terminate() {}
    }
  );

  new WasmWebClient("rpc", "transport", undefined, "classic-resolver-test");
  await receive({ data: { loaded: true } });
  await vi.waitFor(() => {
    expect(posted.some((message) => message.action === WorkerAction.INIT)).toBe(
      true
    );
  });

  const init = posted.find((message) => message.action === WorkerAction.INIT);
  expect(init.args.at(-1)).toBe(resolvedWasmUrl.href);
});

it("passes the resolver href as INIT_MOCK args[6] when the actual resolver receives a URL object", async () => {
  const posted = [];
  let receive;
  WasmWebClient.workerMode = "classic";
  vi.stubEnv("SSR", false);
  vi.stubGlobal(
    "Worker",
    class {
      addEventListener(event, callback) {
        if (event === "message") receive = callback;
      }

      postMessage(message) {
        posted.push(message);
      }

      terminate() {}
    }
  );

  const client = new MockWebClient(
    undefined,
    undefined,
    "classic-resolver-mock"
  );
  await receive({ data: { loaded: true } });
  client.resolveMockChainReady([new ArrayBuffer(0), new ArrayBuffer(0)]);
  await vi.waitFor(() => {
    expect(
      posted.some((message) => message.action === WorkerAction.INIT_MOCK)
    ).toBe(true);
  });

  const initMock = posted.find(
    (message) => message.action === WorkerAction.INIT_MOCK
  );
  expect(initMock.args[6]).toBe(resolvedWasmUrl.href);
});
