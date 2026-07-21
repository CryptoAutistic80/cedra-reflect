# tRFL v0.2 accounting specification

Status: normative for the ownerless automatic-reflection Testnet release
candidate. It defines economic behavior independently of Cedra storage layout.

## Units and immutable policy

Token, vault, and reserve amounts are unsigned 64-bit base units. Global and LP
share totals are `u128`. Indexes, lifetime totals, and magnified corrections are
bounded unsigned 256-bit magnitudes with an explicit sign bit where needed.

```text
B = 10,000                         basis-point denominator
M = 10^24                          index magnification
reflection_fee_bps in [0, 500]     chosen once at token creation
amm_fee_bps = 30                   source-fixed
```

The release tRFL fee is 100 bps. Ordinary wallet and liquidity transfers are
untaxed. The reflection fee applies only to canonical AMM buy output and sell
input. There is one fixed tRFL supply and no mint capability after creation.

## Lifecycle and authority

`CONFIGURING` permits only source-bound one-shot setup. `LIVE` permits ordinary
token, faucet, AMM, and LP behavior. `CLOSED` permanently disables AMM and LP
mutations after exact final withdrawal.

The fee, supply, faucet grants/cooldown, AMM fee, swap limits, liquidity limits,
stores, and bootstrap amounts have no post-launch setter. No pause, admin,
rotation, shutdown, reseed, later epoch, generic adapter, or arbitrary transfer
authority exists. A retained capability can perform only its encoded fixed
settlement action and cannot be returned to a signer.

## Eligible positions

Exactly two position classes contribute global shares:

1. a registered account's canonical tRFL primary store; and
2. the canonical pool's exact raw tRFL custody balance.

The reward vault, distribution vault, LP reward vault, pool reserve store, and
source-bound package-publisher primary stores are excluded from normal wallet
classification. The pool reserve is nevertheless counted exactly once through
the separately authenticated custody position.

Secondary stores and arbitrary external vaults are unsupported. They do not
gain inferred depositor attribution. Any future custody protocol needs a new,
reviewed adapter that proves beneficial ownership and checkpoints before every
weight change.

## Global index

For each wallet or the custody position:

```text
shares[p]     = eligible raw units
correction[p] = signed magnified correction
claimed[p]    = cumulative whole units materialized or routed

accrued[p] = floor((shares[p] * index + correction[p]) / M)
pending[p] = accrued[p] - claimed[p]

effective_wallet[a] = raw[a] + pending[a]
```

The global aggregate state is:

```text
index
index_remainder
total_shares
aggregate_correction
unallocated_fees
rounding_reserve
lifetime_fees
lifetime_materialized
lifetime_custody_routed
```

Its backing identities are:

```text
gross_entitlement = floor(
    apply_signed(total_shares * index, aggregate_correction) / M
)

aggregate_settled = lifetime_materialized + lifetime_custody_routed
core_indexed_liability = gross_entitlement - aggregate_settled

reward_vault_balance
    = core_indexed_liability + unallocated_fees + rounding_reserve
    = lifetime_fees - lifetime_materialized - lifetime_custody_routed
```

Every multiplication, correction update, narrowing conversion, and subtraction
is checked. Wrapping is invalid.

## Fee collection and index advance

For a taxable gross tRFL amount `G`:

```text
fee = floor(G * reflection_fee_bps / B)
net = G - fee
```

The physical fee reaches the frozen core reward vault before the index changes.
For a nonzero denominator:

```text
numerator = fee * M + index_remainder
increment = floor(numerator / total_shares)
index_remainder = numerator mod total_shares
index = index + increment
```

If `total_shares` is zero, the fee is added to `unallocated_fees`; it is never
awarded retroactively to a later first holder. After every advance,
`rounding_reserve` is recomputed as the exact physical vault balance less
indexed liability and unallocated fees.

Materialized reward becomes raw eligible balance and therefore compounds in
future distributions. Materialization timing cannot alter present effective
balance, but may affect future weighting after the materialized raw units join
the share denominator. All automatic interaction orderings below are therefore
normative.

## Weight changes and historical entitlement

Adding `A` raw shares at index `I`:

```text
shares += A
correction -= A * I
```

Removing `A` raw shares:

```text
shares -= A
correction += A * I
```

The same delta is applied to `total_shares` and
`aggregate_correction`. These corrections preserve all pre-change entitlement
and prevent new units from capturing historical fees.

## Automatic wallet materialization

Every whole pending reward is materialized, not merely the amount needed to
cover a debit.

### Send

1. Validate the canonical sender store.
2. Materialize all sender pending reward into that store.
3. Debit the requested raw units and remove their shares.

### Receive

