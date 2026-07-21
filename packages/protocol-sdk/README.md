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

Swap drafts accept only frozen quotes issued by that exact
`ReflectionPilotClient`. A quote carries its declared slippage plus finalized
chain, ledger, deployment, package, reserve, fee-rate, and swap-limit context.
The client independently recomputes reflection-floor arithmetic, AMM fee,
constant-product output, net receipt, price impact, and the exact minimum
receipt before registering it. Fabricated, cloned, mutated, weakened-minimum,
wrong-chain, or expired quotes cannot become drafts. Use
`quoteAndCreateSwapDraft` when the application wants the verified quote and
bound draft as one operation.

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
| `createOperationalAdminHandoffDraft` | recovery-only; no payload arguments; operations account is the sole ordered secondary signer |
| `createAllOperationalAdminHandoffDraft` | preferred; no payload arguments; assets publisher, AMM publisher, then operations account are ordered secondary signers |
| `createSeedLiquidityDraft` | `rfl_amount`, `usd_amount`, `min_lp_shares`; AMM publisher then LP beneficiary are ordered secondary signers |
| `createReseedLiquidityDraft` | same authenticated signer and payload shape as first seed |

Builders validate Move integer bounds, positive contribution maxima and LP
share amounts, non-negative minimum outputs, future deadlines, non-zero
recipient addresses, and the 10,000-bps ceiling before a draft can reach an
explicitly injected writer. Draft creation and encoding do not discover a
wallet, sign, simulate, submit, or otherwise mutate chain state.

The preferred authority path is the atomic four-signer coordinator: the core
publisher is primary, followed by assets publisher, AMM publisher, and proposed
operations account as ordered secondary signers. The three individual package
handoffs remain recovery-only two-signer transactions. Signer addresses are
never duplicated as payload arguments. Core permanently excludes the proposed
account's empty tRFL primary store before appointment; faucet and AMM can only
align to that same core operator. Once handed off, routine fee, pause, faucet,
shutdown, and limit calls require the operational account; publishers retain
only cold package, capability, and co-signed recovery authority.

Seed and reseed also prove consent through the authenticator list. The core
publisher is primary; the AMM publisher and bootstrap LP beneficiary are
ordered secondary signers. Only the two reserve amounts and minimum LP shares
are payload arguments, so initial LP ownership cannot be assigned to an
unauthenticated address.

`PoolSnapshot` reports the three corresponding operator limits as
`maximumRflContribution`, `maximumTusdContribution`, and
`maximumNonFinalWithdrawalShareBps`.

For a finalized deployment, `encodeCedraEntryFunction(draft, moduleAddresses)`
qualifies single-signer drafts with the three recorded publisher addresses.
`encodeCedraMultiAgentEntryFunction` returns both the payload and its exact
ordered secondary-signer addresses; it refuses single-signer drafts, while the
single-signer encoder refuses multi-agent drafts.

`FinalizedCedraReadAdapter` is Testnet-only. Its immutable manifest must carry
`networkLabel: "cedra-testnet"` and `chainId: 2`; every public read first checks
the official ledger header's actual `chain_id` is `2`, then pins all identity
and state views to that ledger version. A wrong-chain header is rejected before
any Move view is accepted.

Every public read result is detached from adapter-owned memory and recursively
frozen before return, including nested protocol pool state and swap-quote
context. This guarantee applies at the finalized adapter, deterministic mock
adapter, and `ReflectionPilotClient` boundaries. Callers therefore cannot
mutate a later read through an earlier result, and an adapter that retains and
mutates its own result cannot alter the object already issued by the client.

`getLpEpochTerminalDust(epoch)` exposes the finalized
`pool::lp_epoch_terminal_dust` view without unit coercion. Its result separates
`terminalRoundingBaseUnits` (physical tRFL, Move `u128`) from
`retiredResidueMagnified` (fractional correction scaled by `10^24`, Move
`u256`) and records the pinned ledger version. Both the production adapter and
`ReflectionPilotClient` reject zero/oversized epochs, malformed tuples,
out-of-domain values, and an adapter result for a different epoch; the returned
snapshot is covered by the same detached, recursively frozen read boundary.

`CedraReleaseClient` accepts only public addresses and public keys and exposes
single- and multi-agent build/simulation paths. This covers immutable package
publishes and core initialization as well as co-signed operations. Every build
requires explicit sequence number, maximum gas, gas price, and absolute expiry.
`describeSingleSignerTransaction` and `describeMultiAgentTransaction` return a
common JSON-safe identity containing raw-transaction BCS, transaction-wrapper
BCS, and signing-message hex plus SHA-256 digests and every embedded option.
Simulation accepts the exact already-built object and refuses it unless that
identity equals the reviewed identity; it never rebuilds behind the review
boundary.

The client has no sign or submit method. Names, timestamps, and other
unauthenticated strings are not treated as release approval; authenticated
approvals and submission must occur in a separately reviewed signing ceremony.
