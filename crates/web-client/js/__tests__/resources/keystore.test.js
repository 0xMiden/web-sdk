import { describe, it, expect, vi, beforeEach } from "vitest";
import { KeystoreResource } from "../../resources/keystore.js";

function makeKs() {
  return {
    insert: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    getCommitments: vi.fn(),
    getAccountId: vi.fn(),
  };
}

function makeInner(ks) {
  return { keystore: ks };
}

function makeClient() {
  return { assertNotTerminated: vi.fn() };
}

describe("KeystoreResource", () => {
  let ks;
  let inner;
  let client;
  let resource;

  beforeEach(() => {
    ks = makeKs();
    inner = makeInner(ks);
    client = makeClient();
    resource = new KeystoreResource(inner, client);
  });

  describe("insert", () => {
    it("delegates to keystore.insert with assertNotTerminated", async () => {
      ks.insert.mockResolvedValue("inserted");
      const result = await resource.insert("accountId", "secretKey");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(ks.insert).toHaveBeenCalledWith("accountId", "secretKey");
      expect(result).toBe("inserted");
    });

    it("propagates rejection", async () => {
      ks.insert.mockRejectedValue(new Error("insert fail"));
      await expect(resource.insert("a", "s")).rejects.toThrow("insert fail");
    });
  });

  describe("get", () => {
    it("delegates to keystore.get with assertNotTerminated", async () => {
      ks.get.mockResolvedValue("key-data");
      const result = await resource.get("commitment");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(ks.get).toHaveBeenCalledWith("commitment");
      expect(result).toBe("key-data");
    });

    it("propagates rejection", async () => {
      ks.get.mockRejectedValue(new Error("get fail"));
      await expect(resource.get("c")).rejects.toThrow("get fail");
    });
  });

  describe("remove", () => {
    it("delegates to keystore.remove with assertNotTerminated", async () => {
      ks.remove.mockResolvedValue(true);
      const result = await resource.remove("commitment");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(ks.remove).toHaveBeenCalledWith("commitment");
      expect(result).toBe(true);
    });

    it("propagates rejection", async () => {
      ks.remove.mockRejectedValue(new Error("remove fail"));
      await expect(resource.remove("c")).rejects.toThrow("remove fail");
    });
  });

  describe("getCommitments", () => {
    it("delegates to keystore.getCommitments", async () => {
      ks.getCommitments.mockResolvedValue(["c1", "c2"]);
      const result = await resource.getCommitments("accountId");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(ks.getCommitments).toHaveBeenCalledWith("accountId");
      expect(result).toEqual(["c1", "c2"]);
    });

    it("propagates rejection", async () => {
      ks.getCommitments.mockRejectedValue(new Error("commitments fail"));
      await expect(resource.getCommitments("a")).rejects.toThrow(
        "commitments fail"
      );
    });
  });

  describe("getAccountId", () => {
    it("delegates to keystore.getAccountId", async () => {
      ks.getAccountId.mockResolvedValue("accountId");
      const result = await resource.getAccountId("pubKeyCommitment");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(ks.getAccountId).toHaveBeenCalledWith("pubKeyCommitment");
      expect(result).toBe("accountId");
    });

    it("propagates rejection", async () => {
      ks.getAccountId.mockRejectedValue(new Error("getAccountId fail"));
      await expect(resource.getAccountId("c")).rejects.toThrow(
        "getAccountId fail"
      );
    });
  });

  // ── Fallback paths (next): when inner.keystore is undefined, the
  // resource methods route through the older direct-on-inner methods
  // that the napi binding still provides. The fallback path is only
  // present on next; main always has inner.keystore.
  describe("fallback paths (no inner.keystore)", () => {
    let innerNoKs;
    let resourceNoKs;

    beforeEach(() => {
      innerNoKs = {
        addAccountSecretKeyToWebStore: vi.fn().mockResolvedValue("inserted-fb"),
        getAccountAuthByPubKeyCommitment: vi
          .fn()
          .mockResolvedValue("key-data-fb"),
        getPublicKeyCommitmentsOfAccount: vi
          .fn()
          .mockResolvedValue(["c1-fb", "c2-fb"]),
        getAccountByKeyCommitment: vi.fn(),
      };
      resourceNoKs = new KeystoreResource(innerNoKs, client);
    });

    it("insert falls back to addAccountSecretKeyToWebStore", async () => {
      const result = await resourceNoKs.insert("accountId", "secretKey");
      expect(innerNoKs.addAccountSecretKeyToWebStore).toHaveBeenCalledWith(
        "accountId",
        "secretKey"
      );
      expect(result).toBe("inserted-fb");
    });

    it("get falls back to getAccountAuthByPubKeyCommitment", async () => {
      const result = await resourceNoKs.get("commitment");
      expect(innerNoKs.getAccountAuthByPubKeyCommitment).toHaveBeenCalledWith(
        "commitment"
      );
      expect(result).toBe("key-data-fb");
    });

    it("remove throws (no fallback)", async () => {
      await expect(resourceNoKs.remove("c")).rejects.toThrow(
        /remove\(\) is not supported/
      );
    });

    it("getCommitments falls back to getPublicKeyCommitmentsOfAccount", async () => {
      const result = await resourceNoKs.getCommitments("accountId");
      expect(innerNoKs.getPublicKeyCommitmentsOfAccount).toHaveBeenCalledWith(
        "accountId"
      );
      expect(result).toEqual(["c1-fb", "c2-fb"]);
    });

    it("getAccountId falls back to getAccountByKeyCommitment(...).id()", async () => {
      const fakeAccount = { id: vi.fn().mockReturnValue("acc-fb") };
      innerNoKs.getAccountByKeyCommitment.mockResolvedValue(fakeAccount);
      const result = await resourceNoKs.getAccountId("commitment");
      expect(innerNoKs.getAccountByKeyCommitment).toHaveBeenCalledWith(
        "commitment"
      );
      expect(fakeAccount.id).toHaveBeenCalled();
      expect(result).toBe("acc-fb");
    });

    it("getAccountId returns undefined when no account is found", async () => {
      innerNoKs.getAccountByKeyCommitment.mockResolvedValue(null);
      const result = await resourceNoKs.getAccountId("commitment");
      expect(result).toBeUndefined();
    });
  });
});
