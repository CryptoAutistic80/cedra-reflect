# Indexer and reconciliation operations

The worker is an independent, read-only accounting witness. It consumes
cursor-ordered project events and finalized chain views. It cannot sign,
submit, pause, refill, route, claim, or withdraw.

## Transaction-group discipline

Cedra assigns one ledger version to one successful transaction. Event sources
must return every normalized project event for a ledger version in the same
page; they must not split a transaction at a page boundary. The worker sorts by
`(ledger_version, event_index)`, stages a complete ledger-version group, and
commits its projection and cursor only if every cross-module receipt agrees.

This matters because privileged contract paths do not also emit ordinary
wallet hooks:

- a sell receipt supplies the seller debit; its custody event supplies the pool
  credit;
- a buy receipt supplies the buyer credit; its custody event supplies the pool
  debit;
- liquidity receipts supply the wallet side and pair with one custody mutation
  plus one LP-share mutation;
- an LP claim supplies both the LP settlement and the core wallet attachment;
- every custody route must pair in the same transaction with either an LP index
  advance or an explicit zero-share quarantine receipt;
- a first eligible wallet emits `WalletRegistered` before its position or
  balance mutation, advances the cumulative count by exactly one, and binds a
  primary store that cannot be reused by another account;
- every positive LP position, including the first owner of a fresh epoch, must
  belong to a wallet registered earlier in replay order. An LP transfer
  requires both sender and recipient registrations; a later event in the same
  transaction cannot retroactively authorize earlier LP weight;
- a complete LP-position exit may emit `LpFractionalResidueRetired` immediately
  before its share burn/transfer; the event is denominated in `10^24`-scaled
  magnified units even though its rounding-reserve field is physical tRFL base
  units; and
- an active-to-claim-only LP transition must be followed in the same
  transaction by exactly one `LpEpochTerminalDustClassified` receipt. The
  terminal receipt is applied after the share exit and before the containing
  liquidity-removal receipt. A final removal is accepted only when shutdown
  was already committed by an earlier transaction; its exact order is full
  owner share exit, active-to-claim-only transition, terminal classification,
  then `LiquidityRemoved(final_exit = true)`. That receipt clears replayed
  shutdown mode and seeded state.

Native `EligibleBalanceDebited` / `EligibleBalanceCredited` events remain the
authority for ordinary primary-store transfers. If a historical
`WalletTransfer` receipt is also present, it is validated but not applied a
second time.

## Independent arithmetic

The witness uses the contract magnitude `10^24` and signed corrections. It
derives, rather than copies from a vault:

```text
core gross = floor((global_shares * core_index + aggregate_correction) / 10^24)
core liability = core gross - wallet_materialized - custody_routed
core vault = lifetime_fees - wallet_materialized - custody_routed
core vault = core liability + unallocated_fees + rounding_reserve

LP gross[e] = floor((LP_shares[e] * LP_index[e] + LP_correction[e]) / 10^24)
LP liability[e] = LP gross[e] - LP_claimed[e]
LP vault[e] = LP_received[e] - LP_claimed[e]
LP vault[e] = LP liability[e] + LP_unallocated[e] + LP_rounding[e]
```

It also requires `pool_tRFL_reserve == raw_custody_store_balance ==
custody_shares`, and compares every epoch vault independently. Compensating
mutations across two vaults therefore cannot hide a mismatch.

Every multiplication, addition, subtraction, and signed-correction
application corresponding to Move `u256` arithmetic validates its operands
and result at that exact step. JavaScript `bigint` is never allowed to pass
through an out-of-range intermediate merely because a later operation would
produce an in-range stored field. Transaction-end core and LP correction sums
are accumulated in deterministic map order with the same SignedU256 magnitude
bound at every addition; a later cancellation cannot excuse an earlier
overflow.

## Finalized view adapter

At one ledger version, populate `ObservedAccountingSnapshot` from the core
global/correction/custody views, the exact `custody_registry::adapter_id` and
`custody_registry::active_route` views, pool reserve views, and each event-known
LP epoch/owner using:

- `reflection_token::wallet_position_accounting`;
- `reflection_token::registered_wallet_count` and
  `reflection_token::wallet_is_registered` for every replay-known account;
- `reflection_token::custody_position_accounting`;
- `custody_registry::adapter_id`;
- `custody_registry::active_route`;
- `pool::limits`;
- `pool::liquidity_limits`;
- `lp_rewards::epoch_accounting`;
- `lp_rewards::epoch_identity`;
- `lp_rewards::epoch_aggregate_correction`;
- `lp_rewards::position_accounting`;
- `pool::lp_epoch_terminal_dust` for every event-known epoch;
- `reflection_token::operational_admin`;
- `test_faucet::configuration`;
- `test_faucet::operational_admin`;
- `test_faucet::paused`; and
- `pool::operational_admin`.

Convert Move's `(negative, magnitude)` correction pair to a TypeScript signed
`bigint`. Epoch and owner enumeration comes from replayed events; no privileged
table scan is required.

Keep terminal units separate: `pool::lp_epoch_terminal_dust(epoch)` returns
`(u128 terminal_rounding_base_units, u256 retired_residue_magnified)`. Compare
both values exactly against replay. For an active epoch, the terminal rounding
view is expected to remain zero; for a claim-only epoch it must equal the
event-classified rounding reserve. Wallet reconciliation compares the finalized
registered count and per-account registration booleans with the replayed set.
The account-to-primary-store address remains authenticated by the canonical
`WalletRegistered` event because the contract does not expose a store-address
enumeration view.

