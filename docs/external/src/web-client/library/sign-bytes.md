---
title: Verify a signBytes signature
sidebar_position: 70
---

# Verify a signBytes signature

`domainSeparatedSignCommitment` computes the commitment a wallet signs for a
dApp's `signBytes` request. Verify the returned signature with
`publicKey.verify(domainSeparatedSignCommitment(data, kind), signature)`.

The wallet signs under the domain tag `miden-wallet/sign-bytes/v1`, the
Poseidon2 hash of that string, one field element per UTF-8 byte. The SDK
supplies the tag, so a dApp does not compute it; its four elements are
`0x38a8bcdddf30cacf`, `0x240d1b8455bc2c58`, `0x18162f6af29602dd` and
`0x5385955edcd341a4`. `"word"`:
`data` is a serialized `Word`; the signed commitment is that of
`SigningInputs.newArbitrary([...tag, ...word.toFelts()])`. `"signingInputs"`:
`data` is serialized `SigningInputs`. A Blind payload signs
`[...tag, ...word.toFelts()]` and an Arbitrary payload signs
`[...tag, ...payload]` (the tag alone when the payload is empty), both as
Arbitrary inputs. A TransactionSummary is signed unchanged, so its own
commitment is returned.

Any other kind or variant throws.
Wallets released before this change signed the raw value instead.

Needs the SDK's WASM to be loaded: with a lazy entry, await
`MidenClient.ready()` first.

```typescript
import {
  domainSeparatedSignCommitment,
  MidenClient,
} from "@miden-sdk/miden-sdk/lazy";

await MidenClient.ready();
publicKey.verify(domainSeparatedSignCommitment(data, kind), signature);
```
