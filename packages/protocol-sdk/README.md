# Protocol SDK wrapper

`ReflectionPilotClient` exposes query methods and transaction-draft builders
over injected interfaces. It intentionally has no Cedra RPC URL, private key,
wallet discovery, or implicit write capability.

```ts
const client = new ReflectionPilotClient(readAdapter);
const draft = client.createRewardClaimDraft(amount);
await client.submit(draft); // throws StateChangingCallsDisabledError
```

The release application must explicitly create a `CedraReadAdapter` around the
official Cedra TypeScript SDK. Only after a user-visible confirmation may it
also supply a separately reviewed `CedraWriteAdapter`. This keeps dashboard
rendering, quote generation, test fixtures, and indexer operation free of
wallet and network dependencies by default.

All monetary values use `bigint` base units; the wrapper rejects a reflection
fee above 100 bps and makes the Testnet/no-value warning part of every draft.

The canonical liquidity and LP entry surfaces are exposed as pure draft
builders:

| Builder | Move entry arguments (signer omitted) |
| --- | --- |
| `createAddLiquidityDraft` | `max_rfl`, `max_usd`, `min_lp_shares`, `deadline_seconds` |
| `createRemoveLiquidityDraft` | `shares`, `min_rfl_output`, `min_usd_output`, `deadline_seconds` |
| `createTransferLpSharesDraft` | `recipient`, `shares` |
| `createLpRewardClaimDraft` | `epoch`, `amount` (`0` means claim all) |
| `createCheckpointLpRewardsDraft` | none |
| `createConfigureLiquidityLimitsDraft` | `max_rfl_contribution`, `max_usd_contribution`, `max_withdrawal_share_bps` |
| `createSetFaucetPausedDraft` | `paused` |
| `createOperationalAdminHandoffDraft` | non-zero operational account address |

Builders validate Move integer bounds, positive contribution maxima and LP
share amounts, non-negative minimum outputs, future deadlines, non-zero
recipient addresses, and the 10,000-bps ceiling before a draft can reach an
explicitly injected writer. Draft creation and encoding do not discover a
wallet, sign, simulate, submit, or otherwise mutate chain state.

The operational-admin handoff builder targets the core, faucet, or AMM scope.
It must be signed by that package's publisher. Once handed off, routine fee,
pause, faucet, shutdown, and limit calls require the operational account; the
publisher retains only cold package/capability and future handoff authority.

`PoolSnapshot` reports the three corresponding operator limits as
`maximumRflContribution`, `maximumTusdContribution`, and
`maximumNonFinalWithdrawalShareBps`.

For a finalized deployment, `encodeCedraEntryFunction(draft, moduleAddresses)`
qualifies a draft with the three recorded publisher addresses and returns an
official `@cedra-labs/ts-sdk` entry-function payload. `CedraReleaseClient`
provides the separate multi-agent build/simulate/sign/submit path for approved
release operations; it never loads a key or submits from CI.
