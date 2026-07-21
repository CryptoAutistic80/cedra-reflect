/// Immutable v0.2 tRFL/tUSD constant-product Testnet pool.
///
/// Launch is one atomic CONFIGURING -> LIVE transaction. Runtime parameters are
/// compile-time constants, every reserve-touching swap checkpoints LP rewards,
/// and every LP weight change first materializes the affected LP positions.
/// Burning the final outstanding LP shares returns both full reserves and moves
/// the pool irreversibly to CLOSED without an administrator or shutdown gate.
module test_amm::pool {
    use cedra_framework::event;
    use cedra_framework::fungible_asset::{Self, FungibleStore};
    use cedra_framework::object::{Self, Object};
    use cedra_framework::primary_fungible_store;
    use cedra_framework::timestamp;
    use reflection_core::custody_registry::CustodySettlementCapability;
    use reflection_core::custody_settlement;
    use reflection_core::reflection_token::{Self, SettlementCapability};
    use std::signer;
    use test_amm::lp_rewards::{Self, LpAccountingCapability};
    use test_amm::reflection_settlement;
    use test_assets::mock_usd::{Self, PoolSettlementCapability};
    use test_assets::test_faucet;

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_WRONG_AMM_ADDRESS: u64 = 2;
    const E_WRONG_ASSETS_ADDRESS: u64 = 3;
    const E_WRONG_BOOTSTRAP_LP: u64 = 4;
    const E_ZERO_AMOUNT: u64 = 5;
    const E_DEADLINE: u64 = 6;
    const E_MIN_OUTPUT: u64 = 7;
    const E_MAX_SWAP: u64 = 8;
    const E_MAX_RESERVE_PERCENT: u64 = 9;
    const E_INSUFFICIENT_LIQUIDITY: u64 = 10;
    const E_WRONG_LIFECYCLE: u64 = 11;
    const E_NOT_PROPORTIONAL: u64 = 12;
    const E_RESERVE_CUSTODY_MISMATCH: u64 = 13;
    const E_INVALID_LP_OWNER: u64 = 14;
    const E_INVALID_RECIPIENT: u64 = 15;
    const E_MAX_LIQUIDITY_CONTRIBUTION: u64 = 16;
    const E_NOT_SEALABLE: u64 = 17;

    const CONFIGURING: u8 = 0;
    const LIVE: u8 = 1;
    const CLOSED: u8 = 2;

    const BPS_DENOMINATOR: u64 = 10_000;
    const FIXED_AMM_FEE_BPS: u64 = 30;
    const FIXED_MAX_RESERVE_BPS: u64 = 2_000;
    const FIXED_MAX_GROSS_SWAP: u64 = 100_000_000_000;
    const FIXED_MAX_LIQUIDITY_RFL: u64 = 100_000_000_000;
    const FIXED_MAX_LIQUIDITY_USD: u64 = 100_000_000_000;
    const FIXED_MAX_WITHDRAWAL_SHARE_BPS: u64 = BPS_DENOMINATOR;
    const INITIAL_TRFL_LIQUIDITY: u64 = 500_000_000;
    const INITIAL_TUSD_LIQUIDITY: u64 = 500_000_000;
    const RFL_RESERVE_SEED: vector<u8> = b"reflection-amm-trfl-reserve-v2";
    const USD_RESERVE_SEED: vector<u8> = b"reflection-amm-tusd-reserve-v2";

    struct PoolState has key {
        settlement_cap: SettlementCapability,
        custody_cap: CustodySettlementCapability,
        lp_cap: LpAccountingCapability,
        usd_pool_cap: PoolSettlementCapability,
        rfl_reserve: Object<FungibleStore>,
        usd_reserve: Object<FungibleStore>,
        lifecycle: u8,
    }

    #[event]
    struct PoolLifecycleChanged has drop, store {
        old_lifecycle: u8,
        new_lifecycle: u8,
    }

    // Complete immutable launch envelope for indexers and deployment evidence.
    #[event]
    struct LaunchSealed has drop, store {
        reflection_fee_bps: u64,
        amm_fee_bps: u64,
        max_reserve_bps: u64,
        max_gross_swap: u64,
        max_liquidity_rfl: u64,
        max_liquidity_usd: u64,
        max_withdrawal_share_bps: u64,
        faucet_trfl_grant: u64,
        faucet_tusd_grant: u64,
        faucet_cooldown_seconds: u64,
        bootstrap: address,
        rfl_reserve: address,
        usd_reserve: address,
        lp_reward_vault: address,
        seed_rfl: u64,
        seed_usd: u64,
        initial_lp_shares: u128,
    }

    #[event]
    struct LiquiditySeeded has drop, store {
        epoch: u64,
        provider: address,
        rfl_amount: u64,
        usd_amount: u64,
        lp_shares: u128,
        reserve_rfl: u64,
        reserve_usd: u64,
    }

