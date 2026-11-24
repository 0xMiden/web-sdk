---
title: useClaimAggLayerDeposit
sidebar_position: 14
---

# useClaimAggLayerDeposit

Claim an inbound AggLayer deposit. The hook builds the public CLAIM note with
`Note.createClaimNote(...)` and submits it as the sender, declaring the bridge
account as a foreign account. The bridge consumes the note and mints the
deposit.

```tsx
import { useClaimAggLayerDeposit } from "@miden-sdk/react";

function ClaimButton({ proof, leaf }) {
  const { claimAggLayerDeposit, isLoading, stage, error } =
    useClaimAggLayerDeposit();

  const handleClaim = async () => {
    try {
      const { txId, note } = await claimAggLayerDeposit({
        from: senderAccountId,
        bridgeAccount: bridgeAccountId,
        proof, // ClaimProofData from the AggLayer claimAsset data
        leaf, // ClaimLeafData from the same data
        scale: 10, // the faucet's decimal scale
      });
      console.log("Submitted", txId, note.id().toString());
    } catch (err) {
      console.error("Failed to claim:", err);
    }
  };

  return (
    <div>
      {error && <div>Error: {error.message}</div>}
      <button onClick={handleClaim} disabled={isLoading}>
        {isLoading ? `${stage}...` : "Claim deposit"}
      </button>
    </div>
  );
}
```

`claimAggLayerDeposit(options) → { txId, note }`. The hook syncs afterwards
unless `skipSync` is set.

## Options

| Field | Type | Description |
|---|---|---|
| `from` | `AccountRef` | Account that creates the CLAIM note and executes the transaction. |
| `bridgeAccount` | `AccountRef` | The public bridge account that consumes the note and mints the deposit. |
| `proof` | `ClaimProofData` | Proof data from the AggLayer `claimAsset` call. |
| `leaf` | `ClaimLeafData` | Deposit leaf from the same call. |
| `scale` | `number` | The faucet's decimal scale, an integer from 0 to 18. The Miden amount is `floor(leaf amount / 10^scale)`. |
| `skipSync` | `boolean` | Skip the sync after claiming. Default: `false`. |

A `scale` outside 0 to 18 throws before the note is built; a scaled amount
above the maximum fungible amount throws from the note builder.
