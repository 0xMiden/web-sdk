import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useImportAccount } from "../../hooks/useImportAccount";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import type { AccountFile } from "@miden-sdk/miden-sdk/lazy";
import {
  createMockAccount,
  createMockAccountFile,
  createMockAccountId,
  createMockWebClient,
} from "../mocks/miden-sdk";

// Mock useMiden
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useImportAccount", () => {
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

    it("should import public account from seed", async () => {
      const mockAccount = createMockAccount();
      const mockClient = createMockWebClient({
        importPublicAccountFromSeed: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await result.current.importAccount({
          type: "seed",
          seed: new Uint8Array([1, 2, 3]),
          mutable: true,
          authScheme: "falcon",
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

  describe("branch coverage gaps", () => {
    it("should fall back to bytesEqual scan when accountFromFile is null and no new header (lines 228-241)", async () => {
      const mockAccount = createMockAccount({
        id: vi.fn(() => createMockAccountId("0xexisting")),
      });

      // Create an account file that has no .account() method
      const mockFileNoAccount = {
        free: vi.fn(),
        serialize: vi.fn(() => new Uint8Array([9, 8, 7])),
        // No account() or accountId() method — drives accountFromFile = null
      } as unknown as AccountFile;

      // exportAccountFile returns a file whose bytes match the imported file
      const matchingExportedFile = {
        serialize: vi.fn(() => new Uint8Array([9, 8, 7])),
        free: vi.fn(),
      };

      const accountId0 = { id: vi.fn(() => createMockAccountId("0xexisting")), free: vi.fn() };

      const mockClient = createMockWebClient({
        getAccounts: vi
          .fn()
          .mockResolvedValueOnce([accountId0])  // before
          .mockResolvedValueOnce([accountId0]), // after
        importAccountFile: vi.fn().mockResolvedValue("Imported"),
        exportAccountFile: vi.fn().mockResolvedValue(matchingExportedFile),
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      let imported;
      await act(async () => {
        imported = await result.current.importAccount({
          type: "file",
          file: mockFileNoAccount,
        });
      });

      expect(imported).toBe(mockAccount);
    });

    it("should throw Account not found when all fallbacks fail (line ~146)", async () => {
      // account file with no .account() and serialize returns non-matching bytes
      const mockFileNoAccount = {
        free: vi.fn(),
        serialize: vi.fn(() => new Uint8Array([1, 2, 3])),
      } as unknown as AccountFile;

      const nonMatchingExport = {
        serialize: vi.fn(() => new Uint8Array([9, 9, 9])), // different bytes
        free: vi.fn(),
      };

      const accountId0 = { id: vi.fn(() => createMockAccountId("0xold")), free: vi.fn() };

      const mockClient = createMockWebClient({
        getAccounts: vi
          .fn()
          .mockResolvedValueOnce([accountId0])
          .mockResolvedValueOnce([accountId0]),
        importAccountFile: vi.fn().mockResolvedValue("Imported"),
        exportAccountFile: vi.fn().mockResolvedValue(nonMatchingExport),
        getAccount: vi.fn().mockResolvedValue(null),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await expect(
          result.current.importAccount({
            type: "file",
            file: mockFileNoAccount,
          })
        ).rejects.toThrow("Account not found after import");
      });
    });

    it("should propagate file import errors that are not 'already being tracked' (line 109)", async () => {
      const mockAccount = createMockAccount();
      const mockAccountFile = createMockAccountFile(mockAccount);
      const mockClient = createMockWebClient({
        importAccountFile: vi
          .fn()
          .mockRejectedValue(new Error("Some other error")),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await expect(
          result.current.importAccount({
            type: "file",
            file: mockAccountFile as unknown as AccountFile,
          })
        ).rejects.toThrow("Some other error");
      });
    });

    it("should throw Account not found when getAccount returns null for id type (line 152-154)", async () => {
      const mockClient = createMockWebClient({
        importAccountById: vi.fn().mockResolvedValue(undefined),
        getAccount: vi.fn().mockResolvedValue(null),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await expect(
          result.current.importAccount({
            type: "id",
            accountId: "0xmissing",
          })
        ).rejects.toThrow("Account not found after import");
      });
    });

    it("should use default mutable when not provided for seed type (line 158)", async () => {
      const mockAccount = createMockAccount();
      const mockClient = createMockWebClient({
        importPublicAccountFromSeed: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      await act(async () => {
        await result.current.importAccount({
          type: "seed",
          seed: new Uint8Array([1, 2, 3]),
          // mutable not provided - uses DEFAULTS.WALLET_MUTABLE
        });
      });

      expect(mockClient.importPublicAccountFromSeed).toHaveBeenCalled();
    });

    it("should resolve account via accountIdFromFile when file has accountId() method (lines 127-131)", async () => {
      const targetAccount = createMockAccount({
        id: vi.fn(() => createMockAccountId("0xtarget")),
      });

      // File with no account() but has accountId() — drives accountIdFromFile branch
      const mockFileWithAccountId = {
        free: vi.fn(),
        serialize: vi.fn(() => new Uint8Array([1, 2, 3])),
        accountId: vi.fn(() => createMockAccountId("0xtarget")),
      } as unknown as AccountFile;

      const mockClient = createMockWebClient({
        getAccounts: vi.fn().mockResolvedValue([]),
        importAccountFile: vi.fn().mockResolvedValue("Imported"),
        getAccount: vi.fn().mockResolvedValue(targetAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      let imported;
      await act(async () => {
        imported = await result.current.importAccount({
          type: "file",
          file: mockFileWithAccountId,
        });
      });

      expect(imported).toBe(targetAccount);
    });

    it("should accept Uint8Array file input (getAccountFileBytes Uint8Array path)", async () => {
      const innerAccount = createMockAccount({
        id: vi.fn(() => createMockAccountId("0xbytesfile")),
      });

      const mockClient = createMockWebClient({
        getAccounts: vi.fn().mockResolvedValue([]),
        importAccountFile: vi.fn().mockResolvedValue("Imported"),
        getAccount: vi.fn().mockResolvedValue(innerAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      let imported;
      await act(async () => {
        imported = await result.current.importAccount({
          type: "file",
          file: new Uint8Array([1, 2, 3]) as unknown as AccountFile,
        });
      });

      // AccountFile.deserialize is called from mock, so it returns a mock AccountFile
      // and the import proceeds normally
      expect(imported).toBeTruthy();
    });

    it("should return accountFromFile when account() method exists on file (lines 115-116)", async () => {
      const innerAccount = createMockAccount({
        id: vi.fn(() => createMockAccountId("0xinnerfile")),
      });

      // Mock account file object with account() returning our account
      const mockFileWithAccount = {
        free: vi.fn(),
        serialize: vi.fn(() => new Uint8Array([1, 2])),
        account: vi.fn(() => innerAccount),
      } as unknown as AccountFile;

      const mockClient = createMockWebClient({
        getAccounts: vi.fn().mockResolvedValue([]),
        importAccountFile: vi.fn().mockResolvedValue("Imported"),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useImportAccount());

      let imported;
      await act(async () => {
        imported = await result.current.importAccount({
          type: "file",
          file: mockFileWithAccount,
        });
      });

      expect(imported).toBe(innerAccount);
    });
  });
});
