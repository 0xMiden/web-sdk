import type { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk";
import type { SignerAccountConfig } from "../context/SignerContext";
import { parseAccountId } from "./accountParsing";

// SIGNER ACCOUNT INITIALIZATION
// ================================================================================================

/**
 * Checks if the storage mode represents a private account.
 */
function isPrivateStorageMode(
  storageMode: import("@miden-sdk/miden-sdk").AccountStorageMode
): boolean {
  // AccountStorageMode.toString() returns "private" or "public" (the 0.15
  // protocol surface no longer carries a separate "network" storage mode).
  return storageMode.toString() === "private";
}

/**
 * Initializes an account from signer configuration.
 *
 * This function:
 * 1. Syncs the client state
 * 2. Builds an account with the signer's public key commitment as the auth component
 * 3. Attempts to import from chain if public/network storage mode
 * 4. Creates the account locally if it doesn't exist
 *
 * When `importAccountId` is set on the config, steps 2-4 are skipped entirely
 * and the account is imported from the chain by ID. This is the fast path for
 * wallets that create accounts externally (e.g., via a vault with HD key
 * derivation) and already know the on-chain account ID.
 *
 * Why import is needed even though the signer "owns" the account: with an
 * external signer the keys live in the vault, not in this client's store, and
 * the store is per-device — on a fresh device/browser it has no record of the
 * account even though the signer can sign for it. `syncState()` only refreshes
 * accounts the store already tracks; it does not discover an account by ID. So
 * `importAccountById` is how an untracked-but-externally-owned account gets
 * registered locally. The slow path doesn't need it because it rebuilds the
 * account from the public-key commitment + seed and tracks it via `newAccount`;
 * the fast path is for signers (e.g. MidenFi) that hand over only the ID and
 * cannot reconstruct those creation parameters.
 *
 * @param client - The WebClient instance
 * @param config - The signer account configuration
 * @returns The account ID as a string
 */
export async function initializeSignerAccount(
  client: WebClient,
  config: SignerAccountConfig
): Promise<string> {
  const { AccountBuilder, AccountComponent, AuthScheme, Word } = await import(
    "@miden-sdk/miden-sdk"
  );

  // Sync first to get latest state
  await client.syncState();

  // Fast path: import existing account by ID instead of rebuilding from scratch.
  if (config.importAccountId) {
    const accountId = parseAccountId(config.importAccountId);
    try {
      await client.importAccountById(accountId);
    } catch (e) {
      // The WASM boundary attaches a stable, machine-readable `code` to the JS
      // error for the ClientError variants callers branch on (see
      // `code_from_error` in crates/web-client/src/lib.rs); it survives the
      // worker shim. We match on that code rather than the changeable message.
      const code = (e as { code?: string } | null | undefined)?.code;
      // Tolerate two benign cases; rethrow anything else (e.g. a real network
      // failure) so genuine problems still surface as an init error.
      //
      // - AccountNotFoundOnChain: the account is fresh — a brand-new wallet whose
      //   account isn't registered on-chain yet. Expected, not fatal: rethrowing
      //   errors out MidenProvider and leaves new users unable to do anything —
      //   a catch-22, since registering the account on-chain is exactly what
      //   they're blocked from. Tolerating it lets the dApp render. Note the
      //   account is NOT tracked locally as a result (we only have its ID, not
      //   the object), so useAccount(accountId) returns null and a transaction
      //   can't be built against it yet. It becomes usable once it is registered
      //   on-chain and a later importAccountById() succeeds — syncState() only
      //   refreshes already-tracked accounts, so it won't import this one by ID.
      // - AccountAlreadyTracked: the account is already imported locally.
      //   Defensive — this import path overwrites, so it shouldn't normally
      //   surface, but tolerating it is harmless.
      const isFreshAccount = code === "ACCOUNT_NOT_FOUND_ON_CHAIN";
      const isAlreadyTracked = code === "ACCOUNT_ALREADY_TRACKED";
      if (!isAlreadyTracked && !isFreshAccount) {
        throw e;
      }
    }
    await client.syncState();
    return config.importAccountId;
  }

  // Convert Uint8Array commitment to Word (required by SDK)
  const commitmentWord = Word.deserialize(config.publicKeyCommitment);

  // Build account with auth component from public key commitment.
  //
  // `config.accountType` is intentionally not forwarded to the builder: AccountType
  // is a 2-way storage flag (Private / Public), so visibility is fully determined by
  // `storageMode`. The field is retained on the config for back-compat.
  const seed = config.accountSeed ?? crypto.getRandomValues(new Uint8Array(32));

  let builder = new AccountBuilder(seed)
    .withAuthComponent(
      AccountComponent.createAuthComponentFromCommitment(
        commitmentWord,
        AuthScheme.AuthEcdsaK256Keccak
      )
    )
    .storageMode(config.storageMode)
    .withBasicWalletComponent();

  // Add any custom components (e.g. from compiled .masp packages)
  if (config.customComponents?.length) {
    for (const component of config.customComponents) {
      if (
        component == null ||
        typeof (component as any).getProcedures !== "function"
      ) {
        throw new Error(
          "Each entry in customComponents must be an AccountComponent instance created via " +
            "AccountComponent.compile(), AccountComponent.fromPackage(), or AccountComponent.fromLibrary()."
        );
      }
      builder = builder.withComponent(component);
    }
  }

  const buildResult = builder.build();

  const account = buildResult.account;
  const accountId = account.id();

  // For public/network accounts, try to import from chain first
  if (!isPrivateStorageMode(config.storageMode)) {
    try {
      await client.importAccountById(accountId);
      // Account imported successfully from chain
      await client.syncState();
      return accountId.toString();
    } catch {
      // Account doesn't exist on-chain yet, will create locally
    }
  }

  // Check if account already exists locally
  try {
    const existing = await client.getAccount(accountId);
    if (existing) {
      await client.syncState();
      return accountId.toString();
    }
  } catch {
    // Account doesn't exist locally
  }

  // Create account locally
  await client.newAccount(account, false);
  await client.syncState();

  return accountId.toString();
}
