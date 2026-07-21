# Cedra Reflect v0.2 Testnet deployment execution

This runbook covers a fresh ownerless v0.2 deployment. It does not upgrade,
migrate, or mutate v0.1. Commands that read/build/simulate are distinct from
commands that fund, sign, submit, or retire a deployment.

## Network and toolchain

- Network: Cedra Testnet, chain id 2
- REST: `https://testnet.cedra.dev/v1`
- CLI: exact reviewed `/usr/bin/cedra` binary and recorded SHA-256
- Framework: one identical pinned revision in every Move manifest
- Git transport: SSH, `git@github.com:CryptoAutistic80/cedra-reflect.git`

## Profiles

Use a fresh private CLI working directory outside the repository. Create these
Testnet profiles:

```text
cedra-reflect-v02-core-publisher
cedra-reflect-v02-assets-publisher
cedra-reflect-v02-amm-publisher
cedra-reflect-v02-bootstrap-lp
cedra-reflect-v02-alice
cedra-reflect-v02-bob
cedra-reflect-v02-carol
cedra-reflect-v02-dave
```

Record only public profile data. Never print, copy, hash, stage, or commit a
private key. Validate network, URL, public-key/address derivation, distinct
launch roles, and file permissions before funding.

## Local gate

From the exact clean candidate commit:

```bash
make contract-verify
make verify RELEASE_NODE_RUNTIME=/home/james/.nvm/versions/node/v24.11.1/bin/node
```

Generate a clean verification record and exact-address bundle only after these
pass. Bind `bootstrap_lp` into all package artifact manifests and the TestAmm
bytecode.

## Release operation matrix

| Order | Key | Sender | Ordered secondaries | Function/payload |
|---:|---|---|---|---|
| 1 | `core_publish` | core | none | immutable package publish |
| 2 | `core_initialize` | core | none | `<core>::reflection_token::initialize`, args `["100"]` |
| 3 | `assets_publish` | assets | none | immutable package publish |
| 4 | `amm_publish` | AMM | none | immutable package publish |
| 5 | `pool_launch` | core | assets, AMM, bootstrap | `<amm>::pool::launch`, no args |

For each operation:

1. Build deterministic BCS from the reviewed artifact/request.
2. Verify exact signer order, sequence, gas/expiry envelope, payload, source and
   package digests.
3. Simulate with the intended profiles and require success.
4. Confirm simulated authenticators bind the same public keys in exact order.
5. Review the immutable transaction candidate.
6. Submit those same bytes with the authorized CLI profiles.
7. Wait for finalization and collect REST/CLI evidence before building the next
   operation.

The assembler cannot access private keys, sign, submit, or rebuild an approved
candidate.

## Post-launch verification

At one finalized ledger boundary, verify:

- package policy 2 and upgrade number 0 at all three addresses;
- core release 0.2.0, distinct v0.2 deployment identity, fixed supply and six
  decimals;
- reflection fee 100, creation maximum 500, automatic materialization true;
- core and pool lifecycle `LIVE`;
- exact metadata, distribution vault, core reward vault, custody reserve,
  tUSD reserve, and LP reward vault addresses;
- 500m/500m bootstrap reserves and 500m initial LP shares;
- core/LP backing identities and raw reserve/custody equality; and
- no production ABI/control event representing pause, setter, admin, rotation,
  shutdown, or reseed.

From core/assets/AMM publisher profiles, simulate repeated initialize/launch and
all known v0.1 admin calls. Record rejection; do not invent a fallback call.

## Four-wallet exercise

Use the fixed faucets for Alice, Bob, Carol, and Dave. Alice performs ten
alternating buy/sell cycles. After each transaction collect finalized raw,
pending, derived, reserves, vaults, global/LP indexes, corrections, shares, and
events. Reconcile the exact 1% fee and pool pending zero.

Touch passive holders through ordinary transfers, then exercise LP add/remove/
transfer and final fragmented close. None of these transactions uses a
publisher signer. Verify the token still transfers after close and every pool
mutation remains rejected.

## Stop conditions

Stop immediately on any unexpected signer, byte change, simulation/finalization
mismatch, fee/config difference, authority surface, hook disagreement,
under-backed vault, reserve/custody mismatch, pool pending after swap, or
unexplained base unit. Preserve evidence before diagnosis.

## v0.1 retirement boundary

Do not alter v0.1 during v0.2 deployment. Only after v0.2 passes canonical
pilot gates may a separately authorized procedure stop v0.1 faucet/swaps,
unwind controlled positions, preserve uncontrolled claim access, and publish
remaining liability. v0.1 evidence is permanent.
