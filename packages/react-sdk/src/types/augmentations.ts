import "@miden-sdk/miden-sdk";

declare module "@miden-sdk/miden-sdk" {
  interface Account {
    /**
     * Returns the bech32-encoded account id for the network of the provider's
     * client, or the raw account id when that network cannot be confirmed (no
     * client yet, a mock client, or an endpoint naming no known network).
     */
    bech32id(): string;
  }
}

export {};
