/// Stable public liquidity facade for the canonical Testnet AMM.
///
/// Pool state and settlement authority remain private to `pool`; this module
/// exposes only proportional, checkpointed LP lifecycle operations.
module test_amm::liquidity {
    use test_amm::pool;

    public entry fun add(
        provider: &signer,
        max_rfl: u64,
        max_usd: u64,
        min_lp_shares: u128,
        deadline_seconds: u64,
    ) {
        pool::add_liquidity(provider, max_rfl, max_usd, min_lp_shares, deadline_seconds)
    }

    public entry fun remove(
        provider: &signer,
        shares: u128,
        min_rfl_output: u64,
        min_usd_output: u64,
        deadline_seconds: u64,
    ) {
        pool::remove_liquidity(
            provider,
            shares,
            min_rfl_output,
            min_usd_output,
            deadline_seconds,
        )
    }

    public entry fun claim_rewards(owner: &signer, epoch: u64, amount: u64) {
        pool::claim_lp_rewards(owner, epoch, amount)
    }

    public entry fun checkpoint(caller: &signer) {
        pool::checkpoint_lp_rewards(caller)
    }
}
