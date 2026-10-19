import { create } from "zustand";
import type {
  WasmWebClient as WebClient,
  Account,
  AccountHeader,
  InputNoteRecord,
  ConsumableNoteRecord,
} from "@miden-sdk/miden-sdk";
import type { SyncState, MidenConfig, AssetMetadata } from "../types";

interface MidenStoreState {
  // Client state
  client: WebClient | null;
  isReady: boolean;
  isInitializing: boolean;
  initError: Error | null;
  config: MidenConfig;

  // Signer connection state (null = no signer provider)
  signerConnected: boolean | null;

  // Sync state
  sync: SyncState;
  syncPaused: boolean;

  // Cached data
  accounts: AccountHeader[];
  accountDetails: Map<string, Account>;
  notesByFilter: Map<string, InputNoteRecord[]>;
  consumableNotesByAccount: Map<string, ConsumableNoteRecord[]>;
  assetMetadata: Map<string, AssetMetadata>;

  // Temporal note tracking — records when each note ID was first observed
  noteFirstSeen: Map<string, number>;

  // Advanced by every reset, so a fetch can tell its result belongs to a cache
  // that no longer exists.
  cacheGeneration: number;

  // Loading states
  isLoadingAccounts: boolean;
  isLoadingNotes: boolean;

  loadingAccountsToken: number;
  loadingNotesToken: number;
  syncToken: number;
  initializingToken: number;

  // Actions
  setClient: (client: WebClient | null) => void;
  setInitializing: (isInitializing: boolean) => void;
  setInitError: (error: Error | null) => void;
  setConfig: (config: MidenConfig) => void;
  setSignerConnected: (connected: boolean | null) => void;

  setSyncState: (sync: Partial<SyncState>) => void;
  setSyncPaused: (paused: boolean) => void;

  setAccounts: (accounts: AccountHeader[]) => void;
  setAccountDetails: (accountId: string, account: Account) => void;
  setNotes: (notes: InputNoteRecord[], filterKey: string) => void;
  setNotesIfChanged: (notes: InputNoteRecord[], filterKey: string) => void;
  setConsumableNotes: (
    notes: ConsumableNoteRecord[],
    accountIdKey: string
  ) => void;
  setConsumableNotesIfChanged: (
    notes: ConsumableNoteRecord[],
    accountIdKey: string
  ) => void;
  setAssetMetadata: (assetId: string, metadata: AssetMetadata) => void;

  beginLoadingAccounts: () => number;
  endLoadingAccounts: (token: number) => void;
  beginLoadingNotes: () => number;
  endLoadingNotes: (token: number) => void;
  beginSync: () => number;
  endSync: (token: number) => void;
  beginInitializing: () => number;
  endInitializing: (token: number) => void;

  setLoadingAccounts: (isLoading: boolean) => void;
  setLoadingNotes: (isLoading: boolean) => void;

  /** Clear cached data (accounts, notes, metadata, sync) but keep client, isReady, and config */
  resetInMemoryState: () => void;
  reset: () => void;
}

const initialSyncState: SyncState = {
  syncHeight: 0,
  isSyncing: false,
  lastSyncTime: null,
  error: null,
};

function freshCachedState() {
  return {
    sync: { ...initialSyncState },

    syncPaused: false,

    accounts: [] as AccountHeader[],
    accountDetails: new Map<string, Account>(),
    notesByFilter: new Map<string, InputNoteRecord[]>(),
    consumableNotesByAccount: new Map<string, ConsumableNoteRecord[]>(),
    assetMetadata: new Map<string, AssetMetadata>(),
    noteFirstSeen: new Map<string, number>(),

    isLoadingAccounts: false,
    isLoadingNotes: false,
  };
}

function freshState() {
  return {
    client: null as WebClient | null,
    isReady: false,
    isInitializing: false,
    initError: null as Error | null,
    config: {} as MidenConfig,
    signerConnected: null as boolean | null,

    ...freshCachedState(),
    cacheGeneration: 0,
    loadingAccountsToken: 0,
    loadingNotesToken: 0,
    syncToken: 0,
    initializingToken: 0,
  };
}

