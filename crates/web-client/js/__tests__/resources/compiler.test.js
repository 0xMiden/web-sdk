import { describe, it, expect, vi, beforeEach } from "vitest";
import { CompilerResource } from "../../resources/compiler.js";

function makeBuilder() {
  return {
    compileAccountComponentCode: vi.fn(),
    compileTxScript: vi.fn(),
    compileNoteScript: vi.fn(),
    buildLibrary: vi.fn(),
    linkStaticLibrary: vi.fn(),
    linkDynamicLibrary: vi.fn(),
  };
}

function makeAccountComponent() {
  return {
    withSupportsAllTypes: vi.fn().mockReturnThis(),
  };
}

function makeWasm(builder, component) {
  return {
    AccountComponent: {
      compile: vi.fn().mockReturnValue(component),
    },
    createCodeBuilder: vi.fn().mockReturnValue(builder),
  };
}

function makeClient() {
  return { assertNotTerminated: vi.fn() };
}

describe("CompilerResource", () => {
  let builder;
  let component;
  let wasm;
  let inner;
  let client;
  let getWasm;

  beforeEach(() => {
    component = makeAccountComponent();
    builder = makeBuilder();
    wasm = makeWasm(builder, component);
    // inner.createCodeBuilder is what the resource actually calls
    inner = { createCodeBuilder: vi.fn().mockReturnValue(builder) };
    client = makeClient();
    getWasm = vi.fn().mockResolvedValue(wasm);
  });

  describe("component", () => {
    it("compiles and returns component with supports-all-types by default", async () => {
      builder.compileAccountComponentCode.mockReturnValue("compiled");
      const resource = new CompilerResource(inner, getWasm, client);
      const result = await resource.component({ code: "some code", slots: [] });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.createCodeBuilder).toHaveBeenCalledOnce();
      expect(builder.compileAccountComponentCode).toHaveBeenCalledWith(
        "some code"
      );
      expect(wasm.AccountComponent.compile).toHaveBeenCalledWith(
        "compiled",
        []
      );
      expect(component.withSupportsAllTypes).toHaveBeenCalledOnce();
      expect(result).toBe(component);
    });

    it("returns component without withSupportsAllTypes when supportAllTypes=false", async () => {
      builder.compileAccountComponentCode.mockReturnValue("compiled");
      const rawComponent = { withSupportsAllTypes: vi.fn() };
      wasm.AccountComponent.compile.mockReturnValue(rawComponent);
      const resource = new CompilerResource(inner, getWasm, client);
      const result = await resource.component({
        code: "code",
        slots: [],
        supportAllTypes: false,
      });
      expect(rawComponent.withSupportsAllTypes).not.toHaveBeenCalled();
      expect(result).toBe(rawComponent);
    });

    it("defaults slots to empty array when not provided", async () => {
      builder.compileAccountComponentCode.mockReturnValue("compiled");
      const resource = new CompilerResource(inner, getWasm, client);
      await resource.component({ code: "code" });
      expect(wasm.AccountComponent.compile).toHaveBeenCalledWith(
        "compiled",
        []
      );
    });

    it("passes slots to AccountComponent.compile", async () => {
      builder.compileAccountComponentCode.mockReturnValue("compiled");
      const slots = ["slot1", "slot2"];
      const resource = new CompilerResource(inner, getWasm, client);
      await resource.component({ code: "code", slots });
      expect(wasm.AccountComponent.compile).toHaveBeenCalledWith(
        "compiled",
        slots
      );
    });

    it("works without a client (client=null)", async () => {
      builder.compileAccountComponentCode.mockReturnValue("compiled");
      const resource = new CompilerResource(inner, getWasm);
      // Should not throw even without client
      await resource.component({ code: "code" });
    });
  });

  describe("txScript", () => {
    it("compiles and returns txScript result", async () => {
      builder.compileTxScript.mockReturnValue("txScriptResult");
      const resource = new CompilerResource(inner, getWasm, client);
      const result = await resource.txScript({ code: "tx code" });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.createCodeBuilder).toHaveBeenCalledOnce();
      expect(builder.compileTxScript).toHaveBeenCalledWith("tx code");
      expect(result).toBe("txScriptResult");
    });

    it("links dynamic libraries inline when provided as namespace/code objects", async () => {
      builder.compileTxScript.mockReturnValue("txResult");
      const builtLib = { name: "lib" };
      builder.buildLibrary.mockReturnValue(builtLib);
      const resource = new CompilerResource(inner, getWasm, client);
      await resource.txScript({
        code: "code",
        libraries: [{ namespace: "myns", code: "lib code" }],
      });
      expect(builder.buildLibrary).toHaveBeenCalledWith("myns", "lib code");
      expect(builder.linkDynamicLibrary).toHaveBeenCalledWith(builtLib);
    });

    it("links static library when linking='static'", async () => {
      builder.compileTxScript.mockReturnValue("txResult");
      const builtLib = { name: "lib" };
      builder.buildLibrary.mockReturnValue(builtLib);
      const resource = new CompilerResource(inner, getWasm, client);
      await resource.txScript({
        code: "code",
        libraries: [{ namespace: "myns", code: "lib code", linking: "static" }],
      });
      expect(builder.linkStaticLibrary).toHaveBeenCalledWith(builtLib);
      expect(builder.linkDynamicLibrary).not.toHaveBeenCalled();
    });

    it("links pre-built library object dynamically when no namespace field", async () => {
      builder.compileTxScript.mockReturnValue("txResult");
      const prebuiltLib = { someData: true }; // no .namespace
      const resource = new CompilerResource(inner, getWasm, client);
      await resource.txScript({ code: "code", libraries: [prebuiltLib] });
      expect(builder.buildLibrary).not.toHaveBeenCalled();
      expect(builder.linkDynamicLibrary).toHaveBeenCalledWith(prebuiltLib);
    });

    it("handles empty libraries array", async () => {
      builder.compileTxScript.mockReturnValue("txResult");
      const resource = new CompilerResource(inner, getWasm, client);
      const result = await resource.txScript({ code: "code", libraries: [] });
      expect(result).toBe("txResult");
    });

    it("defaults libraries to empty array", async () => {
      builder.compileTxScript.mockReturnValue("txResult");
      const resource = new CompilerResource(inner, getWasm, client);
      const result = await resource.txScript({ code: "code" });
      expect(result).toBe("txResult");
      expect(builder.linkDynamicLibrary).not.toHaveBeenCalled();
    });

    it("works without a client", async () => {
      builder.compileTxScript.mockReturnValue("txResult");
      const resource = new CompilerResource(inner, getWasm);
      await resource.txScript({ code: "code" });
    });
  });

  describe("noteScript", () => {
    it("compiles and returns noteScript result", async () => {
      builder.compileNoteScript.mockReturnValue("noteScriptResult");
      const resource = new CompilerResource(inner, getWasm, client);
      const result = await resource.noteScript({ code: "note code" });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(builder.compileNoteScript).toHaveBeenCalledWith("note code");
      expect(result).toBe("noteScriptResult");
    });

    it("links libraries for noteScript", async () => {
      builder.compileNoteScript.mockReturnValue("noteResult");
      const builtLib = { name: "lib" };
      builder.buildLibrary.mockReturnValue(builtLib);
      const resource = new CompilerResource(inner, getWasm, client);
      await resource.noteScript({
        code: "code",
        libraries: [{ namespace: "ns", code: "lib code" }],
      });
      expect(builder.buildLibrary).toHaveBeenCalledWith("ns", "lib code");
      expect(builder.linkDynamicLibrary).toHaveBeenCalledWith(builtLib);
    });

    it("works without a client", async () => {
      builder.compileNoteScript.mockReturnValue("noteResult");
      const resource = new CompilerResource(inner, getWasm);
      await resource.noteScript({ code: "code" });
    });
  });
});
