/// Fixed-supply tRFL and vault-backed O(1) reflection accounting.
///
/// Normal wallet transfers must enter through Cedra's primary-store dispatcher.
/// The registered hook module delegates here; privileged settlement uses a
/// private TransferRef so it never recursively invokes a hook.
module reflection_core::reflection_token {
    use cedra_framework::dispatchable_fungible_asset;
    use cedra_framework::function_info;
    use cedra_framework::fungible_asset::{Self, FungibleAsset, FungibleStore, Metadata, RawBalanceRef, TransferRef};
    use cedra_framework::object::{Self, Object};
    use cedra_framework::primary_fungible_store;
    use reflection_core::custody_registry::{Self, CustodySettlementCapability};
    use reflection_core::reflection_events;
    use reflection_core::reflection_math::{Self, SignedU256};
    use reflection_core::reflection_registry;
    use std::option;
    use std::signer;
    use std::string;
    use std::table::{Self, Table};

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_NOT_ADMIN: u64 = 2;
    const E_NOT_CANONICAL_POOL: u64 = 3;
    const E_CAPABILITY_ALREADY_ISSUED: u64 = 4;
    const E_SWAPS_PAUSED: u64 = 5;
    const E_CLAIMS_PAUSED: u64 = 6;
    const E_FEE_TOO_HIGH: u64 = 7;
    const E_DIRECT_EXCLUDED_STORE_DEPOSIT: u64 = 8;
    const E_INSUFFICIENT_EFFECTIVE_BALANCE: u64 = 9;
    const E_ZERO_AMOUNT: u64 = 10;
    const E_POOL_ALREADY_REGISTERED: u64 = 11;
    const E_NO_POOL: u64 = 12;
    const E_INVALID_CAP: u64 = 13;
    const E_CLAIM_EXCEEDS_PENDING: u64 = 14;
    const E_EXCLUDED_RECIPIENT: u64 = 15;
    const E_CUSTODY_NOT_REGISTERED: u64 = 20;
    const E_CUSTODY_ALREADY_REGISTERED: u64 = 21;
    const E_STORE_NOT_EMPTY: u64 = 22;
    const E_CUSTODY_SHARE_MISMATCH: u64 = 23;
    const E_CUSTODY_PENDING_AT_EPOCH_CHANGE: u64 = 24;
    const E_UNREGISTERED_WALLET: u64 = 25;
    const E_UNSUPPORTED_STORE: u64 = 26;
    const E_INVALID_CUSTODY_EPOCH_RESIDUE: u64 = 27;
    const E_INVALID_OPERATIONAL_ADMIN: u64 = 28;
    const E_NOT_OPERATIONAL_ADMIN: u64 = 29;
    const E_STORE_ALREADY_CLASSIFIED: u64 = 30;
    const E_NOT_CUSTODY_STORE_OWNER: u64 = 31;
    const E_AUTOMATIC_MATERIALIZATION_DISABLED: u64 = 32;

    const MAX_FEE_BPS: u64 = 100;
    const BPS_DENOMINATOR: u64 = 10_000;
    const INITIAL_FEE_BPS: u64 = 100;
    const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;
    const ASSET_SEED: vector<u8> = b"reflection-pilot-trfl-v1";
    const REWARD_VAULT_SEED: vector<u8> = b"reflection-reward-vault-v1";
    const DISTRIBUTION_VAULT_SEED: vector<u8> = b"reflection-distribution-vault-v1";
    const DEPLOYMENT_ID: vector<u8> = b"reflection-pilot-001";
    const NETWORK_LABEL: vector<u8> = b"cedra-testnet";

    /// `claimed` is whole-token materialisation. `correction` preserves the
    /// accrued dividend when raw balance changes, exactly as a magnified
    /// dividend correction; no holder iteration occurs.
    struct Position has store {
        correction: SignedU256,
        claimed: u256,
    }

    struct ReflectionState has key {
        admin: address,
        operational_admin: address,
        metadata: Object<Metadata>,
        transfer_ref: TransferRef,
        raw_balance_ref: RawBalanceRef,

        index: u256,
        index_remainder: u256,
        total_shares: u128,
        aggregate_correction: SignedU256,
        unallocated_fees: u128,
        lifetime_fees: u256,
        lifetime_materialized: u256,

        fee_bps: u64,
        swaps_paused: bool,
        claims_paused: bool,
        automatic_materialization: bool,
        positions: Table<address, Position>,
        exclusions: Table<address, bool>,

        reward_vault: Object<FungibleStore>,
        distribution_vault: Object<FungibleStore>,
        pool_store: address,
        pool_registered: bool,
        settlement_capability_issued: bool,
        faucet_capability_issued: bool,
    }

    /// Canonical custody and wallet-registration accounting for this initial
    /// deployment schema. ReflectionState remains the authoritative global
    /// index and aggregate correction; this resource supplies the custody
    /// subset and exact vault accounting used by the hook state.
    struct CustodyAccounting has key {
        pool_position: Position,
        custody_shares: u128,
        lifetime_custody_routed: u256,
        rounding_reserve: u128,
        registered_wallets: Table<address, bool>,
        registered: bool,
    }

    /// Held exclusively by the canonical AMM package. It cannot be forged or
    /// duplicated and allows only the two settlement functions below.
    struct SettlementCapability has store { nonce: u64 }

    /// Held exclusively by the test faucet package. It only releases the
    /// deployment's pre-minted distribution reserve.
    struct FaucetCapability has store { nonce: u64 }

    /// One-time fresh-deployment initialization. Hook functions are resolved
    /// from finalized module storage, so registration must occur after package
    /// publication rather than from `init_module`. The selected materialization
    /// mode is immutable for this deployment.
    public entry fun initialize(admin: &signer, automatic_materialization: bool) {
        assert!(signer::address_of(admin) == @reflection_core, E_NOT_ADMIN);
        assert!(!exists<ReflectionState>(@reflection_core), E_ALREADY_INITIALIZED);
        let constructor_ref = object::create_named_object(admin, ASSET_SEED);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &constructor_ref,
            option::some(TOTAL_SUPPLY as u128),
            string::utf8(b"Reflection Pilot Test Token"),
            string::utf8(b"tRFL"),
            6,
            string::utf8(b"https://example.invalid/reflection-pilot/trfl"),
            string::utf8(b"https://example.invalid"),
        );
        dispatchable_fungible_asset::register_dispatch_functions(
            &constructor_ref,
            option::some(function_info::new_function_info(
                admin,
                string::utf8(b"reflection_hooks"),
                string::utf8(b"withdraw_hook"),
            )),
            option::some(function_info::new_function_info(
                admin,
                string::utf8(b"reflection_hooks"),
                string::utf8(b"deposit_hook"),
            )),
            option::some(function_info::new_function_info(
                admin,
                string::utf8(b"reflection_hooks"),
                string::utf8(b"derived_balance_hook"),
            )),
        );

