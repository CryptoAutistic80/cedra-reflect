/// Shared AMM settlement arithmetic. The tRFL reflection fee is calculated in
/// reflection-core; this module applies the independent AMM trading fee.
module test_amm::reflection_settlement {
    const BPS_DENOMINATOR: u64 = 10_000;
    const E_FEE_TOO_HIGH: u64 = 1;

    public fun fee(amount: u64, fee_bps: u64): u64 {
        assert!(fee_bps <= BPS_DENOMINATOR, E_FEE_TOO_HIGH);
        let invariant_input = (
            (amount as u128) * ((BPS_DENOMINATOR - fee_bps) as u128)
                / (BPS_DENOMINATOR as u128)
        ) as u64;
        amount - invariant_input
    }

    /// Constant-product output with the trading fee retained in the input
    /// reserve. The caller must require nonzero reserves and result.
    public fun constant_product_output(reserve_in: u64, reserve_out: u64, gross_input: u64, amm_fee_bps: u64): (u64, u64) {
        let amm_fee = fee(gross_input, amm_fee_bps);
        let invariant_input = gross_input - amm_fee;
        let output = ((reserve_out as u128) * (invariant_input as u128) / ((reserve_in as u128) + (invariant_input as u128))) as u64;
        (output, amm_fee)
    }

    #[test]
    fun non_divisible_fee_rounding_matches_floor_invariant_input() {
        // floor(1_801 * 9_970 / 10_000) = 1_795, so six units remain in
        // reserve as AMM fee/rounding. Subtracting floor(1_801 * 30 / 10_000)
        // would incorrectly price with 1_796 units.
        assert!(fee(1_801, 30) == 6, 10);
        assert!(fee(10_000, 30) == 30, 11);
        let (output, charged) = constant_product_output(1_000_000, 1_000_000, 1_801, 30);
        assert!(charged == 6 && output == 1_791, 12);
    }

    public fun initial_lp_shares(rfl_amount: u64, usd_amount: u64): u128 {
        integer_sqrt((rfl_amount as u128) * (usd_amount as u128))
    }

    /// Calculates shares from maximum inputs and returns only the proportional
    /// amounts actually consumed. Excess input remains in the provider stores.
    public fun liquidity_mint(
        max_rfl: u64,
        max_usd: u64,
        reserve_rfl: u64,
        reserve_usd: u64,
        total_shares: u128,
    ): (u128, u64, u64) {
        let shares_from_rfl = (((max_rfl as u256) * (total_shares as u256)) / (reserve_rfl as u256)) as u128;
        let shares_from_usd = (((max_usd as u256) * (total_shares as u256)) / (reserve_usd as u256)) as u128;
        let shares = if (shares_from_rfl < shares_from_usd) shares_from_rfl else shares_from_usd;
        let rfl_used = ceil_div_u256((shares as u256) * (reserve_rfl as u256), total_shares as u256) as u64;
        let usd_used = ceil_div_u256((shares as u256) * (reserve_usd as u256), total_shares as u256) as u64;
        (shares, rfl_used, usd_used)
    }

    public fun liquidity_withdrawal(
        shares: u128,
        total_shares: u128,
        reserve_rfl: u64,
        reserve_usd: u64,
    ): (u64, u64) {
        if (shares == total_shares) return (reserve_rfl, reserve_usd);
        let rfl_out = (((shares as u256) * (reserve_rfl as u256)) / (total_shares as u256)) as u64;
        let usd_out = (((shares as u256) * (reserve_usd as u256)) / (total_shares as u256)) as u64;
        (rfl_out, usd_out)
    }

    fun ceil_div_u256(numerator: u256, denominator: u256): u256 {
        if (numerator == 0) return 0;
        (numerator - 1) / denominator + 1
    }

    fun integer_sqrt(value: u128): u128 {
        if (value < 2) return value;
        let current = value / 2 + 1;
        let next = (current + value / current) / 2;
        while (next < current) {
            current = next;
            next = (current + value / current) / 2;
        };
        current
    }
}
