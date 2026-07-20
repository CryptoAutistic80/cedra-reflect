# Cedra production-quality testnet plan

Agreed. As of **July 19, 2026**, Cedra’s public documentation exposes a public
**Testnet** endpoint rather than a live mainnet endpoint. Cedra also states that
faucet CED is for development and has no real-world value. The target here is
therefore a **public Testnet beta built to production engineering standards**,
not a production financial launch. This plan has no Devnet execution stage.

The goal becomes:

> Prove the complete reflection-token system under real Cedra network conditions, collect evidence that the accounting is sound, rehearse recovery from a fresh deployment, and leave behind a clean mainnet-candidate codebase.

Think flight-certified prototype, not passenger airline.

**Scope revision — July 20, 2026:** the core contract must reward eligible
`tRFL` exactly once whether it is held in a wallet primary store or deposited
in the canonical LP. The pool is therefore an eligible custody position in the
core accounting, with its accrued rewards passed through to LP holders by a
checkpointed LP-share index. The AMM's raw reserve remains the sole pricing
reserve; reflections must never silently change `x * y`.

**Current execution priority:** complete and prove the full on-chain package —
the reflection core, canonical AMM, LP shares, LP reward passthrough, and their
Move tests — before resuming frontend work. SDK and indexer work during this
stage is limited to transaction generation, independent replay, and accounting
evidence. Later UI requirements remain pilot scope, not the current critical
path.

**Local implementation status — July 20, 2026:** the workspace now contains a
clean initial core custody design, exact-store custody registry and routing
capability, proportional canonical AMM liquidity, account-bound checkpointed LP
shares, downstream LP reward epochs, and Move integration proofs for exact-once
pool accrual, one-for-one routing, claims at the current global index,
historical-capture prevention, partial LP claims, proportional burns, the same
owner participating across isolated reward epochs, tiny-fee bucket accounting,
claim-only epoch reseeding, terminal fractional-dust isolation, guarded quote
failure, independent claim pauses, and configurable public-liquidity limits.
Both the hand-authored accounting vector and a fixed-seed witness containing 64
generated mixed operations are executed by Move and Python and produce the same
indexes, balances, liabilities, custody route, AMM reserves, and LP snapshot.
That generated witness exposed and corrected a non-divisible AMM-fee rounding
mismatch across Move, the SDK mock, and the indexer. Focused adversarial Move
proofs now also reject a fake core admin, a second canonical-custody binding,
funded or already-classified custody stores, a non-owner custody registration,
duplicate initialization, bootstrap shares below the provider's minimum,
and a second LP claim after the entitlement is exhausted. Swap guard proofs cover zero amounts, expired
deadlines, gross and reserve-percentage caps, net-receipt buy slippage, and the
independent pool pause; both raw reserves reject direct deposits and
withdrawals. An evented publisher-authorized handoff now separates the cold
core, asset, and AMM publishers from the operational key used for routine fee,
pause, faucet, shutdown, and limit actions. The contract is one clean initial
schema with no legacy-state conversion surface. Its one-time post-publication
initializer now records one-time automatic-versus-claim-backed behavior; the
selected initial mode is claim-backed, so pending wallet rewards require an
explicit on-chain claim while canonical LP rewards remain separately claimable
by beneficial owners. There is no mode setter or state-conversion path in this
package; compatible package-upgrade authority remains a separate release-policy
trust boundary. This paragraph is local source and deterministic test
evidence only. The isolated hook-probe publication is separately preserved in
`ops/evidence/hook-probe-testnet.json`; it is not a deployment of the core,
test-assets, or AMM packages and is not participant or public-pilot evidence.

**Local contract gate — passed July 20, 2026:** `make verify` passes all Move
packages including **56/56 integration tests**, **6/6 core tests**, and the AMM
rounding unit test, the independent Python model, evidence-template, and
Move-surface checks pass **35/35 tests**, and the TypeScript
contract-support witness passes **24/24 deterministic tests**. The generated
Python/Move witness drift check also passes. The expanded reference-model gate
passes **1,000,000 operations across 1,024 holders**. `make release-artifacts` also
compiles every package with Cedra CLI 1.0.4, records local source digests, and
fails closed if any publishable package's module bytecode plus sparse metadata
exceeds the normal 65,536-byte publication boundary.
These results authorize no publication or live transaction.

---

# 1. Recalibrated scope

| Mainnet-oriented decision | Cedra testnet decision |
|---|---|
| Predeployment contract schema | **One clean initial package with no state-transition machinery** |
| Multiple third-party DEX integrations | **One canonical reflection-aware AMM** |
| Public liquidity provision | **Admin-seeded bootstrap, then controlled public LP positions** |
| Permanent token supply ceremony | **Fixed supply per deployment, distributed through a test faucet** |
| DAO or timelocked governance | **Controlled testnet admin with two-person release approval** |
| Multiple external audits | **Internal review, property testing, one independent review before public beta** |
| Permanent state assumption | **Deployment identity, snapshots, fresh-redeployment runbook** |
| Full economic launch | **No-value test assets with persistent warnings** |
| Broad wallet compatibility | **Cedra TypeScript SDK plus one documented wallet integration first** |
| Mainnet-grade infrastructure redundancy | **Monitored indexer, reproducible deployment, RPC fallback** |
| General-purpose DEX compatibility | **Exact integration with the AMM we control** |
| Delegated custody | **Canonical LP passthrough in core; other vaults require an explicit reviewed adapter** |

Because no contract state exists yet, this release defines the intended schema
directly. Transitional resources, conversion entry points, secondary transition
signers, and transition rehearsals are out of scope until real deployed state
exists and a concrete change actually requires them.

---

# 2. Testnet product definition

The public pilot should be called something visibly non-economic, for example:

```text
Name: Reflection Pilot Test Token
Symbol: tRFL
Network: Cedra Testnet
Value: No real-world value
Reflection fee: 1% on supported swaps
```

The metadata, website, wallet interface, documentation, and faucet should all display:

```text
TESTNET ASSET
NO MONETARY VALUE
STATE AND ADDRESSES MAY CHANGE
```

## Full on-chain package behaviour

The first externally usable release should provide:

