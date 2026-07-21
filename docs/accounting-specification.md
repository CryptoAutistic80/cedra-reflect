# tRFL reflection accounting specification (initial schema)

Status: normative for the Cedra Testnet pilot's economic behaviour.  It is the
source of truth for the independent Python model and the Move conformance
suite.  It deliberately does not prescribe Cedra object layouts or hook APIs.

## Scope and units

All tRFL/tUSD amounts, store balances, reserves, swap inputs/outputs, and vault
base units are `u64`. LP share amounts and both global/LP share totals are
`u128`; indexes, lifetime counters, and magnified correction arithmetic are
bounded to `u256`. A percentage is
expressed in basis points (bps), with `10_000 bps = 100%`. The initial reflection
fee is configurable only from `0` through `100 bps`; the normal setting is
`100 bps` (1%).  No minimum fee is imposed: a fee that rounds below one base
unit is zero.

The deployment has one immutable `fixed_supply`.  There is no tRFL mint or
burn after initialisation.  The distinct mock tUSD supply is outside this
specification and may be minted by the Testnet faucet.

## Stores and eligibility

The following tRFL stores are permanently excluded from global reflection
shares:

- `distribution_vault`, which holds undistributed fixed supply;
- `reward_vault`, which physically backs every reflection fee;
- every LP reward vault;
- the three package-publisher primary stores; and
- every current or former operational primary store.

The asset and AMM publisher exclusions consume exactly two finite bootstrap
slots and require those publishers to co-sign while their stores are empty and
unregistered. Operational exclusions use a separate permanent path: every new
operations signer must have an empty, unregistered tRFL primary store, and role
rotation never re-enables an old operations store.

There are exactly two global-share position classes:

- a registered wallet's primary store; and
- the canonical pool's exact raw tRFL reserve, registered as one approved
  custody position.

The pool reserve is dispatch-excluded so direct deposits and withdrawals abort,
but its raw units are manually included once in the global index by authenticated
settlement. It never also appears as a wallet position. Its pending reward is
routed to the active LP epoch rather than added to the AMM reserve.

Canonical custody registration is a multi-agent operation: the core publisher
authorizes the one-time binding and the AMM custodian co-signs ownership of the
two distinct stores. The reserve and first LP reward vault must both be empty
and previously unclassified. Registration rejects a funded store, an existing
wallet position, a pre-existing LP liability, one object supplied for both
roles, or a store not owned by the signing custodian. Pool initialization and
LP-ledger initialization are one atomic transaction, so a downstream failure
rolls the custody binding back. LP-ledger initialization and mutation functions
are package-only; external callers can use the pool's checkpointed entries and
read-only LP views, but cannot create a competing ledger state.

Wallet eligibility is explicit. A wallet registers its primary store before a
standard receipt, or is registered by a signer-authenticated faucet, buy, LP
claim, or liquidity-withdrawal path. Unregistered secondary stores, wrappers,
contract stores, and delegated custody fail closed. An excluded or unsupported
store has zero pending reward regardless of raw balance. A position first
becoming eligible is attached at the current index and cannot claim earlier
fees.

An account-controlled vault may use that controller account's canonical
primary store and register it as one wallet position. In that case the entire
store accrues to that single account address; the protocol neither discovers
depositors nor apportions the account's reward among them. A custom or
secondary vault store remains unsupported and fails closed. Only the canonical
AMM adapter performs reviewed beneficial-owner passthrough to LP positions.

The first successful registration emits exactly one
`WalletRegistered { account, primary_store, registered_wallet_count }` event.
Explicit registration is idempotent, and implicit signer-authenticated receipt
paths use the same helper, so replay never observes a second registration event
for the same account.

The pool has no generic transfer entry point. Its tRFL reserve can change only
through authenticated bootstrap, canonical `buy`/`sell`, proportional liquidity
operations, and epoch shutdown/reseed. The core reward vault releases tRFL only
through wallet materialisation or a one-for-one custody route. An LP reward
vault releases tRFL only through a computed LP claim. These restrictions prevent
an untaxed direct reserve or vault transfer from bypassing accounting.

## Publisher and operational authority

