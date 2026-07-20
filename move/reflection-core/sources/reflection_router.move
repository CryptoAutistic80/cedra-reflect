/// Optional project transfer adapter. It lives outside reflection_hooks so its
/// call into Cedra's dispatcher does not violate Move's module-lock rule.
module reflection_core::reflection_router {
    use cedra_framework::primary_fungible_store;
    use reflection_core::reflection_events;
    use reflection_core::reflection_token;

    public entry fun transfer(sender: &signer, recipient: address, amount: u64) {
        let sender_address = std::signer::address_of(sender);
        primary_fungible_store::transfer(sender, reflection_token::metadata(), recipient, amount);
        reflection_events::wallet_transfer(sender_address, recipient, amount);
    }
}
