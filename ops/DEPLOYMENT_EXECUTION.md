# Operator-run Cedra Testnet execution

> **TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE**

This is a human-operated release runbook, not deployment automation. The
repository may compile, build transaction identities, simulate, validate, and
collect read-only evidence. It must not load private keys, sign Cedra
transactions, submit transactions, fund accounts, or silently rebuild an
approved transaction.

No release transaction for this deployment has been accepted as finalized
Testnet evidence. The five public profiles below exist outside the repository,
but their account existence, funding, key control, and on-chain status have not
been established by release evidence. The separate hook-probe record is
compatibility evidence, not proof of this release.

The release-tooling re-audit currently reports GO locally. Approval-grade
candidate, approval, and finalized-evidence paths nevertheless require a fresh
exact-commit release root owned by a different trusted identity and read-only
to the dedicated release euid, an exact executable closure, a real externally
signed SDK-review attestation and trust anchor, and two independent approvals
for every proposed transaction.

## Fixed Testnet roles

All five addresses must remain distinct. The profile configuration lives under
the explicit configuration parent `/home/james`; the repository working
directory deliberately has no usable Cedra profiles.

| Role | Cedra Testnet profile | Public candidate address | Release responsibility |
|---|---|---|---|
| Core publisher | `cedra-reflect-core-publisher` | `0x14110b05c8b667577e2ffefab66b01fa2f48bca8091f51af33b1a6c6762773db` | Publish `reflection-core`; primary signer for bootstrap transactions |
| Asset publisher | `cedra-reflect-assets-publisher` | `0x445292601c73f8542d576908c67e8a28a861575bdc8841e02753651f56492f8f` | Publish `test-assets`; co-sign asset and pool bootstrap |
| AMM publisher | `cedra-reflect-amm-publisher` | `0x47f0e7670e63258035b0f71fea8a80d9e24ed118d5262a47a97a555bc6506721` | Publish `test-amm`; co-sign pool bootstrap and seed |
| Operations | `cedra-reflect-operations` | `0xb736430fcbb1b1f3d7dac953dcc11fa6cb033efcbc52a36816f1be32ed28ffa3` | Receive routine controls in the atomic handoff |
| Bootstrap LP | `cedra-reflect-bootstrap-lp` | `0x0b1cd21450f8b849a1235494c1646e3d338a332d286ba6aef79030d92e7b1f82` | Authenticated beneficiary of the initial LP position |

`ops/testnet-roles.candidate.json` is the authoritative public-role candidate.
Its addresses are not funding proof, chain proof, or release approval.

## 1. Capture a public-only profile preflight

Run the profile capture with an explicit configuration parent. Do not run a
bare `cedra` profile command from the repository and do not copy
`.cedra/config.yaml` into the repository.

```bash
bash scripts/capture_public_profile_evidence.sh \
  ops/testnet-roles.candidate.json \
  /home/james \
  ops/local/public-profile-preflight
```

The script executes only `cedra config show-profiles --profile <exact-name>`
from `/home/james`. It requires Testnet, the exact candidate address, the exact
Testnet REST and faucet URLs, and secure `0700`/`0600` configuration
permissions. It retains only an allowlisted public view. It does not read,
hash, or copy private-key values and performs no network mutation. Its OpenSSL
validator derives each legacy Ed25519 authentication-key address as
`sha3-256(public_key_bytes || 0x00)` and requires it to equal the recorded
account. The evidence records that method and tool explicitly. The keyless
assembler later revalidates every binding independently with the reviewed
`@cedra-labs/ts-sdk` `2.2.8`; a format-valid but mismatched public key is
rejected before simulation.

Stop if any profile, address, URL, permission, or network differs. A profile
preflight still does not prove the account is funded or exists on chain.

## 2. Freeze and compile the exact release

From the exact reviewed clean commit:

```bash
make clean-release-verification \
  OUTPUT_DIRECTORY=ops/local/verification-candidate

make exact-address-artifacts-from-candidate \
  OUTPUT_DIRECTORY=ops/local/exact-address-candidate \
  RELEASE_VERIFICATION_RECORD=ops/local/verification-candidate/verification-record.json
```

The exact-address step binds all five roles, copies the three source packages
into an isolated build tree, compiles their immutable bytecode, constructs the
exact package-publish payloads, and compares those payload bytes and module
ordering with the Cedra CLI payload builder. Review
`exact-address-artifacts.json`, each package's canonical publish payload, its
Cedra CLI oracle payload, `compiled-package-files.sha256`, and
`review-bundle-files.sha256`.

This output is keyless and local. A passing bundle is eligible only for human
review; it is not a simulation, approval, signature, submission, transaction
hash, or live package proof. Any source, commit, role, CLI, framework, payload,
or digest change invalidates the bundle and all downstream candidates.

