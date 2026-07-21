# Changelog

All notable protocol changes are recorded here. The reflection-core,
test-assets, and test-AMM packages were published immutably to Cedra Testnet on
July 21, 2026 from source commit
`89df1a041e1c62ce031e5e1b413f42c818d56dcf`.

## Unreleased — Testnet release candidate 0.1.0

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
