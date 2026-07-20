# Internal contract security audit

Status: remediated internal review for the Cedra Testnet release candidate.
Date: 2026-07-20.

This is an author-side security review, not the independent review required by
the release gate. It covers the initial, never-deployed schema in
`move/reflection-core`, `move/test-assets`, `move/test-amm`, and the event
normalizer/reconciler that witnesses their accounting.

## Security objective

The release is a single fixed-supply tRFL instance and a reference design for a
later reflection-token factory. The current packages must therefore be secure
without relying on a future migration or factory abstraction:

- no retained tRFL mint, burn, sweep, forced-balance, or arbitrary user-store
  transfer capability;
- no double counting between registered wallet primary stores and the one
  canonical custody reserve;
- LP beneficial owners, rather than the pool store, receive the reserve's
  reflections through a separately backed, checkpointed LP index;
- every economic mutation is signer- or non-forgeable-capability-gated and is
  independently replayable from the exact approved package addresses;
- all three published packages are immutable after publication; and
- unsupported secondary stores, third-party vaults, wrappers, and delegated
  custody fail closed instead of silently receiving or losing reward weight.

## Threat model and retained authority

Move type safety and Cedra signer authentication are trusted. The framework
revision recorded in each `Move.toml` and the exact compiled release bytes must
still be reviewed independently.

The three package publishers are cold authorities that initialize package-owned
resources, issue the two one-use integration capabilities, and may rotate a
package's operational key. The operational key can change the bounded reflection
fee, pause surfaces, faucet configuration, AMM fee and transaction limits, and
begin a controlled AMM shutdown. It cannot mint tRFL, edit a balance, withdraw a
vault, forge a capability, exceed the one-percent reflection-fee ceiling, or
change immutable package code.

The Testnet tUSD mint is intentionally retained only by the rate-limited,
pausable test faucet. It is not part of the tRFL fixed-supply guarantee.

## Findings and disposition

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| SEC-001 | High | Core event-constructor functions were public, so unrelated Move code could emit authentic-looking accounting events without the corresponding state transition. | Fixed: every core event constructor is `public(package)`; a structural test prevents reopening the ABI. |
| SEC-002 | High | The Cedra normalizer matched only module/event suffixes, allowing a counterfeit package address to enter the accounting witness. | Fixed: the normalizer requires three configured package addresses and matches canonical address, module, and event exactly. Counterfeit-address tests fail closed. |
| SEC-003 | High | Fee events omitted the applied fee rate and the normalizer carried mutable fee state, so restart or partial-history replay could assign the wrong rate. | Fixed: initialization emits its initial rate, every fee receipt emits the applied `fee_bps`, and normalization is stateless. |
| SEC-004 | Medium | The incident runbook required stopping grants, but the faucet had no on-chain pause. | Fixed: a separately evented operational pause blocks both tRFL and tUSD grants and is reconciled against the on-chain view. |
| SEC-005 | Medium | The router receipt assumed two eligible wallet endpoints, causing valid transfers between an eligible wallet and an excluded store to be replayed incorrectly. | Fixed: native eligible debit/credit hooks are authoritative; the router receipt is informational and validates whichever eligible endpoints exist. |
| SEC-006 | Medium | Move schema version `1`, indexer label `testnet-v1`, and manifest release `testnet-v0.1.0` represented different concepts as one value. | Fixed: on-chain state/event data records semantic release `0.1.0` separately from schema `1`; unknown schemas are rejected. |
| SEC-007 | Medium | Initial LP ownership rejected the AMM publisher but not every active operational authority. | Fixed: seed and reseed reject the AMM publisher and all current AMM, core, and faucet operational keys, and require an already registered wallet beneficiary. |
| SEC-008 | Release blocker | tRFL and tUSD metadata used non-resolving placeholder URLs. | Fixed: public no-value Testnet icons and project URLs replace the placeholders; the release manifest records their digests. |
| SEC-009 | Critical trust boundary | `compatible` publication policy allowed publishers to replace reviewed logic after release. | Fixed before any deployment: the core, asset, and AMM packages now publish as `immutable`. Any correction requires a conspicuous fresh deployment. |
| SEC-010 | Medium | The normalizer accepted any numeric initialization schema while interpreting it as the current layout. | Fixed: only event schema `1` is accepted; an unknown schema aborts normalization. |
| SEC-011 | Medium | Initial operational authority and AMM/faucet control defaults were present in state but incompletely evented, forcing replay to rely on hard-coded assumptions until later changes. | Fixed: initialization emits each zero-to-publisher authority assignment plus initial faucet configuration/pause and AMM fee/limit/pause state; the witness reconciles them against views. |

## Capability and value-flow conclusions

- The tRFL `MintRef` is generated once during initialization, mints exactly the
  fixed supply into the frozen distribution vault, and is then dropped. It is
  absent from all stored state.
- The retained core `TransferRef` and `RawBalanceRef` are private fields of a
  resource stored under the immutable core package. No entry returns them.
- `SettlementCapability`, `FaucetCapability`,
  `CustodySettlementCapability`, `LpAccountingCapability`, and the tUSD pool
  capability are non-copyable values with private fields. Each is issued once
  and held only in the package resource that consumes it.
- Ordinary wallet transfers pass through the registered hooks and are untaxed.
  Privileged movements use the retained transfer reference and apply the same
  share/correction mutation atomically.
- The canonical pool's raw tRFL reserve is exactly one global custody position.
  Its whole pending reward moves one-for-one from the core reward vault to the
  active LP epoch vault before the LP index advances.
- LP shares are account-bound table positions, not freely depositable tokens.
  Mint, burn, transfer, checkpoint, and claim all preserve earned history and
  cannot attach historical reward to a new owner.
- Core and LP vaults each satisfy both an indexed-liability partition and an
  independent lifetime-inflow-minus-outflow identity.

## Deliberate limitations and remaining gates

1. This release recognizes wallet primary stores plus exactly one canonical
   pool custody adapter. Arbitrary external vaults and other LP protocols are
   unsupported. Supporting one requires a separately reviewed adapter that can
   prove beneficial ownership, checkpoint before share changes, bind exact
   stores, and reconcile its own reward vault. Guessing ownership off chain is
   not acceptable.
2. The current package deploys one token instance. It is not a factory. A later
   factory must object-scope every state resource and capability and include a
   token-instance identity in every event, view, custody binding, and indexer
   key. Copying the current global-address layout into a multi-token package
   would be unsafe.
3. Publisher and operational authority remain explicit central trust roles for
   the Testnet pilot. Production use should place them behind an appropriate
   multisig/governance policy and document rotation and recovery.
4. The raw GitHub metadata URLs are operationally mutable. The release manifest
   must pin the application commit and icon SHA-256 digests; a production
   factory should use immutable content-addressed metadata.
5. Exact-address compilation, bytecode/package digests, Testnet simulation,
   finalized on-chain reconciliation, quantitative pilot gates, and a genuinely
   independent source/bytecode review remain mandatory before public release.

No unresolved critical or high finding from this internal pass is being carried
as accepted risk. That statement does not replace independent review and does
not claim live-chain proof.
