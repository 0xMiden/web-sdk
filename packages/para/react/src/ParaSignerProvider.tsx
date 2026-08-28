import "@getpara/react-sdk-lite/styles.css";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
  type Context,
  type ReactNode,
} from "react";
import { ParaWeb, Environment, type Wallet } from "@getpara/web-sdk";
import {
  ParaProvider,
  useClient,
  useAccount as useParaAccount,
  useModal,
  useLogout,
  type ParaProviderProps,
} from "@getpara/react-sdk-lite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SignerContext as SignerContextUnsafe,
  type SignerContextValue,
  type SignerAccountConfig,
} from "@miden-sdk/react";

// Re-cast SignerContext to this package's React typings.
//
// WHY: this workspace installs TWO @types/react. packages/react-sdk declares
// `@types/react` as a devDependency at `^18.2.0`; every adopted package here
// declares `^19` (adapter/react and turnkey/react `^19.0.0`, para/react
// `^19.2.5`). With `node-linker=isolated` (see .npmrc) pnpm materializes both
// — @types/react@18.3.28 and @types/react@19.2.18 — and links the 18.x copy
// into packages/react-sdk/node_modules. TypeScript resolves the bare `react`
// import inside packages/react-sdk/dist/index.d.ts relative to that file, so
// `SignerContext` arrives typed by 18.3.28 while everything in this file is
// typed by 19.2.18. The two genuinely disagree: React 19's `ReactNode` admits
// `bigint` and its `Context<T>` carries `$$typeof`; React 18's do neither.
// Drop the cast and tsc reports exactly this pair (verified by removing it):
//   TS2322  Type 'React.ReactNode' is not assignable to type
//           '...@types+react@18.3.28...ReactNode' — 'bigint' is not assignable
//   TS2345  Property '$$typeof' is missing in type
//           '...@types+react@18.3.28...Context<SignerContextValue | null>'
//
// The cast is safe: there is one React context object at runtime and only the
// .d.ts identities differ.
//
// THE REAL FIX is to make a single @types/react serve both sides: bump
// packages/react-sdk's @types/react DEVDEPENDENCY to the major the adopted
// packages use, or pin @types/react via `pnpm.overrides` in the root
// package.json. The devDependency is what decides which copy types the
// emitted .d.ts, so that is the knob.
//
// NOT the fix, despite what an earlier version of this comment claimed:
// widening a @types/react PEER range. packages/adapter/react already carries
// `"@types/react": "^18.0.0 || ^19.0.0"` in peerDependencies (optional), and
// it changes nothing — peer ranges do not decide what pnpm installs.
// adapter/react still resolves 19.2.18 and still needs this same cast.
//
// SCOPE: this is a workspace-local type-identity split, not a consumer bug.
// No published package here depends on @types/react — react-sdk has it only
// as a devDependency, which npm never installs for consumers, and its
// published manifest lists neither a dependency nor a peer on it — so an
// installed consumer resolves the single copy their own app provides. The
// fix above is deferred because @miden-sdk/react is already published at
// 0.16.0-rc.5 and this branch is a release repair: changing what its
// declarations are built against is out of scope here.
const SignerContext =
  SignerContextUnsafe as unknown as Context<SignerContextValue | null>;
import {
  signCb as createSignCb,
  type CustomSignConfirmStep,
} from "@miden-sdk/para";
import {
  evmPkToCommitment,
  getUncompressedPublicKeyFromWallet,
} from "@miden-sdk/para";

// Re-export Para hooks for convenience
export { useModal, useLogout } from "@getpara/react-sdk-lite";

const defaultQueryClient = new QueryClient();

// PARA SIGNER PROVIDER
// ================================================================================================

/** Environment string values accepted by ParaSignerProvider */
/** @public */
export type ParaEnvironment =
  | "BETA"
  | "PROD"
  | "SANDBOX"
  | "DEV"
  | "DEVELOPMENT"
  | "PRODUCTION";

/**
 * Convert environment string to Environment enum value.
 * Handles the mapping safely for both ESM and CJS environments.
 */
function getEnvironmentValue(env: ParaEnvironment): Environment {
  // Handle aliases
  const normalizedEnv =
    env === "DEVELOPMENT" ? "BETA" : env === "PRODUCTION" ? "PROD" : env;

  // Try accessing the enum - Environment may be undefined in some test environments
  if (Environment && typeof Environment === "object") {
    const value = Environment[normalizedEnv as keyof typeof Environment];
    if (value !== undefined) return value;
  }

  // Fallback: return the string directly (Para SDK may accept string values)
  return normalizedEnv as unknown as Environment;
}

