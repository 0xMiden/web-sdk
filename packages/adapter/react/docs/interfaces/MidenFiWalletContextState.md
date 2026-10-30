[**@miden-sdk/miden-wallet-adapter-react**](../README.md)

***

[@miden-sdk/miden-wallet-adapter-react](../README.md) / MidenFiWalletContextState

# Interface: MidenFiWalletContextState

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

### createAccount?

> `optional` **createAccount?**: (`params?`) => `Promise`\<`string`\>

#### Parameters

##### params?

`CreateAccountParams`

#### Returns

`Promise`\<`string`\>

***

### disconnecting

> **disconnecting**: `boolean`

***

### importPrivateNote?

> `optional` **importPrivateNote?**: (`note`) => `Promise`\<`string`\>

#### Parameters

##### note

`Uint8Array`

#### Returns

`Promise`\<`string`\>

***

### publicKey

> **publicKey**: `Uint8Array`\<`ArrayBufferLike`\> \| `null`

***

### requestAssets?

> `optional` **requestAssets?**: () => `Promise`\<`Asset`[]\>

#### Returns

`Promise`\<`Asset`[]\>

***

### requestConsumableNotes?

> `optional` **requestConsumableNotes?**: () => `Promise`\<`InputNoteDetails`[]\>

#### Returns

`Promise`\<`InputNoteDetails`[]\>

***

### requestConsume?

> `optional` **requestConsume?**: (`transaction`) => `Promise`\<`string`\>

#### Parameters

##### transaction

`MidenConsumeTransaction`

#### Returns

`Promise`\<`string`\>

***

### requestGuardianInfo?

> `optional` **requestGuardianInfo?**: () => `Promise`\<`GuardianInfo`\>

#### Returns

`Promise`\<`GuardianInfo`\>

***

### requestPrivateNotes?

> `optional` **requestPrivateNotes?**: (`noteFilterType`, `noteIds?`) => `Promise`\<`InputNoteDetails`[]\>

#### Parameters

##### noteFilterType

`NoteFilterTypes`

##### noteIds?

`string`[]

#### Returns

`Promise`\<`InputNoteDetails`[]\>

***

### requestSend?

> `optional` **requestSend?**: (`transaction`) => `Promise`\<`string`\>

#### Parameters

##### transaction

`MidenSendTransaction`

#### Returns

`Promise`\<`string`\>

***

### requestTransaction?

> `optional` **requestTransaction?**: (`transaction`) => `Promise`\<`string`\>

#### Parameters

##### transaction

`MidenTransaction`

#### Returns

`Promise`\<`string`\>

***

### signBytes?

> `optional` **signBytes?**: (`data`, `kind`) => `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

#### Parameters

##### data

`Uint8Array`

##### kind

`SignKind`

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### waitForTransaction?

> `optional` **waitForTransaction?**: (`txId`, `timeout?`) => `Promise`\<`TransactionOutput`\>

#### Parameters

##### txId

`string`

##### timeout?

`number`

#### Returns

`Promise`\<`TransactionOutput`\>

***

### wallet

> **wallet**: `Wallet` \| `null`

***

### wallets

> **wallets**: `Wallet`[]

## Methods

### connect()

> **connect**(): `Promise`\<`void`\>

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
