# Cedra Reflect v0.2 completion matrix

Last updated: 2026-07-21. This matrix distinguishes source implementation,
local deterministic evidence, finalized Testnet evidence, and canonical pilot
evidence. v0.1 evidence is historical and cannot satisfy a v0.2 row.

Status meanings:

- **IMPLEMENTED:** source exists but the complete clean gate is not yet bound.
- **PASS (local):** reproduced deterministic evidence for the selected source.
- **PASS (Testnet):** finalized v0.2 ledger or wallet evidence.
- **PARTIAL:** part of the stated gate has passed, with the remaining evidence
  named explicitly.
- **OPEN:** required evidence does not yet exist.
- **DEFERRED:** deliberately outside v0.2 scope.

## Contract requirements

| Requirement | Status | Required or current evidence |
|---|---|---|
| Creation-selected fee 0–500 bps; 100 bps instance | PASS (Testnet) | Local boundary tests plus finalized `initialize(100)` and immutable fee view |
| Fixed tRFL supply; mint capability destroyed | PASS (Testnet) | Source/ABI review plus exact live physical-supply reconciliation |
| Atomic source-bound launch | PASS (Testnet) | Finalized four-signer launch plus repeated-launch rejection |
| Ownerless after launch | PASS (Testnet) | Deployed ABI denylist and former-publisher surface review; no setter/pause/admin/rotation/shutdown/reseed |
| Derived wallet balance is raw plus pending | PASS (Testnet) | Genuine raw/pending split returned identically by CLI framework view and REST; real-wallet display remains a separate gate |
| Automatic send/receive materialization | PASS (Testnet) | Standard primary-store transfers materialized Bob, Carol and Dave before debit |
| Automatic buy/sell materialization | PASS (Testnet) | Ten alternating finalized swaps left Alice pending zero and charged the exact immutable fee |
| Automatic post-swap pool checkpoint | PASS (Testnet) | Pool core pending was zero and LP backing increased after every recorded swap |
| LP endpoint materialization | PASS (Testnet) | Finalized add, reward-bearing transfer, partial removal and non-final full-position removal |
| Permissionless exact final close | PASS (local) | Fragmented LP, exact reserve exit, zero discrepancy, permanent-close tests |
| Manual wallet/LP fallback claims | PASS (Testnet) | Finalized wallet `claim_all` and direct bootstrap LP claim-all both left pending zero |
| Unsupported stores/custody fail closed | PASS (local) | Secondary/wrong/funded/aliased store negative tests |
| O(1) holder and LP behavior | PASS (Testnet) | No iteration over holder/LP position tables; measured non-final live paths remain far below the Testnet ceiling |

## Local verification

| Gate | Target | Status |
|---|---:|---|
| Move core/assets/AMM lint | zero accepted warnings | PASS (local, working tree) |
| Move unit/integration tests | all pass | PASS (local, working tree): 36/36 |
| Python accounting tests | all pass | PASS (local, working tree): 72/72 |
| TypeScript read/index/release tests | all pass | PASS (local, working tree): 79/79 plus 16/16 assembler |
| Deterministic Move/Python witnesses | generated artifact current | PASS (local, working tree) |
| Production ABI allowlist | no forbidden surface | PASS (local, working tree) |
| Random creation fees | full 0–500 range | PASS (local, working tree) |
| Randomized accounting operations | at least 1,000,000 successful | PASS (local, working tree): 1,000,000 successful in 1,084,627 attempts |
| Unexplained discrepancy | zero | PASS (local, working tree) |
| Maximum-path gas | <= 2.5x v0.1 and < 80% Testnet ceiling | PARTIAL: all measured non-final paths PASS; final close OPEN |
| Exact-address artifacts | immutable policy 2, upgrade 0, exact source digests | PASS (Testnet): all three finalized packages match fresh-address artifacts |

The working-tree gate is useful implementation evidence, not a clean release
record. Its million-operation digest is
`b6b667a035d559cfcbcb20ed028f1da6162ab2b5068333eb367e675a2e46ebe9`.
All counts and digests must be regenerated from a clean final commit and bound
to the exact-address artifacts before submission.

## Testnet deployment and compatibility

| Gate | Status | Required evidence |
|---|---|---|
| Fresh v0.2 CLI profiles | PASS (Testnet) | Core/assets/AMM/bootstrap plus Alice/Bob/Carol/Dave, all separately Testnet-bound |
| Distinct raw/derived hook probe | PARTIAL | Finalized raw != derived probe PASS; secondary-store rejection remains open |
| CLI/REST/read-adapter agreement | PASS (Testnet) | CLI and REST returned exact derived balance `1,000,484,828` for raw `1,000,440,819` plus pending `44,009` |
| Real wallet display | OPEN | Playwright compatibility evidence; no frontend |
| Five release operations simulated | PARTIAL | Initialize, assets publish, AMM publish and launch used the same simulated/submitted object; core publish did not due recorded CLI behavior |
| Fresh immutable v0.2 deployment | PASS (Testnet) | Fresh addresses, policy 2, upgrade 0, exact source digests, fee 100 and sealed LIVE state |
| Ownerless negative suite | PASS (Testnet) | Repeated init/launch reject; deployed ABI exposes no privileged post-launch entry point to any former publisher |
| Four-holder ten-cycle exercise | PASS (Testnet) | Per-trade exact fee, automatic materialization, passive growth, pool checkpoint, LP growth and exact reconciliation |
| LP add/remove/transfer | PASS (Testnet) | Finalized add, partial/full-position remove and reward-bearing endpoint transfer |
| Fragmented permissionless final close | OPEN | Deliberately retained bootstrap position so the canonical pilot can continue |
| Post-close failures | OPEN | Swap/liquidity/launch/reseed simulation rejection |

## Canonical pilot gates

| Gate | Target | Status |
|---|---:|---|
| Finalized synthetic transactions | 50,000 | OPEN |
| Completed swaps | 10,000 | OPEN |
| Distinct holders | 1,000 | OPEN |
| Distinct LP positions | 100 | OPEN |
| Unexplained reconciliation discrepancy | 0 | OPEN |

v0.2 cannot be called canonical before these pass. A bounded deployment or
four-wallet exercise is not the same as the full pilot.

## Scope boundaries

| Item | Status |
|---|---|
| Single-token reference implementation | in scope |
| Future reflection-token factory | DEFERRED |
| Frontend application | DEFERRED |
| Playwright wallet compatibility evidence | in scope after deployment |
| v0.1 migration/conversion code | prohibited |
| v0.1 retirement | separate operator action after all v0.2 canonical gates |
| External security review | required before mainnet/factory, not Testnet blocker |