A shutdown liquidity removal may have exactly one proportional asset output
equal to zero, including on a non-final exit. Outside shutdown both outputs
must be positive, and in every mode a both-zero output is invalid. The witness
still requires the exact proportional-floor amounts, the LP-share burn, and a
custody receipt exactly when the tRFL output is non-zero.

Outside shutdown, a non-final withdrawal must also satisfy the event-replayed
`maximumNonFinalWithdrawalShareBps` ratio exactly:
`shares * 10_000 <= total_active_shares * configured_bps`. Equality is valid;
one share beyond it is rejected. Prior shutdown bypasses this ratio so every
LP can unwind, but does not relax proportional-output or receipt checks.

Both independent inputs must prove Cedra Testnet chain identity. Every
`EventPage` must report the finalized ledger header's `chainId: 2`, and every
`ObservedAccountingSnapshot` must independently report `chainId: 2` at the
exact replay cursor ledger version. A wrong-chain event page is rejected before
replay; a wrong-chain view snapshot is a critical deployment-identity mismatch.
The chain ID is retained in every durable projection and checkpoint.

Replay every module-qualified `OperationalAdminChanged` event. The old address
must continue the prior evented value and the new address must be non-zero.
After package initialization, a core handoff is accepted only if the new
account has a permanent primary-store exclusion. Faucet and AMM handoffs must
then appoint that exact core operator. The first appointment of an operations
account emits `OperationalPrimaryStoreExcluded`; replay records it without
decrementing the two finite publisher-bootstrap exclusion slots. All three
resulting addresses must match their on-chain views at the same ledger version.
An authority or exclusion mismatch is critical even though it does not change
economic accounting.

Initialization history is not optional: core, faucet, and AMM must each have an
evented operational-admin chain. `deploymentReady` becomes true only after all
three histories are present. A missing history remains a critical authority
alert even when a current view happens to return a plausible address, and the
worker must not write a clean checkpoint while deployment readiness is false.

The preferred `pool::set_all_operational_admin` transaction emits the core,
faucet, and AMM authority changes atomically after any new exclusion event. The
reducer applies them in event order and commits the ledger version only when all
three chains align. Individual package handoffs are recovery-only and must
still satisfy the same replayed exclusion and core-alignment rules.

## Cursor, snapshot, and incident handling

1. Restore the newest trusted snapshot before polling.
2. Poll strictly after its cursor and retain complete transaction groups.
3. Snapshot only after exact-ledger reconciliation has zero alerts and
   `deploymentReady` is true; never checkpoint a merely processed batch.
4. Keep the snapshot beside its release manifest and finalized ledger version.
5. Recovery must restore into a fresh worker and skip overlapping events once.

Runtime replay and snapshot decode enforce the original Move widths on every
numeric field: event identity, timestamps, cursors and configuration are
`u64`; wallet amounts and pool reserves are `u64`; global/LP shares and
rounding buckets are `u128`; indexes, cumulative accounting and magnified
residue are `u256`; signed corrections may have at most a `u256` magnitude.
Exactly `2^64`, `2^128`, or `2^256` is invalid for its respective domain.
Snapshots additionally require complete one-to-one `rewardVaultToEpoch` and
`stateIdToEpoch` indexes for every LP epoch, with exactly one active-status
epoch when `activeLpEpoch` is present and none when it is absent.
Every positive LP position in a snapshot must also have an exact registered
wallet account binding. Finalized reconciliation repeats this independently
for both event-replayed LP positions and the positions returned by chain views,
using the corresponding replayed and finalized registered-account sets.

`FileIndexerStore` serializes the complete restore/poll/reconcile/checkpoint
cycle with `indexer-writer.lock`. Snapshot and alert read-modify-write updates
also use per-file exclusive locks, and snapshots must move monotonically by
the consensus cursor; reusing a cursor with different projection state is
rejected. Wall-clock rollback never overrides cursor order. Lock contention
fails closed; it is not a retry or leadership signal. After a crash, remove a stale lock only after proving that
the recorded writer process is no longer alive and that no replacement worker
has started. The durable directory and files must remain owner-only (`0700`
and `0600`) on systems that expose POSIX permissions.

Every durable snapshot or alert mutation additionally requires the exact
runtime lease token issued to that `FileIndexerStore` instance. Tokens from a
different instance, expired tokens, and calls outside a lease fail closed. A
checkpoint also names the snapshot ID from which its indexer restored; even a
higher cursor is rejected when the durable base changed meanwhile. Production
callers must therefore use `IndexerWorker.runOnce()` or wrap the entire
restore/poll/reconcile/checkpoint sequence in
`EventIndexer.withExclusiveStoreWriter()`. The callback receives an explicit
writer-cycle capability whose methods alone close over that cycle's lease;
there is no ambient lease for another asynchronous call to inherit. A second
cycle or unrelated direct state mutation fails before polling or writing, and
an expired capability cannot be reused. Per-method implicit leases exist only
for `InMemoryIndexerStore` test ergonomics.

Every mismatch is critical. A divergent transaction is rejected without
advancing the cursor. Preserve the first alert and snapshot, then follow
`ops/INCIDENT_RESPONSE.md`; this witness records evidence but never performs an
emergency mutation.

Construct `CedraEventNormalizer` only from the exact core, asset, and AMM
addresses in the approved release manifest. It rejects same-named events from
any other address, zero or canonically duplicate package addresses, and
initialization schemas other than version `1`. Never infer provenance from a
module/event suffix.