    #[event]
    struct LiquidityAdded has drop, store {
        epoch: u64,
        provider: address,
        rfl_amount: u64,
        usd_amount: u64,
        lp_shares: u128,
        reserve_rfl: u64,
        reserve_usd: u64,
    }

    #[event]
    struct LiquidityRemoved has drop, store {
        epoch: u64,
        provider: address,
        rfl_amount: u64,
        usd_amount: u64,
        lp_shares: u128,
        final_exit: bool,
        reserve_rfl: u64,
        reserve_usd: u64,
    }

    // Irreversible terminal evidence emitted only by the all-share exit.
    #[event]
    struct PoolClosed has drop, store {
        provider: address,
        epoch: u64,
        lp_shares: u128,
        rfl_output: u64,
        usd_output: u64,
        reserve_rfl: u64,
        reserve_usd: u64,
    }

    #[event]
    struct SwapExecuted has drop, store {
        trader: address,
        is_sell: bool,
        gross_input: u64,
        reflection_fee: u64,
        amm_fee: u64,
        gross_output: u64,
        net_output: u64,
        reserve_rfl: u64,
        reserve_usd: u64,
    }

    /// Source-bound one-shot launch. All capability handoffs, both fixed reserve
    /// seeds, initial LP ownership, and the core launch seal occur atomically.
    public entry fun launch(
        core_publisher: &signer,
        assets_publisher: &signer,
        amm_publisher: &signer,
        bootstrap_lp: &signer,
    ) acquires PoolState {
        assert!(!exists<PoolState>(@test_amm), E_ALREADY_INITIALIZED);
        assert!(signer::address_of(amm_publisher) == @test_amm, E_WRONG_AMM_ADDRESS);
        assert!(signer::address_of(assets_publisher) == @test_assets, E_WRONG_ASSETS_ADDRESS);
        assert!(signer::address_of(bootstrap_lp) == @bootstrap_lp, E_WRONG_BOOTSTRAP_LP);

        let rfl_constructor = object::create_named_object(amm_publisher, RFL_RESERVE_SEED);
        let rfl_reserve = fungible_asset::create_store(
            &rfl_constructor,
            reflection_token::metadata(),
        );
        let usd_constructor = object::create_named_object(amm_publisher, USD_RESERVE_SEED);
        let usd_reserve = fungible_asset::create_store(&usd_constructor, mock_usd::metadata());
        let lp_vault_constructor = object::create_object(@test_amm);
        let lp_reward_vault = fungible_asset::create_store(
            &lp_vault_constructor,
            reflection_token::metadata(),
        );

        let settlement_cap = reflection_token::issue_settlement_capability(
            core_publisher,
            amm_publisher,
        );
        let custody_cap = reflection_token::register_canonical_custody(
            core_publisher,
            amm_publisher,
            rfl_reserve,
            lp_reward_vault,
        );
        let lp_cap = lp_rewards::initialize(amm_publisher, lp_reward_vault);
        let usd_pool_cap = mock_usd::issue_pool_settlement_capability(
            assets_publisher,
            amm_publisher,
            usd_reserve,
        );
        test_faucet::initialize(core_publisher, assets_publisher);
        reflection_token::bind_protocol_exclusions(core_publisher);
        assert_valid_lp_owner(@bootstrap_lp);
        assert!(
            reflection_token::initial_pool_rfl() == INITIAL_TRFL_LIQUIDITY
                && mock_usd::fixed_pool_bootstrap() == INITIAL_TUSD_LIQUIDITY,
            E_NOT_SEALABLE,
        );

        reflection_token::seed_pool_from_distribution(
            &custody_cap,
            core_publisher,
            rfl_reserve,
            INITIAL_TRFL_LIQUIDITY,
        );
        let usd_seeded = mock_usd::bootstrap_pool_reserve(&usd_pool_cap, usd_reserve);
        assert!(usd_seeded == INITIAL_TUSD_LIQUIDITY, E_NOT_SEALABLE);
        let shares = reflection_settlement::initial_lp_shares(
            INITIAL_TRFL_LIQUIDITY,
            INITIAL_TUSD_LIQUIDITY,
        );
        assert!(shares > 0, E_NOT_SEALABLE);
        lp_rewards::mint_active(&lp_cap, @bootstrap_lp, shares);

        move_to(amm_publisher, PoolState {
            settlement_cap,
            custody_cap,
            lp_cap,
            usd_pool_cap,
            rfl_reserve,
            usd_reserve,
            lifecycle: CONFIGURING,
        });
        let state = borrow_global<PoolState>(@test_amm);
        assert_reserve_custody(state);
        lp_rewards::assert_active_epoch_healthy(&state.lp_cap);
        lp_rewards::assert_epoch_backing(&state.lp_cap, 1);
        let (reserve_rfl, reserve_usd) = reserves(state);
        assert!(
            reserve_rfl == INITIAL_TRFL_LIQUIDITY
                && reserve_usd == INITIAL_TUSD_LIQUIDITY,
            E_NOT_SEALABLE,
        );

        reflection_token::seal_launch(
            core_publisher,
            assets_publisher,
            amm_publisher,
        );
        let (faucet_trfl_grant, faucet_tusd_grant, faucet_cooldown_seconds) =
            test_faucet::configuration();
        let mutable_state = borrow_global_mut<PoolState>(@test_amm);
        mutable_state.lifecycle = LIVE;
        event::emit(LaunchSealed {
            reflection_fee_bps: reflection_token::reflection_fee_bps(),
            amm_fee_bps: FIXED_AMM_FEE_BPS,
            max_reserve_bps: FIXED_MAX_RESERVE_BPS,
            max_gross_swap: FIXED_MAX_GROSS_SWAP,
            max_liquidity_rfl: FIXED_MAX_LIQUIDITY_RFL,
            max_liquidity_usd: FIXED_MAX_LIQUIDITY_USD,
            max_withdrawal_share_bps: FIXED_MAX_WITHDRAWAL_SHARE_BPS,
            faucet_trfl_grant,
            faucet_tusd_grant,
            faucet_cooldown_seconds,
            bootstrap: @bootstrap_lp,
            rfl_reserve: object::object_address(&rfl_reserve),
            usd_reserve: object::object_address(&usd_reserve),
            lp_reward_vault: object::object_address(&lp_reward_vault),
            seed_rfl: INITIAL_TRFL_LIQUIDITY,
            seed_usd: INITIAL_TUSD_LIQUIDITY,
            initial_lp_shares: shares,
        });
        event::emit(PoolLifecycleChanged {
            old_lifecycle: CONFIGURING,
            new_lifecycle: LIVE,
        });
        event::emit(LiquiditySeeded {
            epoch: 1,
            provider: @bootstrap_lp,
            rfl_amount: INITIAL_TRFL_LIQUIDITY,
            usd_amount: INITIAL_TUSD_LIQUIDITY,
            lp_shares: shares,
            reserve_rfl,
            reserve_usd,
        });
    }

