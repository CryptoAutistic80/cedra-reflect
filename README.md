# Reflection Pilot Testnet

> **TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE**

This repository is the source and evidence set for the planned Cedra Reflection
Pilot Testnet: a production-engineering-quality, intentionally non-economic
beta for a fixed-supply `tRFL` / `tUSD` reflection-token system. It is not a
mainnet launch, token sale, investment product, or promise of value.

## What the current repository proves locally

The source and deterministic tests implement one project-controlled constant-
product AMM, a one percent reflection fee on supported swaps, untaxed ordinary
transfers, excluded reward and distribution vaults, an O(1) global-index
accounting model, canonical-LP reward passthrough, one clean initial contract
schema, and an independent reconciliation implementation. This is local source
and test evidence; it is not evidence that the release packages or pilot have
been deployed.

The source tree is organised to keep test-only distribution and synthetic
liquidity separate from the reflection core:

```text
move/       Cedra Move packages and integration tests
python/     Independent reference model, vectors, and property tests
packages/   TypeScript protocol SDK and indexer/reconciler
apps/       Deferred static dashboard prototype; not wallet or live-pilot evidence
ops/        Release, incident, and redeployment controls
```

The TypeScript SDK and indexer are optional, non-authoritative off-chain
integration tools. The SDK can build, fingerprint, and simulate an exact
transaction but contains no release signing or submission shortcut. The Move
packages do not call either package, trust them, or rely on them for any
balance, fee, custody, LP-ownership, pause, or authority rule. Deleting or
replacing them cannot change the on-chain economics.

This is one hard-bound tRFL instance split across three immutable packages,
not a factory. On chain, registered wallet primary stores and the canonical LP
are rewarded exactly once. If an account-controlled vault uses that account's
canonical primary store, the contract sees and rewards only that one address;
it does not infer or apportion rewards among the vault's depositors. Custom and
secondary stores fail closed, and no other custody or LP adapter is supported
by this deployment.

## Current deliverable: the contract

The current completion target is the on-chain package, not a frontend or a
deployment ceremony. The contract is considered locally complete only when
`make contract-verify` passes from the selected source tree. That gate compiles
and strictly lints all three immutable packages, runs every Move unit and
cross-package integration test, checks the independently implemented Python
accounting model and generated Move/Python conformance vectors, and completes
one million successfully applied randomized state transitions with continuous
invariant audits.

There is one operator and no external reviewer for this Testnet project. Codex
can implement, inspect, and test the code with the operator, but that is
author-side engineering review, not independent human assurance. Independent
review is therefore not a blocker for completing this local contract package.
It remains recommended before reusing the design for a mainnet asset or a
multi-token factory.

## Deferred deployment boundary

- Repository release scripts and generated profiles are outside the contract
  completion gate. They are retained for a later, explicitly requested Testnet
  deployment and do not affect on-chain accounting or contract test results.
- Three package publishers and the destination operations account co-sign one
  atomic, evented handoff of routine fee, pause, faucet, shutdown, and limit
  controls. Individual package setters are recovery-only.
- The operations primary store is permanently reward-excluded, and an address
  that has ever held LP shares cannot become operations.
- Initial or replacement bootstrap LP ownership requires the beneficiary
  signer; it cannot be assigned with a bare address argument.
- The three release packages are immutable after publication. A code fix uses
  a new deployment and manifest, never an in-place upgrade or migration.
- Do not add a `force_set_balance`, arbitrary vault sweep, post-seal `tRFL`
  mint, user-store transfer, or fee-above-100-bps capability.
- Live Testnet activity is evidence gathered after deployment, not proof that
  unreviewed source code is ready to publish.

## Factory boundary

This repository defines one tRFL instance for deployment; it is the secure single-token
reference, not yet a reflection-token factory. A later factory must give every
created token its own object-scoped accounting state, vault capabilities,
custody bindings, instance-qualified events, and indexer keys. The current
canonical LP design can be reused only for adapters that prove beneficial
ownership and checkpoint before every share mutation.

The five generated public Testnet role candidates are recorded in
`ops/testnet-roles.candidate.json` and summarized in
`CEDRA_TESTNET_PLAN.md`. Their keys remain outside this repository. Local
public-profile capture verifies profile names and public-key/address derivation
with OpenSSL SHA3-256. The keyless assembler separately revalidates the same
bindings with the reviewed `@cedra-labs/ts-sdk` `2.2.8`; neither check
establishes account existence, funding, private-key control, or release
authorization. See `CHANGELOG.md` for the candidate history.

## Local verification

The latest clean, provenance-bound evidence is 118/118 Move tests (2 hook probe, 8
core, 0 asset-local, 5 AMM, 103 integration), 60/60 Python tests, 78/78
TypeScript SDK/indexer tests, and 21/21 release-candidate assembler tests.
Generated conformance is current. The latest claim-backed million-operation run
completed 1,000,000 successful transitions from 1,071,570 attempts, with
70,626 no-ops, 944 rejected operations, 2,002 full audits, 1,024 holders,
`automatic_materialization=false`, and digest
`a40abf6fd8f4b91c7152ba8a63016ef2ef49d2be6c698fdb4dcd87f6c16d90e9`.
The clean record binds the exact Git commit/tree, source, Cedra CLI/framework,
verification log, model report, and local release builds. It remains local
evidence, and it must be regenerated whenever the reviewed commit changes.

The current author-side audit records no unresolved Critical, High, Medium, or
Low contract finding. This is not a claim of independent human assurance.

The authoritative contract command is:

```bash
make contract-verify
```

It performs no funding, signing, publication, wallet, or network operation.

The broader repository/release-tooling command is deliberately read-only/local:

```bash
make verify RELEASE_NODE_RUNTIME=/ABSOLUTE/REVIEWED/PATH/node
```

It runs the Move, Python, TypeScript, keyless candidate-assembler,
release-tooling security, executable-closure, and JSON-schema suites with the
current toolchains. Exact counts must be reproduced at the clean reviewed
commit rather than copied from an earlier run. See the individual package
READMEs for setup.
`make pilot-gate` runs the expanded randomized accounting gate; the clean
release capture runs it and preserves its provenance report. Neither command submits transactions or contacts a
wallet. These local checks validate implementation and evidence handling, not
a live release or independent human SDK approval.

Approval-grade release commands intentionally fail in this developer checkout.
They require a trusted administrator to prepare a fresh standalone exact-commit
clone, not a linked worktree or external Git directory,
whose complete tree, reviewed Node runtime, and pre-emitted closure-matching
JavaScript are root-owned and not writable by the release euid, group, or
others. The ceremony then runs under a dedicated unprivileged uid in an
isolated container or VM and writes only to a separate private output root.
There is no candidate-time compilation and no local/test bypass for this
boundary; see `ops/RELEASE_EVIDENCE.md` for the mandatory preparation procedure.

## Pilot completion evidence

The codebase can prove local arithmetic and implementation requirements. The
isolated Testnet dispatchable-hook probe is already preserved as a bounded
compatibility record. The following broader gates still require a live,
operator-controlled Testnet deployment and are therefore tracked as evidence
rather than faked in CI: 50,000 on-chain synthetic transactions, 10,000
completed swaps, 1,000 distinct on-chain holders, one clean
redeployment/restoration, and wallet-display verification. Independent human
source/bytecode review is a separate pre-publication gate. See `ops/` for the
required records and stop conditions.
