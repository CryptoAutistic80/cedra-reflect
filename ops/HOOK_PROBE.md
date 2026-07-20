# Dispatchable-hook compatibility probe

This probe is the required feasibility gate before an automatic-materialisation
release. It is intentionally a small, isolated package; it must not be inferred
from a successful compile of the reflection protocol.

> **No-value Testnet procedure.** This pilot has no Devnet execution stage.
> Publishing and transactions are operator-authorized mutations and are not
> performed by this repository's CI.

## Preconditions

- Pin the Cedra CLI version, framework revision, RPC URL and wallet/SDK version.
- Create isolated probe publisher, sender and recipient accounts. Do not reuse
  production-like publisher or operational keys.
- Build the package locally, preserve its digest, and simulate each transaction
  before authorizing it.
- Configure a Testnet-only profile with `cedra init --network testnet`; never
  record private keys or mnemonic material in the report.

## Required experiment matrix

| ID | Experiment | Required observation |
|---|---|---|
| H1 | Publish, then register withdrawal, deposit and derived-balance hooks | Both transactions finalize in order and the exact function identifiers are recorded. Registration is a one-time post-publication call because Cedra resolves hooks from finalized module storage. |
| H2 | Primary-store peer transfer | Events and state show both expected hook invocations exactly once. |
| H3 | Standard balance query | CLI/REST/TypeScript SDK query returns the derived/effective balance, or a proven raw-balance fallback. |
| H4 | Internal reference operations | A controlled `with_ref`/reference settlement path does not recurse into hooks or change the index twice. |
| H5 | Reward-vault materialisation | Pending amount can move from an excluded vault to a holder without duplicate entitlement. |
| H6 | Secondary fungible store | Behaviour is documented: supported safely, rejected, or explicitly excluded. |
| H7 | TypeScript SDK | The pinned SDK retrieves the same result as the on-chain view and emitted events. |
| H8 | Chosen wallet | Wallet exposes the derived result, raw result with an understandable fallback, or is unsuitable for the initial pilot. |

## Decision rule

Choose **automatic materialisation** only if H1–H7 succeed with no unexpected
recursion and the wallet result is acceptable or the UI can clearly reconcile
it. Choose **claim-backed** if any result establishes that derived balances are
not reliably visible or spendable through standard transfers. The claim-backed
mode is valid; silence about an inconclusive result is not.

## Evidence record

Copy `ops/evidence/hook-probe.template.json` to
`ops/evidence/hook-probe-testnet.json`. Fill every result from finalized
transactions, checked SDK output and a wallet screenshot/reference. The
release manifest must link this record.