    public entry fun add_liquidity(
        provider: &signer,
        max_rfl: u64,
        max_usd: u64,
        min_lp_shares: u128,
        deadline_seconds: u64,
    ) acquires PoolState {
        assert_deadline(deadline_seconds);
        assert!(max_rfl > 0 && max_usd > 0, E_ZERO_AMOUNT);
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        let provider_address = signer::address_of(provider);
        assert_valid_lp_owner(provider_address);
        checkpoint_active(state);
        materialize_lp_rewards(state, provider_address);
        let (reserve_rfl, reserve_usd) = reserves(state);
        let total_shares = lp_rewards::total_active_shares();
        assert!(
            reserve_rfl > 0 && reserve_usd > 0 && total_shares > 0,
            E_INSUFFICIENT_LIQUIDITY,
        );
        let (shares, rfl_used, usd_used) = reflection_settlement::liquidity_mint(
            max_rfl,
            max_usd,
            reserve_rfl,
            reserve_usd,
            total_shares,
        );
        assert!(
            rfl_used <= FIXED_MAX_LIQUIDITY_RFL
                && usd_used <= FIXED_MAX_LIQUIDITY_USD,
            E_MAX_LIQUIDITY_CONTRIBUTION,
        );
        assert!(
            shares > 0
                && shares >= min_lp_shares
                && rfl_used > 0
                && usd_used > 0,
            E_MIN_OUTPUT,
        );
        assert!(rfl_used <= max_rfl && usd_used <= max_usd, E_NOT_PROPORTIONAL);
        custody_settlement::wallet_to_custody(
            &state.custody_cap,
            provider,
            state.rfl_reserve,
            rfl_used,
        );
        let usd = primary_fungible_store::withdraw(provider, mock_usd::metadata(), usd_used);
        mock_usd::deposit_to_pool(&state.usd_pool_cap, state.usd_reserve, usd);
        lp_rewards::mint_active(&state.lp_cap, provider_address, shares);
        lp_rewards::assert_epoch_backing(&state.lp_cap, 1);
        assert_reserve_custody(state);
        let (after_rfl, after_usd) = reserves(state);
        event::emit(LiquidityAdded {
            epoch: 1,
            provider: provider_address,
            rfl_amount: rfl_used,
            usd_amount: usd_used,
            lp_shares: shares,
            reserve_rfl: after_rfl,
            reserve_usd: after_usd,
        });
    }

