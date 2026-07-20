# Fresh-deployment recovery rehearsal

1. Save a trusted signed snapshot and release manifest. Never infer allocations
   from a partial event stream.
2. Deploy a new fixed-supply test instance with a new deployment identifier.
3. Rehearse a clean new deployment first. The current contracts deliberately
   expose no migration, arbitrary restoration grant, forced balance, or state
   conversion surface.
4. If a later pilot explicitly requires snapshot-derived allocations, design a
   separate finite claim distributor with a committed Merkle root, total cap,
   expiry, duplicate-claim protection, and independent review. Never add a
   privileged balance editor to the token and never describe an unimplemented
   distributor as available recovery machinery.
5. Seed the new controlled pool from its own fixed distribution vault and
   reconcile its supply, both reward-vault layers, reserve/custody equality,
   and fresh zero-history positions. Snapshot values are comparison evidence,
   not authority to mutate the new instance.
6. Test indexer recovery from a deliberately old cursor, then publish the new
   addresses and no-value warning.
