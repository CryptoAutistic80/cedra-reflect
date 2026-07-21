# Controlled Cedra Testnet release checklist

> **TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE**

Only named release operators may execute state-changing Testnet actions. CI and
repository scripts may verify, build, simulate exact entry-function candidates
without committing them, and collect read-only evidence. They must never fund
an account, sign, publish, or submit a state-changing transaction.

No release transaction for the current five-role deployment has been observed
on Testnet. Keep every live item below unchecked until its finalized evidence
exists.

## Before transaction approval

- [ ] Validate `ops/testnet-roles.candidate.json` and require five distinct,
  non-zero addresses for core publisher, asset publisher, AMM publisher,
  operations, and bootstrap LP.
- [ ] Confirm the exact profiles are `cedra-reflect-core-publisher`,
  `cedra-reflect-assets-publisher`, `cedra-reflect-amm-publisher`,
  `cedra-reflect-operations`, and `cedra-reflect-bootstrap-lp`.
- [ ] From the explicit configuration parent `/home/james`, run
  `scripts/capture_public_profile_evidence.sh`; never rely on the repository
  working directory for profiles.
- [ ] Require the public profile evidence to show `Testnet`, the exact five
  candidate addresses, `https://testnet.cedra.dev`, and
  `https://faucet-api.cedra.dev`; require the declared OpenSSL SHA3-256
  derivation to bind each public key to its account address, then require the
  keyless assembler to revalidate every binding independently with the reviewed
  SDK 2.2.8. Keep funding and demonstrated key-control proof separate.
- [ ] Confirm the external `.cedra` directory/file modes are exactly
  `0700`/`0600`, and confirm no config or private-key value entered release
  output.
- [ ] Pin and record the Cedra Framework revision, Cedra CLI binary/version,
  SDK version, application commit, and source digest.
- [ ] Run `make clean-release-verification` at the exact reviewed clean commit;
  preserve the verification log, model-gate report, and local build record.
- [x] Preserve the isolated hook-probe result and its claim-backed release
  decision. Do not treat it as evidence that this release was deployed.
- [x] Require all three release packages to use immutable publication policy
  and the one-time claim-backed core initialization path.
- [ ] Run `make exact-address-artifacts-from-candidate` with the clean record
  and review all five role bindings and all three packages.
- [ ] For each package, verify metadata/module bytes, canonical publish payload,
  Cedra CLI oracle payload, module order, `compiled-package-files.sha256`, and
  `review-bundle-files.sha256`.
- [ ] Keep custom repository source digests separate from the framework
  `PackageMetadata.source_digest`. Decode the latter from reviewed metadata and
  require finalized `PackageRegistry` to report the same digest with upgrade
  number `0` and immutable policy number `2`.
- [ ] Treat package payload-size evidence as package-data evidence only; verify
  the complete unsigned transaction-wrapper BCS separately in each candidate.
- [ ] Confirm the release contains no post-seal tRFL mint, vault sweep, forced
  user balance, public user-store transfer, or fee setting over 100 bps.
- [ ] Obtain an independent human source/bytecode review and resolve every high
  or critical finding before any account funding or transaction approval.
- [ ] Only after the clean exact-address bundle and independent human review
  pass, have the external operator separately establish and record on-chain
  account existence and demonstrated key control for all five roles, plus
  sufficient Testnet CED gas for every role that will be a primary sender.
  Public-profile capture is not account, control, or funding evidence.
- [ ] Record account-activation and gas-funding actions as separate authorized
  Testnet prerequisites. They are not any of the nine contract-release
  operations and do not authorize package publication.

## For every proposed transaction

- [ ] Have a trusted administrator prepare a fresh standalone exact-commit
  clone (not a linked worktree or external Git directory) at a
  canonical non-symlink path. Require every path, the reviewed Node runtime,
  and pre-emitted closure-matching JavaScript to be root-owned, non-writable by
  the release euid/group/other/ACL, and inside that root. Run under a dedicated
  unprivileged uid in a dedicated container/VM with no unrelated same-uid
  process. A developer checkout must fail closed.