- A fixed-supply Cedra Fungible Asset.
- A 1% fee on swaps through the canonical pool.
- Lazy proportional reflection rewards for eligible holders.
- Untaxed wallet-to-wallet transfers.
- An explicit reward claim function.
- Automatic reward materialisation when holders spend pending rewards, provided Cedra’s dispatchable balance hooks behave as expected on Testnet.
- One `tRFL/tUSD` constant-product pool.
- Admin-seeded bootstrap liquidity with controlled public LP positions.
- A canonical pool custody position whose underlying `tRFL` participates in
  the same global reflection distribution as wallet-held `tRFL`.
- A downstream O(1) LP reward index so the pool's accrued reflections belong
  proportionally to LP holders without inflating the raw AMM reserve.
- Checkpointed LP mint, burn, transfer, and claim operations that cannot grant
  historical rewards to newly acquired LP shares.
- A test-token faucet.
- A complete event and view surface for independent replay and reconciliation.
- One clean initial state schema and an immutable deployment-identity record.

The web interface and public dashboard are downstream consumers of this
contract surface. They are deliberately deferred until the on-chain package and
independent accounting model satisfy their local completion gates.

Cedra already publishes a constant-product DEX guide and Move example with client integration. That can be used as scaffolding, but reflection-aware settlement and reserve accounting should be implemented specifically for this project rather than assumed to work automatically.

---

# 3. Architecture

```text
                         ┌──────────────────────┐
                         │  Web App / Test SDK  │
                         └──────────┬───────────┘
                                    │
                    faucet / transfer / swap / claim
                                    │
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
┌──────────────────────────┐                 ┌────────────────────────┐
│     Reflection Core      │                 │  Canonical Test AMM    │
│                          │◄───────────────►│                        │
│ • dispatch hooks         │ reflection-safe │ • tRFL/tUSD pool       │
│ • global reward index    │ settlement      │ • net-input pricing    │
│ • wallet positions       │                 │ • net-output quoting   │
│ • custody positions      │                 │ • LP share index       │
│ • reward vault           │                 │ • slippage checks      │
│ • custody reward routing │                 │ • add/remove liquidity │
│ • accounting views       │                 │ • swap caps            │
│ • pause controls         │                 └────────────────────────┘
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│ Test Distribution Layer  │
│                          │
│ • excluded tRFL reserve  │
│ • mintable mock tUSD     │
│ • faucet cooldowns       │
│ • test-account grants    │
└──────────────────────────┘

              Events
                │
                ▼
┌──────────────────────────┐
│ Indexer and Reconciler   │
│                          │
│ • balances               │
│ • pending reflections    │
│ • LP shares and rewards  │
│ • reward-vault backing   │
│ • swaps and fee totals   │
│ • invariant alerts       │
└──────────────────────────┘
```

## Package separation

```text
move/
├── reflection-core/
│   ├── reflection_math.move
│   ├── reflection_token.move
│   ├── reflection_hooks.move
│   ├── reflection_registry.move
│   ├── custody_registry.move
│   ├── custody_settlement.move
│   └── reflection_events.move
│
├── test-amm/
│   ├── pool.move
│   ├── swap.move
│   ├── liquidity.move
│   ├── lp_shares.move
│   ├── lp_rewards.move
│   └── reflection_settlement.move
│
├── test-assets/
│   ├── mock_usd.move
│   └── test_faucet.move
│
└── integration-tests/
    ├── protocol_integration_tests.move
    └── wallet_lp_accounting_tests.move
```

The reflection core should remain free of test-only cheats. It owns the global
wallet-and-custody eligibility accounting and a narrow reward-routing
capability. The AMM owns LP shares and the downstream LP reward index. Faucet
behaviour, mock assets, and distribution controls remain separate. This avoids
a dependency from the core into a particular AMM while making the canonical
pool the first approved custody adapter.

---

# 4. Token supply and test distribution

Cedra’s Fungible Asset model supports capped supply and capability-based minting, burning, freezing, and administrative transfer operations. For `tRFL`, create a capped asset and avoid exposing a public mint function.

## Recommended distribution model

At deployment:

1. Mint the complete `tRFL` test supply.
2. Deposit it into an excluded distribution vault.
3. Destroy or permanently seal the mint capability for that deployment.
4. Let the faucet transfer grants from the distribution vault.
5. Register recipients as eligible holders when they receive their first grant.

This gives us fixed-supply behaviour without pretending that the Testnet deployment is permanent.

The distribution vault must be excluded from reflection rewards. Otherwise, most fees would flow back to the undistributed supply, creating a large silent gravity well.

## Mock quote token

Deploy a separate `tUSD` Fungible Asset:

- Mintable by the Testnet faucet.
- Six decimals.
- No intended value.
- No reflection behaviour.
- Used solely for swaps and pool accounting.

Using a mock quote token isolates reflection testing from unrelated external asset contracts.

---

# 5. Reflection accounting

The accounting model should remain the production-shaped vault-backed design from the earlier plan.

## Required state

```move
struct ReflectionState has key {
    index: u256,
    total_shares: u256,
    aggregate_correction: SignedU256,
    index_remainder: u256,

    wallet_eligible_raw_balance: u128,
    custody_eligible_raw_balance: u128,
    unallocated_fees: u128,
    rounding_reserve: u128,
    lifetime_fees: u256,
    lifetime_materialized: u256,
    lifetime_custody_routed: u256,

    fee_bps: u64,
    swaps_paused: bool,
    claims_paused: bool,

    positions: Table<address, Position>,
    custody_adapters: Table<address, CustodyAdapter>,
    exclusions: Table<address, bool>,

    reward_vault: Object<FungibleStore>,
    distribution_vault: Object<FungibleStore>
}
```

`positions` contains both wallet positions and approved custody positions. A
custody position is keyed by its exact `tRFL` store and binds that store to one
immutable reward-routing capability and one excluded payout vault. The
canonical AMM reserve is the first such position.

The AMM separately maintains:

```move
struct LpEpochRegistry has key {
    active_epoch: u64,
    active_state: address,
    next_epoch: u64
}

struct LpEpoch has store {
    epoch_id: u64,
    status: u8, // ACTIVE or CLAIM_ONLY
    index: u256,
    total_lp_shares: u256,
    aggregate_correction: SignedU256,
    index_remainder: u256,
    unallocated_rewards: u128,
    rounding_reserve: u128,
    lifetime_received: u256,
    lifetime_claimed: u256,
    positions: Table<address, LpPosition>,
    reward_vault: Object<FungibleStore>
}
```

