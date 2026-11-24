---
title: useWithdrawUsdcx
sidebar_position: 13
---

# useWithdrawUsdcx

Withdraw USDCx through Circle xReserve. The hook emits one public burn note
that the USDCx faucet (a public account) consumes and burns, and Circle then
releases USDC to the recipient on the destination domain.

```tsx
import { useWithdrawUsdcx } from "@miden-sdk/react";

function WithdrawButton() {
  const { withdrawUsdcx, isLoading, stage, error } = useWithdrawUsdcx();

  const handleWithdraw = async () => {
    try {
      const { transactionId } = await withdrawUsdcx({
        from: senderAccountId,
        faucetId: usdcxFaucetId,
        amount: 1_000_000n,
        destinationDomain: 6, // Circle domain, for example 6 for Arbitrum
        // Circle's 32-byte recipient: an EVM address left-padded with zeros
        destinationRecipient: "0x" + evmAddress.slice(2).padStart(64, "0"),
      });
      console.log("Submitted", transactionId);
    } catch (err) {
      console.error("Failed to withdraw:", err);
    }
  };

  return (
    <div>
      {error && <div>Error: {error.message}</div>}
      <button onClick={handleWithdraw} disabled={isLoading}>
        {isLoading ? `${stage}...` : "Withdraw USDCx"}
      </button>
    </div>
  );
}
```

`withdrawUsdcx(options) → { transactionId }`. The hook syncs afterwards unless
`skipSync` is set.

## Options

| Field | Type | Description |
|---|---|---|
| `from` | `AccountRef` | Account that creates and funds the burn note. |
| `faucetId` | `AccountRef` | The USDCx faucet; it must be a public account. |
| `amount` | `bigint \| number` | Amount to withdraw. A `number` must be a safe integer; pass a `bigint` above `2 ** 53 - 1`. |
| `destinationDomain` | `number` | Circle domain of the destination chain, an integer from 0 to 4294967295. |
| `destinationRecipient` | `string` | Circle's 32-byte recipient as 0x-prefixed hex (64 digits). |
| `skipSync` | `boolean` | Skip the sync after withdrawing. Default: `false`. |

A `destinationRecipient` that is not a 0x-prefixed 32-byte hex string, a
`destinationDomain` outside the u32 range and an unsafe `number` amount all
throw before the note is built.
