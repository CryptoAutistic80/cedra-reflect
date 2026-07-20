# Operator-run Testnet execution

> **TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE**

This is a runbook, not an automation. It is Testnet-only and must be run by the
named release operators after two people approve the release manifest. The
repository deliberately has no Cedra CLI profile or key material.

## Required operator roles

Use three dedicated, funded Testnet accounts:

| Role | Owns | Signs |
|---|---|---|
| Core publisher | `reflection-core` | core publish, `test_faucet::initialize`, pool initialization/seeding |
| Asset publisher | `test-assets` | asset publish, `test_faucet::initialize`, pool initialization |
| AMM publisher | `test-amm` | AMM publish, pool initialization/seeding |

Use a fourth dedicated operational account for routine fee, pause, faucet,
shutdown, swap-limit, and liquidity-limit calls. It must not be one of the
three publisher addresses.

The Cedra CLI only signs one account for `move run`. The official Cedra
TypeScript SDK supports the required multi-agent transactions; use
`CedraReleaseClient` in `packages/protocol-sdk` to build, simulate, obtain the
separate signatures, and submit an approved operation. Do not pass a private
key on a command line or put it in this repository.

## 1. Prepare a release without publishing

1. Each operator creates a network-specific CLI/wallet profile outside this
   repository and obtains faucet CED for gas.
2. Record their public addresses in the unsigned release manifest.
3. Run `make verify` and `make pilot-gate` from the reviewed commit.
4. Run `bash scripts/verify_release_artifacts.sh` and copy its source digests
   and sparse publish-payload component sizes into the release record. The
   final package digest and size are captured again only after the operator
   compiles with the approved named addresses.
5. Obtain two independent human approvals and store their external signatures
   in the release manifest.

## 2. Publish the three initial packages

The publisher address must match the package's named address. Simulate before
an approved publish and record the transaction hash and gas measurement.

```bash
# Core publisher
cd move/reflection-core
cedra move publish --named-addresses reflection_core=<CORE_ADDRESS>

# Asset publisher, after core publication
cd ../test-assets
cedra move publish --named-addresses test_assets=<ASSETS_ADDRESS>,reflection_core=<CORE_ADDRESS>

# AMM publisher, after core and assets publication
cd ../test-amm
cedra move publish --named-addresses test_amm=<AMM_ADDRESS>,reflection_core=<CORE_ADDRESS>,test_assets=<ASSETS_ADDRESS>
```

Never add `--assume-yes` until the simulated package digest, gas result,
network and two approvals are attached to the manifest.

## 3. Initialize using multi-agent transactions

The order of each Move entry's signer parameters defines SDK sender and
secondary signer order:

| Function | Sender | Secondary signers |
|---|---|---|
| `test_assets::test_faucet::initialize(core_admin, faucet_admin)` | core | assets |
| `test_amm::pool::initialize(core_admin, assets_admin, amm_admin)` | core | assets, AMM |

For each transaction: build with the official SDK, simulate with all public
keys, collect signatures from the listed accounts, submit only after the
approval guard succeeds, wait for finalization, then snapshot/reconcile the
exact ledger version. Use the hook-probe package before enabling any
automatic-materialisation deployment.

## 4. Hand off routine controls

After faucet and pool initialization, each publisher submits its own
single-signer handoff to the same approved non-zero operational address:

```text
reflection_core::reflection_token::set_operational_admin
test_assets::test_faucet::set_operational_admin
test_amm::pool::set_operational_admin
```

Build the calls with `createOperationalAdminHandoffDraft`, simulate them, and
record all three finalized hashes and `OperationalAdminChanged` events. Query
the three `operational_admin` views and require the indexer to reconcile them.
A publisher must not be used for routine controls after handoff.

## 5. Seed the controlled pool

Seed only after the handoffs and hook-mode decision are recorded:

| Function | Sender | Secondary signers |
|---|---|---|
| `test_amm::pool::seed_liquidity(core_admin, amm_admin, beneficiary, rfl, usd, min_lp_shares)` | core | AMM |

The beneficiary must be the approved non-operator pilot LP account. Simulate,
collect both signatures, submit after approval, and reconcile the finalized
reserve, custody, LP-share, and vault state before enabling swaps.

## 6. Evidence that must exist before public beta

Attach the Testnet hook record, package and initialization hashes,
gas results, wallet/SDK display evidence, indexer zero-discrepancy snapshots,
fresh-deployment recovery records and independent review to the signed manifest.
`ops/PILOT_GATES.md` remains the authoritative quantitative exit checklist.
