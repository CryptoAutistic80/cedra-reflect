# v0.2 gas gate

Status: v0.1 baseline and current Testnet ceiling recorded; v0.2 simulation and
finalized measurements remain open until the fresh deployment.

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

## Required v0.2 measurements

For sell, buy, add liquidity, non-final remove, final remove/close, LP transfer,
wallet transfer with both endpoints pending, wallet claim, and LP claim:

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
