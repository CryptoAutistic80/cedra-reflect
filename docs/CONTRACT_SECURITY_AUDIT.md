# Cedra Reflect v0.2 internal contract security audit

Status: author-side local source/accounting review complete; exact-address,
gas, and finalized Testnet qualification remain open.
Date: 2026-07-21.

This is an internal review by the operator and Codex. It is not independent
human assurance. Its scope is the publishable Move source in
`move/reflection-core`, `move/test-assets`, and `move/test-amm`, plus the
accounting model and replay boundary that verify it. v0.1 conclusions do not
carry forward automatically.

## Security objectives

- A creator can choose a 0–500 bps reflection fee once, but cannot later alter
  that fee or any other economic/control parameter.
- The complete tRFL supply is minted once; no mint, burn, sweep, forced balance,
  blacklist, pause, recovery, or arbitrary transfer authority remains.
- Launch atomically binds exact source-named modules, stores, capabilities,
  fixed liquidity, and the signing LP beneficiary before setup authority ends.
- Wallets and canonical custody are counted exactly once. New, incoming,
  bought, sold, and transferred weight cannot capture historical rewards.
- Pool reflections reach beneficial LP owners through a separately backed
  checkpointed index, never by treating the pool address as the beneficiary.
- The last LP can exit without an administrator and permanently closes the
  pool with exact reserve/custody reconciliation.
- Every public mutation either preserves all supply/vault/share identities or
  aborts atomically.

## Trust and threat model

Cedra signer authentication, Move type safety, the pinned Cedra Framework
revision, and correct execution of dispatchable fungible-asset hooks are
trusted. Exact compiled bytes, immutable publication policy, upgrade number,
and Testnet chain behavior must still be verified at release time.

Creators and all four launch signers may be malicious after launch. They may
call every public entry, fund normal wallets, and coordinate transactions, but
must have no privileged result. An attacker may use wrong stores, secondary
stores, wrong metadata, forged-looking addresses, tiny/large arithmetic inputs,
fragmented LP ownership, reordered calls, aborted transactions, and repeated
initialization/launch attempts.

Unsupported external vaults and pools are not trusted integrations. They fail
closed because the contract cannot prove their beneficial owners.

## Authority and capability review

- `reflection_token::initialize` requires the exact core package address,
  succeeds once, bounds the fee, mints the fixed supply, and stores no `MintRef`.
- The retained core `TransferRef` and `RawBalanceRef` are private fields under
  the immutable core address and are never returned.
- Settlement/faucet/custody/LP/tUSD capabilities have private fields, lack
  `copy` and `drop`, are issued once while `CONFIGURING`, and are moved directly
  into the exact consuming package resource.
- `pool::launch` accepts only four signers and no caller-selected amount,
  control address, store, fee, or limit. Sealing is the last step, so a failed
  prerequisite rolls all earlier capability/store mutations back.
- All remaining publisher-authenticated functions require `CONFIGURING`; no
  transition returns to that state. Immutable packages prevent replacement
  with a module that could recover the private capabilities.
- Static production ABI review finds no fee/config setter, pause, admin,
  rotation, blacklist, shutdown, reseed, later epoch, migration, arbitrary
  tRFL mint/transfer, or generic exclusion/adapter entry.

Conclusion: publisher addresses are provenance, not post-launch authority.

## Value-flow review

### Wallets

The hook validates canonical primary-store identity and explicit registration.
Send and receive each materialize history before their weight change. A
self-transfer is accounting-neutral after one materialization. The derived
balance path returns checked `raw + pending` without mutating state.

### Swaps

Sell removes gross seller weight before index advance; only remaining seller
units earn the fee. Buy removes gross custody weight before index advance and
adds net buyer weight afterward; purchased units cannot earn their own fee.
Pre-existing buyer holdings do earn and immediately materialize the fee. The
physical fee reaches the core vault before the index changes.

### Custody and LPs

The exact frozen pool store is a manually counted custody position and excluded
from normal wallet classification. Every swap checkpoints before and after
settlement; the postcondition requires pool pending zero. The routed amount
moves one-for-one from the core vault to the exact frozen LP vault before the LP
index advances.

LP add/remove/transfer pays affected historical rewards before weights change.
Both transfer endpoints are paid first. Payout-to-address derives and validates
only that address's registered primary store. No loop over holders or LPs
exists.

### Final exit