export const useMidenStore = create<MidenStoreState>()((set, get) => ({
  ...freshState(),

  setClient: (client) =>
    set({
      client,
      isReady: client !== null,
      isInitializing: false,
      initError: null,
    }),

  setInitializing: (isInitializing) => set({ isInitializing }),

  setInitError: (initError) =>
    set({
      initError,
      isInitializing: false,
      isReady: false,
    }),

  setConfig: (config) => set({ config }),

  setSignerConnected: (signerConnected) => set({ signerConnected }),

  setSyncState: (sync) =>
    set((state) => ({
      sync: { ...state.sync, ...sync },
    })),

  setSyncPaused: (syncPaused) => set({ syncPaused }),

  setAccounts: (accounts) => set({ accounts }),

  setAccountDetails: (accountId, account) =>
    set((state) => {
      const newMap = new Map(state.accountDetails);
      newMap.set(accountId, account);
      return { accountDetails: newMap };
    }),

  setNotes: (notes, filterKey) =>
    set((state) => {
      const newNotesByFilter = new Map(state.notesByFilter);
      newNotesByFilter.set(filterKey, notes);

      const now = Date.now();
      const newFirstSeen = new Map<string, number>();

      for (const [, noteList] of newNotesByFilter) {
        for (const note of noteList) {
          try {
            const id = note.id()!.toString();
            newFirstSeen.set(id, state.noteFirstSeen.get(id) ?? now);
          } catch {
            // Skip if id() fails
          }
        }
      }

      return {
        notesByFilter: newNotesByFilter,
        noteFirstSeen: newFirstSeen,
      };
    }),

  setNotesIfChanged: (notes, filterKey) =>
    set((state) => {
      const safeId = (n: InputNoteRecord): string | null => {
        try {
          return n.id()!.toString();
        } catch {
          return null;
        }
      };
      const prevNotes = state.notesByFilter.get(filterKey) ?? [];
      const prevIds = new Set<string>();
      for (const n of prevNotes) {
        const id = safeId(n);
        if (id) prevIds.add(id);
      }
      const newIds = new Set<string>();
      for (const n of notes) {
        const id = safeId(n);
        if (id) newIds.add(id);
      }
      if (
        state.notesByFilter.has(filterKey) &&
        prevIds.size === newIds.size &&
        [...prevIds].every((id) => newIds.has(id))
      ) {
        return {};
      }

      const newNotesByFilter = new Map(state.notesByFilter);
      newNotesByFilter.set(filterKey, notes);

      const now = Date.now();
      const newFirstSeen = new Map<string, number>();

      for (const [, noteList] of newNotesByFilter) {
        for (const note of noteList) {
          try {
            const id = note.id()!.toString();
            newFirstSeen.set(id, state.noteFirstSeen.get(id) ?? now);
          } catch {
            // Skip
          }
        }
      }

      return {
        notesByFilter: newNotesByFilter,
        noteFirstSeen: newFirstSeen,
      };
    }),

  setConsumableNotes: (consumableNotes, accountIdKey) =>
    set((state) => {
      const newMap = new Map(state.consumableNotesByAccount);
      newMap.set(accountIdKey, consumableNotes);
      return { consumableNotesByAccount: newMap };
    }),

  setConsumableNotesIfChanged: (consumableNotes, accountIdKey) =>
    set((state) => {
      const safeId = (n: ConsumableNoteRecord): string | null => {
        try {
          return n.inputNoteRecord().id()!.toString();
        } catch {
          return null;
        }
      };
      const prevNotes = state.consumableNotesByAccount.get(accountIdKey) ?? [];
      const prevIds = new Set<string>();
      for (const n of prevNotes) {
        const id = safeId(n);
        if (id) prevIds.add(id);
      }
      const newIds = new Set<string>();
      for (const n of consumableNotes) {
        const id = safeId(n);
        if (id) newIds.add(id);
      }
      if (
        state.consumableNotesByAccount.has(accountIdKey) &&
        prevIds.size === newIds.size &&
        [...prevIds].every((id) => newIds.has(id))
      ) {
        return {};
      }
      const newMap = new Map(state.consumableNotesByAccount);
      newMap.set(accountIdKey, consumableNotes);
      return { consumableNotesByAccount: newMap };
    }),

  setAssetMetadata: (assetId, metadata) =>
    set((state) => {
      const newMap = new Map(state.assetMetadata);
      newMap.set(assetId, metadata);
      return { assetMetadata: newMap };
    }),

  beginLoadingAccounts: () => {
    const token = get().loadingAccountsToken + 1;
    set({ loadingAccountsToken: token, isLoadingAccounts: true });
    return token;
  },

  endLoadingAccounts: (token) =>
    set((state) =>
      state.loadingAccountsToken === token ? { isLoadingAccounts: false } : {}
    ),

  beginLoadingNotes: () => {
    const token = get().loadingNotesToken + 1;
    set({ loadingNotesToken: token, isLoadingNotes: true });
    return token;
  },

  endLoadingNotes: (token) =>
    set((state) =>
      state.loadingNotesToken === token ? { isLoadingNotes: false } : {}
    ),

  beginSync: () => {
    const token = get().syncToken + 1;
    set({
      syncToken: token,
      sync: { ...get().sync, isSyncing: true, error: null },
    });
    return token;
  },

  endSync: (token) =>
    set((state) =>
      state.syncToken === token
        ? { sync: { ...state.sync, isSyncing: false } }
        : {}
    ),

  beginInitializing: () => {
    const token = get().initializingToken + 1;
    set({ initializingToken: token, isInitializing: true });
    return token;
  },

  endInitializing: (token) =>
    set((state) =>
      state.initializingToken === token ? { isInitializing: false } : {}
    ),

  setLoadingAccounts: (isLoadingAccounts) => set({ isLoadingAccounts }),

  setLoadingNotes: (isLoadingNotes) => set({ isLoadingNotes }),

  resetInMemoryState: () =>
    set((state) => ({
      ...freshCachedState(),
      cacheGeneration: state.cacheGeneration + 1,
      loadingAccountsToken: state.loadingAccountsToken + 1,
      loadingNotesToken: state.loadingNotesToken + 1,
      syncToken: state.syncToken + 1,
    })),

  reset: () =>
    set((state) => ({
      ...freshState(),
      initializingToken: state.initializingToken + 1,
      cacheGeneration: state.cacheGeneration + 1,
      loadingAccountsToken: state.loadingAccountsToken + 1,
      loadingNotesToken: state.loadingNotesToken + 1,
      syncToken: state.syncToken + 1,
    })),
}));

