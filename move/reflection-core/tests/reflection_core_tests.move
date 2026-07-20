#[test_only]
module reflection_core::reflection_core_tests {
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
    }

    #[test(admin = @0xcafe)]
    fun fee_arithmetic_handles_tiny_and_maximum_u64_amounts(admin: &signer) {
        reflection_token::initialize_for_test(admin);
        assert!(reflection_token::reflection_fee_for(99) == 0, 20);
        assert!(reflection_token::reflection_fee_for(18_446_744_073_709_551_615) == 184_467_440_737_095_516, 21);
    }
}
