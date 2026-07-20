# Security policy for the Reflection Pilot Testnet

> **TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE**

This is a public Testnet pilot, but accounting correctness remains security
critical. Do not rely on a Testnet-only disclaimer to down-rank a defect that
could create, lose, misallocate or conceal a token balance.

## Reportable issues

- A reward-vault liability/backing mismatch or over-allocation.
- A way to make excluded stores accrue rewards or to bypass reflection-aware
  AMM settlement.
- A post-seal `tRFL` mint, unauthorized user-store transfer, reward-vault
  sweep, or fee setting above 100 bps.
- A claim, correction or rounding sequence that manufactures entitlement.
- A swap quote/reserve mismatch, missing net-receipt slippage check, or bypass
  of pool pause/deadline/caps.
- Unauthorized administration, package publication, faucet or liquidity action.
- Indexer/reconciler behaviour that can hide a finalized discrepancy.

## Report format

Provide the deployment/version, exact transaction sequence or local test seed,
expected versus observed raw/effective/pending/vault values, and a minimal
reproduction. Do not publish a proof of concept that could endanger a running
pilot until maintainers have had an opportunity to pause the pool and preserve
the ledger evidence.

## Disclosure and release bar

Every report receives a public disposition in the release changelog. Public
beta cannot proceed with unresolved critical or high-severity findings. A
reproducible accounting mismatch pauses swaps under `ops/INCIDENT_RESPONSE.md`.
