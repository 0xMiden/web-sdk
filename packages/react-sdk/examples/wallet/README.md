# Wallet Example

Barebones React SDK wallet demo: create account, show balances, claim notes, send tokens.

## Run

```bash
# From the repo root: install workspace + build the React SDK.
pnpm install
pnpm --filter @miden-sdk/react run build

# This example is intentionally OUTSIDE the workspace (its file: deps to
# sibling miden-* repos would otherwise bleed into the SDK install graph),
# so it has its own pnpm install. --ignore-workspace prevents pnpm from
# walking up to the monorepo root.
cd packages/react-sdk/examples/wallet
pnpm install --ignore-workspace
pnpm dev
```
