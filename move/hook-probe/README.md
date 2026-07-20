# Dispatchable hook probe

This is Phase 0's on-chain compatibility probe. It registers the three Cedra
dispatch functions and uses `TransferRef` inside the mutating hooks, so a
successful framework primary-store transfer demonstrates non-recursive hook
settlement.

The package pins CedraFramework commit
`01e6ceafae19b900772b343a5af8ae236401e0a8`, the exact `mainnet`-branch
framework revision inspected and compiled for this repository. Before Testnet use,
publish this package independently and record the metadata and frozen probe-vault
addresses, transaction hashes for a primary-store transfer, exact reference
materialisation, secondary-store funding, raw/derived balance reads, and framework
events. The derived-balance hook is intentionally read-only; queries cannot
emit events or increment counters.

Do not wrap `primary_fungible_store::transfer` in the same module that owns a
registered hook: the Move VM rejects the dynamic callback as module re-entry.
The same constraint applies to derived-balance wrappers. Wallet-to-wallet
transfers and effective-balance reads must invoke the framework directly or use
the separate `probe_driver` module. The tests intentionally exercise those
paths outside the hook-owning module.
