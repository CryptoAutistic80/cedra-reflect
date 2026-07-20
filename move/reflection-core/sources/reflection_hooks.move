/// Thin, stable dispatch surface. Keep these signatures unchanged across
/// accounting lives in reflection_token.
module reflection_core::reflection_hooks {
    use cedra_framework::fungible_asset::{FungibleAsset, TransferRef};
    use cedra_framework::object::Object;
    use reflection_core::reflection_token;

    public fun withdraw_hook<T: key>(store: Object<T>, amount: u64, transfer_ref: &TransferRef): FungibleAsset {
        reflection_token::withdraw_hook_impl(store, amount, transfer_ref)
    }

    public fun deposit_hook<T: key>(store: Object<T>, asset: FungibleAsset, transfer_ref: &TransferRef) {
        reflection_token::deposit_hook_impl(store, asset, transfer_ref)
    }

    public fun derived_balance_hook<T: key>(store: Object<T>): u64 {
        reflection_token::derived_balance_hook_impl(store)
    }
}