Complete an independent human source/bytecode review of this exact bundle and
resolve every critical or high finding before account activation, gas funding,
candidate approval, or publication.

## 3. Establish accounts, control, and gas externally

Only after the clean exact-address bundle and independent human review pass may
the authorized external operator perform the separately approved account-setup
ceremony. The repository must not fund accounts. Preserve evidence that:

- all five exact role accounts exist on Cedra Testnet;
- the operator controls each corresponding key without exposing private-key
  material; and
- every role that will be a primary sender has sufficient Testnet CED for its
  approved maximum fees. The primary senders in the nine-operation release are
  core, assets, and AMM; operations and bootstrap LP sign only as secondaries.

Record every account-activation or gas-funding transaction, finalized ledger
version, and post-funding balance separately. These setup actions are not any of
the nine contract-release operations, do not prove the packages are deployed,
and do not authorize publication. After setup, read the exact current sequence
number for the next primary sender rather than assuming it is zero.

## 4. Build and simulate exact transaction candidates

The release consists of these nine state-changing transactions, in order:

| Operation key | Move action | Primary signer | Ordered secondary signers | Payload values after signer parameters |
|---|---|---|---|---|
| `core_publish` | publish exact `reflection-core` payload | core | none | exact metadata and ordered module bytes |
| `core_initialize` | `reflection_core::reflection_token::initialize` | core | none | none |
| `assets_publish` | publish exact `test-assets` payload | assets | none | exact metadata and ordered module bytes |
| `amm_publish` | publish exact `test-amm` payload | AMM | none | exact metadata and ordered module bytes |
| `faucet_initialize` | `test_assets::test_faucet::initialize(core, assets)` | core | assets | none |
| `amm_tusd_claim` | `test_assets::test_faucet::claim_tusd` | AMM | none | none; claimant is the authenticated primary signer |
| `pool_initialize` | `test_amm::pool::initialize(core, assets, amm)` | core | assets, AMM | none |
| `atomic_operational_handoff` | `test_amm::pool::set_all_operational_admin(core, assets, amm, operations)` | core | assets, AMM, operations | none |
| `pool_seed` | `test_amm::pool::seed_liquidity(core, amm, beneficiary, rfl, usd, min_lp)` | core | AMM, bootstrap LP beneficiary | `rfl`, `usd`, `min_lp` as positive integers |

The three publish actions are listed separately but use the same exact-payload
evidence model. Core initialization must follow the finalized core publish.
Faucet and pool initialization require their package dependencies to be
finalized. The AMM publisher must claim the faucet tUSD after faucet
initialization and before seed, because seed withdraws the approved tUSD amount
from that authenticated AMM account. The atomic handoff is the only
initial-release authority path;
individual setters are recovery-only and are not part of this release.
Seed only after the tUSD claim, initialization, and atomic handoff have
finalized. Seed/reseed atomically register the authenticated bootstrap-LP
beneficiary before validating and minting its initial LP position; no separate
unauthenticated beneficiary registration is accepted.
The named-address prefixes in the table resolve to the exact publisher address
in the candidate's on-chain function ID.

For each operation, create a strict request from
`ops/evidence/transaction-build-request.template.json` in a private location
outside the final output directory. Bind the clean exact-artifact and public-
profile evidence file digests, application commit, all five addresses and
public keys, exact current sender sequence number, positive gas price, maximum
gas, absolute future expiry, and explicit approval ceilings. `seed_amounts`
must be `null` except for `pool_seed`, where all three values are positive.

Candidate construction is blocked until an independent human signs the exact
SDK-review attestation under OpenSSH namespace
`cedra-reflect-sdk-review-v1`. The repository template is not evidence. Keep
the signed attestation and its trust anchor external, and set the explicit
runtime and review inputs for every candidate/approval/final validation.
First have a trusted administrator prepare a fresh standalone exact-commit
clone, not a linked worktree or external Git directory, at a
canonical non-symlink path. The complete checkout, reviewed Node binary, and
already-emitted closure-matching JavaScript must be root-owned and not writable
by the release euid, group, others, or an ACL. Run the ceremony under a
dedicated unprivileged uid in a dedicated container/VM with no unrelated
same-uid process. This human isolation gate is not something a repository test
can attest:

```bash
export RELEASE_NODE_RUNTIME="$PWD/ops/local/reviewed-runtime/node"
export RELEASE_EMITTED_JS_DIRECTORY="$PWD/ops/local/reviewed-emitted-js"
export RELEASE_OUTPUT_ROOT=/ABSOLUTE/PRIVATE/RELEASE-OUTPUT
export SDK_REVIEW_ATTESTATION=/ABSOLUTE/EXTERNAL/PATH/sdk-review-attestation.json
export SDK_REVIEW_SIGNATURE=/ABSOLUTE/EXTERNAL/PATH/sdk-review-attestation.json.sig
export SDK_REVIEW_TRUSTED_SIGNERS=/ABSOLUTE/EXTERNAL/PATH/sdk-review.allowed_signers
```

