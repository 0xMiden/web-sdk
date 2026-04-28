import { describe, it, expect, vi, beforeEach } from "vitest";
import { SettingsResource } from "../../resources/settings.js";

function makeInner() {
  return {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    removeSetting: vi.fn(),
    listSettingKeys: vi.fn(),
  };
}

function makeClient() {
  return { assertNotTerminated: vi.fn() };
}

describe("SettingsResource", () => {
  let inner;
  let client;
  let resource;

  beforeEach(() => {
    inner = makeInner();
    client = makeClient();
    resource = new SettingsResource(inner, undefined, client);
  });

  describe("get", () => {
    it("calls assertNotTerminated and getSetting", async () => {
      inner.getSetting.mockResolvedValue("hello");
      const result = await resource.get("myKey");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.getSetting).toHaveBeenCalledWith("myKey");
      expect(result).toBe("hello");
    });

    it("returns null when getSetting returns undefined", async () => {
      inner.getSetting.mockResolvedValue(undefined);
      const result = await resource.get("missing");
      expect(result).toBeNull();
    });

    it("returns the value when non-undefined", async () => {
      inner.getSetting.mockResolvedValue(42);
      expect(await resource.get("k")).toBe(42);
    });

    it("returns null for null value (falsy but not undefined)", async () => {
      inner.getSetting.mockResolvedValue(null);
      // null !== undefined, so it is returned as-is
      expect(await resource.get("k")).toBeNull();
    });

    it("returns 0 (falsy but not undefined)", async () => {
      inner.getSetting.mockResolvedValue(0);
      expect(await resource.get("k")).toBe(0);
    });

    it("propagates rejection from getSetting", async () => {
      inner.getSetting.mockRejectedValue(new Error("db error"));
      await expect(resource.get("k")).rejects.toThrow("db error");
    });
  });

  describe("set", () => {
    it("calls assertNotTerminated and setSetting", async () => {
      inner.setSetting.mockResolvedValue(undefined);
      await resource.set("k", "v");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.setSetting).toHaveBeenCalledWith("k", "v");
    });

    it("propagates rejection from setSetting", async () => {
      inner.setSetting.mockRejectedValue(new Error("write error"));
      await expect(resource.set("k", "v")).rejects.toThrow("write error");
    });
  });

  describe("remove", () => {
    it("calls assertNotTerminated and removeSetting", async () => {
      inner.removeSetting.mockResolvedValue(undefined);
      await resource.remove("k");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.removeSetting).toHaveBeenCalledWith("k");
    });

    it("propagates rejection from removeSetting", async () => {
      inner.removeSetting.mockRejectedValue(new Error("rm error"));
      await expect(resource.remove("k")).rejects.toThrow("rm error");
    });
  });

  describe("listKeys", () => {
    it("calls assertNotTerminated and listSettingKeys, returns result", async () => {
      inner.listSettingKeys.mockResolvedValue(["a", "b"]);
      const result = await resource.listKeys();
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.listSettingKeys).toHaveBeenCalledOnce();
      expect(result).toEqual(["a", "b"]);
    });

    it("returns empty array when no keys", async () => {
      inner.listSettingKeys.mockResolvedValue([]);
      expect(await resource.listKeys()).toEqual([]);
    });

    it("propagates rejection from listSettingKeys", async () => {
      inner.listSettingKeys.mockRejectedValue(new Error("list error"));
      await expect(resource.listKeys()).rejects.toThrow("list error");
    });
  });
});
