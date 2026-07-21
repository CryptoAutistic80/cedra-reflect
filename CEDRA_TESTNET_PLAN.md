# Cedra Reflect v0.2 ownerless automatic-reflection Testnet plan

Status: contract implementation and deterministic local verification passed;
a fresh ownerless v0.2 instance is deployed and has passed the bounded
four-wallet and non-final LP Testnet exercises. It is not canonical until the
remaining compatibility, final-close, release-procedure and live-pilot gates
below are evidenced. The current results and exact open gates are recorded in
[`ops/evidence/testnet-deployment-v02-c95c4fe.md`](ops/evidence/testnet-deployment-v02-c95c4fe.md)
and [`ops/PLAN_COMPLETION_MATRIX.md`](ops/PLAN_COMPLETION_MATRIX.md). v0.1 is a
separate historical deployment.

## Objective

Deploy a fresh immutable, fixed-supply tRFL reference token whose reflection
fee is selected once at creation, whose canonical pool passes reserve rewards
through to LP owners, and whose creator has no post-launch control. This is one
token instance and a secure template for a later factory. A factory and
frontend are out of scope.

Locked parameters for the v0.2 Testnet instance:

| Parameter | Value |
|---|---:|
| Reflection-fee creation range | 0–500 bps |
| Selected tRFL reflection fee | 100 bps |
| Ordinary wallet-transfer fee | 0 bps |
| AMM fee | source-fixed 30 bps |
| Fixed tRFL supply | 1,000,000,000 tokens (1,000,000,000,000,000 base units) |
| Bootstrap tRFL reserve | 500,000,000 base units |
| Bootstrap tUSD reserve | 500,000,000 base units |
| Upgrade policy | immutable, upgrade number 0 |

## Contract lifecycle

### CONFIGURING

`reflection_token::initialize(creator, reflection_fee_bps)` must:

- require the source-bound core publisher;
- accept 0–500 bps and reject 501 or more;
- succeed exactly once;
- mint the complete fixed supply and destroy the tRFL mint capability;
- store the selected fee without any mutation function; and
- emit `TokenCreated` with supply, decimals, fee, release, deployment identity,
  metadata address, reward vault, and distribution vault.

Setup-only capability issuance and canonical store binding are allowed only in
this state. The capabilities are non-copyable, source-bound, retained inside
the immutable modules, and restricted to their settlement purpose.

### LIVE

`pool::launch(core, assets, amm, bootstrap_lp)` is the only launch coordinator.
It takes no economic amount or control-address arguments. In one transaction it
must:

- authenticate the three source-bound package publishers and the source-bound
  bootstrap LP beneficiary;
- bind the fixed faucet and its tRFL/tUSD capabilities;
- create and bind the exact frozen tRFL reserve and LP reward vault;
- create and bind the exact tUSD reserve;
- seed the source-fixed 500m/500m reserves;
- mint the source-fixed initial LP shares to the signing beneficiary;
- exclude the exact protocol primary stores;
- validate the creation-selected reflection fee and all fixed policy values;
- transition the protocol to `LIVE`; and
- emit `LaunchSealed`, repeating the reflection fee and complete immutable
  launch envelope.

If any step fails, the complete launch rolls back. After success, every
bootstrap-only path aborts forever.

### CLOSED

The final LP owner may withdraw without a publisher signature. The call must
checkpoint rewards, pay every whole position liability, return the complete
tRFL and tUSD reserves without proportional-floor dust, burn the final shares,
verify zero raw-reserve/custody discrepancy and zero pool pending reward, emit
`PoolClosed`, and transition both core and pool state to `CLOSED`.

Further swaps, liquidity mutations, launches, and reseeding must fail. Wallet
transfers and residual permissionless claim fallbacks remain available.

## Ownerless authority model

No production ABI may contain a post-launch:

- reflection-fee, AMM-fee, faucet, cooldown, swap-limit, or liquidity-limit
  setter;
