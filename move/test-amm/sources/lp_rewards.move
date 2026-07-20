/// Checkpointed LP-share and downstream reflection accounting.
///
/// Shares are module-accounted positions rather than freely transferable FA
/// stores. This keeps the initial release fail-closed against secondary-store and delegated LP
/// custody while still supporting an explicit checkpointed transfer entry.
module test_amm::lp_rewards {
    use cedra_framework::event;
    use cedra_framework::fungible_asset::{FungibleStore};
    use cedra_framework::object::{Self, Object};
    use reflection_core::reflection_math::{Self, SignedU256};
    use reflection_core::reflection_token;
    use std::signer;
    use std::table::{Self, Table};

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_WRONG_AMM_ADDRESS: u64 = 2;
    const E_INVALID_CAPABILITY: u64 = 3;
    const E_NO_ACTIVE_EPOCH: u64 = 4;
    const E_EPOCH_NOT_ACTIVE: u64 = 5;
    const E_EPOCH_NOT_CLAIMABLE: u64 = 6;
    const E_ZERO_AMOUNT: u64 = 7;
    const E_INSUFFICIENT_SHARES: u64 = 8;
    const E_CLAIM_EXCEEDS_PENDING: u64 = 9;
    const E_ZERO_DENOMINATOR_QUARANTINE: u64 = 10;
    const E_EPOCH_NOT_EMPTY: u64 = 11;
    const E_VAULT_ACCOUNTING: u64 = 12;
    const E_EPOCH_ALREADY_ACTIVE: u64 = 13;

    const STATUS_ACTIVE: u8 = 1;
    const STATUS_CLAIM_ONLY: u8 = 2;

    struct LpAccountingCapability has store { nonce: u64 }

    struct LpPosition has store {
        shares: u128,
        correction: SignedU256,
        claimed: u256,
    }

    struct LpEpoch has store {
        epoch_id: u64,
        state_id: address,
        status: u8,
        reward_vault: Object<FungibleStore>,
        index: u256,
        index_remainder: u256,
        total_shares: u128,
        aggregate_correction: SignedU256,
        unallocated_rewards: u128,
        rounding_reserve: u128,
        lifetime_received: u256,
        lifetime_claimed: u256,
        quarantined: bool,
        positions: Table<address, LpPosition>,
    }

    struct LpEpochRegistry has key {
        active_epoch: u64,
        next_epoch: u64,
        epochs: Table<u64, LpEpoch>,
    }

    #[event]
    struct LpEpochOpened has drop, store {
        epoch: u64,
        state_id: address,
        reward_vault: address,
    }
    #[event]
    struct LpEpochStatusChanged has drop, store { epoch: u64, old_status: u8, new_status: u8 }
    #[event]
    struct LpSharesChanged has drop, store {
        epoch: u64,
        owner: address,
        added: bool,
        amount: u128,
        owner_shares: u128,
        total_shares: u128,
    }
    #[event]
    struct LpSharesTransferred has drop, store {
        epoch: u64,
        sender: address,
        recipient: address,
        amount: u128,
    }
    #[event]
    struct LpRewardIndexAdvanced has drop, store {
        epoch: u64,
        old_index: u256,
        new_index: u256,
        remainder: u256,
        received: u64,
        total_shares: u128,
        rounding_reserve: u128,
    }
    #[event]
    struct LpRewardsClaimed has drop, store {
        epoch: u64,
        owner: address,
        amount: u64,
        total_claimed: u256,
    }
    #[event]
    struct LpRewardQuarantined has drop, store {
        epoch: u64,
        amount: u64,
        unallocated_rewards: u128,
        reward_vault: address,
    }

    public fun initialize(amm_admin: &signer, first_reward_vault: Object<FungibleStore>): LpAccountingCapability {
        assert!(signer::address_of(amm_admin) == @test_amm, E_WRONG_AMM_ADDRESS);
        assert!(!exists<LpEpochRegistry>(@test_amm), E_ALREADY_INITIALIZED);
        let epochs = table::new<u64, LpEpoch>();
        let state_constructor = object::create_object(@test_amm);
        let state_id = object::address_from_constructor_ref(&state_constructor);
        table::add(&mut epochs, 1, new_epoch(1, state_id, first_reward_vault));
        move_to(amm_admin, LpEpochRegistry { active_epoch: 1, next_epoch: 2, epochs });
        event::emit(LpEpochOpened {
            epoch: 1,
            state_id,
            reward_vault: object::object_address(&first_reward_vault),
        });
        LpAccountingCapability { nonce: 1 }
    }

