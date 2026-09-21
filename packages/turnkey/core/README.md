# @miden-sdk/turnkey

Miden + Turnkey wallet integration SDK for building secure blockchain applications.

## Packages

This monorepo contains the following packages:

| Package | Description |
|---------|-------------|
| [`@miden-sdk/turnkey`](/packages/turnkey/core) | Core SDK for Miden + Turnkey integration |
| [`@miden-sdk/turnkey-react`](/packages/turnkey/react) | React hook for easy integration |
| [`@miden-sdk/create-turnkey-react`](/packages/turnkey/create) | CLI to scaffold new projects |

## Quick Start

### Option 1: Scaffold a new project

```bash
yarn create @miden-sdk/turnkey-react my-app
cd my-app
yarn dev
```

### Option 2: Add to an existing React project

```bash
yarn add @miden-sdk/turnkey @miden-sdk/turnkey-react @miden-sdk/miden-sdk @turnkey/react-wallet-kit
```

```tsx
import { TurnkeyProvider } from "@turnkey/react-wallet-kit";
import { useTurnkeyMiden } from "@miden-sdk/turnkey-react";

function App() {
  return (
    <TurnkeyProvider config={turnkeyConfig}>
      <MidenApp />
    </TurnkeyProvider>
  );
}

function MidenApp() {
  const { client, accountId } = useTurnkeyMiden(
    "https://rpc.miden.io",
    "public",
    { accountSeed: "my-seed" }
  );

  if (!client) return <div>Loading...</div>;

  return <div>Account: {accountId}</div>;
}
```

### Option 3: Use the core SDK directly

```bash
yarn add @miden-sdk/turnkey @miden-sdk/miden-sdk @turnkey/http
```

```typescript
import { createMidenTurnkeyClient } from "@miden-sdk/turnkey";
import { TurnkeyClient } from "@turnkey/http";

const turnkeyClient = new TurnkeyClient({
  baseUrl: "https://api.turnkey.com",
  // ... auth config
});

const { client, accountId } = await createMidenTurnkeyClient(
  {
    client: turnkeyClient,
    organizationId: "your-org-id",
    account: walletAccount,
  },
  {
    endpoint: "https://rpc.miden.io",
    noteTransportUrl: "https://transport.miden.io",
    accountSeed: "my-seed",
    storageMode: AccountStorageMode.public(),
  }
);
```

## Installation

### Core SDK

```bash
yarn add @miden-sdk/turnkey
```

**Peer Dependencies:**
- `@miden-sdk/miden-sdk@^0.16.2`

`@turnkey/core`, `@turnkey/http` and `@turnkey/sdk-browser` are regular
dependencies of this package, so you do not install them yourself.

### React Hook

```bash
yarn add @miden-sdk/turnkey-react
```

**Peer Dependencies:**
- `@miden-sdk/turnkey@^0.16.2`
- `@miden-sdk/miden-sdk@^0.16.2`
- `@miden-sdk/react@^0.16.2`
- `@turnkey/core@^1.8.2`
- `@turnkey/react-wallet-kit@^1.6.2`
- `@turnkey/sdk-browser@^5.13.4`
- `react@^18.0.0 || ^19.0.0`

## Development

### Prerequisites

- Node.js 20+
- pnpm 9+

### Setup

```bash
# Clone the repository
git clone https://github.com/0xMiden/web-sdk.git
cd web-sdk

# Install dependencies
pnpm install

# Build all packages
pnpm -r build
```

### Building Individual Packages

```bash
# Core package
pnpm --filter @miden-sdk/turnkey run build

# React hook package
pnpm --filter @miden-sdk/turnkey-react run build
```

### Running the Example

```bash
cd packages/turnkey/core/examples/react
pnpm install
pnpm dev
```

## API Reference

### `createMidenTurnkeyClient(turnkeyConfig, opts)`

Creates a Miden client with Turnkey signing integration.

#### Parameters

- `turnkeyConfig` - Turnkey configuration
  - `client` - TurnkeyClient or TurnkeyBrowserClient instance
  - `organizationId` - Your Turnkey organization ID
  - `account` - WalletAccount to use for signing
- `opts` - Miden options
  - `endpoint` - Miden node RPC URL
  - `noteTransportUrl` - Note transport service URL
  - `seed` - Client seed (`Uint8Array`)
  - `accountSeed` - Account derivation seed
  - `storageMode` - Storage mode (`AccountStorageMode.public()` or
    `AccountStorageMode.private()`). Required; every other option is optional.

#### Returns

```typescript
Promise<{
  client: MidenClient;
  accountId: string;
}>
```

### `useTurnkeyMiden(nodeUrl, storageMode?, opts?)`

React hook for Miden + Turnkey integration. See [@miden-sdk/turnkey-react README](/packages/turnkey/react/README.md).

## Examples

See the [examples/react](/packages/turnkey/core/examples/react) directory for a complete Next.js example application.

## License

ISC
