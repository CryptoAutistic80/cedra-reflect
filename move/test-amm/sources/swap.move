/// Stable, wallet-facing swap surface. Pricing/settlement stays in pool.move.
module test_amm::swap {
    use test_amm::pool;
    public entry fun sell_trfl(seller: &signer, gross_trfl_input: u64, min_tusd_output: u64, deadline_seconds: u64) {
        pool::sell_trfl(seller, gross_trfl_input, min_tusd_output, deadline_seconds)
    }

    public entry fun buy_trfl(buyer: &signer, tusd_input: u64, min_net_trfl_output: u64, deadline_seconds: u64) {
        pool::buy_trfl(buyer, tusd_input, min_net_trfl_output, deadline_seconds)
    }
}