The core, test-assets, and AMM package publishers are cold authorities for
package-owned resources and narrow capability issuance. An operational handoff
requires the destination account's signer, not a bare address. The normal path
is one atomic four-signer AMM-coordinator entry that authenticates all three
publishers plus the new operations signer and rolls every authority change back
if any package check fails. Individual package handoffs exist only as explicit
recovery surfaces and retain the same destination-signature requirement.
Routine reflection-fee, pause, faucet, shutdown, swap-limit, and
liquidity-limit calls authenticate that operational address instead of the
publisher after handoff.

The new operations account must be distinct from every publisher, must never
have registered or funded its tRFL primary store, and must never have held LP
shares. Its primary store is permanently excluded in the same transaction.
Pool seed, reseed, add-liquidity, and LP-transfer paths reject the operations
role, so neutrality remains true after handoff. A later atomic rotation removes
the old key's authority while leaving both old and new primary stores excluded.
Every authority and exclusion event is replayed by the indexer and compared
with the three on-chain operational-admin views. This separation changes no
balance, index, correction, reserve, vault, or LP entitlement.

Initial seed and later reseed operations authenticate the LP beneficiary as a
signer. The signer must be non-excluded and must not be any publisher or current
operational authority. Seed/reseed then registers a fresh authenticated wallet
atomically before minting its LP position; an already registered eligible wallet
is accepted idempotently. This prevents permanent LP ownership from being
assigned to a typo, an excluded control account, or an address whose control was
not proved in the transaction.

`begin_shutdown` is permitted only while LP claims are unpaused. Shutdown
locks pause reconfiguration, and full-position removal may need to auto-pay an
LP claim; accepting a claims-paused shutdown would therefore create a permanent
operator-induced exit deadlock. The preflight occurs before any pause or
shutdown field changes, so rejection is atomic.

## State and position formula

The global state contains:

```text
index: u256                    // magnified reward per eligible raw tRFL
index_remainder: u256          // carried integer-division residue
total_shares: u128             // sum of eligible raw tRFL
aggregate_correction: signed   // sum of per-position corrections
unallocated_fees: u128         // fees collected while total_shares was zero
rounding_reserve: u128         // whole vault units not yet indexed liability
lifetime_fees: u256
lifetime_materialized: u256
lifetime_custody_routed: u256
```

Each wallet or custody position has signed `correction` and cumulative `settled`
amounts. Let `M = 10^24`, `shares[p]` be wallet raw balance or custody raw units,
`I` be `index`, and `C[p]` be `correction[p]`.

```text
accrued[p] = floor((shares[p] × I + C[p]) / M)
pending[p] = accrued[p] - settled[p]
effective_wallet[a] = raw[a] + pending[a]
```

For aggregate backing:

```text
gross_entitlement
    = floor(apply_signed(total_shares × index, aggregate_correction) / M)
aggregate_settled = lifetime_materialized + lifetime_custody_routed
core_indexed_liability = gross_entitlement - aggregate_settled

reward_vault_balance
    = core_indexed_liability + unallocated_fees + rounding_reserve
    = lifetime_fees - lifetime_materialized - lifetime_custody_routed
```

`C[a]` is allowed to be negative.  Intermediate multiplication and all
correction arithmetic must use checked `u256`-sized magnitude arithmetic and
an explicit signed representation in Move; no wrapping arithmetic is valid.
The Python model uses arbitrary precision but rejects a correction magnitude or
index outside the stated bound.

This model uses **eligible raw balance as its share basis**. Materialising
a reward makes it raw balance and consequently eligible for later fee rounds.
This is intentional and must be identical in Move and the indexer; it means
claim timing can affect shares in *future* distributions, but never changes a
claim's current effective balance.  The protocol must not imply a different,
automatically compounding share model without a separately reviewed
specification.

## Index advance and rounding

For a taxable gross amount `G`:

```text
fee = floor(G × fee_bps / 10_000)
net = G - fee
```

The `fee` is transferred physically into `reward_vault` before entitlement is
advanced.  If `total_shares > 0`, calculate:

```text
numerator = fee × M + index_remainder
increment = floor(numerator / total_shares)
index_remainder = numerator mod total_shares
index += increment
```

If `total_shares == 0`, do not change `index`; instead add the fee to
`unallocated_fees`.  These fees remain backed surplus in the reward vault and
are never retroactively awarded to the first later holder.  This avoids a
newly-created position claiming fees earned when no eligible holder existed.

`index_remainder` is normalized at index-advance time.  Because eligible raw
supply may change between two advances, it need not be less than the current
`total_shares` at every later instant; it is reduced again on the next advance.

