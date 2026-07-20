/// Immutable bindings for the canonical tRFL custody adapter.
///
/// The reserve store never changes. Each LP reward epoch registers a fresh
/// payout vault; old vaults remain approved for claim-only payouts, while only
/// the active vault may receive newly routed custody rewards.
module reflection_core::custody_registry {
    use cedra_framework::fungible_asset::FungibleStore;
    use cedra_framework::object::{Self, Object};
    use std::signer;
    use std::table::{Self, Table};

    const E_ALREADY_REGISTERED: u64 = 1;
    const E_NOT_CORE_ADMIN: u64 = 2;
    const E_INVALID_CAPABILITY: u64 = 3;
    const E_INVALID_RESERVE: u64 = 4;
    const E_INVALID_ACTIVE_VAULT: u64 = 5;
    const E_UNAPPROVED_VAULT: u64 = 6;
    const E_VAULT_ALREADY_REGISTERED: u64 = 7;

    struct CustodySettlementCapability has store {
        adapter_id: u64,
        reserve_store: address,
        nonce: u64,
    }

    struct CustodyRegistry has key {
        adapter_id: u64,
        reserve_store: address,
        active_epoch: u64,
        active_lp_vault: address,
        approved_lp_vaults: Table<address, u64>,
    }

    public(package) fun register(
        admin: &signer,
        reserve: Object<FungibleStore>,
        lp_vault: Object<FungibleStore>,
    ): CustodySettlementCapability {
        assert!(signer::address_of(admin) == @reflection_core, E_NOT_CORE_ADMIN);
        assert!(!exists<CustodyRegistry>(@reflection_core), E_ALREADY_REGISTERED);
        let reserve_store = object::object_address(&reserve);
        let vault_address = object::object_address(&lp_vault);
        let approved_lp_vaults = table::new<address, u64>();
        table::add(&mut approved_lp_vaults, vault_address, 1);
        move_to(admin, CustodyRegistry {
            adapter_id: 1,
            reserve_store,
            active_epoch: 1,
            active_lp_vault: vault_address,
            approved_lp_vaults,
        });
        CustodySettlementCapability { adapter_id: 1, reserve_store, nonce: 1 }
    }

    /// Activates a fresh immutable epoch-to-vault binding. The token module
    /// validates the zero-reserve/zero-pending boundary before calling this.
    public(package) fun open_epoch(
        admin: &signer,
        cap: &CustodySettlementCapability,
        epoch: u64,
        lp_vault: Object<FungibleStore>,
    ) acquires CustodyRegistry {
        assert!(signer::address_of(admin) == @reflection_core, E_NOT_CORE_ADMIN);
        assert_capability(cap);
        let registry = borrow_global_mut<CustodyRegistry>(@reflection_core);
        assert!(epoch == registry.active_epoch + 1, E_INVALID_ACTIVE_VAULT);
        let vault_address = object::object_address(&lp_vault);
        assert!(!table::contains(&registry.approved_lp_vaults, vault_address), E_VAULT_ALREADY_REGISTERED);
        table::add(&mut registry.approved_lp_vaults, vault_address, epoch);
        registry.active_epoch = epoch;
        registry.active_lp_vault = vault_address;
    }

    public(package) fun assert_active_route(
        cap: &CustodySettlementCapability,
        reserve: Object<FungibleStore>,
        epoch: u64,
        lp_vault: Object<FungibleStore>,
    ) acquires CustodyRegistry {
        assert_capability(cap);
        let registry = borrow_global<CustodyRegistry>(@reflection_core);
        assert!(object::object_address(&reserve) == registry.reserve_store, E_INVALID_RESERVE);
        assert!(epoch == registry.active_epoch, E_INVALID_ACTIVE_VAULT);
        assert!(object::object_address(&lp_vault) == registry.active_lp_vault, E_INVALID_ACTIVE_VAULT);
    }

    public(package) fun assert_claim_vault(
        cap: &CustodySettlementCapability,
        epoch: u64,
        lp_vault: Object<FungibleStore>,
    ) acquires CustodyRegistry {
        assert_capability(cap);
        let registry = borrow_global<CustodyRegistry>(@reflection_core);
        let vault_address = object::object_address(&lp_vault);
        assert!(table::contains(&registry.approved_lp_vaults, vault_address), E_UNAPPROVED_VAULT);
        assert!(*table::borrow(&registry.approved_lp_vaults, vault_address) == epoch, E_UNAPPROVED_VAULT);
    }

    public(package) fun assert_reserve(cap: &CustodySettlementCapability, reserve: Object<FungibleStore>) acquires CustodyRegistry {
        assert_capability(cap);
        assert!(object::object_address(&reserve) == borrow_global<CustodyRegistry>(@reflection_core).reserve_store, E_INVALID_RESERVE);
    }

    #[view]
    public fun adapter_id(): u64 acquires CustodyRegistry {
        borrow_global<CustodyRegistry>(@reflection_core).adapter_id
    }

    #[view]
    public fun active_route(): (u64, address, address) acquires CustodyRegistry {
        let registry = borrow_global<CustodyRegistry>(@reflection_core);
        (registry.active_epoch, registry.reserve_store, registry.active_lp_vault)
    }

    #[view]
    public fun epoch_for_vault(vault: address): u64 acquires CustodyRegistry {
        let registry = borrow_global<CustodyRegistry>(@reflection_core);
        if (!table::contains(&registry.approved_lp_vaults, vault)) return 0;
        *table::borrow(&registry.approved_lp_vaults, vault)
    }

    fun assert_capability(cap: &CustodySettlementCapability) acquires CustodyRegistry {
        let registry = borrow_global<CustodyRegistry>(@reflection_core);
        assert!(
            cap.nonce == 1
                && cap.adapter_id == registry.adapter_id
                && cap.reserve_store == registry.reserve_store,
            E_INVALID_CAPABILITY,
        );
    }

    #[test_only]
    public fun destroy_capability_for_test(cap: CustodySettlementCapability) {
        let CustodySettlementCapability { adapter_id: _, reserve_store: _, nonce: _ } = cap;
    }
}
