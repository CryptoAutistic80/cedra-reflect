# Cedra Testnet plan completion matrix

Last audited: 2026-07-21

This matrix maps `CEDRA_TESTNET_PLAN.md` to evidence that exists in the current
workspace. It deliberately distinguishes local source/test proof from finalized
Testnet evidence. A green local gate never authorizes publication,
funding, signing, or submission.

The active deliverable is now the local contract package. Its authoritative
gate is `make contract-verify`. Live deployment, release ceremony, SDK/indexer
operation, frontend, and pilot phases are retained below as deferred context,
not as blockers to contract completion. This project has one operator and no
external reviewer; author-side review is not labelled independent assurance.

No transaction for the five-role release deployment has finalized Testnet
evidence. The earlier hook probe is an isolated network-compatibility record;
it is not package-publication, initialization, authority-handoff, liquidity, or
account-control evidence for this release.

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
| Phase 2 — reflection core | PASS (local) | `move/reflection-core`; immutable publication policy and one-time claim-backed mode initialization; fixed supply with no retained mint authority; exact backing views; package-only events; clean initial schema; 8 core tests and the full 118-test Move suite pass locally; author-side audit records no unresolved rated finding | Re-run `make contract-verify` on the final selected source tree |
| Phase 3 — AMM and faucet | PASS (local) | `move/test-amm`; `move/test-assets`; AMM and integration tests cover deployment-scale claim-backed flow, wallet/LP exact-once rewards, faucet pause, explicit AMM tUSD funding, atomic four-party handoff, atomic registration of the authenticated bootstrap LP, and a clean exact-address bundle; assets has no package-local tests but is exercised by integration; all three generated conformance witnesses and arithmetic boundary vectors pass | Re-run `make contract-verify` on the final selected source tree |
| Phase 4 — client, release boundary, and indexer | PARTIAL | 78 deterministic SDK/indexer tests and 21 candidate-assembler tests plus green generated-conformance, release-tooling, and schema checks; SDK/indexer parity recheck GO; release-tooling re-audit GO; offline drafts; generic Cedra single/multi-agent build and exact identity extraction; identity-preserving simulation; executable keyless assembler with explicit local ABIs for all nine release operations, runtime SDK pin, public-profile/authenticator binding, pre-publication validation, and atomic private output; finalized read adapter; unknown-event and non-Testnet fail-closed checks; exact-cursor reconciliation gates; durable file store, single-writer worker lock, alert journal, and snapshots | These are deterministic local/runtime boundaries only. Candidate, approval, and finalized-evidence paths require an externally isolated different-owner read-only release root, exact executable closure, real signed SDK-review attestation and external trust anchor, and two independent transaction approvals. The SDK and assembler have no sign/submit API, and no actual candidate exists until clean bound inputs and fresh transaction controls produce a successful Testnet simulation. An independently reviewed external ceremony must add only authenticators, re-extract the approved raw/wrapper/signing-message identity, and submit without rebuilding. Production service operation, external alert delivery, live crash recovery, wallet integration, and a live journey remain open |
| Phase 5 — closed Testnet pilot | OPEN (live) | Runbooks and gate definitions only | Approved deployment, participants, load sequence, pause/recovery exercises, and zero-discrepancy evidence |
| Phase 6 — open Testnet beta and frontend | DEFERRED / OPEN (live) | Static dashboard prototype and incident/release procedures only; frontend work is outside the current contract priority | Browser/wallet evidence, public deployment, faucet, synthetic generator, bug channel, changelogs, drills, and closed-pilot exit |
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
| Claim-backed wallet rewards are explicitly claimable; automatic spending is disabled | PASS (local implementation; bounded Testnet probe supports the decision) | The production initializer hardcodes claim-backed mode. H1-H7 finalized in `ops/evidence/hook-probe-testnet.json`; H8 did not prove wallet automatic-materialization behavior. Finalized initialization and explicit-claim evidence for the exact release artifact remain open |
| Release source hardcodes one-time claim-backed initialization | PASS (local) | Publisher-only post-publication initializer hardcodes claim-backed mode; automatic behavior exists only in compiler-excluded test code; no setter or conversion resource. The exact release still needs a finalized initialization event/view |
| AMM prices from net input and authoritative raw reserves | PASS (local) | Non-divisible AMM rounding unit, raw reserve/custody assertions, and cross-implementation witness |
| Buy quote/slippage uses net user receipt | PASS (local) | `buy_slippage_uses_net_user_receipt` and SDK quote assertions |
| Unclaimed LP rewards never change reserves or invariant | PASS (local) | Custody checkpoint and LP claim tests compare reserves before/after |
| Direct reserve, LP, custody route, and vault bypasses fail closed | PASS (local) | Direct tRFL/tUSD reserve deposit/withdrawal tests, frozen LP vault tests, package-only registry/LP mutators, private capabilities, and table-based account-bound LP shares |
| Zero LP supply and fresh epochs cannot inherit live custody or liabilities | PASS (local) | Final shutdown, claim-only dust, same-owner fresh-epoch, and reseed tests |
| Unsupported delegated custody fails closed | PASS (local) | Explicit wallet registration; custodian co-signature; funded, aliased, already-classified, wrong-owner, and pre-liable registration rejection; exact single custody binding; unsupported-store hook aborts; and no public adapter registrar |
| No speculative legacy-state transition surface | PASS (local) | Source scan plus one direct initial resource schema; no conversion resource or entry function |
| Economic events support independent replay | PASS (local) | Package-only Move event constructors; schema/release separation; exact package-address normalization; stateless fee receipts; evented initial authority/configuration; atomic transaction grouping; and snapshot reconciliation |
| All three release packages declare immutable publication policy | PASS (local) | `reflection-core`, `test-assets`, and `test-amm` declare `upgrade_policy = "immutable"`, and structural tests enforce it. Exact-address compiled manifests and finalized on-chain policy remain open |
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
| Accounting and reward allocation | 100% | OPEN (live) | On-chain views plus independent replay at identical ledger versions |
| Core/LP vault discrepancy and unnamed units | 0 | OPEN (live) | Per-vault and combined snapshots |
| Raw reserve/custody discrepancy | 0 | OPEN (live) | Raw accessor, reserve, and custody view comparison |
| Successful bypasses or unauthorized actions | 0 | OPEN (live) | Negative finalized transactions plus event audit |
| Fresh-deployment rehearsal | >= 1 | OPEN (live) | Two finalized manifests, per-transaction detached approvals, and trusted-snapshot reconciliation |
| Indexer recovery from snapshot | demonstrated | PARTIAL | Deterministic durable file-store restart, single-writer lock, exact-cursor checkpoint, corruption rejection, and alert-journal tests exist; deployed old-cursor/crash recovery and external alert-delivery evidence are missing |
| Unresolved high/critical findings | 0 | OPEN (human) | Independent human review and issue disposition |

