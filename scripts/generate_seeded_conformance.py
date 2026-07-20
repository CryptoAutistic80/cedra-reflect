#!/usr/bin/env python3
"""Generate one seeded Python/Move accounting-conformance witness.

The independent Python model chooses and executes a fixed-seed sequence of
valid wallet, swap, custody, liquidity, LP-transfer, and claim operations.  The
same concrete sequence and resulting snapshot are emitted as a Move test.  CI
uses ``--check`` so model, vector, and Move witness cannot drift silently.
"""

from __future__ import annotations

import argparse
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


SEED = 0xCEDA20260720
GENERATED_OPERATION_COUNT = 64
FIXED_SUPPLY = 1_000_000_000_000_000
ACCOUNTS = ("alice", "bob", "carol", "dave")
VECTOR_PATH = ROOT / "python" / "test_vectors" / "seeded_mixed_accounting.json"
MOVE_PATH = (
    ROOT
    / "move"
    / "integration-tests"
    / "tests"
    / "seeded_conformance_generated.move"
)


def signed(value: int) -> dict[str, int | bool]:
    return {"negative": value < 0, "magnitude": abs(value)}


def model_snapshot(model: ReflectionModel) -> dict[str, Any]:
    epoch = model.lp_epoch(1)
    raw_accounts = (*ACCOUNTS, "pool", "reward_vault", "distribution_vault", epoch.vault)
    quote_accounts = (*ACCOUNTS, "admin", "pool")
    return {
        "fee_bps": model.fee_bps,
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
        available = model.effective_balance(first)
        if available:
            return {
                "op": "transfer",
                "sender": first,
                "recipient": second,
                "amount": rng.randint(1, min(available, 5_000)),
            }
    elif kind < 36:
        available = model.effective_balance(first)
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
        return {"op": "checkpoint_pool"}
    elif kind < 75:
        rfl = model.effective_balance(first)
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
        return {"op": "set_fee_bps", "actor": "admin", "fee_bps": rng.randint(0, 100)}
    return None


def build_vector() -> dict[str, Any]:
    model = ReflectionModel(fixed_supply=FIXED_SUPPLY, fee_bps=100, amm_fee_bps=30)
    operations = setup_operations()
    for operation in operations:
        model.apply_operation(operation)
        model.assert_invariants()

    rng = random.Random(SEED)
    generated: list[dict[str, Any]] = []
    attempts = 0
    while len(generated) < GENERATED_OPERATION_COUNT and attempts < 10_000:
        attempts += 1
        operation = candidate_operation(rng, model)
        if operation is None:
            continue
        try:
            model.apply_operation(operation)
        except AccountingError:
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
        "name": "seeded_mixed_wallet_custody_lp_conformance",
        "generator": {
            "seed": SEED,
            "generated_operation_count": GENERATED_OPERATION_COUNT,
            "algorithm": "Python random.Random fixed-seed valid-operation sampler",
        },
        "initial": {"fixed_supply": FIXED_SUPPLY, "fee_bps": 100, "amm_fee_bps": 30},
        "operations": operations + generated,
        "expect": model_snapshot(model),
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
            f"    core, amm, {address(operation['beneficiary'])}, {operation['rfl_amount']},",
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
    if op == "set_fee_bps":
        return [f"reflection_token::set_fee_bps(core, {operation['fee_bps']});"]
    raise ValueError(f"unsupported generated Move operation: {op}")


def move_bool(value: bool) -> str:
    return "true" if value else "false"


def render_move(vector: dict[str, Any]) -> str:
    expected = vector["expect"]
    lines = [
        "// @generated by scripts/generate_seeded_conformance.py; do not edit.",
        "#[test_only]",
        "module integration_tests::seeded_conformance_generated {",
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
        "        reflection_token::initialize_for_test(core);",
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
        "    fun seeded_python_move_conformance(",
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
    vector = build_vector()
    ok_vector = check_or_write(VECTOR_PATH, serialized_vector(vector), args.check)
    ok_move = check_or_write(MOVE_PATH, render_move(vector), args.check)
    return 0 if ok_vector and ok_move else 1


if __name__ == "__main__":
    raise SystemExit(main())
