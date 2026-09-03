import {
  Account,
  AccountId,
  AccountInterface,
  Address,
  NetworkId,
} from "@miden-sdk/miden-sdk";
import { useMidenStore } from "../store/MidenStore";
import { parseAccountId } from "./accountParsing";

type AccountPrototype = {
  bech32id?: () => string;
};

// Derive the bech32 network from the live client's endpoint (single source of truth).
// A real client always carries an endpoint (testnet by default), so the only
// undetermined cases are: no client yet (provider still initializing) or a configured
// custom endpoint we can't map — both return `null` so callers fall back to the raw
// account id rather than tagging it for the wrong network.
const resolveNetworkId = (): NetworkId | null => {
  const url = useMidenStore.getState().client?.endpoint()?.toLowerCase();
  if (!url) {
    return null;
  }
  if (url.includes("devnet") || url.includes("mdev")) {
    return NetworkId.devnet();
  }
  if (url.includes("mainnet")) {
    return NetworkId.mainnet();
  }
  if (url.includes("testnet") || url.includes("mtst")) {
    return NetworkId.testnet();
  }
  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    // Local nodes run a devnet genesis by default.
    return NetworkId.devnet();
  }
  return null;
};

const toBech32FromAccountId = (id: AccountId): string => {
  const networkId = resolveNetworkId();
  // Network not yet determinable (provider initializing, or a custom endpoint):
  // return the raw id rather than risk a wrong-network bech32 address.
  if (!networkId) {
    return id.toString();
  }

  try {
    const address = Address.fromAccountId(id, "BasicWallet");
    return address.toBech32(networkId);
  } catch {
    // Fall through to AccountId conversion or string fallback.
  }

  try {
    const maybeBech32 = id.toBech32?.(networkId, AccountInterface.BasicWallet);
    if (typeof maybeBech32 === "string") {
      return maybeBech32;
    }
  } catch {
    // Fall through to string fallback.
  }

  return id.toString();
};

const defineBech32 = (target: AccountPrototype | Account): boolean => {
  try {
    Object.defineProperty(target, "bech32id", {
      value: function bech32id() {
        try {
          const id = this.id?.();
          if (id) {
            return toBech32FromAccountId(id);
          }
        } catch {
          // Fall through to string-based conversion.
        }

        const fallback =
          typeof this.toString === "function" ? this.toString() : "";
        return fallback ? toBech32AccountId(fallback) : "";
      },
    });
    return true;
  } catch {
    return false;
  }
};

export const installAccountBech32 = () => {
  const proto = Account.prototype as AccountPrototype;
  if (proto.bech32id) {
    return;
  }

  defineBech32(proto);
};

export const ensureAccountBech32 = (account?: Account | null) => {
  if (!account) {
    return;
  }

  if (typeof (account as AccountPrototype).bech32id === "function") {
    return;
  }

  const proto = Object.getPrototypeOf(account) as AccountPrototype | null;
  if (proto?.bech32id) {
    return;
  }

  if (proto && defineBech32(proto)) {
    return;
  }

  defineBech32(account as unknown as AccountPrototype);
};

export const toBech32AccountId = (accountId: string): string => {
  try {
    const id = parseAccountId(accountId);
    return toBech32FromAccountId(id);
  } catch {
    return accountId;
  }
};
