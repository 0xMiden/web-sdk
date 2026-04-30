import { describe, it, expect, vi, beforeEach } from "vitest";
import { TagsResource } from "../../resources/tags.js";

function makeInner() {
  return {
    addTag: vi.fn(),
    removeTag: vi.fn(),
    listTags: vi.fn(),
  };
}

function makeClient() {
  return { assertNotTerminated: vi.fn() };
}

describe("TagsResource", () => {
  let inner;
  let client;
  let resource;

  beforeEach(() => {
    inner = makeInner();
    client = makeClient();
    resource = new TagsResource(inner, undefined, client);
  });

  describe("add", () => {
    it("calls assertNotTerminated and addTag with stringified argument", async () => {
      inner.addTag.mockResolvedValue(undefined);
      await resource.add(42);
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.addTag).toHaveBeenCalledWith("42");
    });

    it("coerces a string tag to string (no-op)", async () => {
      inner.addTag.mockResolvedValue(undefined);
      await resource.add("mytag");
      expect(inner.addTag).toHaveBeenCalledWith("mytag");
    });

    it("propagates rejection from addTag", async () => {
      inner.addTag.mockRejectedValue(new Error("add error"));
      await expect(resource.add(1)).rejects.toThrow("add error");
    });
  });

  describe("remove", () => {
    it("calls assertNotTerminated and removeTag with stringified argument", async () => {
      inner.removeTag.mockResolvedValue(undefined);
      await resource.remove(7);
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.removeTag).toHaveBeenCalledWith("7");
    });

    it("propagates rejection from removeTag", async () => {
      inner.removeTag.mockRejectedValue(new Error("remove error"));
      await expect(resource.remove(1)).rejects.toThrow("remove error");
    });
  });

  describe("list", () => {
    it("returns numeric tags mapped from inner list", async () => {
      inner.listTags.mockResolvedValue(["1", "2", "300"]);
      const result = await resource.list();
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(result).toEqual([1, 2, 300]);
    });

    it("uses Array.from to convert iterable", async () => {
      // Return a Set to verify Array.from is called
      inner.listTags.mockResolvedValue(new Set(["5", "10"]));
      const result = await resource.list();
      expect(result).toEqual(expect.arrayContaining([5, 10]));
      expect(result).toHaveLength(2);
    });

    it("returns empty array when no tags", async () => {
      inner.listTags.mockResolvedValue([]);
      expect(await resource.list()).toEqual([]);
    });

    it("throws when a tag is not a valid number", async () => {
      inner.listTags.mockResolvedValue(["abc"]);
      await expect(resource.list()).rejects.toThrow("Invalid tag value: abc");
    });

    it("throws for NaN-producing tag values", async () => {
      inner.listTags.mockResolvedValue(["not-a-number"]);
      await expect(resource.list()).rejects.toThrow(/Invalid tag value/);
    });

    it("propagates rejection from listTags", async () => {
      inner.listTags.mockRejectedValue(new Error("list error"));
      await expect(resource.list()).rejects.toThrow("list error");
    });
  });
});
