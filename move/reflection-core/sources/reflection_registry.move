/// Immutable deployment identity for the initial contract schema.
module reflection_core::reflection_registry {
    use std::signer;

    const E_ALREADY_INITIALIZED: u64 = 2;

    struct ProtocolRegistry has key {
        admin: address,
        state_object: address,
        deployment_id: vector<u8>,
        network_label: vector<u8>,
        release_major: u64,
        release_minor: u64,
        release_patch: u64,
    }

    public(package) fun initialize(
        admin: &signer,
        state_object: address,
        deployment_id: vector<u8>,
        network_label: vector<u8>,
        release_major: u64,
        release_minor: u64,
        release_patch: u64,
    ) {
        assert!(!exists<ProtocolRegistry>(@reflection_core), E_ALREADY_INITIALIZED);
        move_to(admin, ProtocolRegistry {
            admin: signer::address_of(admin),
            state_object,
            deployment_id,
            network_label,
            release_major,
            release_minor,
            release_patch,
        });
    }

    #[view]
    public fun state_object(): address acquires ProtocolRegistry { borrow_global<ProtocolRegistry>(@reflection_core).state_object }
    #[view]
    public fun deployment_id(): vector<u8> acquires ProtocolRegistry { borrow_global<ProtocolRegistry>(@reflection_core).deployment_id }
    #[view]
    public fun network_label(): vector<u8> acquires ProtocolRegistry { borrow_global<ProtocolRegistry>(@reflection_core).network_label }
    #[view]
    public fun admin(): address acquires ProtocolRegistry { borrow_global<ProtocolRegistry>(@reflection_core).admin }
    #[view]
    public fun release_version(): (u64, u64, u64) acquires ProtocolRegistry {
        let registry = borrow_global<ProtocolRegistry>(@reflection_core);
        (registry.release_major, registry.release_minor, registry.release_patch)
    }
}
