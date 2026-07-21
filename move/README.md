# Cedra Move protocol packages

| Package | Role | Local command |
| --- | --- | --- |
| `hook-probe` | Phase-0 dispatchable FA compatibility probe | `cd move/hook-probe && cedra move test --dev --skip-fetch-latest-git-deps` |
| `reflection-core` | Fixed-supply tRFL, O(1) reflection index, vaults, hooks, registry | `cd move/reflection-core && cedra move test --dev --skip-fetch-latest-git-deps` |
| `test-assets` | tUSD and a two-authority, cooldown-governed faucet | `cd move/test-assets && cedra move compile --dev --skip-fetch-latest-git-deps` |
| `test-amm` | Admin-seeded canonical tRFL/tUSD pool | `cd move/test-amm && cedra move compile --dev --skip-fetch-latest-git-deps` |
| `integration-tests` | Cross-package economic and security assertions | `cd move/integration-tests && cedra move test --dev --skip-fetch-latest-git-deps` |

All packages pin CedraFramework commit
`01e6ceafae19b900772b343a5af8ae236401e0a8`. This is the exact `mainnet`
branch revision used for local compilation; its dispatchable FA source is the
authoritative API assumption. No deployment, account, faucet, or private-key
operation is performed by these packages.

The three immutable release packages together implement one address-bound tRFL
instance; they are not three token products and are not a token factory. There
is no migration, upgrade, arbitrary vault sweep, or post-initialization tRFL
mint path. Wallet and canonical-LP reward accounting is enforced by Move;
off-chain SDK/indexer packages only build or witness evidence.

The Testnet publish sequence is deliberately multi-authority:

1. Publish and initialise `reflection-core` with the core admin.
2. Publish `test-assets`; its mock USD initialises with the asset admin.
3. Call `test_faucet::initialize(core_admin, faucet_admin)` once.
4. Publish `test-amm`, then call `pool::initialize(core_admin, asset_admin, amm_admin)` once.
5. Create a clean operations profile that is not a package publisher, registered
   tRFL wallet, funded tRFL primary store, or past/present LP participant. Make
   the preferred atomic handoff with
   `pool::set_all_operational_admin(core_publisher, assets_publisher, amm_publisher, new_operational_admin)`.
   All four profiles sign the same transaction; there are no payload arguments.
6. Register the consenting bootstrap profile with
   `reflection_token::register_wallet(bootstrap_lp)`, give only the AMM admin
   tUSD, then call
   `seed_liquidity(core_admin, amm_admin, bootstrap_lp, rfl_amount, usd_amount, min_lp_shares)`.
   The bootstrap LP is a signer, so valuable initial LP ownership cannot be
   assigned to an unconsenting or mistyped address. `reseed_liquidity` has the
   same signer-authenticated beneficiary shape.

The three per-package `set_operational_admin` entries remain recovery surfaces,
but routine rotations should use the atomic coordinator. Every operations
primary store is permanently excluded without consuming either publisher
exclusion slot, and an address that has ever held LP shares can never become
operations for that deployment.

The public pilot must first publish and exercise `hook-probe` on Testnet. See
[the hook gate](docs/HOOK_COMPATIBILITY.md) and
[the accounting specification](docs/REFLECTION_ACCOUNTING.md).