There is no `NODE_BIN`, `PATH`, or mutable-developer-checkout fallback. A
shell-only preflight verifies the complete Node/runtime/compiler/dependency/SDK
closure plus the fixed root-owned Python runtime and kernel no-replace
publication helper. Production does not compile: the externally prepared
emitted tree inside the immutable release root must match the reviewed closure
manifest before its entrypoint executes.

Run every executable production entrypoint below directly as `./scripts/...`.
Its fixed `/usr/bin/bash -p` interpreter ignores `BASH_ENV` and exported shell
functions before script line 1. Do not substitute ambient `bash script`.

Run the keyless assembler with an output path that does not already exist:

```bash
make assemble-testnet-candidate \
  EXACT_ADDRESS_ARTIFACTS=ops/local/exact-address-candidate/exact-address-artifacts.json \
  PUBLIC_PROFILE_EVIDENCE=ops/local/public-profile-preflight/public-profile-evidence.json \
  BUILD_REQUEST=ops/local/requests/core-publish.json \
  OUTPUT_DIRECTORY="$RELEASE_OUTPUT_ROOT/core-publish" \
  RELEASE_NODE_RUNTIME="$RELEASE_NODE_RUNTIME" \
  RELEASE_EMITTED_JS_DIRECTORY="$RELEASE_EMITTED_JS_DIRECTORY" \
  SDK_REVIEW_ATTESTATION="$SDK_REVIEW_ATTESTATION" \
  SDK_REVIEW_SIGNATURE="$SDK_REVIEW_SIGNATURE" \
  SDK_REVIEW_TRUSTED_SIGNERS="$SDK_REVIEW_TRUSTED_SIGNERS"
```

The assembler accepts only a clean, locally review-eligible exact-address v3
bundle and validated public-profile evidence. It checks the declared and
actually loaded `@cedra-labs/ts-sdk` version are exactly `2.2.8`, uses a local
checked-in ABI for the selected one of nine operations, builds with explicit
transaction controls and default CED gas, and simulates the exact same object
with the bound public keys. The returned simulation authenticators must contain
those exact keys in signer order and only the SDK's all-zero simulation
signatures. No fee payer is allowed.

Before making the output visible, the assembler runs the existing semantic and
BCS validator in a private staging directory. It then atomically exposes a
mode-`0700` directory containing only mode-`0600`
`transaction-candidate.json` and `simulation-response.json`. It never reads a
private key, signs, submits, estimates transaction fields, or fetches a remote
ABI. The resulting candidate binds:

- the exact-address and public-profile evidence digests, all five role
  addresses, and all five public keys;
- Cedra Testnet API `https://testnet.cedra.dev/v1` and chain ID `2`;
- transaction type, sender, ordered secondary signers, sequence number,
  expiration, maximum gas, gas-unit price, and gas-asset type;
- exact payload arguments and, for a publish, the reviewed package payload;
- raw transaction BCS, unsigned transaction-wrapper BCS, signing message, and
  every SHA-256;
- a successful simulation wrapper produced from that same identity; and
- worst-case as well as observed gas ceilings.

The assembler performs this validation itself; an operator may repeat it before
anyone approves the candidate:

```bash
./scripts/validate_transaction_candidate.sh \
  "$RELEASE_OUTPUT_ROOT/core-publish/transaction-candidate.json" \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json
```

The repository now has an executable keyless candidate-production workflow for
all nine operations. It is deliberately build/simulate-only and does not close
the external signing/submission gate. No real candidate exists merely because
the assembler exists: the operator must first supply a clean review-eligible
exact bundle, a matching validated profile record, an operation request with
fresh sequence/state, and a successful Testnet simulation. Build later
candidates only after the predecessor is finalized and the next exact sequence
and required state are known.

## 5. Obtain two detached release approvals

Render the canonical approval statement only after the candidate passes both
the semantic and BCS validators:

```bash
./scripts/render_release_approval_statement.sh \
  "$RELEASE_OUTPUT_ROOT/core-publish/transaction-candidate.json" \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json \
  "$RELEASE_OUTPUT_ROOT/core-publish/approval-statement.json"
```

The absolute statement path must not exist. Its final parent must be owned by
the release euid with exact mode `0700`, and every ancestor must be a real
directory. The renderer publishes from an unnamed held file descriptor with a
kernel no-replace link; it never redirects into an attacker-selected path.

