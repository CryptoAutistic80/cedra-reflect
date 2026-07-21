#[test_only]
module reflection_core::reflection_core_tests {
    use cedra_framework::fungible_asset::{Self, FungibleStore};
    use cedra_framework::object::{Self, Object};
    use cedra_framework::primary_fungible_store;
    use reflection_core::custody_registry::{Self, CustodySettlementCapability};
    use reflection_core::reflection_registry;
    use reflection_core::reflection_token::{Self, FaucetCapability, SettlementCapability};
    use std::signer;

    fun setup_live(
        admin: &signer,
        assets: &signer,
        amm: &signer,
    ): (
        SettlementCapability,
        FaucetCapability,
        CustodySettlementCapability,
        Object<FungibleStore>,
        Object<FungibleStore>,
    ) {
        reflection_token::initialize(admin, 100);
        let settlement_cap = reflection_token::issue_settlement_capability(admin, amm);
        let faucet_cap = reflection_token::issue_faucet_capability(admin, assets);
        let pool_constructor = object::create_named_object(amm, b"core-test-pool-v2");
        let pool = fungible_asset::create_store(&pool_constructor, reflection_token::metadata());
        let vault_constructor = object::create_named_object(amm, b"core-test-lp-vault-v2");
        let vault = fungible_asset::create_store(&vault_constructor, reflection_token::metadata());
        let custody_cap = reflection_token::register_canonical_custody(admin, amm, pool, vault);
        reflection_token::bind_protocol_exclusions(admin);
        reflection_token::seed_pool_from_distribution(
            &custody_cap,
            admin,
            pool,
            reflection_token::initial_pool_rfl(),
        );
        reflection_token::seal_launch(admin, assets, amm);
        (settlement_cap, faucet_cap, custody_cap, pool, vault)
    }

    #[test(admin = @0xcafe)]
    fun zero_fee_is_valid_and_immutable_state_starts_configuring(admin: &signer) {
        reflection_token::initialize_with_fee_for_test(admin, 0);
        assert!(reflection_token::reflection_fee_bps() == 0, 1);
        assert!(reflection_token::fee_bps() == 0, 2);
        assert!(reflection_token::reflection_fee_for(1_000_000) == 0, 3);
        assert!(reflection_token::launch_state() == 0, 4);
        assert!(!reflection_token::is_sealed(), 5);
        assert!(!reflection_token::is_closed(), 6);
        assert!(reflection_token::automatic_materialization_enabled(), 7);
        assert!(reflection_token::distribution_vault_balance() == reflection_token::fixed_supply(), 8);
        assert!(reflection_token::reward_vault_balance() == 0, 9);
        let (major, minor, patch) = reflection_registry::release_version();
        assert!(major == 0 && minor == 2 && patch == 0, 10);
    }

    #[test(admin = @0xcafe)]
    fun one_basis_point_fee_is_exact(admin: &signer) {
        reflection_token::initialize_with_fee_for_test(admin, 1);
        assert!(reflection_token::reflection_fee_bps() == 1, 20);
        assert!(reflection_token::reflection_fee_for(9_999) == 0, 21);
        assert!(reflection_token::reflection_fee_for(10_000) == 1, 22);
    }

    #[test(admin = @0xcafe)]
    fun testnet_one_percent_fee_is_exact(admin: &signer) {
        reflection_token::initialize_with_fee_for_test(admin, 100);
        assert!(reflection_token::reflection_fee_bps() == 100, 30);
        assert!(reflection_token::reflection_fee_for(99) == 0, 31);
        assert!(reflection_token::reflection_fee_for(10_000) == 100, 32);
        assert!(
            reflection_token::reflection_fee_for(18_446_744_073_709_551_615)
                == 184_467_440_737_095_516,
            33,
        );
    }

    #[test(admin = @0xcafe)]
    fun maximum_fee_is_valid(admin: &signer) {
        reflection_token::initialize_with_fee_for_test(admin, 500);
        assert!(reflection_token::reflection_fee_bps() == 500, 40);
        assert!(reflection_token::reflection_fee_for(10_000) == 500, 41);
    }

