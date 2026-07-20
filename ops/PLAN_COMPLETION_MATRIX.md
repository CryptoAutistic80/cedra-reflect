# Cedra Testnet plan completion matrix

Last audited: 2026-07-20

This matrix maps `CEDRA_TESTNET_PLAN.md` to evidence that exists in the current
workspace. It deliberately distinguishes local source/test proof from finalized
Devnet or Testnet evidence. A green local gate never authorizes publication,
funding, signing, or submission.

Status meanings:

- **PASS (local):** current source plus a scope-matched deterministic check.
- **PARTIAL:** an implementation or template exists, but required evidence is
  incomplete or narrower than the plan.
- **OPEN (live):** requires finalized network, wallet, participant, or service
  evidence.
- **OPEN (human):** requires an independent person or release approval.

## Phase exit conditions

| Plan phase | Status | Current authoritative evidence | Missing evidence or work |
|---|---|---|---|
| Phase 0 — network compatibility | PARTIAL | Pinned framework in every `Move.toml`; local `hook-probe` test; `move/docs/HOOK_COMPATIBILITY.md`; `ops/HOOK_PROBE.md` | Finalized Devnet and Testnet H1-H8 records, SDK/wallet display results, gas measurements, and signed automatic-materialisation versus claim-backed decision |
| Phase 1 — specification and model | PASS (local) | `docs/accounting-specification.md`; independent Python model; hand-authored vector; fixed-seed generated Python/Move witness; one-million-operation gate | Re-run from the exact reviewed release commit before publication |
| Phase 2 — reflection core | PASS (local) | `move/reflection-core`; core and integration tests; exact backing views; raw-store accessor; clean initial schema | Exact-address release compilation, independent review, and finalized chain proof |
| Phase 3 — AMM and faucet | PASS (local) | `move/test-amm`; `move/test-assets`; 54 integration tests; Python and generated conformance witness | Exact-address release compilation, gas results, and finalized chain reconciliation |
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
| Pending rewards are spendable when hooks work | PARTIAL | Local VM hook probe and auto-materialisation integration pass | Finalized Devnet/Testnet and wallet compatibility decision |
| AMM prices from net input and authoritative raw reserves | PASS (local) | Non-divisible AMM rounding unit, raw reserve/custody assertions, and cross-implementation witness |
| Buy quote/slippage uses net user receipt | PASS (local) | `buy_slippage_uses_net_user_receipt` and SDK quote assertions |
| Unclaimed LP rewards never change reserves or invariant | PASS (local) | Custody checkpoint and LP claim tests compare reserves before/after |
| Direct reserve, LP, custody route, and vault bypasses fail closed | PASS (local) | Direct tRFL/tUSD reserve deposit/withdrawal tests, frozen LP vault tests, private capabilities, and table-based account-bound LP shares |
| Zero LP supply and fresh epochs cannot inherit live custody or liabilities | PASS (local) | Final shutdown, claim-only dust, same-owner fresh-epoch, and reseed tests |
| Unsupported delegated custody fails closed | PASS (local) | Explicit wallet registration; custodian co-signature; funded, aliased, already-classified, wrong-owner, and pre-liable registration rejection; exact single custody binding; unsupported-store hook aborts; and no public adapter registrar |
| No speculative legacy-state transition surface | PASS (local) | Source scan plus one direct initial resource schema; no conversion resource or entry function |
| Economic events support independent replay | PASS (local) | Move event surfaces, normalizer/reducer tests, atomic transaction grouping, and snapshot reconciliation |
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

1. The committed metadata URIs are `example.invalid` placeholders and cannot
   be used for an approved public pilot artifact.
2. Phase 4 remains deliberately deferred while contract work is the active
   priority; the static mock dashboard is not evidence of a live wallet journey.