Each LP epoch owns a distinct immutable `LpEpoch` state record, position
table, and reward vault. The registry points new liquidity operations at the
single active epoch. A shutdown changes the old epoch to `CLAIM_ONLY`: no index
or share mutation is allowed, but zero-share positions can still claim their
already-indexed rewards. Reseeding creates a fresh state object and table, so
the same owner address can have an old claim and a clean new position without
state collision. `CLAIM_ONLY` is terminal. Sub-base-unit position fractions can
sum to aggregate liability even when no individual has a whole base unit to
claim; that residue remains named and backed in the old immutable vault and is
never swept or carried into a new epoch.

The LP index is downstream accounting. It never makes the pool reserve itself
grow, so AMM quotations always use raw reserves.

For both indexes, `index_remainder` carries magnified division remainder and
`rounding_reserve` accounts for whole base units in the vault that are not yet
represented by aggregate indexed liability. `unallocated_fees` or
`unallocated_rewards` accounts for amounts received while the relevant share
denominator is zero. An index advance updates the aggregate liability and its
rounding reserve in O(1); no base unit is allowed to disappear into an unnamed
surplus bucket.

## Fee flow

For a taxable amount `G`:

```text
fee = floor(G × 100 / 10,000)
net = G - fee
```

The fee is physically deposited into the excluded core reward vault. The one
global reflection index is then advanced across:

```text
total_shares = eligible wallet raw tRFL + approved custody raw tRFL
```

The canonical pool therefore receives the same per-unit entitlement as a
wallet. When its custody position is checkpointed, the core moves exactly that
position's pending reward from the core reward vault to the AMM's excluded LP
reward vault. The AMM advances its LP index by the received amount. This is a
liability transfer, not a new fee and not a reserve deposit.

No wallet or LP-holder loop occurs.

## Eligible balances

Core eligibility:

- Registered wallet primary stores: eligible wallet positions.
- The canonical AMM `tRFL` reserve: eligible as one custody position.
- Reward vault: excluded.
- LP reward vault: excluded.
- Distribution vault: excluded.
- Testnet admin stores: excluded.
- Unregistered contract, escrow, secondary, and delegated-custody stores:
  rejected or excluded; they never silently become wallet positions.
- Other delegated-custody stores: eligible only through an explicit reviewed
  adapter that routes the custody position's rewards to beneficial owners.

An adapter may be registered only while its underlying store and downstream
reward liabilities are empty. Once funded, its store binding, payout vault,
and routing capability cannot be replaced in place. This prevents an admin or
vault from switching beneficiary accounting after rewards have accrued.

The canonical pool adapter is registered atomically during pool initialization,
before bootstrap funding, public deposits, or swaps are possible. Registration
must fail if the reserve or LP reward vault is already funded, if LP shares
already exist, or if the store is already classified as a wallet or another
custody position. No retroactive entitlement is inferred at registration.

The core cannot infer beneficial ownership inside an arbitrary third-party
vault. Unsupported vaults therefore fail closed rather than crediting the vault
operator as though it were the economic holder.

## Exact-once invariants

At every completed transaction boundary:

```text
global total_shares
    = sum(eligible wallet raw tRFL)
    + sum(approved custody raw tRFL)

canonical pool custody raw units = canonical pool raw tRFL reserve
canonical pool store appears in exactly one custody position and no wallet position

core reward-vault balance
    = aggregate wallet-and-custody indexed liability
    + unallocated fees
    + core rounding reserve

LP reward-vault balance
    = aggregate LP indexed liability
    + unallocated LP rewards
    + LP rounding reserve

combined accounted reward funds
    = both aggregate indexed liabilities
    + both unallocated buckets
    + both rounding reserves
```

Aggregate indexed liability is computed in O(1) from total shares, index,
aggregate correction, and lifetime settled amounts. Per-position claimable
values may individually floor fractional entitlements, but their aggregate
index state, remainder, and rounding reserve still account for every base unit.

A custody checkpoint reduces the pool's core pending liability and the core
reward-vault balance by exactly `X`, then increases the LP reward-vault balance
and the sum of downstream indexed liability, unallocated rewards, and rounding
reserve by exactly `X`. It does not change the pool reserve, the pool's global
raw shares, global `total_shares`, or combined accounted reward funds. This
one-for-one hand-off is the exact-once boundary between the two indexes.

## Transaction ordering

### Sell

For a sale of 100 `tRFL`:

```text
seller effective balance decreases by 100
1 tRFL enters reward vault
global index advances across the seller's remaining wallet units and the
pre-trade pool custody units
99 tRFL then enters the AMM reserve and becomes custody units for future fees
AMM prices the trade using the 99-token net input
```

The seller's remaining balance and the pool's pre-trade `tRFL` participate in
the fee. The new 99 reserve units do not receive their own transaction's fee.

### Buy

For a gross pool output of 100 `tRFL`:

```text
pool raw reserve and custody units decrease by 100
1 tRFL enters reward vault
global index advances across the post-withdraw pool units and pre-existing
wallet units
99 tRFL then enters the buyer store as wallet units
```

The newly purchased 99 tokens do not receive a share of their own swap fee. Any
balance the buyer held before the trade remains eligible. The withdrawn 100
pool units do not receive a fee after they have left custody.

## LP checkpoint ordering

Before every LP share mint, burn, transfer, or reward claim:

```text
1. Settle the canonical pool custody position's pending global reward without
   adding it to the pool reserve or global shares.
2. Move that exact amount into the excluded LP reward vault.
3. Advance the LP reward index.
4. Checkpoint the affected LP positions at the current LP index.
5. Apply the LP share change or claim.
```

Liquidity addition is one atomic sequence:

```text
1. Read authoritative pre-deposit raw reserves and calculate LP shares.
2. Route all pool custody pending reward through the existing LP-share index.
3. Checkpoint the provider's existing LP position at the resulting LP index.
4. Debit the provider's wallet raw shares with a correction at global index I.
5. Move the raw tRFL into the pool and add equal custody shares at index I.
6. Move the proportional tUSD amount into its raw reserve.
7. Mint the new LP shares with a correction at the current LP index.
8. Assert raw reserve = custody units and emit the complete transition.
```

Liquidity withdrawal is the reverse atomic sequence:

```text
1. Read authoritative pre-withdrawal raw reserves and calculate both outputs.
2. Route all pool custody pending reward through the pre-burn LP-share index.
3. Checkpoint the provider's LP position and burn shares at that LP index.
4. Remove the proportional raw tRFL and equal custody shares at global index I.
5. Credit the recipient wallet with equal raw shares at global index I.
6. Move the proportional tUSD output.
7. Enforce minimum outputs and the active-pool or final-shutdown invariant.
8. Assert raw reserve = custody units and emit the complete transition.
```

