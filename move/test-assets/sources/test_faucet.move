/// Fixed-parameter Testnet faucet for the immutable v0.2 deployment.
///
/// Initialization hands this module two narrow capabilities while the core is
/// CONFIGURING. Claims become available only after the core launch is sealed.
/// There is no pause, parameter setter, administrator, or authority rotation.
module test_assets::test_faucet {
    use cedra_framework::timestamp;
    use reflection_core::reflection_token::{Self, FaucetCapability};
    use std::signer;
    use std::table::{Self, Table};
    use test_assets::mock_usd::{Self, FaucetMintCapability};

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_COOLDOWN: u64 = 2;
    const E_WRONG_FAUCET_ADDRESS: u64 = 3;
    const E_NOT_LIVE: u64 = 4;

    const FIXED_COOLDOWN_SECONDS: u64 = 3_600;
    const FIXED_TRFL_GRANT: u64 = 1_000_000_000;
    const FIXED_TUSD_GRANT: u64 = 1_000_000_000;

    struct FaucetState has key {
        rfl_cap: FaucetCapability,
        usd_cap: FaucetMintCapability,
        last_trfl_claim: Table<address, u64>,
        last_tusd_claim: Table<address, u64>,
    }

    /// One-time capability handoff. The package publisher has no callable
    /// privilege after this function returns.
    public entry fun initialize(core_admin: &signer, faucet_admin: &signer) {
        assert!(!exists<FaucetState>(@test_assets), E_ALREADY_INITIALIZED);
        assert!(signer::address_of(faucet_admin) == @test_assets, E_WRONG_FAUCET_ADDRESS);
        let rfl_cap = reflection_token::issue_faucet_capability(core_admin, faucet_admin);
        let usd_cap = mock_usd::issue_faucet_capability(faucet_admin);
        move_to(faucet_admin, FaucetState {
            rfl_cap,
            usd_cap,
            last_trfl_claim: table::new<address, u64>(),
            last_tusd_claim: table::new<address, u64>(),
        });
    }

    public entry fun claim_trfl(claimant: &signer) acquires FaucetState {
        assert!(reflection_token::is_sealed() && !reflection_token::is_closed(), E_NOT_LIVE);
        let state = borrow_global_mut<FaucetState>(@test_assets);
        assert_available(&mut state.last_trfl_claim, signer::address_of(claimant));
        reflection_token::faucet_grant(
            &state.rfl_cap,
            signer::address_of(claimant),
            FIXED_TRFL_GRANT,
            @test_assets,
        );
    }

    public entry fun claim_tusd(claimant: &signer) acquires FaucetState {
        assert!(reflection_token::is_sealed() && !reflection_token::is_closed(), E_NOT_LIVE);
        let state = borrow_global_mut<FaucetState>(@test_assets);
        assert_available(&mut state.last_tusd_claim, signer::address_of(claimant));
        mock_usd::mint_from_faucet(
            &state.usd_cap,
            signer::address_of(claimant),
            FIXED_TUSD_GRANT,
            @test_assets,
        );
    }

    #[view]
    public fun configuration(): (u64, u64, u64) {
        (FIXED_TRFL_GRANT, FIXED_TUSD_GRANT, FIXED_COOLDOWN_SECONDS)
    }

    #[view]
    public fun last_claim(account: address, trfl: bool): (bool, u64) acquires FaucetState {
        let state = borrow_global<FaucetState>(@test_assets);
        let claims = if (trfl) &state.last_trfl_claim else &state.last_tusd_claim;
        if (!table::contains(claims, account)) return (false, 0);
        (true, *table::borrow(claims, account))
    }

    fun assert_available(last_claims: &mut Table<address, u64>, account: address) {
        let now = timestamp::now_seconds();
        if (table::contains(last_claims, account)) {
            let previous = *table::borrow(last_claims, account);
            assert!(
                now >= previous && now - previous >= FIXED_COOLDOWN_SECONDS,
                E_COOLDOWN,
            );
            *table::borrow_mut(last_claims, account) = now;
        } else {
            table::add(last_claims, account, now);
        };
    }
}
