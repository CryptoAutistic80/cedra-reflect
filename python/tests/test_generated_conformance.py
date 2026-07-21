"""Drift, independence, transition, and arithmetic-boundary conformance tests."""

from __future__ import annotations

import json
import math
import runpy
import unittest
from pathlib import Path

from reflection_model import ReflectionModel


ROOT = Path(__file__).resolve().parents[2]
GENERATOR_PATH = ROOT / "scripts" / "generate_seeded_conformance.py"
GENERATOR = runpy.run_path(str(GENERATOR_PATH))
SEED_SPECS = GENERATOR["SEED_SPECS"]
ECONOMIC_STATE = GENERATOR["economic_state"]
MODEL_SNAPSHOT = GENERATOR["model_snapshot"]
LIFECYCLE_SNAPSHOT = GENERATOR["lifecycle_snapshot"]
LIFECYCLE_VECTOR_PATH = GENERATOR["LIFECYCLE_VECTOR_PATH"]
MAX_U64 = (1 << 64) - 1
MAX_U128 = (1 << 128) - 1
MAX_U256 = (1 << 256) - 1


class GeneratedAccountingConformanceTests(unittest.TestCase):
    def test_v01_vectors_remain_available_as_archived_replay_fixtures(self) -> None:
        # The old generator also emits a v0.1 Move test module and is therefore
        # no longer a production-v0.2 freshness gate. The archived JSON vectors
        # remain independently replayed by the tests below.
        for _, _, filename in SEED_SPECS:
            self.assertTrue((ROOT / "python" / "test_vectors" / filename).is_file())
        self.assertTrue(LIFECYCLE_VECTOR_PATH.is_file())

    def test_three_independent_seeded_sequences_replay_exactly_without_no_ops(self) -> None:
        seeds: list[int] = []
        serialized_sequences: list[str] = []
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

        for expected_seed, expected_name, filename in SEED_SPECS:
            path = ROOT / "python" / "test_vectors" / filename
            vector = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(vector["name"], expected_name)
            self.assertEqual(vector["generator"]["seed"], expected_seed)
            self.assertEqual(vector["generator"]["generated_operation_count"], 64)
            self.assertIs(vector["initial"]["automatic_materialization"], False)
            self.assertEqual(vector["initial"]["max_reserve_bps"], 2_000)
            self.assertEqual(vector["initial"]["max_gross_swap"], 100_000_000_000)
            self.assertEqual(
                vector["generator"]["admission_rule"],
                "accepted operations must change non-event model state",
            )

            model = ReflectionModel(**vector["initial"])
            self.assertFalse(model.automatic_materialization)
            for operation in vector["operations"]:
                before = ECONOMIC_STATE(model)
                model.apply_operation(operation)
                self.assertNotEqual(
                    ECONOMIC_STATE(model),
                    before,
                    f"accepted no-op in {filename}: {operation}",
                )
                model.assert_invariants()

            self.assertEqual(MODEL_SNAPSHOT(model), vector["expect"])
            generated = vector["operations"][-64:]
            self.assertTrue(required.issubset({operation["op"] for operation in generated}))
            seeds.append(expected_seed)
            serialized_sequences.append(json.dumps(generated, sort_keys=True))

        self.assertEqual(len(set(seeds)), 3)
        self.assertEqual(len(set(serialized_sequences)), 3)

    def test_lifecycle_and_quarantine_cases_replay_exactly(self) -> None:
        vector = json.loads(LIFECYCLE_VECTOR_PATH.read_text(encoding="utf-8"))
        self.assertEqual(vector["initial"]["fixed_supply"], 1_000_000_000_000_000)
        cases = {case["name"]: case for case in vector["cases"]}
        self.assertEqual(
            set(cases),
            {"shutdown_reseed_epoch_two", "zero_denominator_quarantine"},
        )

        for case in cases.values():
            model = ReflectionModel(**vector["initial"])
            for operation in case["operations"]:
                model.apply_operation(operation)
                model.assert_invariants()
            self.assertEqual(
                LIFECYCLE_SNAPSHOT(model, tuple(case["accounts"])),
                case["expect"],
            )

        lifecycle = cases["shutdown_reseed_epoch_two"]["expect"]
        self.assertEqual(lifecycle["pool"]["active_epoch"], 2)
        self.assertEqual(lifecycle["epochs"]["1"]["status"], "CLAIM_ONLY")
        self.assertEqual(lifecycle["epochs"]["2"]["status"], "ACTIVE")
        self.assertGreater(lifecycle["epochs"]["1"]["terminal_rounding_reserve"], 0)
        self.assertGreater(
            lifecycle["route_open_events"][0]["retired_residue_magnified"],
            0,
        )
        self.assertGreater(lifecycle["wallets"]["bob"]["claimed"], 0)
        self.assertGreater(lifecycle["wallets"]["bob"]["correction"]["magnitude"], 0)

        quarantine = cases["zero_denominator_quarantine"]["expect"]
        self.assertEqual(quarantine["pool"]["active_epoch"], 1)
        self.assertTrue(quarantine["epochs"]["1"]["quarantined"])
        self.assertEqual(quarantine["epochs"]["1"]["total_shares"], 0)
        self.assertGreater(quarantine["epochs"]["1"]["unallocated_rewards"], 0)
        self.assertEqual(quarantine["custody_pending"], 0)


class AmmArithmeticBoundaryVectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vector = json.loads(
            (ROOT / "python" / "test_vectors" / "amm_arithmetic_boundaries.json").read_text(
                encoding="utf-8"
            )
        )

    def test_widened_intermediates_cover_full_input_types(self) -> None:
        # These are the widest products formed by fee/constant-product and LP
        # arithmetic. They fit their Move intermediate types before division.
        self.assertLessEqual(MAX_U64 * 10_000, MAX_U128)
        self.assertLessEqual(MAX_U64 * MAX_U64, MAX_U128)
        self.assertLessEqual(MAX_U64 * MAX_U128, MAX_U256)

    def test_fee_and_constant_product_vectors(self) -> None:
        for case in self.vector["fee"]:
            invariant_input = case["amount"] * (10_000 - case["fee_bps"]) // 10_000
            self.assertLessEqual(invariant_input, MAX_U64)
            self.assertEqual(case["amount"] - invariant_input, case["expected_fee"])

        for case in self.vector["constant_product"]:
            charged = case["gross_input"] - (
                case["gross_input"] * (10_000 - case["fee_bps"]) // 10_000
            )
            invariant_input = case["gross_input"] - charged
            output = (
                case["reserve_out"]
                * invariant_input
                // (case["reserve_in"] + invariant_input)
            )
            self.assertLessEqual(output, MAX_U64)
            self.assertLess(output, case["reserve_out"] + 1)
            self.assertEqual(output, case["expected_output"])
            self.assertEqual(charged, case["expected_fee"])

    def test_initial_share_vectors_include_exact_and_floor_sqrt_boundaries(self) -> None:
        for case in self.vector["initial_lp_shares"]:
            product = case["rfl_amount"] * case["usd_amount"]
            self.assertLessEqual(product, MAX_U128)
            expected = math.isqrt(product)
            self.assertLessEqual(expected, MAX_U64)
            self.assertEqual(expected, case["expected_shares"])

    def test_liquidity_mint_vectors_narrow_only_the_limiting_candidate(self) -> None:
        saw_non_limiting_u128_overflow = False
        for case in self.vector["liquidity_mint"]:
            rfl_candidate = (
                case["max_rfl"] * case["total_shares"] // case["reserve_rfl"]
            )
            usd_candidate = (
                case["max_usd"] * case["total_shares"] // case["reserve_usd"]
            )
            shares = min(rfl_candidate, usd_candidate)
            if max(rfl_candidate, usd_candidate) > MAX_U128:
                saw_non_limiting_u128_overflow = True
            self.assertLessEqual(shares, MAX_U128)
            rfl_used = (
                0
                if shares == 0
                else (shares * case["reserve_rfl"] - 1) // case["total_shares"] + 1
            )
            usd_used = (
                0
                if shares == 0
                else (shares * case["reserve_usd"] - 1) // case["total_shares"] + 1
            )
            self.assertLessEqual(rfl_used, MAX_U64)
            self.assertLessEqual(usd_used, MAX_U64)
            self.assertEqual(shares, case["expected_shares"])
            self.assertEqual(rfl_used, case["expected_rfl_used"])
            self.assertEqual(usd_used, case["expected_usd_used"])
        self.assertTrue(saw_non_limiting_u128_overflow)

    def test_liquidity_withdrawal_vectors_are_bounded_by_reserves(self) -> None:
        for case in self.vector["liquidity_withdrawal"]:
            self.assertGreater(case["shares"], 0)
            self.assertLessEqual(case["shares"], case["total_shares"])
            if case["shares"] == case["total_shares"]:
                rfl_out, usd_out = case["reserve_rfl"], case["reserve_usd"]
            else:
                rfl_out = (
                    case["shares"] * case["reserve_rfl"] // case["total_shares"]
                )
                usd_out = (
                    case["shares"] * case["reserve_usd"] // case["total_shares"]
                )
            self.assertLessEqual(rfl_out, case["reserve_rfl"])
            self.assertLessEqual(usd_out, case["reserve_usd"])
            self.assertEqual(rfl_out, case["expected_rfl_out"])
            self.assertEqual(usd_out, case["expected_usd_out"])


if __name__ == "__main__":
    unittest.main()