The correction updates in steps 4–5 preserve the wallet's pre-deposit global
entitlement and the pool's pre-withdrawal entitlement. The LP checkpoint before
mint or burn preserves the old LP owners' entitlement. Neither representation
change alters global `total_shares`; only a separate claim that moves excluded
reward-vault tokens back into an eligible wallet increases it.

An LP share transfer similarly routes pool custody pending reward, checkpoints
sender and recipient, and then applies equal-and-opposite LP corrections at one
LP index. The initial release permits transfers only between registered signer-owned primary LP
stores. Secondary stores, contract custody, wrappers, and vault deposits fail
closed; LP-share custody adapters are deferred. If Cedra's dispatch hooks cannot
enforce even the primary-store rule reproducibly, initial LP shares remain
account-bound and only mint, burn, claim, and proportional withdrawal are
enabled.

If `total_lp_shares == 0`, normal execution requires the raw tRFL reserve,
custody units, and custody pending reward all to be zero. An unexpected reward
received with a zero denominator is recorded in `unallocated_rewards`, pauses
LP mutations, and is never assigned to future LPs silently. A final shutdown
first routes custody pending, checkpoints every affected exit, removes all raw
reserves and custody units, and only then closes the final escrow share
position. Old zero-share positions retain their already-indexed claims. Any
later reseed uses a fresh LP reward epoch so old liabilities cannot leak to new
providers.

## Rounding

The implementation should retain:

- `u256` intermediate arithmetic.
- A carried global remainder.
- Per-position signed correction values.
- Separate carried remainders for the global and LP indexes.
- Exact transfer reductions and additions.
- No forced minimum fee for tiny transactions.

This is not an area to simplify merely because the tokens are valueless. The arithmetic evidence produced on Testnet is one of the principal assets of the pilot.

---

# 6. Dispatchable-hook feasibility gate

Before publishing the protocol, run a small compatibility probe on Cedra
Testnet. Local deterministic tests precede this probe; Devnet is not part of
the execution path for this pilot.

## Probe package

Deploy a minimal Fungible Asset that registers:

```move
withdraw hook
deposit hook
derived balance hook
```

Test:

1. Hook registration succeeds.
2. Primary-store transfers invoke the expected hooks.
3. Derived balance is returned through standard balance queries.
4. Internal `with_ref` operations do not recursively re-enter hooks.
5. The reward-vault store can materialise pending amounts.
6. Secondary fungible stores behave as expected.
7. The TypeScript SDK reads the effective balance correctly.
8. The chosen wallet displays either the derived balance or a documented fallback.
9. If LP shares are transferable, their transfer hook checkpoints both LP
   positions without re-entrancy or historical-reward leakage.

## Recorded Testnet result — 2026-07-20

The finalized H1-H8 record is `ops/evidence/hook-probe-testnet.json`.
H1-H7 passed on Cedra Testnet: package publication and post-publication hook
registration finalized, standard transfers dispatched exactly once, internal
reference materialisation did not recurse, secondary-store raw/derived values
agreed, and CLI/REST/TypeScript SDK reads converged. H8 did not establish a
real wallet's distinct derived-balance display or transfer path, so it is
explicitly recorded as failed/inconclusive rather than inferred from equal raw
and derived probe values.

The initial protocol release mode is therefore **claim-backed**. Withdrawal and
deposit hooks still maintain exact wallet accounting for standard transfers,
but the standard displayed/spendable value is raw balance and pending rewards
must be claimed on chain before spending. Automatic materialisation remains a
fresh-deployment option only after distinct-balance wallet evidence succeeds;
it is not a migration or post-deployment toggle. LP shares remain account-bound
and LP beneficial owners claim from the separately backed LP reward vault.

## Gate result A: full hook support

Proceed with:

- Effective balances that grow automatically.
- Spending pending reflections without a separate claim.
- Explicit claim as an optional operation.
- Checkpoint-aware transferable LP shares if their separate hook probe passes.

## Gate result B: partial or incompatible support

Proceed with a claim-backed pilot:

- Raw balance remains the spendable balance.
- Pending rewards are exposed through a view.
- Users call `claim()` before spending reflected tokens.
- Swap economics and reward distribution remain unchanged.
- LP shares remain account-bound if their checkpoint cannot be enforced on
  arbitrary transfers; LP mint, burn, claim, and withdrawal still operate.

This fallback still validates the core reflection model. It merely loses the old-school “wallet number quietly climbs” experience.

---

# 7. Canonical AMM scope

## Canonical pool

```text
Pair: tRFL / tUSD
Model: constant product
Bootstrap liquidity provider: project-controlled Testnet account
Public operations: buy, sell, proportional add liquidity, proportional remove liquidity, claim LP reflections
LP accounting: checkpointed shares plus downstream reflection index
LP share transfer: enabled only if the dedicated hook gate passes; otherwise account-bound
Multi-hop routing: disabled
Flash operations: disabled
Oracle integration: disabled
```

The dedicated bootstrap provider seeds the initial price and receives the first LP shares.
Public liquidity opens only after the closed-pilot accounting gate. The initial release keeps
the surface deliberately narrow:

Bootstrap reserve funding, custody-share creation, and the initial LP-share
mint are one atomic operation. No completed state may contain a positive raw
pool reserve without a positive, fully assigned LP-share supply.

The initial LP beneficiary must be a dedicated, non-privileged pilot account
or an explicitly labelled protocol LP escrow. It must not be the excluded core,
asset, or AMM operator wallet. Bootstrap administration and beneficial LP
ownership are separate roles.

- Proportional two-sided deposits only.
- No one-sided liquidity bypass.
- No donation-based share minting.
- Minimum-liquidity lock or equivalent first-depositor protection. Any locked
  shares remain in an explicit checkpointed escrow position; LP supply is never
  burned or orphaned outside the reward index.
- Minimum LP shares on deposit and minimum token outputs on withdrawal.
- LP reward checkpoint before every share-supply or ownership change.
- Raw reserves, LP reward vault assets, and pending custody rewards are three
  separately reconciled quantities.

Liquidity movement is not a swap and does not pay the 1% reflection fee. It
changes whether the deposited `tRFL` is represented by a wallet position or by
the canonical pool custody position. The global correction accounting must
preserve all rewards accrued before that change.

## LP reflection passthrough

