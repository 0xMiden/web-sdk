import "@miden-sdk/miden-sdk";

declare module "@miden-sdk/miden-sdk" {
  interface Account {
    /**
     * Returns the bech32-encoded account id for the network of the provider's
     * client, or the raw account id when that network cannot be confirmed (no
     * client yet or a mock client). An endpoint naming no known network is mainnet.
     */
    bech32id(): string;
  }
}

export {};
