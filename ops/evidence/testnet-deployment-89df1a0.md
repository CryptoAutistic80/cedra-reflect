# Cedra Testnet deployment and CLI-wallet verification

Date: 2026-07-21

Network: Cedra Testnet (`chain_id = 2`, `https://testnet.cedra.dev/v1`)

Deployed source commit: `89df1a041e1c62ce031e5e1b413f42c818d56dcf`

Deployed source tree: `b99a44df742c0d87d9b28c47b661761d309cf407`

Release-source SHA-256: `97dfcc17b17904ba9d5841f82cc8330d77af7b6289303b73b39ae182ca5af711`

Cedra CLI: `cedra 1.0.4`

Final reconciliation observed by ledger version: `149626840`

This is a sanitized public record. It contains addresses, transaction hashes,
versions, and view results only. Private keys remain solely in the external
Cedra CLI configuration and were neither printed nor copied into the
repository.

## Evidence boundary

This record proves one immutable Testnet deployment and a bounded functional
exercise using dedicated Cedra CLI wallet profiles. It does not claim the
larger public-pilot load gates of 50,000 transactions, 10,000 swaps, 1,000
holders, 100 LP positions, a second deployment, browser-wallet compatibility,
or independent human review.

Before publication, the exact clean commit passed 118/118 Move tests, 60/60
Python tests, 78/78 TypeScript SDK/indexer tests, and 21/21 release-candidate
assembler tests. The claim-backed reference model completed 1,000,000 applied
state changes across 1,024 holders with digest
`a40abf6fd8f4b91c7152ba8a63016ef2ef49d2be6c698fdb4dcd87f6c16d90e9`.
The local verification-record SHA-256 was
`3d03971a0df038d408813d681849177ef577a69a809311203ebc2fc2fc23269f`;
the exact-address-artifacts SHA-256 was
`63255dfbef1daf20ec55ad660d72f62fcda310ff0ef31f434121446992778935`.
Those two files are intentionally retained outside Git because the local
evidence directory also contains ceremony working material.

## Roles and deployed packages

| Role | CLI profile | Address |
|---|---|---|
| Core publisher | `cedra-reflect-core-publisher` | `0x14110b05c8b667577e2ffefab66b01fa2f48bca8091f51af33b1a6c6762773db` |
| Test-assets publisher | `cedra-reflect-assets-publisher` | `0x445292601c73f8542d576908c67e8a28a861575bdc8841e02753651f56492f8f` |
| Test-AMM publisher | `cedra-reflect-amm-publisher` | `0x47f0e7670e63258035b0f71fea8a80d9e24ed118d5262a47a97a555bc6506721` |
| Operations | `cedra-reflect-operations` | `0xb736430fcbb1b1f3d7dac953dcc11fa6cb033efcbc52a36816f1be32ed28ffa3` |
| Bootstrap LP | `cedra-reflect-bootstrap-lp` | `0x0b1cd21450f8b849a1235494c1646e3d338a332d286ba6aef79030d92e7b1f82` |
| Test holder Alice | `cedra-reflect-test-alice` | `0x12482591c12fd3fcc2996cf18fa7a77906fed077710d1ed9ff6b44102e48e4a1` |
| Test holder Bob | `cedra-reflect-test-bob` | `0x42a51b83f3ff7c37f73ffc64ec692b92fe6bef270b9ecd3b644c0801e5de30cc` |
| Test holder Carol | `cedra-reflect-test-carol` | `0x52b13f4d20dd37e65f7343c1875c5e600620f41b0ef8e28e08825dfb86f7968d` |
| Test holder Dave | `cedra-reflect-test-dave` | `0xb3e0ebad58c7f2725d118e9313553fd10ebdef7e57ad36da39dc975317f93cf7` |

| Package | Modules | On-chain source digest | Policy | Upgrade |
|---|---:|---|---:|---:|
| `ReflectionCore` | 8 | `BF71D40A0E875C334964C7DE60A3E9DC92CDDB3606F767600E98E296F643E364` | immutable (`2`) | `0` |
| `TestAssets` | 2 | `0EC6C9566AA7F767E500441DBEEAB1FFF4F215CD1B271CC5FC6E38A38D6B4E1B` | immutable (`2`) | `0` |
| `TestAmm` | 6 | `80C5868C0FBC8CBFE1EA5A97A7F881E51CDC1993601B5E2A1601BD707BF16AF5` | immutable (`2`) | `0` |

## Deployment transactions

Every mutating CLI operation was simulated before submission. Multi-agent
initialization, handoff, and seeding signed and submitted the same transaction
object that had passed simulation.