export function captureClientCurrency(client: WebClient): () => boolean {
  const { cacheGeneration } = useMidenStore.getState();
  return () => {
    const state = useMidenStore.getState();
    return state.client === client && state.cacheGeneration === cacheGeneration;
  };
}

const EMPTY_INPUT_NOTES: InputNoteRecord[] = [];
const EMPTY_CONSUMABLE_NOTES: ConsumableNoteRecord[] = [];

// Selector hooks for optimal re-renders
export const useSignerConnected = () =>
  useMidenStore((state) => state.signerConnected);
export const useIsInitializing = () =>
  useMidenStore((state) => state.isInitializing);
export const useSyncStateStore = () => useMidenStore((state) => state.sync);
export const useAccountsStore = () => useMidenStore((state) => state.accounts);
export const useNotesStore = (filterKey: string) =>
  useMidenStore(
    (state) => state.notesByFilter.get(filterKey) ?? EMPTY_INPUT_NOTES
  );
export const useConsumableNotesStore = (accountIdKey: string) =>
  useMidenStore(
    (state) =>
      state.consumableNotesByAccount.get(accountIdKey) ?? EMPTY_CONSUMABLE_NOTES
  );
export const useAssetMetadataStore = () =>
  useMidenStore((state) => state.assetMetadata);
export const useNoteFirstSeenStore = () =>
  useMidenStore((state) => state.noteFirstSeen);