        let mint_ref = fungible_asset::generate_mint_ref(&constructor_ref);
        let transfer_ref = fungible_asset::generate_transfer_ref(&constructor_ref);
        let raw_balance_ref = fungible_asset::generate_raw_balance_ref(&constructor_ref);
        let metadata = fungible_asset::mint_ref_metadata(&mint_ref);

        let reward_constructor = object::create_named_object(admin, REWARD_VAULT_SEED);
        let reward_vault = fungible_asset::create_store(&reward_constructor, metadata);
        let distribution_constructor = object::create_named_object(admin, DISTRIBUTION_VAULT_SEED);
        let distribution_vault = fungible_asset::create_store(&distribution_constructor, metadata);
        let metadata_address = object::object_address(&metadata);
        let reward_vault_address = object::object_address(&reward_vault);
        let distribution_vault_address = object::object_address(&distribution_vault);
        fungible_asset::set_frozen_flag(&transfer_ref, reward_vault, true);
        fungible_asset::set_frozen_flag(&transfer_ref, distribution_vault, true);
        let supply = fungible_asset::mint(&mint_ref, TOTAL_SUPPLY);
        fungible_asset::deposit_with_ref(&transfer_ref, distribution_vault, supply);

        let exclusions = table::new<address, bool>();
        let admin_primary_store = primary_fungible_store::primary_store_address_inlined(signer::address_of(admin), metadata);
        table::add(&mut exclusions, object::object_address(&reward_vault), true);
        table::add(&mut exclusions, object::object_address(&distribution_vault), true);
        table::add(&mut exclusions, admin_primary_store, true);
        move_to(admin, ReflectionState {
            admin: signer::address_of(admin),
            operational_admin: signer::address_of(admin),
            metadata,
            transfer_ref,
            raw_balance_ref,
            index: 0,
            index_remainder: 0,
            total_shares: 0,
            aggregate_correction: reflection_math::zero(),
            unallocated_fees: 0,
            lifetime_fees: 0,
            lifetime_materialized: 0,
            fee_bps: INITIAL_FEE_BPS,
            swaps_paused: false,
            claims_paused: false,
            automatic_materialization,
            positions: table::new<address, Position>(),
            exclusions,
            reward_vault,
            distribution_vault,
            pool_store: @0x0,
            pool_registered: false,
            settlement_capability_issued: false,
            faucet_capability_issued: false,
        });
        move_to(admin, CustodyAccounting {
            pool_position: Position { correction: reflection_math::zero(), claimed: 0 },
            custody_shares: 0,
            lifetime_custody_routed: 0,
            rounding_reserve: 0,
            registered_wallets: table::new<address, bool>(),
            registered: false,
        });
        reflection_registry::initialize(admin, @reflection_core, DEPLOYMENT_ID, NETWORK_LABEL);
        reflection_events::protocol_initialized(
            1,
            DEPLOYMENT_ID,
            metadata_address,
            reward_vault_address,
            distribution_vault_address,
            automatic_materialization,
        );
    }

    /// Stable hook implementation surface. The hook module is separate because
    /// calling a dispatcher from the hook-owning module is VM re-entrancy.
    public fun withdraw_hook_impl<T: key>(
        store: Object<T>,
        amount: u64,
        transfer_ref: &TransferRef,
    ): FungibleAsset acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        if (is_eligible_wallet_store(state, custody, store)) {
            let account = object::owner(store);
            let raw = fungible_asset::balance_with_ref(&state.raw_balance_ref, store);
            if (raw < amount) {
                assert!(state.automatic_materialization, E_AUTOMATIC_MATERIALIZATION_DISABLED);
                assert!(!state.claims_paused, E_CLAIMS_PAUSED);
                materialize_to_store(state, account, store, amount - raw, false);
            };
            remove_raw_shares(state, account, amount);
            reflection_events::eligible_balance_debited(account, amount);
        } else {
            assert!(is_excluded_store(state, object::object_address(&store)), E_UNSUPPORTED_STORE);
        };
        fungible_asset::withdraw_with_ref(transfer_ref, store, amount)
    }

    public fun deposit_hook_impl<T: key>(
        store: Object<T>,
        asset: FungibleAsset,
        transfer_ref: &TransferRef,
    ) acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        let store_address = object::object_address(&store);
        assert!(!is_excluded_store(state, store_address), E_DIRECT_EXCLUDED_STORE_DEPOSIT);
        assert!(is_eligible_wallet_store(state, custody, store), E_UNSUPPORTED_STORE);
        let amount = fungible_asset::amount(&asset);
        fungible_asset::deposit_with_ref(transfer_ref, store, asset);
        let account = object::owner(store);
        add_raw_shares(state, account, amount);
        reflection_events::eligible_balance_credited(account, amount);
    }

    public fun derived_balance_hook_impl<T: key>(store: Object<T>): u64 acquires ReflectionState, CustodyAccounting {
        let state = borrow_global<ReflectionState>(@reflection_core);
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        let raw = fungible_asset::balance_with_ref(&state.raw_balance_ref, store);
        if (!is_eligible_wallet_store(state, custody, store)) return raw;
        if (!state.automatic_materialization) return raw;
        raw + claimable_for_store(state, object::owner(store), store)
    }

    /// Wallets opt into the primary-store accounting surface before receiving
    /// standard dispatcher transfers. Signer-authenticated faucet, buy, LP
    /// claim, and liquidity-withdrawal paths register the same address
    /// atomically when needed.
    public entry fun register_wallet(owner: &signer) acquires ReflectionState, CustodyAccounting {
        let account = signer::address_of(owner);
        let state = borrow_global<ReflectionState>(@reflection_core);
        let store = primary_fungible_store::ensure_primary_store_exists(account, state.metadata);
        assert!(!is_excluded_store(state, object::object_address(&store)), E_EXCLUDED_RECIPIENT);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        ensure_registered_wallet_for_store(state, custody, account, store);
    }

    /// Explicit claim remains available even when a wallet does not consume
    /// Cedra's derived-balance view. It is also the Testnet fallback if hook
    /// behaviour changes after the compatibility probe.
    public entry fun claim(owner: &signer, amount: u64) acquires ReflectionState, CustodyAccounting {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert!(!state.claims_paused, E_CLAIMS_PAUSED);
        let account = signer::address_of(owner);
        assert_registered_wallet(borrow_global<CustodyAccounting>(@reflection_core), account);
        let store = primary_fungible_store::ensure_primary_store_exists(account, state.metadata);
        materialize_to_store(state, account, store, amount, true);
    }

    public entry fun claim_all(owner: &signer) acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert!(!state.claims_paused, E_CLAIMS_PAUSED);
        let account = signer::address_of(owner);
        assert_registered_wallet(borrow_global<CustodyAccounting>(@reflection_core), account);
        let store = primary_fungible_store::ensure_primary_store_exists(account, state.metadata);
        let amount = materialize_all_to_store(state, account, store, true);
        assert!(amount > 0, E_ZERO_AMOUNT);
    }

    public entry fun set_fee_bps(admin: &signer, new_fee_bps: u64) acquires ReflectionState {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_operational_admin(state, admin);
        assert!(new_fee_bps <= MAX_FEE_BPS, E_FEE_TOO_HIGH);
        let old_fee_bps = state.fee_bps;
        state.fee_bps = new_fee_bps;
        reflection_events::fee_changed(old_fee_bps, new_fee_bps);
    }

    public entry fun set_pause_state(admin: &signer, swaps_paused: bool, claims_paused: bool) acquires ReflectionState {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_operational_admin(state, admin);
        state.swaps_paused = swaps_paused;
        state.claims_paused = claims_paused;
        reflection_events::pause_changed(swaps_paused, claims_paused);
    }

    /// The publisher remains the cold package/capability authority while this
    /// evented handoff assigns routine fee and pause controls to a separate key.
    public entry fun set_operational_admin(
        publisher: &signer,
        new_operational_admin: address,
    ) acquires ReflectionState {
        assert!(new_operational_admin != @0x0, E_INVALID_OPERATIONAL_ADMIN);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_admin(state, publisher);
        let old_operational_admin = state.operational_admin;
        state.operational_admin = new_operational_admin;
        reflection_events::operational_admin_changed(
            old_operational_admin, new_operational_admin,
        );
    }

    public fun issue_settlement_capability(admin: &signer): SettlementCapability acquires ReflectionState {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_admin(state, admin);
        assert!(!state.settlement_capability_issued, E_CAPABILITY_ALREADY_ISSUED);
        state.settlement_capability_issued = true;
        SettlementCapability { nonce: 1 }
    }

    public fun issue_faucet_capability(admin: &signer): FaucetCapability acquires ReflectionState {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_admin(state, admin);
        assert!(!state.faucet_capability_issued, E_CAPABILITY_ALREADY_ISSUED);
        state.faucet_capability_issued = true;
        FaucetCapability { nonce: 1 }
    }

    /// Called once by the canonical AMM during initialization. The custodian
    /// co-signs and must own two distinct, empty, previously unclassified
    /// stores. Their immutable binding is represented by the returned
    /// non-copyable capability.
    public fun register_canonical_custody(
        admin: &signer,
        custodian: &signer,
        pool_store: Object<FungibleStore>,
        lp_reward_vault: Object<FungibleStore>,
    ): CustodySettlementCapability acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_admin(state, admin);
        assert!(!state.pool_registered, E_POOL_ALREADY_REGISTERED);
        assert!(fungible_asset::store_metadata(pool_store) == state.metadata, E_NOT_CANONICAL_POOL);
        assert!(fungible_asset::store_metadata(lp_reward_vault) == state.metadata, E_NOT_CANONICAL_POOL);
        let custodian_address = signer::address_of(custodian);
        assert!(
            object::owner(pool_store) == custodian_address
                && object::owner(lp_reward_vault) == custodian_address,
            E_NOT_CUSTODY_STORE_OWNER,
        );
        let pool_store_address = object::object_address(&pool_store);
        let lp_reward_vault_address = object::object_address(&lp_reward_vault);
        assert!(pool_store_address != lp_reward_vault_address, E_STORE_ALREADY_CLASSIFIED);
        assert!(fungible_asset::balance_with_ref(&state.raw_balance_ref, pool_store) == 0, E_STORE_NOT_EMPTY);
        assert!(fungible_asset::balance_with_ref(&state.raw_balance_ref, lp_reward_vault) == 0, E_STORE_NOT_EMPTY);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        assert!(!custody.registered, E_CUSTODY_ALREADY_REGISTERED);
        assert!(
            !is_excluded_store(state, pool_store_address)
                && !is_excluded_store(state, lp_reward_vault_address)
                && !is_eligible_wallet_store(state, custody, pool_store)
                && !is_eligible_wallet_store(state, custody, lp_reward_vault),
            E_STORE_ALREADY_CLASSIFIED,
        );
        state.pool_store = pool_store_address;
        state.pool_registered = true;
        table::add(&mut state.exclusions, state.pool_store, true);
        table::add(&mut state.exclusions, lp_reward_vault_address, true);
        fungible_asset::set_frozen_flag(&state.transfer_ref, pool_store, true);
        fungible_asset::set_frozen_flag(&state.transfer_ref, lp_reward_vault, true);
        custody.registered = true;
        reflection_events::custody_adapter_registered(
            pool_store_address,
            lp_reward_vault_address,
        );
        custody_registry::register(admin, pool_store, lp_reward_vault)
    }

    /// Binds the next LP epoch to a fresh empty reward vault. The previous
    /// vault remains approved for claim-only payouts, but current custody
    /// rewards can route only to the new active vault.
    public fun open_custody_epoch_route(
        admin: &signer,
        cap: &CustodySettlementCapability,
        epoch: u64,
        pool_store: Object<FungibleStore>,
        lp_reward_vault: Object<FungibleStore>,
    ) acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_admin(state, admin);
        assert_pool(state, pool_store);
        custody_registry::assert_reserve(cap, pool_store);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        assert!(custody.custody_shares == 0, E_CUSTODY_SHARE_MISMATCH);
        assert!(fungible_asset::balance_with_ref(&state.raw_balance_ref, pool_store) == 0, E_STORE_NOT_EMPTY);
        assert!(custody_pending_for_store(state, custody, pool_store) == 0, E_CUSTODY_PENDING_AT_EPOCH_CHANGE);

        // A zero-share position can still contain a sub-base-unit magnified
        // residue from the prior epoch. Reusing that correction would let a
        // later epoch mature old fractions into a whole reward. Preserve the
        // already-routed whole entitlement (`claimed * M`), remove only the
        // fractional residue from both position and aggregate corrections, and
        // let the exact vault partition name any resulting whole unit as core
        // rounding reserve.
        let (negative, correction_magnitude) = reflection_math::parts(
            custody.pool_position.correction,
        );
        let normalized_magnitude = custody.pool_position.claimed
            * reflection_math::magnitude();
        assert!(
            !negative
                && correction_magnitude >= normalized_magnitude
                && correction_magnitude < normalized_magnitude + reflection_math::magnitude(),
            E_INVALID_CUSTODY_EPOCH_RESIDUE,
        );
        let retired_residue = correction_magnitude - normalized_magnitude;
        if (retired_residue > 0) {
            reflection_math::subtract_unsigned(
                &mut custody.pool_position.correction,
                retired_residue,
            );
            reflection_math::subtract_unsigned(
                &mut state.aggregate_correction,
                retired_residue,
            );
        };
        recompute_rounding_reserve(state, custody);
        assert!(fungible_asset::store_metadata(lp_reward_vault) == state.metadata, E_NOT_CANONICAL_POOL);
        assert!(fungible_asset::balance_with_ref(&state.raw_balance_ref, lp_reward_vault) == 0, E_STORE_NOT_EMPTY);
        let vault_address = object::object_address(&lp_reward_vault);
        assert!(!table::contains(&state.exclusions, vault_address), E_CUSTODY_ALREADY_REGISTERED);
        table::add(&mut state.exclusions, vault_address, true);
        fungible_asset::set_frozen_flag(&state.transfer_ref, lp_reward_vault, true);
        custody_registry::open_epoch(admin, cap, epoch, lp_reward_vault);
        reflection_events::custody_epoch_route_opened(
            epoch,
            object::object_address(&pool_store),
            vault_address,
            retired_residue,
        );
    }

    /// Administrative and contract-owned primary stores must be registered
    /// before they receive tRFL. This prevents privileged balances from taking
    /// reflection shares while retaining a narrow, auditable allow-list.
    public fun register_excluded_primary_store(admin: &signer, account: address) acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_admin(state, admin);
        assert!(!is_registered_wallet(borrow_global<CustodyAccounting>(@reflection_core), account), E_UNREGISTERED_WALLET);
        let store = primary_fungible_store::primary_store_address_inlined(account, state.metadata);
        if (!table::contains(&state.exclusions, store)) {
            table::add(&mut state.exclusions, store, true);
        };
    }

    /// Bootstrap movement from the pre-minted excluded reserve. Requiring the
    /// AMM-held custody capability prevents a standalone admin call from
    /// funding custody without atomically issuing LP ownership.
    public fun seed_pool_from_distribution(
        cap: &CustodySettlementCapability,
        admin: &signer,
        pool_store: Object<FungibleStore>,
        amount: u64,
    ) acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_admin(state, admin);
        assert_pool(state, pool_store);
        custody_registry::assert_reserve(cap, pool_store);
        assert!(amount > 0, E_ZERO_AMOUNT);
        fungible_asset::transfer_with_ref(&state.transfer_ref, state.distribution_vault, pool_store, amount);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        add_custody_shares(state, custody, amount);
        assert_custody_matches_raw(state, custody, pool_store);
    }

    /// Faucet-only movement from excluded distribution reserve to an eligible
    /// primary store. It is deliberately not minting.
    public fun faucet_grant(cap: &FaucetCapability, recipient: address, amount: u64, operator: address) acquires ReflectionState, CustodyAccounting {
        assert!(cap.nonce == 1, E_INVALID_CAP);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        let recipient_store = primary_fungible_store::ensure_primary_store_exists(recipient, state.metadata);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        ensure_registered_wallet_for_store(state, custody, recipient, recipient_store);
        assert_eligible_primary_store(state, custody, recipient_store);
        fungible_asset::transfer_with_ref(&state.transfer_ref, state.distribution_vault, recipient_store, amount);
        add_raw_shares(state, recipient, amount);
        reflection_events::faucet_grant(recipient, amount, operator);
    }

    /// Canonical sell settlement: gross leaves the seller, fee reaches the
    /// reward vault, and only the net amount reaches the pool reserve.
    public fun settle_sell(
        cap: &SettlementCapability,
        seller: &signer,
        pool_store: Object<FungibleStore>,
        gross_input: u64,
    ): (u64, u64) acquires ReflectionState, CustodyAccounting {
        assert!(cap.nonce == 1, E_INVALID_CAP);
        assert!(gross_input > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert!(!state.swaps_paused, E_SWAPS_PAUSED);
        assert_pool(state, pool_store);
        let seller_address = signer::address_of(seller);
        let seller_store = primary_fungible_store::ensure_primary_store_exists(seller_address, state.metadata);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        assert_eligible_primary_store(state, custody, seller_store);
        let raw = fungible_asset::balance_with_ref(&state.raw_balance_ref, seller_store);
        if (raw < gross_input) {
            assert!(state.automatic_materialization, E_AUTOMATIC_MATERIALIZATION_DISABLED);
            assert!(!state.claims_paused, E_CLAIMS_PAUSED);
            materialize_to_store(state, seller_address, seller_store, gross_input - raw, false);
        };
        let raw_after_materialisation = fungible_asset::balance_with_ref(&state.raw_balance_ref, seller_store);
        assert!(raw_after_materialisation >= gross_input, E_INSUFFICIENT_EFFECTIVE_BALANCE);
        let input_asset = fungible_asset::withdraw_with_ref(&state.transfer_ref, seller_store, gross_input);
        remove_raw_shares(state, seller_address, gross_input);
        let fee = fee_for(state, gross_input);
        let net_input = gross_input - fee;
        if (fee > 0) {
            let fee_asset = fungible_asset::extract(&mut input_asset, fee);
            fungible_asset::deposit_with_ref(&state.transfer_ref, state.reward_vault, fee_asset);
            advance_index(state, custody, seller_address, gross_input, fee, 1);
        };
        fungible_asset::deposit_with_ref(&state.transfer_ref, pool_store, input_asset);
        add_custody_shares(state, custody, net_input);
        assert_custody_matches_raw(state, custody, pool_store);
        (net_input, fee)
    }

    /// Canonical buy settlement. The index advances before net tRFL reaches the
    /// buyer, so newly purchased tRFL cannot receive its own fee.
    public fun settle_buy(
        cap: &SettlementCapability,
        buyer: &signer,
        pool_store: Object<FungibleStore>,
        gross_output: u64,
    ): (u64, u64) acquires ReflectionState, CustodyAccounting {
        assert!(cap.nonce == 1, E_INVALID_CAP);
        assert!(gross_output > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert!(!state.swaps_paused, E_SWAPS_PAUSED);
        assert_pool(state, pool_store);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        remove_custody_shares(state, custody, gross_output);
        let output_asset = fungible_asset::withdraw_with_ref(&state.transfer_ref, pool_store, gross_output);
        let fee = fee_for(state, gross_output);
        let net_output = gross_output - fee;
        assert!(net_output > 0, E_ZERO_AMOUNT);
        if (fee > 0) {
            let fee_asset = fungible_asset::extract(&mut output_asset, fee);
            fungible_asset::deposit_with_ref(&state.transfer_ref, state.reward_vault, fee_asset);
            advance_index(state, custody, signer::address_of(buyer), gross_output, fee, 2);
        };
        let buyer_address = signer::address_of(buyer);
        let buyer_store = primary_fungible_store::ensure_primary_store_exists(buyer_address, state.metadata);
        ensure_registered_wallet_for_store(state, custody, buyer_address, buyer_store);
        assert_eligible_primary_store(state, custody, buyer_store);
        fungible_asset::deposit_with_ref(&state.transfer_ref, buyer_store, output_asset);
        add_raw_shares(state, buyer_address, net_output);
        assert_custody_matches_raw(state, custody, pool_store);
        (net_output, fee)
    }

    /// Untaxed proportional liquidity input. Wallet and custody corrections
    /// are applied at the same global index, so pre-deposit entitlement stays
    /// with the provider while total global shares remain unchanged.
    public fun move_wallet_to_custody(
        cap: &CustodySettlementCapability,
        provider: &signer,
        pool_store: Object<FungibleStore>,
        amount: u64,
    ) acquires ReflectionState, CustodyAccounting {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_pool(state, pool_store);
        custody_registry::assert_reserve(cap, pool_store);
        let provider_address = signer::address_of(provider);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        assert_registered_wallet(custody, provider_address);
        let provider_store = primary_fungible_store::ensure_primary_store_exists(provider_address, state.metadata);
        let raw = fungible_asset::balance_with_ref(&state.raw_balance_ref, provider_store);
        if (raw < amount) {
            assert!(state.automatic_materialization, E_AUTOMATIC_MATERIALIZATION_DISABLED);
            assert!(!state.claims_paused, E_CLAIMS_PAUSED);
            materialize_to_store(state, provider_address, provider_store, amount - raw, false);
        };
        let asset = fungible_asset::withdraw_with_ref(&state.transfer_ref, provider_store, amount);
        remove_raw_shares(state, provider_address, amount);
        fungible_asset::deposit_with_ref(&state.transfer_ref, pool_store, asset);
        add_custody_shares(state, custody, amount);
        assert_custody_matches_raw(state, custody, pool_store);
    }

    /// Untaxed proportional liquidity output. Custody and wallet corrections
    /// are applied at the same global index after the AMM has checkpointed and
    /// burned the provider's LP shares.
    public fun move_custody_to_wallet(
        cap: &CustodySettlementCapability,
        pool_store: Object<FungibleStore>,
        recipient: &signer,
        amount: u64,
    ) acquires ReflectionState, CustodyAccounting {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert_pool(state, pool_store);
        custody_registry::assert_reserve(cap, pool_store);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        remove_custody_shares(state, custody, amount);
        let asset = fungible_asset::withdraw_with_ref(&state.transfer_ref, pool_store, amount);
        let recipient_address = signer::address_of(recipient);
        let recipient_store = primary_fungible_store::ensure_primary_store_exists(recipient_address, state.metadata);
        ensure_registered_wallet_for_store(state, custody, recipient_address, recipient_store);
        assert_eligible_primary_store(state, custody, recipient_store);
        fungible_asset::deposit_with_ref(&state.transfer_ref, recipient_store, asset);
        add_raw_shares(state, recipient_address, amount);
        assert_custody_matches_raw(state, custody, pool_store);
    }

    /// Moves the canonical custody position's whole pending reward into the
    /// active LP epoch vault. This settles one liability and creates another;
    /// it never adds raw reserve units or changes global shares/corrections.
    public fun route_custody_rewards(
        cap: &CustodySettlementCapability,
        pool_store: Object<FungibleStore>,
        epoch: u64,
        lp_reward_vault: Object<FungibleStore>,
    ): u64 acquires ReflectionState, CustodyAccounting {
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert!(!state.claims_paused, E_CLAIMS_PAUSED);
        assert_pool(state, pool_store);
        custody_registry::assert_active_route(cap, pool_store, epoch, lp_reward_vault);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        assert_custody_matches_raw(state, custody, pool_store);
        let amount = custody_pending_for_store(state, custody, pool_store);
        if (amount == 0) return 0;
        custody.pool_position.claimed = custody.pool_position.claimed + (amount as u256);
        custody.lifetime_custody_routed = custody.lifetime_custody_routed + (amount as u256);
        fungible_asset::transfer_with_ref(&state.transfer_ref, state.reward_vault, lp_reward_vault, amount);
        reflection_events::custody_rewards_routed(
            object::object_address(&pool_store),
            object::object_address(&lp_reward_vault),
            epoch,
            amount,
            custody.pool_position.claimed,
        );
        amount
    }

    /// Payout seam for an LP epoch. The AMM computes and settles the LP
    /// position; the core merely verifies the immutable epoch vault binding,
    /// moves the exact amount with its TransferRef, and attaches the receipt to
    /// the wallet at the current global index.
    public fun payout_lp_reward(
        cap: &CustodySettlementCapability,
        claimant: &signer,
        epoch: u64,
        lp_reward_vault: Object<FungibleStore>,
        amount: u64,
    ) acquires ReflectionState, CustodyAccounting {
        assert!(amount > 0, E_ZERO_AMOUNT);
        let state = borrow_global_mut<ReflectionState>(@reflection_core);
        assert!(!state.claims_paused, E_CLAIMS_PAUSED);
        custody_registry::assert_claim_vault(cap, epoch, lp_reward_vault);
        let claimant_address = signer::address_of(claimant);
        let custody = borrow_global_mut<CustodyAccounting>(@reflection_core);
        let claimant_store = primary_fungible_store::ensure_primary_store_exists(claimant_address, state.metadata);
        ensure_registered_wallet_for_store(state, custody, claimant_address, claimant_store);
        assert_eligible_primary_store(state, custody, claimant_store);
        let asset = fungible_asset::withdraw_with_ref(&state.transfer_ref, lp_reward_vault, amount);
        fungible_asset::deposit_with_ref(&state.transfer_ref, claimant_store, asset);
        add_raw_shares(state, claimant_address, amount);
    }

    #[view]
    public fun metadata(): Object<Metadata> acquires ReflectionState { borrow_global<ReflectionState>(@reflection_core).metadata }
    #[view]
    public fun reward_vault(): Object<FungibleStore> acquires ReflectionState { borrow_global<ReflectionState>(@reflection_core).reward_vault }
    #[view]
    public fun distribution_vault(): Object<FungibleStore> acquires ReflectionState { borrow_global<ReflectionState>(@reflection_core).distribution_vault }
    #[view]
    public fun fee_bps(): u64 acquires ReflectionState { borrow_global<ReflectionState>(@reflection_core).fee_bps }
    #[view]
    public fun reflection_fee_for(gross_amount: u64): u64 acquires ReflectionState {
        fee_for(borrow_global<ReflectionState>(@reflection_core), gross_amount)
    }
    #[view]
    public fun pauses(): (bool, bool) acquires ReflectionState { let s = borrow_global<ReflectionState>(@reflection_core); (s.swaps_paused, s.claims_paused) }
    #[view]
    public fun operational_admin(): address acquires ReflectionState {
        borrow_global<ReflectionState>(@reflection_core).operational_admin
    }
    #[view]
    public fun automatic_materialization_enabled(): bool acquires ReflectionState {
        borrow_global<ReflectionState>(@reflection_core).automatic_materialization
    }
    #[view]
    public fun primary_store_is_excluded(account: address): bool acquires ReflectionState {
        let s = borrow_global<ReflectionState>(@reflection_core);
        is_excluded_store(s, primary_fungible_store::primary_store_address_inlined(account, s.metadata))
    }
    #[view]
    public fun global_accounting(): (u256, u256, u128, u128, u256, u256) acquires ReflectionState {
        let s = borrow_global<ReflectionState>(@reflection_core);
        (s.index, s.index_remainder, s.total_shares, s.unallocated_fees, s.lifetime_fees, s.lifetime_materialized)
    }
    #[view]
    public fun aggregate_correction(): (bool, u256) acquires ReflectionState {
        reflection_math::parts(borrow_global<ReflectionState>(@reflection_core).aggregate_correction)
    }
    #[view]
    public fun raw_balance(account: address): u64 acquires ReflectionState {
        let s = borrow_global<ReflectionState>(@reflection_core);
        if (!primary_fungible_store::primary_store_exists(account, s.metadata)) return 0;
        fungible_asset::balance_with_ref(&s.raw_balance_ref, primary_fungible_store::primary_store(account, s.metadata))
    }
    #[view]
    public fun raw_store_balance<T: key>(store: Object<T>): u64 acquires ReflectionState {
        let s = borrow_global<ReflectionState>(@reflection_core);
        fungible_asset::balance_with_ref(&s.raw_balance_ref, store)
    }
    #[view]
    public fun pending_rewards(account: address): u64 acquires ReflectionState {
        let s = borrow_global<ReflectionState>(@reflection_core);
        if (!primary_fungible_store::primary_store_exists(account, s.metadata)) return 0;
        claimable_for_store(s, account, primary_fungible_store::primary_store(account, s.metadata))
    }
    #[view]
    public fun effective_balance(account: address): u64 acquires ReflectionState {
        let s = borrow_global<ReflectionState>(@reflection_core);
        if (!primary_fungible_store::primary_store_exists(account, s.metadata)) return 0;
        let store = primary_fungible_store::primary_store(account, s.metadata);
        fungible_asset::balance_with_ref(&s.raw_balance_ref, store) + claimable_for_store(s, account, store)
    }
    #[view]
    public fun reward_vault_balance(): u64 acquires ReflectionState {
        let s = borrow_global<ReflectionState>(@reflection_core);
        fungible_asset::balance_with_ref(&s.raw_balance_ref, s.reward_vault)
    }
    #[view]
    public fun wallet_is_registered(account: address): bool acquires CustodyAccounting {
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        table::contains(&custody.registered_wallets, account)
            && *table::borrow(&custody.registered_wallets, account)
    }
    #[view]
    public fun custody_accounting(): (u128, u256, u128) acquires CustodyAccounting {
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        (custody.custody_shares, custody.lifetime_custody_routed, custody.rounding_reserve)
    }
    #[view]
    public fun wallet_position_accounting(account: address): (bool, u256, u256) acquires ReflectionState {
        let state = borrow_global<ReflectionState>(@reflection_core);
        if (!table::contains(&state.positions, account)) return (false, 0, 0);
        let position = table::borrow(&state.positions, account);
        let (negative, magnitude) = reflection_math::parts(position.correction);
        (negative, magnitude, position.claimed)
    }
    #[view]
    public fun custody_position_accounting(): (address, bool, u256, u256, u64) acquires ReflectionState, CustodyAccounting {
        let state = borrow_global<ReflectionState>(@reflection_core);
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        let (negative, magnitude) = reflection_math::parts(custody.pool_position.correction);
        let pending = if (state.pool_registered) {
            custody_pending_for_store(
                state,
                custody,
                object::address_to_object<FungibleStore>(state.pool_store),
            )
        } else {
            0
        };
        (state.pool_store, negative, magnitude, custody.pool_position.claimed, pending)
    }
    #[view]
    public fun pool_pending_rewards(): u64 acquires ReflectionState, CustodyAccounting {
        let state = borrow_global<ReflectionState>(@reflection_core);
        if (!state.pool_registered) return 0;
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        custody_pending_for_store(
            state,
            custody,
            object::address_to_object<FungibleStore>(state.pool_store),
        )
    }
    #[view]
    public fun aggregate_indexed_liability(): u256 acquires ReflectionState, CustodyAccounting {
        aggregate_liability(
            borrow_global<ReflectionState>(@reflection_core),
            borrow_global<CustodyAccounting>(@reflection_core),
        )
    }
    #[view]
    public fun core_vault_partition(): (u64, u256, u128, u128) acquires ReflectionState, CustodyAccounting {
        let state = borrow_global<ReflectionState>(@reflection_core);
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        (
            fungible_asset::balance_with_ref(&state.raw_balance_ref, state.reward_vault),
            aggregate_liability(state, custody),
            state.unallocated_fees,
            custody.rounding_reserve,
        )
    }
    public fun assert_accounting_backing() acquires ReflectionState, CustodyAccounting {
        let state = borrow_global<ReflectionState>(@reflection_core);
        let custody = borrow_global<CustodyAccounting>(@reflection_core);
        let vault = fungible_asset::balance_with_ref(&state.raw_balance_ref, state.reward_vault) as u256;
        assert!(
            vault
                == aggregate_liability(state, custody)
                    + (state.unallocated_fees as u256)
                    + (custody.rounding_reserve as u256),
            E_CUSTODY_SHARE_MISMATCH,
        );
        assert!(
            state.lifetime_fees
                >= state.lifetime_materialized + custody.lifetime_custody_routed
                && vault
                    == state.lifetime_fees
                        - state.lifetime_materialized
                        - custody.lifetime_custody_routed,
            E_CUSTODY_SHARE_MISMATCH,
        );
    }
    fun assert_admin(state: &ReflectionState, admin: &signer) {
        assert!(signer::address_of(admin) == state.admin, E_NOT_ADMIN);
    }

    fun assert_operational_admin(state: &ReflectionState, admin: &signer) {
        assert!(
            signer::address_of(admin) == state.operational_admin,
            E_NOT_OPERATIONAL_ADMIN,
        );
    }

    fun assert_pool(state: &ReflectionState, pool_store: Object<FungibleStore>) {
        assert!(state.pool_registered, E_NO_POOL);
        assert!(object::object_address(&pool_store) == state.pool_store, E_NOT_CANONICAL_POOL);
    }

    fun assert_eligible_primary_store(
        state: &ReflectionState,
        custody: &CustodyAccounting,
        store: Object<FungibleStore>,
    ) {
        assert!(!is_excluded_store(state, object::object_address(&store)), E_EXCLUDED_RECIPIENT);
        assert_registered_wallet(custody, object::owner(store));
    }

    fun is_excluded_store(state: &ReflectionState, store: address): bool {
        table::contains(&state.exclusions, store) && *table::borrow(&state.exclusions, store)
    }

    fun is_eligible_wallet_store<T: key>(
        state: &ReflectionState,
        custody: &CustodyAccounting,
        store: Object<T>,
    ): bool {
        let address = object::object_address(&store);
        if (is_excluded_store(state, address)) return false;
        let owner = object::owner(store);
        if (!is_registered_wallet(custody, owner)) return false;
        // Hooks run while primary_fungible_store is module-locked. Cedra exposes
        // this inlined variant specifically so hook implementations do not
        // dynamically re-enter the primary-store module.
        address == primary_fungible_store::primary_store_address_inlined(owner, state.metadata)
    }

    fun is_registered_wallet(custody: &CustodyAccounting, account: address): bool {
        table::contains(&custody.registered_wallets, account)
            && *table::borrow(&custody.registered_wallets, account)
    }

    fun assert_registered_wallet(custody: &CustodyAccounting, account: address) {
        assert!(is_registered_wallet(custody, account), E_UNREGISTERED_WALLET);
    }

    fun ensure_registered_wallet(custody: &mut CustodyAccounting, account: address) {
        if (!table::contains(&custody.registered_wallets, account)) {
            table::add(&mut custody.registered_wallets, account, true);
        };
    }

    /// Registration never retroactively turns an already-funded store into
    /// reward shares. All signer-authenticated receipt paths call this before
    /// their privileged deposit; an already-funded unregistered store is
    /// rejected rather than receiving retroactive reward weight.
    fun ensure_registered_wallet_for_store(
        state: &ReflectionState,
        custody: &mut CustodyAccounting,
        account: address,
        store: Object<FungibleStore>,
    ) {
        if (!is_registered_wallet(custody, account)) {
            assert!(
                fungible_asset::balance_with_ref(&state.raw_balance_ref, store) == 0,
                E_UNREGISTERED_WALLET,
            );
            ensure_registered_wallet(custody, account);
        };
    }

    fun ensure_position(state: &mut ReflectionState, account: address) {
        if (!table::contains(&state.positions, account)) {
            table::add(&mut state.positions, account, Position { correction: reflection_math::zero(), claimed: 0 });
            reflection_events::position_created(account);
        };
    }

    fun add_raw_shares(state: &mut ReflectionState, account: address, amount: u64) {
        if (amount == 0) return;
        ensure_position(state, account);
        let index = state.index;
        let correction_delta = (amount as u256) * index;
        {
            let position = table::borrow_mut(&mut state.positions, account);
            reflection_math::subtract_unsigned(&mut position.correction, correction_delta);
        };
        reflection_math::subtract_unsigned(&mut state.aggregate_correction, correction_delta);
        state.total_shares = state.total_shares + (amount as u128);
    }

    fun remove_raw_shares(state: &mut ReflectionState, account: address, amount: u64) {
        if (amount == 0) return;
        ensure_position(state, account);
        let index = state.index;
        let correction_delta = (amount as u256) * index;
        {
            let position = table::borrow_mut(&mut state.positions, account);
            reflection_math::add_unsigned(&mut position.correction, correction_delta);
        };
        reflection_math::add_unsigned(&mut state.aggregate_correction, correction_delta);
        state.total_shares = state.total_shares - (amount as u128);
    }

    fun add_custody_shares(
        state: &mut ReflectionState,
        custody: &mut CustodyAccounting,
        amount: u64,
    ) {
        if (amount == 0) return;
        let correction_delta = (amount as u256) * state.index;
        reflection_math::subtract_unsigned(&mut custody.pool_position.correction, correction_delta);
        reflection_math::subtract_unsigned(&mut state.aggregate_correction, correction_delta);
        custody.custody_shares = custody.custody_shares + (amount as u128);
        state.total_shares = state.total_shares + (amount as u128);
        reflection_events::custody_shares_changed(true, amount, custody.custody_shares, state.total_shares);
    }

    fun remove_custody_shares(
        state: &mut ReflectionState,
        custody: &mut CustodyAccounting,
        amount: u64,
    ) {
        if (amount == 0) return;
        assert!(custody.custody_shares >= (amount as u128), E_CUSTODY_SHARE_MISMATCH);
        let correction_delta = (amount as u256) * state.index;
        reflection_math::add_unsigned(&mut custody.pool_position.correction, correction_delta);
        reflection_math::add_unsigned(&mut state.aggregate_correction, correction_delta);
        custody.custody_shares = custody.custody_shares - (amount as u128);
        state.total_shares = state.total_shares - (amount as u128);
        reflection_events::custody_shares_changed(false, amount, custody.custody_shares, state.total_shares);
    }

    fun custody_pending_for_store(
        state: &ReflectionState,
        custody: &CustodyAccounting,
        store: Object<FungibleStore>,
    ): u64 {
        if (!custody.registered) return 0;
        let raw = fungible_asset::balance_with_ref(&state.raw_balance_ref, store);
        assert!((raw as u128) == custody.custody_shares, E_CUSTODY_SHARE_MISMATCH);
        let magnified = reflection_math::apply(
            (custody.custody_shares as u256) * state.index,
            custody.pool_position.correction,
        );
        let entitled = magnified / reflection_math::magnitude();
        reflection_math::checked_subtract(entitled, custody.pool_position.claimed) as u64
    }

    fun assert_custody_matches_raw(
        state: &ReflectionState,
        custody: &CustodyAccounting,
        store: Object<FungibleStore>,
    ) {
        assert!(
            (fungible_asset::balance_with_ref(&state.raw_balance_ref, store) as u128)
                == custody.custody_shares,
            E_CUSTODY_SHARE_MISMATCH,
        );
    }

    fun aggregate_liability(state: &ReflectionState, custody: &CustodyAccounting): u256 {
        let magnified = reflection_math::apply(
            (state.total_shares as u256) * state.index,
            state.aggregate_correction,
        );
        let gross_entitlement = magnified / reflection_math::magnitude();
        let settled = state.lifetime_materialized + custody.lifetime_custody_routed;
        reflection_math::checked_subtract(gross_entitlement, settled)
    }

    fun recompute_rounding_reserve(state: &ReflectionState, custody: &mut CustodyAccounting) {
        let vault_balance = fungible_asset::balance_with_ref(&state.raw_balance_ref, state.reward_vault) as u256;
        let named = aggregate_liability(state, custody) + (state.unallocated_fees as u256);
        assert!(vault_balance >= named, E_CUSTODY_SHARE_MISMATCH);
        custody.rounding_reserve = (vault_balance - named) as u128;
    }

    fun claimable_for_store<T: key>(state: &ReflectionState, account: address, store: Object<T>): u64 {
        if (!table::contains(&state.positions, account)) return 0;
        let raw = fungible_asset::balance_with_ref(&state.raw_balance_ref, store);
        let position = table::borrow(&state.positions, account);
        let magnified = reflection_math::apply((raw as u256) * state.index, position.correction);
        let entitled = magnified / reflection_math::magnitude();
        let pending = reflection_math::checked_subtract(entitled, position.claimed);
        pending as u64
    }

    /// Returns materialised amount. It first updates correction and claimed
    /// accounting, then moves exactly that amount from the excluded reward
    /// vault. Thus raw balance rises and pending falls by the same amount.
    fun materialize_all_to_store<T: key>(state: &mut ReflectionState, account: address, store: Object<T>, explicit_claim: bool): u64 {
        if (!table::contains(&state.positions, account)) return 0;
        let pending = claimable_for_store(state, account, store);
        if (pending == 0) return 0;
        materialize_to_store(state, account, store, pending, explicit_claim)
    }

    /// Materialises an exact positive portion of pending reward. This is the
    /// public `claim(amount)` primitive; hooks call the all-pending wrapper.
    fun materialize_to_store<T: key>(state: &mut ReflectionState, account: address, store: Object<T>, amount: u64, explicit_claim: bool): u64 {
        let pending = claimable_for_store(state, account, store);
        assert!(amount > 0 && amount <= pending, E_CLAIM_EXCEEDS_PENDING);
        let index = state.index;
        let correction_delta = (amount as u256) * index;
        let total_claimed = {
            let position = table::borrow_mut(&mut state.positions, account);
            position.claimed = position.claimed + (amount as u256);
            reflection_math::subtract_unsigned(&mut position.correction, correction_delta);
            position.claimed
        };
        reflection_math::subtract_unsigned(&mut state.aggregate_correction, correction_delta);
        state.total_shares = state.total_shares + (amount as u128);
        state.lifetime_materialized = state.lifetime_materialized + (amount as u256);
        let asset = fungible_asset::withdraw_with_ref(&state.transfer_ref, state.reward_vault, amount);
        fungible_asset::deposit_with_ref(&state.transfer_ref, store, asset);
        reflection_events::rewards_materialized(account, amount, total_claimed);
        if (explicit_claim) reflection_events::rewards_claimed(account, amount, total_claimed);
        amount
    }

    fun fee_for(state: &ReflectionState, gross: u64): u64 {
        ((gross as u128) * (state.fee_bps as u128) / (BPS_DENOMINATOR as u128)) as u64
    }

    /// Physical fee must already be in reward_vault before this function. A
    /// carried numerator remainder ensures no global division dust disappears.
    fun advance_index(
        state: &mut ReflectionState,
        custody: &mut CustodyAccounting,
        account: address,
        gross: u64,
        fee: u64,
        kind: u8,
    ) {
        state.lifetime_fees = state.lifetime_fees + (fee as u256);
        reflection_events::fee_collected(account, gross, fee, kind);
        if (state.total_shares == 0) {
            state.unallocated_fees = state.unallocated_fees + (fee as u128);
            recompute_rounding_reserve(state, custody);
            return
        };
        let old_index = state.index;
        let numerator = (fee as u256) * reflection_math::magnitude() + state.index_remainder;
        let shares = state.total_shares as u256;
        state.index = state.index + numerator / shares;
        state.index_remainder = numerator % shares;
        recompute_rounding_reserve(state, custody);
        reflection_events::index_advanced(old_index, state.index, state.index_remainder, fee, state.total_shares);
    }

    #[test_only]
    public fun initialize_for_test(admin: &signer) { initialize(admin, true); }

    #[test_only]
    public fun initialize_claim_backed_for_test(admin: &signer) { initialize(admin, false); }

    #[test_only]
    public fun destroy_faucet_capability_for_test(cap: FaucetCapability) {
        let FaucetCapability { nonce: _ } = cap;
    }
}
