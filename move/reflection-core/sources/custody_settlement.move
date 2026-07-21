/// Stable canonical-custody surface consumed by the AMM package.
///
/// Binding and accounting live in custody_registry/reflection_token. This thin
/// module is the integration seam consumed by the canonical AMM package.
module reflection_core::custody_settlement {
    use cedra_framework::fungible_asset::FungibleStore;
    use cedra_framework::object::Object;
    use reflection_core::custody_registry::CustodySettlementCapability;
    use reflection_core::reflection_token;

    public fun checkpoint(
        cap: &CustodySettlementCapability,
        reserve: Object<FungibleStore>,
        epoch: u64,
        lp_reward_vault: Object<FungibleStore>,
    ): u64 {
        reflection_token::route_custody_rewards(cap, reserve, epoch, lp_reward_vault)
    }

    public fun wallet_to_custody(
        cap: &CustodySettlementCapability,
        provider: &signer,
        reserve: Object<FungibleStore>,
        amount: u64,
    ) {
        reflection_token::move_wallet_to_custody(cap, provider, reserve, amount)
    }

    public fun custody_to_wallet(
        cap: &CustodySettlementCapability,
        reserve: Object<FungibleStore>,
        recipient: &signer,
        amount: u64,
    ) {
        reflection_token::move_custody_to_wallet(cap, reserve, recipient, amount)
    }

    public fun pay_lp_claim(
        cap: &CustodySettlementCapability,
        claimant: &signer,
        epoch: u64,
        lp_reward_vault: Object<FungibleStore>,
        amount: u64,
    ) {
        reflection_token::payout_lp_reward(cap, claimant, epoch, lp_reward_vault, amount)
    }

    public fun pay_lp_claim_to(
        cap: &CustodySettlementCapability,
        recipient: address,
        epoch: u64,
        lp_reward_vault: Object<FungibleStore>,
        amount: u64,
    ) {
        reflection_token::payout_lp_reward_to(cap, recipient, epoch, lp_reward_vault, amount)
    }
}
