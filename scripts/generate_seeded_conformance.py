#!/usr/bin/env python3
"""Generate deterministic Python/Move accounting-conformance witnesses.

The independent Python model chooses and executes three fixed-seed sequences of
valid wallet, swap, custody, liquidity, LP-transfer, and claim operations. It
also executes compact deterministic shutdown/reseed and quarantine lifecycles.
Only sampled operations that produce a real economic or configuration state
transition are admitted. The same concrete sequences, arithmetic boundary
vectors, lifecycle states, and final snapshots are emitted as Move tests. CI
uses ``--check`` so model, vectors, and Move witnesses cannot drift silently.
"""

from __future__ import annotations

import argparse
import copy
import json
import random
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from reflection_model import AccountingError, ReflectionModel  # noqa: E402


GENERATED_OPERATION_COUNT = 64
FIXED_SUPPLY = 1_000_000_000_000_000
ACCOUNTS = ("alice", "bob", "carol", "dave")
MAX_U64 = (1 << 64) - 1
MAX_U128 = (1 << 128) - 1
SEED_SPECS = (
    (0xCEDA20260720, "seeded_mixed_wallet_custody_lp_conformance_1", "seeded_mixed_accounting.json"),
    (0xA11CE20260720, "seeded_mixed_wallet_custody_lp_conformance_2", "seeded_mixed_accounting_seed_2.json"),
    (0xB0BCA20260720, "seeded_mixed_wallet_custody_lp_conformance_3", "seeded_mixed_accounting_seed_3.json"),
)
ARITHMETIC_VECTOR_PATH = (
    ROOT / "python" / "test_vectors" / "amm_arithmetic_boundaries.json"
)
MOVE_PATH = (
    ROOT
    / "move"
    / "integration-tests"
    / "tests"
    / "seeded_conformance_generated.move"
)
LIFECYCLE_VECTOR_PATH = (
    ROOT / "python" / "test_vectors" / "lifecycle_accounting.json"
)


def economic_state(model: ReflectionModel) -> dict[str, Any]:
    """Return state whose equality means an operation made no real transition.

    Events are deliberately excluded: emitting an event cannot turn an
    otherwise ineffective call into a generated accounting operation.
    """

    return copy.deepcopy(
        {
            key: value
            for key, value in model.__dict__.items()
            if key not in {"events", "_lock"}
        }
    )


def signed(value: int) -> dict[str, int | bool]:
    return {"negative": value < 0, "magnitude": abs(value)}


def model_snapshot(model: ReflectionModel) -> dict[str, Any]:
    epoch = model.lp_epoch(1)
    raw_accounts = (*ACCOUNTS, "pool", "reward_vault", "distribution_vault", epoch.vault)
    quote_accounts = (*ACCOUNTS, "admin", "pool")
    return {
        "fee_bps": model.fee_bps,
        "automatic_materialization": model.automatic_materialization,
        "swap_limits": {
            "amm_fee_bps": model.amm_fee_bps,
            "max_reserve_bps": model.max_reserve_bps,
            "max_gross_swap": model.max_gross_swap,
        },
        "index": model.index,
        "index_remainder": model.index_remainder,
        "total_shares": model.total_shares,
        "aggregate_correction": signed(model.aggregate_correction),
        "unallocated_fees": model.unallocated_fees,
        "lifetime_fees": model.lifetime_fees,
        "lifetime_materialized": model.lifetime_materialized,
        "lifetime_custody_routed": model.lifetime_custody_routed,
        "rounding_reserve": model.rounding_reserve,
        "custody_shares": model.custody_shares,
        "custody_correction": signed(model.custody_correction),
        "custody_settled": model.custody_settled,
        "custody_pending": model.pool_pending_rewards(),
        "raw": {account: model.raw_balance(account) for account in raw_accounts},
        "pending": {
            **{account: model.pending(account) for account in ACCOUNTS},
            "pool": model.pool_pending_rewards(),
        },
        "quote": {account: model.quote_balance(account) for account in quote_accounts},
        "lp_epoch": {
            "status": epoch.status,
            "index": epoch.index,
            "index_remainder": epoch.index_remainder,
            "total_shares": epoch.total_shares,
            "aggregate_correction": signed(epoch.aggregate_correction),
            "unallocated_rewards": epoch.unallocated_rewards,
            "rounding_reserve": epoch.rounding_reserve,
            "terminal_rounding_reserve": epoch.terminal_rounding_reserve,
            "retired_residue_magnified": epoch.retired_residue_magnified,
            "lifetime_received": epoch.lifetime_received,
            "lifetime_claimed": epoch.lifetime_claimed,
            "liability": epoch.aggregate_liability(),
            "vault_balance": model.lp_vault_balance(1),
            "positions": {
                account: {
                    "shares": epoch.positions.get(account).shares
                    if account in epoch.positions
                    else 0,
                    "correction": signed(epoch.positions.get(account).correction)
                    if account in epoch.positions
                    else signed(0),
                    "claimed": epoch.positions.get(account).claimed
                    if account in epoch.positions
                    else 0,
                    "pending": epoch.pending(account),
                }
                for account in ACCOUNTS
            },
        },
    }