## Known plan gaps to close before publication

1. Five explicit Cedra Testnet profiles and public candidate addresses exist,
   and a local public-only profile capture verifies names and public-key/address
   derivation. It is not yet bound into an approved release candidate and proves
   neither account existence, funding, private-key control, nor release
   authorization. A clean verification-bound exact-address bundle and private
   reviewer handoff now exist locally; external account activation and gas
   funding may occur only after that bundle passes independent human review and
   remain separate from the nine operations.
2. The exact payload, candidate, BCS, simulation, approval, read-only collection
   validators, and executable keyless assembler for all nine operations exist.
   An independently reviewed Cedra ceremony that adds only authenticators,
   re-extracts the approved raw transaction, unsigned wrapper, and signing
   message, and submits without rebuilding does not exist in this repository.
   That remains a genuine operator gate.
3. Every proposed transaction still needs a successful exact-identity
   simulation, approved gas ceilings, two distinct OpenSSH-key approvals, the
   required Cedra account signatures, external submission, and finalized
   read-only Testnet evidence. The authenticated AMM tUSD bootstrap claim,
   atomic operational handoff, and authenticated bootstrap LP seed have no live
   evidence.
4. `docs/CONTRACT_SECURITY_AUDIT.md` is an internal author review; the required
   independent human source/bytecode reviewer has not signed off.
5. Frontend work remains deliberately deferred while contract and release
   safety are the active priority; the static mock dashboard is not evidence of
   a live wallet journey.
6. This release creates one hard-bound tRFL instance across three immutable
   packages. It is a secure single-token reference, not a token factory; a
   multi-instance factory requires a separate architecture and review phase.