Two independent human approvers sign that exact statement outside the
repository with OpenSSH namespace `cedra-reflect-testnet-release-v1`. Populate
`approval-envelope.json` from
`ops/evidence/transaction-approval-envelope.template.json`. It must bind the
candidate, statement, trusted external allowed-signers file, two distinct
identities, two distinct verified key fingerprints, and both detached
signature digests.

Verify the envelope against the operator-supplied trust anchor:

```bash
./scripts/verify_release_approvals.sh \
  "$RELEASE_OUTPUT_ROOT/core-publish/approval-envelope.json" \
  /ABSOLUTE/EXTERNAL/PATH/cedra-reflect.allowed_signers \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json
```

These OpenSSH signatures approve the exact release candidate. They are not
Cedra account signatures and cannot submit a transaction.

## 6. External Cedra signing and submission ceremony

State-changing execution is an external, operator-owned gate. The ceremony
tool must:

1. accept the already validated candidate and its exact unsigned transaction-
   wrapper BCS/signing identity;
2. display Testnet, chain ID, sender, ordered secondary signers, sequence,
   expiry, gas fields, function, and arguments to every required signer;
3. collect the required Cedra account signatures without exposing keys;
4. populate only the authenticator fields, then decode the signed envelope and
   prove its raw-transaction digest, unsigned-wrapper digest, signing-message
   digest, signer order, and absent fee payer exactly match the candidate; and
5. submit once, return the transaction hash, and never rebuild the transaction.

`transaction_identity.transactionBcsHex` is the approved **unsigned** Cedra
transaction wrapper. A correctly signed envelope adds authenticators and is
therefore not byte-for-byte equal to that field. Equality is required after
re-extracting the raw transaction, unsigned wrapper, and signing message; the
only permitted addition is the required authenticator material.

The repository does not currently contain that signing/submission tool. Do not
substitute a direct CLI package publish, a direct Move-run command, or an SDK
rebuild after approval. If the ceremony cannot populate authenticators and
submit while preserving the approved transaction identity, stop the release.

The required Cedra account signers are exactly those in the operation table.
For the preferred authority transition, core is primary and assets, AMM, then
operations are ordered secondaries. For the initial seed, core is primary and
AMM then the bootstrap LP beneficiary are ordered secondaries; the three
amounts are the only payload arguments.

## 7. Collect finalized evidence read-only

Only after the external ceremony returns a finalized Testnet transaction hash,
run the collector:

```bash
./scripts/collect_finalized_transaction_evidence.sh \
  "$RELEASE_OUTPUT_ROOT/core-publish/transaction-candidate.json" \
  "$RELEASE_OUTPUT_ROOT/core-publish/approval-envelope.json" \
  /ABSOLUTE/EXTERNAL/PATH/cedra-reflect.allowed_signers \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json \
  0xRECORD_64_HEX_TRANSACTION_HASH \
  "$RELEASE_OUTPUT_ROOT/core-publish/finalized"
```

The collector first revalidates the exact candidate and both detached
approvals. The supplied envelope must be the exact
`approval-envelope.json` beside that exact candidate; no directory or basename
search is performed. The absent output must have an already-existing
current-euid-owned parent with exact mode `0700`. It then performs only two
Testnet HTTPS GET requests: the transaction
by hash and ledger info. It checks the finalized response against the
REST-observable approved fields: signature type with no fee payer, payload,
signer order, chain, sequence, expiry, gas ceilings, and exact publish binding.
The REST response does not expose raw transaction/wrapper BCS, signing-message
bytes, or the fungible gas-asset field; those remain retained, locally decoded
candidate-and-approval bindings rather than finalized observations. The
collector cannot sign or submit and must never be credited as the actor that
changed chain state.

Repeat the candidate, approval, external signing, submission, and read-only
collection cycle for every operation. Do not construct later candidates until
the prerequisite transaction is finalized and its required sequence/on-chain
state is known.

## 8. Release completion boundary

Before public beta, the finalized manifest must cross-bind the public profile
preflight, clean verification, exact-address artifacts, every finalized
transaction record, initialization objects/events, atomic handoff, seed,
same-ledger reconciliation, hook decision, gas results, and independent review.
`ops/PILOT_GATES.md` remains the quantitative exit checklist.

Validate it against the external trust anchor:

```bash
./scripts/validate_release_manifest.sh \
  ops/local/release-manifest.testnet-v0.1.0.json \
  /ABSOLUTE/EXTERNAL/PATH/cedra-reflect.allowed_signers
```

Local tests, local profile existence, account/gas setup, a valid exact artifact
bundle, successful simulation, and detached approvals are all necessary but
none is live release proof. Until every state-changing release transaction is
externally signed/submitted and read back from Cedra Testnet, deployment status
remains open.
