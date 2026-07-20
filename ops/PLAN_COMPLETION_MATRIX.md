# Cedra Testnet plan completion matrix

Last audited: 2026-07-20

This matrix maps `CEDRA_TESTNET_PLAN.md` to evidence that exists in the current
workspace. It deliberately distinguishes local source/test proof from finalized
Testnet evidence. A green local gate never authorizes publication,
funding, signing, or submission.

Status meanings:

- **PASS (local):** current source plus a scope-matched deterministic check.
- **PASS (Testnet):** finalized public-ledger evidence for the stated scope.
- **PARTIAL:** an implementation or template exists, but required evidence is
  incomplete or narrower than the plan.
- **OPEN (live):** requires finalized network, wallet, participant, or service
  evidence.
- **OPEN (human):** requires an independent person or release approval.

## Phase exit conditions

| Plan phase | Status | Current authoritative evidence | Missing evidence or work |
|---|---|---|---|
| Phase 0 — network compatibility | PASS (Testnet, claim-backed) | `ops/evidence/hook-probe-testnet.json`: H1-H7 finalized; publish/init/transfer/materialisation/secondary-store gas recorded; CLI/REST/SDK agree; H8 explicitly failed/inconclusive; claim-backed mode selected | A later native-wallet distinct-derived-balance run is required only before any fresh automatic-materialisation deployment |
| Phase 1 — specification and model | PASS (local) | `docs/accounting-specification.md`; independent Python model; hand-authored vector; fixed-seed generated Python/Move witness; one-million-operation gate | Re-run from the exact reviewed release commit before publication |
| Phase 2 — reflection core | PASS (local) | `move/reflection-core`; immutable publication policy and one-time claim-backed mode initialization; fixed supply with no retained mint authority; exact backing views; package-only events; clean initial schema; source digest `038b55aa...c1e5c87`; 37,887-byte dev-address sparse publish payload components; internal audit findings remediated | Exact-address release compilation, independent review, and finalized chain proof |
| Phase 3 — AMM and faucet | PASS (local) | `move/test-amm`; `move/test-assets`; 59 integration tests including claim-backed wallets, LP-owner payout, faucet pause, and non-operator bootstrap; Python and generated conformance witness; AMM digest `4674f3e5...2532f26` / 30,581 bytes; asset digest `7606d6ec...77522e` / 8,266 bytes | Exact-address release compilation, gas results, and finalized chain reconciliation |
| Phase 4 — client and indexer | PARTIAL | Offline-first SDK drafts; Cedra normalizer; event reducer; reconciler; snapshots; five-screen static dashboard; deterministic TypeScript tests | Finalized Cedra read adapter, wallet integration, persistent production store/worker, alert delivery, and new-user live journey |
| Phase 5 — closed Testnet pilot | OPEN (live) | Runbooks and gate definitions only | Approved deployment, participants, load sequence, pause/recovery exercises, and zero-discrepancy evidence |
| Phase 6 — open Testnet beta | OPEN (live) | Static dashboard and incident/release procedures only | Public deployment, faucet, synthetic generator, bug channel, changelogs, drills, and closed-pilot exit |
| Phase 7 — fresh deployment recovery | OPEN (live) | `ops/REDEPLOYMENT_RUNBOOK.md` | Signed trusted snapshot plus a second deployment and invariant-preserving reconciliation; no migration or arbitrary state-edit surface may be added |

## On-chain package definition of done