The canonical pool is not treated as one ordinary wallet and its reward is not
left for the pool operator. It is an approved custody position:

```text
pool raw tRFL reserve
        -> global core shares
        -> pool custody pending reward
        -> core custody checkpoint
        -> excluded LP reward vault
        -> LP reward index
        -> LP-holder pending reward
```

An LP reward claim transfers from the LP reward vault to the claimant's wallet
position at the current global index. The claimed amount can earn future
reflections but cannot earn any fee collected before the claim.

The reflection core exposes an authoritative read-only raw-store balance
accessor backed by its `RawBalanceRef`. AMM settlement and quotation functions
must use that accessor for `tRFL`; they must never price from a standard or
derived balance query. If the AMM also caches a reserve counter for events or
gas, every completed operation must prove:

```text
raw-store accessor balance = cached AMM reserve = custody raw units
```

Any mismatch aborts the operation and triggers the reserve/custody incident
path.

## Pricing rules

### Selling `tRFL`

The AMM must price using the amount that actually reaches the reserve:

```text
gross input
minus 1% reflection fee
equals net AMM input
multiplied by `(10_000 - amm_fee_bps) / 10_000` and rounded down
equals invariant input
net AMM input minus invariant input equals the reported AMM trading fee
```

### Buying `tRFL`

The AMM calculates a gross reserve output. The UI then displays:

```text
gross pool output
reflection fee
net amount received
minimum net amount received
```

Slippage checks must use the **net user receipt**, not the gross reserve output.

## Swap safeguards

Add configurable Testnet limits:

- Maximum gross swap amount.
- Maximum percentage of reserve consumed in one swap.
- Minimum output.
- Deadline.
- Pool pause.
- Independent liquidity-add/remove pause.
- Independent LP-reward-claim pause.
- Maximum per-operation liquidity contribution and withdrawal.
- Minimum LP-share mint and minimum proportional withdrawal outputs.
- Reflection-fee pause or temporary zero-fee mode.
- Per-account faucet cooldown.

---

# 8. Initial deployment schema

The contract has not been deployed. The release therefore contains one direct,
complete state schema. It does not contain a second state resource, conversion
entry point, transition approver, transition event, or rehearsal for nonexistent
legacy state. Any future schema change is a separate project based on the exact
state that is actually live at that time.

## Stable hook surface

Registered hook functions should remain thin and stable:

```move
withdraw_hook(...)
deposit_hook(...)
derived_balance_hook(...)
```

Each delegates to the current accounting implementation.

If transferable LP shares pass their separate compatibility gate, their
checkpoint hooks are equally stable and thin:

```move
lp_withdraw_hook(...)
lp_deposit_hook(...)
lp_derived_balance_hook(...)
```

## Deployment identity

Use a small stable registry:

```move
struct ProtocolRegistry has key {
    state_object: address,
    deployment_id: vector<u8>,
    network_label: vector<u8>
}
```

The economic resources are the initial schema itself:

```move
ReflectionState
CustodyRegistry
LpEpoch
LpEpochRegistry
```

## Release naming

```text
testnet-v0.1.0
testnet-v0.1.1
testnet-v0.2.0
```

Each release manifest should record:

```json
{
  "network": "cedra-testnet",
  "deployment_id": "reflection-pilot-001",
  "framework_commit": "...",
  "application_commit": "...",
  "packages": {
    "reflection_core": { "publisher": "0x...", "source_digest": "...", "compiled_package_digest": "..." },
    "test_assets": { "publisher": "0x...", "source_digest": "...", "compiled_package_digest": "..." },
    "test_amm": { "publisher": "0x...", "source_digest": "...", "compiled_package_digest": "..." }
  },
  "operational_authority": { "address": "0x...", "handoff_transactions": ["0x...", "0x...", "0x..."] },
  "objects": {
    "token_metadata": "0x...",
    "reward_vault": "0x...",
    "distribution_vault": "0x...",
    "pool": "0x...",
    "pool_custody_store": "0x...",
    "lp_share_representation": "account-bound-table",
    "lp_epoch_registry": "0x...",
    "active_lp_epoch": "1",
    "active_lp_state": "0x...",
    "lp_reward_vault": "0x...",
    "mock_usd_metadata": "0x..."
  },
  "initialization": { "finalized_ledger_version": "...", "zero_discrepancy_snapshot": "..." }
}
```

No automatic Testnet publication should occur from CI. CI builds and verifies
the artifact; an approved release operator publishes it.

---

# 9. Administration

Testnet administration should be controlled but not burdened with full DAO machinery.

## Admin powers

The Testnet admin may:

- Pause or resume swaps.
- Set the fee between 0 and 100 basis points.
- Refill the `tUSD` faucet.
- Adjust faucet grants and cooldowns.
- Adjust maximum swap limits.
- Adjust public-liquidity contribution and non-final withdrawal limits.
- Pause or resume public liquidity operations and LP reward claims.
- Seed or withdraw synthetic bootstrap liquidity under the same LP-share rules.
- Register the canonical pool custody adapter once, while all associated
  stores and liabilities are empty.

The admin may not:

- Arbitrarily alter holder reflection balances.
- Sweep `tRFL` from the reward vault.
- Mint additional `tRFL` after the deployment supply is sealed.
- Transfer tokens out of user stores.
- Redirect a funded custody position or replace its beneficiary accounting.
- Sweep the LP reward vault or assign LP rewards to the pool operator.
- Mint, burn, transfer, or overwrite LP shares outside checkpoint-aware paths.
- Set a reflection fee above 1%.
- Silently replace event history.

## Operational approval

Use:

- A dedicated publisher key.
- A separate operational key for routine pause and faucet actions.
- Two-person approval for package publication.
- A signed release manifest.
- A changelog for every release.

For a Testnet pilot, this process is more valuable than building an elaborate governance contract whose own complexity would overshadow the token experiment.

Each package publisher initially owns its package's routine control only long
enough to perform an evented handoff to a non-zero operational address. After
handoff, the publisher can rotate that address but cannot execute routine fee,
pause, faucet, shutdown, or limit calls unless it performs another visible
handoff. The core, asset, and AMM handoffs are separate transactions and the
indexer reconciles all three current operational addresses against their
on-chain views.

---

# 10. SDK and interface

Cedra provides an official TypeScript SDK for building, submitting, and querying Testnet transactions. Use that as the client foundation.

## Public interface

The initial web application should contain five screens:

### Faucet

