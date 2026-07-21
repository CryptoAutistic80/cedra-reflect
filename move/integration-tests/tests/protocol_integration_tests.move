#[test_only]
module integration_tests::protocol_integration_tests {
    use cedra_framework::dispatchable_fungible_asset;
    use cedra_framework::primary_fungible_store;
    use cedra_framework::timestamp;
    use reflection_core::reflection_router;
    use reflection_core::reflection_token;
    use std::signer;
    use test_amm::pool;
    use test_assets::mock_usd;
    use test_assets::test_faucet;

    const ONE: u64 = 1_000_000;

    fun setup(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        fee_bps: u64,
    ) {
        timestamp::set_time_has_started_for_testing(framework);
        reflection_token::initialize(core, fee_bps);
        mock_usd::initialize_for_test(assets);
        pool::launch(core, assets, amm, bootstrap);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
    )]
    fun atomic_launch_seals_fixed_ownerless_configuration(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        assert!(reflection_token::launch_state() == 1, 1);
        assert!(reflection_token::is_sealed() && !reflection_token::is_closed(), 2);
        assert!(pool::lifecycle() == 1, 3);
        assert!(reflection_token::reflection_fee_bps() == 100, 4);
        assert!(reflection_token::automatic_materialization_enabled(), 5);
        let (amm_fee, max_reserve, max_swap) = pool::limits();
        assert!(amm_fee == 30 && max_reserve == 2_000 && max_swap == 100_000_000_000, 6);
        let (rfl_seed, usd_seed, beneficiary) = pool::initial_liquidity();
        assert!(rfl_seed == 500_000_000 && usd_seed == 500_000_000, 7);
        assert!(beneficiary == @bootstrap_lp, 8);
        let (rfl, usd) = pool::reserves_view();
        assert!(rfl == rfl_seed && usd == usd_seed, 9);
        assert!(pool::lp_shares(1, @bootstrap_lp) == 500_000_000, 10);
        let (trfl_grant, tusd_grant, cooldown) = test_faucet::configuration();
        assert!(trfl_grant == 1_000_000_000 && tusd_grant == 1_000_000_000, 11);
        assert!(cooldown == 3_600, 12);
        assert!(reflection_token::primary_store_is_excluded(@reflection_core), 13);
        assert!(reflection_token::primary_store_is_excluded(@test_assets), 14);
        assert!(reflection_token::primary_store_is_excluded(@test_amm), 15);
        reflection_token::assert_accounting_backing();
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
    fun repeated_trader_materializes_while_passive_wallets_and_lp_grow(
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
        setup(core, assets, amm, bootstrap, framework, 100);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(alice);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_trfl(carol);
        test_faucet::claim_trfl(dave);

        let bob_raw = reflection_token::raw_balance(signer::address_of(bob));
        let carol_raw = reflection_token::raw_balance(signer::address_of(carol));
        let dave_raw = reflection_token::raw_balance(signer::address_of(dave));
        let cycle = 0;
        while (cycle < 10) {
            let gross = 5 * ONE + cycle * 100_000;
            let (sell_out, sell_fee, _) = pool::quote_sell(gross);
            assert!(sell_fee == gross / 100, 20);
            pool::sell_trfl(alice, gross, sell_out, 10_000);
            assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 21);
            assert!(reflection_token::pool_pending_rewards() == 0, 22);
            let (net_buy, buy_fee, _) = pool::quote_buy(gross);
            assert!(buy_fee > 0, 23);
            pool::buy_trfl(alice, gross, net_buy, 10_000);
            assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 24);
            assert!(reflection_token::pool_pending_rewards() == 0, 25);
            cycle = cycle + 1;
        };

        assert!(reflection_token::raw_balance(signer::address_of(bob)) == bob_raw, 30);
        assert!(reflection_token::raw_balance(signer::address_of(carol)) == carol_raw, 31);
        assert!(reflection_token::raw_balance(signer::address_of(dave)) == dave_raw, 32);
        let bob_pending = reflection_token::pending_rewards(signer::address_of(bob));
        let carol_pending = reflection_token::pending_rewards(signer::address_of(carol));
        let dave_pending = reflection_token::pending_rewards(signer::address_of(dave));
        assert!(bob_pending > 0 && carol_pending > 0 && dave_pending > 0, 33);
        assert!(
            primary_fungible_store::balance(signer::address_of(bob), reflection_token::metadata())
                == bob_raw + bob_pending,
            34,
        );
        assert!(pool::pending_lp_rewards(1, @bootstrap_lp) > 0, 35);

        reflection_router::transfer(bob, signer::address_of(alice), 1);
        reflection_router::transfer(carol, signer::address_of(alice), 1);
        reflection_router::transfer(dave, signer::address_of(alice), 1);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) == 0, 36);
        assert!(reflection_token::pending_rewards(signer::address_of(carol)) == 0, 37);
        assert!(reflection_token::pending_rewards(signer::address_of(dave)) == 0, 38);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == bob_raw + bob_pending - 1, 39);
        assert!(reflection_token::raw_balance(signer::address_of(carol)) == carol_raw + carol_pending - 1, 40);
        assert!(reflection_token::raw_balance(signer::address_of(dave)) == dave_raw + dave_pending - 1, 41);
        reflection_token::assert_accounting_backing();
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        trader = @0x7ade,
        bob = @0xb0b,
    )]
    fun lp_transfer_materializes_both_historical_endpoints(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        trader: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        test_faucet::claim_trfl(trader);
        test_faucet::claim_tusd(trader);
        pool::transfer_lp_shares(bootstrap, signer::address_of(bob), 100_000_000);

        let (sell_out, _, _) = pool::quote_sell(10 * ONE);
        pool::sell_trfl(trader, 10 * ONE, sell_out, 10_000);
        let bootstrap_pending = pool::pending_lp_rewards(1, @bootstrap_lp);
        let bob_pending = pool::pending_lp_rewards(1, signer::address_of(bob));
        assert!(bootstrap_pending > 0 && bob_pending > 0, 50);
        let bootstrap_raw = reflection_token::raw_balance(@bootstrap_lp);
        let bob_raw = reflection_token::raw_balance(signer::address_of(bob));

        pool::transfer_lp_shares(bootstrap, signer::address_of(bob), 1);
        assert!(pool::pending_lp_rewards(1, @bootstrap_lp) == 0, 51);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 52);
        assert!(reflection_token::raw_balance(@bootstrap_lp) == bootstrap_raw + bootstrap_pending, 53);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == bob_raw + bob_pending, 54);
        reflection_token::assert_accounting_backing();
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        bob = @0xb0b,
        carol = @0xca201,
    )]
    fun fragmented_final_lp_exit_closes_without_publisher_and_token_still_transfers(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        bob: &signer,
        carol: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        pool::transfer_lp_shares(bootstrap, signer::address_of(bob), 250_000_000);
        pool::remove_liquidity(bootstrap, 250_000_000, 1, 1, 10_000);
        assert!(pool::lifecycle() == 1, 60);
        let bob_shares = pool::lp_shares(1, signer::address_of(bob));
        pool::remove_liquidity(bob, bob_shares, 1, 1, 10_000);
        assert!(pool::lifecycle() == 2, 61);
        assert!(reflection_token::is_closed() && reflection_token::launch_state() == 2, 62);
        let (rfl, usd) = pool::reserves_view();
        assert!(rfl == 0 && usd == 0, 63);
        assert!(pool::total_lp_shares() == 0, 64);
        reflection_router::transfer(bob, signer::address_of(carol), 1);
        assert!(reflection_token::raw_balance(signer::address_of(carol)) == 1, 65);
        reflection_token::assert_accounting_backing();
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        alice = @0xa110,
    )]
    fun zero_reflection_fee_is_immutable_and_charges_nothing(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 0);
        test_faucet::claim_trfl(alice);
        let (out, fee, _) = pool::quote_sell(10 * ONE);
        assert!(fee == 0, 70);
        pool::sell_trfl(alice, 10 * ONE, out, 10_000);
        assert!(reflection_token::reward_vault_balance() == 0, 71);
        assert!(reflection_token::pool_pending_rewards() == 0, 72);
        assert!(reflection_token::reflection_fee_bps() == 0, 73);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        alice = @0xa110,
    )]
    #[expected_failure(abort_code = 2, location = test_assets::test_faucet)]
    fun fixed_faucet_cooldown_cannot_be_bypassed(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(alice);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        wrong_bootstrap = @0xb0b,
        framework = @0x1,
    )]
    #[expected_failure(abort_code = 4, location = test_amm::pool)]
    fun launch_rejects_redirected_bootstrap_lp(
        core: &signer,
        assets: &signer,
        amm: &signer,
        wrong_bootstrap: &signer,
        framework: &signer,
    ) {
        timestamp::set_time_has_started_for_testing(framework);
        reflection_token::initialize(core, 100);
        mock_usd::initialize_for_test(assets);
        pool::launch(core, assets, amm, wrong_bootstrap);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        alice = @0xa110,
    )]
    #[expected_failure(abort_code = 327683, location = cedra_framework::fungible_asset)]
    fun direct_deposit_to_canonical_rfl_reserve_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        test_faucet::claim_trfl(alice);
        dispatchable_fungible_asset::transfer(
            alice,
            primary_fungible_store::primary_store(
                signer::address_of(alice),
                reflection_token::metadata(),
            ),
            pool::rfl_reserve_store(),
            1,
        );
    }
}
