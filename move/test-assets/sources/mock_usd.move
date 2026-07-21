/// Six-decimal, no-value tUSD. Mint authority is held only by test_faucet.
module test_assets::mock_usd {
    use cedra_framework::event;
    use cedra_framework::fungible_asset::{Self, FungibleAsset, FungibleStore, Metadata, MintRef, TransferRef};
    use cedra_framework::object::{Self, Object};
    use cedra_framework::primary_fungible_store;
    use std::option;
    use std::signer;
    use std::string;

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_NOT_ADMIN: u64 = 2;
    const E_CAPABILITY_ALREADY_ISSUED: u64 = 3;
    const E_INVALID_CAP: u64 = 4;
    const E_ZERO_AMOUNT: u64 = 5;
    const SEED: vector<u8> = b"reflection-pilot-tusd-v1";

    struct MockUsdState has key {
        admin: address,
        metadata: Object<Metadata>,
        mint_ref: MintRef,
        transfer_ref: TransferRef,
        faucet_capability_issued: bool,
        pool_capability_issued: bool,
        pool_reserve: address,
    }

    struct FaucetMintCapability has store { nonce: u64 }
    struct PoolSettlementCapability has store { reserve_store: address, nonce: u64 }

    #[event]
    struct MockUsdMinted has drop, store {
        recipient: address,
        amount: u64,
        operator: address,
    }

    #[event]
    struct PoolReserveBound has drop, store {
        reserve_store: address,
        custodian: address,
    }

    fun init_module(admin: &signer) {
        assert!(!exists<MockUsdState>(@test_assets), E_ALREADY_INITIALIZED);
        let constructor_ref = object::create_named_object(admin, SEED);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &constructor_ref,
            option::none(),
            string::utf8(b"Reflection Pilot Test USD"),
            string::utf8(b"tUSD"),
            6,
            string::utf8(b"https://raw.githubusercontent.com/CryptoAutistic80/cedra-reflect/main/assets/tusd-testnet.svg"),
            string::utf8(b"https://github.com/CryptoAutistic80/cedra-reflect"),
        );
        let mint_ref = fungible_asset::generate_mint_ref(&constructor_ref);
        let transfer_ref = fungible_asset::generate_transfer_ref(&constructor_ref);
        let metadata = fungible_asset::mint_ref_metadata(&mint_ref);
        move_to(admin, MockUsdState {
            admin: signer::address_of(admin),
            metadata,
            mint_ref,
            transfer_ref,
            faucet_capability_issued: false,
            pool_capability_issued: false,
            pool_reserve: @0x0,
        });
    }

    public fun issue_faucet_capability(admin: &signer): FaucetMintCapability acquires MockUsdState {
        let state = borrow_global_mut<MockUsdState>(@test_assets);
        assert!(signer::address_of(admin) == state.admin, E_NOT_ADMIN);
        assert!(!state.faucet_capability_issued, E_CAPABILITY_ALREADY_ISSUED);
        state.faucet_capability_issued = true;
        FaucetMintCapability { nonce: 1 }
    }

    public fun mint_from_faucet(cap: &FaucetMintCapability, recipient: address, amount: u64, operator: address) acquires MockUsdState {
        assert!(cap.nonce == 1, E_INVALID_CAP);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global<MockUsdState>(@test_assets);
        primary_fungible_store::mint(&state.mint_ref, recipient, amount);
        event::emit(MockUsdMinted { recipient, amount, operator });
    }

    /// Handed once to the canonical AMM. Its public surface can only move tUSD
    /// into or out of the frozen reserve, not mint it.
    public fun issue_pool_settlement_capability(
        admin: &signer,
        custodian: &signer,
        store: Object<FungibleStore>,
    ): PoolSettlementCapability acquires MockUsdState {
        let state = borrow_global_mut<MockUsdState>(@test_assets);
        assert!(signer::address_of(admin) == state.admin, E_NOT_ADMIN);
        assert!(!state.pool_capability_issued, E_CAPABILITY_ALREADY_ISSUED);
        assert!(fungible_asset::store_metadata(store) == state.metadata, E_INVALID_CAP);
        assert!(object::owner(store) == signer::address_of(custodian), E_INVALID_CAP);
        assert!(fungible_asset::balance(store) == 0, E_INVALID_CAP);
        let reserve_store = object::object_address(&store);
        state.pool_capability_issued = true;
        state.pool_reserve = reserve_store;
        fungible_asset::set_frozen_flag(&state.transfer_ref, store, true);
        event::emit(PoolReserveBound {
            reserve_store,
            custodian: signer::address_of(custodian),
        });
        PoolSettlementCapability { reserve_store, nonce: 1 }
    }

    public fun deposit_to_pool(cap: &PoolSettlementCapability, store: Object<FungibleStore>, asset: FungibleAsset) acquires MockUsdState {
        assert!(fungible_asset::asset_metadata(&asset) == borrow_global<MockUsdState>(@test_assets).metadata, E_INVALID_CAP);
        assert_pool_cap(cap, store);
        let state = borrow_global<MockUsdState>(@test_assets);
        fungible_asset::deposit_with_ref(&state.transfer_ref, store, asset);
    }

    public fun withdraw_from_pool(cap: &PoolSettlementCapability, store: Object<FungibleStore>, amount: u64): FungibleAsset acquires MockUsdState {
        assert_pool_cap(cap, store);
        let state = borrow_global<MockUsdState>(@test_assets);
        fungible_asset::withdraw_with_ref(&state.transfer_ref, store, amount)
    }

    #[view]
    public fun metadata(): Object<Metadata> acquires MockUsdState { borrow_global<MockUsdState>(@test_assets).metadata }

    #[view]
    public fun pool_reserve(): address acquires MockUsdState { borrow_global<MockUsdState>(@test_assets).pool_reserve }

    fun assert_pool_cap(cap: &PoolSettlementCapability, store: Object<FungibleStore>) acquires MockUsdState {
        let store_address = object::object_address(&store);
        assert!(
            cap.nonce == 1
                && cap.reserve_store == store_address
                && borrow_global<MockUsdState>(@test_assets).pool_reserve == store_address,
            E_INVALID_CAP,
        );
    }

    #[test_only]
    public fun initialize_for_test(admin: &signer) { init_module(admin); }
    #[test_only]
    public fun destroy_faucet_capability_for_test(cap: FaucetMintCapability) { let FaucetMintCapability { nonce: _ } = cap; }
    #[test_only]
    public fun destroy_pool_capability_for_test(cap: PoolSettlementCapability) {
        let PoolSettlementCapability { reserve_store: _, nonce: _ } = cap;
    }
}
