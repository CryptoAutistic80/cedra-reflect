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
    }

    struct FaucetMintCapability has store { nonce: u64 }
    struct PoolSettlementCapability has store { nonce: u64 }

    #[event]
    struct MockUsdMinted has drop, store {
        recipient: address,
        amount: u64,
        operator: address,
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
    public fun issue_pool_settlement_capability(admin: &signer): PoolSettlementCapability acquires MockUsdState {
        let state = borrow_global_mut<MockUsdState>(@test_assets);
        assert!(signer::address_of(admin) == state.admin, E_NOT_ADMIN);
        assert!(!state.pool_capability_issued, E_CAPABILITY_ALREADY_ISSUED);
        state.pool_capability_issued = true;
        PoolSettlementCapability { nonce: 1 }
    }

    public fun freeze_pool_reserve(cap: &PoolSettlementCapability, store: Object<FungibleStore>) acquires MockUsdState {
        assert!(cap.nonce == 1, E_INVALID_CAP);
        let state = borrow_global<MockUsdState>(@test_assets);
        assert!(fungible_asset::store_metadata(store) == state.metadata, E_INVALID_CAP);
        fungible_asset::set_frozen_flag(&state.transfer_ref, store, true);
    }

    public fun deposit_to_pool(cap: &PoolSettlementCapability, store: Object<FungibleStore>, asset: FungibleAsset) acquires MockUsdState {
        assert!(cap.nonce == 1, E_INVALID_CAP);
        let state = borrow_global<MockUsdState>(@test_assets);
        fungible_asset::deposit_with_ref(&state.transfer_ref, store, asset);
    }

    public fun withdraw_from_pool(cap: &PoolSettlementCapability, store: Object<FungibleStore>, amount: u64): FungibleAsset acquires MockUsdState {
        assert!(cap.nonce == 1, E_INVALID_CAP);
        let state = borrow_global<MockUsdState>(@test_assets);
        fungible_asset::withdraw_with_ref(&state.transfer_ref, store, amount)
    }

    #[view]
    public fun metadata(): Object<Metadata> acquires MockUsdState { borrow_global<MockUsdState>(@test_assets).metadata }

    #[test_only]
    public fun initialize_for_test(admin: &signer) { init_module(admin); }
    #[test_only]
    public fun destroy_faucet_capability_for_test(cap: FaucetMintCapability) { let FaucetMintCapability { nonce: _ } = cap; }
    #[test_only]
    public fun destroy_pool_capability_for_test(cap: PoolSettlementCapability) { let PoolSettlementCapability { nonce: _ } = cap; }
}
