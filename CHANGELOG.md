# Changelog

All notable protocol changes are recorded here. This repository has not yet
published the reflection-core, test-assets, or test-AMM packages to Cedra
Testnet.

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

- Added `make contract-verify` as the authoritative contract-only completion
  gate: strict Move compilation/lint, 118 Move tests, 60 Python model/surface
  tests, generated conformance checks, and one million randomized applied
  transitions with continuous invariant audits.
- Recorded the one-operator review model accurately. The operator and Codex
  perform author-side review; no external reviewer or independence claim is
  fabricated.
- Local deterministic checks and the isolated hook-compatibility probe do not
  prove that the three release packages are deployed.
- Testnet funding, exact simulations, publication, initialization, and pilot
  workload evidence are deferred outside the current contract-only scope.
- Independent review is recommended before mainnet or reflection-token-factory
  reuse, where the risk and architecture are materially broader.