```text
Claim test CED instructions
Claim tRFL
Claim tUSD
Cooldown status
```

Cedra’s official faucet supplies Testnet CED for gas, and those tokens are explicitly described as development-only.

### Portfolio

```text
Effective tRFL balance
Raw tRFL balance
Pending reflections
Lifetime claimed
Share of eligible supply
LP shares and share of pool
Pending LP reflections
Claimable wallet-plus-LP total without double counting
```

### Swap

```text
Input
Gross output/input
Reflection fee
AMM fee
Net received
Minimum net received
Price impact
Transaction deadline
```

### Claim

```text
Pending reflections
Claim amount
Claim all
Pending LP reflections
Claim LP reflections by epoch
Claim-only rewards from prior LP epochs
Estimated gas
```

### Protocol dashboard

```text
Eligible holders
Eligible supply
Wallet eligible supply
Canonical pool custody supply
Reward-vault balance
LP reward-vault balance
Calculated wallet reflection liability
Calculated custody and LP liabilities
Backing surplus
Lifetime swap fees
Lifetime materialized rewards
Current index
Pool reserves
Current package version
Paused state
```

A persistent Testnet banner should never be dismissible.

---

# 11. Indexer and reconciliation

The indexer is not just a convenience layer. It is the independent accounting witness.

## Events

Emit:

```text
ProtocolInitialized
FaucetGrant
WalletTransfer
EligibleBalanceDebited
EligibleBalanceCredited
SwapExecuted
ReflectionFeeCollected
ReflectionIndexAdvanced
RewardsMaterialized
RewardsClaimed
PositionCreated
CustodyAdapterRegistered
CustodyEpochRouteOpened
CustodySharesChanged
CustodyRewardsRouted
LpSharesChanged
LpSharesTransferred
LpRewardIndexAdvanced
LpRewardsClaimed
LpRewardQuarantined
LpEpochOpened
LpEpochStatusChanged
FeeConfigurationChanged
SwapLimitsChanged
LiquidityLimitsChanged
PauseStateChanged
PoolPauseChanged
OperationalAdminChanged
LiquiditySeeded
LiquidityAdded
LiquidityRemoved
```

## Reconciliation loop

After each indexed transaction:

```text
1. Recompute global wallet and custody reflection state.
2. Recompute the canonical pool custody position and its pending reward.
3. Recompute the downstream LP index and every LP position.
4. Recompute core and LP reward-vault liabilities separately and combined.
5. Compare calculated indexes and remainders with on-chain values.
6. Recompute unallocated and rounding-reserve buckets and prove that every
   reward-vault base unit is named.
7. Compare calculated vault backing with on-chain backing.
8. Verify fee equals configured fee formula.
9. Verify raw-store accessor, cached reserve, and custody units are identical.
10. Verify pool reserve and custody-share changes match swap or liquidity direction.
11. Verify each custody checkpoint is an equal accounted-funds transfer into the LP vault.
12. Record any discrepancy as a critical alert.
```

## Snapshots

Take regular off-chain snapshots of:

- Effective holder balances.
- Raw holder balances.
- Pending rewards.
- Custody-position raw units, correction, claimed amount, and pending reward.
- LP shares, corrections, pending rewards, and lifetime claims.
- Pool reserves.
- Global and LP indexes and carried remainders.
- Core and LP unallocated and rounding-reserve buckets.
- Global and LP aggregate corrections.
- Core and LP reward-vault balances and liabilities.
- Every LP reward epoch, its state-object and vault address, and its
  active/claim-only status.
- Package version.
- Last processed ledger version.

Snapshots support both investigation and Testnet redeployment rehearsals.

---

# 12. Testing programme

## Move unit tests

Cover:

- Initialization.
- First holder.
- Faucet distribution.
- Eligible and excluded stores.
- Wallet-to-canonical-pool eligibility movement.
- Canonical pool custody-position accrual.
- Custody reward checkpoint into the LP reward vault.
- LP share mint, burn, optional transfer, and reward claim.
- First/last LP and minimum-liquidity protection.
- Two-provider deposits and exits immediately before and after fee events.
- Partial and final exits across repeated global and LP rounding checkpoints.
- The same owner exiting with an old epoch claim, then joining a fresh epoch.
- Liquidity addition and proportional withdrawal.
- Ordinary transfer.
- Buy.
- Sell.
- Partial claim.
- Full claim.
- Auto-materialisation.
- Zero-fee mode.
- Tiny-amount rounding.
- Maximum amount arithmetic.
- Empty eligible supply.
- Zero LP-share supply with zero raw reserve and zero custody units.
- Funding, routing, or reseeding attempts that would create custody units or
  assign old liabilities while LP-share supply is zero.
- Paused swaps.
- Swap caps.
- Direct reserve-transfer attempts.
- Direct LP-share and LP reward-vault bypass attempts.

## Python reference model

Create an independent implementation of:

- Share calculations.
- Custody-position calculations.
- LP share and downstream reward-index calculations.
- Signed corrections.
- Fee distribution.
- Claims.
- Transfers.
- Buy ordering.
- Sell ordering.
- Vault liability.
- Cross-vault liability transfer at custody checkpoints.
- Remainder carry.
- Unallocated and rounding-reserve buckets.
- Terminal claim-only dust and zero-denominator behavior.

The Move implementation and Python model must produce identical state after randomized transaction sequences.

## Property tests

Required properties:

```text
core and LP reward vaults separately and jointly cover their liabilities
every reward-vault base unit is indexed liability, unallocated, or rounding reserve
claims do not change a holder's effective balance
ordinary transfers preserve total effective eligible value
moving tRFL between a wallet and the canonical pool preserves pre-move entitlement
splitting transfers cannot create additional rewards
splitting claims cannot create additional rewards
excluded stores never accrue rewards
the canonical pool accrues exactly one global entitlement based on raw reserve units
canonical pool raw reserve equals its global custody shares at every completed operation
raw-store accessor balance equals any cached AMM reserve and custody shares
derived or effective balances are never used for AMM pricing
the pool reserve is absent from wallet shares and never counted twice
positive pool custody shares imply a positive, owned LP share supply
pool custody rewards move to LP accounted funds one-for-one
sum of LP position shares equals total LP shares
LP shares cannot enter an unsupported secondary or delegated-custody store
LP mint, burn, and transfer cannot acquire historical rewards
LP reward claims do not change total wallet-plus-custody-plus-LP effective value
raw AMM reserves never include unclaimed reflections
unsupported custody stores never accrue or trap reflection shares
zero LP-share supply implies zero raw reserve, zero custody units, and zero custody pending
new LP epochs cannot inherit old LP liabilities or unallocated rewards
claim-only LP epochs reject share/index mutations while preserving old claims
fees never exceed 1%
the AMM receives the exact net sell input
the buyer receives the exact net buy output
total raw token supply remains constant
```