    public fun open_epoch(
        cap: &LpAccountingCapability,
        amm_admin: &signer,
        reward_vault: Object<FungibleStore>,
    ): u64 acquires LpEpochRegistry {
        assert_cap(cap);
        assert!(signer::address_of(amm_admin) == @test_amm, E_WRONG_AMM_ADDRESS);
        let registry = borrow_global_mut<LpEpochRegistry>(@test_amm);
        assert!(registry.active_epoch == 0, E_EPOCH_ALREADY_ACTIVE);
        let epoch = registry.next_epoch;
        let state_constructor = object::create_object(@test_amm);
        let state_id = object::address_from_constructor_ref(&state_constructor);
        registry.next_epoch = epoch + 1;
        registry.active_epoch = epoch;
        table::add(&mut registry.epochs, epoch, new_epoch(epoch, state_id, reward_vault));
        event::emit(LpEpochOpened {
            epoch,
            state_id,
            reward_vault: object::object_address(&reward_vault),
        });
        epoch
    }

    /// Accounts for tRFL already moved into the active epoch's frozen vault.
    public fun receive_routed_reward(cap: &LpAccountingCapability, amount: u64) acquires LpEpochRegistry {
        assert_cap(cap);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let registry = borrow_global_mut<LpEpochRegistry>(@test_amm);
        let epoch_id = registry.active_epoch;
        assert!(epoch_id > 0, E_NO_ACTIVE_EPOCH);
        let epoch = table::borrow_mut(&mut registry.epochs, epoch_id);
        // The pool preflights health before moving custody funds. This branch
        // remains as defense in depth for any future internal caller that
        // already moved a routed amount before discovering a zero denominator.
        assert_active_mutation(epoch);
        epoch.lifetime_received = epoch.lifetime_received + (amount as u256);
        if (epoch.total_shares == 0) {
            epoch.unallocated_rewards = epoch.unallocated_rewards + (amount as u128);
            epoch.quarantined = true;
            recompute_rounding(epoch);
            event::emit(LpRewardQuarantined {
                epoch: epoch_id,
                amount,
                unallocated_rewards: epoch.unallocated_rewards,
                reward_vault: object::object_address(&epoch.reward_vault),
            });
            return
        };
        let old_index = epoch.index;
        let numerator = (amount as u256) * reflection_math::magnitude() + epoch.index_remainder;
        let shares = epoch.total_shares as u256;
        epoch.index = epoch.index + numerator / shares;
        epoch.index_remainder = numerator % shares;
        recompute_rounding(epoch);
        event::emit(LpRewardIndexAdvanced {
            epoch: epoch_id,
            old_index,
            new_index: epoch.index,
            remainder: epoch.index_remainder,
            received: amount,
            total_shares: epoch.total_shares,
            rounding_reserve: epoch.rounding_reserve,
        });
    }

    public fun mint_active(cap: &LpAccountingCapability, owner: address, amount: u128) acquires LpEpochRegistry {
        assert_cap(cap);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let registry = borrow_global_mut<LpEpochRegistry>(@test_amm);
        let epoch_id = registry.active_epoch;
        assert!(epoch_id > 0, E_NO_ACTIVE_EPOCH);
        let epoch = table::borrow_mut(&mut registry.epochs, epoch_id);
        assert_active_mutation(epoch);
        // Zero shares is permitted only for the first mint of a fresh epoch.
        if (epoch.total_shares > 0) assert_active_epoch_healthy_internal(epoch);
        ensure_position(epoch, owner);
        let delta = (amount as u256) * epoch.index;
        let owner_shares = {
            let position = table::borrow_mut(&mut epoch.positions, owner);
            position.shares = position.shares + amount;
            reflection_math::subtract_unsigned(&mut position.correction, delta);
            position.shares
        };
        reflection_math::subtract_unsigned(&mut epoch.aggregate_correction, delta);
        epoch.total_shares = epoch.total_shares + amount;
        event::emit(LpSharesChanged {
            epoch: epoch_id, owner, added: true, amount, owner_shares, total_shares: epoch.total_shares,
        });
    }