- pause, unpause, blacklist, operational-admin, role-rotation, or recovery
  authority;
- shutdown, reseed, later-epoch, migration, legacy conversion, or generic
  exclusion/custody-registration entry;
- arbitrary tRFL mint, burn, vault sweep, or privileged user transfer.

Publisher addresses are provenance after launch. A publisher using an ordinary
wallet receives exactly the same rights and reward treatment as every other
eligible wallet. Source-retained transfer/mint references may perform only the
fixed faucet and exact canonical settlement actions encoded by the module.

## Wallet reflection behavior

The global index uses raw eligible wallet balances plus the exact canonical
pool custody balance as shares. Protocol vaults and source-bound protocol
primary stores are excluded exactly once.

For each interaction:

- Send: materialize all sender pending reward, then debit.
- Receive: materialize the recipient's historical pending reward before adding
  the incoming amount.
- Buy: materialize buyer history, remove gross output from pool custody,
  collect/advance the fee with bought units excluded, materialize the fee
  earned by pre-existing buyer holdings, then credit net bought units.
- Sell: materialize seller history, remove gross sold shares, collect/advance
  the fee with sold units excluded, materialize the fee earned by remaining
  seller holdings, then credit net tRFL to custody.
- Liquidity: materialize wallet and LP rewards before wallet/custody or LP
  weights change.

The derived Cedra balance hook returns `raw + pending`. Thus a passive wallet's
raw balance stays unchanged while pending and derived balance rise. A standard
send, receive, buy, sell, or liquidity interaction turns every whole pending
unit into raw spendable balance. `claim` and `claim_all` remain permissionless
fallbacks and cannot be paused.

`RewardsMaterialized` records trigger codes for manual claim, send, receive,
buy pre/post, sell pre/post, liquidity input/output, LP payout, and faucet.

Only registered primary stores are supported. Secondary stores and unreviewed
delegated-custody arrangements fail closed; the protocol does not guess their
beneficial owners.

## LP reflection behavior

The canonical pool is one global reflection position. Every successful buy and
sell checkpoints its complete whole pending reward into the LP reward vault and
index before returning. Pool pending must therefore be zero at every successful
swap boundary.

LP rewards are attributed by checkpointed LP shares. Existing rewards are paid
before mint, burn, or transfer changes weights, and both transfer endpoints are
paid before shares move. Address-based automatic payout may target only the
recipient's registered tRFL primary store through the core settlement
capability. Permissionless checkpoint and manual LP claim remain fallbacks.
No holder or LP loop is allowed.

## Local verification gates

### ABI and lifecycle

- Static ABI allowlist rejects every forbidden owner/admin surface.
- Creation fee cases 0, 1, 100, and 500 pass; 501 fails.
- Repeated initialization, capability issue, custody binding, exclusion
  binding, launch, and post-close pool mutations fail atomically.
- Every former publisher signer lacks a privileged post-launch action.

### Accounting

- Wallet send/receive/self-transfer, effective-balance spend, unsupported
  stores, and exact supply/vault/share accounting.
- Buy/sell historical-weight tests for old, incoming, remaining, and sold
  balances with exact immutable fee charging.
- LP add/remove/transfer with fragmented ownership, historical reward
  isolation, endpoint payout, final exact exit, rounding classification, and
  permanent close.
- Wrong-store, wrong-signer, under-backed vault, overflow, and aborted payout
  rollback.
- Fixed faucet grants/cooldowns, tRFL distribution exhaustion, fixed tUSD
  minting, and lack of reconfiguration authority.

### Cross-implementation and scale

- Move, independent Python model, TypeScript indexer/reconciler, deterministic
  generated witnesses, and release assembler must agree.
- Randomized creation fees cover the full 0–500 bps range.
- One million successful model operations preserve every supply, vault,
  reserve, correction, custody, and LP invariant with zero discrepancy.
