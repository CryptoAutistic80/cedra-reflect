# Dispatchable-hook compatibility gate

The source is compiled against CedraFramework
`01e6ceafae19b900772b343a5af8ae236401e0a8`. The hooks use Cedra's exact
dispatch signatures:

```move
withdraw<T: key>(Object<T>, u64, &TransferRef): FungibleAsset
deposit<T: key>(Object<T>, FungibleAsset, &TransferRef)
derived_balance<T: key>(Object<T>): u64
```

`hook-probe` proves those signatures locally with a real dispatchable FA. The
successful test invokes `primary_fungible_store::transfer` from a second module,
and verifies both the raw balance and the framework's derived-balance query.

## Confirmed local VM constraint

The Move VM rejects a dynamic callback into a hook-owning module that is already
executing. Therefore neither `hook_probe` nor `reflection_hooks` may wrap
`primary_fungible_store::transfer` or `primary_fungible_store::balance` in the
same module. `reflection_router` is intentionally separate, and the hooks use
`primary_store_address_inlined` because Cedra documents it for dispatch paths.

The mutating hooks use `fungible_asset::withdraw_with_ref` and
`deposit_with_ref`; the integration test proves this does not recursively invoke
the hook when the original transfer entered through the framework/router path.

## Required Testnet evidence before enabling auto-materialisation

1. Publish `hook-probe` with the exact pinned framework/package build.
2. Directly call the standard primary-store transfer and standard balance query.
3. Record the transaction hash, raw balance, derived balance, and framework
   deposit/withdraw events.
4. Repeat for a primary store and a secondary store.
5. Repeat through the selected TypeScript SDK and wallet.

If any result differs, retain the same vault/index accounting but use a fresh
claim-only deployment: Cedra dispatch functions are registered at asset creation
and are not treated as removable configuration. The test assets and AMM do not
rely on a wallet rendering a derived balance.