Per-position rounding is explicitly classified, never treated as an unnamed or
withdrawable surplus. After every index advance:

```text
rounding_reserve
    = reward_vault_balance - core_indexed_liability - unallocated_fees

reward_vault_balance
    = core_indexed_liability + unallocated_fees + rounding_reserve
```

The sum of individually floored pending positions may be below aggregate
indexed liability; that difference remains represented by the aggregate index
and corrections. No base unit disappears from the three named buckets.

## Balance mutations and corrections

For every raw movement of `x` from eligible sender `s` to eligible recipient
`r`, apply the raw movement and then:

```text
C[s] += I × x
C[r] -= I × x
```

The same respective adjustment is applied for an eligible debit or credit to
an excluded store.  `total_shares` changes only when an eligible raw balance
changes.  These corrections preserve both sender and recipient accrued reward
exactly across an ordinary transfer, including all fractional magnified state.
Wallet-to-wallet transfers do not collect a reflection fee.

### Claim and automatic materialisation

For `0 < x <= pending[a]`:

```text
reward_vault.raw -= x
raw[a] += x
total_shares += x
C[a] -= I × x
materialized[a] += x
```

The correction prevents the newly raw `x` from claiming historic index
rewards. Before and after the claim, `effective[a]` is identical. If the
deployment's immutable `automatic_materialization` mode is `true`, an attempted
spend that exceeds raw balance automatically materialises exactly the shortfall
first, unless claims are paused. A claims pause blocks both explicit claims and
this automatic materialisation path; a transfer or sell backed entirely by raw
balance remains possible. In claim-backed mode, withdrawal and deposit hooks
still maintain corrections for standard transfers, the derived hook returns raw
balance, and a spend requires enough raw balance until an explicit on-chain
claim materialises pending rewards. The publishable Testnet initializer hardcodes
claim-backed mode after the compatibility probe; automatic mode is exercised
only in test bytecode. There is no setter, conversion resource, or migration
path in this package version. The publishable core, asset, and AMM
packages use immutable upgrade policy; changing this logic requires a visibly
fresh deployment and a new release manifest.

### Custody reward routing

The canonical reserve's position uses its raw reserve as shares. For
`0 < x <= pending[pool]`, a custody checkpoint performs:

```text
reward_vault.raw -= x
active_lp_epoch.reward_vault.raw += x
pool.settled += x
lifetime_custody_routed += x
active_lp_epoch.lifetime_received += x
```

It does not change pool raw reserve, custody shares, global `total_shares`, or
the pool correction. The downstream LP index then accounts for the received
`x`. The decrease in core accounted funds equals the increase in LP accounted
funds exactly.

Only the active epoch vault bound to the canonical adapter may receive current
custody rewards. A terminal claim-only epoch never receives a current-pool
checkpoint and has no remaining indexed liability.

## LP reward epochs

Each LP epoch has a distinct immutable state identifier, position table, and
excluded reward vault:

```text
status: ACTIVE | CLAIM_ONLY
index: u256
index_remainder: u256
total_lp_shares: u128
aggregate_correction: signed
unallocated_rewards: u128
rounding_reserve: u128
terminal_rounding_reserve: u128
retired_residue_magnified: u256
lifetime_received: u256
lifetime_claimed: u256
```

For LP position `q`, replace global raw shares in the formula with its LP share
units. The aggregate formulas are:

```text
lp_gross_entitlement[e]
    = floor(apply_signed(total_lp_shares[e] × lp_index[e],
                         lp_aggregate_correction[e]) / M)
lp_indexed_liability[e] = lp_gross_entitlement[e] - lifetime_claimed[e]

lp_reward_vault[e]
    = lp_indexed_liability[e]
    + unallocated_rewards[e]
    + rounding_reserve[e]
    = lifetime_received[e] - lifetime_claimed[e]
```

An active epoch receiving `x` advances its index with the same magnified
remainder algorithm as the core. A defense-in-depth zero-denominator receipt is
recorded in `unallocated_rewards`, sets the epoch's quarantine flag, freezes
share/index mutation, and is never silently assigned to a later provider. A
claim against entitlement indexed before quarantine skips active checkpointing
and remains payable; the quarantined receipt itself never enters the index.
Mint, burn, and module-mediated transfer apply signed
corrections at one LP index, so new shares receive no historical reward and
removed shares retain everything already earned.

