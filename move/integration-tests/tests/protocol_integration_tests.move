#[test_only]
module integration_tests::protocol_integration_tests {
    use cedra_framework::dispatchable_fungible_asset;
    use cedra_framework::fungible_asset;
    use cedra_framework::object;
    use cedra_framework::primary_fungible_store;
    use cedra_framework::timestamp;
    use reflection_core::custody_registry;
    use reflection_core::reflection_router;
    use reflection_core::reflection_token;
    use std::signer;
    use test_amm::lp_rewards;
    use test_amm::pool;
    use test_assets::mock_usd;
    use test_assets::test_faucet;

    const ONE: u64 = 1_000_000;

    fun setup_with_materialization_mode(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        automatic_materialization: bool,
    ) {
        timestamp::set_time_has_started_for_testing(framework);
        if (automatic_materialization) {
            reflection_token::initialize_for_test(core);
        } else {
            reflection_token::initialize_claim_backed_for_test(core);
        };
        mock_usd::initialize_for_test(assets);
        test_faucet::initialize(core, assets);
        pool::initialize(core, assets, amm);
    }

    fun setup(core: &signer, assets: &signer, amm: &signer, framework: &signer) {
        setup_with_materialization_mode(core, assets, amm, framework, true);
    }

    fun setup_claim_backed(core: &signer, assets: &signer, amm: &signer, framework: &signer) {
        setup_with_materialization_mode(core, assets, amm, framework, false);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce, bob = @0xb0b)]
    fun faucet_amm_reflections_claim_and_zero_fee(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        // Independent faucet grants demonstrate fixed tRFL distribution and
        // mintable six-decimal tUSD from narrow capabilities.
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        test_faucet::claim_tusd(bob);
        reflection_token::register_wallet(bob);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == 1_000 * ONE, 10);
        assert!(primary_fungible_store::balance(signer::address_of(bob), mock_usd::metadata()) == 1_000 * ONE, 11);

        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        let (rfl_seeded, usd_seeded) = pool::reserves_view();
        assert!(rfl_seeded == 100 * ONE && usd_seeded == 100 * ONE, 12);

        let (sell_quote, sell_reflection_fee, _) = pool::quote_sell(ONE);
        assert!(sell_reflection_fee == ONE / 100, 13);
        pool::sell_trfl(alice, ONE, sell_quote, 1_000);
        assert!(reflection_token::reward_vault_balance() == ONE / 100, 14);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) > 0, 15);

        // Spend only part of the pending amount. The dispatch withdrawal hook
        // must materialise the shortfall, not claim the entire reward balance.
        let raw_before_spend = reflection_token::raw_balance(signer::address_of(alice));
        let pending_before_spend = reflection_token::pending_rewards(signer::address_of(alice));
        let materialised_shortfall = pending_before_spend / 2;
        reflection_router::transfer(alice, signer::address_of(bob), raw_before_spend + materialised_shortfall);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == 0, 151);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == pending_before_spend - materialised_shortfall, 152);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == raw_before_spend + materialised_shortfall, 153);

        let before_claim = reflection_token::effective_balance(signer::address_of(alice));
        let pending_before_claim = reflection_token::pending_rewards(signer::address_of(alice));
        let partial_claim = pending_before_claim / 2;
        reflection_token::claim(alice, partial_claim);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == pending_before_claim - partial_claim, 161);
        assert!(reflection_token::effective_balance(signer::address_of(alice)) == before_claim, 162);
        reflection_token::claim_all(alice);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 16);
        assert!(reflection_token::effective_balance(signer::address_of(alice)) == before_claim, 17);
        let (aggregate_negative, aggregate_magnitude) = reflection_token::aggregate_correction();
        assert!(aggregate_negative && aggregate_magnitude > 0, 171);

        let (net_buy, buy_reflection_fee, _) = pool::quote_buy(ONE);
        assert!(net_buy > 0 && buy_reflection_fee > 0, 18);
        let bob_before_buy = reflection_token::raw_balance(signer::address_of(bob));
        pool::buy_trfl(bob, ONE, net_buy, 1_000);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == bob_before_buy + net_buy, 19);

        reflection_router::transfer(bob, signer::address_of(alice), ONE);
        reflection_token::set_fee_bps(core, 0);
        let (_, zero_reflection_fee, _) = pool::quote_sell(ONE);
        assert!(zero_reflection_fee == 0, 20);
        pool::sell_trfl(alice, ONE, 0, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce, bob = @0xb0b)]
    fun claim_backed_mode_requires_explicit_wallet_claim_and_preserves_lp_rewards(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        assert!(!reflection_token::automatic_materialization_enabled(), 210);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        let (sell_quote, _, _) = pool::quote_sell(ONE);
        pool::sell_trfl(alice, ONE, sell_quote, 1_000);

        let raw_before_claim = reflection_token::raw_balance(signer::address_of(alice));
        let pending_before_claim = reflection_token::pending_rewards(signer::address_of(alice));
        assert!(pending_before_claim > 0, 211);
        assert!(primary_fungible_store::balance(
            signer::address_of(alice), reflection_token::metadata(),
        ) == raw_before_claim, 212);
        let effective_before_claim = reflection_token::effective_balance(signer::address_of(alice));
        assert!(effective_before_claim == raw_before_claim + pending_before_claim, 213);

        reflection_token::claim_all(alice);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 214);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == effective_before_claim, 215);
        assert!(primary_fungible_store::balance(
            signer::address_of(alice), reflection_token::metadata(),
        ) == effective_before_claim, 216);

        pool::checkpoint_lp_rewards(bob);
        let lp_pending = pool::pending_lp_rewards(1, signer::address_of(alice));
        assert!(lp_pending > 0, 217);
        let wallet_before_lp_claim = reflection_token::raw_balance(signer::address_of(alice));
        pool::claim_lp_rewards(alice, 1, lp_pending);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 218);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == wallet_before_lp_claim + lp_pending, 219);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce, bob = @0xb0b)]
    #[expected_failure(abort_code = 32, location = reflection_core::reflection_token)]
    fun claim_backed_mode_rejects_spending_pending_before_claim(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        let (sell_quote, _, _) = pool::quote_sell(ONE);
        pool::sell_trfl(alice, ONE, sell_quote, 1_000);
        let raw = reflection_token::raw_balance(signer::address_of(alice));
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) > 0, 220);
        reflection_router::transfer(alice, signer::address_of(bob), raw + 1);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 3, location = test_assets::test_faucet)]
    fun faucet_cooldown_is_enforced(core: &signer, assets: &signer, amm: &signer, framework: &signer, alice: &signer) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(alice);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 6, location = test_assets::test_faucet)]
    fun faucet_configuration_is_operational_admin_only(core: &signer, assets: &signer, amm: &signer, framework: &signer, alice: &signer) {
        setup(core, assets, amm, framework);
        test_faucet::configure(alice, ONE, ONE, 0);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 8, location = test_assets::test_faucet)]
    fun faucet_pause_blocks_distribution(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::set_paused(assets, true);
        assert!(test_faucet::paused(), 230);
        test_faucet::claim_trfl(alice);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 6, location = test_assets::test_faucet)]
    fun faucet_pause_is_operational_admin_only(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::set_paused(alice, true);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    fun canonical_pool_is_an_exact_once_reward_position(core: &signer, assets: &signer, amm: &signer, framework: &signer, alice: &signer) {
        setup(core, assets, amm, framework);
        test_faucet::configure(assets, 10 * ONE, 1_000 * ONE, 0);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        let (_, _, shares, unallocated, lifetime_fees, _) = reflection_token::global_accounting();
        let (custody_shares, routed, _) = reflection_token::custody_accounting();
        let (reserve_rfl, _) = pool::reserves_view();
        assert!(shares == (reserve_rfl as u128), 320);
        assert!(custody_shares == (reserve_rfl as u128), 321);
        assert!(unallocated == 0, 322);
        assert!(lifetime_fees == (ONE as u256) / 10, 322);
        assert!(reflection_token::reward_vault_balance() == ONE / 10, 323);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 324);
        assert!(reflection_token::pool_pending_rewards() == ONE / 10, 325);
        assert!(routed == 0, 326);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        fresh_beneficiary = @0xf123,
        reseed_beneficiary = @0xf124,
    )]
    fun seed_atomically_registers_fresh_authenticated_lp_beneficiary(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        fresh_beneficiary: &signer,
        reseed_beneficiary: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_tusd(amm);
        let beneficiary_address = signer::address_of(fresh_beneficiary);
        assert!(!reflection_token::wallet_is_registered(beneficiary_address), 327);

        pool::seed_liquidity(
            core, amm, fresh_beneficiary, 100 * ONE, 100 * ONE, 1,
        );

        assert!(reflection_token::wallet_is_registered(beneficiary_address), 328);
        assert!(pool::lp_shares(1, beneficiary_address) == ((100 * ONE) as u128), 329);
        assert!(reflection_token::registered_wallet_count() == 1, 333);
        reflection_token::register_wallet(fresh_beneficiary);
        assert!(reflection_token::registered_wallet_count() == 1, 334);

        pool::begin_shutdown(amm);
        let initial_shares = pool::lp_shares(1, beneficiary_address);
        pool::remove_liquidity(fresh_beneficiary, initial_shares, 1, 1, 1_000);
        let reseed_address = signer::address_of(reseed_beneficiary);
        assert!(!reflection_token::wallet_is_registered(reseed_address), 330);

        pool::reseed_liquidity(
            core, amm, reseed_beneficiary, 50 * ONE, 50 * ONE, 1,
        );

        assert!(reflection_token::wallet_is_registered(reseed_address), 331);
        assert!(pool::lp_shares(2, reseed_address) == ((50 * ONE) as u128), 332);
        assert!(reflection_token::registered_wallet_count() == 2, 335);
        reflection_token::register_wallet(reseed_beneficiary);
        assert!(reflection_token::registered_wallet_count() == 2, 336);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 19, location = test_amm::pool)]
    fun operational_admin_cannot_be_bootstrap_lp_beneficiary(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_all_operational_admin(core, assets, amm, alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce, bob = @0xb0b)]
    #[expected_failure(abort_code = 6, location = reflection_core::reflection_token)]
    fun paused_claims_block_automatic_transfer_materialisation(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::configure(assets, 10 * ONE, 1_000 * ONE, 0);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::sell_trfl(alice, ONE, 0, 1_000);
        let raw = reflection_token::raw_balance(signer::address_of(alice));
        reflection_token::set_pause_state(core, false, true);
        reflection_router::transfer(alice, signer::address_of(bob), raw + 1);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 6, location = reflection_core::reflection_token)]
    fun paused_claims_block_automatic_sell_materialisation(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::configure(assets, 10 * ONE, 1_000 * ONE, 0);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::sell_trfl(alice, ONE, 0, 1_000);
        let raw = reflection_token::raw_balance(signer::address_of(alice));
        reflection_token::set_pause_state(core, false, true);
        pool::sell_trfl(alice, raw + 1, 0, 1_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure(abort_code = 6, location = reflection_core::reflection_token)]
    fun claim_backed_wallet_claim_pause_blocks_explicit_claim(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::sell_trfl(alice, ONE, 0, 1_000);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) > 0, 300);
        reflection_token::set_pause_state(core, false, true);
        reflection_token::claim_all(alice);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    fun claim_backed_wallet_pause_does_not_block_raw_transfer_or_lp_claim(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::sell_trfl(alice, ONE, 0, 1_000);
        let wallet_pending = reflection_token::pending_rewards(
            signer::address_of(alice),
        );
        assert!(wallet_pending > 0, 301);
        reflection_token::set_pause_state(core, false, true);
        reflection_router::transfer(alice, signer::address_of(bob), ONE);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == ONE, 302);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == wallet_pending, 303);

        pool::checkpoint_lp_rewards(bob);
        let lp_pending = pool::pending_lp_rewards(
            1,
            signer::address_of(alice),
        );
        assert!(lp_pending > 0, 304);
        let alice_raw = reflection_token::raw_balance(signer::address_of(alice));
        pool::claim_lp_rewards(alice, 1, lp_pending);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == alice_raw + lp_pending, 305);
        let (_, claims_paused) = reflection_token::pauses();
        assert!(claims_paused, 306);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    fun all_publisher_and_operational_primary_stores_are_excluded(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_all_operational_admin(core, assets, amm, operator);
        assert!(reflection_token::primary_store_is_excluded(signer::address_of(core)), 310);
        assert!(reflection_token::primary_store_is_excluded(signer::address_of(assets)), 311);
        assert!(reflection_token::primary_store_is_excluded(signer::address_of(amm)), 312);
        assert!(reflection_token::primary_store_is_excluded(signer::address_of(operator)), 313);
        assert!(reflection_token::protocol_exclusions_remaining() == 0, 314);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator_one = @0x0bed,
        operator_two = @0x0bee,
    )]
    fun atomic_rotation_preserves_every_operational_exclusion(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator_one: &signer,
        operator_two: &signer,
    ) {
        setup(core, assets, amm, framework);
        let operator_one_address = signer::address_of(operator_one);
        let operator_two_address = signer::address_of(operator_two);
        pool::set_all_operational_admin(core, assets, amm, operator_one);
        pool::set_all_operational_admin(core, assets, amm, operator_two);
        assert!(reflection_token::operational_admin() == operator_two_address, 320);
        assert!(test_faucet::operational_admin() == operator_two_address, 321);
        assert!(pool::operational_admin() == operator_two_address, 322);
        assert!(reflection_token::primary_store_is_excluded(operator_one_address), 323);
        assert!(reflection_token::primary_store_is_excluded(operator_two_address), 324);
        assert!(reflection_token::protocol_exclusions_remaining() == 0, 325);

        // Rotating back is safe because exclusion is permanent and neither
        // operations profile can ever become a wallet or LP participant.
        pool::set_all_operational_admin(core, assets, amm, operator_one);
        assert!(reflection_token::operational_admin() == operator_one_address, 326);
        assert!(test_faucet::operational_admin() == operator_one_address, 327);
        assert!(pool::operational_admin() == operator_one_address, 328);
        assert!(reflection_token::primary_store_is_excluded(operator_two_address), 329);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        wrong_amm = @0xa44,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 2, location = test_amm::pool)]
    fun atomic_handoff_rolls_back_when_final_publisher_auth_fails(
        core: &signer,
        assets: &signer,
        amm: &signer,
        wrong_amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        // Core and faucet setters execute first. Failure at the final AMM
        // authentication boundary proves the coordinator is one transaction;
        // Move abort semantics roll all earlier writes and events back.
        pool::set_all_operational_admin(core, assets, wrong_amm, operator);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 35, location = reflection_core::reflection_token)]
    fun registered_wallet_cannot_become_operational_admin(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        reflection_token::register_wallet(operator);
        pool::set_all_operational_admin(core, assets, amm, operator);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 36, location = reflection_core::reflection_token)]
    fun funded_unregistered_wallet_cannot_become_operational_admin(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        let operator_address = signer::address_of(operator);
        reflection_token::fund_unregistered_primary_store_for_test(
            core,
            operator_address,
            ONE,
        );
        assert!(!reflection_token::wallet_is_registered(operator_address), 330);
        pool::set_all_operational_admin(core, assets, amm, operator);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 15, location = reflection_core::reflection_token)]
    fun operational_admin_cannot_register_as_wallet(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_all_operational_admin(core, assets, amm, operator);
        reflection_token::register_wallet(operator);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator_one = @0x0bed,
        operator_two = @0x0bee,
    )]
    #[expected_failure(abort_code = 15, location = reflection_core::reflection_token)]
    fun rotated_out_operational_admin_remains_ineligible(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator_one: &signer,
        operator_two: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_all_operational_admin(core, assets, amm, operator_one);
        pool::set_all_operational_admin(core, assets, amm, operator_two);
        reflection_token::register_wallet(operator_one);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1)]
    #[expected_failure(abort_code = 7, location = test_assets::test_faucet)]
    fun faucet_recovery_handoff_rejects_initial_core_publisher(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::set_operational_admin(assets, core);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1)]
    #[expected_failure(abort_code = 26, location = test_amm::pool)]
    fun amm_recovery_handoff_rejects_initial_core_publisher(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_operational_admin(amm, core);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1)]
    #[expected_failure(abort_code = 28, location = reflection_core::reflection_token)]
    fun package_publisher_cannot_be_new_operational_admin(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_all_operational_admin(core, assets, amm, core);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        zero = @0x0,
    )]
    #[expected_failure(abort_code = 28, location = reflection_core::reflection_token)]
    fun zero_address_cannot_be_new_operational_admin(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        zero: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_all_operational_admin(core, assets, amm, zero);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 15, location = reflection_core::reflection_token)]
    fun operational_admin_cannot_claim_trfl_from_faucet(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::set_all_operational_admin(core, assets, amm, operator);
        test_faucet::claim_trfl(operator);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 8, location = reflection_core::reflection_token)]
    fun operational_admin_cannot_receive_trfl_transfer(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        pool::set_all_operational_admin(core, assets, amm, operator);
        reflection_router::transfer(
            alice,
            signer::address_of(operator),
            ONE,
        );
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 19, location = test_amm::pool)]
    fun operational_admin_cannot_buy_trfl(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::set_all_operational_admin(core, assets, amm, operator);
        test_faucet::claim_tusd(operator);
        pool::buy_trfl(operator, ONE, 0, 1_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 19, location = test_amm::pool)]
    fun operational_admin_cannot_add_liquidity(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::set_all_operational_admin(core, assets, amm, operator);
        pool::add_liquidity(operator, ONE, ONE, 1, 1_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 19, location = test_amm::pool)]
    fun operational_admin_cannot_receive_lp_shares(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::set_all_operational_admin(core, assets, amm, operator);
        pool::transfer_lp_shares(
            alice,
            signer::address_of(operator),
            1,
        );
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    fun bootstrap_lp_is_bound_to_the_consenting_signer(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        reflection_token::register_wallet(bob);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        assert!(pool::lp_shares(1, signer::address_of(alice)) > 0, 340);
        assert!(pool::lp_shares(1, signer::address_of(bob)) == 0, 341);
        assert!(lp_rewards::has_ever_held_lp(signer::address_of(alice)), 342);
        assert!(!lp_rewards::has_ever_held_lp(signer::address_of(bob)), 343);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure(abort_code = 27, location = test_amm::pool)]
    fun historical_lp_participation_permanently_blocks_operational_role(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::sell_trfl(alice, ONE, 0, 1_000);
        pool::begin_shutdown(amm);
        let shares = pool::lp_shares(1, signer::address_of(alice));
        pool::remove_liquidity(alice, shares, 1, 1, 1_000);
        assert!(pool::lp_shares(1, signer::address_of(alice)) == 0, 344);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 345);
        pool::set_all_operational_admin(core, assets, amm, alice);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 19, location = test_amm::pool)]
    fun operational_admin_cannot_be_reseed_lp_beneficiary(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::begin_shutdown(amm);
        let shares = pool::lp_shares(1, signer::address_of(alice));
        pool::remove_liquidity(alice, shares, 1, 1, 1_000);
        pool::set_all_operational_admin(core, assets, amm, operator);
        pool::reseed_liquidity(core, amm, operator, 50 * ONE, 50 * ONE, 1);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 33, location = reflection_core::reflection_token)]
    fun protocol_exclusion_slots_close_after_bootstrap(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        reflection_token::register_protocol_publisher_store(core, alice);
    }

    #[test(core = @0xcafe, alice = @0xa11ce)]
    #[expected_failure(abort_code = 25, location = reflection_core::reflection_token)]
    fun registered_wallet_cannot_consent_to_exclusion(core: &signer, alice: &signer) {
        reflection_token::initialize_for_test(core);
        reflection_token::register_wallet(alice);
        reflection_token::register_protocol_publisher_store(core, alice);
    }

    #[test(core = @0xcafe, alice = @0xa11ce)]
    #[expected_failure(abort_code = 34, location = reflection_core::reflection_token)]
    fun arbitrary_cosigner_cannot_consume_protocol_exclusion_slot(
        core: &signer,
        alice: &signer,
    ) {
        reflection_token::initialize_for_test(core);
        reflection_token::register_protocol_publisher_store(core, alice);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1)]
    #[expected_failure(abort_code = 15, location = reflection_core::reflection_token)]
    fun excluded_operator_cannot_claim_trfl_from_faucet(core: &signer, assets: &signer, amm: &signer, framework: &signer) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(core);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure]
    fun direct_core_reward_vault_deposit_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        let source = primary_fungible_store::primary_store(
            signer::address_of(alice),
            reflection_token::metadata(),
        );
        dispatchable_fungible_asset::transfer(
            alice,
            source,
            reflection_token::reward_vault(),
            ONE,
        );
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure]
    fun direct_core_distribution_vault_deposit_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        let source = primary_fungible_store::primary_store(
            signer::address_of(alice),
            reflection_token::metadata(),
        );
        dispatchable_fungible_asset::transfer(
            alice,
            source,
            reflection_token::distribution_vault(),
            ONE,
        );
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure]
    fun direct_core_distribution_vault_withdrawal_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        let destination = primary_fungible_store::primary_store(
            signer::address_of(alice),
            reflection_token::metadata(),
        );
        dispatchable_fungible_asset::transfer(
            core,
            reflection_token::distribution_vault(),
            destination,
            ONE,
        );
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure]
    fun direct_core_reward_vault_withdrawal_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::sell_trfl(alice, ONE, 0, 1_000);
        assert!(reflection_token::reward_vault_balance() > 0, 307);
        let destination = primary_fungible_store::primary_store(
            signer::address_of(alice),
            reflection_token::metadata(),
        );
        dispatchable_fungible_asset::transfer(
            core,
            reflection_token::reward_vault(),
            destination,
            1,
        );
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure]
    fun direct_rfl_reserve_deposit_is_blocked(core: &signer, assets: &signer, amm: &signer, framework: &signer, alice: &signer) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        let source = primary_fungible_store::primary_store(signer::address_of(alice), reflection_token::metadata());
        dispatchable_fungible_asset::transfer(alice, source, pool::rfl_reserve_store(), ONE);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure]
    fun direct_tusd_reserve_deposit_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_tusd(alice);
        let source = primary_fungible_store::primary_store(
            signer::address_of(alice), mock_usd::metadata(),
        );
        fungible_asset::transfer(alice, source, pool::usd_reserve_store(), ONE);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure]
    fun direct_tusd_reserve_withdrawal_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        let destination = primary_fungible_store::primary_store(
            signer::address_of(alice), mock_usd::metadata(),
        );
        fungible_asset::transfer(
            alice, pool::usd_reserve_store(), destination, ONE,
        );
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 4, location = test_assets::mock_usd)]
    fun pool_usd_capability_is_bound_to_exact_reserve(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        let constructor = object::create_object(signer::address_of(amm));
        let foreign_store = fungible_asset::create_store(
            &constructor, mock_usd::metadata(),
        );
        pool::attempt_usd_withdraw_from_store_for_test(
            foreign_store, signer::address_of(alice), 1,
        );
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 25, location = test_amm::pool)]
    fun amm_limits_are_operational_admin_only(core: &signer, assets: &signer, amm: &signer, framework: &signer, alice: &signer) {
        setup(core, assets, amm, framework);
        pool::configure_limits(alice, 30, 2_000, 100 * ONE);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 25, location = test_amm::pool)]
    fun liquidity_limits_are_operational_admin_only(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::configure_liquidity_limits(alice, 10 * ONE, 10 * ONE, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 29, location = reflection_core::reflection_token)]
    fun reflection_fee_is_operational_admin_only(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        reflection_token::set_fee_bps(alice, 0);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    fun publisher_handoff_assigns_all_routine_controls(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        let operator_address = signer::address_of(operator);
        pool::set_all_operational_admin(core, assets, amm, operator);
        assert!(reflection_token::operational_admin() == operator_address, 500);
        assert!(test_faucet::operational_admin() == operator_address, 501);
        assert!(pool::operational_admin() == operator_address, 502);

        reflection_token::set_fee_bps(operator, 75);
        reflection_token::set_pause_state(operator, true, false);
        test_faucet::configure(operator, 2 * ONE, 3 * ONE, 60);
        pool::configure_limits(operator, 25, 1_500, 10 * ONE);
        pool::configure_liquidity_limits(operator, 20 * ONE, 30 * ONE, 2_500);
        pool::configure_pauses(operator, true, true, true);

        assert!(reflection_token::fee_bps() == 75, 503);
        let (swaps_paused, claims_paused) = reflection_token::pauses();
        assert!(swaps_paused && !claims_paused, 504);
        let (trfl_grant, tusd_grant, cooldown) = test_faucet::configuration();
        assert!(trfl_grant == 2 * ONE && tusd_grant == 3 * ONE && cooldown == 60, 505);
        let (amm_fee, reserve_bps, max_swap) = pool::limits();
        assert!(amm_fee == 25 && reserve_bps == 1_500 && max_swap == 10 * ONE, 506);
        let (max_rfl, max_usd, max_withdrawal_bps) = pool::liquidity_limits();
        assert!(max_rfl == 20 * ONE && max_usd == 30 * ONE && max_withdrawal_bps == 2_500, 507);
        let (pool_paused, liquidity_paused, lp_claims_paused, shutdown_mode, seeded) =
            pool::pause_state();
        assert!(pool_paused && liquidity_paused && lp_claims_paused, 508);
        assert!(!shutdown_mode && !seeded, 509);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 29, location = reflection_core::reflection_token)]
    fun core_publisher_loses_routine_authority_after_handoff(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        reflection_token::set_operational_admin(core, operator);
        reflection_token::set_fee_bps(core, 0);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 6, location = test_assets::test_faucet)]
    fun asset_publisher_loses_routine_authority_after_handoff(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        reflection_token::set_operational_admin(core, operator);
        test_faucet::set_operational_admin(assets, operator);
        test_faucet::configure(assets, ONE, ONE, 0);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        operator = @0x0bed,
    )]
    #[expected_failure(abort_code = 25, location = test_amm::pool)]
    fun amm_publisher_loses_routine_authority_after_handoff(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        operator: &signer,
    ) {
        setup(core, assets, amm, framework);
        reflection_token::set_operational_admin(core, operator);
        pool::set_operational_admin(amm, operator);
        pool::configure_limits(amm, 30, 2_000, 100 * ONE);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1)]
    #[expected_failure(abort_code = 11, location = reflection_core::reflection_token)]
    fun canonical_custody_binding_cannot_be_registered_twice(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, framework);
        let unexpected_cap = reflection_token::register_canonical_custody(
            core,
            amm,
            pool::rfl_reserve_store(),
            lp_rewards::reward_vault(1),
        );
        custody_registry::destroy_capability_for_test(unexpected_cap);
    }

    #[test(core = @0xcafe)]
    #[expected_failure(abort_code = 22, location = reflection_core::reflection_token)]
    fun funded_custody_reserve_cannot_be_registered(core: &signer) {
        reflection_token::initialize_for_test(core);
        let vault_constructor = object::create_object(signer::address_of(core));
        let empty_vault = fungible_asset::create_store(
            &vault_constructor, reflection_token::metadata(),
        );
        let unexpected_cap = reflection_token::register_canonical_custody(
            core,
            core,
            reflection_token::distribution_vault(),
            empty_vault,
        );
        custody_registry::destroy_capability_for_test(unexpected_cap);
    }

    #[test(core = @0xcafe)]
    #[expected_failure(abort_code = 22, location = reflection_core::reflection_token)]
    fun funded_lp_reward_vault_cannot_be_registered(core: &signer) {
        reflection_token::initialize_for_test(core);
        let reserve_constructor = object::create_object(signer::address_of(core));
        let empty_reserve = fungible_asset::create_store(
            &reserve_constructor, reflection_token::metadata(),
        );
        let unexpected_cap = reflection_token::register_canonical_custody(
            core,
            core,
            empty_reserve,
            reflection_token::distribution_vault(),
        );
        custody_registry::destroy_capability_for_test(unexpected_cap);
    }

    #[test(core = @0xcafe, alice = @0xa11ce)]
    #[expected_failure(abort_code = 30, location = reflection_core::reflection_token)]
    fun registered_wallet_store_cannot_be_reclassified_as_custody(
        core: &signer,
        alice: &signer,
    ) {
        reflection_token::initialize_for_test(core);
        reflection_token::register_wallet(alice);
        let wallet_store = primary_fungible_store::primary_store(
            signer::address_of(alice), reflection_token::metadata(),
        );
        let vault_constructor = object::create_object(signer::address_of(alice));
        let empty_vault = fungible_asset::create_store(
            &vault_constructor, reflection_token::metadata(),
        );
        let unexpected_cap = reflection_token::register_canonical_custody(
            core, alice, wallet_store, empty_vault,
        );
        custody_registry::destroy_capability_for_test(unexpected_cap);
    }

    #[test(core = @0xcafe)]
    #[expected_failure(abort_code = 30, location = reflection_core::reflection_token)]
    fun one_store_cannot_be_both_reserve_and_reward_vault(core: &signer) {
        reflection_token::initialize_for_test(core);
        let store_constructor = object::create_object(signer::address_of(core));
        let store = fungible_asset::create_store(
            &store_constructor, reflection_token::metadata(),
        );
        let unexpected_cap = reflection_token::register_canonical_custody(
            core, core, store, store,
        );
        custody_registry::destroy_capability_for_test(unexpected_cap);
    }

    #[test(core = @0xcafe, alice = @0xa11ce)]
    #[expected_failure(abort_code = 31, location = reflection_core::reflection_token)]
    fun custody_registration_requires_store_owner_signature(
        core: &signer,
        alice: &signer,
    ) {
        reflection_token::initialize_for_test(core);
        let reserve_constructor = object::create_object(signer::address_of(core));
        let reserve = fungible_asset::create_store(
            &reserve_constructor, reflection_token::metadata(),
        );
        let vault_constructor = object::create_object(signer::address_of(core));
        let vault = fungible_asset::create_store(
            &vault_constructor, reflection_token::metadata(),
        );
        let unexpected_cap = reflection_token::register_canonical_custody(
            core, alice, reserve, vault,
        );
        custody_registry::destroy_capability_for_test(unexpected_cap);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1)]
    #[expected_failure(abort_code = 1, location = test_amm::pool)]
    fun pool_initialization_is_one_shot(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::initialize(core, assets, amm);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    #[expected_failure(abort_code = 22, location = test_amm::pool)]
    fun liquidity_contribution_cap_is_enforced(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_tusd(amm);
        test_faucet::claim_tusd(bob);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::configure_liquidity_limits(amm, 5 * ONE, 5 * ONE, 10_000);
        pool::add_liquidity(bob, 10 * ONE, 10 * ONE, 1, 1_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    #[expected_failure(abort_code = 23, location = test_amm::pool)]
    fun liquidity_withdrawal_share_cap_is_enforced(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_tusd(amm);
        test_faucet::claim_tusd(bob);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::add_liquidity(bob, 100 * ONE, 100 * ONE, 1, 1_000);
        pool::configure_liquidity_limits(amm, 100 * ONE, 100 * ONE, 1_000);
        let bob_shares = pool::lp_shares(1, signer::address_of(bob));
        pool::remove_liquidity(bob, bob_shares, 1, 1, 1_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    #[expected_failure(abort_code = 11, location = test_amm::pool)]
    fun independent_liquidity_pause_blocks_additions(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_tusd(amm);
        test_faucet::claim_tusd(bob);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::configure_pauses(amm, false, true, false);
        pool::add_liquidity(bob, 10 * ONE, 10 * ONE, 1, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1)]
    #[expected_failure(abort_code = 14, location = test_amm::pool)]
    fun unseeded_pool_quote_fails_cleanly(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
    ) {
        setup(core, assets, amm, framework);
        pool::quote_sell(ONE);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 4, location = test_amm::pool)]
    fun zero_value_swap_is_rejected(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::sell_trfl(alice, 0, 0, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 5, location = test_amm::pool)]
    fun expired_swap_deadline_is_rejected(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        timestamp::update_global_time_for_test_secs(10);
        pool::sell_trfl(alice, ONE, 0, 9);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 7, location = test_amm::pool)]
    fun maximum_gross_swap_limit_is_enforced(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::configure_limits(amm, 30, 10_000, ONE - 1);
        pool::sell_trfl(alice, ONE, 0, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 8, location = test_amm::pool)]
    fun maximum_reserve_percentage_limit_is_enforced(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::configure_limits(amm, 30, 100, 100 * ONE);
        pool::sell_trfl(alice, 2 * ONE, 0, 1_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        buyer = @0xb0b,
    )]
    #[expected_failure(abort_code = 6, location = test_amm::pool)]
    fun buy_slippage_uses_net_user_receipt(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        buyer: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        test_faucet::claim_tusd(buyer);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        let (net_output, _, _) = pool::quote_buy(ONE);
        pool::buy_trfl(buyer, ONE, net_output + 1, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 10, location = test_amm::pool)]
    fun independent_pool_pause_blocks_swaps(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::configure_pauses(amm, true, false, false);
        pool::sell_trfl(alice, ONE, 0, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 10, location = test_amm::pool)]
    fun core_swap_pause_also_blocks_quotes(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        reflection_token::set_pause_state(core, true, false);
        pool::quote_sell(ONE);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    fun final_shutdown_exit_bypasses_withdrawal_share_cap(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::configure_liquidity_limits(amm, ONE, ONE, 1);
        let all_shares = pool::lp_shares(1, signer::address_of(alice));
        pool::begin_shutdown(amm);
        pool::remove_liquidity(alice, all_shares, 1, 1, 1_000);
        let (rfl, usd) = pool::reserves_view();
        assert!(rfl == 0 && usd == 0, 400);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure(abort_code = 12, location = test_amm::pool)]
    fun lp_claim_pause_blocks_shutdown_before_state_mutation(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, alice, ONE, ONE, 1);
        pool::configure_pauses(amm, false, true, true);
        pool::begin_shutdown(amm);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    fun unpaused_shutdown_fragmented_exit_bypasses_tiny_cap_and_one_sided_floor(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::configure(assets, 1, 100, 0);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(core, amm, alice, 1, 100, 1);
        pool::transfer_lp_shares(alice, signer::address_of(bob), 5);
        assert!(pool::lp_shares(1, signer::address_of(alice)) == 5, 401);
        assert!(pool::lp_shares(1, signer::address_of(bob)) == 5, 402);
        pool::configure_liquidity_limits(amm, 1, 100, 1);

        // The pause must be explicitly cleared before shutdown can begin.
        pool::configure_pauses(amm, false, true, true);
        pool::configure_pauses(amm, false, true, false);
        pool::begin_shutdown(amm);

        pool::remove_liquidity(bob, 5, 0, 50, 1_000);
        let (mid_rfl, mid_usd) = pool::reserves_view();
        assert!(mid_rfl == 1 && mid_usd == 50, 403);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == 0, 404);
        assert!(
            primary_fungible_store::balance(
                signer::address_of(bob),
                mock_usd::metadata(),
            ) == 50,
            405,
        );

        pool::remove_liquidity(alice, 5, 1, 50, 1_000);
        let (final_rfl, final_usd) = pool::reserves_view();
        assert!(final_rfl == 0 && final_usd == 0, 406);
        assert!(pool::active_epoch() == 0, 407);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    #[expected_failure(abort_code = 4, location = test_amm::pool)]
    fun normal_operation_rejects_one_sided_rounded_liquidity_output(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::configure(assets, 1, 100, 0);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(core, amm, alice, 1, 100, 1);
        pool::transfer_lp_shares(alice, signer::address_of(bob), 5);
        pool::remove_liquidity(bob, 5, 0, 50, 1_000);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    #[expected_failure(abort_code = 6, location = test_amm::pool)]
    fun shutdown_one_sided_output_still_honors_zero_side_minimum(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::configure(assets, 1, 100, 0);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(core, amm, alice, 1, 100, 1);
        pool::transfer_lp_shares(alice, signer::address_of(bob), 5);
        pool::begin_shutdown(amm);
        pool::remove_liquidity(bob, 5, 1, 50, 1_000);
    }

    #[test(core = @0xcafe, assets = @0xbabe, amm = @0xdead, framework = @0x1, alice = @0xa11ce)]
    #[expected_failure(abort_code = 10, location = test_amm::pool)]
    fun paused_swaps_cannot_settle(core: &signer, assets: &signer, amm: &signer, framework: &signer, alice: &signer) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        reflection_token::set_pause_state(core, true, false);
        pool::sell_trfl(alice, ONE, 0, 1_000);
    }
}
