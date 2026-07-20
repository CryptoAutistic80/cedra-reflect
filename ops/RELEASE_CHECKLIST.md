# Controlled Testnet release checklist

> **TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE**

Only an approved release operator may execute the state-changing publish step.
CI must build and verify the package but never publish it automatically.

## Before approval

- [ ] Pin and record the Cedra Framework revision and CLI version.
- [ ] Run the complete local verification suite from a clean checkout.
- [x] Run the dispatchable-hook probe on Testnet; attach the finalized report at
  `ops/evidence/hook-probe-testnet.json`.
- [x] Record the supported mode: **claim-backed**. Automatic materialisation is
  not authorized by the current wallet evidence.
- [x] Set all three initial package publication policies to `immutable`; no
  audited logic can be replaced in place after publication.
- [ ] Review the exact-address compiled package digests against the approved
  manifest.
- [ ] Require `exact-address-artifacts.json` to report
  `working_tree_clean: true` for the reviewed application commit. This keyless
  bundle remains `approval_eligible: false` until the separate simulation,
  on-chain policy/digest checks, and two human approvals are recorded.
- [ ] Record each sparse-metadata publish payload size and require it to remain
  within the normal 65,536-byte boundary; do not guess a large-package route.
- [ ] Confirm the release contains no post-seal `tRFL` mint, vault sweep, forced
  balance, user-store transfer, or fee-over-100-bps entry point.
- [ ] Prepare the release manifest from `release-manifest.template.json`.
- [ ] Record schema/release versions, exact event-source addresses, fixed-supply
  configuration, metadata URLs, and both icon SHA-256 digests in the manifest.
- [ ] Obtain two independently recorded human approvals.
- [ ] Record a distinct non-zero operational address that is not any package
  publisher.

## During publication

- [ ] Use the dedicated publisher profile, never an everyday operational account.
- [ ] Verify the selected network is Cedra Testnet and that faucet CED has no
  value outside testing.
- [ ] Simulate the package publish first; capture the simulation and gas result.
- [ ] Publish only after both approvals and record the transaction hash, package
  address, metadata objects, vaults, pool and finalized ledger version.
- [ ] After core publication finalizes, simulate and submit the one-time
  `reflection_token::initialize(..., false)` call; record its event and require
  `automatic_materialization_enabled()` to return `false`.
- [ ] Confirm initialization minted the exact fixed `tRFL` supply into the
  frozen distribution vault and retained no mint capability.
- [ ] Finalize all three publisher-authorized operational-admin handoffs,
  reconcile their events/views, and use only the operational key for routine
  controls afterward.
- [ ] Seed only the approved controlled liquidity after the handoffs and hook
  mode decision are recorded.

## After publication

- [ ] Index from the deployment ledger version and obtain a zero-discrepancy
  reconciliation snapshot.
- [ ] Confirm the dashboard’s permanent Testnet/no-value warning is visible.
- [ ] Execute the documented smoke sequence: faucet, transfer, buy, sell,
  claim, pause/resume and indexer restart.
- [ ] Publish the signed manifest and changelog without private key material.