    public fun burn_active(cap: &LpAccountingCapability, owner: address, amount: u128) acquires LpEpochRegistry {
        assert_cap(cap);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let registry = borrow_global_mut<LpEpochRegistry>(@test_amm);
        let epoch_id = registry.active_epoch;
        assert!(epoch_id > 0, E_NO_ACTIVE_EPOCH);
        let epoch = table::borrow_mut(&mut registry.epochs, epoch_id);
        assert_active_epoch_healthy_internal(epoch);
        ensure_position(epoch, owner);
        let delta = (amount as u256) * epoch.index;
        let owner_shares = {
            let position = table::borrow_mut(&mut epoch.positions, owner);
            assert!(position.shares >= amount, E_INSUFFICIENT_SHARES);
            position.shares = position.shares - amount;
            reflection_math::add_unsigned(&mut position.correction, delta);
            position.shares
        };
        reflection_math::add_unsigned(&mut epoch.aggregate_correction, delta);
        epoch.total_shares = epoch.total_shares - amount;
        event::emit(LpSharesChanged {
            epoch: epoch_id, owner, added: false, amount, owner_shares, total_shares: epoch.total_shares,
        });
    }

    public fun transfer_active(
        cap: &LpAccountingCapability,
        sender: address,
        recipient: address,
        amount: u128,
    ) acquires LpEpochRegistry {
        assert_cap(cap);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let registry = borrow_global_mut<LpEpochRegistry>(@test_amm);
        let epoch_id = registry.active_epoch;
        assert!(epoch_id > 0, E_NO_ACTIVE_EPOCH);
        let epoch = table::borrow_mut(&mut registry.epochs, epoch_id);
        assert_active_epoch_healthy_internal(epoch);
        ensure_position(epoch, sender);
        ensure_position(epoch, recipient);
        let delta = (amount as u256) * epoch.index;
        {
            let sender_position = table::borrow_mut(&mut epoch.positions, sender);
            assert!(sender_position.shares >= amount, E_INSUFFICIENT_SHARES);
            sender_position.shares = sender_position.shares - amount;
            reflection_math::add_unsigned(&mut sender_position.correction, delta);
        };
        {
            let recipient_position = table::borrow_mut(&mut epoch.positions, recipient);
            recipient_position.shares = recipient_position.shares + amount;
            reflection_math::subtract_unsigned(&mut recipient_position.correction, delta);
        };
        event::emit(LpSharesTransferred { epoch: epoch_id, sender, recipient, amount });
    }

    /// Mutates only LP accounting. The caller must complete the corresponding
    /// core-vault payout in the same transaction; an abort rolls this back.
    public fun prepare_claim(
        cap: &LpAccountingCapability,
        epoch_id: u64,
        owner: address,
        requested: u64,
    ): u64 acquires LpEpochRegistry {
        assert_cap(cap);
        let registry = borrow_global_mut<LpEpochRegistry>(@test_amm);
        let epoch = table::borrow_mut(&mut registry.epochs, epoch_id);
        assert!(epoch.status == STATUS_ACTIVE || epoch.status == STATUS_CLAIM_ONLY, E_EPOCH_NOT_CLAIMABLE);
        if (epoch.status == STATUS_ACTIVE) assert_active_epoch_healthy_internal(epoch);
        let pending = pending_for(epoch, owner);
        let amount = if (requested == 0) pending else requested;
        assert!(amount > 0 && amount <= pending, E_CLAIM_EXCEEDS_PENDING);
        let total_claimed = {
            let position = table::borrow_mut(&mut epoch.positions, owner);
            position.claimed = position.claimed + (amount as u256);
            position.claimed
        };
        epoch.lifetime_claimed = epoch.lifetime_claimed + (amount as u256);
        event::emit(LpRewardsClaimed { epoch: epoch_id, owner, amount, total_claimed });
        amount
    }

    public fun mark_active_claim_only(cap: &LpAccountingCapability) acquires LpEpochRegistry {
        assert_cap(cap);
        let registry = borrow_global_mut<LpEpochRegistry>(@test_amm);
        let epoch_id = registry.active_epoch;
        assert!(epoch_id > 0, E_NO_ACTIVE_EPOCH);
        let epoch = table::borrow_mut(&mut registry.epochs, epoch_id);
        assert!(epoch.status == STATUS_ACTIVE && epoch.total_shares == 0, E_EPOCH_NOT_EMPTY);
        let old_status = epoch.status;
        epoch.status = STATUS_CLAIM_ONLY;
        registry.active_epoch = 0;
        event::emit(LpEpochStatusChanged { epoch: epoch_id, old_status, new_status: STATUS_CLAIM_ONLY });
    }

