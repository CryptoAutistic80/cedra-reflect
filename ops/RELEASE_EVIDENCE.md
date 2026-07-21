# Release evidence and provenance

This workflow keeps local construction, human approval, chain execution, and
read-only observation separate. No generated local record authorizes a Cedra
Testnet mutation, and no read-only collector can prove it submitted one.

There is currently no finalized release transaction evidence for this
deployment. The public role candidates and local tooling are preparation only.
The isolated hook-probe record proves a narrow compatibility experiment, not
that these packages or five release accounts were deployed.

The five profiles and public addresses exist and
`ops/testnet-roles.candidate.json` validates locally. That proves neither
funding, on-chain account existence, private-key control, release approval, nor
publication. Independent local contract, SDK/indexer, and release-tooling
re-audits report GO, but approval-grade execution still requires an externally
isolated different-owner read-only exact-commit release root, exact executable
closure, real signed SDK-review attestation and external trust anchor, and two
independent approvals for every transaction.

## Evidence layers

| Record | What it proves | What it does not prove |
|---|---|---|
| public-role candidate | five intended, distinct profile names and public addresses were recorded | profile configuration, funding, chain existence, key control, or approval |
| public-profile preflight | public CLI output from the explicit external configuration parent matches all five Testnet candidates | private-key possession, account funding, transaction authority, or chain state |
| clean verification record | deterministic local checks passed at one clean Git commit with one identified Cedra CLI | exact publisher payloads, simulation, approval, or live state |
| exact-address artifact bundle | exact immutable package metadata/module bytes and canonical publish payloads are content-bound to the five roles and checked against the CLI payload builder | a full transaction was built, simulated, signed, submitted, or finalized |
| transaction candidate and simulation | one complete Cedra transaction identity, BCS, payload, signer order, gas limits, and simulation are mutually consistent | human approval, Cedra account signatures, submission, or finalization |
| detached approval envelope | two distinct trusted OpenSSH keys approved the canonical statement for that exact candidate | Cedra account signatures or submission |
| finalized transaction evidence | read-only Testnet responses match the REST-observable approved fields, forbid fee-payer signature types, and retain the separately validated BCS candidate | that REST returned the candidate raw BCS, signing message, or fungible gas-asset field; or that the collector performed the state change |
| finalized release manifest | all required release records and live outcomes are cross-bound as one release | truth of an unverified external file or a substitute for independent same-ledger review |

Every release record has an explicit `evidence_scope`. Treat a scope mismatch,
placeholder, unbound file, digest mismatch, signer-order mismatch, or changed
transaction byte as a hard failure.

## 1. Public roles and profile evidence

`ops/testnet-roles.candidate.json` contains these five roles:

- `core_publisher` — `cedra-reflect-core-publisher`;
- `assets_publisher` — `cedra-reflect-assets-publisher`;
- `amm_publisher` — `cedra-reflect-amm-publisher`;
- `operations` — `cedra-reflect-operations`; and
- `bootstrap_lp` — `cedra-reflect-bootstrap-lp`.

Validate the candidate:

```bash
make validate-public-role-candidate
```

The Cedra profiles live under `/home/james/.cedra`, not under the repository.
Capture the allowlisted public fields by giving the script the explicit
configuration parent:

```bash
bash scripts/capture_public_profile_evidence.sh \
  ops/testnet-roles.candidate.json \
  /home/james \
  ops/local/public-profile-preflight
```

The script runs only `cedra config show-profiles --profile <exact-name>` from
that parent. It requires network `Testnet`, the exact public address, REST URL
`https://testnet.cedra.dev`, faucet URL
`https://faucet-api.cedra.dev`, and configuration modes `0700`/`0600`. Its
output states that private-key values were not read and that no network,
funding, signing, or submission action occurred. Offline, the validator
independently recomputes Cedra's legacy Ed25519 authentication key as
`sha3-256(public_key_bytes || 0x00)` using `OpenSSL dgst -sha3-256`; every
derived address must exactly match its profile account. The evidence records
that method and tool rather than attributing this check to the SDK. This profile
check starts no Node.js process.

