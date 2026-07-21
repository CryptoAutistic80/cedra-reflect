# Cedra Reflect v0.2 Testnet release checklist

This checklist authorizes no transaction by itself. Complete each row with
exact-commit, exact-address, simulated, finalized evidence. Never reuse v0.1
addresses, profiles, manifests, or approvals as v0.2 evidence.

## Source and contract

- [ ] Selected branch/commit is reviewed and the worktree is clean.
- [ ] `make contract-verify` passes from that exact commit.
- [ ] Move ABI allowlist contains no setter, pause, admin, rotation, blacklist,
  shutdown, reseed, later epoch, migration, arbitrary mint/transfer, or generic
  custody/exclusion entry.
- [ ] Fee tests pass for 0, 1, 100, 500 and rejected 501.
- [ ] One-million-operation automatic v0.2 model gate has zero discrepancy.
- [ ] Maximum-path gas passes the documented v0.1/Testnet bound.
- [ ] Internal contract/accounting and model-parity reviews have no unresolved
  rated finding.

## Fresh public roles

- [ ] Fresh Testnet profiles exist for core publisher, assets publisher, AMM
  publisher, bootstrap LP, Alice, Bob, Carol, and Dave.
- [ ] Each profile reports `network: Testnet`, the official REST/faucet URLs,
  and a private key without exposing its value.
- [ ] Public key to authentication-key/address derivation passes.
- [ ] Core/assets/AMM/bootstrap addresses are distinct and source-bound.
- [ ] Private CLI config is mode 0700/0600 and outside the repository.

There is deliberately no operations/admin profile.

## Exact-address artifacts

- [ ] Core, assets, and AMM packages compile with four exact named addresses:
  `reflection_core`, `test_assets`, `test_amm`, and `bootstrap_lp`.
- [ ] Embedded package metadata reports immutable policy 2 and upgrade number 0.
- [ ] Source, metadata, bytecode, CLI-oracle payload, framework, CLI, commit, and
  tree digests reconcile.
- [ ] Release manifest records v0.2 deployment identity, fee 100/max 500,
  automatic materialization, lifecycle `LIVE`, fixed launch constants, and no
  privileged address.

## Five ordered release transactions

Every transaction is built once, validated, simulated, reviewed, submitted,
and finalized before the dependent transaction is built.

1. [ ] `core_publish`: core signer, no secondary signer.
2. [ ] `core_initialize`: core signer; function
   `<core>::reflection_token::initialize`; exact arguments `["100"]`.
3. [ ] `assets_publish`: assets signer, no secondary signer.
4. [ ] `amm_publish`: AMM signer, no secondary signer.
5. [ ] `pool_launch`: core sender; ordered secondary signers assets, AMM,
   bootstrap; function `<amm>::pool::launch`; no arguments.

- [ ] Simulation status is success and authenticator keys/order match profiles.
- [ ] Exactly one detached OpenSSH operator approval verifies against the pinned
  allowed-signers trust anchor and canonical candidate-derived statement.
- [ ] Submitted BCS/signing bytes equal reviewed simulated bytes.
- [ ] Finalized transaction succeeds with the expected sender/sequence/payload.
- [ ] No fee payer, keyless signer, unexpected secondary, or rebuilt payload is
  introduced after review.
- [ ] The repository did not read a private key, sign, or submit a transaction.

## Finalized launch verification

- [ ] All packages exist at exact addresses with policy 2 and upgrade 0.
- [ ] `TokenCreated` and `LaunchSealed` agree on fee 100 and deployment identity.
- [ ] Core and pool lifecycle are `LIVE`; automatic materialization is true.
- [ ] Fixed supply, distribution/core/LP vaults, reserves, custody shares, and
  initial LP shares reconcile exactly.
- [ ] AMM fee/limits and faucet grants/cooldown equal source constants.
- [ ] All former publisher profiles fail every setup/relaunch/privileged action.

## Compatibility and functional evidence

- [ ] Distinct raw/pending/derived hook probe succeeds on Testnet.
- [ ] CLI, REST, read adapter, and real wallet display agree on `raw + pending`.
- [ ] Secondary-store transfer/receipt fails closed.
- [ ] Alice completes ten alternating buy/sell cycles while Bob, Carol, and Dave
  remain passive; every trade reconciles exact fee and all accounting.
- [ ] Passive wallets retain raw while pending/derived rise, then materialize on
  ordinary touch.
- [ ] Pool pending is zero after every swap and LP entitlement rises.
- [ ] LP add, partial/full remove, transfer, fragmented ownership, and final
  permissionless close pass.
- [ ] Post-close swaps/liquidity/launch/reseed all fail.

## Canonical decision

- [ ] At least 50,000 finalized synthetic transactions.
- [ ] At least 10,000 completed swaps.
- [ ] At least 1,000 distinct holders.
- [ ] At least 100 distinct LP positions.
- [ ] Zero unexplained reconciliation discrepancy.

Only after every row above passes may v0.2 be declared canonical. v0.1
retirement is a later, separately approved operator action.
