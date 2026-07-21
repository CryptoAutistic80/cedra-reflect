# tRFL wallet and canonical-LP accounting

`tRFL` is capped at `1_000_000_000_000_000` base units at creation. Its sole
`MintRef` is consumed during initialization and is not stored. All later tRFL
distribution moves pre-minted tokens out of the frozen distribution vault.
Token/store/reserve amounts are `u64`, LP shares and share totals are `u128`,
and magnified index/correction/lifetime arithmetic is bounded to `u256`.

## Store classification

The frozen core reward vault, distribution vault, every LP reward vault,
package-publisher primary stores, and every current or former operations
primary store are excluded from the global reward denominator. Direct dispatch
deposits to those stores abort.

The canonical AMM tRFL reserve is also dispatch-excluded, so users cannot
bypass settlement, but its raw units are represented exactly once by the
core's canonical custody position. It is therefore globally reward-eligible
without being misclassified as a wallet. The required identity is:

```text
global total shares = registered-wallet raw tRFL + canonical custody raw tRFL
canonical custody raw tRFL = physical raw pool reserve
```

Wallet eligibility is limited to registered primary stores. Faucet receipt,
buy settlement, LP-reward payout, and liquidity withdrawal register the signer
atomically. Other secondary, contract, escrow, or delegated-custody stores fail
closed. If an account-controlled vault uses its controller's canonical primary
store, it accrues only as that one wallet address; the core cannot identify or
apportion the entitlement among depositors. The canonical pool is the only
supported custody adapter with beneficial-owner passthrough in the initial
release.
First registration emits exactly one
`WalletRegistered { account, primary_store, registered_wallet_count }`; repeat
explicit registration and later implicit receipt paths are event-idempotent.

## Authority and role neutrality

Routine controls are assigned with the preferred four-signer entry
`pool::set_all_operational_admin(core_publisher, assets_publisher, amm_publisher,
new_operational_admin)`. It invokes the core, faucet, and AMM authenticated
handoffs in one transaction and asserts that all three resulting authority
views agree. Any failed publisher or candidate check aborts and rolls back the
whole transaction. The individual package handoffs remain recovery-only
surfaces.

The new operations profile must be nonzero, distinct from all three package
publishers, unregistered as a tRFL wallet, and have a zero tRFL primary-store
balance. Core classifies that primary store as permanently excluded and emits
`OperationalPrimaryStoreExcluded { account, store }`. This classification does
not consume either one-time publisher exclusion slot, and rotation never
removes an old operations exclusion.

Operations profiles cannot register, receive or claim tRFL, seed or add
liquidity, or receive LP shares. The LP registry also records every address
that ever acquires LP shares through mint or transfer. That O(1) history is
permanent: active shares may be zero and an old epoch may contain only residual
entitlement, but the address still cannot become operations. This conservative
separation prevents an authority key from sharing in the value affected by its
own fee, pause, limit, and shutdown decisions.

## Core O(1) index

For a taxable gross amount `G`, the core computes:

```text
fee = floor(G * fee_bps / 10_000)
net = G - fee
```

The physical fee reaches the core reward vault before `index` advances. With
`M = 10^24`, `S = total_shares`, and carried `R`:

```text
numerator = fee * M + R
index += floor(numerator / S)
R = numerator mod S
```

Every wallet position and the canonical custody position stores a signed
magnified correction plus a whole-unit settled amount. Adding shares at index
`I` subtracts `amount * I` from correction; removing them adds it. That
preserves pre-mutation entitlement and prevents new units from receiving
historical rewards without iterating over holders.

The O(1) aggregate core liability is:

```text
gross = floor(apply_signed(total_shares * index, aggregate_correction) / M)
core indexed liability = gross - wallet_materialized - custody_routed

core reward vault
  = core indexed liability + unallocated fees + core rounding reserve
```

The rounding reserve is recomputed from the physical vault balance after every
index advance. No whole base unit is left in an unnamed surplus.

## Canonical custody checkpoint and LP index

The pool's accrued global reward is not deposited into its AMM reserve. A
checkpoint instead moves the whole pending amount `X` from the core reward
vault into the active epoch's frozen LP reward vault and marks the custody
position settled:

```text
core vault -= X
custody pending -= X
LP vault += X
pool raw reserve unchanged
global shares and corrections unchanged
```

The AMM then advances a second O(1) index across the LP shares that existed
before the checkpoint. LP mint, burn, and module-mediated transfer use the same
signed-correction rules. Newly minted or received shares get no historical
reward; burned or transferred shares retain all pre-mutation entitlement.

For an LP epoch:

```text
gross = floor(apply_signed(total_lp_shares * lp_index, aggregate_correction) / M)
LP indexed liability = gross - lifetime_lp_claimed

LP reward vault
  = LP indexed liability + unallocated LP rewards + LP rounding reserve
  = lifetime_received - lifetime_claimed
```

An LP claim removes tRFL from that epoch's vault and adds it to the claimant's
registered wallet at the current global index. It can earn future global fees
but none collected before the claim.

LP shares are module-accounted positions, not freely transferable Fungible
Assets. The initial transfer path is signer-authorized and checkpoints before
changing ownership. Secondary-store and external-vault LP custody therefore
cannot silently acquire reward weight.