When one burn equals total active shares, output is the complete current tRFL
and tUSD reserve rather than a proportional floor. The final owner is paid
first, both reserves and custody shares must reach zero, pool pending must be
zero, active shares are retired, and both core/pool lifecycles become `CLOSED`.
Terminal fractional/rounding evidence is not an operator-withdrawable surplus.

## Arithmetic and backing review

- Fee multiplication widens before division and narrows only after bounds.
- Index/correction operations use checked `u256` magnitudes and explicit sign.
- Token/reserve paths stay within `u64`; LP shares stay within `u128`.
- AMM quotes and settlement use the same integer ordering. Buy slippage applies
  to net tRFL output and sell pricing uses tRFL after reflection fee.
- Core and LP vaults each maintain both a liability partition and an independent
  lifetime-inflow-minus-outflow identity.
- Wallet/custody movements apply paired corrections at one index, preserving
  total global shares.
- Wrong capability/store/owner, zero or excessive amount, stale lifecycle,
  reserve/custody mismatch, under-backed payout, and overflow abort the entire
  transaction.

## Findings and dispositions

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| V02-001 | Critical | v0.1 retained mutable operational controls that violate the required ownerless trust model. | Removed rather than migrated. v0.2 is a fresh immutable deployment with no production setter/pause/admin/rotation/shutdown/reseed surface. |
| V02-002 | High | Split setup calls could leave partially bound protocol state or preserve publisher recovery authority. | `pool::launch` atomically performs every binding/seed/seal step; setup functions require `CONFIGURING` and abort forever afterward. |
| V02-003 | High | Claim-backed behavior did not automatically make pending rewards spendable during standard interactions. | All send/receive/buy/sell/liquidity paths materialize complete whole pending rewards in historical-safe order; manual claims remain fallback. |
| V02-004 | High | Pool custody earned reflections at the pool address unless explicitly passed through to LP beneficial owners. | Exact custody binding plus mandatory pre/post-swap checkpoint routes one-for-one into a separately backed LP index. |
| V02-005 | High | Final proportional withdrawal could strand reserve floor dust or require an administrator to end the pool. | A permissionless total-share burn returns exact reserves, proves zero custody discrepancy, and closes permanently. |
| V02-006 | Medium | A new wallet, buyer, liquidity provider, or LP transferee could capture rewards earned before its weight arrived. | Every affected position is materialized/checkpointed first, then correction deltas attach new weight at the current index. |
| V02-007 | Medium | An arbitrary recipient store could redirect automatic LP payout. | Address payout derives the exact registered primary store and requires the custody settlement capability. |
| V02-008 | Medium | A creator-selected fee could exceed the documented economic envelope or later change. | Initialization accepts exactly 0–500 bps; 501 aborts; no mutation function or mutable authority field exists. |
| V02-009 | Medium | Direct deposits to frozen canonical stores could desynchronize reserve/custody or LP accounting. | Exact reserve/vault stores are frozen and only capability settlement mutates them; direct-store negative tests abort. |
| V02-010 | Low | Off-chain SDK builders could imply obsolete admin capabilities or become confused with contract enforcement. | v0.2 removes obsolete transaction builders and retains only optional read/replay/release verification. Move has no dependency on TypeScript. |

No unresolved Critical, High, Medium, or Low source finding is currently
identified. The working-tree gate passed 36 Move tests, 72 Python tests, 79
TypeScript tests, 16 release-assembler tests, static production ABI checks,
deterministic conformance, and 1,000,000 successful randomized operations with
zero reconciliation discrepancy. This conclusion remains provisional until the
same gate is bound to a clean commit, fresh exact-address ABI/artifacts pass,
and the open Testnet/gas qualification is completed.

## Verification required to close the review

- Strict Move build/lint and all package/integration tests.
- Production ABI allowlist over compiled/source surfaces.
- Independent Python and TypeScript replay/model parity.
- Deterministic witnesses and one-million-operation invariant run across the
  full 0–500 bps creation range.
- Maximum-path gas comparison against v0.1 and Testnet ceiling.
- Exact-address immutable metadata/bytecode/source digest verification.
- Fresh Testnet hook/derived-balance compatibility, simulation-before-submit,
  four-holder repeated-trade proof, LP movement/final-close proof, former-
  publisher negative simulations, and zero finalized reconciliation.

Local green tests do not prove deployment, wallet display, finalized chain
state, large pilot load, or external review. Mainnet or a production factory
still requires independent external security review.
