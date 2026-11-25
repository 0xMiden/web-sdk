---
title: useWaitForAccountUpdate
sidebar_position: 15
---

# useWaitForAccountUpdate

Wait for an account-state update driven by an external consumer (for example, a
note consumed by a network operator or another client that the local `WebClient`
did not submit).

```tsx
import { useWaitForAccountUpdate } from "@miden-sdk/react";

function CounterWatcher({ accountId }: { accountId: string }) {
  const { waitForAccountUpdate, unsubscribe, account, isWaiting, error } =
    useWaitForAccountUpdate();

  const handleWatch = async () => {
    try {
      const updated = await waitForAccountUpdate(accountId, {
        slot: "counter::value",
        timeoutMs: 30_000,
        intervalMs: 1_000,
      });
      console.log("Updated commitment:", updated.to_commitment().toHex());
    } catch (err) {
      console.error("Wait ended:", err);
    }
  };

  return (
    <div>
      {error && <div>Error: {error.message}</div>}
      {account && <div>Commitment: {account.to_commitment().toHex()}</div>}
      <button onClick={handleWatch} disabled={isWaiting}>
        {isWaiting ? "Waiting..." : "Watch account"}
      </button>
      {isWaiting && <button onClick={unsubscribe}>Cancel</button>}
    </div>
  );
}
```

`waitForAccountUpdate(options?)` or
`waitForAccountUpdate(accountId, options?)` resolves with the updated
`Account` once its state moves past the baseline, and populates `account` and
the store's account details. Passing `enabled: true` to
`useWaitForAccountUpdate(accountId, { enabled: true, ... })` starts the same
poll loop declaratively on mount and whenever watched inputs change.

## Options

| Field | Type | Description |
|---|---|---|
| `accountId` | `AccountRef` | Account ID (hex string, Bech32, `AccountId`, or `AccountHeader`) to watch. Optional if supplied to `useWaitForAccountUpdate(accountId, options)`. |
| `baselineCommitment` | `string \| Word` | Known account commitment hex or `Word` to compare against when `slot` is omitted. If omitted, the first non-null polled snapshot becomes the baseline. |
| `slot` | `string` | Optional storage slot name to watch instead of the overall account commitment. |
| `mapKey` | `string \| Word` | Optional map key (hex `Word` or `Word` instance) within `slot` to watch a specific storage map entry. Requires `slot`. |
| `baselineValue` | `string \| Word \| bigint \| null` | Known baseline value for `slot` or `mapKey`. Pass `null` when watching for a new map entry to appear. |
| `timeoutMs` | `number` | Maximum time to wait before rejecting with a timeout error. Default: `10000`. |
| `intervalMs` | `number` | Poll interval in milliseconds between sync checks. Default: `1000`. |
| `enabled` | `boolean` | Hook-level option (`UseWaitForAccountUpdateOptions`) that starts polling automatically when truthy. Default: `false`. |

## Behavior

- Each poll runs `syncState()` and `getAccount()` sequentially through `runExclusive`.
- Calling `unsubscribe()` rejects the in-flight `waitForAccountUpdate` promise, clears any pending timer, and stops polling.
- Component unmount or `reset()` stops polling and clears timers cleanly without leaving background `syncState()` calls or rejecting unawaited promises.
- Calling `waitForAccountUpdate()` while another wait from the same hook instance is active supersedes the previous wait.
