import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useImportAccount } from "../../hooks/useImportAccount";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { AccountFile } from "@miden-sdk/miden-sdk";
import {
  createMockAccount,
  createMockAccountFile,
  createMockAccountHeader,
  createMockAccountId,
  createMockWebClient,
} from "../mocks/miden-sdk";

// Mock useMiden
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useImportAccount", () => {
  it.each(["resolve", "reject"])(
    "keeps the latest call busy when the replaced client's call settles (%s)",
    async (outcome) => {
      const pendingA = deferred<ReturnType<typeof createMockAccount>>();
      const pendingB = deferred<ReturnType<typeof createMockAccount>>();
      const clientA = createMockWebClient({
        importPublicAccountFromSeed: vi.fn().mockReturnValue(pendingA.promise),
      });
      const clientB = createMockWebClient({
        importPublicAccountFromSeed: vi.fn().mockReturnValue(pendingB.promise),
      });
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      useMidenStore.getState().setClient(clientA as never);
      const { result, rerender } = renderHook(() => useImportAccount());
      let callA!: Promise<unknown>;
      act(() => {
        callA = result.current
          .importAccount({ type: "seed", seed: new Uint8Array(32) })
          .catch((error: Error) => error);
      });
      expect(clientA.importPublicAccountFromSeed).toHaveBeenCalledTimes(1);
      expect(result.current.isImporting).toBe(true);

      act(() => {
        useMidenStore.getState().setClient(clientB as never);
        mockUseMiden.mockReturnValue({ client: clientB, isReady: true });
      });
      rerender();
      let callB!: Promise<unknown>;
      act(() => {
        callB = result.current.importAccount({
          type: "seed",
          seed: new Uint8Array(32),
        });
      });
      expect(clientB.importPublicAccountFromSeed).toHaveBeenCalledTimes(1);
      expect(result.current.isImporting).toBe(true);

      await act(async () => {
        if (outcome === "resolve") pendingA.resolve(createMockAccount());
        else pendingA.reject(new Error("replaced call failed"));
        await callA;
      });
      expect(result.current.isImporting).toBe(true);
      expect(result.current.error).toBeNull();
      expect(clientA.getAccounts).not.toHaveBeenCalled();

      await act(async () => {
        pendingB.resolve(createMockAccount());
        await callB;
      });
      expect(result.current.isImporting).toBe(false);
      expect(result.current.error).toBeNull();
    }
  );

  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useImportAccount());

      expect(result.current.account).toBeNull();
      expect(result.current.isImporting).toBe(false);
      expect(result.current.error).toBeNull();
      expect(typeof result.current.importAccount).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("import account", () => {
    it("should throw error when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useImportAccount());

      await expect(
        result.current.importAccount({
          type: "id",
          accountId: "0xaccount",
        })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("should import account from file", async () => {
      const mockAccount = createMockAccount();
      const mockAccountFile = createMockAccountFile(mockAccount);
      const mockClient = createMockWebClient({
        importAccountFile: vi.fn().mockResolvedValue("Imported account"),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useImportAccount());

      let imported;
      await act(async () => {
        imported = await result.current.importAccount({
          type: "file",
          file: mockAccountFile as unknown as AccountFile,
        });
      });

      expect(imported).toBe(mockAccount);
      expect(result.current.account).toBe(mockAccount);
      expect(mockClient.importAccountFile).toHaveBeenCalledWith(
        mockAccountFile
      );
      expect(mockClient.getAccounts).toHaveBeenCalled();
    });

    it("should ignore already tracked errors on file import", async () => {
      const mockAccount = createMockAccount();
      const mockAccountFile = createMockAccountFile(mockAccount);
      const mockClient = createMockWebClient({
        importAccountFile: vi
          .fn()
          .mockRejectedValue(
            new Error("account with id 0x123 is already being tracked")
          ),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useImportAccount());

      let imported;
      await act(async () => {
        imported = await result.current.importAccount({
          type: "file",
          file: mockAccountFile as unknown as AccountFile,
        });
      });

      expect(imported).toBe(mockAccount);
      expect(result.current.account).toBe(mockAccount);
      expect(mockClient.importAccountFile).toHaveBeenCalledWith(
        mockAccountFile
      );
    });

    it("should import account by id", async () => {
      const mockAccount = createMockAccount({
        id: vi.fn(() => createMockAccountId("0ximported")),
      });
      const mockClient = createMockWebClient({
        importAccountById: vi.fn().mockResolvedValue(undefined),
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await result.current.importAccount({
          type: "id",
          accountId: "0ximported",
        });
      });

      expect(mockClient.importAccountById).toHaveBeenCalled();
      expect(mockClient.getAccount).toHaveBeenCalled();
      expect(result.current.account).toBe(mockAccount);
    });

    it("does not cache accounts from an import after the cache generation changes", async () => {
      const mockAccount = createMockAccount();
      const staleAccounts = [createMockAccountHeader()];
      let finishAccounts!: (accounts: typeof staleAccounts) => void;
      const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
        finishAccounts = resolve;
      });
      const mockClient = createMockWebClient({
        importAccountById: vi.fn().mockResolvedValue(undefined),
        getAccount: vi.fn().mockResolvedValue(mockAccount),
        getAccounts: vi.fn().mockReturnValue(pendingAccounts),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);
      const { result } = renderHook(() => useImportAccount());

      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount({
          type: "id",
          accountId: "0x1234567890abcdef",
        });
      });
      await waitFor(() => {
        expect(mockClient.getAccounts).toHaveBeenCalledTimes(1);
      });
      expect(result.current.isImporting).toBe(true);

      const generation = useMidenStore.getState().cacheGeneration;
      act(() => {
        useMidenStore.getState().resetInMemoryState();
      });
      expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

      await act(async () => {
        finishAccounts(staleAccounts);
        await expect(importing).resolves.toBe(mockAccount);
      });

      expect(result.current.account).toBeNull();
      expect(result.current.isImporting).toBe(false);
      expect(result.current.error).toBeNull();
      expect(useMidenStore.getState().accounts).toEqual([]);
    });

    it("should import public account from seed", async () => {
      const mockAccount = createMockAccount();
      const mockClient = createMockWebClient({
        importPublicAccountFromSeed: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await result.current.importAccount({
          type: "seed",
          seed: new Uint8Array([1, 2, 3]),
          authScheme: 2,
        });
      });

      expect(mockClient.importPublicAccountFromSeed).toHaveBeenCalled();
      expect(result.current.account).toBe(mockAccount);
    });
  });

  describe("error handling", () => {
    it("should surface errors during import", async () => {
      const mockClient = createMockWebClient({
        importAccountById: vi.fn().mockRejectedValue(new Error("Not found")),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await expect(
          result.current.importAccount({
            type: "id",
            accountId: "0xmissing",
          })
        ).rejects.toThrow("Not found");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("Not found");
      });
    });
  });

  describe("reset", () => {
    it("should reset all state", async () => {
      const mockAccount = createMockAccount();
      const mockClient = createMockWebClient({
        importPublicAccountFromSeed: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await result.current.importAccount({
          type: "seed",
          seed: new Uint8Array([1, 2, 3]),
        });
      });

      expect(result.current.account).toBe(mockAccount);

      act(() => {
        result.current.reset();
      });

      expect(result.current.account).toBeNull();
      expect(result.current.isImporting).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });
});

describe("useImportAccount client ownership", () => {
  it.each(["id import", "file accounts", "file import"])(
    "stops before the next SDK call when replaced during %s",
    async (stage) => {
      const pending = deferred<unknown>();
      const imported = createMockAccount();
      const clientA = createMockWebClient({
        importAccountById: vi.fn().mockReturnValue(pending.promise),
        importAccountFile:
          stage === "file import"
            ? vi.fn().mockReturnValue(pending.promise)
            : vi.fn().mockResolvedValue("Imported account"),
        getAccount: vi.fn().mockResolvedValue(imported),
        getAccounts:
          stage === "file accounts"
            ? vi.fn().mockReturnValue(pending.promise)
            : vi.fn().mockResolvedValue([]),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount(
          stage === "id import"
            ? { type: "id", accountId: "0x1234" }
            : {
                type: "file",
                file: createMockAccountFile(imported) as unknown as AccountFile,
              }
        );
        void importing.catch(() => {});
      });
      await waitFor(() => {
        expect(
          stage === "id import"
            ? clientA.importAccountById
            : stage === "file import"
              ? clientA.importAccountFile
              : clientA.getAccounts
        ).toHaveBeenCalledTimes(1);
      });
      const accountsB = [createMockAccountHeader("0x2000000000000002")];
      act(() => {
        useMidenStore.getState().setClient(createMockWebClient() as never);
        useMidenStore.getState().setAccounts(accountsB as never);
      });
      await act(async () => {
        pending.resolve(
          stage === "file accounts"
            ? []
            : stage === "file import"
              ? "Imported account"
              : undefined
        );
        if (stage === "file import") {
          await expect(importing).resolves.toBe(imported);
        } else {
          await expect(importing).rejects.toThrow("Miden client is not ready");
        }
      });
      expect(clientA.getAccount).not.toHaveBeenCalled();
      expect(clientA.getAccounts).toHaveBeenCalledTimes(
        stage === "id import" ? 0 : 1
      );
      expect(clientA.importAccountFile).toHaveBeenCalledTimes(
        stage === "file import" ? 1 : 0
      );
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each(["id", "file", "seed"])(
    "rejects a retained %s import callback before any SDK call",
    async (type) => {
      const clientA = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(createMockAccount()),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      const saved = result.current.importAccount;
      act(() => {
        useMidenStore.getState().setClient(createMockWebClient() as never);
      });
      const options =
        type === "id"
          ? { type: "id" as const, accountId: "0x1234" }
          : type === "file"
            ? {
                type: "file" as const,
                file: createMockAccountFile() as unknown as AccountFile,
              }
            : { type: "seed" as const, seed: new Uint8Array([1, 2, 3]) };
      await act(async () => {
        await expect(saved(options)).rejects.toThrow(
          "Miden client is not ready"
        );
      });
      expect(clientA.importAccountById).not.toHaveBeenCalled();
      expect(clientA.importAccountFile).not.toHaveBeenCalled();
      expect(clientA.importPublicAccountFromSeed).not.toHaveBeenCalled();
      expect(clientA.getAccounts).not.toHaveBeenCalled();
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each(["seed", "accounts", "error"])(
    "discards a replaced client's late %s without further SDK calls or state writes",
    async (stage) => {
      const pending = deferred<unknown>();
      const imported = createMockAccount();
      const clientA = createMockWebClient({
        importPublicAccountFromSeed:
          stage === "accounts"
            ? vi.fn().mockResolvedValue(imported)
            : vi.fn().mockReturnValue(pending.promise),
        getAccounts:
          stage === "accounts"
            ? vi.fn().mockReturnValue(pending.promise)
            : vi.fn().mockResolvedValue([]),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount({
          type: "seed",
          seed: new Uint8Array([1, 2, 3]),
        });
        void importing.catch(() => {});
      });
      await waitFor(() => {
        expect(
          stage === "accounts"
            ? clientA.getAccounts
            : clientA.importPublicAccountFromSeed
        ).toHaveBeenCalledTimes(1);
      });
      const accountsB = [createMockAccountHeader("0x2000000000000002")];
      act(() => {
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(createMockWebClient() as never);
        useMidenStore.getState().setAccounts(accountsB as never);
      });
      const lateError = new Error("late import failed");
      await act(async () => {
        if (stage === "error") {
          pending.reject(lateError);
          await expect(importing).rejects.toThrow("Miden client is not ready");
        } else {
          pending.resolve(stage === "accounts" ? [] : imported);
          await expect(importing).resolves.toBe(imported);
        }
      });
      expect(clientA.getAccounts).toHaveBeenCalledTimes(
        stage === "accounts" ? 1 : 0
      );
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );
});

describe("useImportAccount cancellation fallbacks", () => {
  function replaceClient() {
    const accounts = [createMockAccountHeader("0x2000000000000002")];
    useMidenStore.getState().setClient(createMockWebClient() as never);
    useMidenStore.getState().setAccounts(accounts as never);
    return accounts;
  }

  it.each(["bytes", "buffer"])(
    "rejects after deserializing %s when no Account was obtained before replacement",
    async (format) => {
      const clientA = createMockWebClient();
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let accountsB: ReturnType<typeof replaceClient> = [];
      const file = createMockAccountFile();
      const deserialize = vi
        .spyOn(AccountFile, "deserialize")
        .mockImplementationOnce(() => {
          accountsB = replaceClient();
          return file as unknown as AccountFile;
        });
      try {
        await act(async () => {
          await expect(
            result.current.importAccount({
              type: "file",
              file:
                format === "bytes" ? new Uint8Array([1]) : new ArrayBuffer(1),
            })
          ).rejects.toThrow("Miden client is not ready");
        });
        expect(file.account).not.toHaveBeenCalled();
        expect(file.serialize).not.toHaveBeenCalled();
        expect(clientA.importAccountFile).not.toHaveBeenCalled();
        expect(clientA.getAccounts).toHaveBeenCalledTimes(1);
        expect(useMidenStore.getState().accounts).toBe(accountsB);
        expect(result.current.account).toBeNull();
        expect(result.current.error).toBeNull();
        expect(result.current.isImporting).toBe(false);
      } finally {
        deserialize.mockRestore();
      }
    }
  );

  it.each(["success", "already tracked", "error"])(
    "rejects a cancelled file import without an Account after %s",
    async (outcome) => {
      const pending = deferred<unknown>();
      const clientA = createMockWebClient({
        importAccountFile: vi.fn().mockReturnValue(pending.promise),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount({
          type: "file",
          file: {
            accountId: () => createMockAccountId("0x1234"),
            serialize: () => new Uint8Array([1]),
          } as unknown as AccountFile,
        });
        void importing.catch(() => {});
      });
      await waitFor(() =>
        expect(clientA.importAccountFile).toHaveBeenCalledTimes(1)
      );
      let accountsB!: ReturnType<typeof replaceClient>;
      act(() => {
        accountsB = replaceClient();
      });
      await act(async () => {
        if (outcome === "success") pending.resolve("Imported account");
        else
          pending.reject(
            new Error(
              outcome === "already tracked"
                ? "account is already being tracked"
                : "late file error"
            )
          );
        await expect(importing).rejects.toThrow("Miden client is not ready");
      });
      expect(clientA.getAccounts).toHaveBeenCalledTimes(1);
      expect(clientA.getAccount).not.toHaveBeenCalled();
      expect(clientA.exportAccountFile).not.toHaveBeenCalled();
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each(["already tracked", "error"])(
    "returns an embedded Account after a cancelled file import rejects with %s",
    async (outcome) => {
      const imported = createMockAccount();
      const pending = deferred<unknown>();
      const clientA = createMockWebClient({
        importAccountFile: vi.fn().mockReturnValue(pending.promise),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount({
          type: "file",
          file: createMockAccountFile(imported) as unknown as AccountFile,
        });
        void importing.catch(() => {});
      });
      await waitFor(() =>
        expect(clientA.importAccountFile).toHaveBeenCalledTimes(1)
      );
      let accountsB!: ReturnType<typeof replaceClient>;
      act(() => {
        accountsB = replaceClient();
      });
      await act(async () => {
        pending.reject(
          new Error(
            outcome === "already tracked"
              ? "account is already being tracked"
              : "late file error"
          )
        );
        await expect(importing).resolves.toBe(imported);
      });
      expect(clientA.getAccounts).toHaveBeenCalledTimes(1);
      expect(clientA.getAccount).not.toHaveBeenCalled();
      expect(clientA.exportAccountFile).not.toHaveBeenCalled();
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each(["id", "file", "seed"])(
    "returns an obtained %s Account when a cancelled refresh rejects",
    async (type) => {
      const imported = createMockAccount();
      const pending = deferred<unknown>();
      const getAccounts = vi.fn().mockReturnValue(pending.promise);
      if (type === "file") getAccounts.mockResolvedValueOnce([]);
      const clientA = createMockWebClient({
        getAccounts,
        getAccount: vi.fn().mockResolvedValue(imported),
        importPublicAccountFromSeed: vi.fn().mockResolvedValue(imported),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount(
          type === "id"
            ? { type: "id", accountId: "0x1234" }
            : type === "seed"
              ? {
                  type: "seed",
                  seed: new Uint8Array([1, 2, 3]),
                }
              : {
                  type: "file",
                  file: createMockAccountFile(
                    imported
                  ) as unknown as AccountFile,
                }
        );
        void importing.catch(() => {});
      });
      const calls = type === "file" ? 2 : 1;
      await waitFor(() => expect(getAccounts).toHaveBeenCalledTimes(calls));
      let accountsB!: ReturnType<typeof replaceClient>;
      act(() => {
        accountsB = replaceClient();
      });
      await act(async () => {
        pending.reject(new Error("late refresh error"));
        await expect(importing).resolves.toBe(imported);
      });
      expect(getAccounts).toHaveBeenCalledTimes(calls);
      expect(clientA.exportAccountFile).not.toHaveBeenCalled();
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each(["file id", "new header", "export"])(
    "publishes a current file import using the %s fallback",
    async (source) => {
      const imported = createMockAccount();
      const header = createMockAccountHeader();
      const accountsAfter = [header];
      const clientA = createMockWebClient({
        getAccounts: vi
          .fn()
          .mockResolvedValueOnce(source === "new header" ? [] : [header])
          .mockResolvedValue(accountsAfter),
        getAccount: vi.fn().mockResolvedValue(imported),
        exportAccountFile: vi
          .fn()
          .mockResolvedValue({ serialize: () => new Uint8Array([1]) }),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      await act(async () => {
        await expect(
          result.current.importAccount({
            type: "file",
            file: {
              ...(source === "file id" ? { accountId: () => header.id() } : {}),
              serialize: () => new Uint8Array([1]),
            } as unknown as AccountFile,
          })
        ).resolves.toBe(imported);
      });
      expect(clientA.getAccount.mock.calls[0][0].toString()).toBe(
        "0x1234567890abcdef"
      );
      expect(clientA.exportAccountFile).toHaveBeenCalledTimes(
        source === "export" ? 1 : 0
      );
      expect(useMidenStore.getState().accounts).toBe(accountsAfter);
      expect(result.current.account).toBe(imported);
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each(["embedded", "file id", "new header", "export"])(
    "stops after the file accounts refresh with the %s Account source",
    async (source) => {
      const pending = deferred<ReturnType<typeof createMockAccountHeader>[]>();
      const imported = createMockAccount();
      const header = createMockAccountHeader();
      const clientA = createMockWebClient({
        getAccounts: vi
          .fn()
          .mockResolvedValueOnce(source === "new header" ? [] : [header])
          .mockReturnValueOnce(pending.promise),
        getAccount: vi.fn().mockResolvedValue(imported),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      const file =
        source === "embedded"
          ? createMockAccountFile(imported)
          : {
              ...(source === "file id" ? { accountId: () => header.id() } : {}),
              serialize: () => new Uint8Array([1]),
            };
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount({
          type: "file",
          file: file as unknown as AccountFile,
        });
        void importing.catch(() => {});
      });
      await waitFor(() => expect(clientA.getAccounts).toHaveBeenCalledTimes(2));
      let accountsB!: ReturnType<typeof replaceClient>;
      act(() => {
        accountsB = replaceClient();
      });
      await act(async () => {
        pending.resolve([header]);
        if (source === "embedded")
          await expect(importing).resolves.toBe(imported);
        else
          await expect(importing).rejects.toThrow("Miden client is not ready");
      });
      expect(clientA.getAccount).not.toHaveBeenCalled();
      expect(clientA.exportAccountFile).not.toHaveBeenCalled();
      expect(clientA.getAccounts).toHaveBeenCalledTimes(2);
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each([
    { source: "id", found: true },
    { source: "id", found: false },
    { source: "file id", found: true },
    { source: "file id", found: false },
    { source: "new header", found: true },
    { source: "new header", found: false },
    { source: "export", found: true },
    { source: "export", found: false },
  ])(
    "settles a replaced $source lookup with Account found=$found",
    async ({ source, found }) => {
      const imported = createMockAccount();
      const pending = deferred<typeof imported | undefined>();
      const header = createMockAccountHeader();
      const clientA = createMockWebClient({
        getAccounts: vi
          .fn()
          .mockResolvedValueOnce(source === "new header" ? [] : [header])
          .mockResolvedValue([header]),
        getAccount: vi.fn().mockReturnValue(pending.promise),
        exportAccountFile: vi
          .fn()
          .mockResolvedValue({ serialize: () => new Uint8Array([1]) }),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount(
          source === "id"
            ? { type: "id", accountId: "0x1234" }
            : {
                type: "file",
                file: {
                  ...(source === "file id"
                    ? { accountId: () => header.id() }
                    : {}),
                  serialize: () => new Uint8Array([1]),
                } as unknown as AccountFile,
              }
        );
        void importing.catch(() => {});
      });
      await waitFor(() => expect(clientA.getAccount).toHaveBeenCalledTimes(1));
      let accountsB!: ReturnType<typeof replaceClient>;
      act(() => {
        accountsB = replaceClient();
      });
      await act(async () => {
        pending.resolve(found ? imported : undefined);
        if (found) await expect(importing).resolves.toBe(imported);
        else
          await expect(importing).rejects.toThrow("Miden client is not ready");
      });
      expect(clientA.getAccount).toHaveBeenCalledTimes(1);
      expect(clientA.getAccounts).toHaveBeenCalledTimes(
        source === "id" ? 0 : 2
      );
      expect(clientA.exportAccountFile).toHaveBeenCalledTimes(
        source === "export" ? 1 : 0
      );
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );

  it.each([true, false])(
    "stops a replaced export fallback with matching bytes=%s",
    async (matches) => {
      const pending = deferred<unknown>();
      const headers = [
        createMockAccountHeader(),
        createMockAccountHeader("0x3456"),
      ];
      const exported = {
        serialize: vi.fn(() => new Uint8Array([matches ? 1 : 2])),
      };
      const clientA = createMockWebClient({
        getAccounts: vi.fn().mockResolvedValue(headers),
        getAccount: vi.fn().mockResolvedValue(createMockAccount()),
        exportAccountFile: vi
          .fn()
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValue({ serialize: () => new Uint8Array([1]) }),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useImportAccount());
      let importing!: Promise<unknown>;
      act(() => {
        importing = result.current.importAccount({
          type: "file",
          file: {
            serialize: () => new Uint8Array([1]),
          } as unknown as AccountFile,
        });
        void importing.catch(() => {});
      });
      await waitFor(() =>
        expect(clientA.exportAccountFile).toHaveBeenCalledTimes(1)
      );
      let accountsB!: ReturnType<typeof replaceClient>;
      act(() => {
        accountsB = replaceClient();
      });
      await act(async () => {
        pending.resolve(exported);
        await expect(importing).rejects.toThrow("Miden client is not ready");
      });
      expect(exported.serialize).not.toHaveBeenCalled();
      expect(clientA.exportAccountFile).toHaveBeenCalledTimes(1);
      expect(clientA.getAccount).not.toHaveBeenCalled();
      expect(clientA.getAccounts).toHaveBeenCalledTimes(2);
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    }
  );
});