Do not treat `has_private_key: true` in public CLI output as cryptographic proof
that an operator demonstrated control. Do not copy or hash the external config.

## 2. Clean local verification

After the implementation is committed and the worktree is clean:

```bash
export RELEASE_NODE_RUNTIME=/ABSOLUTE/REVIEWED/PATH/node
make clean-release-verification \
  OUTPUT_DIRECTORY=ops/local/verification-candidate
```

The capture binds:

- application commit and Git tree;
- release-source SHA-256;
- Cedra Framework revision;
- Cedra CLI version, resolved path, and binary SHA-256;
- complete verification log and SHA-256;
- one-million-applied-operation model-gate report and SHA-256; and
- structured local release-build output and SHA-256.

This remains local evidence. It records that exact Testnet transaction
construction, signatures, submission, and finalized state were absent.

## 3. Exact-address package and payload evidence

Bind the clean record and all five public roles:

```bash
make exact-address-artifacts-from-candidate \
  OUTPUT_DIRECTORY=ops/local/exact-address-candidate \
  RELEASE_VERIFICATION_RECORD=ops/local/verification-candidate/verification-record.json
```

The build runs against a complete isolated source copy so the CLI cannot write
release output into tracked package directories. For each package it preserves:

- exact sparse package metadata and ordered module bytecode;
- a canonical compact publish payload whose metadata/module bytes are copied
  directly from those files;
- the Cedra CLI native publish-payload result used as an independent byte/order
  oracle;
- `compiled-package-files.sha256`, covering only compiled package files; and
- `review-bundle-files.sha256`, covering the compiled files and both payload
  representations.

`exact-address-artifacts.json` binds the five roles, three immutable package
sources, CLI and framework identity, commit, custom repository source digests,
both manifest digests, payload digests, argument byte sizes, and CLI
payload-size result. It separately decodes each framework
`PackageMetadata.source_digest`, initial `upgrade_number: "0"`, and immutable
policy number `2` from `package-metadata.bcs`. The custom
`release_source_sha256`/`package_source_sha256` algorithms are not assumed to
equal that embedded framework digest. Finalized publish evidence must find the
same embedded digest, upgrade number, and policy in the sender's on-chain
`0x1::code::PackageRegistry`. The validator also requires the canonical and CLI
payloads to carry identical metadata and module bytes in identical order.

The package payload-size check is not a claim about the size of a complete
signed transaction. Full raw-transaction and unsigned transaction-wrapper BCS
bytes appear only in the downstream transaction candidate. A clean exact-
address bundle can be eligible for human review, but `approval_eligible`
remains false.

## 4. Exact transaction candidate and simulation

### Mandatory isolated release root

Approval-grade candidate, approval, and finalized-evidence commands deliberately
fail in an ordinary developer checkout. Before any such command, a trusted
administrator must prepare a **fresh standalone exact-commit clone** (not a
linked worktree or external Git directory) at a canonical
non-symlink path (for example `/srv/cedra-reflect-release/COMMIT`), put the
reviewed Node binary and already-emitted closure-matching JavaScript inside that
root, recursively make the complete root `root:root`, and remove every
group/other write bit. The invoking release euid must have no write access,
including through ACLs. Every tracked working byte and executable mode, every
index flag, `HEAD`, and the Git tree are rechecked against the exact commit.

Run the ceremony as a dedicated unprivileged release account in a dedicated
container or VM with no unrelated process using that uid. The filesystem check
cannot prove process/account isolation, so that remains a mandatory recorded
human gate. The release account writes only to separate, non-existent output
paths whose final parent it owns privately. Do not fabricate an isolation
record or weaken the check for local tests; local tests assert that a normal
current-uid checkout fails closed.

There is no candidate-time compiler. `RELEASE_NODE_RUNTIME` and
`RELEASE_EMITTED_JS_DIRECTORY` must both resolve inside the immutable release
root. The emitted tree is prepared before the root is frozen and must exactly
match the checked-in executable-closure digest. Put both under the ignored
`ops/local/` namespace so the exact tracked checkout remains clean; the closure
preflight authenticates their bytes independently of Git.

