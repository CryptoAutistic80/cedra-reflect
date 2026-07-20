# Reflection Pilot Testnet

> **TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE**

This repository is the source and evidence set for the Cedra Reflection Pilot
Testnet: a production-engineering-quality, intentionally non-economic beta for
a fixed-supply `tRFL` / `tUSD` reflection-token system. It is not a mainnet
launch, token sale, investment product, or promise of value.

## What this repository proves

The planned pilot has one project-controlled constant-product AMM, a one
percent reflection fee on supported swaps, untaxed ordinary transfers, an
excluded reward vault and distribution vault, an O(1) global-index accounting
model, canonical-LP reward passthrough, one clean initial contract schema, and
an independent reconciliation witness.

The source tree is organised to keep test-only distribution and synthetic
liquidity separate from the reflection core:

```text
move/       Cedra Move packages and integration tests
python/     Independent reference model, vectors, and property tests
packages/   TypeScript protocol SDK and indexer/reconciler
apps/       Public Testnet dashboard
ops/        Release, incident, and redeployment controls
```

## Safety and operational boundary

- Never publish, fund, transfer, or invoke state-changing Testnet commands
  from CI or a local convenience script.
- Only an approved release operator publishes after a two-person approval
  recorded in a signed release manifest.
- Package publishers hand routine fee, pause, faucet, shutdown, and limit
  controls to a distinct operational key through three evented transactions.
- The three release packages are immutable after publication. A code fix uses
  a new deployment and manifest, never an in-place upgrade or migration.
- Do not add a `force_set_balance`, arbitrary vault sweep, post-seal `tRFL`
  mint, user-store transfer, or fee-above-100-bps capability.
- Live Testnet activity is evidence gathered after deployment, not proof that
  unreviewed source code is ready to publish.

## Factory boundary

This repository deploys one tRFL instance; it is the secure single-token
reference, not yet a reflection-token factory. A later factory must give every
created token its own object-scoped accounting state, vault capabilities,
custody bindings, instance-qualified events, and indexer keys. The current
canonical LP design can be reused only for adapters that prove beneficial
ownership and checkpoint before every share mutation.

## Local verification

The root verification command is deliberately read-only/local:

```bash
make verify
```

It runs Move, Python, and TypeScript checks once their toolchains are
installed. See the individual package READMEs for setup. `make pilot-gate`
runs the expanded randomized accounting gate; it does not submit transactions
or contact a wallet.

## Pilot completion evidence

The codebase can prove local arithmetic and implementation requirements. The
following gates require a live, operator-controlled Testnet deployment and are
therefore tracked as evidence records rather than faked in CI: the Testnet
dispatchable-hook probe, 50,000 on-chain synthetic transactions,
10,000 completed swaps, 1,000 distinct on-chain holders, one clean
redeployment/restoration, wallet-display verification, and independent
review. See `ops/` for the required records and stop conditions.