- [ ] Obtain the independent human SDK-review attestation, detached OpenSSH
  signature under `cedra-reflect-sdk-review-v1`, immutable report reference,
  and external allowed-signers trust anchor. Confirm they bind the exact
  checked-in SDK pin. A repository template or test fixture is never evidence.
- [ ] Set the in-root `RELEASE_NODE_RUNTIME`, in-root
  `RELEASE_EMITTED_JS_DIRECTORY`, and all three `SDK_REVIEW_*` paths. Require
  shell-only closure preflight to authenticate the runtime, compiler, complete
  dependency/SDK trees, and complete externally prepared emitted JS. There is
  no candidate-time compile. Reject `NODE_BIN`, shared/stale `dist/`, or a
  closure-manifest mismatch.
- [ ] Create a strict `transaction-build-request.json` from the checked-in
  template, then run `make assemble-testnet-candidate` with a non-existent,
  untracked/private output directory.
- [ ] Bind the exact artifact digest, public-profile evidence digest,
  application commit, deployment ID, all five role addresses, and all five
  public keys; require the loaded Cedra SDK package to be exactly `2.2.8`.
- [ ] Bind Cedra Testnet API `https://testnet.cedra.dev/v1`, chain ID `2`,
  transaction type, primary sender, ordered secondary signers, sequence,
  absolute future expiry, default CED gas asset, maximum gas, and positive
  gas-unit price. Require fee payer to be absent/null.
- [ ] Bind raw transaction BCS, unsigned transaction-wrapper BCS, signing
  message, and every digest; for publishes, bind the reviewed exact package
  payload and compiled manifest.
- [ ] Simulate the exact same transaction identity. Require success, matching
  payload/signers/options, the requested public keys in exact signer order,
  only all-zero SDK simulation signatures, and an exact content digest for the
  wrapper and raw responses.
- [ ] Approve maximum gas, unit price, and worst-case
  `max_gas_amount * gas_unit_price` before signing.
- [ ] Run `scripts/validate_transaction_candidate.sh` against the exact-address
  artifact record; require both semantic and BCS validation to pass.
- [ ] Confirm the keyless assembler produced its two-file private output only
  after semantic and BCS validation. Its existence is not candidate evidence;
  retain the actual validator-accepted output for this operation.
- [ ] Render the canonical statement with
  `scripts/render_release_approval_statement.sh` to an absent absolute path
  whose final parent is current-euid-owned mode `0700` with no symlink
  ancestors; require held-fd no-replace publication.
- [ ] Obtain two detached OpenSSH signatures under namespace
  `cedra-reflect-testnet-release-v1` from two independent human approvers using
  trusted identities backed by two distinct verified signing-key fingerprints.
- [ ] Build the approval envelope and verify it with
  `scripts/verify_release_approvals.sh` against the external allowed-signers
  trust anchor. Never accept a trust anchor supplied only by the envelope.
- [ ] Keep detached review approvals separate from the Cedra account signatures
  required by the Move entry function.
- [ ] Confirm the external Cedra ceremony can populate authenticators and
  submit while preserving the already validated unsigned transaction identity.
  If it must rebuild any approved transaction field, stop.

## Required Testnet sequence

- [ ] `core_publish`: core primary, no secondary signer; exact reviewed
  `reflection-core` payload.
- [ ] `core_initialize`: core primary, no secondary signer; zero payload
  arguments; require the finalized event/view to prove claim-backed mode.
- [ ] `assets_publish`: assets primary, no secondary signer; exact reviewed
  `test-assets` payload.
- [ ] `amm_publish`: AMM primary, no secondary signer; exact reviewed
  `test-amm` payload.
- [ ] `faucet_initialize`: core primary; assets is the sole ordered secondary;
  call `test_assets::test_faucet::initialize(core, assets)` with zero payload
  arguments.
- [ ] `amm_tusd_claim`: AMM publisher primary, no secondary signer; call
  `test_assets::test_faucet::claim_tusd` with zero payload arguments after
  faucet initialization. Confirm the finalized grant is sufficient for the
  approved seed tUSD amount.
- [ ] `pool_initialize`: core primary; assets then AMM are ordered secondaries;
  call `test_amm::pool::initialize(core, assets, amm)` with zero payload
  arguments.