An LP claim increments only that position's settled amount and
`lifetime_claimed`, then moves the exact tRFL from that epoch vault into the
claimant's registered wallet at the current global index. It does not change LP
shares or raw reserves.

Before a burn or module-mediated transfer takes an owner's LP shares to zero,
the pool pays every whole pending unit into that owner's registered wallet. If
payment is required while LP claims are paused, the complete transaction aborts
and all checkpoint, payout, reserve, and share mutations roll back. A zero-pending
exit remains available while paused because it moves no reward-vault value.

After the whole payout, a zero-share position must satisfy:

```text
claimed[q] * M <= correction[q] < (claimed[q] + 1) * M
residue[q] = correction[q] - claimed[q] * M
correction[q] -= residue[q]
aggregate_correction[e] -= residue[q]
retired_residue_magnified[e] += residue[q]
```

Only the fractional magnified residue is removed. Recomputing the physical
three-bucket identity may reclassify one or more combined whole base units from
aggregate liability into `rounding_reserve`; those units are not paid to the
admin, the last LP, a transferee, or a later cohort.

At shutdown, the active epoch routes custody pending before each burn. Every
shutdown removal bypasses `max_withdrawal_share_bps`, so an operator cannot set
a tiny cap and strand fragmented holders after pause configuration is locked.
A non-final proportional burn may return exactly one zero asset when the other
asset is nonzero; the pool conditionally moves only the nonzero assets. Both-zero
output remains invalid, and both caller-supplied minimums remain binding. The
final withdrawal returns every residual reserve unit. Closure requires
`total_lp_shares == 0`, indexed liability `== 0`, and
`unallocated_rewards == 0`. It records the remaining physical vault balance as
immutable `terminal_rounding_reserve`, emits exact terminal evidence, and then
becomes `CLAIM_ONLY`. Reseeding is allowed only after raw reserve, custody
shares, and custody pending are zero. A fresh epoch state/table/vault is
created; before fresh custody shares enter, the route opener normalizes the
zero-share custody correction to
`lifetime_custody_routed * M`, subtracts the exact sub-base-unit residue from
both custody and aggregate corrections, recomputes core rounding, and emits
`CustodyEpochRouteOpened.retired_residue_magnified`. No sweep or migration
surface exists, and no later epoch can address the old vault.

Replay consumes two unit-explicit events:

```text
LpFractionalResidueRetired {
  epoch: u64, owner: address, residue_magnified: u256,
  cumulative_retired_residue_magnified: u256,
  rounding_reserve_base_units: u128
}
LpEpochTerminalDustClassified {
  epoch: u64, reward_vault: address,
  terminal_rounding_base_units: u128,
  retired_residue_magnified: u256,
  lifetime_received_base_units: u256,
  lifetime_claimed_base_units: u256
}
```

`pool::lp_epoch_terminal_dust(epoch)` returns
`(terminal_rounding_base_units: u128, retired_residue_magnified: u256)`. The
existing nine-field `lp_epoch_accounting` return shape is unchanged.

The canonical pool uses a controlled project bootstrap instead of burned
minimum-liquidity shares. Public liquidity cannot be first. Thus every issued
LP share always belongs to an explicit position and no permanently orphaned
share can trap rewards.

## Proportional liquidity math

For the controlled bootstrap:

```text
initial_lp_shares = isqrt(rfl_in × usd_in)
```

The bootstrap aborts unless both reserves and total LP shares were zero, both
inputs and the result are positive, and all initial shares are assigned to the
declared non-operator beneficiary atomically with reserve/custody creation.

For later addition with maximum inputs `rfl_max`, `usd_max`, existing raw
reserves `R`, `U`, and total LP shares `T`:

```text
minted = min(floor(rfl_max × T / R), floor(usd_max × T / U))
rfl_used = ceil(minted × R / T)
usd_used = ceil(minted × U / T)
```

`minted`, `rfl_used`, and `usd_used` must be positive and within the user's
maxima; only the used amounts are withdrawn, so no donation/refund ambiguity is
created. The pool routes custody pending and checkpoints the provider before
moving raw assets or minting shares.

For withdrawal of `burn` shares:

```text
rfl_out = floor(burn × R / T)
usd_out = floor(burn × U / T)
```