Create one strict build request per operation from
`ops/evidence/transaction-build-request.template.json`. Keep that input outside
the final candidate output directory. The supported initial release operation
keys are:

- `core_publish`, `assets_publish`, and `amm_publish`;
- `core_initialize`, `faucet_initialize`, and `pool_initialize`;
- `amm_tusd_claim`;
- `atomic_operational_handoff`; and
- `pool_seed`.

After binding the clean exact-address artifact, validated public-profile
evidence, current sequence, absolute future expiry, explicit gas controls and
ceilings, run:

First satisfy the independent SDK-review gate. A human reviewer outside the
implementation team must complete
`ops/evidence/sdk-review-attestation.template.json`, bind an externally
controlled allowed-signers file, and sign the exact JSON bytes with OpenSSH
namespace `cedra-reflect-sdk-review-v1`. The template, checked-in SDK pin, or a
locally generated test signature is not an approval. Keep the signed
attestation, detached signature, review report, and trust anchor outside the
repository, then export all four explicit release inputs:

```bash
export RELEASE_NODE_RUNTIME="$PWD/ops/local/reviewed-runtime/node"
export RELEASE_EMITTED_JS_DIRECTORY="$PWD/ops/local/reviewed-emitted-js"
export RELEASE_OUTPUT_ROOT=/ABSOLUTE/PRIVATE/RELEASE-OUTPUT
export SDK_REVIEW_ATTESTATION=/ABSOLUTE/EXTERNAL/PATH/sdk-review-attestation.json
export SDK_REVIEW_SIGNATURE=/ABSOLUTE/EXTERNAL/PATH/sdk-review-attestation.json.sig
export SDK_REVIEW_TRUSTED_SIGNERS=/ABSOLUTE/EXTERNAL/PATH/sdk-review.allowed_signers
```

There is deliberately no `NODE_BIN` or `PATH` fallback. The signed statement
must approve the exact SDK pin/tree and its trust-anchor digest; every
candidate, approval, and finalized-evidence validation repeats that check.
Run every executable production entrypoint below directly as `./scripts/...`.
Its fixed `/usr/bin/bash -p` interpreter ignores `BASH_ENV` and exported shell
functions before script line 1. Do not replace the documented direct execution
with ambient `bash script`.

```bash
make assemble-testnet-candidate \
  EXACT_ADDRESS_ARTIFACTS=ops/local/exact-address-candidate/exact-address-artifacts.json \
  PUBLIC_PROFILE_EVIDENCE=ops/local/public-profile-preflight/public-profile-evidence.json \
  BUILD_REQUEST=ops/local/requests/OPERATION.json \
  OUTPUT_DIRECTORY="$RELEASE_OUTPUT_ROOT/OPERATION" \
  RELEASE_NODE_RUNTIME="$RELEASE_NODE_RUNTIME" \
  RELEASE_EMITTED_JS_DIRECTORY="$RELEASE_EMITTED_JS_DIRECTORY" \
  SDK_REVIEW_ATTESTATION="$SDK_REVIEW_ATTESTATION" \
  SDK_REVIEW_SIGNATURE="$SDK_REVIEW_SIGNATURE" \
  SDK_REVIEW_TRUSTED_SIGNERS="$SDK_REVIEW_TRUSTED_SIGNERS"
```

The output directory must not already exist. The assembler uses only explicit
checked-in ABIs, pins both the declared and loaded Cedra SDK to `2.2.8`, builds
with default CED gas and no fee payer, simulates with public keys only, validates
the candidate, and atomically exposes exactly the candidate and simulation
files with private permissions. It never reads a private key, signs, submits,
estimates transaction controls, or fetches a remote ABI.

Before building, the assembler independently revalidates each captured
public-key/address binding with the reviewed SDK. The candidate keeps the
OpenSSL evidence fields as `derivation_method` and `derivation_tool` and records
the separate check as `assembler_revalidation_sdk_package` and
`assembler_revalidation_sdk_version`.