    /// Capability-gated liveness guard for every active-epoch operation that
    /// can move custody rewards or mutate LP weights. A claim-only epoch is a
    /// terminal historical ledger and is intentionally excluded.
    public fun assert_active_epoch_healthy(
        cap: &LpAccountingCapability,
    ) acquires LpEpochRegistry {
        assert_cap(cap);
        let registry = borrow_global<LpEpochRegistry>(@test_amm);
        let epoch_id = registry.active_epoch;
        assert!(epoch_id > 0, E_NO_ACTIVE_EPOCH);
        assert_active_epoch_healthy_internal(table::borrow(&registry.epochs, epoch_id));
    }

    #[view]
    public fun active_epoch(): u64 acquires LpEpochRegistry {
        borrow_global<LpEpochRegistry>(@test_amm).active_epoch
    }

    #[view]
    public fun active_reward_vault(): Object<FungibleStore> acquires LpEpochRegistry {
        let registry = borrow_global<LpEpochRegistry>(@test_amm);
        assert!(registry.active_epoch > 0, E_NO_ACTIVE_EPOCH);
        table::borrow(&registry.epochs, registry.active_epoch).reward_vault
    }

    #[view]
    public fun reward_vault(epoch_id: u64): Object<FungibleStore> acquires LpEpochRegistry {
        table::borrow(&borrow_global<LpEpochRegistry>(@test_amm).epochs, epoch_id).reward_vault
    }

    #[view]
    public fun total_active_shares(): u128 acquires LpEpochRegistry {
        let registry = borrow_global<LpEpochRegistry>(@test_amm);
        if (registry.active_epoch == 0) return 0;
        table::borrow(&registry.epochs, registry.active_epoch).total_shares
    }

    #[view]
    public fun position_shares(epoch_id: u64, owner: address): u128 acquires LpEpochRegistry {
        let registry = borrow_global<LpEpochRegistry>(@test_amm);
        let epoch = table::borrow(&registry.epochs, epoch_id);
        if (!table::contains(&epoch.positions, owner)) return 0;
        table::borrow(&epoch.positions, owner).shares
    }

    #[view]
    public fun pending_rewards(epoch_id: u64, owner: address): u64 acquires LpEpochRegistry {
        pending_for(table::borrow(&borrow_global<LpEpochRegistry>(@test_amm).epochs, epoch_id), owner)
    }

    #[view]
    public fun epoch_accounting(epoch_id: u64): (u8, u256, u256, u128, u128, u128, u256, u256, u256) acquires LpEpochRegistry {
        let epoch = table::borrow(&borrow_global<LpEpochRegistry>(@test_amm).epochs, epoch_id);
        (
            epoch.status,
            epoch.index,
            epoch.index_remainder,
            epoch.total_shares,
            epoch.unallocated_rewards,
            epoch.rounding_reserve,
            epoch.lifetime_received,
            epoch.lifetime_claimed,
            aggregate_liability(epoch),
        )
    }

    #[view]
    public fun epoch_identity(epoch_id: u64): (address, address, u8, bool) acquires LpEpochRegistry {
        let epoch = table::borrow(&borrow_global<LpEpochRegistry>(@test_amm).epochs, epoch_id);
        (
            epoch.state_id,
            object::object_address(&epoch.reward_vault),
            epoch.status,
            epoch.quarantined,
        )
    }

    #[view]
    public fun epoch_aggregate_correction(epoch_id: u64): (bool, u256) acquires LpEpochRegistry {
        let epoch = table::borrow(&borrow_global<LpEpochRegistry>(@test_amm).epochs, epoch_id);
        reflection_math::parts(epoch.aggregate_correction)
    }

    #[view]
    public fun position_accounting(
        epoch_id: u64,
        owner: address,
    ): (u128, bool, u256, u256, u64) acquires LpEpochRegistry {
        let registry = borrow_global<LpEpochRegistry>(@test_amm);
        let epoch = table::borrow(&registry.epochs, epoch_id);
        if (!table::contains(&epoch.positions, owner)) return (0, false, 0, 0, 0);
        let position = table::borrow(&epoch.positions, owner);
        let (negative, magnitude) = reflection_math::parts(position.correction);
        (
            position.shares,
            negative,
            magnitude,
            position.claimed,
            pending_for(epoch, owner),
        )
    }