The final `burn == T` shutdown withdrawal returns all remaining `R` and `U`
rather than flooring. It is available only in shutdown mode after the custody
checkpoint. Minimum-output and deadline checks occur in the same atomic
transaction. Outside shutdown, a non-final removal still requires both outputs
to be positive. During shutdown, exactly one side may floor to zero, provided
the other is positive and both explicit minima are satisfied; each nonzero side
is settled independently.

## Canonical AMM settlement

The only initial pool is a project-managed constant-product `tRFL/tUSD` pool. Its
AMM fee is a distinct configurable value bounded to `0..100 bps` (default
`30 bps`). Gross input is also bounded by the configured absolute maximum and
by `max_reserve_bps` of the input reserve (defaults: `100_000_000_000` base
units and `2_000 bps`). The same reserve-percentage cap is checked against gross
output. The AMM fee remains in the reserve; pricing uses only:

```text
invariant_input = floor(net_input × (10_000 - amm_fee_bps) / 10_000)
amm_fee = net_input - invariant_input
output = floor(output_reserve × invariant_input / (input_reserve + invariant_input))
```

This ordering is deliberate for inputs that are not evenly divisible by the
basis-point denominator. The invariant input rounds down; the complementary
base-unit remainder stays in the input reserve and is reported as `amm_fee`.
Computing `floor(net_input × amm_fee_bps / 10_000)` first and subtracting it
would round the invariant input up and is not conformant.

### Sell tRFL

For a seller's `gross_rfl`:

1. Require the seller's raw balance to cover `gross_rfl`, then debit it. The
   publishable immutable Testnet mode does not auto-materialise a pending
   shortfall; the holder must claim first.
2. Compute `reflection_fee` and `net_rfl` from gross input.
3. Credit `reflection_fee` to the reward vault and advance the global index
   across the seller's remaining wallet units and the pre-trade pool custody
   units.
4. Credit `net_rfl` to the raw pool reserve and add equal custody shares at the
   new index.
5. Price tUSD output using `net_rfl` (and then the AMM fee) as input, debit pool
   tUSD, and credit seller tUSD.

The seller's *remaining* raw balance and the pre-trade pool reserve participate
in that fee distribution. The sold amount does not, and the newly deposited
`net_rfl` cannot receive its own fee. The AMM receives exactly `net_rfl`, never
the gross user input.

### Buy tRFL

For a buyer's `quote_in`:

1. Price gross pool tRFL output from `quote_in` after the AMM fee.
2. Compute reflection fee from that gross tRFL output and calculate `net_rfl`.
3. Move quote input into the pool, remove custody shares equal to gross tRFL
   output at the pre-fee index, debit that raw output, and credit the reflection
   fee to the reward vault.
4. Advance the index across the post-withdraw pool units and all pre-existing
   wallet units while the purchased `net_rfl` is not yet eligible.
5. Credit `net_rfl` to the buyer with a correction at the new index.

The buyer's pre-existing raw balance participates in the buy fee; newly
purchased tokens do not.  Slippage checks must compare the user's requested
minimum against `net_rfl`, not the gross reserve output.

## Required invariants

Every implementation and the indexer must enforce or continuously verify:

1. `sum(all raw tRFL stores) == fixed_supply`.
2. `total_shares == sum(wallet raw shares) + pool custody raw shares`.
3. `pool raw-store balance == cached raw reserve == pool custody shares`.
4. The pool appears in one custody position and no wallet position.
5. Core and every LP vault satisfy both exact identities above; every vault base
   unit is indexed liability, unallocated, or rounding reserve.
6. A custody checkpoint reduces core accounted funds and increases the active
   LP epoch's accounted funds by the same amount without changing reserves.
7. `sum(LP position shares) == total_lp_shares` for every epoch.
8. Only an `ACTIVE` epoch can mutate its index/shares. A normal `CLAIM_ONLY`
   epoch has zero indexed liability and unallocated rewards, an immutable
   terminal dust balance, and no path into a new epoch.
9. Zero active LP shares normally implies zero pool raw reserve, zero custody
   shares, and zero custody pending. The sole exception is a quarantined
   defense-in-depth receipt: it has positive named `unallocated_rewards`, zero
   custody pending, and all pool/share/index mutation is frozen.
