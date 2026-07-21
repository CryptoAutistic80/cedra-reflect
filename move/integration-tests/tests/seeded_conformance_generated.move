// Generated from the independent Python v0.2 model. Do not edit by hand.
#[test_only]
module integration_tests::seeded_conformance_generated {
    use cedra_framework::timestamp;
    use reflection_core::reflection_router;
    use reflection_core::reflection_token;
    use std::signer;
    use test_amm::pool;
    use test_amm::reflection_settlement;
    use test_assets::mock_usd;
    use test_assets::test_faucet;

    const ONE: u64 = 1_000_000;

    fun setup(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
    ) {
        timestamp::set_time_has_started_for_testing(framework);
        reflection_token::initialize(core, 100);
        mock_usd::initialize_for_test(assets);
        pool::launch(core, assets, amm, bootstrap);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        alice = @0xa110,
        bob = @0xb0b,
        carol = @0xca201,
        dave = @0xda7e,
    )]
    fun seeded_ownerless_automatic_accounting_witness(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
        carol: &signer,
        dave: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(alice);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_tusd(bob);
        test_faucet::claim_trfl(carol);
        test_faucet::claim_trfl(dave);

        let (sell_1, _, _) = pool::quote_sell(7 * ONE);
        pool::sell_trfl(alice, 7 * ONE, sell_1, 10_000);
        let (buy_1, _, _) = pool::quote_buy(5 * ONE);
        pool::buy_trfl(alice, 5 * ONE, buy_1, 10_000);
        reflection_router::transfer(bob, signer::address_of(carol), 11 * ONE);

        pool::add_liquidity(bob, 10 * ONE, 10 * ONE, 1, 10_000);
        let (sell_2, _, _) = pool::quote_sell(9 * ONE);
        pool::sell_trfl(alice, 9 * ONE, sell_2, 10_000);
        let bob_shares = pool::lp_shares(1, signer::address_of(bob));
        pool::transfer_lp_shares(bob, signer::address_of(dave), bob_shares / 3);
        let (buy_2, _, _) = pool::quote_buy(6 * ONE);
        pool::buy_trfl(alice, 6 * ONE, buy_2, 10_000);
        pool::remove_liquidity(bob, pool::lp_shares(1, signer::address_of(bob)) / 2, 1, 1, 10_000);

        // BEGIN GENERATED MODEL ASSERTIONS
        // Exact values are emitted by the independent Python v0.2 model for
        // the deterministic operation sequence above.
        assert!(reflection_token::reflection_fee_bps() == 100, 1);
        assert!(reflection_token::pool_pending_rewards() == 0, 2);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == 995_183_933, 3);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 4);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == 982_411_423, 5);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) == 0, 6);
        assert!(reflection_token::raw_balance(signer::address_of(carol)) == 1_011_026_865, 7);
        assert!(reflection_token::pending_rewards(signer::address_of(carol)) == 34_128, 8);
        assert!(reflection_token::effective_balance(signer::address_of(carol)) == 1_011_060_993, 9);
        assert!(reflection_token::raw_balance(signer::address_of(dave)) == 1_000_000_000, 10);
        assert!(reflection_token::pending_rewards(signer::address_of(dave)) == 60_621, 11);
        assert!(reflection_token::effective_balance(signer::address_of(dave)) == 1_000_060_621, 12);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 13);
        assert!(pool::lp_shares(1, signer::address_of(bob)) == 3_320_997, 14);
        assert!(pool::lp_shares(1, signer::address_of(dave)) == 3_320_996, 15);
        assert!(pool::pending_lp_rewards(1, signer::address_of(dave)) == 45, 16);
        let (reserve_rfl, reserve_usd) = pool::reserves_view();
        let (custody_shares, _, _) = reflection_token::custody_accounting();
        assert!(reserve_rfl == 511_252_551 && reserve_usd == 502_152_386, 17);
        assert!((reserve_rfl as u128) == custody_shares, 18);
        // END GENERATED MODEL ASSERTIONS
        reflection_token::assert_accounting_backing();
    }

    #[test]
    fun arithmetic_boundaries_remain_exact() {
        let (shares, used_rfl, used_usd) = reflection_settlement::liquidity_mint(
            1_000_000,
            2_000_000,
            10_000_000,
            20_000_000,
            5_000_000,
        );
        assert!(shares == 500_000 && used_rfl == 1_000_000 && used_usd == 2_000_000, 20);
        let (out, fee) = reflection_settlement::constant_product_output(
            500_000_000,
            500_000_000,
            10_000_000,
            30,
        );
        assert!(out > 0 && fee == 30_000, 21);
        let (rfl_out, usd_out) = reflection_settlement::liquidity_withdrawal(
            250_000_000,
            500_000_000,
            500_000_000,
            500_000_000,
        );
        assert!(rfl_out == 250_000_000 && usd_out == 250_000_000, 22);
    }
}
