import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContractsResource } from "../../resources/contracts.js";

const account = { id: () => "contractId" };
const generatedKey = { kind: "generatedKey" };

function setup() {
  const wasm = {
    AuthSecretKey: {
      rpoFalconWithRNG: vi.fn().mockReturnValue(generatedKey),
    },
  };
  const client = {
    assertNotTerminated: vi.fn(),
    accounts: { create: vi.fn().mockResolvedValue(account) },
  };
  const resource = new ContractsResource(async () => wasm, client);
  return { wasm, client, resource };
}

describe("ContractsResource.deploy", () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("generates a 32-byte seed and a Falcon key when omitted, and defers to accounts.create", async () => {
    const components = [{ tag: "component" }];
    const result = await ctx.resource.deploy({ components });

    expect(ctx.client.accounts.create).toHaveBeenCalledTimes(1);
    const args = ctx.client.accounts.create.mock.calls[0][0];
    expect(args.components).toBe(components);
    expect(args.seed).toBeInstanceOf(Uint8Array);
    expect(args.seed).toHaveLength(32);
    expect(args.auth).toBe(generatedKey);
    expect(result).toEqual({ account, seed: args.seed, auth: generatedKey });
  });

  it("generates a different seed on each call", async () => {
    await ctx.resource.deploy({ components: [{}] });
    await ctx.resource.deploy({ components: [{}] });
    const [a, b] = ctx.client.accounts.create.mock.calls.map((c) => c[0].seed);
    expect(a).not.toEqual(b);
  });

  it("leaves the storage mode to accounts.create unless given", async () => {
    await ctx.resource.deploy({ components: [{}] });
    expect(ctx.client.accounts.create.mock.calls[0][0]).not.toHaveProperty(
      "storage"
    );
    await ctx.resource.deploy({ components: [{}], storage: "private" });
    expect(ctx.client.accounts.create.mock.calls[1][0].storage).toBe("private");
  });

  it("uses the given seed and auth without generating a key", async () => {
    const seed = new Uint8Array(32).fill(7);
    const auth = { kind: "mine" };
    const result = await ctx.resource.deploy({
      components: [{}],
      seed,
      auth,
    });
    expect(ctx.wasm.AuthSecretKey.rpoFalconWithRNG).not.toHaveBeenCalled();
    expect(ctx.client.accounts.create.mock.calls[0][0]).toMatchObject({
      seed,
      auth,
    });
    expect(result).toEqual({ account, seed, auth });
  });

  it('passes auth: "none" through without generating a key', async () => {
    const result = await ctx.resource.deploy({
      components: [{}],
      auth: "none",
    });
    expect(ctx.wasm.AuthSecretKey.rpoFalconWithRNG).not.toHaveBeenCalled();
    expect(result.auth).toBe("none");
  });

  it("rejects missing components instead of creating a wallet", async () => {
    await expect(ctx.resource.deploy({})).rejects.toThrow(TypeError);
    await expect(ctx.resource.deploy()).rejects.toThrow(/components/);
    expect(ctx.client.accounts.create).not.toHaveBeenCalled();
  });

  it("propagates accounts.create validation errors", async () => {
    ctx.client.accounts.create.mockRejectedValue(new Error("no procedure"));
    await expect(ctx.resource.deploy({ components: [] })).rejects.toThrow(
      "no procedure"
    );
  });

  it("refuses after terminate()", async () => {
    ctx.client.assertNotTerminated.mockImplementation(() => {
      throw new Error("terminated");
    });
    await expect(ctx.resource.deploy({ components: [{}] })).rejects.toThrow(
      "terminated"
    );
    expect(ctx.client.accounts.create).not.toHaveBeenCalled();
  });
});