10. `0 <= fee_bps <= 100`; no successful supported swap charges more than 1%.
11. Wallet and LP claims preserve combined effective value exactly.
12. Wallet transfer and wallet/custody representation changes preserve all
    pre-change entitlement. Bootstrap is the exception: distribution-vault raw
    entering custody increases global shares by the seeded amount.
13. A sell increases the raw tRFL reserve by exactly net sell input; a buy
    decreases it by gross pool output and credits the buyer exactly net output.
14. LP checkpoints and claims never alter raw reserves, quotes, or `R × U`.
15. No direct pool, custody, LP-share, or reward-vault bypass succeeds.
16. Every zero-share LP position is normalized to `claimed * M`; only its
    fractional residue is retired from the aggregate correction.
17. Epoch closure emits exactly one terminal classification whose physical base
    units equal the old vault balance. There is no admin, last-LP, transferee,
    or future-cohort redirect.
18. `0 <= amm_fee_bps <= 100`; every token/reserve amount is within `u64`, while
    LP share state remains within `u128`.
19. Shutdown cannot begin while LP claims are paused; once begun, every
    non-final burn is independent of the operator withdrawal-share cap, rejects
    both-zero output, and enforces both user minima.

## Initial schema and fresh-deployment recovery

This contract has not been deployed, so the repository defines one complete
initial schema directly. It contains no legacy-state conversion resource,
entry point, approver, event, model operation, or rehearsal.

Recovery from a disposable Testnet instance uses a signed off-chain snapshot
containing all state above, every raw/quote balance, corrections, materialised
amounts, exclusions, and pause/configuration values. The initial rehearsal is
a clean deployment whose fresh zero-history state is reconciled against its own
manifest. The snapshot is comparison evidence, not authority for manual state
mutation. If a later pilot explicitly requires allocation restoration, it must
use a separate finite, independently reviewed claim distributor; the token
contract retains no migration or privileged balance-edit surface.

## Test evidence and commands

The hand-authored deterministic reference vector is
[`python/test_vectors/basic_accounting.json`](../python/test_vectors/basic_accounting.json).
It uses the deployment's exact fixed supply
`1_000_000_000_000_000`, so its distribution-vault balance requires no hidden
offset when compared with Move.
The fixed-seed mixed-operation witness is
[`python/test_vectors/seeded_mixed_accounting.json`](../python/test_vectors/seeded_mixed_accounting.json),
and its generated Move replay is
[`move/integration-tests/tests/seeded_conformance_generated.move`](../move/integration-tests/tests/seeded_conformance_generated.move).
The same generator also emits
[`python/test_vectors/lifecycle_accounting.json`](../python/test_vectors/lifecycle_accounting.json),
whose Move replay proves shutdown through epoch-two reseed, custody route
residue, wallet correction/materialised values, historical and active epoch
state, terminal dust, and a separately quarantined zero-denominator receipt.
The generator executes the independent model, validates every intermediate
state, and emits both artifacts. The verification gate rejects drift:

```bash
PYTHONPATH=python python3 scripts/generate_seeded_conformance.py --check
```

The standard suite uses Python's built-in `unittest` runner and has no network
or package-install prerequisite:

```bash
PYTHONPATH=python python3 -m unittest discover -s python/tests -v
```

The default randomized gate is deliberately tractable for local/CI runs.  The
full quantitative reference-model gate executes one million deterministic
operations and a periodic full invariant audit:

```bash
REFLECTION_MODEL_OPERATIONS=1000000 REFLECTION_MODEL_HOLDERS=1024 \
PYTHONPATH=python python3 scripts/run_model_gate.py
```

The large-model random seed is fixed in the test source and the operation count
and holder count are explicit command inputs. The model emits an ordered event
log for each run. The bounded cross-implementation witness separately samples
64 valid mixed operations from a fixed seed after setup and proves the complete
Move and Python final snapshots are identical.

## Finalized hook decision

The 2026-07-20 Cedra Testnet record in
`ops/evidence/hook-probe-testnet.json` proves post-publication registration,
standard transfer dispatch, non-recursive reference materialisation, secondary
stores, and CLI/REST/SDK reads. It does not prove a real wallet's distinct
derived-balance display and transfer path. The initial release therefore uses
immutable claim-backed mode. This decision changes only display/spend
materialisation: the fee, vault, index, correction, canonical custody, AMM, and
LP beneficial-owner rules remain identical.
