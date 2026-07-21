# Internal contract security audit

Status: remediated author-side review; no unresolved rated finding.
Date: 2026-07-21.

This is an author-side security review performed by the operator and Codex.
There is no external reviewer, and this document does not claim independent
human assurance. It records no remaining Critical, High, Medium, or Low issue
in the reviewed local source. This review covers the initial, never-deployed
schema in
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
- all three publishable packages are immutable after publication; and
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
| SEC-007 | Medium | Initial LP ownership rejected the AMM publisher but not every active operational authority. | Fixed: seed and reseed reject the AMM publisher, excluded publishers, and all current AMM, core, and faucet operational keys; they then atomically register the authenticated fresh beneficiary before minting LP shares. |
| SEC-008 | Release blocker | tRFL and tUSD metadata used non-resolving placeholder URLs. | Fixed: public no-value Testnet icons and project URLs replace the placeholders; the release manifest records their digests. |
| SEC-009 | Critical trust boundary | `compatible` publication policy allowed publishers to replace reviewed logic after release. | Fixed before any deployment: the core, asset, and AMM packages now publish as `immutable`. Any correction requires a conspicuous fresh deployment. |
| SEC-010 | Medium | The normalizer accepted any numeric initialization schema while interpreting it as the current layout. | Fixed: only event schema `1` is accepted; an unknown schema aborts normalization. |
| SEC-011 | Medium | Initial operational authority and AMM/faucet control defaults were present in state but incompletely evented, forcing replay to rely on hard-coded assumptions until later changes. | Fixed: initialization emits each zero-to-publisher authority assignment plus initial faucet configuration/pause and AMM fee/limit/pause state; the witness reconciles them against views. |
| SEC-012 | High | The bootstrap primary-store exclusion function let the core publisher classify an arbitrary empty account without the target's signature or a closing boundary. It could have become a privileged wallet-denial primitive. | Fixed: exactly the named asset and AMM publishers may co-sign their own empty-store exclusion; two finite slots are consumed once, every classification is evented, and an already registered wallet cannot be reclassified. |
| SEC-013 | Medium | The core wallet-claim pause also stopped custody checkpoints and LP payouts, coupling two independent safety domains and allowing a wallet incident response to freeze LP owners unnecessarily. | Fixed: the core pause blocks only wallet materialisation. Custody routing remains live, while the AMM's separately authorized LP-claim pause controls LP payouts. |
| SEC-014 | Medium | The tUSD settlement capability proved only possession of a nonce and could be presented internally with a different tUSD store. | Fixed: issuance co-signs the AMM custodian, binds one exact empty reserve in both capability and state, freezes it immediately, verifies metadata on deposits, and rejects every other store. |
| SEC-015 | Medium | A core swap pause stopped settlement but not AMM quote views, so clients could receive a quote that the same policy state made unexecutable. | Fixed: the shared pool-live guard combines core swap pause, AMM pause, shutdown, seed, and active-epoch health for both quotes and execution. |
| SEC-016 | Medium | The zero-LP-denominator defense named and quarantined an unexpected receipt, but that quarantine also prevented withdrawal of entitlement indexed before the incident. | Fixed: quarantine freezes share/index mutation and isolates the unallocated receipt while preserving claims against the pre-quarantine index; a real routed-receipt test proves the two buckets never mix. |
| SEC-017 | Medium | The independent replay discarded magnified custody residue retired at an epoch boundary, so a valid reseed could diverge from the on-chain aggregate correction. | Fixed: the route-open event carries the exact retired residue; replay verifies and subtracts it from both custody and aggregate corrections before reconciliation. |
| SEC-018 | Release blocker | The production initializer exposed the unproven automatic-materialisation mode as a boolean choice, making an operator mistake irreversible under immutable publication. | Fixed: the sole publishable initializer accepts only the publisher signer and passes `false`; only a `#[test_only]` wrapper can invoke the private implementation with `true`. |
| SEC-019 | Medium / release blocker | A distinct post-bootstrap operations account was not automatically reward-excluded, so it could register, hold tRFL or LP shares, and receive reflections while controlling the faucet and AMM. | Fixed: every handoff authenticates the destination signer, requires an empty and unregistered primary store, permanently excludes it on chain, and rejects any historical LP participant. Pool paths prevent the active operations account from later acquiring LP ownership. |
| SEC-020 | Medium | Three independent handoff transactions allowed temporarily split authority during rotation, and bootstrap LP ownership accepted an unauthenticated address. | Fixed: the normal handoff is an atomic four-signer coordinator across all three packages, while seed and reseed require the LP beneficiary signer. Individual handoffs remain recovery-only and retain destination co-signing and alignment checks. |
| SEC-021 | Medium | A zero-share LP could retain only a fractional personal correction while the aggregate ledger still named whole liability that no individual could claim. Final shutdown could therefore freeze claim-shaped value forever. | Fixed: a full burn/transfer first auto-pays every whole owner claim, then normalizes only the sub-base-unit correction to `claimed * M` in both owner and aggregate ledgers. Closure requires indexed liability and unallocated rewards to be zero and classifies the exact physical remainder as immutable terminal rounding dust. Ten equal positions sharing nine units prove no admin, last-LP, transferee, or future-cohort capture. |
| SEC-022 | Medium | The Python oracle, randomized workload, and generated Move witness exercised automatic materialization while the publishable initializer was claim-backed, so off-chain green evidence could accept a spend that production aborts. | Fixed: model mode is constructor-selected and getter-only, defaults to claim-backed, and all release vectors/workloads use raw spendable balances. Generated Move witnesses invoke the claim-backed initializer; the gate binds mode into its report and digest and rejects automatic-mode evidence. A separate explicit compatibility constructor remains test-only. |
| SEC-023 | Medium | The Python oracle accepted AMM fees and swap sizes outside the Move envelope, rejected a fresh authenticated bootstrap beneficiary that Move registers atomically, and modeled token amounts as u128 rather than u64. | Fixed: AMM fee, reserve-percentage, absolute-gross, output-cap, fresh-beneficiary, role/exclusion, and u64 token/reserve rules now mirror Move. LP shares remain u128 and magnified arithmetic u256. Bidirectional boundary tests cover both acceptance and rejection. |
| SEC-024 | Low / replay completeness | Wallet registration changed the canonical registered-wallet table and count without a dedicated event, so an event-only reconciler could not discover the transition exactly. | Fixed end to end: first registration emits `WalletRegistered { account, primary_store, registered_wallet_count }` exactly once across explicit and implicit paths. The TS normalizer/reducer/schema now handles that event plus the LP residue/terminal events, preserves the account-to-primary-store binding, and reconciles the terminal view. |
| SEC-025 | High / shutdown liveness | Shutdown could begin while LP claims were paused, but shutdown then locked pause reconfiguration. Any full-position exit requiring its mandatory auto-payment could become permanently impossible. | Fixed: `begin_shutdown` rejects `E_LP_CLAIMS_PAUSED` before mutating any pool field. Atomic model evidence snapshots the complete rejected state; Move rejection plus unpause, shutdown, and full-exit regressions cover the executable boundary. |
| SEC-026 | High / shutdown liveness | Non-final shutdown burns still obeyed the operator withdrawal-share cap and required both proportional asset outputs to be nonzero. A tiny cap or imbalanced `1:100` reserve with `5/5` fragmented LP ownership could prevent every holder from unwinding after configuration was locked. | Fixed: every shutdown burn bypasses the cap, permits exactly one rounded-zero side, conditionally settles each nonzero asset, rejects both-zero, and enforces both user minima. Normal operation retains the two-positive-output rule. Exact Move/Python `1:100`, `5/5`, `1 bps` regressions complete the final exit. |
| SEC-027 | Medium / oracle parity | Python reseed retained the prior custody fractional correction, while its routed zero-denominator branch aborted instead of naming unallocated value and quarantine. It also checkpointed a quarantined active claim that Move intentionally serves from frozen pre-quarantine history. | Fixed: Python now normalizes custody and aggregate corrections at route-open, recomputes core rounding, emits the exact retired residue, names zero-denominator receipts as unallocated plus quarantined, admits that state in its invariants, and skips checkpointing quarantined active claims. |
| SEC-028 | Low / conformance completeness | Generated cross-implementation witnesses ended in epoch one, and the hand-authored basic vector used a smaller model supply than the immutable Move deployment, requiring an undocumented distribution-vault offset. | Fixed: a deterministic generated artifact now replays shutdown through epoch-two reseed and a separate quarantine case, asserting wallet correction/claimed values, active and historical epochs, terminal dust, quarantine, and route residue. The basic vector now uses the exact deployment fixed supply. |

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
- A full LP-position burn or transfer pays all whole pending value before the
  position reaches zero. Only its sub-base-unit magnified correction is retired;
  any resulting whole physical unit is immutable terminal dust with no sweep or
  reassignment path.