    /// Transaction-boundary invariant used by the pool after every LP state or
    /// vault mutation. The second identity independently proves that only
    /// routed receipts and claims can change the epoch's physical balance.
    public fun assert_epoch_backing(
        cap: &LpAccountingCapability,
        epoch_id: u64,
    ) acquires LpEpochRegistry {
        assert_cap(cap);
        let epoch = table::borrow(
            &borrow_global<LpEpochRegistry>(@test_amm).epochs,
            epoch_id,
        );
        let vault_balance = reflection_token::raw_store_balance(epoch.reward_vault) as u256;
        assert!(
            vault_balance
                == aggregate_liability(epoch)
                    + (epoch.unallocated_rewards as u256)
                    + (epoch.rounding_reserve as u256),
            E_VAULT_ACCOUNTING,
        );
        assert!(
            epoch.lifetime_received >= epoch.lifetime_claimed
                && vault_balance == epoch.lifetime_received - epoch.lifetime_claimed,
            E_VAULT_ACCOUNTING,
        );
    }

    fun new_epoch(epoch_id: u64, state_id: address, reward_vault: Object<FungibleStore>): LpEpoch {
        LpEpoch {
            epoch_id,
            state_id,
            status: STATUS_ACTIVE,
            reward_vault,
            index: 0,
            index_remainder: 0,
            total_shares: 0,
            aggregate_correction: reflection_math::zero(),
            unallocated_rewards: 0,
            rounding_reserve: 0,
            lifetime_received: 0,
            lifetime_claimed: 0,
            quarantined: false,
            positions: table::new<address, LpPosition>(),
        }
    }

    fun ensure_position(epoch: &mut LpEpoch, owner: address) {
        if (!table::contains(&epoch.positions, owner)) {
            table::add(&mut epoch.positions, owner, LpPosition {
                shares: 0,
                correction: reflection_math::zero(),
                claimed: 0,
            });
        };
    }

    fun pending_for(epoch: &LpEpoch, owner: address): u64 {
        if (!table::contains(&epoch.positions, owner)) return 0;
        let position = table::borrow(&epoch.positions, owner);
        let magnified = reflection_math::apply(
            (position.shares as u256) * epoch.index,
            position.correction,
        );
        let entitled = magnified / reflection_math::magnitude();
        reflection_math::checked_subtract(entitled, position.claimed) as u64
    }

    fun aggregate_liability(epoch: &LpEpoch): u256 {
        let magnified = reflection_math::apply(
            (epoch.total_shares as u256) * epoch.index,
            epoch.aggregate_correction,
        );
        let entitled = magnified / reflection_math::magnitude();
        reflection_math::checked_subtract(entitled, epoch.lifetime_claimed)
    }

    fun recompute_rounding(epoch: &mut LpEpoch) {
        let vault_balance = reflection_token::raw_store_balance(epoch.reward_vault) as u256;
        let named = aggregate_liability(epoch) + (epoch.unallocated_rewards as u256);
        assert!(vault_balance >= named, E_VAULT_ACCOUNTING);
        epoch.rounding_reserve = (vault_balance - named) as u128;
    }

    fun assert_active_mutation(epoch: &LpEpoch) {
        assert!(epoch.status == STATUS_ACTIVE, E_EPOCH_NOT_ACTIVE);
        assert!(!epoch.quarantined, E_ZERO_DENOMINATOR_QUARANTINE);
    }

    fun assert_active_epoch_healthy_internal(epoch: &LpEpoch) {
        assert!(epoch.status == STATUS_ACTIVE, E_EPOCH_NOT_ACTIVE);
        assert!(epoch.total_shares > 0, E_ZERO_DENOMINATOR_QUARANTINE);
        assert!(!epoch.quarantined, E_ZERO_DENOMINATOR_QUARANTINE);
    }

    fun assert_cap(cap: &LpAccountingCapability) {
        assert!(cap.nonce == 1, E_INVALID_CAPABILITY);
    }

    #[test_only]
    public fun destroy_capability_for_test(cap: LpAccountingCapability) {
        let LpAccountingCapability { nonce: _ } = cap;
    }
}