It additionally requires a completely clean current Git index and worktree,
including no untracked files, and requires current `HEAD` and its tree to equal
the commit/tree in the fully validated exact-address v3 bundle. The candidate
records the reviewed `package-lock.json` digest and SDK lock integrity plus the
digests of the actual loaded SDK package manifest, entrypoint, and entire
installed SDK tree. It also records the signed SDK-review attestation,
signature, external trust-anchor digests, signature namespace, and authenticated
reviewer identity. Approval-time BCS validation independently recomputes the
same bytes and bindings. Output publication is a Linux kernel
`renameat2(RENAME_NOREPLACE)` operation with no fallback; an existing or
concurrently created destination is never replaced.

Before the first Node process, a shell-only preflight authenticates the exact
in-root Node runtime, fixed root-owned Python runtime, package lock, complete
`node_modules` inventory (including all transitive loaded packages), TypeScript
compiler, Cedra SDK tree, release JavaScript sources, and the kernel no-replace
publication helper against
`ops/evidence/release-executable-closure.json`. The production command does not
compile. It executes only the externally prepared, root-owned, closure-matching
emitted tree inside the immutable release root. Shared or freshly mutable
`dist/` output is never a release input. The candidate build environment records the
SHA-256 of that exact checked-in closure manifest, and approval-time validation
recomputes it. Regenerate the closure only after all source
changes settle, review the manifest diff, and verify it deterministically:

```bash
bash scripts/render_release_executable_closure.sh \
  "$PWD" "$RELEASE_NODE_RUNTIME" > /tmp/release-executable-closure.json
diff -u ops/evidence/release-executable-closure.json \
  /tmp/release-executable-closure.json
bash scripts/check_release_executable_closure.sh \
  "$PWD" "$RELEASE_NODE_RUNTIME"
```

The installed-SDK comparison is not self-attested. Its checked-in trust anchor
is `ops/evidence/reviewed-cedra-sdk-2.2.8.json`, whose SHA-256 is
`adeca264fd6c99cdcf74bc4d8381ecd1b45218ef3ba054da48d84aed86834299`.
That record binds the exact lockfile SHA-512 integrity, registry tarball
SHA-256 `c75c4157ed3607e5860ec68e830a83c1c8691e658166fa1ebcf1cb934a381321`,
and installed-tree SHA-256
`0259184429bdc85d4d78e1a6bf105677e8cea7707bec5dcdbba269dea36e2765`.
Independently verify a downloaded tarball without extracting archive paths:

```bash
python3 scripts/verify_reviewed_sdk_pin.py \
  ops/evidence/reviewed-cedra-sdk-2.2.8.json \
  package-lock.json \
  /ABSOLUTE/PATH/cedra-labs-ts-sdk-2.2.8.tgz
```

Their authenticated identities are fixed:

| Operation | Primary | Ordered secondaries | Function/payload |
|---|---|---|---|
| `core_publish` | core | none | exact `reflection-core` publish payload |
| `assets_publish` | assets | none | exact `test-assets` publish payload |
| `amm_publish` | AMM | none | exact `test-amm` publish payload |
| `core_initialize` | core | none | `reflection_core::reflection_token::initialize`; no payload arguments |
| `faucet_initialize` | core | assets | `test_assets::test_faucet::initialize`; no payload arguments |
| `amm_tusd_claim` | AMM | none | `test_assets::test_faucet::claim_tusd`; no payload arguments |
| `pool_initialize` | core | assets, AMM | `test_amm::pool::initialize`; no payload arguments |
| `atomic_operational_handoff` | core | assets, AMM, operations | `test_amm::pool::set_all_operational_admin`; no payload arguments |
| `pool_seed` | core | AMM, bootstrap LP | `test_amm::pool::seed_liquidity`; `rfl`, `usd`, `min_lp` only |

Named-address prefixes resolve to the exact publisher addresses bound in the
candidate. A signer parameter is represented by the primary/ordered-secondary
transaction identity and must never be duplicated as an unauthenticated JSON
payload argument.

Each candidate binds the public-profile evidence and all five role addresses
and public keys. It also binds the full transaction identity: single- or multi-
agent type, primary sender, ordered secondary signers, no hidden fee payer,
sequence number, maximum gas, gas-unit price, expiration, chain ID `2`, default
CED gas asset, raw transaction BCS, unsigned transaction-wrapper BCS, signing
message, and their digests. Its semantic digest also binds the exact function
and arguments.