| Operation | Transaction | Version |
|---|---|---:|
| Publish core | `0x5174f7114cfda46a765a27f13f9d232aff6b07eb55a80ea0e3d1b828e677fd50` | `149600383` |
| Initialize fixed-supply core | `0x27970bad0327ad7e660cf31ae47e1dec2896d343960b9f7239b48d303420dd8a` | `149600819` |
| Publish test assets | `0x661a23a8f9930e3798876c05098eaaccaf4e003f0f47db003929aa00369e57a2` | `149601326` |
| Publish test AMM | `0x3aae429a19685850582bddb605c98f6703202670606020af98919f3b6dbf9fbc` | `149601522` |
| Initialize faucet, core + assets | `0x745b012d6464fd3ce346d127737e854c135bfeff2155f4cb040e844be310d76d` | `149603353` |
| Fund AMM tUSD store | `0x56ed974039a041cc0ea1b0efb61f4849d3f59c10774dfec3207e5f493bd602b5` | `149603885` |
| Initialize pool, core + assets + AMM | `0x6db9c4043f4af478d086859d85018c1fcc90e609ac8613bfadbd5462d15596dc` | `149604060` |
| Atomic operational handoff, four signers | `0x28dc1b6616f41421bb4b1d48742637318a517a2b7dd15088acf9505da6a86e3f` | `149604309` |
| Seed 500,000,000 tRFL + 500,000,000 tUSD | `0x7b3af4aa25e6285a79fcb59ab77c019b4c12913f7f8f0ae712100142e030b9fb` | `149604536` |

The core profile also activated the other role accounts with Testnet gas:
assets `0x2367ff25c42fffe6b27c104c60e9bc933fefce2105c7cbf414911fc8bb096e1f`,
AMM `0x7bed971fe5548ea3a5fdf8bbc9836d6679d18653450248b0318b677e8bdc9583`,
operations `0x0ee4f14ee9f9be3aca6854b60117819e15a627fae8674f1d46a6ef41b5d74a7d`,
and bootstrap LP
`0xa5e14e0c1e43550fd64a48eff73d181c31ffe523bd24b76eab00fb66083b7d67`.

## CLI-wallet functional exercise

| Test | Finalized evidence |
|---|---|
| Alice/Bob tRFL and tUSD faucet claims | `0x677f3df16ebe14908c7e37e1113bf7102b6bf942fcdd94efa6a15831cf269cc3`, `0x0aa0151a3461139393171784f33db1ecacb8ae03290312af5bba2403ff177d71`, `0x9b0786c995dc1828a5b5942343fcaca8f50dd6318bb1fd0260025395b63e102a`, `0x22ad0ded5f3da474880080f8730a69d83154136126299684e2e43655b653f04d` |
| Untaxed 100,000,000-base-unit Alice-to-Bob transfer | `0x18e9d51922438a4ea477dc804677975deacd8d3f0a47b03ab21663a07c5f3fc7` |
| Sell and LP checkpoint; 100,000 reflection units routed | `0x512f91d97fc71be4d5616e465b76b12eb68e44440a8e6660989ede8bc005a06f`, `0xf657aff427cf96390c19a260e0f47904f772673197a6476421f66aee35f24ff5` |
| Bootstrap LP claim; partial/full Alice and full Bob wallet claims | `0x0b7ba2d2ea6df424bb1cbb18acc3ddf01f73fa20c56501105efd70855f9c11da`, `0xad381e36b7dcd82c51e1d3ecf75f2d68781d8e76e3dec6a81994a4666f7383dc`, `0x0e1e02a2e7e0c75f36c733eac6f3a28bcde8e6b81e0c18e6bc5887f39f5bf4e4`, `0x22d5d00db6bd4cd551298c136bf38410b3e88e19e7d2b535cfbf47a6e008af04` |
| Bob buy, Alice add liquidity, Alice partial remove | `0x61bbd341b498dcdd0680ba099896128fd96e561c5b724983b28f5622b54c5074`, `0x4dbf7884c3b5d9efb004491584e660ceed17a3081ffc3e651619b3eb1f9e4b94`, `0xb4017389375fa390ae75ca3e829db094378c3a938ebfbc50e1d5ba3c025a532c` |
| Swap pause, wallet-claim pause, independent LP claim, full unpause | `0xa6cd9107f98d873df77e7ef0933431ad4114855ea0413dc388cdfa0c4516847b`, `0x38997f003f1d7dac0806976d46b910a4d75506df292089a6ffaa05ffc3d4b900`, `0x139323a5a64b02647b68aae21f9cada760dece76cfa6e3de50de020167ad8adc`, `0x02de34eac8a43c6a634d098877dd0b4e5ec3344bfa4be643996dbd23f9cdd157` |
| Alice/Bob wallet claims after unpause | `0x5915e544f459e011dbe80c7ee639022eb339cd1c2a5fd7eb6ee7758005f87f84`, `0x8018a2e161d192fc82ae1c9276e4d637d4944b9d957c23869ab33fa1ac5bc2e4` |
| Pre-transfer sell/checkpoint | `0x040fbf7700a61821b74cdfd278a4445ac68a3c30674fe2da33eb3b4e42e99c1a`, `0x5ce8af5f26473c904de34c95864e2586af5fab9e984ea57f2e48f6ce0ad8335e` |
| Transfer 1,000,000 LP shares Alice to Bob | `0x247676cf350579033381aa94c81e8725681f8ec7dfb97578305771b9a712fe48` |
| Post-transfer sell/checkpoint | `0x9679df3e25118dd07b36e421493b1df898ccfe1da3f2beddc52323504353551d`, `0x51f9dd4394bfa9b5b3087b7a9b545d13052e8e75fd7891ecb19341947ce1aa2a` |
| Alice/Bob/bootstrap LP claims | `0x49a96de1b427577240a8b40deb8492d81d6efb45b0abe4f2b95968144cc92f33`, `0xde31cc1440597f198261a90d57409d56c29c79c82a8ea9863c514e0f56880831`, `0x8c3e3ff7223cccb4d8c4f3fffe0d92a98a2c6d6007df03b6a0bf668ae96e839a` |
| Final Alice/Bob/bootstrap wallet claims | `0xabb13a8ca9d1f6e57001ce1a8ef96a481da1f887f71e4198507c5f4280652cf6`, `0xb7f245d94b4c4cf400d3e400d16e1c55eb8bce238f666a13a965f9b4f323e576`, `0x57d44f45468db3b6944992339d04e6e28c1c31af0167d27726ff1edfba70f0ac` |

