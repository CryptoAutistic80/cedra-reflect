/// External driver for hook experiments that must originate outside the
/// hook-owning module. It exists only in the isolated compatibility package.
module hook_probe::probe_driver {
    use cedra_framework::dispatchable_fungible_asset;
    use cedra_framework::event;
    use cedra_framework::fungible_asset::{Self, FungibleStore};
    use cedra_framework::object;
    use cedra_framework::primary_fungible_store;
    use hook_probe::hook_probe;
    use std::signer;

    const E_ZERO_AMOUNT: u64 = 1;
    const SECONDARY_STORE_SEED: vector<u8> = b"reflection-hook-probe-secondary-v1";

    #[event]
    struct SecondaryStoreFunded has drop, store {
        owner: address,
        store: address,
        amount: u64,
        raw_balance: u64,
        derived_balance: u64,
    }

    /// H6 probe: create an account-owned secondary FA store and route a normal
    /// dispatchable withdrawal/deposit into it from outside the hook module.
    public entry fun create_and_fund_secondary(owner: &signer, amount: u64) {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let constructor = object::create_named_object(owner, SECONDARY_STORE_SEED);
        let store = fungible_asset::create_store(&constructor, hook_probe::metadata());
        let asset = primary_fungible_store::withdraw(
            owner, hook_probe::metadata(), amount,
        );
        dispatchable_fungible_asset::deposit(store, asset);
        event::emit(SecondaryStoreFunded {
            owner: signer::address_of(owner),
            store: object::object_address(&store),
            amount,
            raw_balance: hook_probe::raw_store_balance(
                object::object_address(&store),
            ),
            derived_balance: dispatchable_fungible_asset::derived_balance(store),
        });
    }

    #[view]
    public fun secondary_store(owner: address): address {
        object::create_object_address(&owner, SECONDARY_STORE_SEED)
    }

    #[view]
    public fun primary_derived_balance(owner: address): u64 {
        primary_fungible_store::balance(owner, hook_probe::metadata())
    }

    #[view]
    public fun secondary_raw_balance(owner: address): u64 {
        hook_probe::raw_store_balance(secondary_store(owner))
    }

    #[view]
    public fun secondary_derived_balance(owner: address): u64 {
        let store = object::address_to_object<FungibleStore>(secondary_store(owner));
        dispatchable_fungible_asset::derived_balance(store)
    }
}
