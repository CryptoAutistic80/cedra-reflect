/// Project events are intentionally complete enough for an independent
/// indexer/reconciler to replay economic state without privileged access.
module reflection_core::reflection_events {
    use cedra_framework::event;

    #[event]
    struct TokenCreated has drop, store {
        version: u64,
        release_major: u64,
        release_minor: u64,
        release_patch: u64,
        deployment_id: vector<u8>,
        network_label: vector<u8>,
        metadata: address,
        reward_vault: address,
        distribution_vault: address,
        reflection_fee_bps: u64,
        total_supply: u64,
        decimals: u8,
    }

    #[event]
    struct CoreLaunchSealed has drop, store {
        reflection_fee_bps: u64,
        metadata: address,
        reward_vault: address,
        distribution_vault: address,
        pool_store: address,
    }

    #[event]
    struct CorePoolClosed has drop, store {
        pool_store: address,
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
        fee_bps: u64,
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
        trigger: u8,
    }

    #[event]
    struct RewardsClaimed has drop, store {
        account: address,
        amount: u64,
        total_claimed: u256,
    }

    #[event]
    struct PositionCreated has drop, store { account: address }

    // Emitted exactly once when an address first joins the canonical
    // primary-store reflection surface. `primary_store` is included so an
    // indexer can reject secondary-store lookalikes without reconstructing
    // object addresses off chain.
    #[event]
    struct WalletRegistered has drop, store {
        account: address,
        primary_store: address,
        registered_wallet_count: u64,
    }

    #[event]
    struct CustodyAdapterRegistered has drop, store {
        adapter_id: u64,
        reserve_store: address,
        first_epoch: u64,
        lp_reward_vault: address,
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
    struct ProtocolPrimaryStoreExcluded has drop, store {
        account: address,
        store: address,
    }

    // Event constructors are package-only. Exposing them publicly would let an
    // unrelated module emit authentic-looking protocol events without making
    // the corresponding state transition.
    public(package) fun token_created(
        version: u64,
        release_major: u64,
        release_minor: u64,
        release_patch: u64,
        deployment_id: vector<u8>,
        network_label: vector<u8>,
        metadata: address,
        reward_vault: address,
        distribution_vault: address,
        reflection_fee_bps: u64,
        total_supply: u64,
        decimals: u8,
    ) {
        event::emit(TokenCreated {
            version,
            release_major,
            release_minor,
            release_patch,
            deployment_id,
            network_label,
            metadata,
            reward_vault,
            distribution_vault,
            reflection_fee_bps,
            total_supply,
            decimals,
        });
    }
    public(package) fun core_launch_sealed(
        reflection_fee_bps: u64,
        metadata: address,
        reward_vault: address,
        distribution_vault: address,
        pool_store: address,
    ) {
        event::emit(CoreLaunchSealed {
            reflection_fee_bps,
            metadata,
            reward_vault,
            distribution_vault,
            pool_store,
        });
    }
    public(package) fun core_pool_closed(pool_store: address) {
        event::emit(CorePoolClosed { pool_store });
    }
    public(package) fun faucet_grant(recipient: address, amount: u64, operator: address) { event::emit(FaucetGrant { recipient, amount, operator }); }
    public(package) fun wallet_transfer(from: address, to: address, amount: u64) { event::emit(WalletTransfer { from, to, amount }); }
    public(package) fun eligible_balance_debited(account: address, amount: u64) { event::emit(EligibleBalanceDebited { account, amount }); }
    public(package) fun eligible_balance_credited(account: address, amount: u64) { event::emit(EligibleBalanceCredited { account, amount }); }
    public(package) fun fee_collected(
        account: address,
        gross_amount: u64,
        fee_amount: u64,
        fee_bps: u64,
        kind: u8,
    ) {
        event::emit(ReflectionFeeCollected { account, gross_amount, fee_amount, fee_bps, kind });
    }
    public(package) fun index_advanced(old_index: u256, new_index: u256, remainder: u256, fee_amount: u64, eligible_supply: u128) { event::emit(ReflectionIndexAdvanced { old_index, new_index, remainder, fee_amount, eligible_supply }); }
    public(package) fun rewards_materialized(account: address, amount: u64, total_claimed: u256, trigger: u8) { event::emit(RewardsMaterialized { account, amount, total_claimed, trigger }); }
    public(package) fun rewards_claimed(account: address, amount: u64, total_claimed: u256) { event::emit(RewardsClaimed { account, amount, total_claimed }); }
    public(package) fun position_created(account: address) { event::emit(PositionCreated { account }); }
    public(package) fun wallet_registered(
        account: address,
        primary_store: address,
        registered_wallet_count: u64,
    ) {
        event::emit(WalletRegistered {
            account,
            primary_store,
            registered_wallet_count,
        });
    }
    public(package) fun custody_adapter_registered(
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
    public(package) fun custody_shares_changed(added: bool, amount: u64, custody_shares: u128, global_shares: u128) {
        event::emit(CustodySharesChanged { added, amount, custody_shares, global_shares });
    }
    public(package) fun custody_rewards_routed(
        reserve_store: address,
        lp_reward_vault: address,
        epoch: u64,
        amount: u64,
        total_routed: u256,
    ) {
        event::emit(CustodyRewardsRouted { reserve_store, lp_reward_vault, epoch, amount, total_routed });
    }
    public(package) fun protocol_primary_store_excluded(
        account: address,
        store: address,
    ) {
        event::emit(ProtocolPrimaryStoreExcluded { account, store });
    }
}