Initial `seed_liquidity` and later `reseed_liquidity` require the LP beneficiary
as a signer in addition to the core and AMM publishers. The beneficiary's
authenticated address, rather than a payload address, receives every bootstrap
share. The normal wallet-registration, exclusion, publisher, operations, and
LP-history recording rules still apply before those shares are minted.

## Settlement ordering

The publishable Testnet mode is immutable claim-backed mode. Sell ordering is:
require enough raw wallet balance; remove the seller's gross wallet shares;
place the fee in the core vault; advance the global index over
the seller remainder plus pre-trade custody; then add only net input to the raw
pool reserve and custody shares. New reserve units do not receive their own
fee.

Buy ordering is: remove gross output from raw reserve and custody shares; place
the reflection fee in the core vault; advance the index over post-withdraw
custody and pre-existing wallets; then add net output to the buyer at the new
index. Neither withdrawn pool units nor newly purchased units receive that
fee.

AMM fees are bounded to `0..100 bps` (default `30`). Gross input is bounded by
both `max_gross_swap` and `max_reserve_bps` of the input reserve (defaults
`100_000_000_000` base units and `2_000 bps`); gross output is checked against
the same reserve-percentage cap.

Liquidity is untaxed. Before mint, burn, transfer, or active-epoch claim, the
pool routes custody pending into the pre-mutation LP index. Wallet-to-custody
and custody-to-wallet movements apply equal-and-opposite corrections at one
global index, preserving all prior entitlement.

Before a burn or transfer reduces an owner to zero LP shares, every whole
pending LP unit is paid to that signer. If such a payout is needed while LP
claims are paused, the transaction aborts atomically. The zero-share correction
is then normalized to `claimed * M`: only the remaining fraction below `M` is
subtracted from both owner and aggregate corrections. Combined fractions that
become whole physical units are reclassified as rounding reserve, never paid to
the admin, last LP, recipient, or a later epoch.

Shutdown cannot begin while LP claims are paused. The preflight occurs before
any pause/shutdown mutation because pause configuration is locked after
shutdown begins and a later full exit may require the payout above. During
shutdown, every non-final burn bypasses the operator withdrawal-share cap. A
proportional removal may have exactly one output floor to zero; the nonzero side
is settled independently, both-zero is rejected, and both user minima remain
binding. Normal-operation removals retain the conservative requirement that
both outputs are positive.

## Epoch lifecycle

Final reserve exit requires explicit shutdown. The pool checkpoints the active
epoch, auto-pays the final owner's whole claim, burns the shares, returns every
residual reserve unit, and proves raw reserve, custody shares, custody pending,
LP indexed liability, and LP unallocated rewards are zero. It freezes the old
vault's exact remaining balance as terminal rounding dust before the epoch
becomes claim-only. Reseeding creates a fresh epoch, position table, and reward
vault; the custody route can rotate only at the zero-reserve, zero-custody,
zero-pending boundary. At that boundary, the route opener normalizes the old
zero-share custody correction to `lifetime_custody_routed * M`, subtracts only
the exact sub-base-unit residue from custody and aggregate corrections,
recomputes core rounding, and emits the residue in
`CustodyEpochRouteOpened` before any fresh reserve shares enter.

An unexpected reward with zero LP supply is named as unallocated and
quarantines that epoch rather than gifting history to future LPs. Such an epoch
cannot close normally. A claim against entitlement indexed before quarantine
skips active checkpointing and remains payable; the quarantined receipt itself
never enters the index. A normally retired epoch has zero liability and
unallocated value; its terminal dust stays named and backed in the old immutable
vault and is never swept or carried into a fresh epoch.

The terminal replay surface is:

```text
LpFractionalResidueRetired(epoch, owner, residue_magnified,
  cumulative_retired_residue_magnified, rounding_reserve_base_units)
LpEpochTerminalDustClassified(epoch, reward_vault,
  terminal_rounding_base_units, retired_residue_magnified,
  lifetime_received_base_units, lifetime_claimed_base_units)
pool::lp_epoch_terminal_dust(epoch)
  -> (terminal_rounding_base_units: u128, retired_residue_magnified: u256)
```

The existing `lp_epoch_accounting` tuple is unchanged.

## Replay invariants

- Core and every LP reward vault satisfy their exact three-bucket identity.
- The combined vault balance equals collected fees minus wallet and LP payouts.
- Wallet transfers are untaxed and preserve total effective value.
- The pool has one custody entitlement and no wallet entitlement.
- Pool raw reserve equals custody shares after every completed operation.
- Custody checkpoint and LP claim never change raw reserves, quotes, or `x * y`.
- LP share mint, burn, and transfer cannot acquire historical rewards.
- A zero-share LP position has correction exactly `claimed * M`.
- A claim-only epoch has zero indexed liability/unallocated value and its vault
  equals immutable terminal rounding dust.
- Zero active LP shares normally implies zero pool reserve, custody shares, and
  custody pending. A quarantined defense receipt is the explicit exception: it
  has named unallocated value, zero custody pending, and frozen mutation.
- Shutdown entry requires LP claims live. Shutdown burns ignore the operator
  withdrawal cap, reject both-zero output, and enforce both caller minima.
- Direct reserve, custody-route, LP-share, and LP-vault bypasses fail closed.