For publish operations, `publish_binding` must point to the corresponding
package payload and compiled-file manifest in the exact-address artifact
bundle. Initialization, the AMM tUSD claim, and atomic handoff have no payload
arguments. Pool seed
has exactly `rfl`, `usd`, and `min_lp` as positive integer payload arguments.
The bootstrap LP beneficiary is an ordered Cedra signer, not an unauthenticated
address argument. The claim funds the AMM signer from which seed withdraws
tUSD; seed atomically registers the authenticated bootstrap-LP beneficiary.

The simulation file is a wrapper containing the same complete transaction
identity and raw Cedra simulation responses. The validator requires successful
execution, exact sender/signers/payload/sequence/expiry/gas/chain equality,
public keys matching the bound profiles in exact signer order, all-zero
64-byte SDK simulation signatures, and these approved ceilings:

- `approved_max_gas_amount` exactly equals the transaction maximum and also
  bounds simulated/final gas used;
- `approved_max_gas_unit_price` exactly equals the transaction unit price;
  and
- `approved_max_total_fee_base_units` exactly equals
  `max_gas_amount * gas_unit_price`, not merely the observed fee.

Validate before rendering an approval statement:

```bash
./scripts/validate_transaction_candidate.sh \
  "$RELEASE_OUTPUT_ROOT/OPERATION/transaction-candidate.json" \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json
```

The BCS validator decodes the SDK objects and reconstructs the signing message,
signer order, transaction options, entry function, and arguments. JSON equality
alone is insufficient.

The dedicated keyless assembler now covers all nine operation shapes, including
the three exact package publishes. The protocol SDK and assembler remain
build/simulate-only: they do not sign or submit. No actual candidate exists
until an operator supplies a clean review-eligible exact bundle, matching
validated profile evidence, a fresh request, and receives a successful
validator-accepted simulation. Later operations must wait for finalized
predecessors so their sequence and state inputs are current.

## 5. Canonical two-key approval envelope

Render the canonical statement:

```bash
./scripts/render_release_approval_statement.sh \
  "$RELEASE_OUTPUT_ROOT/OPERATION/transaction-candidate.json" \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json \
  "$RELEASE_OUTPUT_ROOT/OPERATION/approval-statement.json"
```

The statement path must be absolute and absent. Its final parent must be owned
by the release euid with exact mode `0700`, and no ancestor may be a symbolic
link. Publication uses an unnamed file plus kernel no-replace `linkat` from its
held descriptor (`AT_EMPTY_PATH` where permitted, otherwise the exact
`/proc/self/fd` descriptor target), so it never redirects through or replaces
an attacker-created destination pathname.

This statement and envelope approve one exact transaction candidate; they are
not a signed release manifest. The statement content-binds the candidate,
exact artifacts, public-profile evidence, exact role-candidate digest, loaded
build environment, all transaction semantics and BCS identities, simulation,
gas policy, and publish evidence.
Two independent approvers sign the exact statement with standard OpenSSH
detached signatures under namespace
`cedra-reflect-testnet-release-v1`.

Populate `ops/evidence/transaction-approval-envelope.template.json` outside
tracked source. The envelope must include the canonical statement and candidate
digests; the exact-address, public-profile, and exact role-candidate digests;
the SHA-256 of an externally maintained allowed-signers trust anchor; and for
each approval its identity, observed OpenSSH key fingerprint, signature
filename, and signature digest. Both identities and verified fingerprints must
be distinct.

Verify locally:

```bash
./scripts/verify_release_approvals.sh \
  "$RELEASE_OUTPUT_ROOT/OPERATION/approval-envelope.json" \
  /ABSOLUTE/EXTERNAL/PATH/cedra-reflect.allowed_signers \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json
```

The allowed-signers file is an operator-controlled trust anchor. Never accept a
trust anchor supplied only by the envelope being verified. Changing any bound
candidate, statement, signature, identity, fingerprint, or trust anchor fails
closed.

