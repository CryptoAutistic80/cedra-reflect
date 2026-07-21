# v0.2 gas gate

Status: fresh v0.2 non-final paths measured on Testnet; final-close measurement
remains open.

On 2026-07-21 the official Cedra Testnet
`0x1::gas_schedule::GasScheduleV2` resource reported:

```text
txn.maximum_number_of_gas_units = 2,000,000
txn.max_execution_gas           = 920,000,000 internal scaled units
txn.gas_unit_scaling_factor     = 1,000,000
```

The v0.2 acceptance ceiling is therefore 1,600,000 external transaction gas
units (80% of `txn.maximum_number_of_gas_units`) at this snapshot. Re-read the
resource at deployment; the lower contemporaneous ceiling controls.

## Finalized v0.1 comparison

These values were read from the official Testnet transactions preserved in the
v0.1 evidence record:

| Path | v0.1 gas used | Transaction |
|---|---:|---|
| sell | 28 | `0x512f91d97fc71be4d5616e465b76b12eb68e44440a8e6660989ede8bc005a06f` |
| buy | 29 | `0x61bbd341b498dcdd0680ba099896128fd96e561c5b724983b28f5622b54c5074` |
| add liquidity | 918 | `0x4dbf7884c3b5d9efb004491584e660ceed17a3081ffc3e651619b3eb1f9e4b94` |
| partial remove | 32 | `0xb4017389375fa390ae75ca3e829db094378c3a938ebfbc50e1d5ba3c025a532c` |
| LP transfer | 905 | `0x247676cf350579033381aa94c81e8725681f8ec7dfb97578305771b9a712fe48` |
| wallet claim | 14 | `0xad381e36b7dcd82c51e1d3ecf75f2d68781d8e76e3dec6a81994a4666f7383dc` |

The high add/LP-transfer observations include the actual storage/I/O behavior
of those particular finalized transactions; they are the conservative path
baselines rather than a source-level instruction estimate.

## Finalized v0.2 measurements

Every row below used one transaction object for successful simulation and
subsequent signing/submission. Gas was identical in simulation and finality.

| Path | v0.2 maximum gas | v0.1 gas | Ratio | Gate |
|---|---:|---:|---:|---|
| sell | 35 | 28 | 1.25x | PASS |
| buy | 36 | 29 | 1.24x | PASS |
| add liquidity | 490 | 918 | 0.54x | PASS |
| partial remove, existing stores | 35 | 32 | 1.09x | PASS |
| LP transfer with sender payout | 485 | 905 | 0.54x | PASS |
| standard wallet transfer, both stores existing | 23 | n/a | n/a | ceiling PASS |
| wallet `claim_all` | 14 | 14 | 1.00x | PASS |
| full LP-position remove, recipient store creation | 571 | n/a equivalent | n/a | ceiling PASS |
| direct LP `claim_all` | 1,928 | n/a equivalent | n/a | ceiling PASS |

The maximum observed non-final path was 1,928 gas, or 0.121% of the 1,600,000
acceptance ceiling. The full-position removal is not compared to the v0.1
partial-removal row because its recipient tUSD store was created during the
v0.2 transaction; the evidence deliberately binds that storage condition. The
direct LP claim has no preserved like-for-like v0.1 baseline, so only its
ceiling result is asserted.

Representative finalized v0.2 transactions:

- buy: `0x9307b5bc215b9cd1666533fc5e2eb1fe80493c511df80a0aba99c2747b800489`
- sell: `0x70ab0bdef6878ae2feee844f6b7a414e50e43439dc46a6c15694fdd460d519db`
- add: `0x6cffacf79c2ea29906f9646c8ce6a998635a140360005f34c607beff63083dec`
- LP transfer: `0xf70320f73070950ae07a3b0152d49ba869524c0c633fc1be25e739fa424acf1c`
- partial remove: `0x4f29fa2c5d7a352637bdc3126aebfeded119f356ae3a80a21e7631d8b135e500`
- full position remove: `0x0d59513b50f52e4af483d697cd0c52cc436bccf7ddd0eb6839d37d99674806aa`
- standard wallet transfer: `0xfadb1880a4338b58d6ff21e67d4dc4c364bd4ff0b5902ccac6485ba78fd28d2c`
- wallet claim: `0xf84f0e47f03c919e6a1acf4cfe134d4545c5a7e9f1becb7add9e46147ad07bd6`
- direct LP claim: `0x45044a7b7bf26373394a17dd88c4f47ef2aca537f4d9a72424a451e46f47e59d`

## Remaining measurements

Final remove/close still requires a finalized measurement. For that path:

1. record a success simulation from the exact v0.2 package addresses;
2. record finalized `gas_used` for the same semantic path;
3. bind whether recipient primary stores/positions already existed;
4. use the maximum simulation/finalized observation; and
5. require both:

```text
v0.2 gas <= 2.5 * comparable v0.1 gas
v0.2 gas <  1,600,000 (or 80% of the newer Testnet ceiling, if lower)
```

Where v0.2 introduces a path absent in v0.1 (atomic launch and final permanent
close), only the 80% Testnet-ceiling bound applies. No gas gate is marked PASS
from local unit tests.
