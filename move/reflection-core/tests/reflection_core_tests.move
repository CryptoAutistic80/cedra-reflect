#[test_only]
module reflection_core::reflection_core_tests {
    use reflection_core::reflection_registry;
    use reflection_core::reflection_token;
    use cedra_framework::primary_fungible_store;
    use std::signer;

    #[test(admin = @0xcafe, alice = @0xa11ce, bob = @0xb0b)]
    fun fixed_supply_grants_and_untaxed_transfers(admin: &signer, alice: &signer, bob: &signer) {
        reflection_token::initialize_for_test(admin);
        let faucet_cap = reflection_token::issue_faucet_capability(admin);
        reflection_token::faucet_grant(&faucet_cap, signer::address_of(alice), 10_000, signer::address_of(admin));
        reflection_token::faucet_grant(&faucet_cap, signer::address_of(bob), 1_000, signer::address_of(admin));
        reflection_token::destroy_faucet_capability_for_test(faucet_cap);
        primary_fungible_store::transfer(alice, reflection_token::metadata(), signer::address_of(bob), 2_500);
        assert!(reflection_token::raw_balance(signer::address_of(alice)) == 7_500, 10);
        assert!(reflection_token::raw_balance(signer::address_of(bob)) == 3_500, 11);
        assert!(reflection_token::pending_rewards(signer::address_of(alice)) == 0, 12);
        assert!(reflection_token::pending_rewards(signer::address_of(bob)) == 0, 13);
        let (_, _, shares, _, _, _) = reflection_token::global_accounting();
        assert!(shares == 11_000, 14);
        assert!(reflection_token::fixed_supply() == 1_000_000_000_000_000, 15);
        assert!(
            reflection_token::distribution_vault_balance()
                + reflection_token::reward_vault_balance()
                + reflection_token::raw_balance(signer::address_of(alice))
                + reflection_token::raw_balance(signer::address_of(bob))
                == reflection_token::fixed_supply(),
            16,
        );
    }

    #[test(admin = @0xcafe)]
    fun fee_arithmetic_handles_tiny_and_maximum_u64_amounts(admin: &signer) {
        reflection_token::initialize_for_test(admin);
        assert!(reflection_token::reflection_fee_for(99) == 0, 20);
        assert!(reflection_token::reflection_fee_for(18_446_744_073_709_551_615) == 184_467_440_737_095_516, 21);
    }

    #[test(admin = @0xcafe)]
    fun claim_backed_mode_is_recorded_on_chain(admin: &signer) {
        reflection_token::initialize_claim_backed_for_test(admin);
        assert!(!reflection_token::automatic_materialization_enabled(), 30);
        let (major, minor, patch) = reflection_registry::release_version();
        assert!(major == 0 && minor == 1 && patch == 0, 31);
    }

    #[test(admin = @0xcafe)]
    fun production_initializer_is_claim_backed_and_fully_vaulted(admin: &signer) {
        reflection_token::initialize(admin);
        let admin_address = signer::address_of(admin);
        assert!(!reflection_token::automatic_materialization_enabled(), 40);
        assert!(reflection_token::distribution_vault_balance() == reflection_token::fixed_supply(), 41);
        assert!(reflection_token::reward_vault_balance() == 0, 42);
        assert!(reflection_token::protocol_exclusions_remaining() == 2, 43);
        assert!(reflection_token::operational_admin() == admin_address, 44);
        assert!(reflection_token::primary_store_is_excluded(admin_address), 45);
    }

    #[test(admin = @0xcafe, alice = @0xa11ce, bob = @0xb0b)]
    fun explicit_and_implicit_wallet_registration_are_exact_once(
        admin: &signer,
        alice: &signer,
        bob: &signer,
    ) {
        reflection_token::initialize_claim_backed_for_test(admin);
        assert!(reflection_token::registered_wallet_count() == 0, 50);
        reflection_token::register_wallet(alice);
        reflection_token::register_wallet(alice);
        assert!(reflection_token::registered_wallet_count() == 1, 51);

        let faucet_cap = reflection_token::issue_faucet_capability(admin);
        reflection_token::faucet_grant(
            &faucet_cap,
            signer::address_of(bob),
            1,
            signer::address_of(admin),
        );
        reflection_token::faucet_grant(
            &faucet_cap,
            signer::address_of(bob),
            1,
            signer::address_of(admin),
        );
        reflection_token::destroy_faucet_capability_for_test(faucet_cap);
        assert!(reflection_token::registered_wallet_count() == 2, 52);
    }

    #[test(admin = @0xcafe)]
    #[expected_failure(abort_code = 1, location = reflection_core::reflection_token)]
    fun initialization_is_one_shot(admin: &signer) {
        reflection_token::initialize_for_test(admin);
        reflection_token::initialize(admin);
    }

    #[test(alice = @0xa11ce)]
    #[expected_failure(abort_code = 2, location = reflection_core::reflection_token)]
    fun initialization_requires_package_publisher(alice: &signer) {
        reflection_token::initialize(alice);
    }
}