export interface ParaSignerProviderProps {
  children: ReactNode;
  /** Para API key */
  apiKey: string;
  /** Para environment (BETA, PROD, SANDBOX, DEV, DEVELOPMENT, PRODUCTION) */
  environment: ParaEnvironment;
  /** App name displayed in Para modal */
  appName?: string;
  /** Whether to show the signing modal for transaction confirmation */
  showSigningModal?: boolean;
  /** Custom sign confirmation step callback */
  customSignConfirmStep?: CustomSignConfirmStep;
  /**
   * Optional custom QueryClient instance for React Query.
   * If not provided, a default instance is used internally.
   */
  queryClient?: QueryClient;
  /**
   * Advanced: Additional config to pass to ParaProvider.
   * Use this for customizing OAuth methods, external wallets, etc.
   */
  paraProviderConfig?: Partial<
    Omit<ParaProviderProps<any, any>, "children" | "paraClientConfig">
  >;
  /** Optional custom account components to include in the account (e.g. from a compiled .masp package) */
  customComponents?: SignerAccountConfig["customComponents"];
  /** Optional account ID to import instead of creating a new account */
  importAccountId?: string;
}

/**
 * Para-specific extras exposed via useParaSigner hook.
 */
export interface ParaSignerExtras {
  /** Para client instance */
  para: ParaWeb;
  /** Connected wallet (null if not connected) */
  wallet: Wallet | null;
}

const ParaSignerExtrasContext = createContext<ParaSignerExtras | null>(null);

/**
 * ParaSignerProvider wraps MidenProvider to enable Para wallet signing.
 * Includes ParaProvider internally, so you don't need to wrap with it separately.
 *
 * @example
 * ```tsx
 * <ParaSignerProvider apiKey="your-api-key" environment="BETA" appName="My App">
 *   <MidenProvider config={{ rpcUrl: "testnet" }}>
 *     <App />
 *   </MidenProvider>
 * </ParaSignerProvider>
 * ```
 */
export function ParaSignerProvider({
  children,
  apiKey,
  environment,
  appName = "Miden App",
  showSigningModal = true,
  customSignConfirmStep,
  queryClient,
  paraProviderConfig,
  customComponents,
  importAccountId,
}: ParaSignerProviderProps) {
  return (
    <QueryClientProvider client={queryClient ?? defaultQueryClient}>
      <ParaProvider
        paraClientConfig={{
          env: getEnvironmentValue(environment),
          apiKey,
        }}
        config={{ appName }}
        {...paraProviderConfig}
      >
        <ParaSignerProviderInner
          showSigningModal={showSigningModal}
          customSignConfirmStep={customSignConfirmStep}
          customComponents={customComponents}
          importAccountId={importAccountId}
        >
          {children}
        </ParaSignerProviderInner>
      </ParaProvider>
    </QueryClientProvider>
  );
}

/**
 * Inner component that has access to ParaProvider context (useModal, etc.)
 */
