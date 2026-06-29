import { describe, it, expect, vi } from "vitest";

import { MidenClient } from "../client.js";

describe("MidenClient.rawWebClient", () => {
  // The constructor only stores refs + builds resource wrappers, so a bare mock
  // inner is enough to exercise the accessor without a real WASM client.
  const make = (inner) => new MidenClient(inner, vi.fn(), null);

  it("hands back the exact WasmWebClient the client owns (borrow, not reconstruct)", () => {
    const inner = { storeIdentifier: vi.fn() };
    const client = make(inner);
    // Must be the SAME instance — borrowing it is what avoids a second client
    // over the same store, the dual-instance bug (#169). A copy/new object here
    // would reintroduce it.
    expect(client.rawWebClient()).toBe(inner);
  });

  it("throws after terminate — no borrowing a dead client", () => {
    const inner = { terminate: vi.fn() };
    const client = make(inner);
    client.terminate();
    expect(() => client.rawWebClient()).toThrow("Client terminated");
  });
});
