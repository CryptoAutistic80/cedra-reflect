# v0.2 review boundary

Cedra Reflect v0.2 Testnet has one operator and no external reviewer. The
required Testnet review is therefore an internal separation-of-concerns review,
not independent human assurance.

Before publication, record three passes against the same exact source:

1. Contract/security pass: public ABI, lifecycle, capability isolation,
   authority removal, store binding, rollback and close liveness.
2. Accounting pass: wallet/custody/LP indexes, corrections, rounding, supply,
   vault backing, historical entitlement and exact final reconciliation.
3. Model/release parity pass: Move/Python/TypeScript agreement, generated
   witnesses, artifact bytes, five operation surfaces and signer order.

Each pass must list scope, commit/tree, commands, findings and disposition.
Codex agents may provide separate specialist passes, but those remain
author-side automated review and must not be described as an independent human
audit.

No external reviewer is a Testnet blocker. External security review is required
before mainnet deployment or turning this one-token reference into a production
factory.

The single detached Testnet operator signature is execution authorization over
an exact simulated candidate. It does not convert the author-side passes above
into an independent review.
