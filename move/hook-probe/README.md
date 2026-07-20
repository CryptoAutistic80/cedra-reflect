# Dispatchable hook probe

This is Phase 0's on-chain compatibility probe. It registers the three Cedra
dispatch functions and uses `TransferRef` inside the mutating hooks, so a
successful framework primary-store transfer demonstrates non-recursive hook
settlement.

The package pins CedraFramework commit
`01e6ceafae19b900772b343a5af8ae236401e0a8`, the exact `mainnet`-branch
framework revision inspected and compiled for this repository. Before Testnet use,
publish this package independently and record the metadata address, transaction
hashes for a primary-store transfer, raw/derived balance reads, and framework
events. The derived-balance hook is intentionally read-only; queries cannot
emit events or increment counters.

Do not wrap `primary_fungible_store::transfer` in the same module that owns a
registered hook: the Move VM rejects the dynamic callback as module re-entry.
Wallet-to-wallet transfers must invoke Cedra's primary-store transfer directly,
or be invoked from a separate adapter module. The test intentionally exercises
the direct framework path from a second module.