- [ ] `atomic_operational_handoff`: call
  `test_amm::pool::set_all_operational_admin(core, assets, amm, operations)`
  with core as primary and assets, AMM, then operations as ordered secondaries;
  zero payload arguments. Individual setters are recovery-only and are not the
  initial release path.
- [ ] `pool_seed`: call
  `test_amm::pool::seed_liquidity(core, amm, beneficiary, rfl, usd, min_lp)`
  with core as primary and AMM then bootstrap LP beneficiary as ordered
  secondaries; require exactly three positive amount payload arguments.
- [ ] Require seed to atomically register the authenticated bootstrap-LP
  signer before beneficiary validation and LP mint; do not insert an
  unauthenticated beneficiary address or omit the AMM tUSD funding claim.
- [ ] Do not advance to a dependent operation until the prerequisite is
  finalized, collected read-only, and reconciled. Use the newly observed
  sequence/state when constructing the next candidate.

## External signing and submission

- [ ] Display network, chain ID, primary/secondary signers in order, sequence,
  expiry, gas, function, arguments, signing-message digest, and unsigned-
  wrapper BCS digest to every required Cedra signer.
- [ ] Collect Cedra account signatures outside the repository without exposing
  private keys.
- [ ] Decode the signed envelope immediately before submission and require its
  raw-transaction, unsigned-wrapper, and signing-message digests to equal the
  candidate, with signatures only in authenticator fields and no fee payer.
  The complete signed envelope is expected to differ from the candidate's
  unsigned `transactionBcsHex`; never silently rebuild approved fields.
- [ ] Submit the approved transaction once through the independently reviewed
  external ceremony and record its returned transaction hash.
- [ ] Do not substitute a direct package-publish command, direct Move-run
  command, or repository SDK shortcut. None is an approved release path.

## Read-only finalization evidence

- [ ] For every transaction hash, run
  `scripts/collect_finalized_transaction_evidence.sh` with the candidate,
  approval envelope, external allowed-signers file, exact artifacts, public-
  profile evidence, hash, and a non-existent output directory.
- [ ] Require the collector output parent to exist already, be owned by the
  release euid, and have exact mode `0700`.
- [ ] Require the exact supplied file to be `approval-envelope.json` beside the
  exact supplied `transaction-candidate.json`; never permit basename search or
  substitution from another directory.
- [ ] Require the collector to match a successful finalized user transaction,
  chain ID, allowed signature type, absence of a fee payer, sender, ordered
  secondary signers, sequence, expiry, payload, publish bytes, ledger version,
  and all REST-observable gas ceilings.
- [ ] Record that REST does not return raw transaction/wrapper BCS, the signing
  message, or the fungible gas-asset field. Preserve these as approved
  candidate bindings; do not mislabel them as finalized REST observations.
- [ ] Preserve the raw simulation, transaction, ledger, candidate, approval
  statement, envelope, signatures, and content digests.
- [ ] Remember that the collector performs only Testnet GET requests; it did
  not sign or submit the transaction.

## Release completion

- [ ] Reconcile core reward, LP reward, distribution, reserve, custody, and LP
  share state at the same finalized ledger version with zero unnamed units or
  discrepancies.
- [ ] Confirm the exact fixed tRFL supply was deposited into the frozen
  distribution vault and no mint capability remains.
- [ ] Confirm all three operational-admin views equal the dedicated operations
  address after the single atomic handoff.
- [ ] Confirm the bootstrap LP account owns the intended initial LP position and
  reserves/custody match the approved seed amounts.
- [ ] Complete the documented faucet, wallet transfer, buy, sell, wallet claim,
  LP add/remove/transfer/claim, custody checkpoint, pause/resume,
  shutdown/reseed, prior claim-only epoch, durable indexer restart, and recovery
  exercises.
- [ ] Cross-bind public profiles, clean verification, exact artifacts, every
  finalized transaction, each transaction's two-key approval envelope,
  objects/events, reconciliation, hook decision, gas evidence, and independent
  human review in the final manifest.
- [ ] Validate the final manifest against the external allowed-signers trust
  anchor and publish it without private key material.
- [ ] Do not mark the release or pilot complete while any required live,
  participant, wallet, indexer, review, or quantitative gate remains open.
