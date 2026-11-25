---
title: Node health
sidebar_position: 65
---

# Check and monitor the node's health

`client.checkHealth()` asks the node for its status through its `Status`
endpoint. It never rejects for a node problem, so a dApp can show a connection
indicator without wrapping the call:

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.createTestnet();
const health = await client.checkHealth();

if (health.reachable) {
  health.version; // the node's RPC version
  health.chainTip; // block number of the node's chain tip
  health.genesisCommitment; // hex, when the node reports one
  health.blockProducer?.status; // the block producer's status
  health.blockProducer?.mempoolStats?.unbatchedTransactions;
} else {
  health.error; // why the node could not be reached or did not answer
}
```

An unreachable node, a failed request and a mock client, which has no node,
resolve to `{ reachable: false, error }`; only a terminated client rejects. The
request runs outside the client's call queue, so it answers while a sync or a
transaction is in flight. It skips version negotiation, so a node running an
incompatible version still reports its `version`. `blockProducer` and its
`mempoolStats` are present when the node reports them, with the block
producer's `version`, `status` and `chainTip` and the mempool's
`unbatchedTransactions`, `proposedBatches` and `provenBatches`.

## Monitor the connection

`client.monitorHealth({ intervalMs, onChange })` checks now and then every
`intervalMs` after the previous check settles, so checks never overlap. It
calls `onChange` with the first result, then only when reachability or the
block producer's `status` changes; a new chain tip alone is not a change. It
returns a function that stops the monitor, and `terminate()` stops every
monitor of the client:

```typescript
const stop = client.monitorHealth({
  intervalMs: 15_000,
  onChange: (health) => setOnline(health.reachable),
});

// later
stop();
```

An error thrown by `onChange` is logged and the monitor keeps running.
`intervalMs` must be a positive number of at most 2147483647 (the longest delay
a timer can hold) and `onChange` a function, or the call throws a `TypeError`.

## Without a client

`RpcClient.getStatus()` returns the same status as a `RpcStatusInfo`, with
`version`, `chainTip`, `genesisCommitment` (a `Word`) and `blockProducer` (a
`BlockProducerStatusInfo` with `version`, `status`, `chainTip` and
`mempoolStats`, a `MempoolStatsInfo` with the same three counts as 64-bit
integers, which `checkHealth` reports as numbers). Unlike
`checkHealth`, it rejects when the node cannot be reached:

```typescript
import { Endpoint, RpcClient } from "@miden-sdk/miden-sdk";

const status = await new RpcClient(Endpoint.testnet()).getStatus();
status.chainTip;
```
