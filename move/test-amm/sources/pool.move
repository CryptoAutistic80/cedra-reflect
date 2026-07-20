/// Canonical tRFL/tUSD constant-product Testnet pool with checkpointed LP
/// ownership and exact-once passthrough of the reserve's global reflections.
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

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_NOT_AMM_ADMIN: u64 = 2;
    const E_WRONG_AMM_ADDRESS: u64 = 3;
    const E_ZERO_AMOUNT: u64 = 4;
    const E_DEADLINE: u64 = 5;
    const E_MIN_OUTPUT: u64 = 6;
    const E_MAX_SWAP: u64 = 7;
    const E_MAX_RESERVE_PERCENT: u64 = 8;
    const E_INSUFFICIENT_LIQUIDITY: u64 = 9;
    const E_POOL_PAUSED: u64 = 10;
    const E_LIQUIDITY_PAUSED: u64 = 11;
    const E_LP_CLAIMS_PAUSED: u64 = 12;
    const E_ALREADY_SEEDED: u64 = 13;
    const E_NOT_SEEDED: u64 = 14;
    const E_NOT_PROPORTIONAL: u64 = 15;
    const E_FINAL_EXIT_REQUIRES_SHUTDOWN: u64 = 16;
    const E_NOT_SHUTDOWN: u64 = 17;
    const E_RESERVE_CUSTODY_MISMATCH: u64 = 18;
    const E_INVALID_BENEFICIARY: u64 = 19;
    const E_ACTIVE_EPOCH_EXISTS: u64 = 20;
    const E_INVALID_RECIPIENT: u64 = 21;
    const E_MAX_LIQUIDITY_CONTRIBUTION: u64 = 22;
    const E_MAX_LIQUIDITY_WITHDRAWAL: u64 = 23;
    const E_INVALID_LIQUIDITY_LIMIT: u64 = 24;
    const E_NOT_OPERATIONAL_ADMIN: u64 = 25;
    const E_INVALID_OPERATIONAL_ADMIN: u64 = 26;

    const BPS_DENOMINATOR: u64 = 10_000;
    const DEFAULT_AMM_FEE_BPS: u64 = 30;
    const DEFAULT_MAX_RESERVE_BPS: u64 = 2_000;
    const DEFAULT_MAX_GROSS_SWAP: u64 = 100_000_000_000;
    const DEFAULT_MAX_LIQUIDITY_RFL: u64 = 100_000_000_000;
    const DEFAULT_MAX_LIQUIDITY_USD: u64 = 100_000_000_000;
    const DEFAULT_MAX_WITHDRAWAL_SHARE_BPS: u64 = BPS_DENOMINATOR;
    const RFL_RESERVE_SEED: vector<u8> = b"reflection-amm-trfl-reserve-v1";
    const USD_RESERVE_SEED: vector<u8> = b"reflection-amm-tusd-reserve-v1";

    struct PoolState has key {
        admin: address,
        operational_admin: address,
        settlement_cap: SettlementCapability,
        custody_cap: CustodySettlementCapability,
        lp_cap: LpAccountingCapability,
        usd_pool_cap: PoolSettlementCapability,
        rfl_reserve: Object<FungibleStore>,
        usd_reserve: Object<FungibleStore>,
        amm_fee_bps: u64,
        max_reserve_bps: u64,
        max_gross_swap: u64,
        max_liquidity_rfl: u64,
        max_liquidity_usd: u64,
        max_withdrawal_share_bps: u64,
        pool_paused: bool,
        liquidity_paused: bool,
        lp_claims_paused: bool,
        shutdown_mode: bool,
        seeded: bool,
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

    #[event]
    struct SwapLimitsChanged has drop, store {
        amm_fee_bps: u64,
        max_reserve_bps: u64,
        max_gross_swap: u64,
    }

    #[event]
    struct LiquidityLimitsChanged has drop, store {
        max_rfl_contribution: u64,
        max_usd_contribution: u64,
        max_withdrawal_share_bps: u64,
    }

    #[event]
    struct PoolPauseChanged has drop, store {
        pool_paused: bool,
        liquidity_paused: bool,
        lp_claims_paused: bool,
        shutdown_mode: bool,
    }

    #[event]
    struct OperationalAdminChanged has drop, store {
        old_operational_admin: address,
        new_operational_admin: address,
    }

    public entry fun initialize(core_admin: &signer, assets_admin: &signer, amm_admin: &signer) {
        assert!(!exists<PoolState>(@test_amm), E_ALREADY_INITIALIZED);
        assert!(signer::address_of(amm_admin) == @test_amm, E_WRONG_AMM_ADDRESS);
        let rfl_constructor = object::create_named_object(amm_admin, RFL_RESERVE_SEED);
        let rfl_reserve = fungible_asset::create_store(&rfl_constructor, reflection_token::metadata());
        let usd_constructor = object::create_named_object(amm_admin, USD_RESERVE_SEED);
        let usd_reserve = fungible_asset::create_store(&usd_constructor, mock_usd::metadata());
        let lp_vault_constructor = object::create_object(@test_amm);
        let lp_reward_vault = fungible_asset::create_store(&lp_vault_constructor, reflection_token::metadata());
        let settlement_cap = reflection_token::issue_settlement_capability(core_admin);
        let custody_cap = reflection_token::register_canonical_custody(core_admin, rfl_reserve, lp_reward_vault);
        let lp_cap = lp_rewards::initialize(amm_admin, lp_reward_vault);
        let usd_pool_cap = mock_usd::issue_pool_settlement_capability(assets_admin);
        reflection_token::register_excluded_primary_store(core_admin, signer::address_of(assets_admin));
        reflection_token::register_excluded_primary_store(core_admin, signer::address_of(amm_admin));
        mock_usd::freeze_pool_reserve(&usd_pool_cap, usd_reserve);
        move_to(amm_admin, PoolState {
            admin: signer::address_of(amm_admin),
            operational_admin: signer::address_of(amm_admin),
            settlement_cap,
            custody_cap,
            lp_cap,
            usd_pool_cap,
            rfl_reserve,
            usd_reserve,
            amm_fee_bps: DEFAULT_AMM_FEE_BPS,
            max_reserve_bps: DEFAULT_MAX_RESERVE_BPS,
            max_gross_swap: DEFAULT_MAX_GROSS_SWAP,
            max_liquidity_rfl: DEFAULT_MAX_LIQUIDITY_RFL,
            max_liquidity_usd: DEFAULT_MAX_LIQUIDITY_USD,
            max_withdrawal_share_bps: DEFAULT_MAX_WITHDRAWAL_SHARE_BPS,
            pool_paused: false,
            liquidity_paused: false,
            lp_claims_paused: false,
            shutdown_mode: false,
            seeded: false,
        });
    }

    /// Controlled first bootstrap. Distribution-vault tRFL becomes custody
    /// shares atomically with assignment of every initial LP share.
    public entry fun seed_liquidity(
        core_admin: &signer,
        amm_admin: &signer,
        beneficiary: address,
        rfl_amount: u64,
        usd_amount: u64,
        min_lp_shares: u128,
    ) acquires PoolState {
        assert!(rfl_amount > 0 && usd_amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global<PoolState>(@test_amm);
        assert_amm_admin(state, amm_admin);
        assert!(!state.seeded, E_ALREADY_SEEDED);
        assert!(beneficiary != state.admin && reflection_token::wallet_is_registered(beneficiary), E_INVALID_BENEFICIARY);
        assert!(lp_rewards::active_epoch() == 1 && lp_rewards::total_active_shares() == 0, E_ACTIVE_EPOCH_EXISTS);
        let (before_rfl, before_usd) = reserves(state);
        assert!(before_rfl == 0 && before_usd == 0, E_ALREADY_SEEDED);
        let shares = reflection_settlement::initial_lp_shares(rfl_amount, usd_amount);
        assert!(shares > 0 && shares >= min_lp_shares, E_MIN_OUTPUT);
        reflection_token::seed_pool_from_distribution(&state.custody_cap, core_admin, state.rfl_reserve, rfl_amount);
        let usd = primary_fungible_store::withdraw(amm_admin, mock_usd::metadata(), usd_amount);
        mock_usd::deposit_to_pool(&state.usd_pool_cap, state.usd_reserve, usd);
        lp_rewards::mint_active(&state.lp_cap, beneficiary, shares);
        lp_rewards::assert_active_epoch_healthy(&state.lp_cap);
        lp_rewards::assert_epoch_backing(&state.lp_cap, 1);
        assert_reserve_custody(state);
        let (reserve_rfl, reserve_usd) = reserves(state);
        let epoch = lp_rewards::active_epoch();
        let mutable_state = borrow_global_mut<PoolState>(@test_amm);
        mutable_state.seeded = true;
        event::emit(LiquiditySeeded {
            epoch, provider: beneficiary, rfl_amount, usd_amount, lp_shares: shares, reserve_rfl, reserve_usd,
        });
    }

    /// Fresh bootstrap after an earlier epoch completed its final reserve exit.
    /// The previous epoch remains claim-only with its own vault/table.
    public entry fun reseed_liquidity(
        core_admin: &signer,
        amm_admin: &signer,
        beneficiary: address,
        rfl_amount: u64,
        usd_amount: u64,
        min_lp_shares: u128,
    ) acquires PoolState {
        assert!(rfl_amount > 0 && usd_amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global<PoolState>(@test_amm);
        assert_amm_admin(state, amm_admin);
        assert!(!state.seeded && !state.shutdown_mode, E_ALREADY_SEEDED);
        assert!(lp_rewards::active_epoch() == 0, E_ACTIVE_EPOCH_EXISTS);
        assert!(beneficiary != state.admin && reflection_token::wallet_is_registered(beneficiary), E_INVALID_BENEFICIARY);
        let (before_rfl, before_usd) = reserves(state);
        assert!(before_rfl == 0 && before_usd == 0, E_ALREADY_SEEDED);
        let lp_vault_constructor = object::create_object(@test_amm);
        let lp_reward_vault = fungible_asset::create_store(&lp_vault_constructor, reflection_token::metadata());
        let epoch = lp_rewards::open_epoch(&state.lp_cap, amm_admin, lp_reward_vault);
        reflection_token::open_custody_epoch_route(
            core_admin,
            &state.custody_cap,
            epoch,
            state.rfl_reserve,
            lp_reward_vault,
        );
        let shares = reflection_settlement::initial_lp_shares(rfl_amount, usd_amount);
        assert!(shares > 0 && shares >= min_lp_shares, E_MIN_OUTPUT);
        reflection_token::seed_pool_from_distribution(&state.custody_cap, core_admin, state.rfl_reserve, rfl_amount);
        let usd = primary_fungible_store::withdraw(amm_admin, mock_usd::metadata(), usd_amount);
        mock_usd::deposit_to_pool(&state.usd_pool_cap, state.usd_reserve, usd);
        lp_rewards::mint_active(&state.lp_cap, beneficiary, shares);
        lp_rewards::assert_active_epoch_healthy(&state.lp_cap);
        lp_rewards::assert_epoch_backing(&state.lp_cap, epoch);
        assert_reserve_custody(state);
        let (reserve_rfl, reserve_usd) = reserves(state);
        let mutable_state = borrow_global_mut<PoolState>(@test_amm);
        mutable_state.seeded = true;
        event::emit(LiquiditySeeded {
            epoch, provider: beneficiary, rfl_amount, usd_amount, lp_shares: shares, reserve_rfl, reserve_usd,
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
        assert!(state.seeded, E_NOT_SEEDED);
        assert!(!state.liquidity_paused && !state.shutdown_mode, E_LIQUIDITY_PAUSED);
        checkpoint_active(state);
        let (reserve_rfl, reserve_usd) = reserves(state);
        let total_shares = lp_rewards::total_active_shares();
        assert!(reserve_rfl > 0 && reserve_usd > 0 && total_shares > 0, E_INSUFFICIENT_LIQUIDITY);
        let (shares, rfl_used, usd_used) = reflection_settlement::liquidity_mint(
            max_rfl, max_usd, reserve_rfl, reserve_usd, total_shares,
        );
        assert!(
            rfl_used <= state.max_liquidity_rfl && usd_used <= state.max_liquidity_usd,
            E_MAX_LIQUIDITY_CONTRIBUTION,
        );
        assert!(shares > 0 && shares >= min_lp_shares && rfl_used > 0 && usd_used > 0, E_MIN_OUTPUT);
        assert!(rfl_used <= max_rfl && usd_used <= max_usd, E_NOT_PROPORTIONAL);
        custody_settlement::wallet_to_custody(&state.custody_cap, provider, state.rfl_reserve, rfl_used);
        let usd = primary_fungible_store::withdraw(provider, mock_usd::metadata(), usd_used);
        mock_usd::deposit_to_pool(&state.usd_pool_cap, state.usd_reserve, usd);
        let provider_address = signer::address_of(provider);
        lp_rewards::mint_active(&state.lp_cap, provider_address, shares);
        lp_rewards::assert_epoch_backing(&state.lp_cap, lp_rewards::active_epoch());
        assert_reserve_custody(state);
        let (after_rfl, after_usd) = reserves(state);
        event::emit(LiquidityAdded {
            epoch: lp_rewards::active_epoch(), provider: provider_address, rfl_amount: rfl_used,
            usd_amount: usd_used, lp_shares: shares, reserve_rfl: after_rfl, reserve_usd: after_usd,
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
        assert!(state.seeded, E_NOT_SEEDED);
        assert!(!state.liquidity_paused || state.shutdown_mode, E_LIQUIDITY_PAUSED);
        checkpoint_active(state);
        let epoch = lp_rewards::active_epoch();
        let provider_address = signer::address_of(provider);
        assert!(lp_rewards::position_shares(epoch, provider_address) >= shares, E_INSUFFICIENT_LIQUIDITY);
        let total_shares = lp_rewards::total_active_shares();
        let final_exit = shares == total_shares;
        if (final_exit) assert!(state.shutdown_mode, E_FINAL_EXIT_REQUIRES_SHUTDOWN);
        if (!final_exit) {
            assert!(
                (shares as u256) * (BPS_DENOMINATOR as u256)
                    <= (total_shares as u256) * (state.max_withdrawal_share_bps as u256),
                E_MAX_LIQUIDITY_WITHDRAWAL,
            );
        };
        let (reserve_rfl, reserve_usd) = reserves(state);
        let (rfl_out, usd_out) = reflection_settlement::liquidity_withdrawal(
            shares, total_shares, reserve_rfl, reserve_usd,
        );
        assert!(rfl_out > 0 && usd_out > 0, E_ZERO_AMOUNT);
        assert!(rfl_out >= min_rfl_output && usd_out >= min_usd_output, E_MIN_OUTPUT);
        lp_rewards::burn_active(&state.lp_cap, provider_address, shares);
        custody_settlement::custody_to_wallet(&state.custody_cap, state.rfl_reserve, provider, rfl_out);
        let usd = mock_usd::withdraw_from_pool(&state.usd_pool_cap, state.usd_reserve, usd_out);
        primary_fungible_store::deposit(provider_address, usd);
        assert_reserve_custody(state);
        let (after_rfl, after_usd) = reserves(state);
        lp_rewards::assert_epoch_backing(&state.lp_cap, epoch);
        if (final_exit) {
            assert!(after_rfl == 0 && after_usd == 0 && reflection_token::pool_pending_rewards() == 0, E_RESERVE_CUSTODY_MISMATCH);
            lp_rewards::mark_active_claim_only(&state.lp_cap);
            let mutable_state = borrow_global_mut<PoolState>(@test_amm);
            mutable_state.seeded = false;
            mutable_state.shutdown_mode = false;
        };
        event::emit(LiquidityRemoved {
            epoch, provider: provider_address, rfl_amount: rfl_out, usd_amount: usd_out,
            lp_shares: shares, final_exit, reserve_rfl: after_rfl, reserve_usd: after_usd,
        });
    }

    /// Module-mediated LP transfer. No FungibleStore exists for LP shares, so
    /// secondary/delegated custody cannot silently receive reward weight.
    public entry fun transfer_lp_shares(sender: &signer, recipient: address, shares: u128) acquires PoolState {
        assert!(shares > 0 && recipient != signer::address_of(sender), E_INVALID_RECIPIENT);
        assert!(reflection_token::wallet_is_registered(recipient), E_INVALID_RECIPIENT);
        let state = borrow_global<PoolState>(@test_amm);
        assert!(!state.liquidity_paused && !state.shutdown_mode, E_LIQUIDITY_PAUSED);
        checkpoint_active(state);
        lp_rewards::transfer_active(&state.lp_cap, signer::address_of(sender), recipient, shares);
        lp_rewards::assert_epoch_backing(&state.lp_cap, lp_rewards::active_epoch());
    }

    /// `amount == 0` claims all currently pending rewards for the epoch.
    public entry fun claim_lp_rewards(owner: &signer, epoch: u64, amount: u64) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert!(!state.lp_claims_paused, E_LP_CLAIMS_PAUSED);
        if (epoch == lp_rewards::active_epoch() && epoch > 0) checkpoint_active(state);
        let claimed = lp_rewards::prepare_claim(&state.lp_cap, epoch, signer::address_of(owner), amount);
        let vault = lp_rewards::reward_vault(epoch);
        custody_settlement::pay_lp_claim(&state.custody_cap, owner, epoch, vault, claimed);
        lp_rewards::assert_epoch_backing(&state.lp_cap, epoch);
        reflection_token::assert_accounting_backing();
    }

    /// Permissionless accounting checkpoint. The caller receives no special
    /// authority or funds; this only routes the canonical reserve position's
    /// whole pending reward into the active LP epoch at the pre-checkpoint LP
    /// share weights.
    public entry fun checkpoint_lp_rewards(_caller: &signer) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert!(state.seeded, E_NOT_SEEDED);
        checkpoint_active(state);
    }

    /// The AMM publisher remains the cold package/capability authority. This
    /// evented handoff assigns routine pause, shutdown, fee, and limit controls
    /// to a separate operational key.
    public entry fun set_operational_admin(
        amm_publisher: &signer,
        new_operational_admin: address,
    ) acquires PoolState {
        assert!(new_operational_admin != @0x0, E_INVALID_OPERATIONAL_ADMIN);
        let state = borrow_global_mut<PoolState>(@test_amm);
        assert_amm_admin(state, amm_publisher);
        let old_operational_admin = state.operational_admin;
        state.operational_admin = new_operational_admin;
        event::emit(OperationalAdminChanged {
            old_operational_admin,
            new_operational_admin,
        });
    }

    public entry fun begin_shutdown(amm_admin: &signer) acquires PoolState {
        let state = borrow_global_mut<PoolState>(@test_amm);
        assert_operational_admin(state, amm_admin);
        assert!(state.seeded, E_NOT_SEEDED);
        state.pool_paused = true;
        state.shutdown_mode = true;
        state.liquidity_paused = false;
        event::emit(PoolPauseChanged {
            pool_paused: state.pool_paused,
            liquidity_paused: state.liquidity_paused,
            lp_claims_paused: state.lp_claims_paused,
            shutdown_mode: state.shutdown_mode,
        });
    }

    public entry fun configure_pauses(
        amm_admin: &signer,
        pool_paused: bool,
        liquidity_paused: bool,
        lp_claims_paused: bool,
    ) acquires PoolState {
        let state = borrow_global_mut<PoolState>(@test_amm);
        assert_operational_admin(state, amm_admin);
        assert!(!state.shutdown_mode, E_NOT_SHUTDOWN);
        state.pool_paused = pool_paused;
        state.liquidity_paused = liquidity_paused;
        state.lp_claims_paused = lp_claims_paused;
        event::emit(PoolPauseChanged {
            pool_paused, liquidity_paused, lp_claims_paused, shutdown_mode: state.shutdown_mode,
        });
    }

    public entry fun configure_limits(
        amm_admin: &signer,
        amm_fee_bps: u64,
        max_reserve_bps: u64,
        max_gross_swap: u64,
    ) acquires PoolState {
        assert!(
            amm_fee_bps <= 100
                && max_reserve_bps > 0
                && max_reserve_bps <= BPS_DENOMINATOR
                && max_gross_swap > 0,
            E_MAX_SWAP,
        );
        let state = borrow_global_mut<PoolState>(@test_amm);
        assert_operational_admin(state, amm_admin);
        state.amm_fee_bps = amm_fee_bps;
        state.max_reserve_bps = max_reserve_bps;
        state.max_gross_swap = max_gross_swap;
        event::emit(SwapLimitsChanged { amm_fee_bps, max_reserve_bps, max_gross_swap });
    }

    public entry fun configure_liquidity_limits(
        amm_admin: &signer,
        max_rfl_contribution: u64,
        max_usd_contribution: u64,
        max_withdrawal_share_bps: u64,
    ) acquires PoolState {
        assert!(
            max_rfl_contribution > 0
                && max_usd_contribution > 0
                && max_withdrawal_share_bps > 0
                && max_withdrawal_share_bps <= BPS_DENOMINATOR,
            E_INVALID_LIQUIDITY_LIMIT,
        );
        let state = borrow_global_mut<PoolState>(@test_amm);
        assert_operational_admin(state, amm_admin);
        state.max_liquidity_rfl = max_rfl_contribution;
        state.max_liquidity_usd = max_usd_contribution;
        state.max_withdrawal_share_bps = max_withdrawal_share_bps;
        event::emit(LiquidityLimitsChanged {
            max_rfl_contribution,
            max_usd_contribution,
            max_withdrawal_share_bps,
        });
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
        assert_swap_bounds(state, gross_trfl_input, true);
        let (rfl_before, usd_before) = reserves(state);
        let reflection_fee = reflection_token::reflection_fee_for(gross_trfl_input);
        let net_input = gross_trfl_input - reflection_fee;
        let (gross_output, amm_fee) = reflection_settlement::constant_product_output(
            rfl_before, usd_before, net_input, state.amm_fee_bps,
        );
        assert_reserve_output_cap(state, gross_output, usd_before);
        assert!(gross_output > 0 && gross_output >= min_tusd_output, E_MIN_OUTPUT);
        let (settled_net, settled_fee) = reflection_token::settle_sell(
            &state.settlement_cap, seller, state.rfl_reserve, gross_trfl_input,
        );
        assert!(settled_net == net_input && settled_fee == reflection_fee, E_INSUFFICIENT_LIQUIDITY);
        let usd = mock_usd::withdraw_from_pool(&state.usd_pool_cap, state.usd_reserve, gross_output);
        primary_fungible_store::deposit(signer::address_of(seller), usd);
        assert_reserve_custody(state);
        let (reserve_rfl, reserve_usd) = reserves(state);
        event::emit(SwapExecuted {
            trader: signer::address_of(seller), is_sell: true, gross_input: gross_trfl_input,
            reflection_fee, amm_fee, gross_output, net_output: gross_output, reserve_rfl, reserve_usd,
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
        assert_swap_bounds(state, tusd_input, false);
        let (rfl_before, usd_before) = reserves(state);
        let (gross_output, amm_fee) = reflection_settlement::constant_product_output(
            usd_before, rfl_before, tusd_input, state.amm_fee_bps,
        );
        assert_reserve_output_cap(state, gross_output, rfl_before);
        let reflection_fee = reflection_token::reflection_fee_for(gross_output);
        let net_output = gross_output - reflection_fee;
        assert!(net_output > 0 && net_output >= min_net_trfl_output, E_MIN_OUTPUT);
        let usd = primary_fungible_store::withdraw(buyer, mock_usd::metadata(), tusd_input);
        mock_usd::deposit_to_pool(&state.usd_pool_cap, state.usd_reserve, usd);
        let (settled_net, settled_fee) = reflection_token::settle_buy(
            &state.settlement_cap, buyer, state.rfl_reserve, gross_output,
        );
        assert!(settled_net == net_output && settled_fee == reflection_fee, E_INSUFFICIENT_LIQUIDITY);
        assert_reserve_custody(state);
        let (reserve_rfl, reserve_usd) = reserves(state);
        event::emit(SwapExecuted {
            trader: signer::address_of(buyer), is_sell: false, gross_input: tusd_input,
            reflection_fee, amm_fee, gross_output, net_output, reserve_rfl, reserve_usd,
        });
    }

    #[view]
    public fun quote_sell(gross_trfl_input: u64): (u64, u64, u64) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        assert_swap_bounds(state, gross_trfl_input, true);
        let (rfl, usd) = reserves(state);
        let reflection_fee = reflection_token::reflection_fee_for(gross_trfl_input);
        let (output, amm_fee) = reflection_settlement::constant_product_output(
            rfl, usd, gross_trfl_input - reflection_fee, state.amm_fee_bps,
        );
        assert_reserve_output_cap(state, output, usd);
        assert!(output > 0, E_MIN_OUTPUT);
        (output, reflection_fee, amm_fee)
    }

    #[view]
    public fun quote_buy(tusd_input: u64): (u64, u64, u64) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        assert_pool_live(state);
        assert_swap_bounds(state, tusd_input, false);
        let (rfl, usd) = reserves(state);
        let (gross_output, amm_fee) = reflection_settlement::constant_product_output(
            usd, rfl, tusd_input, state.amm_fee_bps,
        );
        assert_reserve_output_cap(state, gross_output, rfl);
        assert!(gross_output > 0, E_MIN_OUTPUT);
        let reflection_fee = reflection_token::reflection_fee_for(gross_output);
        let net_output = gross_output - reflection_fee;
        assert!(net_output > 0, E_MIN_OUTPUT);
        (net_output, reflection_fee, amm_fee)
    }

    #[view]
    public fun reserves_view(): (u64, u64) acquires PoolState { reserves(borrow_global<PoolState>(@test_amm)) }
    #[view]
    public fun rfl_reserve_store(): Object<FungibleStore> acquires PoolState { borrow_global<PoolState>(@test_amm).rfl_reserve }
    #[view]
    public fun usd_reserve_store(): Object<FungibleStore> acquires PoolState { borrow_global<PoolState>(@test_amm).usd_reserve }
    #[view]
    public fun limits(): (u64, u64, u64) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        (state.amm_fee_bps, state.max_reserve_bps, state.max_gross_swap)
    }
    #[view]
    public fun liquidity_limits(): (u64, u64, u64) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        (
            state.max_liquidity_rfl,
            state.max_liquidity_usd,
            state.max_withdrawal_share_bps,
        )
    }
    #[view]
    public fun pause_state(): (bool, bool, bool, bool, bool) acquires PoolState {
        let state = borrow_global<PoolState>(@test_amm);
        (
            state.pool_paused,
            state.liquidity_paused,
            state.lp_claims_paused,
            state.shutdown_mode,
            state.seeded,
        )
    }
    #[view]
    public fun operational_admin(): address acquires PoolState {
        borrow_global<PoolState>(@test_amm).operational_admin
    }
    #[view]
    public fun active_epoch(): u64 { lp_rewards::active_epoch() }
    #[view]
    public fun lp_shares(epoch: u64, owner: address): u128 { lp_rewards::position_shares(epoch, owner) }
    #[view]
    public fun pending_lp_rewards(epoch: u64, owner: address): u64 { lp_rewards::pending_rewards(epoch, owner) }
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

    fun checkpoint_active(state: &PoolState) {
        lp_rewards::assert_active_epoch_healthy(&state.lp_cap);
        let epoch = lp_rewards::active_epoch();
        assert!(epoch > 0, E_NOT_SEEDED);
        let vault = lp_rewards::active_reward_vault();
        let amount = custody_settlement::checkpoint(&state.custody_cap, state.rfl_reserve, epoch, vault);
        if (amount > 0) lp_rewards::receive_routed_reward(&state.lp_cap, amount);
        lp_rewards::assert_epoch_backing(&state.lp_cap, epoch);
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
        assert!(state.seeded, E_NOT_SEEDED);
        assert!(!state.pool_paused && !state.shutdown_mode, E_POOL_PAUSED);
        lp_rewards::assert_active_epoch_healthy(&state.lp_cap);
    }

    fun assert_amm_admin(state: &PoolState, admin: &signer) {
        assert!(signer::address_of(admin) == state.admin, E_NOT_AMM_ADMIN);
    }

    fun assert_operational_admin(state: &PoolState, admin: &signer) {
        assert!(
            signer::address_of(admin) == state.operational_admin,
            E_NOT_OPERATIONAL_ADMIN,
        );
    }

    fun assert_deadline(deadline: u64) { assert!(timestamp::now_seconds() <= deadline, E_DEADLINE); }

    fun assert_swap_bounds(state: &PoolState, amount: u64, is_sell: bool) {
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(amount <= state.max_gross_swap, E_MAX_SWAP);
        let (rfl, usd) = reserves(state);
        let reserve = if (is_sell) rfl else usd;
        assert!(
            reserve > 0
                && (amount as u128) * (BPS_DENOMINATOR as u128)
                    <= (reserve as u128) * (state.max_reserve_bps as u128),
            E_MAX_RESERVE_PERCENT,
        );
    }

    fun assert_reserve_output_cap(state: &PoolState, output: u64, reserve_out: u64) {
        assert!(
            (output as u128) * (BPS_DENOMINATOR as u128)
                <= (reserve_out as u128) * (state.max_reserve_bps as u128),
            E_MAX_RESERVE_PERCENT,
        );
    }
}
