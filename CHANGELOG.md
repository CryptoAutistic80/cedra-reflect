# Changelog

All notable protocol changes are recorded here. v0.1 and v0.2 are distinct
immutable deployments and their events, balances, and evidence must never be
merged.

## Unreleased — Testnet release candidate 0.2.0

### Changed

- Replaced claim-backed v0.1 with a fresh automatic-materialization design;
  there is no migration or in-place upgrade.
- The reflection fee is selected once during core initialization, accepts
  0–500 basis points, and has no mutation surface. The v0.2 Testnet instance
  selects 100 basis points.
- Wallet send, receive, buy, sell, and liquidity paths materialize all whole
  pending rewards before relevant weights change. The derived balance remains
  `raw + pending` for passive holders.
- Every successful swap automatically checkpoints canonical pool rewards into
  LP accounting. LP mint, burn, and transfer automatically pay affected
  positions before changing shares.
- Final LP withdrawal returns exact reserves and closes the pool permanently.

### Removed

- Removed every fee/configuration setter, pause domain, operational-admin role,
  authority rotation, shutdown, reseed, later epoch, and recovery entry point.
- Removed arbitrary seed amounts and split initialization transactions in
  favor of the source-bound four-signer `pool::launch` transaction.
- Removed obsolete SDK transaction builders for v0.1 administrative actions.
  Remaining TypeScript is optional read/reconciliation and deterministic
  release verification only.

### Security

- Setup capabilities can be issued and bound only while `CONFIGURING`; atomic
  launch seals them inside source-bound immutable modules.
- Exact primary-store and custody binding prevents incoming wallets, bought
  tokens, transferred LP shares, or liquidity changes from capturing historical
  rewards.
- Publisher addresses are provenance only after launch. No creator pause,
  blacklist, mint, sweep, or configuration authority remains.

### Evidence boundary

- v0.2 requires fresh local verification and fresh Testnet deployment evidence.
  No v0.1 local count, live transaction, wallet result, or reconciliation is
  evidence that v0.2 passed.
- The 50,000-transaction, 10,000-swap, 1,000-holder, and 100-LP-position gates
  remain required before v0.2 is declared canonical.

## 0.1.0 — Historical immutable Testnet deployment

The v0.1 reflection-core, test-assets, and test-AMM packages were published
immutably to Cedra Testnet on July 21, 2026 from source commit
`89df1a041e1c62ce031e5e1b413f42c818d56dcf`.

### Added

- One immutable, fixed-supply tRFL instance with claim-backed O(1) wallet
  reflections and no retained mint authority.
- One canonical tRFL/tUSD AMM custody adapter whose reserve reflections route
  one-for-one into a separately backed LP reward index.
- Checkpointed, account-bound LP ownership across mint, burn, transfer, claim,
  final shutdown, and fresh reward epochs.
- Three cold publisher roles, one permanently excluded operations role, and a
  signer-authenticated bootstrap-LP role.
- Atomic four-signer operational handoff across core, faucet, and AMM packages;
  individual handoffs remain recovery-only.
- Exact-address build, transaction-evidence, approval-envelope, finalized-state,
  model, SDK, and indexer verification tooling.

### Security

- Publishable packages use immutable policy and contain no migration or
  legacy-state conversion surface.
- Publisher, operations, reserve, distribution, core-reward, and LP-reward
  stores fail closed against reward or transfer-path misclassification.
- Unsupported external vaults and LP protocols receive no inferred beneficial
  ownership; each future custody integration requires a separately reviewed
  on-chain adapter.

### Evidence boundary

- Added the finalized three-package Testnet deployment and CLI-wallet evidence
  record, including package policy, transaction hashes, a four-holder repeated
  buy/sell proof, LP historical-ownership checks, pause/authority failures,
  exact fixed-supply conservation, and final core/LP vault reconciliation.

- Added `make contract-verify` as the authoritative contract-only completion
  gate: strict Move compilation/lint, 118 Move tests, 60 Python model/surface
  tests, generated conformance checks, and one million randomized applied
  transitions with continuous invariant audits.
- Recorded the one-operator review model accurately. The operator and Codex
  perform author-side review; no external reviewer or independence claim is
  fabricated.
- Local deterministic checks remain distinct from the finalized Testnet
  deployment. The live record proves a bounded functional exercise, not the
  larger 50,000-transaction public-pilot load gates.
- Independent review is recommended before mainnet or reflection-token-factory
  reuse, where the risk and architecture are materially broader.