- Core and LP vaults each satisfy both an indexed-liability partition and an
  independent lifetime-inflow-minus-outflow identity.
- The deployment-scale claim-backed test uses most of the fixed tRFL supply,
  large two-sided reserves, wallet and LP ownership changes, both claim layers,
  and a partial liquidity exit. It finishes by accounting for every physical
  tRFL unit across the distribution vault, core vault, custody reserve, LP
  vault, and two wallets.

## Local verification evidence

This evidence is local source-level verification, not Testnet publication,
simulation, finalized-chain, or clean release-candidate proof:

- strict `make move-lint`: passed for core, assets, and AMM packages with no
  accepted lint warning;
- `make move-test`: 118/118 Move tests passed (2 hook probe, 8 core, 5 AMM
  arithmetic, 103 integration; the assets package currently has no unit test);
- `PYTHONPATH=python python3 -m unittest discover -s python/tests -v`: 60/60
  tests passed;
- TypeScript SDK/indexer tests: 78/78 passed; release-candidate assembler tests:
  21/21 passed;
- `PYTHONPATH=python python3 scripts/generate_seeded_conformance.py --check`:
  all three sampled Python vectors, arithmetic boundaries, deterministic
  lifecycle/quarantine vector, and generated Move witnesses were current;
- focused gate with 1,024 holders: 1,000,000 successful state transitions in
  1,071,570 bounded attempts, 70,626 no-op draws, 944 rejected operations,
  2,002 full invariant audits, claim-backed mode
  (`automatic_materialization=false`), final SHA-256 state digest
  `a40abf6fd8f4b91c7152ba8a63016ef2ef49d2be6c698fdb4dcd87f6c16d90e9`.