def lifecycle_snapshot(
    model: ReflectionModel,
    accounts: tuple[str, ...],
) -> dict[str, Any]:
    """Capture exact core, wallet, custody, and every LP epoch state."""

    epochs: dict[str, Any] = {}
    for epoch_id in sorted(model.lp_epochs):
        epoch = model.lp_epoch(epoch_id)
        epochs[str(epoch_id)] = {
            "status": epoch.status,
            "index": epoch.index,
            "index_remainder": epoch.index_remainder,
            "total_shares": epoch.total_shares,
            "aggregate_correction": signed(epoch.aggregate_correction),
            "unallocated_rewards": epoch.unallocated_rewards,
            "rounding_reserve": epoch.rounding_reserve,
            "terminal_rounding_reserve": epoch.terminal_rounding_reserve,
            "retired_residue_magnified": epoch.retired_residue_magnified,
            "lifetime_received": epoch.lifetime_received,
            "lifetime_claimed": epoch.lifetime_claimed,
            "liability": epoch.aggregate_liability(),
            "vault_balance": model.lp_vault_balance(epoch_id),
            "quarantined": epoch.quarantined,
            "positions": {
                account: {
                    "shares": model.lp_shares(epoch_id, account),
                    "correction": signed(
                        epoch.positions[account].correction
                        if account in epoch.positions
                        else 0
                    ),
                    "claimed": (
                        epoch.positions[account].claimed
                        if account in epoch.positions
                        else 0
                    ),
                    "pending": epoch.pending(account),
                }
                for account in accounts
            },
        }

    route_events = [
        {
            "epoch": event["epoch"],
            "adapter_id": event["adapter_id"],
            "reserve_store": event["reserve_store"],
            "lp_reward_vault": event["lp_reward_vault"],
            "retired_residue_magnified": event["retired_residue_magnified"],
        }
        for event in model.events
        if event["event"] == "CustodyEpochRouteOpened"
    ]
    return {
        "fixed_supply": model.fixed_supply,
        "index": model.index,
        "index_remainder": model.index_remainder,
        "total_shares": model.total_shares,
        "aggregate_correction": signed(model.aggregate_correction),
        "unallocated_fees": model.unallocated_fees,
        "lifetime_fees": model.lifetime_fees,
        "lifetime_materialized": model.lifetime_materialized,
        "lifetime_custody_routed": model.lifetime_custody_routed,
        "rounding_reserve": model.rounding_reserve,
        "reward_vault_balance": model.reward_vault_balance,
        "distribution_vault_balance": model.distribution_vault_balance,
        "custody_shares": model.custody_shares,
        "custody_correction": signed(model.custody_correction),
        "custody_settled": model.custody_settled,
        "custody_pending": model.pool_pending_rewards(),
        "pool": {
            "active_epoch": model.active_epoch or 0,
            "seeded": model.seeded,
            "pool_paused": model.pool_paused,
            "liquidity_paused": model.liquidity_paused,
            "lp_claims_paused": model.lp_claims_paused,
            "shutdown_mode": model.shutdown_mode,
            "rfl_reserve": model.pool_rfl_reserve,
            "usd_reserve": model.pool_usd_reserve,
        },
        "wallets": {
            account: {
                "registered": model.wallet_is_registered(account),
                "raw": model.raw_balance(account),
                "pending": model.pending(account),
                "correction": signed(model.correction.get(account, 0)),
                "claimed": model.materialized.get(account, 0),
                "quote": model.quote_balance(account),
            }
            for account in accounts
        },
        "admin_quote": model.quote_balance("admin"),
        "epochs": epochs,
        "route_open_events": route_events,
    }


def _execute_recorded_operation(
    model: ReflectionModel,
    operations: list[dict[str, Any]],
    operation: dict[str, Any],
) -> None:
    model.apply_operation(operation)
    model.assert_invariants()
    operations.append(operation)


def build_lifecycle_vector() -> dict[str, Any]:
    """Build compact deterministic epoch-two and quarantine witnesses."""

    initial = {
        "fixed_supply": FIXED_SUPPLY,
        "fee_bps": 100,
        "amm_fee_bps": 30,
        "automatic_materialization": False,
        "max_reserve_bps": 2_000,
        "max_gross_swap": 100_000_000_000,
    }

    lifecycle_accounts = ACCOUNTS
    lifecycle_model = ReflectionModel(**initial)
    lifecycle_operations: list[dict[str, Any]] = []
    for operation in (
        {"op": "faucet_grant", "actor": "admin", "recipient": "bob", "amount": 20_000_000},
        {"op": "mint_quote", "actor": "admin", "recipient": "admin", "amount": 200_000_000},
        {
            "op": "seed_pool",
            "actor": "admin",
            "rfl_amount": 100_000_000,
            "usd_amount": 100_000_000,
            "beneficiary": "alice",
            "min_lp_shares": 1,
        },
        {"op": "register_wallet", "actor": "carol"},
        {
            "op": "transfer_lp_shares",
            "sender": "alice",
            "recipient": "carol",
            "shares": 50_000_000,
        },
        {
            "op": "sell",
            "seller": "bob",
            "gross_rfl": 10_000_000,
            "min_quote_out": 0,
        },
        {"op": "checkpoint_pool"},
    ):
        _execute_recorded_operation(
            lifecycle_model,
            lifecycle_operations,
            operation,
        )
    bob_claim = lifecycle_model.pending("bob")
    if bob_claim <= 0:
        raise RuntimeError("lifecycle vector did not create a wallet claim")
    for operation in (
        {"op": "claim", "account": "bob", "amount": bob_claim},
        {"op": "begin_shutdown", "actor": "admin"},
        {
            "op": "remove_liquidity",
            "provider": "carol",
            "shares": 50_000_000,
            "min_rfl_output": 1,
            "min_usd_output": 1,
        },
        {
            "op": "remove_liquidity",
            "provider": "alice",
            "shares": 50_000_000,
            "min_rfl_output": 1,
            "min_usd_output": 1,
        },
        {
            "op": "reseed_pool",
            "actor": "admin",
            "rfl_amount": 50_000_000,
            "usd_amount": 50_000_000,
            "beneficiary": "dave",
            "min_lp_shares": 1,
        },
    ):
        _execute_recorded_operation(
            lifecycle_model,
            lifecycle_operations,
            operation,
        )
    lifecycle_expect = lifecycle_snapshot(lifecycle_model, lifecycle_accounts)
    route_events = lifecycle_expect["route_open_events"]
    if (
        lifecycle_expect["pool"]["active_epoch"] != 2
        or lifecycle_expect["epochs"]["1"]["status"] != "CLAIM_ONLY"
        or lifecycle_expect["epochs"]["2"]["status"] != "ACTIVE"
        or lifecycle_expect["epochs"]["1"]["terminal_rounding_reserve"] <= 0
        or len(route_events) != 1
        or route_events[0]["epoch"] != 2
        or route_events[0]["retired_residue_magnified"] <= 0
        or lifecycle_expect["wallets"]["bob"]["claimed"] <= 0
    ):
        raise RuntimeError("lifecycle vector lacks required epoch-two accounting evidence")

    quarantine_accounts = ("alice",)
    quarantine_model = ReflectionModel(**initial)
    quarantine_operations: list[dict[str, Any]] = []
    for operation in (
        {"op": "faucet_grant", "actor": "admin", "recipient": "alice", "amount": 10_000_000},
        {"op": "mint_quote", "actor": "admin", "recipient": "admin", "amount": 100_000_000},
        {
            "op": "seed_pool",
            "actor": "admin",
            "rfl_amount": 100_000_000,
            "usd_amount": 100_000_000,
            "beneficiary": "alice",
            "min_lp_shares": 1,
        },
        {
            "op": "sell",
            "seller": "alice",
            "gross_rfl": 5_000_000,
            "min_quote_out": 0,
        },
        {"op": "checkpoint_pool"},
        {"op": "claim_lp", "owner": "alice", "epoch_id": 1, "amount": 0},
        {
            "op": "sell",
            "seller": "alice",
            "gross_rfl": 5_000_000,
            "min_quote_out": 0,
        },
        {"op": "force_zero_denominator_receipt_for_test", "owner": "alice"},
    ):
        _execute_recorded_operation(
            quarantine_model,
            quarantine_operations,
            operation,
        )
    quarantine_expect = lifecycle_snapshot(quarantine_model, quarantine_accounts)
    quarantined_epoch = quarantine_expect["epochs"]["1"]
    if (
        not quarantined_epoch["quarantined"]
        or quarantined_epoch["status"] != "ACTIVE"
        or quarantined_epoch["total_shares"] != 0
        or quarantined_epoch["unallocated_rewards"] <= 0
        or quarantine_expect["custody_pending"] != 0
    ):
        raise RuntimeError("quarantine vector lacks a named zero-denominator receipt")

    return {
        "name": "epoch_lifecycle_and_zero_denominator_conformance",
        "initial": initial,
        "cases": [
            {
                "name": "shutdown_reseed_epoch_two",
                "accounts": list(lifecycle_accounts),
                "operations": lifecycle_operations,
                "expect": lifecycle_expect,
            },
            {
                "name": "zero_denominator_quarantine",
                "accounts": list(quarantine_accounts),
                "operations": quarantine_operations,
                "expect": quarantine_expect,
            },
        ],
    }