1. Validate or register the canonical recipient store.
2. Materialize all recipient historical pending reward.
3. Credit incoming raw units and add their shares at the current index.

Incoming units cannot capture history because materialization and correction
occur before their weight is added. A self-transfer materializes once and is
otherwise share/accounting neutral.

### Sell

1. Materialize all seller history.
2. Remove the gross sold units and their shares.
3. Split fee/net and deposit the fee to the core vault.
4. Advance the index with sold units excluded.
5. Materialize the fee earned by the seller's remaining holdings.
6. Credit net tRFL to custody and add the matching custody shares.

### Buy

1. Materialize buyer history.
2. Remove gross output from custody and custody shares.
3. Split fee/net and deposit the fee to the core vault.
4. Advance the index with gross bought units excluded from custody and before
   net buyer shares exist.
5. Materialize the fee earned by the buyer's pre-existing holdings.
6. Credit net bought units and add their shares.

### Liquidity movement

Materialize the wallet before moving tRFL between the wallet and custody. Apply
the paired wallet/custody correction deltas at the same index so total global
shares remain unchanged.

## Manual wallet fallback

`claim(amount)` and `claim_all()` use the same pending calculation and exact
one-for-one reward-vault payout. They are permissionless to the position owner,
remain available after pool closure, and have no pause path. Manual
materialization must preserve effective balance:

```text
effective_before = raw_before + pending_before
effective_after  = raw_after  + pending_after
effective_before = effective_after
```

## LP reward index

The pool custody position earns global reflections. Every swap checkpoints its
whole pending amount by:

1. marking the custody amount routed in global accounting;
2. transferring the same physical amount from the core reward vault to the
   exact frozen LP reward vault; and
3. advancing the LP reward index.

At every successful swap boundary:

```text
pool_global_pending = 0
lp_vault_balance = lp_indexed_liability + lp_unallocated + lp_rounding
lp_vault_balance = lp_lifetime_received - lp_lifetime_claimed
```

For LP position `q`:

```text
lp_accrued[q] = floor((lp_shares[q] * lp_index + lp_correction[q]) / M)
lp_pending[q] = lp_accrued[q] - lp_claimed[q]
```

LP mint, burn, and transfer use the same correction method as global shares.
Before any change, the pool checkpoints custody and automatically pays every
whole pending LP reward for each affected endpoint. An address payout may only
reach that address's canonical registered tRFL primary store through the core
custody capability. Both endpoints are paid before LP shares transfer.

Permissionless checkpoint and explicit LP claim remain fallbacks. Neither may
change AMM reserves.

## AMM pricing

For constant-product reserves `X` (input) and `Y` (output), input `A`, and
source-fixed AMM fee `f`:

```text
effective_input = floor(A * (B - f) / B)
amm_fee = A - effective_input
output = floor(Y * effective_input / (X + effective_input))
```

On a sell, `A` for price impact is net tRFL after reflection fee. On a buy,
tUSD pricing produces gross tRFL output, then the reflection fee is taken from
that gross output. Slippage protection for a buy applies to the user's net tRFL
receipt. Quotes and settlement must use identical integer arithmetic.

## Liquidity and final closure

Non-final adds/removes are proportional and respect fixed source limits. Reward
checkpoint and endpoint payout happen before share mutation.

When the requested burn equals total LP supply, the withdrawal uses the exact
current tRFL and tUSD reserves, not a proportional floor. After payout:

```text
rfl_reserve = 0
tusd_reserve = 0
custody_shares = 0
pool_global_pending = 0
active_lp_shares = 0
```

All whole LP position liabilities must already have been paid. Fractional index
residue and any non-liability whole rounding unit are classified as immutable
terminal evidence; they are never a creator-withdrawable surplus. Core and pool
lifecycles then become `CLOSED` permanently.

## Faucet

The faucet uses source-fixed grant sizes and cooldown. tRFL grants transfer
pre-minted units from the excluded distribution vault and stop when that vault
is exhausted. tUSD grants mint only the fixed amount through the capability
locked in the faucet module. No signer can change grant sizes, cooldown, pause
state, recipient accounting, or mint an arbitrary amount.

## Required transaction-boundary invariants

Every successful public mutation must preserve:

```text
fixed_tRFL_supply
  = distribution_vault
  + core_reward_vault
  + all registered wallet raw balances
  + canonical pool raw reserve
  + LP reward vault

global_total_shares
  = sum(registered wallet raw balances) + canonical custody raw units

canonical custody raw units = canonical tRFL reserve raw balance
pool global pending = 0 after every swap and final closure
```

All core and LP vault units must belong to a named liability, unallocated, or
rounding bucket. Any mismatch, unsupported store, wrong capability, wrong
signer, stale lifecycle, overflow, or under-backed payout aborts the complete
transaction.
