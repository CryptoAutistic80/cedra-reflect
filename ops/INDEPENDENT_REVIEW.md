# Independent-review brief

Independent local contract, SDK/indexer-parity, and release-tooling re-audits
currently report GO; the contract re-audit carries no unresolved Critical,
High, Medium, or Low finding. Those engineering reviews are inputs to, not
substitutes for, the external human reviews and signatures defined below.

The public beta requires one independent reviewer who did not author the
reflection core. The review should assess source and generated Move bytecode
for the recorded package digest, run deterministic model vectors, and inspect
the reconciler on a fresh event replay.

Candidate tooling has a separate fail-closed SDK artifact gate. Before any
candidate is built, an independent reviewer must inspect the exact Cedra SDK
tarball/source/runtime tree pinned by
`ops/evidence/reviewed-cedra-sdk-2.2.8.json`, complete the external
`sdk-review-attestation` record, and sign its exact bytes under OpenSSH
namespace `cedra-reflect-sdk-review-v1`. The allowed-signers trust anchor and
review report remain external. The checked-in template and local test fixtures
are deliberately not review evidence.

The reviewer must also confirm the operational isolation boundary: candidate,
approval, and finalized-evidence commands run only from a fresh exact-commit,
root-owned, non-writable release root; the reviewed Node binary and pre-emitted
closure-matching JavaScript reside inside it; and a dedicated unprivileged uid
with no unrelated same-uid process runs in a dedicated container/VM. A normal
developer checkout must fail closed. This process-isolation check is a human
ceremony assertion, not repository-generated evidence.

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
The reviewer must additionally reproduce the atomic four-signer authority
handoff, prove that failed sub-handoffs roll the whole transaction back, verify
that every current and former operations primary store remains excluded, and
confirm that publisher/operations accounts cannot receive LP ownership. Seed
and reseed evidence must authenticate the recorded bootstrap-LP signer rather
than trusting an address argument.
Review `docs/CONTRACT_SECURITY_AUDIT.md` as author-supplied input, independently
reproduce its findings, and record any disagreement rather than treating it as
external assurance.