| Requirement | Status | Evidence |
|---|---|---|
| Fixed deployment tRFL supply; no post-initialization mint | PASS (local) | `reflection_token.move` drops the one-use mint reference after depositing the complete supply; core tests cover fixed grants and unchanged supply |
| Distribution, core reward, LP reward, and operator stores excluded | PASS (local) | Core initialization, pool/faucet initialization, frozen exact stores, and `all_operator_primary_stores_are_excluded` |
| Wallet transfers untaxed | PASS (local) | Core transfer test, Python invariants, and indexer native-hook replay |
| Supported swaps charge at most and normally exactly 1% | PASS (local) | Fee formula/unit boundary tests, buy/sell integration, and configurable 0-100 bps guard |
| Reflection fee physically reaches the core vault | PASS (local) | Sell/buy settlement tests and exact core-vault partition invariant |
| Wallet and canonical custody counted once | PASS (local) | `canonical_pool_is_an_exact_once_reward_position`, raw reserve/custody assertions, and generated conformance |
| Custody reward routes one-for-one to LP accounting | PASS (local) | Checkpoint integration proof and separate core/LP vault reconciliation |
| Both vault layers classify every base unit | PASS (local) | Tiny-fee, terminal-dust, Python property, indexer, and generated conformance tests |
| Wallet and LP claims preserve effective value | PASS (local) | Partial/full wallet and LP claim tests plus Python invariants |
| LP mint, burn, transfer, and claim prevent historical capture | PASS (local) | Checkpoint-before-mint/transfer, proportional burn, claim replay, and epoch-isolation tests |
| Pending rewards are spendable when hooks work | PASS (Testnet, claim-backed decision) | H1-H7 finalized in `ops/evidence/hook-probe-testnet.json`; exact explicit claims remain on chain | Automatic spending is deliberately disabled for the initial release because H8 is inconclusive; a later fresh deployment requires wallet evidence |
| Initial materialization mode is one-time and on chain | PASS (local) | One-time publisher-only post-publication initializer, `ProtocolInitialized.automatic_materialization`, mode view, no setter/conversion resource, immutable package policy, claim-backed positive and negative integration tests | Finalized core initialization event/view on the exact approved release artifact |
| AMM prices from net input and authoritative raw reserves | PASS (local) | Non-divisible AMM rounding unit, raw reserve/custody assertions, and cross-implementation witness |
| Buy quote/slippage uses net user receipt | PASS (local) | `buy_slippage_uses_net_user_receipt` and SDK quote assertions |
| Unclaimed LP rewards never change reserves or invariant | PASS (local) | Custody checkpoint and LP claim tests compare reserves before/after |
| Direct reserve, LP, custody route, and vault bypasses fail closed | PASS (local) | Direct tRFL/tUSD reserve deposit/withdrawal tests, frozen LP vault tests, package-only registry/LP mutators, private capabilities, and table-based account-bound LP shares |
| Zero LP supply and fresh epochs cannot inherit live custody or liabilities | PASS (local) | Final shutdown, claim-only dust, same-owner fresh-epoch, and reseed tests |
| Unsupported delegated custody fails closed | PASS (local) | Explicit wallet registration; custodian co-signature; funded, aliased, already-classified, wrong-owner, and pre-liable registration rejection; exact single custody binding; unsupported-store hook aborts; and no public adapter registrar |
| No speculative legacy-state transition surface | PASS (local) | Source scan plus one direct initial resource schema; no conversion resource or entry function |
| Economic events support independent replay | PASS (local) | Package-only Move event constructors; schema/release separation; exact package-address normalization; stateless fee receipts; evented initial authority/configuration; atomic transaction grouping; and snapshot reconciliation |
| Published logic cannot change after review | PASS (local) | `reflection-core`, `test-assets`, and `test-amm` all declare `upgrade_policy = "immutable"`; structural evidence test enforces it | Exact-address compiled manifest and finalized publication policy remain live evidence |
| Independent implementations converge | PASS (local) | Hand-authored vector and fixed-seed 64-operation witness executed by Python and Move |
| Structurally suitable for mainnet hardening | OPEN (human) | Internal local evidence only | Independent source/bytecode review and disposition of all high/critical findings |

## Quantitative gates

| Gate | Target | Current status | Required proof |
|---|---:|---|---|
| Reference-model operations | >= 1,000,000 | PASS (local) | Reproducible fixed-seed gate; rerun at reviewed release commit |
| On-chain synthetic transactions | >= 50,000 | OPEN (live) | Finalized indexed ledger range |
| Completed swaps | >= 10,000 | OPEN (live) | Reconciled `SwapExecuted` events |
| Distinct holder positions | >= 1,000 | OPEN (live) | Unique finalized eligible positions |
| Distinct LP positions | >= 100 | OPEN (live) | Unique finalized LP positions by epoch |
| Liquidity add/remove operations | >= 1,000 | OPEN (live) | Reconciled finalized liquidity events |
| Accounting and reward allocation | 100% | OPEN (live) | On-chain views plus independent replay at identical ledger versions |
| Core/LP vault discrepancy and unnamed units | 0 | OPEN (live) | Per-vault and combined snapshots |
| Raw reserve/custody discrepancy | 0 | OPEN (live) | Raw accessor, reserve, and custody view comparison |
| Successful bypasses or unauthorized actions | 0 | OPEN (live) | Negative finalized transactions plus event audit |
| Fresh-deployment rehearsal | >= 1 | OPEN (live) | Two signed manifests and trusted-snapshot reconciliation |
| Indexer recovery from snapshot | demonstrated | PARTIAL | Deterministic memory-store restart tests exist; live old-cursor recovery record is missing |
| Unresolved high/critical findings | 0 | OPEN (human) | Independent review and issue disposition |

## Known plan gaps to close before publication

1. Exact-address package builds, simulations, gas measurements, manifests,
   two human approvals, and finalized deployment evidence do not yet exist.
2. `docs/CONTRACT_SECURITY_AUDIT.md` is an internal author review; the required
   independent source/bytecode reviewer has not signed off.
3. Phase 4 remains deliberately deferred while contract work is the active
   priority; the static mock dashboard is not evidence of a live wallet journey.