Detached OpenSSH approvals do not satisfy the Move signer parameters. The
separate external Cedra ceremony must collect the exact package-account
signatures and populate only the signed-envelope authenticator fields. Before
submission it must re-extract and match the candidate raw-transaction,
unsigned-wrapper, and signing-message digests, signer order, and absent fee
payer. The complete signed envelope is not byte-identical to the candidate's
unsigned `transactionBcsHex`. This repository contains no signing/submission
API or ceremony tool.

## 6. Finalized transaction evidence is read-only

After an external operator has submitted the exact approved transaction and
provided its hash:

```bash
./scripts/collect_finalized_transaction_evidence.sh \
  "$RELEASE_OUTPUT_ROOT/OPERATION/transaction-candidate.json" \
  "$RELEASE_OUTPUT_ROOT/OPERATION/approval-envelope.json" \
  /ABSOLUTE/EXTERNAL/PATH/cedra-reflect.allowed_signers \
  ops/local/exact-address-candidate/exact-address-artifacts.json \
  ops/local/public-profile-preflight/public-profile-evidence.json \
  0xRECORD_64_HEX_TRANSACTION_HASH \
  "$RELEASE_OUTPUT_ROOT/OPERATION/finalized"
```

The collector revalidates candidate BCS and both detached approvals before it
contacts `https://testnet.cedra.dev/v1`. It performs only:

- `GET /transactions/by_hash/{hash}`; and
- `GET /` for ledger information.

The exact supplied file must be named `approval-envelope.json` and sit beside
the exact supplied `transaction-candidate.json`; the collector never searches
for or substitutes another basename-matching envelope. The absent final output
must have an already-existing current-euid-owned parent with exact mode `0700`.

It requires a successful finalized user transaction and exact equality with
the approved REST-observable sender, signature type, absence of a fee payer,
ordered secondary signers, sequence, expiry, maximum gas, gas-unit price,
payload, and publish bytes. It retains the raw simulation, transaction, ledger,
candidate, approval statement, envelope, and signatures with content digests.
The standard REST user-transaction response does not return raw transaction
BCS, transaction-wrapper BCS, signing-message bytes, or the fungible gas-asset
field. Those remain candidate-and-approval bindings, not finalized REST
observations. The collector never reads a Cedra profile, signs, submits, or
retries a mutation.

`scripts/collect_finalized_transaction_evidence.sh` cannot be run as evidence
until a real transaction hash exists. No such release hash exists yet.

## 7. Final release manifest

Create a finalized manifest only after every required referenced record exists.
It must cross-bind the public-role candidate, public-profile preflight, clean
verification record/log/model report, exact-address bundle, all three publish
records, all initialization records, the atomic four-party handoff, initial
three-party seed, same-ledger reconciliation, hook decision, and independent
review.

Every transaction reference must dereference to a validator-accepted finalized
record whose application commit, deployment ID, five roles, exact artifact
digest, approval envelope, signer fingerprints, transaction identity, payload,
gas policy, REST-observation boundaries, and raw-response digests match the
manifest. Loose names or pasted
transaction hashes are not approval evidence.

Validate the completed manifest with the external allowed-signers trust anchor:

```bash
./scripts/validate_release_manifest.sh \
  ops/local/release-manifest.testnet-v0.1.0.json \
  /ABSOLUTE/EXTERNAL/PATH/cedra-reflect.allowed_signers
```

The trust anchor must be external and operator-controlled, never a file trusted
only because the manifest or an approval envelope points to it. The manifest
validator cryptographically revalidates every transaction approval and every
bound evidence file. The machine-readable schemas are:

- `ops/schemas/transaction-evidence.schema.json`;
- `ops/schemas/transaction-build-request.schema.json`;
- `ops/schemas/approval-envelope.schema.json`;
- `ops/schemas/release-manifest.schema.json`;
- `ops/schemas/sdk-review-attestation.schema.json`; and
- `ops/schemas/release-executable-closure.schema.json`.

Schema acceptance is necessary but does not replace cryptographic approval
verification, BCS decoding, live Testnet response matching, or independent
same-ledger reconciliation.
