# Cedra Reflect

> **TESTNET ASSET — NO MONETARY VALUE**

Cedra Reflect is a single-token Cedra Move reference implementation for a
fixed-supply reflection token and its canonical tRFL/tUSD liquidity pool. The
current v0.2 release candidate is designed to become ownerless at launch and to
materialize wallet and LP rewards automatically during ordinary interactions.
It is a reference for a future factory; it is not itself a token factory.

## What is enforced on chain

- The creator chooses the swap reflection fee once in
  `reflection_token::initialize`. The allowed range is 0–500 basis points and
  the v0.2 Testnet instance uses 100 basis points.
- The tRFL supply is minted once and the mint capability is destroyed. Ordinary
  wallet transfers are untaxed; canonical AMM buys and sells pay the immutable
  reflection fee.
- `pool::launch` atomically binds the faucet, AMM, canonical custody store, LP
  reward vault, fixed bootstrap reserves, and initial LP owner. It then seals
  every setup-only path.
- There is no post-launch owner, pause, fee setter, limit setter, authority
  rotation, blacklist, shutdown, reseed, epoch-open, arbitrary mint, or generic
  custody-registration entry point.
- Wallet sends, receives, buys, sells, and liquidity movements materialize all
  whole pending rewards before the relevant weight changes. The derived Cedra
  balance is `raw + pending`, so passive wallets immediately expose rewards.
- Every swap checkpoints canonical pool reflections into the LP reward index.
  LP mint, burn, and transfer materialize affected positions first.
- The final LP withdrawal returns the complete reserves, closes the pool
  permanently, and requires no publisher signature.

All accounting is O(1). The contract never iterates over holders or LP
positions.

## Repository layout

```text
move/       immutable Cedra Move packages and integration tests
python/     independent accounting model and randomized invariant gates
packages/   optional read/index/release verification helpers
tests/      off-chain parity and release-tooling tests
ops/        Testnet plans, manifests, schemas, and evidence templates
docs/       normative accounting and security documentation
```

The TypeScript code is not part of the token and is not trusted by the Move
contracts. It is retained only where it independently reads/reconciles chain
state or assembles a deterministic release candidate. It cannot set balances,
sign, submit, pause, mint, or control the protocol. The v0.2 work deliberately
does not add an application SDK or frontend.

## Lifecycle

1. `CONFIGURING`: publish the three immutable packages, initialize tRFL with
   the selected fee, and prepare the four source-bound launch signers.
2. `LIVE`: call `pool::launch` once with core, assets, AMM, and bootstrap-LP
   signers. Setup authority is thereafter unusable.
3. `CLOSED`: the final LP withdraws all reserves. Swaps, liquidity changes, and
   reseeding remain impossible; wallet transfers and residual manual claims
   remain available.

The four launch roles are package publishers for core/assets/AMM plus the
initial LP beneficiary. Their addresses provide provenance after launch, not
administrative rights. Private keys and CLI configuration never belong in this
repository.

## Verification

The contract-only gate performs no network, funding, signing, publication, or
wallet action:

```bash
make contract-verify
```

The broader local repository gate is:

```bash
make verify RELEASE_NODE_RUNTIME=/absolute/reviewed/path/to/node
```

Before a v0.2 Testnet instance is called canonical, the project also requires
fresh exact-address artifacts, simulation before every submission, finalized
CLI-wallet evidence, a four-holder repeated buy/sell exercise, LP
add/remove/transfer/final-close evidence, and zero reconciliation discrepancy.
The larger 50,000-transaction pilot gates remain separate live evidence and
must not be inferred from local tests.

## Release history and scope

The immutable v0.1 Testnet deployment is historical and claim-backed. Its
addresses, events, and evidence remain separate from v0.2. v0.2 is a fresh
deployment with no migration or conversion code. See
[`CEDRA_TESTNET_PLAN.md`](CEDRA_TESTNET_PLAN.md) and
[`CHANGELOG.md`](CHANGELOG.md).

There is one operator and no external reviewer for this Testnet reference. Each
release candidate requires exactly one detached OpenSSH operator approval bound
to the reviewed candidate, trust anchor, exact-address artifacts, and simulated
transaction. The repository still cannot sign or submit transactions. Internal
contract/accounting and model-parity reviews are required. An external security
review remains required before mainnet use or a production token factory.
