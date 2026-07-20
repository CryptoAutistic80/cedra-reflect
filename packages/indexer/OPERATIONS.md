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
  advance or an explicit zero-share quarantine receipt.

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

## Finalized view adapter

At one ledger version, populate `ObservedAccountingSnapshot` from the core
global/correction/custody views, the exact `custody_registry::adapter_id` and
`custody_registry::active_route` views, pool reserve views, and each event-known
LP epoch/owner using:

- `reflection_token::wallet_position_accounting`;
- `reflection_token::custody_position_accounting`;
- `custody_registry::adapter_id`;
- `custody_registry::active_route`;
- `pool::liquidity_limits`;
- `lp_rewards::epoch_accounting`;
- `lp_rewards::epoch_identity`;
- `lp_rewards::epoch_aggregate_correction`;
- `lp_rewards::position_accounting`.
- `reflection_token::operational_admin`;
- `test_faucet::operational_admin`; and
- `pool::operational_admin`.

Convert Move's `(negative, magnitude)` correction pair to a TypeScript signed
`bigint`. Epoch and owner enumeration comes from replayed events; no privileged
table scan is required.

Replay every module-qualified `OperationalAdminChanged` event. The old address
must continue the prior evented value, the new address must be non-zero, and
the three resulting addresses must match their on-chain views at the same
ledger version. An authority mismatch is critical even though it does not
change economic accounting.

## Cursor, snapshot, and incident handling

1. Restore the newest trusted snapshot before polling.
2. Poll strictly after its cursor and retain complete transaction groups.
3. Snapshot after every bounded batch and before incident work.
4. Keep the snapshot beside its release manifest and finalized ledger version.
5. Recovery must restore into a fresh worker and skip overlapping events once.

Every mismatch is critical. A divergent transaction is rejected without
advancing the cursor. Preserve the first alert and snapshot, then follow
`ops/INCIDENT_RESPONSE.md`; this witness records evidence but never performs an
emergency mutation.
