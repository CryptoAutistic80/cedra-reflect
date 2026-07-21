# Cedra Reflect v0.2 completion matrix

Last updated: 2026-07-21. This matrix distinguishes source implementation,
local deterministic evidence, finalized Testnet evidence, and canonical pilot
evidence. v0.1 evidence is historical and cannot satisfy a v0.2 row.

Status meanings:

- **IMPLEMENTED:** source exists but the complete clean gate is not yet bound.
- **PASS (local):** reproduced deterministic evidence for the selected source.
- **PASS (Testnet):** finalized v0.2 ledger or wallet evidence.
- **OPEN:** required evidence does not yet exist.
- **DEFERRED:** deliberately outside v0.2 scope.

## Contract requirements

| Requirement | Status | Required or current evidence |
|---|---|---|
| Creation-selected fee 0–500 bps; 100 bps instance | PASS (local) | Core tests for 0, 1, 100, 500 and rejected 501; exact initialization payload is `100` |
| Fixed tRFL supply; mint capability destroyed | PASS (local) | Source/ABI review, supply tests, and zero-discrepancy model reconciliation |
| Atomic source-bound launch | PASS (local) | Four-signer launch tests, rollback tests, five-operation release candidate |
| Ownerless after launch | PASS (local) | ABI deny/allowlist plus former-publisher negative tests; no setter/pause/admin/rotation/shutdown/reseed |
| Derived wallet balance is raw plus pending | PASS (local) | Move hook tests pass; fresh Testnet CLI/REST/wallet compatibility remains open |
| Automatic send/receive materialization | PASS (local) | Endpoint, self-transfer, spend-effective, and historical-capture tests |
| Automatic buy/sell materialization | PASS (local) | Old/incoming/remaining/sold entitlement and exact-fee tests |
| Automatic post-swap pool checkpoint | PASS (local) | Every successful model and Move buy/sell ends with pool pending zero and LP backing increased |
| LP endpoint materialization | PASS (local) | Add/remove/transfer historical ownership and recipient-store tests |
| Permissionless exact final close | PASS (local) | Fragmented LP, exact reserve exit, zero discrepancy, permanent-close tests |
| Manual wallet/LP fallback claims | PASS (local) | Unpausable owner/permissionless checkpoint tests, including after close where applicable |
| Unsupported stores/custody fail closed | PASS (local) | Secondary/wrong/funded/aliased store negative tests |
| O(1) holder and LP behavior | PASS (local) | No iteration over holder/LP position tables; finalized v0.2 gas comparison remains open |

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
| Maximum-path gas | <= 2.5x v0.1 and < 80% Testnet ceiling | OPEN |
| Exact-address artifacts | immutable policy 2, upgrade 0, exact source digests | PASS (local dummy-address build); fresh profile-address build OPEN |

The working-tree gate is useful implementation evidence, not a clean release
record. Its million-operation digest is
`b6b667a035d559cfcbcb20ed028f1da6162ab2b5068333eb367e675a2e46ebe9`.
All counts and digests must be regenerated from a clean final commit and bound
to the exact-address artifacts before submission.

## Testnet deployment and compatibility

| Gate | Status | Required evidence |
|---|---|---|
| Fresh v0.2 CLI profiles | OPEN | Core/assets/AMM/bootstrap plus Alice/Bob/Carol/Dave, all Testnet-bound |
| Distinct raw/derived hook probe | OPEN | Finalized raw != derived evidence and secondary-store rejection |
| CLI/REST/read-adapter agreement | OPEN | Same finalized version and exact derived balance |
| Real wallet display | OPEN | Playwright compatibility evidence; no frontend |
| Five release operations simulated | OPEN | Publish, initialize(100), publish, publish, launch; simulate before submission |
| Fresh immutable v0.2 deployment | OPEN | New addresses/identity, policy 2, upgrade 0, source digests, bound fee |
| Ownerless negative suite | OPEN | Every former publisher has no privileged post-launch success |
| Four-holder ten-cycle exercise | OPEN | Per-trade fee/materialization/passive-holder/pool/LP/reconciliation record |
| LP movement and final close | OPEN | Add, partial/full remove, transfer, fragmented permissionless close |
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
