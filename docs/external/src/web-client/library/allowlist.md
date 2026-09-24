---
title: Account Allowlist
sidebar_position: 40
---

# Registering Accounts on an Allowlisted Network

A network that enforces an account allowlist creates an account on chain only
once the account is registered. Registration binds an invitation code, issued
by the network operator, to the account ID. It does not create the account: the
account's first transaction does that, and the node rejects the transaction
when the account is not registered. Only creation is gated. An account that
already exists on chain is never checked, and network accounts are exempt.

## Checking whether an account is allowed

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create({ rpcUrl });
const wallet = await client.accounts.create();

const allowed = await client.accounts.isAllowed(wallet);
```

`isAllowed` answers `true` when the node does not enforce an allowlist, or when
the account is registered.

## Registering an account

```typescript
try {
  await client.accounts.register({ account: wallet, invitationCode });
} catch (error) {
  switch (error.code) {
    case "ACCOUNT_ALREADY_ALLOWED":
      // The node already allows the account, or enforces no allowlist. The
      // code was not sent, so keep it for another account.
      break;
    case "INVITATION_NOT_FOUND":
    case "ALREADY_REGISTERED":
    case "INVALID_REGISTRATION_REQUEST":
      // The node rejected the registration.
      break;
    default:
      throw error;
  }
}
```

The account must be tracked by the client, must not be deployed on chain yet,
and must not be a network account. A registration consumes the code, so the
client asks the node first and does not send the code for an account the node
already allows.

When the network operator runs a funding service, the node pays the registered
account a public P2ID note with the native asset and answers once that note is
committed, so `register` can take a few blocks. The note is not part of the
response. It arrives with the next `sync()`, and consuming it is the first
transaction of the account, which creates the account on chain and pays its fee
out of the received funds:

```typescript
await client.sync();
await client.transactions.consumeAll({ account: wallet });
```

## Submitting for an unregistered account

`transactions.send`, `transactions.consume` and every other submission that
would create an account the network does not accept fail with the code
`ACCOUNT_NOT_ALLOWLISTED` before anything is proven or sent. Register the
account and submit again.

Error codes are the `code` property of the thrown error on the WASM build. The
Node.js binding reports the same reason in the error message.

## Registering without a tracked account

`RpcClient` exposes the two node endpoints directly, for a registration flow
that never holds the account's state, such as an onboarding service that
registers IDs its users hand it:

```typescript
import { Endpoint, RpcClient, AccountId } from "@miden-sdk/miden-sdk";

const rpc = new RpcClient(new Endpoint(rpcUrl));
const accountId = AccountId.fromBech32(address);

if (!(await rpc.isAccountAllowed(accountId))) {
  await rpc.registerAccount(accountId, invitationCode);
}
```

Unlike `accounts.register`, `RpcClient.registerAccount` sends the request as
given: it does not check that the account is new, and it does not ask the node
first, so a code spent on an account the node already allows is consumed.