## Adversarial tests

Attempt:

- Fake pool calls.
- Fake admin signers.
- Direct reserve deposits.
- Direct reserve withdrawals.
- Registering a funded or already-liable custody adapter.
- Replacing or redirecting a funded custody adapter.
- Forging the canonical pool custody capability.
- Direct LP reward-vault withdrawal.
- Donation and first-depositor LP-share manipulation.
- Minting LP shares immediately before a custody checkpoint.
- Withdrawing liquidity immediately after a custody checkpoint.
- Bypassing LP-share transfer checkpointing.
- Depositing LP shares into an unregistered secondary store, wrapper, or vault.
- Pricing from a derived/effective reserve balance instead of the raw accessor.
- Advancing the LP index or funding custody units with zero LP-share supply.
- Reseeding a new LP epoch against an old reward vault or correction state.
- Reusing an old epoch's position table for the same owner in a new epoch.
- Claiming twice.
- Claiming during a swap.
- Re-entrant dispatch paths.
- Zero-value operations.
- Integer-boundary amounts.
- Creating thousands of tiny holder positions.
- Rapid fee toggling.
- Indexer restart from an old cursor.
- Public RPC interruption.

Local runtime tests cover the attacks that can be expressed without weakening
the package: authority rejection, immutable one-time custody registration,
direct reserve and reward-vault bypasses, bootstrap minimum-share enforcement,
historical-capture attempts, claim replay, pause boundaries, epoch isolation,
and exact vault backing. Pre-initializing or directly mutating the LP ledger,
forging the custody capability, and constructing an LP secondary store are
prevented structurally by package-only functions, private Move resource types,
and the absence of a fungible LP asset; the test package must not expose a forge
or escape hatch merely to simulate those impossible calls. Network interruption,
wallet behaviour, and RPC recovery remain live-environment gates rather than
local Move claims.

---

# 13. Public Testnet pilot phases

## Phase 0: network compatibility

Deliver:

- Pinned Cedra framework revision.
- Hook probe.
- SDK probe.
- Wallet display report.
- Gas measurements.
- Go or no-go decision for automatic materialisation.

**Exit condition:** The exact Cedra Testnet behaviour of deposit, withdrawal, derived balance, and internal reference operations is documented and reproducible.

**Recorded result (2026-07-20):** Exit condition met for the claim-backed path.
H1-H7 finalized successfully; H8 is an explicit inconclusive/fail result, so
automatic materialisation is not authorized. See
`ops/evidence/hook-probe-testnet.json`.

## Phase 1: specification and model

Deliver:

- Economic specification.
- Transaction ordering.
- Eligibility specification.
- Canonical LP custody and beneficial-owner specification.
- Custody-adapter trust and registration specification.
- Rounding specification.
- Python reference model.
- Independent LP/custody reference model.
- Deterministic test vectors.
- State-invariant document.

**Exit condition:** Two independent implementations calculate identical balances from the same operation sequence.

## Phase 2: reflection core

Deliver:

- Fixed-supply `tRFL`.
- Reward vault.
- Distribution vault.
- Global index.
- Wallet and custody positions and corrections.
- Custody registry and narrow reward-routing capability.
- Custody checkpoint that transfers liability without changing pool reserves.
- Aggregate-liability, unallocated-fee, and rounding-reserve accounting.
- Authoritative raw custody-balance accessor.
- Hooks.
- Claims and materialisation.
- Views and events.
- Pause controls.
- A clean initial schema with no legacy-state transition surface.

**Exit condition:** All core tests and model comparisons pass.

## Phase 3: Testnet AMM and faucet

Deliver:

- `tUSD`.
- Faucet.
- Canonical pool.
- Buy and sell paths.
- Net swap quotations.
- Bootstrap and controlled public liquidity paths.
- LP share accounting and downstream reward index.
- LP reflection checkpoint and claim paths.
- LP unallocated/rounding buckets and isolated reward epochs.
- Active-epoch registry plus immutable claim-only prior epoch states and vaults.
- Primary-store-only or account-bound LP ownership enforcement.
- Proportional liquidity withdrawal.
- Swap limits.

**Exit condition:** Every swap and liquidity operation reconciles gross amount,
reflection fee, AMM fee, net amount, wallet shares, pool custody shares, LP
shares, both reward vaults, both indexes, and every liability transfer.

## Phase 4: client and indexer

Deliver:

- TypeScript SDK wrapper.
- Web application.
- Wallet integration.
- Event processor.
- Reconciliation worker.
- Public dashboard.
- Alerting.

**Exit condition:** A new user can obtain gas, claim test assets, trade, transfer, observe reflections, and claim rewards without manual CLI work.

## Phase 5: closed Testnet pilot

Participants use a published deployment with controlled faucet grants.

Exercise:

- Normal trading.
- Burst trading.
- Many small holders.
- Claims.
- Transfers.
- LP deposits, proportional withdrawals, and reward claims.
- LP share transfers when enabled by the hook gate.
- Pool custody checkpoints before and after burst trading.
- Pauses.
- Indexer recovery.
- Liquidity withdrawal and reseeding.

**Exit condition:** No unexplained accounting differences and no unresolved high-severity implementation defects.

## Phase 6: open Testnet beta

Open the faucet and web interface publicly.

Open capped public liquidity only after the closed pilot proves zero
wallet/custody/LP reconciliation discrepancy and the independent review has no
unresolved high or critical finding.

Run:

- Synthetic transaction generators.
- Public bug reporting.
- Public accounting dashboard.
- Release changelogs.
- Fresh-deployment recovery drills.
- Incident-response drills.

## Phase 7: fresh-deployment recovery rehearsal

Deploy a completely new Testnet instance and optionally rehydrate holder allocations from the last trusted snapshot.

The trusted snapshot must include wallet positions, custody registrations, pool
custody corrections and claims, LP shares and corrections, both indexes, and
both reward-vault liabilities.

**Exit condition:** The project can recover from a disposable-network event
without inventing balances manually.

---

# 14. Quantitative pilot gates

Before calling the Testnet build successful, require:

