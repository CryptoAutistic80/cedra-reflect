# Dispatchable-hook compatibility gate

The source is compiled against CedraFramework
`01e6ceafae19b900772b343a5af8ae236401e0a8`. The hooks use Cedra's exact
dispatch signatures:

```move
withdraw<T: key>(Object<T>, u64, &TransferRef): FungibleAsset
deposit<T: key>(Object<T>, FungibleAsset, &TransferRef)
derived_balance<T: key>(Object<T>): u64
```

`hook-probe` proves those signatures locally with a real dispatchable FA. Its
tests invoke `primary_fungible_store::transfer` from a second module, verify
capability-backed raw and framework-derived balances separately, materialise an
exact amount from a frozen vault with `TransferRef`, and create/fund a secondary
store through the dispatch surface.

## Confirmed local VM constraint

The Move VM rejects a dynamic callback into a hook-owning module that is already
executing. Therefore neither `hook_probe` nor `reflection_hooks` may wrap
`primary_fungible_store::transfer` or `primary_fungible_store::balance` in the
same module. `reflection_router` is intentionally separate, and the hooks use
`primary_store_address_inlined` because Cedra documents it for dispatch paths.

The mutating hooks use `fungible_asset::withdraw_with_ref` and
`deposit_with_ref`; the integration test proves this does not recursively invoke
the hook when the original transfer entered through the framework/router path.
The ordinary `fungible_asset::balance` intentionally rejects a dispatchable FA;
raw accounting therefore uses the capability-backed accessor while user-facing
effective reads use the dispatchable/primary-store path from another module.

## Required Testnet evidence before enabling auto-materialisation

1. Publish `hook-probe` with the exact pinned framework/package build and wait
   for finality.
2. Invoke the one-time `hook_probe::initialize` entry to create the probe asset
   and register all three hooks. Cedra resolves dynamic hook functions from
   on-chain module storage, so registration is deliberately post-publication.
3. Directly call the standard primary-store transfer and standard balance query.
4. Record the transaction hash, raw balance, derived balance, and framework
   deposit/withdraw events.
5. Repeat for a primary store and a secondary store.
6. Repeat through the selected TypeScript SDK and wallet.

The finalized 2026-07-20 result selects a fresh claim-backed deployment. The
one-time post-publication initializer still registers withdrawal and deposit
hooks so standard transfers maintain exact corrections, while immutable mode
state makes the derived hook return raw balance and rejects spending pending
rewards before an explicit claim. Dispatch registration and materialization mode
have no removal or mutation API in this package version. Compatible package
upgrade authority is a separate release-policy trust boundary. The test assets
and AMM do not rely on a wallet rendering a derived balance.
