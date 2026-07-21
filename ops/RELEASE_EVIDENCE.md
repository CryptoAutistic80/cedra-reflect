# Cedra Reflect v0.2 release evidence

Release evidence proves exactly what occurred; it does not grant authority.
Local tests, simulation, finalized chain state, wallet display, and canonical
load evidence are separate claims and must remain separate artifacts.

## Evidence generations

- v0.1 artifacts are historical claim-backed deployment evidence.
- v0.2 artifacts use fresh addresses, deployment identity, schema, manifests,
  profiles, events, and transactions.
- Indexers and reports must never merge the two generations.

## Required v0.2 files

The release bundle binds:

- clean full-verification record and log;
- one-million-operation automatic v0.2 model report;
- exact-address package metadata, bytecode, CLI-oracle payloads, source digests,
  framework/CLI/runtime provenance;
- four-role public candidate and public-profile evidence;
- five-operation build request and deterministic candidate;
- exactly one detached OpenSSH operator approval for each canonical candidate,
  bound to an externally pinned allowed-signers trust anchor;
- simulation responses and authenticator validation;
- submitted BCS/signing-byte equality and finalized transaction responses;
- release manifest plus finalized views/events/reconciliation; and
- hook, wallet, four-holder, LP, closure, and pilot evidence.

Private keys and CLI config are never evidence files.

## Four roles

```text
core_publisher
assets_publisher
amm_publisher
bootstrap_lp
```

There is no operations/admin role. Addresses must be distinct and must equal
the four exact named-address bindings. After launch the first three addresses
retain provenance only; the fourth is an ordinary LP owner.

## Five operation contracts

```text
core_publish       core, no secondaries
core_initialize    core, no secondaries, initialize args ["100"]
assets_publish     assets, no secondaries
amm_publish        AMM, no secondaries
pool_launch        core, ordered secondaries assets/AMM/bootstrap, no args
```

Every candidate records exact sender, secondaries, function, type arguments,
arguments, sequence, gas, expiry, raw BCS, signing message, fingerprint,
simulation response, and build environment. Unknown operation keys and extra
request fields fail closed.

## Artifact and executable closure

Publishable package metadata must report immutable policy number 2 and upgrade
number 0. The exact-address builder records all four named addresses in every
package record, including the `bootstrap_lp` binding used by TestAmm.

Candidate assembly uses the reviewed explicit Node runtime, lockfile, installed
Cedra SDK tree, TypeScript compiler tree, emitted JavaScript, Python runtime,
and security helper scripts recorded in
`ops/evidence/release-executable-closure.json`. Regenerate that closure only
after source/package/dist settle:

```bash
bash scripts/render_release_executable_closure.sh \
  "$PWD" /home/james/.nvm/versions/node/v24.11.1/bin/node \
  > /tmp/release-executable-closure.json

diff -u ops/evidence/release-executable-closure.json \
  /tmp/release-executable-closure.json
```

The production assembler is build/simulate-only. It cannot read wallet private
keys, sign, submit, or replace an existing candidate directory.

For this Testnet release, the approval envelope contains exactly one operator
identity, signing-key fingerprint, and detached signature. Verification still
binds the signature namespace, external allowed-signers trust anchor, canonical
approval statement, candidate digest, exact-address artifacts, public profiles,
and successful simulation. The signature authorizes execution; it is not an
external security review. Mainnet or factory use still requires external review.

## Finalized state evidence

The v0.2 manifest/reconciliation must independently prove:

- release 0.2.0 and distinct deployment identity;
- reflection fee 100, maximum 500, automatic materialization true;
- lifecycle `LIVE` after launch and `CLOSED` after final LP exit;
- fixed supply, exact stores/vaults/reserves, custody and LP identities;
- exact launch constants and bootstrap beneficiary;
- source digests, immutable policies and upgrade number 0;
- core and LP vault partitions and lifetime identities;
- raw reserve/custody equality and pool pending zero after each swap;
- no privileged post-launch address or accepted authority action.

## Evidence labels

- `PASS (local)` means deterministic current-source verification only.
- `PASS (simulation)` means an unsigned/simulation transaction was accepted by
  Testnet state at a recorded ledger version.
- `PASS (Testnet)` means a submitted transaction finalized successfully and its
  resulting state was independently read/reconciled.
- `PASS (wallet)` means a named real wallet displayed/acted on the finalized
  derived balance, captured with Playwright where appropriate.
- `PASS (canonical pilot)` requires the full 50k/10k/1k/100 load gates and zero
  unexplained discrepancy.

Never promote one label into another.

## Sanitization

Before committing evidence, scan for private keys, mnemonics, bearer tokens,
CLI configuration, home-directory secrets, raw signed wallet exports, or other
credentials. Public keys, derived addresses, transaction hashes, package
digests, and finalized ledger data are expected. Preserve v0.1 evidence files
unchanged.
