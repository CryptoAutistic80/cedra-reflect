# Cedra Testnet plan completion matrix

Last audited: 2026-07-21

This matrix maps `CEDRA_TESTNET_PLAN.md` to evidence that exists in the current
workspace. It deliberately distinguishes local source/test proof from finalized
Testnet evidence. A green local gate never authorizes publication,
funding, signing, or submission.

The contract package passed its authoritative local `make contract-verify`
gate, then the exact source commit was published to Testnet under explicit
operator authorization. `ops/evidence/testnet-deployment-89df1a0.md` records
the immutable packages, initialization, authority handoff, seeded liquidity,
four-holder CLI-wallet exercise, and final reconciliation. SDK/indexer
operation, frontend, large participant/load phases, and fresh-redeployment
recovery remain outside this bounded deployment claim. This project has one
operator and no external reviewer; author-side review is not labelled
independent assurance.

Status meanings:

- **PASS (local):** current source plus a scope-matched deterministic check.
- **PASS (Testnet):** finalized public-ledger evidence for the stated scope.
- **PARTIAL:** an implementation or template exists, but required evidence is
  incomplete or narrower than the plan.
- **OPEN (live):** requires finalized network, wallet, participant, or service
  evidence.
- **OPEN (human):** requires an independent person or release approval.
- **DEFERRED:** intentionally outside the current contract/release priority; it
  carries no completion claim.

## Current deterministic suite inventory

These counts are local test evidence only and must be reproduced from the exact
clean release commit before approval.

| Suite | Local result |
|---|---:|
| Move hook probe | 2 |
| Move reflection core | 8 |
| Move test assets | 0 package-local tests |
| Move test AMM | 5 |
| Move integration | 103 |
| **Move total** | **118** |
| TypeScript | 99 (78 core/SDK/indexer + 21 candidate assembler) |
| Python | 60 |
| Release tooling and JSON schemas | PASS |

## Phase exit conditions

| Plan phase | Status | Current authoritative evidence | Missing evidence or work |
|---|---|---|---|
| Phase 0 — network compatibility | PASS (Testnet, claim-backed) | `ops/evidence/hook-probe-testnet.json`: H1-H7 finalized; publish/init/transfer/materialisation/secondary-store gas recorded; CLI/REST/SDK agree; H8 explicitly failed/inconclusive; claim-backed mode selected | A later native-wallet distinct-derived-balance run is required only before any fresh automatic-materialisation deployment |
| Phase 1 — specification and model | PASS (local) | `docs/accounting-specification.md`; independent Python model; hand-authored vector; three independent fixed-seed Python/Move witnesses with 64 applied operations each; 27 AMM arithmetic boundary vectors; 60 Python tests; the clean release capture completed 1,000,000 applied state changes from 1,071,570 attempts with 70,626 no-ops, 944 rejected attempts, 2,002 full audits, 1,024 holders, and digest `a40abf6fd8f4b91c7152ba8a63016ef2ef49d2be6c698fdb4dcd87f6c16d90e9` | Preserve the clean provenance record and regenerate it whenever the selected commit changes |
| Phase 2 — reflection core | PASS (Testnet + local) | Immutable `ReflectionCore` package at the recorded core address; finalized initialization; fixed supply; explicit wallet claims; operational-admin rejection; exact core-vault and supply reconciliation; 8 core tests and full 118-test Move suite passed on deployed source | Large holder/load gates remain Phase 5 work |
| Phase 3 — AMM and faucet | PASS (Testnet + local) | Immutable `TestAssets` and `TestAmm`; finalized faucet/pool initialization, authenticated seed, repeated buy/sells, add/remove liquidity, LP transfer/claims, pause-domain test, custody/reserve and LP-vault reconciliation; all local conformance and arithmetic tests passed | Large swap/LP/load gates remain Phase 5 work |
| Phase 4 — client, release boundary, and indexer | PARTIAL | 78 deterministic SDK/indexer tests and 21 candidate-assembler tests; clean exact-address artifacts; finalized Testnet deployment and CLI-wallet evidence; finalized read adapter; exact-cursor reconciliation; durable file store, worker lock, alert journal, and snapshots | The bounded deployment used the operator-authorized CLI/profile path and does not claim an external independent release ceremony. Production indexer operation, alert delivery, live crash recovery, browser-wallet integration, and a public journey remain open |
| Phase 5 — closed Testnet pilot | PARTIAL (live) | Deployment and bounded four-holder/three-LP-profile functional exercise passed with zero-discrepancy snapshot | Quantitative participant/load sequence and recovery exercises |
| Phase 6 — open Testnet beta and frontend | DEFERRED / OPEN (live) | Public contract/faucet deployment plus static dashboard prototype; frontend work remains deferred | Browser/wallet evidence, synthetic generator, bug channel, changelogs, drills, and closed-pilot exit |
| Phase 7 — fresh deployment recovery | OPEN (live) | `ops/REDEPLOYMENT_RUNBOOK.md` | Signed trusted snapshot plus a second immutable deployment and invariant-preserving reconciliation; no legacy-state conversion or arbitrary state-edit surface may be added |

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
| Claim-backed wallet rewards are explicitly claimable; automatic spending is disabled | PASS (Testnet + local) | Finalized initialization reports automatic materialization `false`; four holder profiles accrued rewards and claimed through the CLI; pause and post-unpause claims behaved independently from LP claims |
| Release source hardcodes one-time claim-backed initialization | PASS (Testnet + local) | Exact published source and on-chain view confirm claim-backed mode; automatic behavior exists only in compiler-excluded test code; no setter or conversion resource |
| AMM prices from net input and authoritative raw reserves | PASS (local) | Non-divisible AMM rounding unit, raw reserve/custody assertions, and cross-implementation witness |
| Buy quote/slippage uses net user receipt | PASS (local) | `buy_slippage_uses_net_user_receipt` and SDK quote assertions |
| Unclaimed LP rewards never change reserves or invariant | PASS (local) | Custody checkpoint and LP claim tests compare reserves before/after |
| Direct reserve, LP, custody route, and vault bypasses fail closed | PASS (local) | Direct tRFL/tUSD reserve deposit/withdrawal tests, frozen LP vault tests, package-only registry/LP mutators, private capabilities, and table-based account-bound LP shares |
| Zero LP supply and fresh epochs cannot inherit live custody or liabilities | PASS (local) | Final shutdown, claim-only dust, same-owner fresh-epoch, and reseed tests |
| Unsupported delegated custody fails closed | PASS (local) | Explicit wallet registration; custodian co-signature; funded, aliased, already-classified, wrong-owner, and pre-liable registration rejection; exact single custody binding; unsupported-store hook aborts; and no public adapter registrar |
| No speculative legacy-state transition surface | PASS (local) | Source scan plus one direct initial resource schema; no conversion resource or entry function |
| Economic events support independent replay | PASS (local) | Package-only Move event constructors; schema/release separation; exact package-address normalization; stateless fee receipts; evented initial authority/configuration; atomic transaction grouping; and snapshot reconciliation |
| All three release packages declare immutable publication policy | PASS (Testnet + local) | On-chain package registries report policy `2`, upgrade number `0`, and the source digests recorded in `ops/evidence/testnet-deployment-89df1a0.md` |
| Independent implementations converge | PASS (local) | Hand-authored vector, three independent 64-operation fixed-seed witnesses, and 27 AMM boundary vectors execute consistently across Python and Move |
| Structurally suitable for later mainnet hardening | PASS (local design) / DEFERRED (mainnet assurance) | Author-side threat model and audit are complete for the Testnet reference; independent human review is recommended before mainnet or factory reuse |