### Four-wallet repeated-trader test

Carol and Dave were created as fresh Testnet CLI profiles, funded for gas by
the core profile, and each claimed 1,000,000,000 tRFL base units:

- Carol gas funding: `0x33329fde3141c342af676f1fec3f39ccf33877fea0f2adba879d7a28634ad207`;
  tRFL claim: `0x8d227f6e4b0773fc22cd9c83bfe34e9a6e3b53c28f723197d08cdf3296dbea65`.
- Dave gas funding: `0xd73837dfb359acfb2c9cd828a0182e5ce5bba345b821f7df5b7aecfa5a0bc7f3`;
  tRFL claim: `0x0e215ca5eee7e9a816a2e74daf2b5ab7eedcf017dd502a907c658facedb7caa8`.

The four non-bootstrap holders were Alice (the trader), Bob, Carol, and Dave.
The three passive wallets and all LP positions began with zero pending reward.
Alice then completed three quote-bound buy/sell cycles through her CLI profile:

| Cycle | Buy | Sell | Buy reflection fee | Sell reflection fee |
|---:|---|---|---:|---:|
| 1: 5,000,000 units each side | `0xb52ba6f957423c900b2debd948e4a3158c747c98b491b52af2af6142cf67af5a` | `0xe80c65e5394c93731b8a64126ae03fbd2a7fb3af8db069aba8d823203a862063` | `51243` | `50000` |
| 2: 7,000,000 units each side | `0x83ca9499a1de1df294ce33eeaf1c8befcc09074769952fc53be99b45dbc1811f` | `0xdac72c07314681596eca706ea798caf8f245d1834fa921e7c3d93b246c8042ee` | `71404` | `70000` |
| 3: 9,000,000 units each side | `0xaeb56f9d9db1c495920f534ae25ce35b257bfe1b182c9bc6899b7c401c97bdbf` | `0xa0f87bb8896b1b200a6e18d4a564052f02f698d18b08b0187c1acaa2b316afc0` | `91362` | `90000` |

Before the passive holders claimed, their raw balances were unchanged while
pending/effective balances increased exactly as follows:

| Passive wallet | Raw before | Pending after cycles | Effective after cycles | Raw after wallet claim |
|---|---:|---:|---:|---:|
| Bob | `1110193468` | `104785` | `1110298253` | `1110298253` |
| Carol | `1000000000` | `94384` | `1000094384` | `1000094384` |
| Dave | `1000000000` | `94384` | `1000094384` | `1000094384` |

Wallet claim transactions were Bob
`0x0692c3b3df307e4567becf0d8dd1efe3f5d8477f350ecfef40c40dcc8e6b7645`,
Carol `0x4639406dd9dd0ceb92e2da18c59b8ea88153c782dcdaaeb47643d5829652fec3`,
and Dave `0xb6d02913f9e562ed779d2f38fea136627f5f6d86b6bd551d821c771f542f8116`.

