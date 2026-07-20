/// Stable account-bound LP-share facade.
///
/// Initial shares deliberately are not freely transferable fungible assets: they
/// exist only in the AMM's checkpointed ledger, so secondary-store and vault
/// custody cannot silently acquire reward weight.
module test_amm::lp_shares {
    use test_amm::pool;

    public entry fun transfer(sender: &signer, recipient: address, shares: u128) {
        pool::transfer_lp_shares(sender, recipient, shares)
    }

    #[view]
    public fun balance(epoch: u64, owner: address): u128 {
        pool::lp_shares(epoch, owner)
    }

    #[view]
    public fun active_supply(): u128 {
        pool::total_lp_shares()
    }
}
