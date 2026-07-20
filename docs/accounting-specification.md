# tRFL reflection accounting specification (initial schema)

Status: normative for the Cedra Testnet pilot's economic behaviour.  It is the
source of truth for the independent Python model and the Move conformance
suite.  It deliberately does not prescribe Cedra object layouts or hook APIs.

## Scope and units

All tRFL and tUSD values are non-negative integer base units.  A percentage is
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
- the core, faucet, and AMM operator primary stores; and
- explicitly registered contract/escrow primary stores.

There are exactly two global-share position classes:

- a registered wallet's primary store; and
- the canonical pool's exact raw tRFL reserve, registered as one approved
  custody position.

The pool reserve is dispatch-excluded so direct deposits and withdrawals abort,
but its raw units are manually included once in the global index by authenticated
settlement. It never also appears as a wallet position. Its pending reward is
routed to the active LP epoch rather than added to the AMM reserve.

Wallet eligibility is explicit. A wallet registers its primary store before a
standard receipt, or is registered by a signer-authenticated faucet, buy, LP
claim, or liquidity-withdrawal path. Unregistered secondary stores, wrappers,
contract stores, and delegated custody fail closed. An excluded or unsupported
store has zero pending reward regardless of raw balance. A position first
becoming eligible is attached at the current index and cannot claim earlier
fees.

The pool has no generic transfer entry point. Its tRFL reserve can change only
through authenticated bootstrap, canonical `buy`/`sell`, proportional liquidity
operations, and epoch shutdown/reseed. The core reward vault releases tRFL only
through wallet materialisation or a one-for-one custody route. An LP reward
vault releases tRFL only through a computed LP claim. These restrictions prevent
an untaxed direct reserve or vault transfer from bypassing accounting.

## Publisher and operational authority

The core, test-assets, and AMM package publishers are cold authorities for
package-owned resources and narrow capability issuance. Each publisher may set
a non-zero operational address through an evented entry function. Routine
reflection-fee, pause, faucet, shutdown, swap-limit, and liquidity-limit calls
authenticate that operational address instead of the publisher after handoff.

The publisher may rotate the operational address, but the old operational key
loses authority immediately and the publisher does not implicitly retain
routine authority. Every handoff is replayed by the indexer and compared with
the three on-chain operational-admin views. This separation changes no balance,
index, correction, reserve, vault, or LP state.

## State and position formula

The global state contains:

```text
index: u256                    // magnified reward per eligible raw tRFL
index_remainder: u256          // carried integer-division residue
total_shares: u256             // sum of eligible raw tRFL
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
dispatchable-hook feasibility gate succeeds, an attempted spend that exceeds
raw balance automatically materialises exactly the shortfall first, unless
claims are paused. A claims pause blocks both explicit claims and this
automatic materialisation path; a transfer or sell backed entirely by raw
balance remains possible. If the gate fails, the same model is used in
explicit-claim mode and a spend requires enough raw balance.

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
custody rewards. An old claim-only epoch remains withdrawable by its existing
positions but never receives a current-pool checkpoint.

## LP reward epochs

Each LP epoch has a distinct immutable state identifier, position table, and
excluded reward vault:

```text
status: ACTIVE | CLAIM_ONLY
index: u256
index_remainder: u256
total_lp_shares: u256
aggregate_correction: signed
unallocated_rewards: u128
rounding_reserve: u128
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
remainder algorithm as the core. A zero-denominator receipt is recorded in
`unallocated_rewards`, pauses LP mutation, and is never silently assigned to a
later provider. Mint, burn, and module-mediated transfer apply signed
corrections at one LP index, so new shares receive no historical reward and
removed shares retain everything already earned.

An LP claim increments only that position's settled amount and
`lifetime_claimed`, then moves the exact tRFL from that epoch vault into the
claimant's registered wallet at the current global index. It does not change LP
shares or raw reserves. Claiming from `CLAIM_ONLY` epoch `e` never checkpoints
the active pool and cannot mutate any other epoch.

