# tRFL wallet and canonical-LP accounting

`tRFL` is capped at `1_000_000_000_000_000` base units at creation. Its sole
`MintRef` is consumed during initialization and is not stored. All later tRFL
distribution moves pre-minted tokens out of the frozen distribution vault.

## Store classification

The frozen core reward vault, distribution vault, every LP reward vault, and
operator primary stores are excluded from the global reward denominator.
Direct dispatch deposits to those stores abort.

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
closed. The canonical pool is the only supported custody adapter in the initial release.

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

## Settlement ordering

Sell ordering is: materialize any wallet shortfall; remove the seller's gross
wallet shares; place the fee in the core vault; advance the global index over
the seller remainder plus pre-trade custody; then add only net input to the raw
pool reserve and custody shares. New reserve units do not receive their own
fee.

Buy ordering is: remove gross output from raw reserve and custody shares; place
the reflection fee in the core vault; advance the index over post-withdraw
custody and pre-existing wallets; then add net output to the buyer at the new
index. Neither withdrawn pool units nor newly purchased units receive that
fee.

Liquidity is untaxed. Before mint, burn, transfer, or active-epoch claim, the
pool routes custody pending into the pre-mutation LP index. Wallet-to-custody
and custody-to-wallet movements apply equal-and-opposite corrections at one
global index, preserving all prior entitlement.

## Epoch lifecycle

Final reserve exit requires explicit shutdown. The pool checkpoints the active
epoch, burns the final owned LP shares, returns every residual reserve unit,
and proves raw reserve, custody shares, and custody pending are zero. The old
epoch becomes claim-only: its existing zero-share positions can claim, but its
index and share ledger cannot mutate. Reseeding creates a fresh epoch, position
table, and reward vault; the custody route can rotate only at the zero-reserve,
zero-custody, zero-pending boundary.

An unexpected reward with zero LP supply is named as unallocated and
quarantines that epoch rather than gifting history to future LPs. A retired
epoch remains permanently claim-only. Legitimate sub-base-unit position
fractions can combine into aggregate liability even when no individual has a
whole base unit to claim, so that residue stays named and backed in the old
immutable vault; it is never swept or carried into a fresh epoch.

## Replay invariants

- Core and every LP reward vault satisfy their exact three-bucket identity.
- The combined vault balance equals collected fees minus wallet and LP payouts.
- Wallet transfers are untaxed and preserve total effective value.
- The pool has one custody entitlement and no wallet entitlement.
- Pool raw reserve equals custody shares after every completed operation.
- Custody checkpoint and LP claim never change raw reserves, quotes, or `x * y`.
- LP share mint, burn, and transfer cannot acquire historical rewards.
- Zero active LP shares implies zero pool reserve, custody shares, and custody pending.
- Direct reserve, custody-route, LP-share, and LP-vault bypasses fail closed.