The million-operation run intentionally disclosed `git_clean=false`; its digest
is strong local remediation evidence but must not be represented as a signed
clean-source release record.

## Factory extraction constraints

This implementation is intentionally the audited one-token reference, not a
multi-token factory hidden behind configuration. A later factory must preserve
the same security properties while changing the storage topology:

1. Every token instance needs its own object-scoped state, metadata, vaults,
   indexes, corrections, adapter registry, pause state, and authority records.
   No table, capability, route, or view may rely on one package-global address.
2. Every capability must carry an unforgeable token-instance identity plus its
   exact store or route binding. Possessing a capability for token A must never
   authorize token B or another reserve belonging to A.
3. Every event, view, manifest key, indexer cursor, and snapshot identity must
   include the token-instance identifier. Address/module suffix matching is not
   sufficient for a factory.
4. Factory creation must atomically cap and issue the requested supply, place it
   in that instance's excluded distribution vault, and discard or seal the mint
   authority according to the declared token class. A reflection token advertised
   as fixed supply cannot retain a generic factory mint path.
5. Custody and LP support remains adapter-specific. A factory cannot infer
   beneficial ownership from a pool balance; each supported adapter must bind
   exact stores, checkpoint before ownership changes, route one-for-one, and
   maintain an independently backed downstream index.
6. Instance parameters need construction-time bounds equivalent to this release:
   fee ceiling, integer-width/product safety, finite bootstrap exclusions,
   metadata identity, and immutable mode selection. An SDK or indexer may verify
   these facts but must never be required to enforce them.
7. Factory code itself needs an explicit release policy. If immutable, a defect
   means deploying a new factory version rather than mutating existing token
   logic. If a future design is upgradeable, that is a materially different
   trust model and cannot inherit this audit conclusion.

## Deliberate limitations and remaining gates

1. This release recognizes wallet primary stores plus exactly one canonical
   pool custody adapter. Arbitrary external vaults and other LP protocols are
   unsupported. Supporting one requires a separately reviewed adapter that can
   prove beneficial ownership, checkpoint before share changes, bind exact
   stores, and reconcile its own reward vault. Guessing ownership off chain is
   not acceptable.
   An account-controlled vault that uses its controller's canonical primary
   store accrues only as that one address; this does not prove or allocate any
   depositor-level beneficial ownership. Custom and secondary stores fail
   closed.
2. The current packages define one token instance. They are not a factory. A later
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
   finalized on-chain reconciliation, and quantitative pilot gates are
   deployment evidence, not contract-completion requirements. Independent
   review remains recommended before mainnet or factory reuse.
6. The TypeScript indexer locally normalizes and reduces `WalletRegistered`,
   `LpFractionalResidueRetired`, and `LpEpochTerminalDustClassified`, persists
   the two terminal-dust units without conflation, reconciles
   `lp_epoch_terminal_dust(epoch)`, requires registered-wallet ownership for
   positive LP positions, and enforces Move arithmetic widths. Live finalized
   replay of the exact deployed addresses remains unproved.

No unresolved Critical, High, Medium, or Low finding is being carried as
accepted risk by this author-side review. That statement does not claim
independent assurance, signed-release evidence, or live-chain proof.