    public entry fun remove_liquidity(
        provider: &signer,
        shares: u128,
        min_rfl_output: u64,
        min_usd_output: u64,
        deadline_seconds: u64,
    ) acquires PoolState {
        assert_deadline(deadline_seconds);
        assert!(shares > 0, E_ZERO_AMOUNT);
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        checkpoint_active(state);
        let provider_address = signer::address_of(provider);
        assert!(
            lp_rewards::position_shares(1, provider_address) >= shares,
            E_INSUFFICIENT_LIQUIDITY,
        );
        materialize_lp_rewards(state, provider_address);
        let total_shares = lp_rewards::total_active_shares();
        let final_exit = shares == total_shares;
        let (reserve_rfl, reserve_usd) = reserves(state);
        let (rfl_out, usd_out) = if (final_exit) {
            (reserve_rfl, reserve_usd)
        } else {
            reflection_settlement::liquidity_withdrawal(
                shares,
                total_shares,
                reserve_rfl,
                reserve_usd,
            )
        };
        assert!(rfl_out > 0 && usd_out > 0, E_ZERO_AMOUNT);
        assert!(rfl_out >= min_rfl_output && usd_out >= min_usd_output, E_MIN_OUTPUT);

        lp_rewards::burn_active(&state.lp_cap, provider_address, shares);
        custody_settlement::custody_to_wallet(
            &state.custody_cap,
            state.rfl_reserve,
            provider,
            rfl_out,
        );
        let usd = mock_usd::withdraw_from_pool(
            &state.usd_pool_cap,
            state.usd_reserve,
            usd_out,
        );
        primary_fungible_store::deposit(provider_address, usd);
        assert_reserve_custody(state);
        let (after_rfl, after_usd) = reserves(state);
        lp_rewards::assert_epoch_backing(&state.lp_cap, 1);

        if (final_exit) {
            assert!(
                after_rfl == 0
                    && after_usd == 0
                    && reflection_token::pool_pending_rewards() == 0,
                E_RESERVE_CUSTODY_MISMATCH,
            );
            lp_rewards::mark_active_claim_only(&state.lp_cap);
            reflection_token::close_pool(&state.custody_cap);
            let mutable_state = borrow_global_mut<PoolState>(@test_amm);
            mutable_state.lifecycle = CLOSED;
            event::emit(PoolLifecycleChanged {
                old_lifecycle: LIVE,
                new_lifecycle: CLOSED,
            });
            event::emit(PoolClosed {
                provider: provider_address,
                epoch: 1,
                lp_shares: shares,
                rfl_output: rfl_out,
                usd_output: usd_out,
                reserve_rfl: after_rfl,
                reserve_usd: after_usd,
            });
        };
        event::emit(LiquidityRemoved {
            epoch: 1,
            provider: provider_address,
            rfl_amount: rfl_out,
            usd_amount: usd_out,
            lp_shares: shares,
            final_exit,
            reserve_rfl: after_rfl,
            reserve_usd: after_usd,
        });
    }

    /// Account-bound transfer. Both endpoints receive every whole LP reward at
    /// the old weights before those weights change.
    public entry fun transfer_lp_shares(
        sender: &signer,
        recipient: address,
        shares: u128,
    ) acquires PoolState {
        let sender_address = signer::address_of(sender);
        assert!(
            shares > 0 && recipient != sender_address,
            E_INVALID_RECIPIENT,
        );
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        assert_valid_lp_owner(recipient);
        checkpoint_active(state);
        materialize_lp_rewards(state, sender_address);
        materialize_lp_rewards(state, recipient);
        lp_rewards::transfer_active(
            &state.lp_cap,
            sender_address,
            recipient,
            shares,
        );
        lp_rewards::assert_epoch_backing(&state.lp_cap, 1);
        reflection_token::assert_accounting_backing();
    }