- Maximum interaction gas must be at most 2.5 times the v0.1 measured path and
  below 80% of the current Testnet transaction ceiling.

## Testnet compatibility gates

- Repeat the dispatch-hook probe with genuinely different raw and derived
  balances.
- Prove CLI, REST, the read-only adapter, primary-store transfer, and wallet
  display agree that derived balance equals `raw + pending`.
- Prove secondary-store paths fail closed.
- Playwright may be used only for browser-wallet compatibility evidence. No
  frontend is built.

These are live-chain/wallet claims and cannot be inferred from local tests.

## Fresh v0.2 deployment procedure

1. Create fresh Testnet CLI profiles for core publisher, assets publisher, AMM
   publisher, bootstrap LP, Alice, Bob, Carol, and Dave. Record only public
   names, public keys, derived addresses, and network bindings in evidence.
2. Prepare exact-address immutable package artifacts with `bootstrap_lp` bound
   into the AMM bytecode. Verify source digests, metadata policy 2, upgrade
   number 0, and framework/CLI provenance.
3. Build and simulate, without submitting, these five ordered operations:
   `core_publish`, `core_initialize(100)`, `assets_publish`, `amm_publish`, and
   `pool_launch`.
4. After explicit operator review, record exactly one detached OpenSSH operator
   approval over the canonical statement for the already-simulated candidate,
   then submit those same BCS/signing bytes outside the repository and wait for
   finalization before building the dependent operation.
5. Verify all views/events, fixed balances, exact addresses, lifecycle `LIVE`,
   source digests, bound fee 100, and absence of authority surfaces.
6. From each former publisher profile, simulate forbidden relaunch/setup calls
   and record the rejection without submitting a state-changing fallback.

Testnet publication and later v0.1 retirement are separate operator actions.

## Live four-holder reflection exercise

Fund Alice, Bob, Carol, and Dave through the fixed faucet. Alice then performs
ten alternating buy/sell cycles while Bob, Carol, and Dave remain passive.
After every trade record:

- exact 1% reflection fee;
- Alice pending zero and automatic raw materialization;
- unchanged raw but rising pending/derived balance for Bob, Carol, and Dave;
- pool core pending zero;
- rising LP vault/index and effective LP entitlements; and
- exact fixed-supply, vault, reserve, custody-share, correction, and rounding
  reconciliation.

Then touch each passive wallet through standard primary-store transfers and
prove its pending reward becomes raw automatically. Exercise LP add, partial
remove, full remove, and LP transfer with automatic endpoint payout. Fragment
the LP shares and have the final LP close the pool without a publisher signer.
Prove every post-close swap, liquidity change, launch, and reseed attempt fails.

## Canonical pilot gates

Before v0.2 is declared canonical, finalized evidence must show:

| Gate | Minimum |
|---|---:|
| finalized synthetic transactions | 50,000 |
| completed swaps | 10,000 |
| distinct holders | 1,000 |
| distinct LP positions | 100 |
| unexplained reconciliation discrepancy | 0 |

Local or bounded four-wallet evidence does not satisfy these load gates.

## v0.1 separation and retirement

v0.1 and v0.2 use different package addresses and deployment identities. Their
events, balances, manifests, and evidence must never be merged. v0.2 contains
no migration or legacy-conversion code.

Only after v0.2 passes every canonical gate may the operator separately stop
the v0.1 faucet/swaps through v0.1's existing controls, unwind controlled LP
positions, materialize controlled claims, and mark its addresses superseded.
If uncontrolled holders remain, claims stay accessible and the remaining
liability is published. Historical v0.1 evidence is preserved permanently.

## Assurance boundary

No external reviewer is required for this Testnet deployment. Its detached
release-approval quorum is exactly one operator identity and one signing key;
that signature is execution authorization, not an independent security review.
Internal contract/accounting review and independent model parity are mandatory.
An external security review remains required before mainnet deployment or using
this reference as a production reflection-token factory.
