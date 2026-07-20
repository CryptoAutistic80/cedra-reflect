# Incident response

The primary emergency action is **pause swaps**. Do not pause ordinary wallet
transfers or claims unless the specific accounting defect requires it.

1. Pause the canonical pool using the separate operational key.
2. Record the finalized ledger version and package version.
3. Snapshot global state, position/correction state, vault stores, pool reserves
   and the indexer cursor.
4. Stop faucet grants.
5. Reconcile events from the last trusted snapshot through that ledger version.
6. Identify and preserve the first divergent transaction; do not repair state
   with a privileged balance-edit function.
7. Publish the affected version and reproducible transaction sequence.
8. Prepare and review a corrected package, then use a clean deployment and
   snapshot-governed restoration if contract state must change.
9. Rerun deterministic recovery tests and require zero unexplained discrepancy.
10. Resume swaps only after a second approver accepts the evidence.

If user assets or the reward vault disagree with the accounting witness, the
pilot remains paused. There is intentionally no `force_set_balance` escape
hatch.
