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
operations, fresh-deployment snapshot restoration and indexer old-cursor
recovery. It is not satisfied by a superficial code style review.
