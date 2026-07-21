#[test_only]
module integration_tests::wallet_lp_accounting_tests {
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
        alice = @0xa110,
        bob = @0xb0b,
    )]
    fun manual_claims_remain_permissionless_fallbacks(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(bob);
        let (out, _, _) = pool::quote_sell(10 * ONE);
        pool::sell_trfl(alice, 10 * ONE, out, 10_000);
        let pending = reflection_token::pending_rewards(signer::address_of(bob));
        assert!(pending > 1, 1);
        let effective = reflection_token::effective_balance(signer::address_of(bob));
        reflection_token::claim(bob, pending / 2);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) > 0, 2);
        assert!(reflection_token::effective_balance(signer::address_of(bob)) == effective, 3);
        reflection_token::claim_all(bob);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) == 0, 4);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == effective, 5);
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
    )]
    fun maximum_creation_fee_is_exact_and_passive_holder_receives_it(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 500);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(bob);
        let (out, fee, _) = pool::quote_sell(10 * ONE);
        assert!(fee == 500_000, 10);
        pool::sell_trfl(alice, 10 * ONE, out, 10_000);
        assert!(reflection_token::reflection_fee_bps() == 500, 11);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 12);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) > 0, 13);
        assert!(reflection_token::pool_pending_rewards() == 0, 14);
        assert!(pool::pending_lp_rewards(1, @bootstrap_lp) > 0, 15);
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
        trader = @0x7ade,
    )]
    fun untaxed_transfer_materializes_sender_and_recipient_without_history_capture(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
        trader: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_trfl(trader);
        let (out, _, _) = pool::quote_sell(10 * ONE);
        pool::sell_trfl(trader, 10 * ONE, out, 10_000);
        let alice_pending = reflection_token::pending_rewards(signer::address_of(alice));
        let bob_pending = reflection_token::pending_rewards(signer::address_of(bob));
        let alice_raw = reflection_token::raw_balance(signer::address_of(alice));
        let bob_raw = reflection_token::raw_balance(signer::address_of(bob));
        assert!(alice_pending > 0 && bob_pending > 0, 20);

        reflection_router::transfer(alice, signer::address_of(bob), ONE);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 21);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) == 0, 22);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == alice_raw + alice_pending - ONE, 23);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == bob_raw + bob_pending + ONE, 24);
        reflection_token::assert_accounting_backing();
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        alice = @0xa110,
        trader = @0x7ade,
    )]
    fun self_transfer_is_accounting_neutral_and_materializes_once(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
        trader: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(trader);
        let (out, _, _) = pool::quote_sell(10 * ONE);
        pool::sell_trfl(trader, 10 * ONE, out, 10_000);
        let effective = reflection_token::effective_balance(signer::address_of(alice));
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) > 0, 30);
        reflection_router::transfer(alice, signer::address_of(alice), 1);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 31);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == effective, 32);
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
    #[expected_failure(abort_code = 11, location = test_amm::pool)]
    fun swaps_remain_permanently_closed_after_final_lp_exit(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        let all_shares = pool::lp_shares(1, @bootstrap_lp);
        pool::remove_liquidity(bootstrap, all_shares, 1, 1, 10_000);
        pool::sell_trfl(alice, 1, 0, 10_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
    )]
    #[expected_failure(abort_code = 1, location = test_amm::pool)]
    fun launch_is_irreversible_and_cannot_run_twice(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, bootstrap, framework, 100);
        pool::launch(core, assets, amm, bootstrap);
    }
}