The canonical pool accrued `47937` pending reflection units. Bob checkpointed
them in
`0xd288843eeee1ef366f58705d8295892db08459984780a4a07559f9b2196ee41f`.
The physical LP vault increased from its prior 1-unit rounding reserve to
`47938`. Claimable LP allocations increased from zero to bootstrap `47369`,
Alice `473`, and Bob `94`; the aggregate indexed liability was `47937`, with
one whole base unit represented only by the aggregate fractional accounting.
LP claims finalized in
bootstrap `0x156c3d95340bb4a0ee0545700cf5828b87c6ec73b025f01c8576331eec37bc4d`,
Alice `0xcae5c5819b5d66bb2bfbc5f20b436dfa5d436985ab16ef0fd0e79565fd0e637f`,
and Bob `0xf30545430c368d01d6dcae180d9a7aaabc4f88f767807306a85589c96500e3ed`.
Alice and bootstrap then cleared their final wallet pending amounts in
`0x1d495f91e40b53a63e1762e5ed17e098b59a51556a6ed709355b804935bb6017`
and `0x2ec9e2bb43e38e910045a852460371672367c8b026ab6056a514fd6769fe268c`.

### Historical LP reward ownership

Immediately before the LP transfer, Alice owned 5,993,588 shares and had 120
pending LP reward units; Bob owned zero shares and had zero pending. After
Alice transferred 1,000,000 shares, Alice owned 4,993,588 and retained all 120
historical reward units; Bob owned 1,000,000 and still had zero. After another
sell and checkpoint, Alice had 221 pending and Bob had 20. Thus the old reward
did not follow the shares, while the new reward did. All three LP holders then
claimed through their own CLI profiles.

### Simulation-only negative checks

These failed during simulation and produced no submitted transaction:

- Former core publisher attempted `set_fee_bps`: core
  `E_NOT_OPERATIONAL_ADMIN(29)`.
- Alice attempted a swap while swaps were paused: AMM `E_POOL_PAUSED(10)`.
- Alice attempted a wallet claim while wallet claims were paused: core
  `E_CLAIMS_PAUSED(6)`; the bootstrap LP claim still succeeded, demonstrating
  independent pause domains.
- Alice attempted a second exhausted LP claim: LP rewards
  `E_CLAIM_EXCEEDS_PENDING(9)`.
- An initial remove-liquidity command included an obsolete extra Boolean
  argument and failed ABI argument-count simulation. The command was corrected
  to the published four-argument ABI before submission.

## Final on-chain reconciliation

All quantities below are tRFL base units unless stated otherwise.

### Fixed-supply conservation

```text
distribution vault       999,995,500,000,000
Alice wallet                     874,386,896
Bob wallet                     1,110,298,347
Carol wallet                   1,000,094,384
Dave wallet                    1,000,094,384
bootstrap LP wallet                107,979
AMM tRFL reserve                515,018,007
core reward vault                         1
LP reward vault                           2
                              -----------------
fixed supply             1,000,000,000,000,000
```

The sum is exact with discrepancy zero. Global eligible shares were
4,499,999,997, exactly the five registered wallet balances plus the canonical
AMM tRFL reserve.

### Core and custody

- Global index: `215436761132720950018`.
- Lifetime fees: `725623`; lifetime wallet materialized: `616841`; lifetime
  custody routed: `108781`.
- Core vault partition: vault `1` = aggregate indexed liability `0` +
  unallocated `0` + rounding reserve `1`.
- Custody shares `515018007` exactly equal the AMM tRFL reserve `515018007`.
- Pool pending reward and all five registered wallet pending rewards are `0`
  after final claims.
- Registered wallet count is `5`. Automatic materialization is `false`.

### AMM and LP rewards

- Reserves: tRFL `515018007`, tUSD `497337184`.
- Active epoch `1`; total LP shares `505993588` = bootstrap `500000000` +
  Alice `4993588` + Bob `1000000`.
- Epoch lifetime received `108781`; lifetime claimed `108779`; aggregate
  liability `1`; rounding reserve `1`; physical LP vault `2`.
- All three LP pending rewards are `0` after final claims.
- Pool, liquidity, LP-claim, and shutdown pauses are all `false`; the pool is
  seeded.

### Authority and faucet

Core, faucet, and AMM all report the same operational admin:
`0xb736430fcbb1b1f3d7dac953dcc11fa6cb033efcbc52a36816f1be32ed28ffa3`.
The faucet is unpaused and configured for grants of 1,000,000,000 tRFL and
1,000,000,000 tUSD base units with a 3,600-second cooldown. Final AMM limits
are fee `30` bps, maximum reserve output `2000` bps, maximum gross swap
`100000000000`, maximum per-asset liquidity contribution `100000000000`, and
maximum withdrawal share `10000` bps.