    /// `amount == 0` claims every whole reward currently pending for epoch 1.
    public entry fun claim_lp_rewards(
        owner: &signer,
        epoch: u64,
        amount: u64,
    ) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        if (state.lifecycle == LIVE && epoch == 1) checkpoint_active(state);
        let claimed = lp_rewards::prepare_claim(
            &state.lp_cap,
            epoch,
            signer::address_of(owner),
            amount,
        );
        custody_settlement::pay_lp_claim(
            &state.custody_cap,
            owner,
            epoch,
            lp_rewards::reward_vault(epoch),
            claimed,
        );
        lp_rewards::assert_epoch_backing(&state.lp_cap, epoch);
        reflection_token::assert_accounting_backing();
    }

    /// Permissionless accounting checkpoint. No funds are paid to the caller.
    public entry fun checkpoint_lp_rewards(_caller: &signer) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        checkpoint_active(state);
    }

    public entry fun sell_trfl(
        seller: &signer,
        gross_trfl_input: u64,
        min_tusd_output: u64,
        deadline_seconds: u64,
    ) acquires PoolState {
        assert_deadline(deadline_seconds);
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        checkpoint_active(state);
        assert_swap_bounds(gross_trfl_input, true, state);
        let (rfl_before, usd_before) = reserves(state);
        let reflection_fee = reflection_token::reflection_fee_for(gross_trfl_input);
        let net_input = gross_trfl_input - reflection_fee;
        let (gross_output, amm_fee) = reflection_settlement::constant_product_output(
            rfl_before,
            usd_before,
            net_input,
            FIXED_AMM_FEE_BPS,
        );
        assert_reserve_output_cap(gross_output, usd_before);
        assert!(gross_output > 0 && gross_output >= min_tusd_output, E_MIN_OUTPUT);
        let (settled_net, settled_fee) = reflection_token::settle_sell(
            &state.settlement_cap,
            seller,
            state.rfl_reserve,
            gross_trfl_input,
        );
        assert!(
            settled_net == net_input && settled_fee == reflection_fee,
            E_INSUFFICIENT_LIQUIDITY,
        );
        checkpoint_active(state);
        assert!(reflection_token::pool_pending_rewards() == 0, E_RESERVE_CUSTODY_MISMATCH);
        let usd = mock_usd::withdraw_from_pool(
            &state.usd_pool_cap,
            state.usd_reserve,
            gross_output,
        );
        primary_fungible_store::deposit(signer::address_of(seller), usd);
        assert_reserve_custody(state);
        let (reserve_rfl, reserve_usd) = reserves(state);
        event::emit(SwapExecuted {
            trader: signer::address_of(seller),
            is_sell: true,
            gross_input: gross_trfl_input,
            reflection_fee,
            amm_fee,
            gross_output,
            net_output: gross_output,
            reserve_rfl,
            reserve_usd,
        });
    }

    public entry fun buy_trfl(
        buyer: &signer,
        tusd_input: u64,
        min_net_trfl_output: u64,
        deadline_seconds: u64,
    ) acquires PoolState {
        assert_deadline(deadline_seconds);
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        checkpoint_active(state);
        assert_swap_bounds(tusd_input, false, state);
        let (rfl_before, usd_before) = reserves(state);
        let (gross_output, amm_fee) = reflection_settlement::constant_product_output(
            usd_before,
            rfl_before,
            tusd_input,
            FIXED_AMM_FEE_BPS,
        );
        assert_reserve_output_cap(gross_output, rfl_before);
        let reflection_fee = reflection_token::reflection_fee_for(gross_output);
        let net_output = gross_output - reflection_fee;
        assert!(net_output > 0 && net_output >= min_net_trfl_output, E_MIN_OUTPUT);
        let usd = primary_fungible_store::withdraw(buyer, mock_usd::metadata(), tusd_input);
        mock_usd::deposit_to_pool(&state.usd_pool_cap, state.usd_reserve, usd);
        let (settled_net, settled_fee) = reflection_token::settle_buy(
            &state.settlement_cap,
            buyer,
            state.rfl_reserve,
            gross_output,
        );
        assert!(
            settled_net == net_output && settled_fee == reflection_fee,
            E_INSUFFICIENT_LIQUIDITY,
        );
        checkpoint_active(state);
        assert!(reflection_token::pool_pending_rewards() == 0, E_RESERVE_CUSTODY_MISMATCH);
        assert_reserve_custody(state);
        let (reserve_rfl, reserve_usd) = reserves(state);
        event::emit(SwapExecuted {
            trader: signer::address_of(buyer),
            is_sell: false,
            gross_input: tusd_input,
            reflection_fee,
            amm_fee,
            gross_output,
            net_output,
            reserve_rfl,
            reserve_usd,
        });
    }

    #[view]
    public fun quote_sell(gross_trfl_input: u64): (u64, u64, u64) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        assert_swap_bounds(gross_trfl_input, true, state);
        let (rfl, usd) = reserves(state);
        let reflection_fee = reflection_token::reflection_fee_for(gross_trfl_input);
        let (output, amm_fee) = reflection_settlement::constant_product_output(
            rfl,
            usd,
            gross_trfl_input - reflection_fee,
            FIXED_AMM_FEE_BPS,
        );
        assert_reserve_output_cap(output, usd);
        assert!(output > 0, E_MIN_OUTPUT);
        (output, reflection_fee, amm_fee)
    }

    #[view]
    public fun quote_buy(tusd_input: u64): (u64, u64, u64) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        assert_swap_bounds(tusd_input, false, state);
        let (rfl, usd) = reserves(state);
        let (gross_output, amm_fee) = reflection_settlement::constant_product_output(
            usd,
            rfl,
            tusd_input,
            FIXED_AMM_FEE_BPS,
        );
        assert_reserve_output_cap(gross_output, rfl);
        let reflection_fee = reflection_token::reflection_fee_for(gross_output);
        let net_output = gross_output - reflection_fee;
        assert!(net_output > 0, E_MIN_OUTPUT);
        (net_output, reflection_fee, amm_fee)
    }

    #[view]
    public fun reserves_view(): (u64, u64) acquires PoolState {
        reserves(borrow_global<PoolState>(@test_amm))
    }

    #[view]
    public fun rfl_reserve_store(): Object<FungibleStore> acquires PoolState {
        borrow_global<PoolState>(@test_amm).rfl_reserve
    }

    #[view]
    public fun usd_reserve_store(): Object<FungibleStore> acquires PoolState {
        borrow_global<PoolState>(@test_amm).usd_reserve
    }

    #[view]
    public fun lifecycle(): u8 acquires PoolState {
        borrow_global<PoolState>(@test_amm).lifecycle
    }

    #[view]
    public fun limits(): (u64, u64, u64) {
        (FIXED_AMM_FEE_BPS, FIXED_MAX_RESERVE_BPS, FIXED_MAX_GROSS_SWAP)
    }

    #[view]
    public fun liquidity_limits(): (u64, u64, u64) {
        (
            FIXED_MAX_LIQUIDITY_RFL,
            FIXED_MAX_LIQUIDITY_USD,
            FIXED_MAX_WITHDRAWAL_SHARE_BPS,
        )
    }

    #[view]
    public fun initial_liquidity(): (u64, u64, address) {
        (INITIAL_TRFL_LIQUIDITY, INITIAL_TUSD_LIQUIDITY, @bootstrap_lp)
    }

    #[view]
    public fun active_epoch(): u64 { lp_rewards::active_epoch() }

    #[view]
    public fun lp_shares(epoch: u64, owner: address): u128 {
        lp_rewards::position_shares(epoch, owner)
    }

    #[view]
    public fun pending_lp_rewards(epoch: u64, owner: address): u64 {
        lp_rewards::pending_rewards(epoch, owner)
    }

    #[view]
    public fun total_lp_shares(): u128 { lp_rewards::total_active_shares() }

    #[view]
    public fun lp_reward_vault_balance(epoch: u64): u64 {
        reflection_token::raw_store_balance(lp_rewards::reward_vault(epoch))
    }

    #[view]
    public fun lp_epoch_accounting(
        epoch: u64,
    ): (u8, u256, u256, u128, u128, u128, u256, u256, u256) {
        lp_rewards::epoch_accounting(epoch)
    }

    #[view]
    public fun lp_epoch_terminal_dust(epoch: u64): (u128, u256) {
        lp_rewards::epoch_terminal_dust(epoch)
    }

    #[test_only]
    public fun attempt_usd_withdraw_from_store_for_test(
        store: Object<FungibleStore>,
        recipient: address,
        amount: u64,
    ) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        let asset = mock_usd::withdraw_from_pool(&state.usd_pool_cap, store, amount);
        primary_fungible_store::deposit(recipient, asset);
    }

    #[test_only]
    public fun force_zero_denominator_receipt_for_test(owner: address): u64 acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        let shares = lp_rewards::position_shares(1, owner);
        assert!(shares > 0, E_ZERO_AMOUNT);
        lp_rewards::burn_active(&state.lp_cap, owner, shares);
        let amount = custody_settlement::checkpoint(
            &state.custody_cap,
            state.rfl_reserve,
            1,
            lp_rewards::active_reward_vault(),
        );
        assert!(amount > 0, E_ZERO_AMOUNT);
        lp_rewards::receive_routed_reward(&state.lp_cap, amount);
        amount
    }

    fun checkpoint_active(state: &PoolState) {
        lp_rewards::assert_active_epoch_healthy(&state.lp_cap);
        let amount = custody_settlement::checkpoint(
            &state.custody_cap,
            state.rfl_reserve,
            1,
            lp_rewards::active_reward_vault(),
        );
        if (amount > 0) lp_rewards::receive_routed_reward(&state.lp_cap, amount);
        lp_rewards::assert_epoch_backing(&state.lp_cap, 1);
        reflection_token::assert_accounting_backing();
    }

    /// Materializes every whole LP reward to the owner's exact primary store.
    /// The core capability authenticates the vault and atomically materializes
    /// any pre-existing wallet reward before changing the wallet's raw weight.
    fun materialize_lp_rewards(state: &PoolState, owner: address) {
        let pending = lp_rewards::pending_rewards(1, owner);
        if (pending == 0) return;
        let claimed = lp_rewards::prepare_claim(&state.lp_cap, 1, owner, pending);
        custody_settlement::pay_lp_claim_to(
            &state.custody_cap,
            owner,
            1,
            lp_rewards::reward_vault(1),
            claimed,
        );
        lp_rewards::assert_epoch_backing(&state.lp_cap, 1);
        reflection_token::assert_accounting_backing();
    }

    fun reserves(state: &PoolState): (u64, u64) {
        (
            reflection_token::raw_store_balance(state.rfl_reserve),
            fungible_asset::balance(state.usd_reserve),
        )
    }

    fun assert_reserve_custody(state: &PoolState) {
        let (raw_rfl, _) = reserves(state);
        let (custody_shares, _, _) = reflection_token::custody_accounting();
        assert!((raw_rfl as u128) == custody_shares, E_RESERVE_CUSTODY_MISMATCH);
        reflection_token::assert_accounting_backing();
    }

    fun assert_pool_live(state: &PoolState) {
        assert!(
            state.lifecycle == LIVE
                && reflection_token::is_sealed()
                && !reflection_token::is_closed(),
            E_WRONG_LIFECYCLE,
        );
        lp_rewards::assert_active_epoch_healthy(&state.lp_cap);
    }

    fun assert_valid_lp_owner(owner: address) {
        assert!(
            owner != @0x0
                && owner != @reflection_core
                && owner != @test_assets
                && owner != @test_amm
                && !reflection_token::primary_store_is_excluded(owner),
            E_INVALID_LP_OWNER,
        );
    }

    fun assert_deadline(deadline: u64) {
        assert!(timestamp::now_seconds() <= deadline, E_DEADLINE);
    }

    fun assert_swap_bounds(amount: u64, is_sell: bool, state: &PoolState) {
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(amount <= FIXED_MAX_GROSS_SWAP, E_MAX_SWAP);
        let (rfl, usd) = reserves(state);
        let reserve = if (is_sell) rfl else usd;
        assert!(
            reserve > 0
                && (amount as u128) * (BPS_DENOMINATOR as u128)
                    <= (reserve as u128) * (FIXED_MAX_RESERVE_BPS as u128),
            E_MAX_RESERVE_PERCENT,
        );
    }

    fun assert_reserve_output_cap(output: u64, reserve_out: u64) {
        assert!(
            (output as u128) * (BPS_DENOMINATOR as u128)
                <= (reserve_out as u128) * (FIXED_MAX_RESERVE_BPS as u128),
            E_MAX_RESERVE_PERCENT,
        );
    }

    #[test_only]
    fun launch_for_test(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
    ) acquires PoolState {
        timestamp::set_time_has_started_for_testing(framework);
        reflection_token::initialize_for_test(core);
        mock_usd::initialize_for_test(assets);
        launch(core, assets, amm, bootstrap);
    }

    #[test(
        core = @reflection_core,
        assets = @test_assets,
        amm = @test_amm,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
    )]
    fun immutable_launch_and_exact_final_exit_emit_evidence(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
    ) acquires PoolState {
        launch_for_test(core, assets, amm, bootstrap, framework);
        let bootstrap_address = signer::address_of(bootstrap);
        let (reserve_rfl, reserve_usd) = reserves_view();
        let initial_shares = total_lp_shares();
        assert!(lifecycle() == LIVE && reflection_token::is_sealed(), 1001);
        assert!(
            reserve_rfl == INITIAL_TRFL_LIQUIDITY
                && reserve_usd == INITIAL_TUSD_LIQUIDITY
                && initial_shares == (INITIAL_TRFL_LIQUIDITY as u128),
            1002,
        );

        let launch_events = event::emitted_events<LaunchSealed>();
        assert!(launch_events.length() == 1, 1003);
        let launch_event = launch_events.borrow(0);
        let state = borrow_global<PoolState>(@test_amm);
        assert!(
            launch_event.reflection_fee_bps == 100
                && launch_event.amm_fee_bps == FIXED_AMM_FEE_BPS
                && launch_event.max_reserve_bps == FIXED_MAX_RESERVE_BPS
                && launch_event.max_gross_swap == FIXED_MAX_GROSS_SWAP
                && launch_event.max_liquidity_rfl == FIXED_MAX_LIQUIDITY_RFL
                && launch_event.max_liquidity_usd == FIXED_MAX_LIQUIDITY_USD
                && launch_event.max_withdrawal_share_bps == FIXED_MAX_WITHDRAWAL_SHARE_BPS
                && launch_event.faucet_trfl_grant == 1_000_000_000
                && launch_event.faucet_tusd_grant == 1_000_000_000
                && launch_event.faucet_cooldown_seconds == 3_600
                && launch_event.bootstrap == bootstrap_address
                && launch_event.rfl_reserve == object::object_address(&state.rfl_reserve)
                && launch_event.usd_reserve == object::object_address(&state.usd_reserve)
                && launch_event.lp_reward_vault
                    == object::object_address(&lp_rewards::active_reward_vault())
                && launch_event.seed_rfl == INITIAL_TRFL_LIQUIDITY
                && launch_event.seed_usd == INITIAL_TUSD_LIQUIDITY
                && launch_event.initial_lp_shares == initial_shares,
            1004,
        );

        remove_liquidity(
            bootstrap,
            initial_shares,
            INITIAL_TRFL_LIQUIDITY,
            INITIAL_TUSD_LIQUIDITY,
            1_000,
        );
        let (after_rfl, after_usd) = reserves_view();
        assert!(after_rfl == 0 && after_usd == 0, 1005);
        assert!(lifecycle() == CLOSED && reflection_token::is_closed(), 1006);
        assert!(total_lp_shares() == 0 && reflection_token::pool_pending_rewards() == 0, 1007);
        assert!(reflection_token::raw_balance(bootstrap_address) == INITIAL_TRFL_LIQUIDITY, 1008);
        assert!(
            primary_fungible_store::balance(bootstrap_address, mock_usd::metadata())
                == INITIAL_TUSD_LIQUIDITY,
            1009,
        );

        let closed_events = event::emitted_events<PoolClosed>();
        assert!(closed_events.length() == 1, 1010);
        let closed_event = closed_events.borrow(0);
        assert!(
            closed_event.provider == bootstrap_address
                && closed_event.epoch == 1
                && closed_event.lp_shares == initial_shares
                && closed_event.rfl_output == INITIAL_TRFL_LIQUIDITY
                && closed_event.usd_output == INITIAL_TUSD_LIQUIDITY
                && closed_event.reserve_rfl == 0
                && closed_event.reserve_usd == 0,
            1011,
        );
    }

    #[test(
        core = @reflection_core,
        assets = @test_assets,
        amm = @test_amm,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        seller = @0xa11,
        buyer = @0xb0b,
    )]
    fun every_swap_post_checkpoints_pool_rewards(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        seller: &signer,
        buyer: &signer,
    ) acquires PoolState {
        launch_for_test(core, assets, amm, bootstrap, framework);
        test_faucet::claim_trfl(seller);
        test_faucet::claim_tusd(buyer);

        let (sell_output, _, _) = quote_sell(1_000_000);
        sell_trfl(seller, 1_000_000, sell_output, 1_000);
        assert!(reflection_token::pool_pending_rewards() == 0, 1020);
        let pending_after_sell = pending_lp_rewards(1, signer::address_of(bootstrap));
        assert!(pending_after_sell > 0, 1021);

        let (buy_output, _, _) = quote_buy(1_000_000);
        buy_trfl(buyer, 1_000_000, buy_output, 1_000);
        assert!(reflection_token::pool_pending_rewards() == 0, 1022);
        assert!(pending_lp_rewards(1, signer::address_of(bootstrap)) >= pending_after_sell, 1023);
    }

    #[test(
        core = @reflection_core,
        assets = @test_assets,
        amm = @test_amm,
        bootstrap = @bootstrap_lp,
        framework = @0x1,
        provider = @0xa12,
        trader = @0x7ade,
    )]
    fun lp_transfer_add_and_remove_materialize_before_weight_changes(
        core: &signer,
        assets: &signer,
        amm: &signer,
        bootstrap: &signer,
        framework: &signer,
        provider: &signer,
        trader: &signer,
    ) acquires PoolState {
        launch_for_test(core, assets, amm, bootstrap, framework);
        let bootstrap_address = signer::address_of(bootstrap);
        let provider_address = signer::address_of(provider);
        test_faucet::claim_trfl(trader);

        let (first_sell_output, _, _) = quote_sell(1_000_000);
        sell_trfl(trader, 1_000_000, first_sell_output, 1_000);
        let bootstrap_lp_pending = pending_lp_rewards(1, bootstrap_address);
        assert!(bootstrap_lp_pending > 0, 1030);
        transfer_lp_shares(bootstrap, provider_address, 100_000_000);
        assert!(pending_lp_rewards(1, bootstrap_address) == 0, 1031);
        assert!(reflection_token::raw_balance(bootstrap_address) == bootstrap_lp_pending, 1032);

        test_faucet::claim_trfl(provider);
        test_faucet::claim_tusd(provider);
        let (second_sell_output, _, _) = quote_sell(1_000_000);
        sell_trfl(trader, 1_000_000, second_sell_output, 1_000);
        assert!(pending_lp_rewards(1, provider_address) > 0, 1033);
        assert!(reflection_token::pending_rewards(provider_address) > 0, 1034);
        add_liquidity(provider, 1_000_000, 1_000_000, 1, 1_000);
        assert!(pending_lp_rewards(1, provider_address) == 0, 1035);
        assert!(reflection_token::pending_rewards(provider_address) == 0, 1036);

        let (third_sell_output, _, _) = quote_sell(1_000_000);
        sell_trfl(trader, 1_000_000, third_sell_output, 1_000);
        assert!(pending_lp_rewards(1, provider_address) > 0, 1037);
        assert!(reflection_token::pending_rewards(provider_address) > 0, 1038);
        let provider_shares = lp_shares(1, provider_address);
        remove_liquidity(provider, provider_shares, 1, 1, 1_000);
        assert!(lp_shares(1, provider_address) == 0, 1039);
        assert!(pending_lp_rewards(1, provider_address) == 0, 1040);
        assert!(reflection_token::pending_rewards(provider_address) == 0, 1041);
        reflection_token::assert_accounting_backing();
    }
}
