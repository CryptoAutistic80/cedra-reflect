/// Project events are intentionally complete enough for an independent
/// indexer/reconciler to replay economic state without privileged access.
module reflection_core::reflection_events {
    use cedra_framework::event;

    #[event]
    struct ProtocolInitialized has drop, store {
        version: u64,
        deployment_id: vector<u8>,
        metadata: address,
        reward_vault: address,
        distribution_vault: address,
    }

    #[event]
    struct FaucetGrant has drop, store {
        recipient: address,
        amount: u64,
        operator: address,
    }

    #[event]
    struct WalletTransfer has drop, store {
        from: address,
        to: address,
        amount: u64,
    }

    // Dispatcher hooks receive one endpoint at a time. These two events make
    // every native primary-store transfer replayable without pretending a hook
    // can safely retain cross-callback transfer state.
    #[event]
    struct EligibleBalanceDebited has drop, store {
        account: address,
        amount: u64,
    }

    #[event]
    struct EligibleBalanceCredited has drop, store {
        account: address,
        amount: u64,
    }

    #[event]
    struct ReflectionFeeCollected has drop, store {
        account: address,
        gross_amount: u64,
        fee_amount: u64,
        kind: u8,
    }

    #[event]
    struct ReflectionIndexAdvanced has drop, store {
        old_index: u256,
        new_index: u256,
        remainder: u256,
        fee_amount: u64,
        eligible_supply: u128,
    }

    #[event]
    struct RewardsMaterialized has drop, store {
        account: address,
        amount: u64,
        total_claimed: u256,
    }

    #[event]
    struct RewardsClaimed has drop, store {
        account: address,
        amount: u64,
        total_claimed: u256,
    }

    #[event]
    struct PositionCreated has drop, store { account: address }

    #[event]
    struct CustodyAdapterRegistered has drop, store {
        adapter_id: u64,
        reserve_store: address,
        first_epoch: u64,
        lp_reward_vault: address,
    }

    #[event]
    struct CustodyEpochRouteOpened has drop, store {
        adapter_id: u64,
        epoch: u64,
        reserve_store: address,
        lp_reward_vault: address,
        retired_residue_magnified: u256,
    }

    #[event]
    struct CustodySharesChanged has drop, store {
        added: bool,
        amount: u64,
        custody_shares: u128,
        global_shares: u128,
    }

    #[event]
    struct CustodyRewardsRouted has drop, store {
        reserve_store: address,
        lp_reward_vault: address,
        epoch: u64,
        amount: u64,
        total_routed: u256,
    }

    #[event]
    struct FeeConfigurationChanged has drop, store {
        old_fee_bps: u64,
        new_fee_bps: u64,
    }

    #[event]
    struct PauseStateChanged has drop, store {
        swaps_paused: bool,
        claims_paused: bool,
    }

    #[event]
    struct OperationalAdminChanged has drop, store {
        old_operational_admin: address,
        new_operational_admin: address,
    }

    public fun protocol_initialized(version: u64, deployment_id: vector<u8>, metadata: address, reward_vault: address, distribution_vault: address) {
        event::emit(ProtocolInitialized { version, deployment_id, metadata, reward_vault, distribution_vault });
    }
    public fun faucet_grant(recipient: address, amount: u64, operator: address) { event::emit(FaucetGrant { recipient, amount, operator }); }
    public fun wallet_transfer(from: address, to: address, amount: u64) { event::emit(WalletTransfer { from, to, amount }); }
    public fun eligible_balance_debited(account: address, amount: u64) { event::emit(EligibleBalanceDebited { account, amount }); }
    public fun eligible_balance_credited(account: address, amount: u64) { event::emit(EligibleBalanceCredited { account, amount }); }
    public fun fee_collected(account: address, gross_amount: u64, fee_amount: u64, kind: u8) { event::emit(ReflectionFeeCollected { account, gross_amount, fee_amount, kind }); }
    public fun index_advanced(old_index: u256, new_index: u256, remainder: u256, fee_amount: u64, eligible_supply: u128) { event::emit(ReflectionIndexAdvanced { old_index, new_index, remainder, fee_amount, eligible_supply }); }
    public fun rewards_materialized(account: address, amount: u64, total_claimed: u256) { event::emit(RewardsMaterialized { account, amount, total_claimed }); }
    public fun rewards_claimed(account: address, amount: u64, total_claimed: u256) { event::emit(RewardsClaimed { account, amount, total_claimed }); }
    public fun position_created(account: address) { event::emit(PositionCreated { account }); }
    public fun custody_adapter_registered(
        reserve_store: address,
        lp_reward_vault: address,
    ) {
        event::emit(CustodyAdapterRegistered {
            adapter_id: 1,
            reserve_store,
            first_epoch: 1,
            lp_reward_vault,
        });
    }
    public fun custody_epoch_route_opened(
        epoch: u64,
        reserve_store: address,
        lp_reward_vault: address,
        retired_residue_magnified: u256,
    ) {
        event::emit(CustodyEpochRouteOpened {
            adapter_id: 1,
            epoch,
            reserve_store,
            lp_reward_vault,
            retired_residue_magnified,
        });
    }
    public fun custody_shares_changed(added: bool, amount: u64, custody_shares: u128, global_shares: u128) {
        event::emit(CustodySharesChanged { added, amount, custody_shares, global_shares });
    }
    public fun custody_rewards_routed(
        reserve_store: address,
        lp_reward_vault: address,
        epoch: u64,
        amount: u64,
        total_routed: u256,
    ) {
        event::emit(CustodyRewardsRouted { reserve_store, lp_reward_vault, epoch, amount, total_routed });
    }
    public fun fee_changed(old_fee_bps: u64, new_fee_bps: u64) { event::emit(FeeConfigurationChanged { old_fee_bps, new_fee_bps }); }
    public fun pause_changed(swaps_paused: bool, claims_paused: bool) { event::emit(PauseStateChanged { swaps_paused, claims_paused }); }
    public fun operational_admin_changed(old_operational_admin: address, new_operational_admin: address) {
        event::emit(OperationalAdminChanged { old_operational_admin, new_operational_admin });
    }
}