def setup_operations() -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    for account in ACCOUNTS:
        operations.append(
            {"op": "faucet_grant", "actor": "admin", "recipient": account, "amount": 500_000}
        )
    operations.append(
        {"op": "mint_quote", "actor": "admin", "recipient": "admin", "amount": 5_000_000}
    )
    for account in ACCOUNTS:
        operations.append(
            {"op": "mint_quote", "actor": "admin", "recipient": account, "amount": 1_000_000}
        )
    operations.append(
        {
            "op": "seed_pool",
            "actor": "admin",
            "rfl_amount": 2_000_000,
            "usd_amount": 2_000_000,
            "beneficiary": "alice",
            "min_lp_shares": 1,
        }
    )
    return operations


def candidate_operation(
    rng: random.Random,
    model: ReflectionModel,
) -> dict[str, Any] | None:
    first = ACCOUNTS[rng.randrange(len(ACCOUNTS))]
    second = ACCOUNTS[rng.randrange(len(ACCOUNTS))]
    if first == second:
        second = ACCOUNTS[(ACCOUNTS.index(first) + 1) % len(ACCOUNTS)]
    kind = rng.randrange(100)

    if kind < 18:
        available = model.raw_balance(first)
        if available:
            return {
                "op": "transfer",
                "sender": first,
                "recipient": second,
                "amount": rng.randint(1, min(available, 5_000)),
            }
    elif kind < 36:
        available = model.raw_balance(first)
        if available:
            return {
                "op": "sell",
                "seller": first,
                "gross_rfl": rng.randint(1, min(available, 5_000)),
                "min_quote_out": 0,
            }
    elif kind < 51:
        available = model.quote_balance(first)
        if available:
            return {
                "op": "buy",
                "buyer": first,
                "quote_in": rng.randint(1, min(available, 5_000)),
                "min_net_rfl_out": 0,
            }
    elif kind < 59:
        pending = model.pending(first)
        if pending:
            return {
                "op": "claim",
                "account": first,
                "amount": rng.randint(1, pending),
            }
    elif kind < 66:
        if model.pool_pending_rewards() > 0:
            return {"op": "checkpoint_pool"}
    elif kind < 75:
        rfl = model.raw_balance(first)
        usd = model.quote_balance(first)
        if rfl and usd:
            return {
                "op": "add_liquidity",
                "provider": first,
                "max_rfl": rng.randint(1, min(rfl, 2_000)),
                "max_usd": rng.randint(1, min(usd, 4_000)),
                "min_lp_shares": 1,
            }
    elif kind < 83:
        shares = model.lp_shares(1, first)
        if shares:
            return {
                "op": "transfer_lp_shares",
                "sender": first,
                "recipient": second,
                "shares": rng.randint(1, min(shares, 5_000)),
            }
    elif kind < 90:
        pending = model.lp_pending(1, first)
        if pending:
            return {
                "op": "claim_lp",
                "owner": first,
                "epoch_id": 1,
                "amount": rng.randint(1, pending),
            }
    elif kind < 97:
        owned = model.lp_shares(1, first)
        total = model.active_lp_epoch().total_shares
        if owned and total > 1:
            return {
                "op": "remove_liquidity",
                "provider": first,
                "shares": rng.randint(1, min(owned, total - 1, 5_000)),
                "min_rfl_output": 1,
                "min_usd_output": 1,
            }
    else:
        fee_bps = rng.randint(0, 100)
        if fee_bps == model.fee_bps:
            fee_bps = (fee_bps + 1) % 101
        return {"op": "set_fee_bps", "actor": "admin", "fee_bps": fee_bps}
    return None


def build_vector(seed: int, name: str) -> dict[str, Any]:
    model = ReflectionModel(
        fixed_supply=FIXED_SUPPLY,
        fee_bps=100,
        amm_fee_bps=30,
        automatic_materialization=False,
    )
    operations = setup_operations()
    for operation in operations:
        before = economic_state(model)
        model.apply_operation(operation)
        if economic_state(model) == before:
            raise RuntimeError(f"setup operation made no state transition: {operation}")
        model.assert_invariants()

    rng = random.Random(seed)
    generated: list[dict[str, Any]] = []
    attempts = 0
    unavailable = 0
    rejected = 0
    no_op = 0
    while len(generated) < GENERATED_OPERATION_COUNT and attempts < 10_000:
        attempts += 1
        operation = candidate_operation(rng, model)
        if operation is None:
            unavailable += 1
            continue
        before = economic_state(model)
        try:
            model.apply_operation(operation)
        except AccountingError:
            rejected += 1
            continue
        if economic_state(model) == before:
            no_op += 1
            continue
        model.assert_invariants()
        generated.append(operation)

    if len(generated) != GENERATED_OPERATION_COUNT:
        raise RuntimeError("could not generate the requested valid operation count")
    observed = {str(operation["op"]) for operation in generated}
    required = {
        "transfer",
        "sell",
        "buy",
        "claim",
        "checkpoint_pool",
        "add_liquidity",
        "remove_liquidity",
        "transfer_lp_shares",
        "claim_lp",
        "set_fee_bps",
    }
    if not required.issubset(observed):
        missing = ", ".join(sorted(required - observed))
        raise RuntimeError(f"seed does not exercise required operations: {missing}")

    return {
        "name": name,
        "generator": {
            "seed": seed,
            "generated_operation_count": GENERATED_OPERATION_COUNT,
            "attempt_count": attempts,
            "unavailable_candidate_count": unavailable,
            "rejected_candidate_count": rejected,
            "no_op_candidate_count": no_op,
            "algorithm": "Python random.Random fixed-seed valid-operation sampler",
            "admission_rule": "accepted operations must change non-event model state",
        },
        "initial": {
            "fixed_supply": FIXED_SUPPLY,
            "fee_bps": 100,
            "amm_fee_bps": 30,
            "automatic_materialization": False,
            "max_reserve_bps": 2_000,
            "max_gross_swap": 100_000_000_000,
        },
        "operations": operations + generated,
        "expect": model_snapshot(model),
    }


def _fee(amount: int, fee_bps: int) -> int:
    invariant_input = amount * (10_000 - fee_bps) // 10_000
    return amount - invariant_input


