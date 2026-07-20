# Fresh-deployment recovery rehearsal

1. Save a trusted signed snapshot and release manifest. Never infer allocations
   from a partial event stream.
2. Deploy a new fixed-supply test instance with a new deployment identifier.
3. Rehydrate allocations only from the trusted snapshot and log every grant as
   a restoration event; do not manually invent balances.
4. Seed the controlled pool and compare restored supply, vault backing and
   aggregate pending rewards to the snapshot.
5. Test indexer recovery from a deliberately old cursor, then publish the new
   addresses and no-value warning.
