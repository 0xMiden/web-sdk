[**@miden-sdk/miden-wallet-adapter-react**](../README.md)

***

[@miden-sdk/miden-wallet-adapter-react](../README.md) / WalletContextState

# Interface: WalletContextState

## Properties

### address

> **address**: `string` \| `null`

***

### autoConnect

> **autoConnect**: `boolean`

***

### connected

> **connected**: `boolean`

***

### connecting

> **connecting**: `boolean`

***

### disconnecting

> **disconnecting**: `boolean`

***

### importPrivateNote

> **importPrivateNote**: ((`note`) => `Promise`\<`string`\>) \| `undefined`

***

### privateDataPermission?

> `optional` **privateDataPermission?**: `PrivateDataPermission`

***

### publicKey

> **publicKey**: `Uint8Array`\<`ArrayBufferLike`\> \| `null`

***

### requestAssets

> **requestAssets**: (() => `Promise`\<`Asset`[]\>) \| `undefined`

***

### requestConsumableNotes

> **requestConsumableNotes**: (() => `Promise`\<`InputNoteDetails`[]\>) \| `undefined`

***

### requestConsume

> **requestConsume**: ((`transaction`) => `Promise`\<`string`\>) \| `undefined`

***

### requestGuardianInfo

> **requestGuardianInfo**: (() => `Promise`\<`GuardianInfo`\>) \| `undefined`

***

### requestPrivateNotes

> **requestPrivateNotes**: ((`noteFilterType`, `noteIds?`) => `Promise`\<`InputNoteDetails`[]\>) \| `undefined`

***

### requestSend

> **requestSend**: ((`transaction`) => `Promise`\<`string`\>) \| `undefined`

***

### requestTransaction

> **requestTransaction**: ((`transaction`) => `Promise`\<`string`\>) \| `undefined`

***

### signBytes

> **signBytes**: ((`data`, `kind`) => `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>) \| `undefined`

***

### waitForTransaction

> **waitForTransaction**: ((`txId`, `timeout?`) => `Promise`\<`TransactionOutput`\>) \| `undefined`

***

### wallet

> **wallet**: [`Wallet`](Wallet.md) \| `null`

***

### wallets

> **wallets**: [`Wallet`](Wallet.md)[]

## Methods

### connect()

> **connect**(`privateDataPermission`, `network`, `allowedPrivateData?`): `Promise`\<`void`\>

#### Parameters

##### privateDataPermission

`PrivateDataPermission`

##### network

`WalletAdapterNetwork`

##### allowedPrivateData?

`AllowedPrivateData`

#### Returns

`Promise`\<`void`\>

***

### disconnect()

> **disconnect**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### select()

> **select**(`walletName`): `void`

#### Parameters

##### walletName

`WalletName`

#### Returns

`void`