## Quantitative gates

| Gate | Target | Current status | Required proof |
|---|---:|---|---|
| Reference-model operations | >= 1,000,000 | PASS (local clean record) | 1,000,000 applied / 1,071,570 attempts / 70,626 no-ops / 944 rejected / 2,002 audits / 1,024 holders / `automatic_materialization=false` / digest `a40abf6fd8f4b91c7152ba8a63016ef2ef49d2be6c698fdb4dcd87f6c16d90e9`; the provenance-bound report must match the selected reviewed commit |
| On-chain synthetic transactions | >= 50,000 | OPEN (live) | Finalized indexed ledger range |
| Completed swaps | >= 10,000 | OPEN (live) | Reconciled `SwapExecuted` events |
| Distinct holder positions | >= 1,000 | OPEN (live) | Unique finalized eligible positions |
| Distinct LP positions | >= 100 | OPEN (live) | Unique finalized LP positions by epoch |
| Liquidity add/remove operations | >= 1,000 | OPEN (live) | Reconciled finalized liquidity events |
| Accounting and reward allocation | 100% | PASS (bounded Testnet snapshot) | Exact supply, core-vault, LP-vault, holder, share, and custody reconciliation by ledger version `149626840`; large-load replay remains open |
| Core/LP vault discrepancy and unnamed units | 0 | PASS (bounded Testnet snapshot) | Core `1 = 0 liability + 1 rounding`; LP `2 = 1 aggregate liability + 1 rounding` |
| Raw reserve/custody discrepancy | 0 | PASS (bounded Testnet snapshot) | Both report `515018007` tRFL base units |
| Successful bypasses or unauthorized actions | 0 | PASS (bounded negative suite) | Former-publisher admin, paused swap, paused wallet claim, and LP double-claim simulations rejected before submission; broad adversarial load remains open |
| Fresh-deployment rehearsal | >= 1 | OPEN (live) | Two finalized manifests, per-transaction detached approvals, and trusted-snapshot reconciliation |
| Indexer recovery from snapshot | demonstrated | PARTIAL | Deterministic durable file-store restart, single-writer lock, exact-cursor checkpoint, corruption rejection, and alert-journal tests exist; deployed old-cursor/crash recovery and external alert-delivery evidence are missing |
| Unresolved high/critical findings | 0 | OPEN (human) | Independent human review and issue disposition |

## Remaining plan gaps after bounded deployment

1. The 50,000-transaction, 10,000-swap, 1,000-holder, 100-LP-position, and
   1,000-liquidity-operation public-pilot gates have not been run.
2. A fresh second immutable deployment and trusted-snapshot recovery rehearsal
   remain open.
3. Production indexer operation, external alert delivery, and browser-wallet
   evidence remain open; local SDK/indexer tests are not live-service proof.
4. `docs/CONTRACT_SECURITY_AUDIT.md` is an internal author review; no independent
   human source/bytecode reviewer has signed off.
5. Frontend work remains deliberately deferred while contract and release
   safety are the active priority; the static mock dashboard is not evidence of
   a live wallet journey.
6. This release creates one hard-bound tRFL instance across three immutable
   packages. It is a secure single-token reference, not a token factory; a
   multi-instance factory requires a separate architecture and review phase.
