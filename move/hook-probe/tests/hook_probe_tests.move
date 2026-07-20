#[test_only]
module hook_probe::hook_probe_tests {
    use cedra_framework::primary_fungible_store;
    use hook_probe::hook_probe;
    use hook_probe::probe_driver;
    use std::signer;

    // The framework calls are deliberately made from a different module: a
    // dispatch callback cannot re-enter a module that is still executing an
    // application-level transfer wrapper.
    #[test(admin = @0xcafe, alice = @0xa11ce)]
    fun framework_transfer_dispatches_hooks(admin: &signer, alice: &signer) {
        hook_probe::initialize_for_test(admin);
        primary_fungible_store::transfer(
            admin,
            hook_probe::metadata(),
            signer::address_of(alice),
            101,
        );
        assert!(hook_probe::raw_balance(signer::address_of(alice)) == 101, 10);
        assert!(primary_fungible_store::balance(
            signer::address_of(alice),
            hook_probe::metadata(),
        ) == 101, 11);
    }

    #[test(admin = @0xcafe, alice = @0xa11ce)]
    fun reference_materialisation_and_secondary_store_are_exact(
        admin: &signer,
        alice: &signer,
    ) {
        hook_probe::initialize_for_test(admin);
        assert!(hook_probe::reward_vault_balance() == 1_000_000, 20);
        hook_probe::materialize_from_vault(admin, signer::address_of(alice), 101);
        assert!(hook_probe::reward_vault_balance() == 999_899, 21);
        assert!(hook_probe::raw_balance(signer::address_of(alice)) == 101, 22);
        assert!(probe_driver::primary_derived_balance(signer::address_of(alice)) == 101, 23);

        probe_driver::create_and_fund_secondary(alice, 40);
        assert!(hook_probe::raw_balance(signer::address_of(alice)) == 61, 24);
        assert!(probe_driver::secondary_raw_balance(signer::address_of(alice)) == 40, 25);
        assert!(probe_driver::secondary_derived_balance(signer::address_of(alice)) == 40, 26);
    }
}