def _constant_product(
    reserve_in: int,
    reserve_out: int,
    gross_input: int,
    fee_bps: int,
) -> tuple[int, int]:
    charged = _fee(gross_input, fee_bps)
    invariant_input = gross_input - charged
    return reserve_out * invariant_input // (reserve_in + invariant_input), charged


def _integer_sqrt(value: int) -> int:
    if value < 2:
        return value
    current = value // 2 + 1
    next_value = (current + value // current) // 2
    while next_value < current:
        current = next_value
        next_value = (current + value // current) // 2
    return current


def _ceil_div(numerator: int, denominator: int) -> int:
    if numerator == 0:
        return 0
    return (numerator - 1) // denominator + 1


def _liquidity_mint(
    max_rfl: int,
    max_usd: int,
    reserve_rfl: int,
    reserve_usd: int,
    total_shares: int,
) -> tuple[int, int, int]:
    shares = min(
        max_rfl * total_shares // reserve_rfl,
        max_usd * total_shares // reserve_usd,
    )
    return (
        shares,
        _ceil_div(shares * reserve_rfl, total_shares),
        _ceil_div(shares * reserve_usd, total_shares),
    )


def _liquidity_withdrawal(
    shares: int,
    total_shares: int,
    reserve_rfl: int,
    reserve_usd: int,
) -> tuple[int, int]:
    if shares == total_shares:
        return reserve_rfl, reserve_usd
    return (
        shares * reserve_rfl // total_shares,
        shares * reserve_usd // total_shares,
    )


def build_arithmetic_vectors() -> dict[str, Any]:
    fee_inputs = (
        (0, 0),
        (1, 30),
        (1_801, 30),
        (MAX_U64, 0),
        (MAX_U64, 100),
        (MAX_U64, 10_000),
    )
    constant_product_inputs = (
        (1, 1, 0, 0),
        (1, 1, 1, 0),
        (MAX_U64, MAX_U64, 1, 30),
        (MAX_U64, MAX_U64, MAX_U64, 0),
        (MAX_U64, MAX_U64, MAX_U64, 100),
        (1, MAX_U64, MAX_U64, 0),
    )
    initial_share_inputs = (
        (0, MAX_U64),
        (1, 1),
        (2, 3),
        (1, MAX_U64),
        (MAX_U64, MAX_U64 - 1),
        (MAX_U64, MAX_U64),
    )
    mint_inputs = (
        (1, 1, MAX_U64, MAX_U64, 1),
        (25_000, 100_000, 800_000, 1_600_000, 1_131_370),
        (MAX_U64, MAX_U64, MAX_U64, MAX_U64, MAX_U64),
        (MAX_U64, MAX_U64, MAX_U64, MAX_U64, MAX_U128),
        # The first candidate exceeds u128, while the limiting candidate and
        # final result do not. Implementations must take the minimum in u256
        # before narrowing.
        (MAX_U64, 1, 1, MAX_U64, MAX_U128),
    )
    withdrawal_inputs = (
        (1, MAX_U128, MAX_U64, MAX_U64),
        (MAX_U128 - 1, MAX_U128, MAX_U64, MAX_U64),
        (MAX_U128, MAX_U128, MAX_U64, MAX_U64),
        (1, 3, 2, 5),
    )
    return {
        "name": "amm_u64_u128_arithmetic_boundaries",
        "limits": {"max_u64": MAX_U64, "max_u128": MAX_U128},
        "fee": [
            {"amount": amount, "fee_bps": bps, "expected_fee": _fee(amount, bps)}
            for amount, bps in fee_inputs
        ],
        "constant_product": [
            {
                "reserve_in": reserve_in,
                "reserve_out": reserve_out,
                "gross_input": gross_input,
                "fee_bps": bps,
                "expected_output": _constant_product(
                    reserve_in, reserve_out, gross_input, bps
                )[0],
                "expected_fee": _constant_product(
                    reserve_in, reserve_out, gross_input, bps
                )[1],
            }
            for reserve_in, reserve_out, gross_input, bps in constant_product_inputs
        ],
        "initial_lp_shares": [
            {
                "rfl_amount": rfl,
                "usd_amount": usd,
                "expected_shares": _integer_sqrt(rfl * usd),
            }
            for rfl, usd in initial_share_inputs
        ],
        "liquidity_mint": [
            {
                "max_rfl": max_rfl,
                "max_usd": max_usd,
                "reserve_rfl": reserve_rfl,
                "reserve_usd": reserve_usd,
                "total_shares": total_shares,
                "expected_shares": _liquidity_mint(
                    max_rfl, max_usd, reserve_rfl, reserve_usd, total_shares
                )[0],
                "expected_rfl_used": _liquidity_mint(
                    max_rfl, max_usd, reserve_rfl, reserve_usd, total_shares
                )[1],
                "expected_usd_used": _liquidity_mint(
                    max_rfl, max_usd, reserve_rfl, reserve_usd, total_shares
                )[2],
            }
            for max_rfl, max_usd, reserve_rfl, reserve_usd, total_shares in mint_inputs
        ],
        "liquidity_withdrawal": [
            {
                "shares": shares,
                "total_shares": total_shares,
                "reserve_rfl": reserve_rfl,
                "reserve_usd": reserve_usd,
                "expected_rfl_out": _liquidity_withdrawal(
                    shares, total_shares, reserve_rfl, reserve_usd
                )[0],
                "expected_usd_out": _liquidity_withdrawal(
                    shares, total_shares, reserve_rfl, reserve_usd
                )[1],
            }
            for shares, total_shares, reserve_rfl, reserve_usd in withdrawal_inputs
        ],
    }


def signer(account: str) -> str:
    if account not in ACCOUNTS:
        raise ValueError(f"no transaction signer for {account}")
    return account


def address(account: str) -> str:
    if account == "admin":
        return "signer::address_of(amm)"
    return f"signer::address_of({signer(account)})"


def render_operation(operation: dict[str, Any]) -> list[str]:
    op = operation["op"]
    if op == "register_wallet":
        account = operation.get("account", operation["actor"])
        return [f"reflection_token::register_wallet({signer(account)});"]
    if op == "faucet_grant":
        return [
            f"test_faucet::configure(assets, {operation['amount']}, 1, 0);",
            f"test_faucet::claim_trfl({signer(operation['recipient'])});",
        ]
    if op == "mint_quote":
        recipient = "amm" if operation["recipient"] == "admin" else signer(operation["recipient"])
        return [
            f"test_faucet::configure(assets, 1, {operation['amount']}, 0);",
            f"test_faucet::claim_tusd({recipient});",
        ]
    if op == "seed_pool":
        return [
            "pool::seed_liquidity(",
            f"    core, amm, {signer(operation['beneficiary'])}, {operation['rfl_amount']},",
            f"    {operation['usd_amount']}, {operation['min_lp_shares']},",
            ");",
        ]
    if op == "transfer":
        return [
            f"reflection_router::transfer({signer(operation['sender'])}, {address(operation['recipient'])}, {operation['amount']});"
        ]
    if op == "sell":
        return [
            f"pool::sell_trfl({signer(operation['seller'])}, {operation['gross_rfl']}, 0, 1_000);"
        ]
    if op == "buy":
        return [
            f"pool::buy_trfl({signer(operation['buyer'])}, {operation['quote_in']}, 0, 1_000);"
        ]
    if op == "claim":
        return [
            f"reflection_token::claim({signer(operation['account'])}, {operation['amount']});"
        ]
    if op == "checkpoint_pool":
        return ["pool::checkpoint_lp_rewards(alice);"]
    if op == "force_zero_denominator_receipt_for_test":
        return [
            "pool::force_zero_denominator_receipt_for_test("
            f"signer::address_of({signer(operation['owner'])}));"
        ]
    if op == "add_liquidity":
        return [
            "pool::add_liquidity(",
            f"    {signer(operation['provider'])}, {operation['max_rfl']}, {operation['max_usd']},",
            f"    {operation['min_lp_shares']}, 1_000,",
            ");",
        ]
    if op == "remove_liquidity":
        return [
            "pool::remove_liquidity(",
            f"    {signer(operation['provider'])}, {operation['shares']},",
            f"    {operation['min_rfl_output']}, {operation['min_usd_output']}, 1_000,",
            ");",
        ]
    if op == "transfer_lp_shares":
        return [
            f"pool::transfer_lp_shares({signer(operation['sender'])}, {address(operation['recipient'])}, {operation['shares']});"
        ]
    if op == "claim_lp":
        return [
            f"pool::claim_lp_rewards({signer(operation['owner'])}, {operation['epoch_id']}, {operation['amount']});"
        ]
    if op == "begin_shutdown":
        return ["pool::begin_shutdown(amm);"]
    if op == "reseed_pool":
        return [
            "pool::reseed_liquidity(",
            f"    core, amm, {signer(operation['beneficiary'])}, {operation['rfl_amount']},",
            f"    {operation['usd_amount']}, {operation['min_lp_shares']},",
            ");",
        ]
    if op == "set_fee_bps":
        return [f"reflection_token::set_fee_bps(core, {operation['fee_bps']});"]
    raise ValueError(f"unsupported generated Move operation: {op}")


def move_bool(value: bool) -> str:
    return "true" if value else "false"


def render_accounting_move_module(vector: dict[str, Any], ordinal: int) -> str:
    expected = vector["expect"]
    module_name = "seeded_conformance_generated"
    test_name = "seeded_python_move_conformance"
    if ordinal > 1:
        module_name = f"{module_name}_{ordinal}"
        test_name = f"{test_name}_{ordinal}"
    lines = [
        "// @generated by scripts/generate_seeded_conformance.py; do not edit.",
        "#[test_only]",
        f"module integration_tests::{module_name} {{",
        "    use cedra_framework::primary_fungible_store;",
        "    use cedra_framework::timestamp;",
        "    use reflection_core::reflection_router;",
        "    use reflection_core::reflection_token;",
        "    use std::signer;",
        "    use test_amm::pool;",
        "    use test_assets::mock_usd;",
        "    use test_assets::test_faucet;",
        "",
        "    fun setup(core: &signer, assets: &signer, amm: &signer, framework: &signer) {",
        "        timestamp::set_time_has_started_for_testing(framework);",
        "        reflection_token::initialize_claim_backed_for_test(core);",
        "        mock_usd::initialize_for_test(assets);",
        "        test_faucet::initialize(core, assets);",
        "        pool::initialize(core, assets, amm);",
        "    }",
        "",
        "    #[test(",
        "        core = @0xcafe,",
        "        assets = @0xbabe,",
        "        amm = @0xdead,",
        "        framework = @0x1,",
        "        alice = @0xa11ce,",
        "        bob = @0xb0b,",
        "        carol = @0xca401,",
        "        dave = @0xda7e,",
        "    )]",
        f"    fun {test_name}(",
        "        core: &signer,",
        "        assets: &signer,",
        "        amm: &signer,",
        "        framework: &signer,",
        "        alice: &signer,",
        "        bob: &signer,",
        "        carol: &signer,",
        "        dave: &signer,",
        "    ) {",
        "        setup(core, assets, amm, framework);",
        "",
    ]
    for index, operation in enumerate(vector["operations"]):
        lines.append(f"        // operation {index + 1}: {operation['op']}")
        lines.extend(f"        {line}" for line in render_operation(operation))

    aggregate = expected["aggregate_correction"]
    custody_correction = expected["custody_correction"]
    epoch = expected["lp_epoch"]
    lp_aggregate = epoch["aggregate_correction"]
    lines.extend(
        [
            "",
            "        let (index, remainder, shares, unallocated, lifetime_fees, materialized) =",
            "            reflection_token::global_accounting();",
            "        assert!(!reflection_token::automatic_materialization_enabled(), 1000);",
            "        let (amm_fee_bps, max_reserve_bps, max_gross_swap) = pool::limits();",
            f"        assert!(amm_fee_bps == {expected['swap_limits']['amm_fee_bps']}, 1001);",
            f"        assert!(max_reserve_bps == {expected['swap_limits']['max_reserve_bps']}, 1002);",
            f"        assert!(max_gross_swap == {expected['swap_limits']['max_gross_swap']}, 1003);",
            f"        assert!(reflection_token::fee_bps() == {expected['fee_bps']}, 1);",
            f"        assert!(index == {expected['index']}, 2);",
            f"        assert!(remainder == {expected['index_remainder']}, 3);",
            f"        assert!(shares == {expected['total_shares']}, 4);",
            f"        assert!(unallocated == {expected['unallocated_fees']}, 5);",
            f"        assert!(lifetime_fees == {expected['lifetime_fees']}, 6);",
            f"        assert!(materialized == {expected['lifetime_materialized']}, 7);",
            "        let (aggregate_negative, aggregate_magnitude) =",
            "            reflection_token::aggregate_correction();",
            f"        assert!(aggregate_negative == {move_bool(aggregate['negative'])}, 8);",
            f"        assert!(aggregate_magnitude == {aggregate['magnitude']}, 9);",
            "        let (custody_shares, routed, core_rounding) =",
            "            reflection_token::custody_accounting();",
            f"        assert!(custody_shares == {expected['custody_shares']}, 10);",
            f"        assert!(routed == {expected['lifetime_custody_routed']}, 11);",
            f"        assert!(core_rounding == {expected['rounding_reserve']}, 12);",
            "        let (_, custody_negative, custody_magnitude, custody_settled, custody_pending) =",
            "            reflection_token::custody_position_accounting();",
            f"        assert!(custody_negative == {move_bool(custody_correction['negative'])}, 13);",
            f"        assert!(custody_magnitude == {custody_correction['magnitude']}, 14);",
            f"        assert!(custody_settled == {expected['custody_settled']}, 15);",
            f"        assert!(custody_pending == {expected['custody_pending']}, 16);",
        ]
    )

    code = 20
    for account in ACCOUNTS:
        lines.append(
            f"        assert!(reflection_token::raw_balance(signer::address_of({account})) == {expected['raw'][account]}, {code});"
        )
        code += 1
        lines.append(
            f"        assert!(reflection_token::pending_rewards(signer::address_of({account})) == {expected['pending'][account]}, {code});"
        )
        code += 1
    lines.extend(
        [
            "        let (pool_rfl, pool_usd) = pool::reserves_view();",
            f"        assert!(pool_rfl == {expected['raw']['pool']}, {code});",
            f"        assert!(pool_usd == {expected['quote']['pool']}, {code + 1});",
            f"        assert!(reflection_token::pool_pending_rewards() == {expected['pending']['pool']}, {code + 2});",
            f"        assert!(reflection_token::reward_vault_balance() == {expected['raw']['reward_vault']}, {code + 3});",
            "        assert!(",
            "            reflection_token::raw_store_balance(reflection_token::distribution_vault())",
            f"                == {expected['raw']['distribution_vault']},",
            f"            {code + 4},",
            "        );",
        ]
    )
    code += 5
    for account in ACCOUNTS:
        lines.append(
            "        assert!(primary_fungible_store::balance("
            f"signer::address_of({account}), mock_usd::metadata()) == {expected['quote'][account]}, {code});"
        )
        code += 1
    lines.append(
        "        assert!(primary_fungible_store::balance("
        f"signer::address_of(amm), mock_usd::metadata()) == {expected['quote']['admin']}, {code});"
    )
    code += 1
    status = 1 if epoch["status"] == "ACTIVE" else 2
    lines.extend(
        [
            "        let (lp_status, lp_index, lp_remainder, lp_shares, lp_unallocated,",
            "            lp_rounding, lp_received, lp_claimed, lp_liability) =",
            "            pool::lp_epoch_accounting(1);",
            f"        assert!(lp_status == {status}, {code});",
            f"        assert!(lp_index == {epoch['index']}, {code + 1});",
            f"        assert!(lp_remainder == {epoch['index_remainder']}, {code + 2});",
            f"        assert!(lp_shares == {epoch['total_shares']}, {code + 3});",
            f"        assert!(lp_unallocated == {epoch['unallocated_rewards']}, {code + 4});",
            f"        assert!(lp_rounding == {epoch['rounding_reserve']}, {code + 5});",
            f"        assert!(lp_received == {epoch['lifetime_received']}, {code + 6});",
            f"        assert!(lp_claimed == {epoch['lifetime_claimed']}, {code + 7});",
            f"        assert!(lp_liability == {epoch['liability']}, {code + 8});",
            f"        assert!(pool::lp_reward_vault_balance(1) == {epoch['vault_balance']}, {code + 9});",
            "        let (terminal_rounding, retired_residue_magnified) =",
            "            pool::lp_epoch_terminal_dust(1);",
            f"        assert!(terminal_rounding == {epoch['terminal_rounding_reserve']}, 1004);",
            f"        assert!(retired_residue_magnified == {epoch['retired_residue_magnified']}, 1005);",
            "        let (lp_aggregate_negative, lp_aggregate_magnitude) =",
            "            test_amm::lp_rewards::epoch_aggregate_correction(1);",
            f"        assert!(lp_aggregate_negative == {move_bool(lp_aggregate['negative'])}, {code + 10});",
            f"        assert!(lp_aggregate_magnitude == {lp_aggregate['magnitude']}, {code + 11});",
        ]
    )
    code += 12
    for account in ACCOUNTS:
        position = epoch["positions"][account]
        correction = position["correction"]
        lines.extend(
            [
                "        let (owner_shares, negative, magnitude, claimed, pending) =",
                f"            test_amm::lp_rewards::position_accounting(1, signer::address_of({account}));",
                f"        assert!(owner_shares == {position['shares']}, {code});",
                f"        assert!(negative == {move_bool(correction['negative'])}, {code + 1});",
                f"        assert!(magnitude == {correction['magnitude']}, {code + 2});",
                f"        assert!(claimed == {position['claimed']}, {code + 3});",
                f"        assert!(pending == {position['pending']}, {code + 4});",
            ]
        )
        code += 5
    lines.extend(
        [
            "        assert!(",
            "            (pool::lp_reward_vault_balance(1) as u256)",
            "                == lp_liability + (lp_unallocated as u256) + (lp_rounding as u256),",
            f"            {code},",
            "        );",
            "        assert!(lp_received - lp_claimed == (pool::lp_reward_vault_balance(1) as u256),",
            f"            {code + 1});",
            "        reflection_token::assert_accounting_backing();",
            "    }",
            "}",
            "",
        ]
    )
    return "\n".join(lines)


def render_lifecycle_move_module(vector: dict[str, Any]) -> str:
    """Render compact exact-state tests for reseed and quarantine cases."""

    test_addresses = {
        "alice": "0xa11ce",
        "bob": "0xb0b",
        "carol": "0xca401",
        "dave": "0xda7e",
    }
    lines = [
        "// @generated by scripts/generate_seeded_conformance.py; do not edit.",
        "#[test_only]",
        "module integration_tests::lifecycle_conformance_generated {",
        "    use cedra_framework::primary_fungible_store;",
        "    use cedra_framework::timestamp;",
        "    use reflection_core::reflection_math;",
        "    use reflection_core::reflection_token;",
        "    use std::signer;",
        "    use test_amm::lp_rewards;",
        "    use test_amm::pool;",
        "    use test_assets::mock_usd;",
        "    use test_assets::test_faucet;",
        "",
        "    fun setup(core: &signer, assets: &signer, amm: &signer, framework: &signer) {",
        "        timestamp::set_time_has_started_for_testing(framework);",
        "        reflection_token::initialize_claim_backed_for_test(core);",
        "        mock_usd::initialize_for_test(assets);",
        "        test_faucet::initialize(core, assets);",
        "        pool::initialize(core, assets, amm);",
        "    }",
    ]

    for case_ordinal, case in enumerate(vector["cases"], start=1):
        accounts = tuple(case["accounts"])
        expected = case["expect"]
        code = case_ordinal * 2_000
        lines.extend(
            [
                "",
                "    #[test(",
                "        core = @0xcafe,",
                "        assets = @0xbabe,",
                "        amm = @0xdead,",
                "        framework = @0x1,",
            ]
        )
        for account in accounts:
            lines.append(f"        {account} = @{test_addresses[account]},")
        lines.extend(
            [
                "    )]",
                f"    fun {case['name']}(",
                "        core: &signer,",
                "        assets: &signer,",
                "        amm: &signer,",
                "        framework: &signer,",
            ]
        )
        for account in accounts:
            lines.append(f"        {account}: &signer,")
        lines.extend(["    ) {", "        setup(core, assets, amm, framework);"])

        route_events = {
            event["epoch"]: event
            for event in expected["route_open_events"]
        }
        for operation_index, operation in enumerate(case["operations"], start=1):
            lines.append(f"        // operation {operation_index}: {operation['op']}")
            if operation["op"] == "reseed_pool":
                route_epoch = expected["pool"]["active_epoch"]
                route_event = route_events[route_epoch]
                residue = route_event["retired_residue_magnified"]
                lines.extend(
                    [
                        "        let (_, route_negative, route_magnitude, route_claimed, route_pending) =",
                        "            reflection_token::custody_position_accounting();",
                        f"        assert!(!route_negative && route_pending == 0, {code});",
                        "        let route_normalized = route_claimed * reflection_math::magnitude();",
                        f"        assert!(route_magnitude >= route_normalized, {code + 1});",
                        f"        assert!(route_magnitude - route_normalized == {residue}, {code + 2});",
                    ]
                )
                code += 3
            lines.extend(f"        {line}" for line in render_operation(operation))

        aggregate = expected["aggregate_correction"]
        custody = expected["custody_correction"]
        pool_state = expected["pool"]
        lines.extend(
            [
                "",
                "        let (index, remainder, shares, unallocated, lifetime_fees, materialized) =",
                "            reflection_token::global_accounting();",
                f"        assert!(reflection_token::fixed_supply() == {expected['fixed_supply']}, {code});",
                f"        assert!(index == {expected['index']}, {code + 1});",
                f"        assert!(remainder == {expected['index_remainder']}, {code + 2});",
                f"        assert!(shares == {expected['total_shares']}, {code + 3});",
                f"        assert!(unallocated == {expected['unallocated_fees']}, {code + 4});",
                f"        assert!(lifetime_fees == {expected['lifetime_fees']}, {code + 5});",
                f"        assert!(materialized == {expected['lifetime_materialized']}, {code + 6});",
                "        let (aggregate_negative, aggregate_magnitude) =",
                "            reflection_token::aggregate_correction();",
                f"        assert!(aggregate_negative == {move_bool(aggregate['negative'])}, {code + 7});",
                f"        assert!(aggregate_magnitude == {aggregate['magnitude']}, {code + 8});",
                "        let (custody_shares, routed, core_rounding) =",
                "            reflection_token::custody_accounting();",
                f"        assert!(custody_shares == {expected['custody_shares']}, {code + 9});",
                f"        assert!(routed == {expected['lifetime_custody_routed']}, {code + 10});",
                f"        assert!(core_rounding == {expected['rounding_reserve']}, {code + 11});",
                "        let (_, custody_negative, custody_magnitude, custody_claimed, custody_pending) =",
                "            reflection_token::custody_position_accounting();",
                f"        assert!(custody_negative == {move_bool(custody['negative'])}, {code + 12});",
                f"        assert!(custody_magnitude == {custody['magnitude']}, {code + 13});",
                f"        assert!(custody_claimed == {expected['custody_settled']}, {code + 14});",
                f"        assert!(custody_pending == {expected['custody_pending']}, {code + 15});",
                f"        assert!(reflection_token::reward_vault_balance() == {expected['reward_vault_balance']}, {code + 16});",
                f"        assert!(reflection_token::distribution_vault_balance() == {expected['distribution_vault_balance']}, {code + 17});",
                "        let (pool_paused, liquidity_paused, lp_claims_paused, shutdown_mode, seeded) =",
                "            pool::pause_state();",
                f"        assert!(pool_paused == {move_bool(pool_state['pool_paused'])}, {code + 18});",
                f"        assert!(liquidity_paused == {move_bool(pool_state['liquidity_paused'])}, {code + 19});",
                f"        assert!(lp_claims_paused == {move_bool(pool_state['lp_claims_paused'])}, {code + 20});",
                f"        assert!(shutdown_mode == {move_bool(pool_state['shutdown_mode'])}, {code + 21});",
                f"        assert!(seeded == {move_bool(pool_state['seeded'])}, {code + 22});",
                f"        assert!(pool::active_epoch() == {pool_state['active_epoch']}, {code + 23});",
                "        let (reserve_rfl, reserve_usd) = pool::reserves_view();",
                f"        assert!(reserve_rfl == {pool_state['rfl_reserve']}, {code + 24});",
                f"        assert!(reserve_usd == {pool_state['usd_reserve']}, {code + 25});",
                "        assert!(primary_fungible_store::balance(",
                "            signer::address_of(amm), mock_usd::metadata(),",
                f"        ) == {expected['admin_quote']}, {code + 26});",
            ]
        )
        code += 27

        for account in accounts:
            wallet = expected["wallets"][account]
            correction = wallet["correction"]
            lines.extend(
                [
                    f"        assert!(reflection_token::wallet_is_registered(signer::address_of({account})) == {move_bool(wallet['registered'])}, {code});",
                    f"        assert!(reflection_token::raw_balance(signer::address_of({account})) == {wallet['raw']}, {code + 1});",
                    f"        assert!(reflection_token::pending_rewards(signer::address_of({account})) == {wallet['pending']}, {code + 2});",
                    "        let (wallet_negative, wallet_magnitude, wallet_claimed) =",
                    f"            reflection_token::wallet_position_accounting(signer::address_of({account}));",
                    f"        assert!(wallet_negative == {move_bool(correction['negative'])}, {code + 3});",
                    f"        assert!(wallet_magnitude == {correction['magnitude']}, {code + 4});",
                    f"        assert!(wallet_claimed == {wallet['claimed']}, {code + 5});",
                    "        assert!(primary_fungible_store::balance(",
                    f"            signer::address_of({account}), mock_usd::metadata(),",
                    f"        ) == {wallet['quote']}, {code + 6});",
                ]
            )
            code += 7

        for epoch_id_text, epoch in expected["epochs"].items():
            epoch_id = int(epoch_id_text)
            status = 1 if epoch["status"] == "ACTIVE" else 2
            lp_aggregate = epoch["aggregate_correction"]
            lines.extend(
                [
                    "        let (lp_status, lp_index, lp_remainder, lp_shares, lp_unallocated,",
                    "            lp_rounding, lp_received, lp_claimed, lp_liability) =",
                    f"            pool::lp_epoch_accounting({epoch_id});",
                    f"        assert!(lp_status == {status}, {code});",
                    f"        assert!(lp_index == {epoch['index']}, {code + 1});",
                    f"        assert!(lp_remainder == {epoch['index_remainder']}, {code + 2});",
                    f"        assert!(lp_shares == {epoch['total_shares']}, {code + 3});",
                    f"        assert!(lp_unallocated == {epoch['unallocated_rewards']}, {code + 4});",
                    f"        assert!(lp_rounding == {epoch['rounding_reserve']}, {code + 5});",
                    f"        assert!(lp_received == {epoch['lifetime_received']}, {code + 6});",
                    f"        assert!(lp_claimed == {epoch['lifetime_claimed']}, {code + 7});",
                    f"        assert!(lp_liability == {epoch['liability']}, {code + 8});",
                    f"        assert!(pool::lp_reward_vault_balance({epoch_id}) == {epoch['vault_balance']}, {code + 9});",
                    "        let (_, _, _, quarantined) =",
                    f"            lp_rewards::epoch_identity({epoch_id});",
                    f"        assert!(quarantined == {move_bool(epoch['quarantined'])}, {code + 10});",
                    "        let (terminal_rounding, retired_residue) =",
                    f"            pool::lp_epoch_terminal_dust({epoch_id});",
                    f"        assert!(terminal_rounding == {epoch['terminal_rounding_reserve']}, {code + 11});",
                    f"        assert!(retired_residue == {epoch['retired_residue_magnified']}, {code + 12});",
                    "        let (lp_aggregate_negative, lp_aggregate_magnitude) =",
                    f"            lp_rewards::epoch_aggregate_correction({epoch_id});",
                    f"        assert!(lp_aggregate_negative == {move_bool(lp_aggregate['negative'])}, {code + 13});",
                    f"        assert!(lp_aggregate_magnitude == {lp_aggregate['magnitude']}, {code + 14});",
                ]
            )
            code += 15
            for account in accounts:
                position = epoch["positions"][account]
                correction = position["correction"]
                lines.extend(
                    [
                        "        let (owner_shares, owner_negative, owner_magnitude, owner_claimed, owner_pending) =",
                        f"            lp_rewards::position_accounting({epoch_id}, signer::address_of({account}));",
                        f"        assert!(owner_shares == {position['shares']}, {code});",
                        f"        assert!(owner_negative == {move_bool(correction['negative'])}, {code + 1});",
                        f"        assert!(owner_magnitude == {correction['magnitude']}, {code + 2});",
                        f"        assert!(owner_claimed == {position['claimed']}, {code + 3});",
                        f"        assert!(owner_pending == {position['pending']}, {code + 4});",
                    ]
                )
                code += 5
        lines.extend(["        reflection_token::assert_accounting_backing();", "    }"])

    lines.extend(["}", ""])
    return "\n".join(lines)


def render_arithmetic_move_module(vector: dict[str, Any]) -> str:
    lines = [
        "// @generated by scripts/generate_seeded_conformance.py; do not edit.",
        "#[test_only]",
        "module integration_tests::amm_arithmetic_conformance_generated {",
        "    use test_amm::reflection_settlement;",
        "",
        "    #[test]",
        "    fun maximum_and_rounding_boundaries_match_python() {",
    ]
    code = 1
    for case in vector["fee"]:
        lines.append(
            "        assert!(reflection_settlement::fee("
            f"{case['amount']}, {case['fee_bps']}) == {case['expected_fee']}, {code});"
        )
        code += 1
    for case in vector["constant_product"]:
        lines.extend(
            [
                f"        let (output_{code}, fee_{code}) = reflection_settlement::constant_product_output(",
                f"            {case['reserve_in']}, {case['reserve_out']}, {case['gross_input']}, {case['fee_bps']},",
                "        );",
                f"        assert!(output_{code} == {case['expected_output']}, {code});",
                f"        assert!(fee_{code} == {case['expected_fee']}, {code + 1});",
            ]
        )
        code += 2
    for case in vector["initial_lp_shares"]:
        lines.append(
            "        assert!(reflection_settlement::initial_lp_shares("
            f"{case['rfl_amount']}, {case['usd_amount']}) == {case['expected_shares']}, {code});"
        )
        code += 1
    for case in vector["liquidity_mint"]:
        lines.extend(
            [
                f"        let (shares_{code}, rfl_{code}, usd_{code}) = reflection_settlement::liquidity_mint(",
                f"            {case['max_rfl']}, {case['max_usd']}, {case['reserve_rfl']},",
                f"            {case['reserve_usd']}, {case['total_shares']},",
                "        );",
                f"        assert!(shares_{code} == {case['expected_shares']}, {code});",
                f"        assert!(rfl_{code} == {case['expected_rfl_used']}, {code + 1});",
                f"        assert!(usd_{code} == {case['expected_usd_used']}, {code + 2});",
            ]
        )
        code += 3
    for case in vector["liquidity_withdrawal"]:
        lines.extend(
            [
                f"        let (rfl_{code}, usd_{code}) = reflection_settlement::liquidity_withdrawal(",
                f"            {case['shares']}, {case['total_shares']},",
                f"            {case['reserve_rfl']}, {case['reserve_usd']},",
                "        );",
                f"        assert!(rfl_{code} == {case['expected_rfl_out']}, {code});",
                f"        assert!(usd_{code} == {case['expected_usd_out']}, {code + 1});",
            ]
        )
        code += 2
    lines.extend(["    }", "}", ""])
    return "\n".join(lines)


def render_move(
    vectors: list[dict[str, Any]],
    arithmetic: dict[str, Any],
    lifecycle: dict[str, Any],
) -> str:
    modules = [
        render_accounting_move_module(vector, ordinal)
        for ordinal, vector in enumerate(vectors, start=1)
    ]
    modules.append(render_lifecycle_move_module(lifecycle))
    modules.append(render_arithmetic_move_module(arithmetic))
    return "\n".join(modules)


def serialized_vector(vector: dict[str, Any]) -> str:
    return json.dumps(vector, indent=2, sort_keys=False) + "\n"


def check_or_write(path: Path, expected: str, check: bool) -> bool:
    if check:
        actual = path.read_text(encoding="utf-8") if path.exists() else ""
        if actual != expected:
            print(f"stale generated conformance artifact: {path.relative_to(ROOT)}", file=sys.stderr)
            return False
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(expected, encoding="utf-8")
    print(f"generated {path.relative_to(ROOT)}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail instead of rewriting stale artifacts")
    args = parser.parse_args()
    vectors = [build_vector(seed, name) for seed, name, _ in SEED_SPECS]
    arithmetic = build_arithmetic_vectors()
    lifecycle = build_lifecycle_vector()
    results = [
        check_or_write(
            ROOT / "python" / "test_vectors" / filename,
            serialized_vector(vector),
            args.check,
        )
        for vector, (_, _, filename) in zip(vectors, SEED_SPECS, strict=True)
    ]
    results.append(
        check_or_write(
            ARITHMETIC_VECTOR_PATH,
            serialized_vector(arithmetic),
            args.check,
        )
    )
    results.append(
        check_or_write(
            LIFECYCLE_VECTOR_PATH,
            serialized_vector(lifecycle),
            args.check,
        )
    )
    results.append(
        check_or_write(
            MOVE_PATH,
            render_move(vectors, arithmetic, lifecycle),
            args.check,
        )
    )
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
