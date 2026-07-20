#[test_only]
module hook_probe::hook_probe_tests {
    use cedra_framework::primary_fungible_store;
    use hook_probe::hook_probe;
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
}