At shutdown, the active epoch routes custody pending before the final burn and
returns every residual reserve unit on the final withdrawal. It then becomes
`CLAIM_ONLY`; old zero-share positions keep their indexed claims. Reseeding is
allowed only after raw reserve, custody shares, and custody pending are zero,
and creates a fresh epoch state/table/vault. `CLAIM_ONLY` is terminal. Because
separate sub-base-unit position fractions can sum to a whole aggregate unit,
an old vault may retain named aggregate liability even when each individual
pending view is zero. That residue stays backed in the old vault and is never
swept, reassigned, or carried into a fresh epoch.

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
transaction.

## Canonical AMM settlement

The only initial pool is a project-managed constant-product `tRFL/tUSD` pool. Its
AMM fee is a distinct configurable value (the reference model defaults to
30 bps).  The AMM fee remains in the reserve; pricing uses only:

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

1. Materialise only the pending shortfall if necessary, then debit seller raw
   tRFL by `gross_rfl`.
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
8. Only `ACTIVE` epoch can mutate its index/shares; `CLAIM_ONLY` epochs can only
   satisfy existing claims; new epochs reuse no old vault, table, or liability.
9. Zero active LP shares implies zero pool raw reserve, zero custody shares, and
   zero custody pending.
10. `0 <= fee_bps <= 100`; no successful supported swap charges more than 1%.
11. Wallet and LP claims preserve combined effective value exactly.
12. Wallet transfer and wallet/custody representation changes preserve all
    pre-change entitlement. Bootstrap is the exception: distribution-vault raw
    entering custody increases global shares by the seeded amount.
13. A sell increases the raw tRFL reserve by exactly net sell input; a buy
    decreases it by gross pool output and credits the buyer exactly net output.
14. LP checkpoints and claims never alter raw reserves, quotes, or `R × U`.
15. No direct pool, custody, LP-share, or reward-vault bypass succeeds.

## Initial schema and fresh-deployment recovery

This contract has not been deployed, so the repository defines one complete
initial schema directly. It contains no legacy-state conversion resource,
entry point, approver, event, model operation, or rehearsal.

Recovery from a disposable Testnet instance uses a signed off-chain snapshot
containing all state above, every raw/quote balance, corrections, materialised
amounts, exclusions, and pause/configuration values. A fresh deployment may be
rehydrated only from that trusted evidence and must reproduce the recorded
allocations and pass every invariant before use.

## Test evidence and commands

The hand-authored deterministic reference vector is
[`python/test_vectors/basic_accounting.json`](../python/test_vectors/basic_accounting.json).
The fixed-seed mixed-operation witness is
[`python/test_vectors/seeded_mixed_accounting.json`](../python/test_vectors/seeded_mixed_accounting.json),
and its generated Move replay is
[`move/integration-tests/tests/seeded_conformance_generated.move`](../move/integration-tests/tests/seeded_conformance_generated.move).
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
PYTHONPATH=python python3 -m unittest python.tests.test_accounting_model.RandomizedPropertyTests.test_seeded_randomized_accounting -v
```

The large-model random seed is fixed in the test source and the operation count
and holder count are explicit command inputs. The model emits an ordered event
log for each run. The bounded cross-implementation witness separately samples
64 valid mixed operations from a fixed seed after setup and proves the complete
Move and Python final snapshots are identical.

## Open protocol decisions requiring the hook probe

The accounting model is complete enough to test the claim-backed fallback, but
three Cedra-specific decisions remain deliberately unresolved until Phase 0:

1. whether a derived balance hook can expose `effective` balance through all
   required primary and secondary stores;
2. whether internal reward-vault materialisation can avoid recursive dispatch
   hook invocation; and
3. whether the selected wallet displays derived balance correctly or must use
   an explicit pending/claim interface.

Those are integration facts, not accounting shortcuts.  Failure of the hook
probe selects explicit-claim mode; it must not change the fee, vault, index,
correction, AMM, or invariant rules above.
