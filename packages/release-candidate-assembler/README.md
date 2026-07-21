# Release candidate assembler

This package is the keyless boundary between reviewed release artifacts and an
external Cedra signing ceremony. It builds and simulates exactly one of the nine
ordered Testnet release operations; it cannot read private keys, sign, submit,
fund, or fetch a remote ABI.

The command-line entry point is:

```bash
make assemble-testnet-candidate \
  EXACT_ADDRESS_ARTIFACTS=/ABSOLUTE/OR/REPO/PATH/exact-address-artifacts.json \
  PUBLIC_PROFILE_EVIDENCE=/ABSOLUTE/OR/REPO/PATH/public-profile-evidence.json \
  BUILD_REQUEST=/ABSOLUTE/OR/REPO/PATH/transaction-build-request.json \
  OUTPUT_DIRECTORY=/NEW/PRIVATE/OUTPUT/DIRECTORY \
  RELEASE_NODE_RUNTIME=/ROOT-OWNED/RELEASE/CHECKOUT/ops/local/reviewed-runtime/node \
  RELEASE_EMITTED_JS_DIRECTORY=/ROOT-OWNED/RELEASE/CHECKOUT/ops/local/reviewed-emitted-js \
  SDK_REVIEW_ATTESTATION=/ABSOLUTE/EXTERNAL/PATH/sdk-review-attestation.json \
  SDK_REVIEW_SIGNATURE=/ABSOLUTE/EXTERNAL/PATH/sdk-review-attestation.json.sig \
  SDK_REVIEW_TRUSTED_SIGNERS=/ABSOLUTE/EXTERNAL/PATH/sdk-review.allowed_signers
```

The output path must not exist. On success it is a mode-`0700` directory with
only mode-`0600` `transaction-candidate.json` and
`simulation-response.json`. The files become visible only after exact semantic
and BCS validation succeeds. Publication uses Linux
`renameat2(RENAME_NOREPLACE)` through an argv-only helper, so a concurrent
destination creator wins without any file being overwritten or merged. There
is no racy portability fallback.

The three SDK-review files are a mandatory external human gate. The
attestation must be signed under `cedra-reflect-sdk-review-v1` by an identity
in the externally controlled trust anchor and bind the exact checked-in SDK
pin. The checked-in template is intentionally invalid and is not evidence.
There is no ambient `NODE_BIN` fallback.

Production assembly intentionally fails in a normal developer checkout. A
trusted administrator must prepare a fresh standalone exact-commit root-owned
clone (not a linked worktree or external Git directory) at
a canonical non-symlink path, place the reviewed Node runtime and already
emitted closure-matching JavaScript inside it, and remove all release-euid,
group, other, and ACL write access. Run it as a dedicated unprivileged release
uid in an isolated container/VM with no unrelated same-uid process. That
process-isolation condition is a mandatory human gate; no test flag bypasses
the filesystem check.

The assembler pins Cedra Testnet chain `2`, default
`0x1::cedra_coin::CedraCoin` gas, no fee payer, `@cedra-labs/ts-sdk` `2.2.8`,
explicit sequence/gas/expiry controls, local ABIs, exact signer order, exact
public-profile keys, and all-zero simulation authenticators. The candidate's
`transactionBcsHex` is an unsigned transaction wrapper. External signing must
add only authenticators and re-extract the same raw transaction, unsigned
wrapper, and signing message before submission.

The captured public-profile record attributes its address derivation to
`OpenSSL dgst -sha3-256`. The assembler independently repeats every
public-key/address check with the reviewed SDK and records that distinct step in
`assembler_revalidation_sdk_package` and
`assembler_revalidation_sdk_version`; it does not rewrite the producer's tool
attribution.

Assembly also requires a completely clean current checkout whose exact `HEAD`
commit and tree match the reviewed v3 exact-address evidence. The candidate
binds `package-lock.json` (including the lock's SDK SHA-512 integrity) and
SHA-256 identities for the package manifest, actually loaded SDK entrypoint,
and complete installed SDK package tree. The independent approval-side BCS
validator recomputes those bytes before accepting the candidate. The build
environment also binds the signed SDK-review attestation, signature, external
trust-anchor digests, namespace, and authenticated reviewer identity, plus the
exact checked-in release executable-closure manifest digest.

A shell-only preflight authenticates the explicit in-root Node runtime, fixed
root-owned Python runtime, TypeScript compiler, complete dependency tree, SDK,
validator JavaScript, kernel no-replace helper, and the complete externally
prepared emitted JavaScript tree before any release import. Production does
not compile. The tree must match `ops/evidence/release-executable-closure.json`
and reside inside the immutable release root; shared `dist/` is not a release
input.

The independent artifact trust anchor is
`ops/evidence/reviewed-cedra-sdk-2.2.8.json` (SHA-256
`adeca264fd6c99cdcf74bc4d8381ecd1b45218ef3ba054da48d84aed86834299`).
It pins npm tarball SHA-256
`c75c4157ed3607e5860ec68e830a83c1c8691e658166fa1ebcf1cb934a381321`
and installed-tree SHA-256
`0259184429bdc85d4d78e1a6bf105677e8cea7707bec5dcdbba269dea36e2765`.
An operator can verify a separately obtained tarball without extracting it:

```bash
python3 scripts/verify_reviewed_sdk_pin.py \
  ops/evidence/reviewed-cedra-sdk-2.2.8.json package-lock.json \
  /ABSOLUTE/PATH/cedra-labs-ts-sdk-2.2.8.tgz
```

See `ops/DEPLOYMENT_EXECUTION.md` for the sequential operator workflow. No
candidate is live-chain evidence.
