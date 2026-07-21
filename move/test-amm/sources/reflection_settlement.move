/// Shared AMM settlement arithmetic. The tRFL reflection fee is calculated in
/// reflection-core; this module applies the independent AMM trading fee.
module test_amm::reflection_settlement {
    const BPS_DENOMINATOR: u64 = 10_000;
    const E_FEE_TOO_HIGH: u64 = 1;
    const E_ZERO_DENOMINATOR: u64 = 2;
    const E_NARROWING_OVERFLOW: u64 = 3;
    const E_INVALID_LP_BURN: u64 = 4;
    const MAX_U64_AS_U128: u128 = 18_446_744_073_709_551_615;
    const MAX_U64_AS_U256: u256 = 18_446_744_073_709_551_615;
    const MAX_U128_AS_U256: u256 = 340_282_366_920_938_463_463_374_607_431_768_211_455;

    public fun fee(amount: u64, fee_bps: u64): u64 {
        assert!(fee_bps <= BPS_DENOMINATOR, E_FEE_TOO_HIGH);
        let invariant_input_u128 =
            (amount as u128) * ((BPS_DENOMINATOR - fee_bps) as u128)
                / (BPS_DENOMINATOR as u128);
        // A u64 amount multiplied by at most 10_000 fits u128, and division
        // by 10_000 cannot increase it. Keep the bound explicit before the
        // only narrowing conversion in fee settlement.
        assert!(invariant_input_u128 <= MAX_U64_AS_U128, E_NARROWING_OVERFLOW);
        let invariant_input = invariant_input_u128 as u64;
        amount - invariant_input
    }

    /// Constant-product output with the trading fee retained in the input
    /// reserve. The caller must require nonzero reserves and result.
    public fun constant_product_output(reserve_in: u64, reserve_out: u64, gross_input: u64, amm_fee_bps: u64): (u64, u64) {
        assert!(reserve_in > 0, E_ZERO_DENOMINATOR);
        let amm_fee = fee(gross_input, amm_fee_bps);
        let invariant_input = gross_input - amm_fee;
        let output_u128 = (reserve_out as u128) * (invariant_input as u128)
            / ((reserve_in as u128) + (invariant_input as u128));
        // reserve_in > 0 makes the denominator greater than invariant_input,
        // so output is strictly below reserve_out and therefore fits u64.
        assert!(output_u128 <= MAX_U64_AS_U128, E_NARROWING_OVERFLOW);
        let output = output_u128 as u64;
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
        assert!(reserve_rfl > 0 && reserve_usd > 0 && total_shares > 0, E_ZERO_DENOMINATOR);
        let shares_from_rfl = (max_rfl as u256) * (total_shares as u256)
            / (reserve_rfl as u256);
        let shares_from_usd = (max_usd as u256) * (total_shares as u256)
            / (reserve_usd as u256);
        // Select the limiting side before narrowing. One non-limiting ratio
        // can exceed u128 for valid u64/u128 inputs even when the actual share
        // result is representable.
        let shares_u256 = if (shares_from_rfl < shares_from_usd) shares_from_rfl else shares_from_usd;
        assert!(shares_u256 <= MAX_U128_AS_U256, E_NARROWING_OVERFLOW);
        let shares = shares_u256 as u128;
        let rfl_used_u256 = ceil_div_u256(
            shares_u256 * (reserve_rfl as u256), total_shares as u256,
        );
        let usd_used_u256 = ceil_div_u256(
            shares_u256 * (reserve_usd as u256), total_shares as u256,
        );
        // The limiting-ratio construction bounds each rounded input by its
        // u64 maximum, but assert the bound immediately before narrowing.
        assert!(rfl_used_u256 <= MAX_U64_AS_U256, E_NARROWING_OVERFLOW);
        assert!(usd_used_u256 <= MAX_U64_AS_U256, E_NARROWING_OVERFLOW);
        let rfl_used = rfl_used_u256 as u64;
        let usd_used = usd_used_u256 as u64;
        (shares, rfl_used, usd_used)
    }

    public fun liquidity_withdrawal(
        shares: u128,
        total_shares: u128,
        reserve_rfl: u64,
        reserve_usd: u64,
    ): (u64, u64) {
        assert!(shares > 0 && total_shares > 0 && shares <= total_shares, E_INVALID_LP_BURN);
        if (shares == total_shares) return (reserve_rfl, reserve_usd);
        let rfl_out_u256 = (shares as u256) * (reserve_rfl as u256)
            / (total_shares as u256);
        let usd_out_u256 = (shares as u256) * (reserve_usd as u256)
            / (total_shares as u256);
        // shares <= total_shares proves each result is at most its u64
        // reserve. The explicit checks make that narrowing premise executable.
        assert!(rfl_out_u256 <= MAX_U64_AS_U256, E_NARROWING_OVERFLOW);
        assert!(usd_out_u256 <= MAX_U64_AS_U256, E_NARROWING_OVERFLOW);
        let rfl_out = rfl_out_u256 as u64;
        let usd_out = usd_out_u256 as u64;
        (rfl_out, usd_out)
    }

    #[test]
    #[expected_failure(abort_code = 2, location = test_amm::reflection_settlement)]
    fun zero_input_reserve_is_rejected_before_constant_product_division() {
        constant_product_output(0, 1, 0, 0);
    }

    #[test]
    #[expected_failure(abort_code = 2, location = test_amm::reflection_settlement)]
    fun zero_liquidity_denominator_is_rejected_before_division() {
        liquidity_mint(1, 1, 0, 1, 1);
    }

    #[test]
    #[expected_failure(abort_code = 3, location = test_amm::reflection_settlement)]
    fun unrepresentable_lp_mint_is_rejected_before_narrowing() {
        liquidity_mint(
            18_446_744_073_709_551_615,
            18_446_744_073_709_551_615,
            1,
            1,
            340_282_366_920_938_463_463_374_607_431_768_211_455,
        );
    }

    #[test]
    #[expected_failure(abort_code = 4, location = test_amm::reflection_settlement)]
    fun zero_lp_burn_is_rejected_before_withdrawal_division() {
        liquidity_withdrawal(0, 1, 1, 1);
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
