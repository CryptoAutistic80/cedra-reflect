# Independent-review brief

The public beta requires one independent reviewer who did not author the
reflection core. The review should assess source and generated Move bytecode
for the recorded package digest, run deterministic model vectors, and inspect
the reconciler on a fresh event replay.

Required conclusion fields:

```text
reviewer identity and independence statement
repository commit and Move package digests reviewed
framework/CLI/SDK versions
test commands and seeds reproduced
critical/high findings and disposition
whether the observed hook mode matches the Testnet evidence record
whether the release manifest and on-chain addresses match the source reviewed
```

The review must explicitly attempt direct pool calls, unauthorized admin calls,
reward-vault withdrawal/sweep, duplicate claim, zero-value/integer-boundary
operations, clean fresh-deployment reconciliation, and indexer old-cursor
recovery. If a separate snapshot claim distributor is ever proposed, review it
as an independent package. This gate is not satisfied by a superficial code
style review.

The reviewer must also confirm that all three release packages are immutable,
the tRFL mint reference is absent from stored bytecode state, core event
constructors are not externally callable, the indexer rejects same-named events
from unapproved package addresses and unknown schema versions, and initialization
events reconstruct every operational authority, fee/limit, and pause default.
Review `docs/CONTRACT_SECURITY_AUDIT.md` as author-supplied input, independently
reproduce its findings, and record any disagreement rather than treating it as
external assurance.