    #[test(admin = @0xcafe)]
    #[expected_failure(abort_code = 7, location = reflection_core::reflection_token)]
    fun fee_above_maximum_is_rejected(admin: &signer) {
        reflection_token::initialize_with_fee_for_test(admin, 501);
    }

    #[test(admin = @0xcafe)]
    #[expected_failure(abort_code = 1, location = reflection_core::reflection_token)]
    fun initialization_is_one_shot_so_fee_cannot_change(admin: &signer) {
        reflection_token::initialize_with_fee_for_test(admin, 100);
        reflection_token::initialize(admin, 500);
    }

    #[test(alice = @0xa11ce)]
    #[expected_failure(abort_code = 2, location = reflection_core::reflection_token)]
    fun initialization_requires_package_publisher(alice: &signer) {
        reflection_token::initialize(alice, 100);
    }

    #[test(admin = @0xcafe, assets = @0xbabe, amm = @0xdead, alice = @0xa11ce, bob = @0xb0b)]
    fun interactions_materialize_all_pending_and_keep_incoming_weight_historical_free(
        admin: &signer,
        assets: &signer,
        amm: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        let (settlement_cap, faucet_cap, custody_cap, pool, _) = setup_live(admin, assets, amm);
        assert!(reflection_token::is_sealed(), 60);
        assert!(reflection_token::launch_state() == 1, 61);
        reflection_token::faucet_grant(&faucet_cap, signer::address_of(alice), 100_000_000, @0xcafe);
        reflection_token::faucet_grant(&faucet_cap, signer::address_of(bob), 100_000_000, @0xcafe);

        let (_, sell_fee) = reflection_token::settle_sell(&settlement_cap, alice, pool, 10_000_000);
        assert!(sell_fee == 100_000, 62);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 63);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) > 0, 64);
        assert!(
            reflection_token::effective_balance(signer::address_of(bob))
                > reflection_token::raw_balance(signer::address_of(bob)),
            65,
        );

        primary_fungible_store::transfer(bob, reflection_token::metadata(), signer::address_of(alice), 1);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) == 0, 66);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 67);

        let (_, bob_sell_fee) = reflection_token::settle_sell(&settlement_cap, bob, pool, 10_000_000);
        assert!(bob_sell_fee == 100_000, 68);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) > 0, 69);
        let alice_raw_before_buy = reflection_token::raw_balance(signer::address_of(alice));
        let (net_buy, buy_fee) = reflection_token::settle_buy(&settlement_cap, alice, pool, 10_000_000);
        assert!(buy_fee == 100_000 && net_buy == 9_900_000, 70);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 71);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) > alice_raw_before_buy + net_buy, 72);
        reflection_token::assert_accounting_backing();

        reflection_token::destroy_settlement_capability_for_test(settlement_cap);
        reflection_token::destroy_faucet_capability_for_test(faucet_cap);
        custody_registry::destroy_capability_for_test(custody_cap);
    }

    #[test(admin = @0xcafe, assets = @0xbabe, amm = @0xdead, alice = @0xa11ce, bob = @0xb0b)]
    fun final_custody_exit_closes_pool_but_not_token_transfers(
        admin: &signer,
        assets: &signer,
        amm: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        let (settlement_cap, faucet_cap, custody_cap, pool, _) = setup_live(admin, assets, amm);
        let (net, fee) = reflection_token::settle_buy(
            &settlement_cap,
            alice,
            pool,
            reflection_token::initial_pool_rfl(),
        );
        assert!(net == 495_000_000 && fee == 5_000_000, 80);
        reflection_token::close_pool(&custody_cap);
        assert!(reflection_token::is_closed(), 81);
        assert!(reflection_token::launch_state() == 2, 82);
        primary_fungible_store::transfer(alice, reflection_token::metadata(), signer::address_of(bob), 1);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == 1, 83);
        assert!(reflection_token::wallet_is_registered(signer::address_of(bob)), 84);

        reflection_token::destroy_settlement_capability_for_test(settlement_cap);
        reflection_token::destroy_faucet_capability_for_test(faucet_cap);
        custody_registry::destroy_capability_for_test(custody_cap);
    }
}
