# Testnet pilot evidence gates

Local tests establish determinism; the following gates require independently
recorded finalized Testnet evidence before the public beta can be called
complete. Do not replace them with simulated results.

| Gate | Target | Authoritative evidence |
|---|---:|---|
| Reference-model operations | >= 1,000,000 | Reproducible test seed and successful full-gate report |
| On-chain synthetic transactions | >= 50,000 | Indexed finalized transaction ledger range |
| Completed swaps | >= 10,000 | Reconciled `SwapExecuted` events |
| Distinct holders | >= 1,000 | Indexed unique eligible position addresses |
| Distinct LP positions | >= 100 | Indexed unique LP owner/epoch positions |
| Liquidity add/remove operations | >= 1,000 | Reconciled `LiquidityAdded` and `LiquidityRemoved` events |
| Accounting reconciliation | 100% | Reconciler snapshots with zero unexplained discrepancy |
| Wallet/custody/LP allocation reconciliation | 100% | Position, custody, and LP epoch replay against same-version views |
| Combined core and LP vault discrepancy | 0 base units | Per-vault and combined on-chain balance vs computed liability comparison |
| Unnamed reward-vault units | 0 base units | Indexed liability plus unallocated plus rounding partition |
| Raw reserve/custody discrepancy | 0 base units | Raw accessor, AMM reserve, and custody-share comparison |
| Overallocated rewards | 0 base units | Model/indexer liability check |
| Direct pool bypasses | 0 successful | Negative test transactions and event audit |
| Direct LP-share or LP-vault bypasses | 0 successful | Negative test transactions and event audit |
| Unauthorized custody adapters | 0 successful | Registration/route authorization failures and event audit |
| Unauthorized admin actions | 0 successful | Negative authorization tests |
| Fresh deployment rehearsal | >= 1 | Trusted snapshot plus restoration reconciliation |
| Indexer recovery | demonstrated | Old-cursor restart record matching head snapshot |
| High/critical findings | 0 unresolved | Dated independent-review and issue disposition record |

The public beta and final Testnet completion require every row. Until live
evidence exists, the repository is a mainnet-candidate codebase and an
operator-ready Testnet pilot, not a deployed pilot.