function ParaSignerProviderInner({
  children,
  showSigningModal = true,
  customSignConfirmStep,
  customComponents,
  importAccountId,
}: Pick<
  ParaSignerProviderProps,
  | "children"
  | "showSigningModal"
  | "customSignConfirmStep"
  | "customComponents"
  | "importAccountId"
>) {
  // Access Para modal from ParaProvider.
  // Store in refs to avoid re-render loops (these hooks return new objects each render).
  const { openModal, closeModal } = useModal();
  const { logoutAsync } = useLogout();
  const openModalRef = useRef(openModal);
  const closeModalRef = useRef(closeModal);
  const logoutAsyncRef = useRef(logoutAsync);
  useEffect(() => {
    openModalRef.current = openModal;
  }, [openModal]);
  useEffect(() => {
    closeModalRef.current = closeModal;
  }, [closeModal]);
  useEffect(() => {
    logoutAsyncRef.current = logoutAsync;
  }, [logoutAsync]);

  // Get the Para client from ParaProvider context (avoids creating a duplicate instance).
  // Store in a ref so downstream effects don't re-fire when the hook returns a new wrapper.
  const para = useClient()!;
  const paraRef = useRef(para);
  useEffect(() => {
    paraRef.current = para;
  }, [para]);

  // Keep props in refs so buildContext doesn't re-run when parent re-renders with new closures.
  const showSigningModalRef = useRef(showSigningModal);
  const customSignConfirmStepRef = useRef(customSignConfirmStep);
  useEffect(() => {
    showSigningModalRef.current = showSigningModal;
  }, [showSigningModal]);
  useEffect(() => {
    customSignConfirmStepRef.current = customSignConfirmStep;
  }, [customSignConfirmStep]);

  // Use Para SDK's reactive useAccount() hook to detect login state.
  // This subscribes to the internal state machine instead of polling isFullyLoggedIn().
  const { isConnected: paraIsConnected, embedded } = useParaAccount();
  const evmWallets = embedded?.wallets?.filter((w) => w.type === "EVM") ?? [];
  const wallet =
    evmWallets.length > 0 ? (evmWallets[0] as unknown as Wallet) : null;
  const isConnected = paraIsConnected && wallet !== null;

  // Close the modal when login is detected
  useEffect(() => {
    if (isConnected) {
      closeModalRef.current();
    }
  }, [isConnected]);

  // Connect opens the Para modal
  const connect = useCallback(async () => {
    openModalRef.current();
  }, []);

  // Disconnect logs out from Para
  const disconnect = useCallback(async () => {
    await logoutAsyncRef.current();
    await paraRef.current.logout();
  }, []);

  // Build signer context (includes connect/disconnect for unified useSigner hook).
  // Only depends on isConnected and wallet — everything else is accessed via refs
  // so that MidenProvider doesn't see a new context object on every poll cycle.
  //
  // IMPORTANT: initialise with a disconnected placeholder (isConnected:false) rather
  // than null.  When signerContext is null MidenProvider creates a local-keystore
  // client whose auto-sync accesses the WASM module; our buildContext also touches
  // WASM (evmPkToCommitment / AccountStorageMode) → concurrent WASM access → crash.
  // A {isConnected:false} context makes MidenProvider's init effect return early
  // without creating any client, keeping the WASM module free for buildContext.
  const disconnectedCtx = useRef<SignerContextValue>({
    signCb: async () => {
      throw new Error("Para wallet not connected");
    },
    accountConfig: null as any,
    storeName: "",
    name: "Para",
    isConnected: false,
    connect,
    disconnect,
  });
  const [signerContext, setSignerContext] = useState<SignerContextValue>(
    disconnectedCtx.current
  );

  useEffect(() => {
    let cancelled = false;

    async function buildContext() {
      if (!isConnected || !wallet) {
        setSignerContext(disconnectedCtx.current);
        return;
      }

      try {
        // Connected - build full context with signing capability
        const p = paraRef.current;
        const publicKey = await getUncompressedPublicKeyFromWallet(p, wallet);
        if (!publicKey) throw new Error("Failed to get public key from wallet");
        const commitment = await evmPkToCommitment(publicKey);

        // Serialize the commitment Word to Uint8Array for SignerAccountConfig
        const commitmentBytes = commitment.serialize();

        const signCallback = createSignCb(
          p,
          wallet,
          showSigningModalRef.current,
          customSignConfirmStepRef.current
        );

        if (!cancelled) {
          const { AccountStorageMode } = await import("@miden-sdk/miden-sdk");

          setSignerContext({
            signCb: signCallback,
            accountConfig: {
              publicKeyCommitment: commitmentBytes,
              storageMode: AccountStorageMode.public(),
              ...(customComponents?.length ? { customComponents } : {}),
              ...(importAccountId ? { importAccountId } : {}),
            },
            storeName: `para_${wallet.id}`,
            name: "Para",
            isConnected: true,
            connect,
            disconnect,
          });
        }
      } catch (error) {
        console.error("Failed to build Para signer context:", error);
        if (!cancelled) {
          setSignerContext(disconnectedCtx.current);
        }
      }
    }

    buildContext();
    return () => {
      cancelled = true;
    };
  }, [isConnected, wallet, connect, disconnect]);

  return (
    <ParaSignerExtrasContext.Provider value={{ para, wallet }}>
      <SignerContext.Provider value={signerContext}>
        {children}
      </SignerContext.Provider>
    </ParaSignerExtrasContext.Provider>
  );
}

/**
 * Hook for Para-specific extras beyond the unified useSigner interface.
 * Use this to access the Para client or wallet details directly.
 *
 * @example
 * ```tsx
 * const { para, wallet, isConnected } = useParaSigner();
 * ```
 */
export function useParaSigner(): ParaSignerExtras & { isConnected: boolean } {
  const extras = useContext(ParaSignerExtrasContext);
  const signer = useContext(SignerContext);
  if (!extras) {
    throw new Error("useParaSigner must be used within ParaSignerProvider");
  }
  return { ...extras, isConnected: signer?.isConnected ?? false };
}
