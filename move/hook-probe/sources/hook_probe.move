/// Dispatchable-Fungible-Asset compatibility probe.
///
/// This package deliberately has no reflection logic.  It establishes the exact
/// Cedra hook surface used by reflection-core before a Testnet deployment is
/// authorised: withdraw, deposit, and derived-balance dispatch all use the
/// framework's documented signatures and bypass recursion with TransferRef.
module hook_probe::hook_probe {
    use cedra_framework::dispatchable_fungible_asset;
    use cedra_framework::function_info;
    use cedra_framework::event;
    use cedra_framework::fungible_asset::{Self, FungibleAsset, FungibleStore, Metadata, RawBalanceRef, TransferRef};
    use cedra_framework::object::{Self, Object};
    use cedra_framework::primary_fungible_store;
    use std::option;
    use std::signer;
    use std::string;

    const E_NOT_ADMIN: u64 = 1;
    const E_ZERO_AMOUNT: u64 = 2;
    const SUPPLY: u64 = 1_000_000_000_000;
    const VAULT_ALLOCATION: u64 = 1_000_000;
    const SEED: vector<u8> = b"reflection-hook-probe-v1";
    const VAULT_SEED: vector<u8> = b"reflection-hook-probe-vault-v1";

    struct ProbeState has key {
        admin: address,
        metadata: Object<Metadata>,
        transfer_ref: TransferRef,
        raw_balance_ref: RawBalanceRef,
        reward_vault: Object<FungibleStore>,
    }

    #[event]
    struct ProbeInitialized has drop, store {
        metadata: address,
        supply: u64,
        reward_vault: address,
        vault_allocation: u64,
    }

    #[event]
    struct ProbeRewardMaterialized has drop, store {
        recipient: address,
        amount: u64,
        vault_balance: u64,
    }

    fun init_module(admin: &signer) {
        let constructor_ref = object::create_named_object(admin, SEED);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &constructor_ref,
            option::some(SUPPLY as u128),
            string::utf8(b"Reflection Hook Probe"),
            string::utf8(b"hRFL"),
            6,
            string::utf8(b"https://example.invalid/reflection-hook-probe"),
            string::utf8(b"https://example.invalid"),
        );
        dispatchable_fungible_asset::register_dispatch_functions(
            &constructor_ref,
            option::some(function_info::new_function_info(
                admin,
                string::utf8(b"hook_probe"),
                string::utf8(b"withdraw_hook"),
            )),
            option::some(function_info::new_function_info(
                admin,
                string::utf8(b"hook_probe"),
                string::utf8(b"deposit_hook"),
            )),
            option::some(function_info::new_function_info(
                admin,
                string::utf8(b"hook_probe"),
                string::utf8(b"derived_balance_hook"),
            )),
        );
        let mint_ref = fungible_asset::generate_mint_ref(&constructor_ref);
        let transfer_ref = fungible_asset::generate_transfer_ref(&constructor_ref);
        let raw_balance_ref = fungible_asset::generate_raw_balance_ref(&constructor_ref);
        let metadata = fungible_asset::mint_ref_metadata(&mint_ref);
        let metadata_address = object::object_address(&metadata);
        let vault_constructor = object::create_named_object(admin, VAULT_SEED);
        let reward_vault = fungible_asset::create_store(&vault_constructor, metadata);
        fungible_asset::set_frozen_flag(&transfer_ref, reward_vault, true);
        let vault_asset = fungible_asset::mint(&mint_ref, VAULT_ALLOCATION);
        fungible_asset::deposit_with_ref(&transfer_ref, reward_vault, vault_asset);
        primary_fungible_store::mint(
            &mint_ref,
            signer::address_of(admin),
            SUPPLY - VAULT_ALLOCATION,
        );
        move_to(admin, ProbeState {
            admin: signer::address_of(admin),
            metadata,
            transfer_ref,
            raw_balance_ref,
            reward_vault,
        });
        event::emit(ProbeInitialized {
            metadata: metadata_address,
            supply: SUPPLY,
            reward_vault: object::object_address(&reward_vault),
            vault_allocation: VAULT_ALLOCATION,
        });
    }

    /// Exact signature checked by Cedra's dispatch-function registration.
    public fun withdraw_hook<T: key>(
        store: Object<T>,
        amount: u64,
        transfer_ref: &TransferRef,
    ): FungibleAsset {
        fungible_asset::withdraw_with_ref(transfer_ref, store, amount)
    }

    /// Exact signature checked by Cedra's dispatch-function registration.
    public fun deposit_hook<T: key>(
        store: Object<T>,
        asset: FungibleAsset,
        transfer_ref: &TransferRef,
    ) {
        fungible_asset::deposit_with_ref(transfer_ref, store, asset);
    }

    /// A view hook must not mutate state, so query observability is provided by
    /// the regular view endpoint and the withdraw/deposit module events.
    public fun derived_balance_hook<T: key>(store: Object<T>): u64 acquires ProbeState {
        let state = borrow_global<ProbeState>(@hook_probe);
        fungible_asset::balance_with_ref(&state.raw_balance_ref, store)
    }

    #[view]
    public fun metadata(): Object<Metadata> acquires ProbeState {
        borrow_global<ProbeState>(@hook_probe).metadata
    }

    #[view]
    public fun raw_balance(account: address): u64 acquires ProbeState {
        let state = borrow_global<ProbeState>(@hook_probe);
        let store = primary_fungible_store::primary_store(account, state.metadata);
        fungible_asset::balance_with_ref(&state.raw_balance_ref, store)
    }

    #[view]
    public fun raw_store_balance(store: address): u64 acquires ProbeState {
        let state = borrow_global<ProbeState>(@hook_probe);
        fungible_asset::balance_with_ref(
            &state.raw_balance_ref,
            object::address_to_object<FungibleStore>(store),
        )
    }

    #[view]
    public fun reward_vault(): address acquires ProbeState {
        object::object_address(&borrow_global<ProbeState>(@hook_probe).reward_vault)
    }

    #[view]
    public fun reward_vault_balance(): u64 acquires ProbeState {
        let state = borrow_global<ProbeState>(@hook_probe);
        fungible_asset::balance_with_ref(&state.raw_balance_ref, state.reward_vault)
    }

    /// H4/H5 probe: an authenticated reference transfer moves an exact amount
    /// from a frozen vault into a primary store without recursively invoking
    /// the registered hooks.
    public entry fun materialize_from_vault(
        admin: &signer,
        recipient: address,
        amount: u64,
    ) acquires ProbeState {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ProbeState>(@hook_probe);
        assert!(signer::address_of(admin) == state.admin, E_NOT_ADMIN);
        let recipient_store = primary_fungible_store::ensure_primary_store_exists(
            recipient, state.metadata,
        );
        fungible_asset::transfer_with_ref(
            &state.transfer_ref,
            state.reward_vault,
            recipient_store,
            amount,
        );
        event::emit(ProbeRewardMaterialized {
            recipient,
            amount,
            vault_balance: fungible_asset::balance_with_ref(
                &state.raw_balance_ref, state.reward_vault,
            ),
        });
    }

    public entry fun assert_admin(admin: &signer) acquires ProbeState {
        assert!(signer::address_of(admin) == borrow_global<ProbeState>(@hook_probe).admin, E_NOT_ADMIN);
    }

    #[test_only]
    public fun initialize_for_test(admin: &signer) {
        init_module(admin);
    }
}
