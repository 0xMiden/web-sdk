# Development funding

On testnet and devnet, new wallets need the native fee asset before they can
submit their first transaction. `accounts.requestFundingNote` asks a development
faucet for a public P2ID note, and `accounts.fundAccount` also waits for that
note, consumes it, and waits for confirmation.

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.createTestnet();
const wallet = await client.accounts.create({ storage: "private" });

// Request only: resume with consume if a later stage fails.
const receipt = await client.accounts.requestFundingNote(wallet);
// { noteId, transactionId, faucetId, amount }

// Or run the full flow:
const funded = await client.accounts.fundAccount(wallet);
// { noteId, transactionId, balance }
```

Defaults:

| Option | Default |
| --- | --- |
| `faucetUrl` | `https://faucet-api.testnet.miden.io` or `…devnet…` from the RPC endpoint |
| `amount` | the faucet's advertised `base_amount` |
| `timeout` | `60_000` ms per stage (mint, note discovery, confirmation) |
| `pollInterval` | `5_000` ms between chain syncs while waiting for the note |

Other networks have no public faucet default: pass `faucetUrl`. The mint request
is never retried: a timeout after the faucet accepted the request can leave a
note on chain, so resume from `noteId` instead of calling the faucet again.

The account must already be tracked locally (`accounts.create` or `import`).
`fundAccount` consumes only the returned funding note; existing balances do not
suppress funding. The amount must cover the consumption fee so a fresh wallet
can pay for that first transaction out of the note.