| Gate | Target |
|---|---:|
| Randomized reference-model operations | At least 1,000,000 |
| On-chain synthetic transactions | At least 50,000 |
| Completed swaps | At least 10,000 |
| Distinct holder positions | At least 1,000 |
| Distinct LP positions | At least 100 |
| Completed liquidity add/remove operations | At least 1,000 |
| Accounting reconciliation | 100% |
| Wallet/custody/LP reward allocation reconciliation | 100% |
| Combined core and LP vault discrepancy | 0 base units |
| Unnamed reward-vault base units | 0 |
| Raw accessor/cached reserve/custody-share discrepancy | 0 base units |
| Overallocated rewards | 0 base units |
| Direct pool bypasses | 0 successful |
| Direct LP-share or LP-vault bypasses | 0 successful |
| Unauthorized custody adapters | 0 successful |
| Unauthorized admin actions | 0 successful |
| Successful fresh-deployment rehearsal | 1 or more |
| Indexer recovery from snapshot | Demonstrated |
| Unresolved critical or high findings | 0 |

These numbers are not measures of commercial adoption. They are test coverage expressed through real chain activity.

---

# 15. Incident response

## Primary emergency action

```text
Pause swaps and liquidity mutations
```

Do not automatically pause wallet transfers, wallet claims, or LP reward claims
unless the defect specifically affects that path. A custody-weight or LP-index
discrepancy requires pausing LP claims as well as liquidity mutations.

## Incident procedure

1. Pause swaps and liquidity mutations; pause LP claims if LP accounting is implicated.
2. Record the current ledger version.
3. Snapshot global state, pool custody state, LP positions, and both reward vaults.
4. Stop faucet distribution.
5. Reconcile events from the last trusted checkpoint.
6. Identify the first divergent transaction.
7. Publish the affected package version and transaction sequence.
8. Prepare and review a corrected package, then deploy a fresh instance if the
   incident cannot be resolved without changing contract state.
9. Rerun deterministic recovery tests.
10. Resume swaps after reconciliation returns to zero discrepancy.

No `force_set_balance` or arbitrary state-edit function should exist, even on Testnet. Such functions make testing appear green by painting over the smoke alarm.

---

# 16. Deliberately deferred features

Do not include these in the initial contract package:

- Additional LP mining or token-emission incentives beyond passthrough of the
  reflections earned by the pool's own underlying `tRFL`.
- One-sided or donation-based liquidity entry.
- Multiple pools.
- Third-party DEX adapters.
- Permissionless or self-reported custody adapters.
- Unreviewed external vault, wrapper, exchange, or bridge passthrough.
- Multi-hop swaps.
- Bridge integration.
- Lending or collateral integration.
- Oracle-dependent logic.
- Buy and sell fee differences.
- Wallet blacklisting.
- Fee greater than 1%.
- Governance token.
- DAO voting.
- Mainnet tokenomics.
- Token sale functionality.
- Real stablecoin pairs.
- Promises of future value.

Capped public LP activation is part of this package's Testnet proof, but it
occurs only after bootstrap liquidity, LP checkpointing, just-in-time-liquidity
tests, proportional redemption, and combined-vault reconciliation have passed
the closed pilot. Additional pools and third-party custody adapters remain
later, separately reviewed releases.

---

# 17. Definition of done

## On-chain package gate — current focus

The full contract package is complete when:

- `tRFL` has a fixed supply for the deployment.
- The distribution, core reward, and LP reward vaults are excluded.
- Wallet-to-wallet transfers are untaxed.
- Supported buys and sells charge exactly 1%.
- The reward vault physically receives every reflection fee.
- Wallet-held and canonical-pool `tRFL` are each counted exactly once in the
  O(1) global index.
- The pool's custody reward is routed one-for-one into an O(1) LP-share index.
- Core and LP reward vaults separately and jointly cover calculated liabilities.
- Every reward-vault base unit is classified as indexed liability, unallocated,
  or rounding reserve.
- Claims preserve effective holder balances.
- LP share mint, burn, transfer, and claim checkpointing preserves accrued
  ownership and cannot capture historical rewards.
- Pending rewards can be spent automatically when hooks permit.
- The AMM prices sells from net reserve input.
- AMM settlement and quotation use the authoritative raw-store accessor, with
  raw store balance, cached reserve, and custody shares equal after every call.
- Unclaimed LP reflections never alter raw AMM reserves, quotations, or `x * y`.
- AMM quote views expose net user receipt for buys.
- Pool transfers cannot bypass the reflection settlement path.
- Direct reserve, LP-share, custody-routing, and LP-vault bypasses fail closed.
- LP shares are account-bound or move only between checkpointed, registered
  primary stores; unsupported LP-share custody fails closed.
- Zero LP-share supply implies zero raw reserve, zero custody units, and zero
  custody pending; a new LP epoch cannot inherit old liabilities.
- Unsupported delegated-custody stores do not silently accrue rewards; every
  supported adapter is explicit, reviewed, and bound to an exact store.
- The initial package contains no speculative legacy-state transition surface.
- Routine operational controls are separated from publisher accounts through
  evented, publisher-authorized handoffs.
- Every economic operation emits sufficient events for replay.
- The independent model reproduces on-chain accounting exactly in deterministic
  and randomized local tests.
- The contract code is structurally suitable for later mainnet hardening.

Passing this gate is local contract evidence. It is not Testnet deployment,
wallet, participant, or public-beta evidence.

## Later pilot completion gate

The broader Cedra Testnet build is complete when:

- The on-chain package gate above has passed on the exact release artifact.
- The independent indexer reproduces on-chain accounting exactly.
- The UI quotes buys using net user receipt.
- The public interface repeatedly states that assets have no value.
- A full redeployment and restoration rehearsal has succeeded.
- The quantitative Testnet gates in section 14 have passed with preserved
  transaction and reconciliation evidence.

## Final recalibrated target

```text
Production-quality code
        +
disposable Testnet deployment
        +
one controlled AMM
        +
wallet and canonical-LP holders rewarded once
        +
fixed test supply
        +
1% vault-backed reflections
        +
one clean initial state schema
        +
public accounting dashboard
        +
fresh-deployment recovery rehearsal
```

The first concrete deliverable should be the **dispatchable-hook compatibility probe plus the written reflection accounting specification**. Those two artifacts determine whether the pilot gets seamless growing balances or the explicit-claim fallback, and they prevent the rest of the project from building a cathedral on a trapdoor.
