#[test_only]
module integration_tests::wallet_lp_accounting_tests {
    use cedra_framework::dispatchable_fungible_asset;
    use cedra_framework::primary_fungible_store;
    use cedra_framework::timestamp;
    use reflection_core::reflection_token;
    use reflection_core::reflection_math;
    use std::signer;
    use test_amm::lp_rewards;
    use test_amm::pool;
    use test_assets::mock_usd;
    use test_assets::test_faucet;

    const ONE: u64 = 1_000_000;
    const TRILLION: u64 = 1_000_000_000_000;

    fun setup(core: &signer, assets: &signer, amm: &signer, framework: &signer) {
        timestamp::set_time_has_started_for_testing(framework);
        reflection_token::initialize_for_test(core);
        mock_usd::initialize_for_test(assets);
        test_faucet::initialize(core, assets);
        pool::initialize(core, assets, amm);
        test_faucet::configure(assets, 1_000 * ONE, 1_000 * ONE, 0);
    }

    fun setup_claim_backed(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
    ) {
        timestamp::set_time_has_started_for_testing(framework);
        reflection_token::initialize_claim_backed_for_test(core);
        mock_usd::initialize_for_test(assets);
        test_faucet::initialize(core, assets);
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
    fun full_lp_transfer_auto_pays_sender_before_zeroing(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        test_faucet::configure(assets, 10 * ONE, 100 * ONE, 0);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        pool::checkpoint_lp_rewards(bob);
        let pending = pool::pending_lp_rewards(1, signer::address_of(alice));
        assert!(pending > 0, 901);
        let alice_raw = reflection_token::raw_balance(signer::address_of(alice));
        let shares = pool::lp_shares(1, signer::address_of(alice));

        pool::transfer_lp_shares(alice, signer::address_of(bob), shares);

        assert!(pool::lp_shares(1, signer::address_of(alice)) == 0, 902);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 903);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == alice_raw + pending, 904);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 905);
        reflection_token::assert_accounting_backing();
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        lp0 = @0x1000,
        lp1 = @0x1001,
        lp2 = @0x1002,
        lp3 = @0x1003,
        lp4 = @0x1004,
        lp5 = @0x1005,
        lp6 = @0x1006,
        lp7 = @0x1007,
        lp8 = @0x1008,
        lp9 = @0x1009,
        trader = @0x7ade,
        fresh_lp = @0xf123,
    )]
    fun ten_fragmented_positions_classify_nine_terminal_units(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        lp0: &signer,
        lp1: &signer,
        lp2: &signer,
        lp3: &signer,
        lp4: &signer,
        lp5: &signer,
        lp6: &signer,
        lp7: &signer,
        lp8: &signer,
        lp9: &signer,
        trader: &signer,
        fresh_lp: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        test_faucet::configure(assets, 900, 1_010, 0);
        test_faucet::claim_trfl(trader);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(core, amm, lp0, 1_000, 1_000, 1);
        reflection_token::register_wallet(lp1);
        reflection_token::register_wallet(lp2);
        reflection_token::register_wallet(lp3);
        reflection_token::register_wallet(lp4);
        reflection_token::register_wallet(lp5);
        reflection_token::register_wallet(lp6);
        reflection_token::register_wallet(lp7);
        reflection_token::register_wallet(lp8);
        reflection_token::register_wallet(lp9);
        pool::transfer_lp_shares(lp0, signer::address_of(lp1), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp2), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp3), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp4), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp5), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp6), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp7), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp8), 100);
        pool::transfer_lp_shares(lp0, signer::address_of(lp9), 100);

        pool::configure_limits(amm, 30, 10_000, 1_000);
        pool::sell_trfl(trader, 900, 0, 1_000);
        pool::checkpoint_lp_rewards(lp0);
        let (_, _, _, shares_before, _, _, received_before, _, liability_before) =
            pool::lp_epoch_accounting(1);
        assert!(shares_before == 1_000, 920);
        assert!(received_before == 9 && liability_before == 9, 921);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp0)) == 0, 922);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp1)) == 0, 923);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp2)) == 0, 924);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp3)) == 0, 925);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp4)) == 0, 926);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp5)) == 0, 927);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp6)) == 0, 928);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp7)) == 0, 929);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp8)) == 0, 930);
        assert!(pool::pending_lp_rewards(1, signer::address_of(lp9)) == 0, 931);

        pool::begin_shutdown(amm);
        pool::remove_liquidity(lp1, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp2, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp3, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp4, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp5, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp6, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp7, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp8, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp9, 100, 1, 1, 1_000);
        pool::remove_liquidity(lp0, 100, 1, 1, 1_000);

        let (status, _, _, terminal_shares, unallocated, rounding, received,
            claimed, liability) = pool::lp_epoch_accounting(1);
        assert!(status == 2 && terminal_shares == 0, 932);
        assert!(unallocated == 0 && rounding == 9 && liability == 0, 933);
        assert!(received == 9 && claimed == 0, 934);
        let (terminal_rounding, retired_residue_magnified) =
            pool::lp_epoch_terminal_dust(1);
        assert!(terminal_rounding == 9, 935);
        assert!(
            retired_residue_magnified
                == 9 * reflection_math::magnitude(),
            936,
        );
        assert!(pool::lp_reward_vault_balance(1) == 9, 937);

        pool::reseed_liquidity(core, amm, fresh_lp, 10, 10, 1);
        assert!(pool::active_epoch() == 2, 938);
        assert!(pool::pending_lp_rewards(2, signer::address_of(fresh_lp)) == 0, 939);
        assert!(pool::lp_reward_vault_balance(2) == 0, 940);
        assert!(pool::lp_reward_vault_balance(1) == 9, 941);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    #[expected_failure(abort_code = 12, location = test_amm::pool)]
    fun lp_claim_pause_blocks_full_transfer_that_requires_auto_payment(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        test_faucet::configure(assets, 10 * ONE, 100 * ONE, 0);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        reflection_token::register_wallet(bob);
        pool::seed_liquidity(core, amm, alice, 100 * ONE, 100 * ONE, 1);
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        pool::checkpoint_lp_rewards(bob);
        pool::configure_pauses(amm, false, false, true);
        let shares = pool::lp_shares(1, signer::address_of(alice));
        pool::transfer_lp_shares(alice, signer::address_of(bob), shares);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        caller = @0xc011,
    )]
    fun custody_checkpoint_routes_exactly_and_lp_claim_starts_at_current_index(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        caller: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::configure(assets, 10 * ONE, 1_000 * ONE, 0);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );

        // Selling Alice's complete wallet position leaves the pre-trade pool
        // as the sole global reward position. The 1% fee therefore belongs to
        // custody exactly once.
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        let expected = ONE / 10;
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == 0, 10);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 11);
        assert!(reflection_token::pool_pending_rewards() == expected, 12);
        assert!(reflection_token::reward_vault_balance() == expected, 13);
        assert!(pool::lp_reward_vault_balance(1) == 0, 14);
        let (rfl_before, usd_before) = pool::reserves_view();

        pool::checkpoint_lp_rewards(caller);

        let (rfl_after, usd_after) = pool::reserves_view();
        let (_, routed, _) = reflection_token::custody_accounting();
        assert!(rfl_after == rfl_before && usd_after == usd_before, 20);
        assert!(reflection_token::pool_pending_rewards() == 0, 21);
        assert!(reflection_token::reward_vault_balance() == 0, 22);
        assert!(routed == (expected as u256), 23);
        assert!(pool::lp_reward_vault_balance(1) == expected, 24);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == expected, 25);

        let global_pending_before_claim = reflection_token::pending_rewards(signer::address_of(alice));
        let partial = expected / 2;
        pool::claim_lp_rewards(alice, 1, partial);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == partial, 30);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == global_pending_before_claim, 31);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == expected - partial, 32);
        assert!(pool::lp_reward_vault_balance(1) == expected - partial, 33);
        let (_, _, _, _, partial_unallocated, partial_rounding, partial_received,
            partial_claimed, partial_liability) = pool::lp_epoch_accounting(1);
        assert!(partial_unallocated == 0 && partial_rounding == 0, 331);
        assert!(partial_received == (expected as u256), 332);
        assert!(partial_claimed == (partial as u256), 333);
        assert!(partial_liability == ((expected - partial) as u256), 334);

        pool::claim_lp_rewards(alice, 1, 0);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == expected, 335);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == global_pending_before_claim, 336);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 337);
        assert!(pool::lp_reward_vault_balance(1) == 0, 338);
        let (_, _, _, _, unallocated, rounding, received, claimed, liability) =
            pool::lp_epoch_accounting(1);
        assert!(unallocated == 0 && rounding == 0, 34);
        assert!(received == (expected as u256) && claimed == (expected as u256), 35);
        assert!(liability == 0, 36);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        buyer = @0xb0b,
    )]
    fun buy_removes_pool_units_before_fee_and_credits_buyer_after_fee(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        buyer: &signer,
    ) {
        setup(core, assets, amm, framework);
        // Alice owns the LP position but has no wallet tRFL. Before the buy,
        // the canonical custody position is the only global denominator.
        reflection_token::register_wallet(alice);
        test_faucet::claim_tusd(amm);
        test_faucet::claim_tusd(buyer);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );

        let (net_output, fee, _) = pool::quote_buy(ONE);
        assert!(net_output > 0 && fee > 0, 37);
        pool::buy_trfl(buyer, ONE, net_output, 1_000);

        // The post-withdraw pool units receive the fee; the newly purchased
        // units enter at the advanced index and receive no history.
        assert!(reflection_token::raw_balance(signer::address_of(buyer)) == net_output, 38);
        assert!(reflection_token::pending_rewards(signer::address_of(buyer)) == 0, 39);
        let pool_pending = reflection_token::pool_pending_rewards();
        let (_, _, core_rounding) = reflection_token::custody_accounting();
        assert!(pool_pending + (core_rounding as u64) == fee, 391);
        pool::checkpoint_lp_rewards(alice);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == pool_pending, 392);
        assert!(reflection_token::pool_pending_rewards() == 0, 393);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    fun checkpoint_before_mint_and_transfer_prevents_historical_capture(
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

        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        assert!(reflection_token::pool_pending_rewards() > 0, 40);

        // The add operation routes pre-existing custody reward before Bob's
        // shares are minted. Bob cannot capture any of that history.
        pool::add_liquidity(bob, 100 * ONE, 100 * ONE, 1, 1_000);
        let alice_history = pool::pending_lp_rewards(1, signer::address_of(alice));
        assert!(alice_history > 0, 41);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 42);

        // A module-mediated transfer at the same LP index preserves the
        // sender's history and gives the recipient no historical entitlement.
        let alice_shares = pool::lp_shares(1, signer::address_of(alice));
        let transferred = alice_shares / 2;
        pool::transfer_lp_shares(alice, signer::address_of(bob), transferred);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == alice_history, 43);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 44);

        // Both current positions participate in later fees.
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        pool::checkpoint_lp_rewards(bob);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) > alice_history, 45);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) > 0, 46);
        assert!(
            pool::total_lp_shares()
                == pool::lp_shares(1, signer::address_of(alice))
                    + pool::lp_shares(1, signer::address_of(bob)),
            47,
        );
        let (raw_reserve, _) = pool::reserves_view();
        let (custody_shares, _, _) = reflection_token::custody_accounting();
        assert!((raw_reserve as u128) == custody_shares, 48);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
        trader = @0x7ade,
    )]
    fun full_position_burn_auto_pays_pre_burn_lp_reward(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
        trader: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_trfl(trader);
        test_faucet::claim_tusd(amm);
        test_faucet::claim_tusd(bob);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::add_liquidity(bob, 100 * ONE, 100 * ONE, 1, 1_000);
        let bob_shares = pool::lp_shares(1, signer::address_of(bob));
        assert!(bob_shares > 0, 50);

        pool::sell_trfl(trader, 10 * ONE, 0, 1_000);
        pool::checkpoint_lp_rewards(trader);
        let pending_before_burn = pool::pending_lp_rewards(1, signer::address_of(bob));
        assert!(pending_before_burn > 0, 51);
        let bob_raw_before = reflection_token::raw_balance(signer::address_of(bob));
        let (reserve_before, _) = pool::reserves_view();

        pool::remove_liquidity(bob, bob_shares, 1, 1, 1_000);
        assert!(pool::lp_shares(1, signer::address_of(bob)) == 0, 52);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 53);
        assert!(pool::total_lp_shares() == pool::lp_shares(1, signer::address_of(alice)), 54);
        let (raw_reserve, _) = pool::reserves_view();
        assert!(
            reflection_token::raw_balance(signer::address_of(bob))
                == bob_raw_before + (reserve_before - raw_reserve) + pending_before_burn,
            531,
        );
        let (custody_shares, _, _) = reflection_token::custody_accounting();
        assert!((raw_reserve as u128) == custody_shares, 55);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    fun same_owner_receives_old_epoch_claim_before_joining_fresh_epoch(
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
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);

        let epoch_one_shares = pool::lp_shares(1, signer::address_of(alice));
        pool::begin_shutdown(amm);
        pool::remove_liquidity(alice, epoch_one_shares, 1, 1, 1_000);
        assert!(pool::active_epoch() == 0, 60);
        let (rfl_after_exit, usd_after_exit) = pool::reserves_view();
        assert!(rfl_after_exit == 0 && usd_after_exit == 0, 61);
        let (custody_after_exit, _, _) = reflection_token::custody_accounting();
        assert!(custody_after_exit == 0 && reflection_token::pool_pending_rewards() == 0, 62);
        let old_pending = pool::pending_lp_rewards(1, signer::address_of(alice));
        assert!(old_pending == 0, 63);
        let (_, old_negative, old_correction, old_routed, _) =
            reflection_token::custody_position_accounting();
        let old_normalized = old_routed * reflection_math::magnitude();
        assert!(!old_negative && old_correction > old_normalized, 631);

        pool::reseed_liquidity(
            core, amm, alice, 50 * ONE, 50 * ONE, 1,
        );
        assert!(pool::active_epoch() == 2, 64);
        let (status, index, remainder, shares, unallocated, rounding, received, claimed, liability) =
            pool::lp_epoch_accounting(2);
        assert!(status == 1 && index == 0 && remainder == 0, 65);
        assert!(shares > 0 && unallocated == 0 && rounding == 0, 66);
        assert!(received == 0 && claimed == 0 && liability == 0, 67);
        assert!(pool::lp_reward_vault_balance(2) == 0, 68);
        assert!(pool::pending_lp_rewards(2, signer::address_of(alice)) == 0, 680);
        let (new_custody_shares, _, _) = reflection_token::custody_accounting();
        let (_, new_negative, new_correction, cumulative_routed, new_pending) =
            reflection_token::custody_position_accounting();
        let (global_index, _, _, _, _, _) = reflection_token::global_accounting();
        let magnified_after_reseed = if (new_negative) {
            (new_custody_shares as u256) * global_index - new_correction
        } else {
            (new_custody_shares as u256) * global_index + new_correction
        };
        assert!(
            magnified_after_reseed == cumulative_routed * reflection_math::magnitude(),
            681,
        );
        assert!(new_pending == 0, 682);

        let (fresh_rfl, fresh_usd) = pool::reserves_view();
        assert!(fresh_rfl == 50 * ONE && fresh_usd == 50 * ONE, 69);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 70);
        assert!(pool::lp_reward_vault_balance(1) == 0, 71);
        let (_, index_after, remainder_after, _, _, _, received_after, _, liability_after) =
            pool::lp_epoch_accounting(2);
        assert!(index_after == 0 && remainder_after == 0, 72);
        assert!(received_after == 0 && liability_after == 0, 73);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    fun repeated_tiny_fees_name_every_base_unit_across_both_vaults(
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

        let i = 0;
        while (i < 50) {
            // 101 base units produces a one-base-unit reflection fee.
            pool::sell_trfl(alice, 101, 0, 1_000);
            if (i % 7 == 0) pool::checkpoint_lp_rewards(alice);
            let (_, _, _, core_unallocated, _, _) = reflection_token::global_accounting();
            let (_, _, core_rounding) = reflection_token::custody_accounting();
            assert!(
                (reflection_token::reward_vault_balance() as u256)
                    == reflection_token::aggregate_indexed_liability()
                        + (core_unallocated as u256)
                        + (core_rounding as u256),
                80,
            );
            let (raw_reserve, _) = pool::reserves_view();
            let (custody_shares, _, _) = reflection_token::custody_accounting();
            assert!((raw_reserve as u128) == custody_shares, 81);
            i = i + 1;
        };
        pool::checkpoint_lp_rewards(alice);

        let (_, _, _, _, lp_unallocated, lp_rounding, lp_received, lp_claimed, lp_liability) =
            pool::lp_epoch_accounting(1);
        assert!(
            (pool::lp_reward_vault_balance(1) as u256)
                == lp_liability + (lp_unallocated as u256) + (lp_rounding as u256),
            82,
        );
        assert!(
            (reflection_token::reward_vault_balance() as u256)
                + (pool::lp_reward_vault_balance(1) as u256)
                == 50,
            83,
        );
        assert!(lp_received - lp_claimed == (pool::lp_reward_vault_balance(1) as u256), 84);
    }

    // Mirrors python/test_vectors/basic_accounting.json exactly. This is the
    // cross-implementation conformance proof: the independent Python model
    // and the Move package execute the same economic operations and must land
    // on the same indexes, corrections-derived liabilities, raw balances,
    // custody route, LP epoch, and pending rewards.
    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
        carol = @0xca401,
    )]
    fun python_vector_wallet_custody_lp_conformance(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
        carol: &signer,
    ) {
        setup(core, assets, amm, framework);

        // faucet_grant(alice, 200_000), plus the bootstrap quote balance
        test_faucet::configure(assets, 200_000, 2_000_000, 0);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);

        // faucet_grant(bob, 300_000), mint_quote(bob, 100_000)
        test_faucet::configure(assets, 300_000, 100_000, 0);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_tusd(bob);

        // faucet_grant(carol, 100_000), mint_quote(carol, 100_000)
        test_faucet::configure(assets, 100_000, 100_000, 0);
        test_faucet::claim_trfl(carol);
        test_faucet::claim_tusd(carol);

        pool::seed_liquidity(
            core, amm, alice, 400_000, 800_000, 1,
        );
        pool::sell_trfl(bob, 10_000, 0, 1_000);
        pool::checkpoint_lp_rewards(bob);
        pool::add_liquidity(carol, 10_000, 20_000, 1, 1_000);
        pool::sell_trfl(alice, 7_000, 0, 1_000);
        pool::transfer_lp_shares(alice, signer::address_of(bob), 5_000);
        pool::claim_lp_rewards(alice, 1, 0);
        pool::buy_trfl(carol, 10_000, 0, 1_000);

        let (index, index_remainder, total_shares, unallocated, lifetime_fees,
            lifetime_materialized) = reflection_token::global_accounting();
        assert!(index == 224800605564355428909, 110);
        assert!(index_remainder == 404402, 111);
        assert!(total_shares == 999846, 112);
        assert!(unallocated == 0, 113);
        assert!(lifetime_fees == 223, 114);
        assert!(lifetime_materialized == 0, 115);

        let (custody_shares, lifetime_routed, core_rounding) =
            reflection_token::custody_accounting();
        assert!(custody_shares == 421490, 116);
        assert!(lifetime_routed == 70, 117);
        assert!(core_rounding == 1, 118);
        let (_, _, _, custody_settled, custody_pending) =
            reflection_token::custody_position_accounting();
        assert!(custody_settled == 70 && custody_pending == 22, 119);

        assert!(reflection_token::raw_balance(signer::address_of(alice)) == 193069, 120);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == 290000, 121);
        assert!(reflection_token::raw_balance(signer::address_of(carol)) == 95287, 122);
        let (pool_rfl, _) = pool::reserves_view();
        assert!(pool_rfl == 421490, 123);
        assert!(reflection_token::reward_vault_balance() == 153, 124);
        assert!(pool::lp_reward_vault_balance(1) == 1, 125);
        assert!(
            reflection_token::raw_store_balance(reflection_token::distribution_vault())
                == 999999999000000,
            126,
        );

        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 44, 127);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) == 65, 128);
        assert!(reflection_token::pending_rewards(signer::address_of(carol)) == 21, 129);
        assert!(reflection_token::pool_pending_rewards() == 22, 130);

        let (status, lp_index, lp_remainder, lp_shares, lp_unallocated,
            lp_rounding, lp_received, lp_claimed, lp_liability) =
            pool::lp_epoch_accounting(1);
        assert!(status == 1, 131);
        assert!(lp_index == 122480837452350659350, 132);
        assert!(lp_remainder == 263450, 133);
        assert!(lp_shares == 579485, 134);
        assert!(lp_unallocated == 0 && lp_rounding == 1, 135);
        assert!(lp_received == 70 && lp_claimed == 69 && lp_liability == 0, 136);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 137);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 138);
        assert!(pool::pending_lp_rewards(1, signer::address_of(carol)) == 0, 139);

        reflection_token::assert_accounting_backing();
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
        carol = @0xca401,
        trader = @0x7ade,
    )]
    fun terminal_fractional_lp_dust_stays_with_claim_only_epoch(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
        carol: &signer,
        trader: &signer,
    ) {
        setup(core, assets, amm, framework);
        reflection_token::register_wallet(alice);
        reflection_token::register_wallet(carol);

        // Alice receives the first 100m LP shares. Bob contributes the same
        // proportional reserves and receives the same 100m shares, while
        // emptying his tRFL wallet in the process.
        test_faucet::configure(assets, 100 * ONE, 100 * ONE, 0);
        test_faucet::claim_trfl(bob);
        test_faucet::claim_tusd(bob);
        test_faucet::configure(assets, 100 * ONE, 200 * ONE, 0);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::add_liquidity(bob, 100 * ONE, 100 * ONE, 1, 1_000);
        let alice_shares = pool::lp_shares(1, signer::address_of(alice));
        let bob_shares = pool::lp_shares(1, signer::address_of(bob));
        assert!(alice_shares == bob_shares && alice_shares > 0, 85);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == 0, 86);

        // A complete 101-base-unit sale creates one reflection base unit. With
        // no wallet shares left after the debit, custody receives that unit;
        // the equal LP positions each own half and individually round to zero.
        test_faucet::configure(assets, 101, 1, 0);
        test_faucet::claim_trfl(trader);
        pool::sell_trfl(trader, 101, 0, 1_000);
        assert!(reflection_token::pool_pending_rewards() == 1, 87);
        pool::checkpoint_lp_rewards(trader);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 88);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 89);
        let (status, _, _, total_shares, unallocated, rounding, received, claimed, liability) =
            pool::lp_epoch_accounting(1);
        assert!(status == 1 && total_shares == alice_shares + bob_shares, 90);
        assert!(unallocated == 0 && rounding == 0, 91);
        assert!(received == 1 && claimed == 0 && liability == 1, 92);
        assert!(pool::lp_reward_vault_balance(1) == 1, 93);

        // Burning both positions retires only their sub-base-unit corrections.
        // The old epoch becomes terminal with zero liability and one physical
        // dust unit; it is neither swept nor made claimable by a future cohort.
        pool::begin_shutdown(amm);
        pool::remove_liquidity(bob, bob_shares, 1, 1, 1_000);
        pool::remove_liquidity(alice, alice_shares, 1, 1, 1_000);
        assert!(pool::active_epoch() == 0, 94);
        let (old_status, _, _, old_shares, old_unallocated, old_rounding, old_received, old_claimed, old_liability) =
            pool::lp_epoch_accounting(1);
        assert!(old_status == 2 && old_shares == 0, 95);
        assert!(old_unallocated == 0 && old_rounding == 1, 96);
        assert!(old_received == 1 && old_claimed == 0 && old_liability == 0, 97);
        let (terminal_rounding, retired_residue_magnified) =
            pool::lp_epoch_terminal_dust(1);
        assert!(terminal_rounding == 1, 109);
        assert!(retired_residue_magnified == 1_000_000_000_000_000_000_000_000, 110);
        assert!(pool::lp_reward_vault_balance(1) == 1, 98);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 99);
        assert!(pool::pending_lp_rewards(1, signer::address_of(bob)) == 0, 100);

        pool::reseed_liquidity(
            core, amm, carol, 50 * ONE, 50 * ONE, 1,
        );
        assert!(pool::active_epoch() == 2, 101);
        let (fresh_status, fresh_index, fresh_remainder, fresh_shares, fresh_unallocated,
            fresh_rounding, fresh_received, fresh_claimed, fresh_liability) =
            pool::lp_epoch_accounting(2);
        assert!(fresh_status == 1 && fresh_shares > 0, 102);
        assert!(fresh_index == 0 && fresh_remainder == 0, 103);
        assert!(fresh_unallocated == 0 && fresh_rounding == 0, 104);
        assert!(fresh_received == 0 && fresh_claimed == 0 && fresh_liability == 0, 105);
        assert!(pool::pending_lp_rewards(2, signer::address_of(carol)) == 0, 106);
        assert!(pool::lp_reward_vault_balance(2) == 0, 107);
        assert!(pool::lp_reward_vault_balance(1) == 1, 108);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure]
    fun direct_lp_reward_vault_deposit_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        let source = primary_fungible_store::primary_store(
            signer::address_of(alice), reflection_token::metadata(),
        );
        dispatchable_fungible_asset::transfer(
            alice, source, lp_rewards::reward_vault(1), ONE,
        );
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure]
    fun direct_pool_reserve_withdrawal_is_blocked(
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
            signer::address_of(alice), reflection_token::metadata(),
        );
        dispatchable_fungible_asset::transfer(
            alice, pool::rfl_reserve_store(), destination, ONE,
        );
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        stranger = @0x57a,
    )]
    #[expected_failure(abort_code = 21, location = test_amm::pool)]
    fun lp_transfer_to_unregistered_recipient_is_blocked(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        stranger: &signer,
    ) {
        setup(core, assets, amm, framework);
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        pool::seed_liquidity(
            core, amm, alice, 100 * ONE, 100 * ONE, 1,
        );
        pool::transfer_lp_shares(alice, signer::address_of(stranger), 1);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    fun wallet_claim_pause_does_not_block_custody_routing_or_lp_payout(
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
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        assert!(reflection_token::pool_pending_rewards() > 0, 140);
        reflection_token::set_pause_state(core, false, true);
        pool::checkpoint_lp_rewards(alice);
        let pending = pool::pending_lp_rewards(1, signer::address_of(alice));
        assert!(pending > 0, 141);
        pool::claim_lp_rewards(alice, 1, pending);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 142);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    fun zero_denominator_receipt_is_named_and_quarantined(
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
        pool::sell_trfl(alice, 5 * ONE, 0, 1_000);
        pool::checkpoint_lp_rewards(alice);
        let pre_quarantine_claim = pool::pending_lp_rewards(
            1, signer::address_of(alice),
        );
        let pre_quarantine_vault = pool::lp_reward_vault_balance(1);
        assert!(pre_quarantine_claim > 0, 150);
        pool::claim_lp_rewards(alice, 1, pre_quarantine_claim);
        assert!(pool::lp_reward_vault_balance(1) == 0, 1501);
        pool::sell_trfl(alice, 5 * ONE, 0, 1_000);
        let pending = reflection_token::pool_pending_rewards();
        assert!(pending > 0, 151);
        let routed = pool::force_zero_denominator_receipt_for_test(
            signer::address_of(alice),
        );
        assert!(routed == pending, 152);
        let (_, _, _, total_shares, unallocated, rounding, received, claimed, liability) =
            pool::lp_epoch_accounting(1);
        let (_, _, _, quarantined) = lp_rewards::epoch_identity(1);
        assert!(total_shares == 0, 153);
        assert!(unallocated == (routed as u128), 154);
        assert!(received == ((pre_quarantine_vault + routed) as u256), 155);
        assert!(claimed == (pre_quarantine_claim as u256) && liability == 0, 156);
        assert!(quarantined && pool::lp_reward_vault_balance(1) == routed, 157);

        // Quarantine freezes mutation and never assigns `unallocated` to a
        // future denominator. The pre-quarantine whole claim was paid before
        // the test-only denominator removal, matching the production exit rule.
        let (_, _, _, shares_after, unallocated_after, rounding_after, _, claimed_after, liability_after) =
            pool::lp_epoch_accounting(1);
        assert!(shares_after == 0 && unallocated_after == unallocated, 158);
        assert!(rounding_after == rounding, 159);
        assert!(claimed_after == (pre_quarantine_claim as u256), 160);
        assert!(liability_after == liability, 161);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 162);
        assert!(pool::lp_reward_vault_balance(1) == routed, 163);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure(abort_code = 12, location = test_amm::pool)]
    fun independent_lp_claim_pause_blocks_lp_payout(
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
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        pool::checkpoint_lp_rewards(alice);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) > 0, 141);
        pool::configure_pauses(amm, false, false, true);
        pool::claim_lp_rewards(alice, 1, 0);
    }

    // Exercises the published claim-backed design with balances close to this
    // deployment's fixed-supply and configured reserve limits. The sequence
    // crosses wallet/custody and LP correction signs, routes large fees, moves
    // LP ownership, claims both layers, and then proves every physical tRFL
    // unit still belongs to one named store.
    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
        bob = @0xb0b,
    )]
    fun deployment_scale_claim_backed_accounting_stays_exact(
        core: &signer,
        assets: &signer,
        amm: &signer,
        framework: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        setup_claim_backed(core, assets, amm, framework);
        test_faucet::configure(
            assets, 450 * TRILLION, 600 * TRILLION, 0,
        );
        test_faucet::claim_trfl(alice);
        test_faucet::claim_tusd(amm);
        test_faucet::configure(
            assets, 100 * TRILLION, 200 * TRILLION, 0,
        );
        test_faucet::claim_trfl(bob);
        test_faucet::claim_tusd(bob);

        pool::configure_limits(amm, 100, 5_000, 100 * TRILLION);
        pool::configure_liquidity_limits(
            amm, 100 * TRILLION, 200 * TRILLION, 5_000,
        );
        pool::seed_liquidity(
            core,
            amm,
            alice,
            400 * TRILLION,
            600 * TRILLION,
            1,
        );

        pool::sell_trfl(alice, 50 * TRILLION, 0, 1_000);
        pool::checkpoint_lp_rewards(bob);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) > 0, 200);

        let (net_buy, _, _) = pool::quote_buy(50 * TRILLION);
        pool::buy_trfl(bob, 50 * TRILLION, net_buy, 1_000);
        pool::add_liquidity(
            bob, 20 * TRILLION, 40 * TRILLION, 1, 1_000,
        );
        pool::transfer_lp_shares(
            alice, signer::address_of(bob), (50 * TRILLION as u128),
        );

        pool::sell_trfl(alice, 20 * TRILLION, 0, 1_000);
        pool::checkpoint_lp_rewards(bob);
        let bob_lp_pending = pool::pending_lp_rewards(
            1, signer::address_of(bob),
        );
        assert!(bob_lp_pending > 0, 201);
        pool::claim_lp_rewards(bob, 1, bob_lp_pending);

        let alice_wallet_pending = reflection_token::pending_rewards(
            signer::address_of(alice),
        );
        assert!(alice_wallet_pending > 0, 202);
        reflection_token::claim(alice, alice_wallet_pending);

        let bob_shares = pool::lp_shares(1, signer::address_of(bob));
        assert!(bob_shares > 4, 203);
        pool::remove_liquidity(
            bob, bob_shares / 4, 1, 1, 1_000,
        );
        primary_fungible_store::transfer(
            alice,
            reflection_token::metadata(),
            signer::address_of(bob),
            TRILLION,
        );

        let (reserve_rfl, _) = pool::reserves_view();
        let (custody_shares, routed, core_rounding) =
            reflection_token::custody_accounting();
        assert!((reserve_rfl as u128) == custody_shares, 204);
        assert!(routed > 0 && core_rounding <= (TRILLION as u128), 205);

        let (_, _, global_shares, _, lifetime_fees, lifetime_materialized) =
            reflection_token::global_accounting();
        let wallet_raw = reflection_token::raw_balance(
            signer::address_of(alice),
        ) + reflection_token::raw_balance(signer::address_of(bob));
        assert!(global_shares == ((wallet_raw + reserve_rfl) as u128), 206);
        assert!(lifetime_fees > 0 && lifetime_materialized > 0, 207);
        assert!(reflection_token::registered_wallet_count() == 2, 208);
        assert!(!reflection_token::automatic_materialization_enabled(), 209);

        let (_, aggregate_correction) = reflection_token::aggregate_correction();
        let (_, lp_correction) = lp_rewards::epoch_aggregate_correction(1);
        assert!(aggregate_correction > 0 && lp_correction > 0, 210);

        let (_, _, _, _, lp_unallocated, lp_rounding, lp_received,
            lp_claimed, lp_liability) = pool::lp_epoch_accounting(1);
        let lp_vault = pool::lp_reward_vault_balance(1);
        assert!(lp_received > 0 && lp_claimed > 0, 211);
        assert!(
            (lp_vault as u256)
                == lp_liability
                    + (lp_unallocated as u256)
                    + (lp_rounding as u256),
            212,
        );

        let physical_supply = reflection_token::distribution_vault_balance()
            + reflection_token::reward_vault_balance()
            + reserve_rfl
            + lp_vault
            + wallet_raw;
        assert!(physical_supply == reflection_token::fixed_supply(), 213);
        reflection_token::assert_accounting_backing();
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure(abort_code = 6, location = test_amm::pool)]
    fun bootstrap_respects_provider_minimum_lp_shares(
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
            core,
            amm,
            alice,
            100 * ONE,
            100 * ONE,
            (100 * ONE as u128) + 1,
        );
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure(abort_code = 9, location = test_amm::lp_rewards)]
    fun fully_claimed_lp_reward_cannot_be_claimed_twice(
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
        pool::sell_trfl(alice, 10 * ONE, 0, 1_000);
        pool::checkpoint_lp_rewards(alice);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) > 0, 142);
        pool::claim_lp_rewards(alice, 1, 0);
        assert!(pool::pending_lp_rewards(1, signer::address_of(alice)) == 0, 143);
        pool::claim_lp_rewards(alice, 1, 0);
    }

    #[test(
        core = @0xcafe,
        assets = @0xbabe,
        amm = @0xdead,
        framework = @0x1,
        alice = @0xa11ce,
    )]
    #[expected_failure(abort_code = 16, location = test_amm::pool)]
    fun final_liquidity_exit_requires_shutdown(
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
        let all_shares = pool::lp_shares(1, signer::address_of(alice));
        pool::remove_liquidity(alice, all_shares, 1, 1, 1_000);
    }
}
