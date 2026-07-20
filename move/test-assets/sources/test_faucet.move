/// Controlled distribution facade: tRFL comes only from its fixed deployment
/// reserve, while tUSD is intentionally Testnet-mintable. Both are rate-limited.
module test_assets::test_faucet {
    use cedra_framework::event;
    use cedra_framework::timestamp;
    use reflection_core::reflection_token::{Self, FaucetCapability};
    use std::signer;
    use std::table::{Self, Table};
    use test_assets::mock_usd::{Self, FaucetMintCapability};

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_NOT_ADMIN: u64 = 2;
    const E_COOLDOWN: u64 = 3;
    const E_ZERO_AMOUNT: u64 = 4;
    const E_WRONG_FAUCET_ADDRESS: u64 = 5;
    const E_NOT_OPERATIONAL_ADMIN: u64 = 6;
    const E_INVALID_OPERATIONAL_ADMIN: u64 = 7;
    const E_FAUCET_PAUSED: u64 = 8;
    const DEFAULT_COOLDOWN_SECONDS: u64 = 3_600;
    const DEFAULT_TRFL_GRANT: u64 = 1_000_000_000;
    const DEFAULT_TUSD_GRANT: u64 = 1_000_000_000;

    struct FaucetState has key {
        admin: address,
        operational_admin: address,
        rfl_cap: FaucetCapability,
        usd_cap: FaucetMintCapability,
        trfl_grant: u64,
        tusd_grant: u64,
        cooldown_seconds: u64,
        paused: bool,
        last_trfl_claim: Table<address, u64>,
        last_tusd_claim: Table<address, u64>,
    }

    #[event]
    struct FaucetConfigured has drop, store {
        trfl_grant: u64,
        tusd_grant: u64,
        cooldown_seconds: u64,
    }

    #[event]
    struct OperationalAdminChanged has drop, store {
        old_operational_admin: address,
        new_operational_admin: address,
    }

    #[event]
    struct FaucetPauseChanged has drop, store { paused: bool }

    /// Initialisation intentionally requires the core admin and the independent
    /// faucet publisher. This hands over only narrow capabilities and works
    /// when reflection-core and test-assets are deployed at different addresses.
    public entry fun initialize(core_admin: &signer, faucet_admin: &signer) {
        assert!(!exists<FaucetState>(@test_assets), E_ALREADY_INITIALIZED);
        assert!(signer::address_of(faucet_admin) == @test_assets, E_WRONG_FAUCET_ADDRESS);
        reflection_token::register_excluded_primary_store(core_admin, signer::address_of(faucet_admin));
        let rfl_cap = reflection_token::issue_faucet_capability(core_admin);
        let usd_cap = mock_usd::issue_faucet_capability(faucet_admin);
        move_to(faucet_admin, FaucetState {
            admin: signer::address_of(faucet_admin),
            operational_admin: signer::address_of(faucet_admin),
            rfl_cap,
            usd_cap,
            trfl_grant: DEFAULT_TRFL_GRANT,
            tusd_grant: DEFAULT_TUSD_GRANT,
            cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
            paused: false,
            last_trfl_claim: table::new<address, u64>(),
            last_tusd_claim: table::new<address, u64>(),
        });
        event::emit(OperationalAdminChanged {
            old_operational_admin: @0x0,
            new_operational_admin: signer::address_of(faucet_admin),
        });
        event::emit(FaucetConfigured {
            trfl_grant: DEFAULT_TRFL_GRANT,
            tusd_grant: DEFAULT_TUSD_GRANT,
            cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
        });
        event::emit(FaucetPauseChanged { paused: false });
    }

    public entry fun claim_trfl(claimant: &signer) acquires FaucetState {
        let state = borrow_global_mut<FaucetState>(@test_assets);
        assert!(!state.paused, E_FAUCET_PAUSED);
        assert_available(&mut state.last_trfl_claim, signer::address_of(claimant), state.cooldown_seconds);
        reflection_token::faucet_grant(&state.rfl_cap, signer::address_of(claimant), state.trfl_grant, @test_assets);
    }

    public entry fun claim_tusd(claimant: &signer) acquires FaucetState {
        let state = borrow_global_mut<FaucetState>(@test_assets);
        assert!(!state.paused, E_FAUCET_PAUSED);
        assert_available(&mut state.last_tusd_claim, signer::address_of(claimant), state.cooldown_seconds);
        mock_usd::mint_from_faucet(&state.usd_cap, signer::address_of(claimant), state.tusd_grant, @test_assets);
    }

    public entry fun configure(admin: &signer, trfl_grant: u64, tusd_grant: u64, cooldown_seconds: u64) acquires FaucetState {
        assert!(trfl_grant > 0 && tusd_grant > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<FaucetState>(@test_assets);
        assert!(signer::address_of(admin) == state.operational_admin, E_NOT_OPERATIONAL_ADMIN);
        state.trfl_grant = trfl_grant;
        state.tusd_grant = tusd_grant;
        state.cooldown_seconds = cooldown_seconds;
        event::emit(FaucetConfigured { trfl_grant, tusd_grant, cooldown_seconds });
    }

    public entry fun set_operational_admin(
        publisher: &signer,
        new_operational_admin: address,
    ) acquires FaucetState {
        assert!(new_operational_admin != @0x0, E_INVALID_OPERATIONAL_ADMIN);
        let state = borrow_global_mut<FaucetState>(@test_assets);
        assert!(signer::address_of(publisher) == state.admin, E_NOT_ADMIN);
        let old_operational_admin = state.operational_admin;
        state.operational_admin = new_operational_admin;
        event::emit(OperationalAdminChanged {
            old_operational_admin,
            new_operational_admin,
        });
    }

    public entry fun set_paused(admin: &signer, paused: bool) acquires FaucetState {
        let state = borrow_global_mut<FaucetState>(@test_assets);
        assert!(signer::address_of(admin) == state.operational_admin, E_NOT_OPERATIONAL_ADMIN);
        state.paused = paused;
        event::emit(FaucetPauseChanged { paused });
    }

    #[view]
    public fun configuration(): (u64, u64, u64) acquires FaucetState {
        let state = borrow_global<FaucetState>(@test_assets);
        (state.trfl_grant, state.tusd_grant, state.cooldown_seconds)
    }

    #[view]
    public fun operational_admin(): address acquires FaucetState {
        borrow_global<FaucetState>(@test_assets).operational_admin
    }

    #[view]
    public fun paused(): bool acquires FaucetState {
        borrow_global<FaucetState>(@test_assets).paused
    }

    fun assert_available(last_claims: &mut Table<address, u64>, account: address, cooldown: u64) {
        let now = timestamp::now_seconds();
        if (table::contains(last_claims, account)) {
            let previous = *table::borrow(last_claims, account);
            assert!(now >= previous && now - previous >= cooldown, E_COOLDOWN);
            *table::borrow_mut(last_claims, account) = now;
        } else {
            table::add(last_claims, account, now);
        };
    }
}
