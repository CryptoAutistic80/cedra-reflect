"""Deterministic, invariant, adversarial, epoch, and randomized model tests.

The default randomized workload is bounded for normal CI.  Set
``REFLECTION_MODEL_OPERATIONS=1000000`` and increase
``REFLECTION_MODEL_HOLDERS`` for the quantitative long-run gate.
"""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from reflection_model import (
    AccountingError,
    AuthorizationError,
    LP_ACTIVE,
    LP_CLAIM_ONLY,
    PoolBypassError,
    ReflectionModel,
)
from reflection_model.model import MAGNITUDE, MAX_U64, MAX_U128, MAX_U256
from reflection_model.workload import (
    APPLIED,
    NOOP,
    REJECTED,
    GitProvenance,
    WorkloadConfig,
    WorkloadCounters,
    WorkloadExhaustedError,
    config_from_environment,
    run_randomized_workload,
)


ROOT = Path(__file__).resolve().parents[2]
VECTOR_PATH = ROOT / "python" / "test_vectors" / "basic_accounting.json"


def configured_model(*, automatic_materialization: bool = False) -> ReflectionModel:
    model = ReflectionModel(
        fixed_supply=5_000_000,
        fee_bps=100,
        amm_fee_bps=30,
        automatic_materialization=automatic_materialization,
    )
    model.faucet_grant("admin", "alice", 400_000)
    model.faucet_grant("admin", "bob", 300_000)
    model.faucet_grant("admin", "carol", 200_000)
    model.mint_quote("admin", "admin", 3_000_000)
    model.mint_quote("admin", "alice", 500_000)
    model.mint_quote("admin", "bob", 500_000)
    model.mint_quote("admin", "carol", 500_000)
    model.seed_pool(
        "admin",
        800_000,
        1_600_000,
        beneficiary="alice",
        min_lp_shares=1,
    )
    model.assert_invariants()
    return model


def accounting_state(model: ReflectionModel) -> dict[str, object]:
    """Deep state copy used only to prove rejected calls are atomic."""
    return copy.deepcopy(model.__dict__)


class DeterministicVectorTests(unittest.TestCase):
    def test_wallet_custody_lp_vector(self) -> None:
        with VECTOR_PATH.open(encoding="utf-8") as handle:
            vector = json.load(handle)
        self.assertEqual(vector["initial"]["fixed_supply"], 1_000_000_000_000_000)
        model = ReflectionModel(**vector["initial"])
        for operation in vector["operations"]:
            model.apply_operation(operation)
            model.assert_invariants()

        expected = vector["expect"]
        self.assertEqual(model.index, expected["index"])
        self.assertEqual(model.index_remainder, expected["index_remainder"])
        self.assertEqual(model.total_shares, expected["total_shares"])
        self.assertEqual(model.lifetime_fees, expected["lifetime_fees"])
        self.assertEqual(model.lifetime_materialized, expected["lifetime_materialized"])
        self.assertEqual(model.lifetime_custody_routed, expected["lifetime_custody_routed"])
        self.assertEqual(model.rounding_reserve, expected["rounding_reserve"])
        self.assertEqual(model.custody_shares, expected["custody_shares"])
        self.assertEqual(model.custody_settled, expected["custody_settled"])
        self.assertEqual(
            {account: model.raw_balance(account) for account in expected["raw"]},
            expected["raw"],
        )
        self.assertEqual(
            {account: model.pending(account) for account in expected["pending"]},
            expected["pending"],
        )
        epoch = model.lp_epoch(expected["lp_epoch"]["epoch_id"])
        self.assertEqual(epoch.status, expected["lp_epoch"]["status"])
        self.assertEqual(epoch.index, expected["lp_epoch"]["index"])
        self.assertEqual(epoch.index_remainder, expected["lp_epoch"]["index_remainder"])
        self.assertEqual(epoch.total_shares, expected["lp_epoch"]["total_shares"])
        self.assertEqual(epoch.lifetime_received, expected["lp_epoch"]["lifetime_received"])
        self.assertEqual(epoch.lifetime_claimed, expected["lp_epoch"]["lifetime_claimed"])
        self.assertEqual(epoch.rounding_reserve, expected["lp_epoch"]["rounding_reserve"])
        self.assertEqual(
            {account: epoch.pending(account) for account in expected["lp_pending"]},
            expected["lp_pending"],
        )

class CoreWalletAndCustodyInvariantTests(unittest.TestCase):
    def test_core_vault_has_exact_named_bucket_identity(self) -> None:
        model = configured_model()
        model.sell("bob", 40_000)
        self.assertEqual(
            model.reward_vault_balance,
            model.reflection_liability() + model.unallocated_fees + model.rounding_reserve,
        )
        self.assertEqual(
            model.reward_vault_balance,
            model.lifetime_fees
            - model.lifetime_materialized
            - model.lifetime_custody_routed,
        )
        model.assert_invariants()

    def test_wallet_claim_preserves_effective_value_and_exact_backing(self) -> None:
        model = configured_model()
        model.sell("bob", 40_000)
        before = model.effective_balance("alice")
        pending = model.pending("alice")
        self.assertGreater(pending, 1)
        claimed = model.claim("alice", pending // 2)
        self.assertEqual(model.effective_balance("alice"), before)
        self.assertEqual(model.pending("alice"), pending - claimed)
        self.assertEqual(
            model.reward_vault_balance,
            model.reflection_liability() + model.unallocated_fees + model.rounding_reserve,
        )
        model.assert_invariants()

    def test_wallet_transfer_preserves_entitlement_and_total_effective_value(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        before_total = model.total_effective_eligible()
        alice_before = model.effective_balance("alice")
        carol_before = model.effective_balance("carol")
        model.transfer("alice", "carol", 12_345)
        self.assertEqual(model.total_effective_eligible(), before_total)
        self.assertEqual(model.effective_balance("alice"), alice_before - 12_345)
        self.assertEqual(model.effective_balance("carol"), carol_before + 12_345)
        model.assert_invariants()

    def test_pool_is_one_eligible_custody_position_and_receives_pro_rata_fee(self) -> None:
        model = configured_model()
        reserve_before = model.pool_rfl_reserve
        pool_correction_before = model.custody_correction
        pool_settled_before = model.custody_settled
        result = model.sell("bob", 10_000)
        expected_pool_accrued = (
            reserve_before * model.index + pool_correction_before
        ) // MAGNITUDE
        self.assertEqual(model.pool_pending_rewards(), expected_pool_accrued - pool_settled_before)
        self.assertGreater(model.pool_pending_rewards(), 0)
        self.assertEqual(model.pool_rfl_reserve, reserve_before + result.net_rfl_amount)
        self.assertEqual(model.custody_shares, model.pool_rfl_reserve)
        self.assertNotIn("pool", model.registered_wallets)
        self.assertEqual(
            model.total_shares,
            sum(model.raw_balance(a) for a in model.registered_wallets) + model.custody_shares,
        )
        model.assert_invariants()

    def test_sell_net_reserve_units_do_not_receive_their_own_fee(self) -> None:
        model = configured_model()
        reserve_before = model.pool_rfl_reserve
        correction_before = model.custody_correction
        settled_before = model.custody_settled
        result = model.sell("bob", 12_345)
        expected = (reserve_before * model.index + correction_before) // MAGNITUDE - settled_before
        self.assertEqual(model.pool_pending_rewards(), expected)
        self.assertEqual(model.pool_rfl_reserve, reserve_before + result.net_rfl_amount)
        self.assertEqual(result.reflection_fee, 123)
        model.assert_invariants()

    def test_buy_removes_custody_before_fee_and_new_wallet_units_capture_no_history(self) -> None:
        model = configured_model()
        model.mint_quote("admin", "dave", 100_000)
        pool_before = model.pool_rfl_reserve
        result = model.buy("dave", 10_000)
        self.assertTrue(model.wallet_is_registered("dave"))
        self.assertEqual(model.raw_balance("dave"), result.net_rfl_amount)
        self.assertEqual(model.pending("dave"), 0)
        self.assertEqual(model.pool_rfl_reserve, pool_before - result.gross_amount)
        self.assertEqual(model.custody_shares, model.pool_rfl_reserve)
        model.assert_invariants()

    def test_automatic_materialisation_supports_wallet_and_liquidity_spends(self) -> None:
        model = configured_model(automatic_materialization=True)
        model.configure_swap_limits("admin", 30, 10_000, 100_000_000_000)
        model.sell("bob", model.raw_balance("bob"))
        pending = model.pending("alice")
        self.assertGreater(pending, 0)
        amount = model.raw_balance("alice") + min(5, pending)
        model.transfer("alice", "carol", amount)
        self.assertGreater(model.materialized["alice"], 0)
        model.assert_invariants()

    def test_tiny_fee_floor_and_policy_bound(self) -> None:
        model = configured_model()
        self.assertEqual(model._reflection_fee(99), 0)
        for amount in (1, 99, 100, 101, 12_345, MAX_U128):
            fee = model._reflection_fee(amount)
            self.assertLessEqual(fee * 10_000, amount * 100)

    def test_zero_core_denominator_is_named_unallocated_not_future_entitlement(self) -> None:
        model = ReflectionModel(fixed_supply=1_000, fee_bps=100)
        model._debit_excluded("distribution_vault", 10)
        model._credit_excluded("reward_vault", 10)
        model._advance_index(10)
        self.assertEqual(model.index, 0)
        self.assertEqual(model.unallocated_fees, 10)
        self.assertEqual(model.rounding_reserve, 0)
        model.register_wallet("alice")
        model.faucet_grant("admin", "alice", 100)
        self.assertEqual(model.pending("alice"), 0)
        model.assert_invariants()


class LpRewardAndLiquidityInvariantTests(unittest.TestCase):
    def test_liquidity_limit_defaults_and_admin_configuration(self) -> None:
        model = configured_model()
        self.assertEqual(
            model.liquidity_limits(),
            (100_000_000_000, 100_000_000_000, 10_000),
        )
        with self.assertRaises(AuthorizationError):
            model.configure_liquidity_limits("attacker", 1, 1, 1)
        for limits in ((0, 1, 1), (1, 0, 1), (1, 1, 0), (1, 1, 10_001)):
            with self.assertRaises(AccountingError):
                model.configure_liquidity_limits("admin", *limits)
        model.configure_liquidity_limits("admin", 10_000, 20_000, 2_500)
        self.assertEqual(model.liquidity_limits(), (10_000, 20_000, 2_500))
        model.assert_invariants()

    def test_contribution_caps_apply_to_actual_used_amounts_not_user_maxima(self) -> None:
        model = configured_model()
        model.configure_liquidity_limits("admin", 10_000, 20_000, 10_000)

        # The tUSD maximum exceeds the configured cap, but the proportional
        # amount actually consumed does not, so the contribution is valid.
        result = model.add_liquidity("carol", 10_000, 100_000)
        self.assertLessEqual(result.rfl_amount, 10_000)
        self.assertLessEqual(result.usd_amount, 20_000)
        self.assertGreater(100_000, model.max_liquidity_usd)

        model.configure_liquidity_limits(
            "admin", result.rfl_amount - 1, result.usd_amount, 10_000
        )
        before = accounting_state(model)
        with self.assertRaises(AccountingError):
            model.add_liquidity("bob", 10_000, 100_000)
        self.assertEqual(accounting_state(model), before)
        model.assert_invariants()

    def test_non_final_withdrawal_share_cap_and_final_shutdown_exemption(self) -> None:
        model = configured_model()
        model.configure_liquidity_limits(
            "admin", 100_000_000_000, 100_000_000_000, 2_500
        )
        total = model.active_lp_epoch().total_shares
        allowed = total * 2_500 // 10_000
        before = accounting_state(model)
        with self.assertRaises(AccountingError):
            model.remove_liquidity("alice", allowed + 1)
        self.assertEqual(accounting_state(model), before)
        result = model.remove_liquidity("alice", allowed)
        self.assertFalse(result.final_exit)

        final_model = configured_model()
        final_model.configure_liquidity_limits(
            "admin", 100_000_000_000, 100_000_000_000, 1
        )
        final_model.begin_shutdown("admin")
        final = final_model.remove_liquidity(
            "alice", final_model.active_lp_epoch().total_shares
        )
        self.assertTrue(final.final_exit)
        self.assertEqual(final_model.lp_epoch(1).status, LP_CLAIM_ONLY)
        final_model.assert_invariants()

    def test_shutdown_fragmented_one_sided_exit_is_cap_independent(self) -> None:
        model = ReflectionModel(fixed_supply=1_000)
        model.mint_quote("admin", "admin", 100)
        model.seed_pool("admin", 1, 100, beneficiary="alice")
        model.register_wallet("bob")
        model.transfer_lp_shares("alice", "bob", 5)
        self.assertEqual(model.lp_shares(1, "alice"), 5)
        self.assertEqual(model.lp_shares(1, "bob"), 5)
        model.configure_liquidity_limits("admin", 1, 100, 1)

        # Routine operation keeps the conservative two-sided output rule.
        before = accounting_state(model)
        with self.assertRaises(AccountingError):
            model.remove_liquidity(
                "bob", 5, min_rfl_output=0, min_usd_output=50
            )
        self.assertEqual(accounting_state(model), before)

        # Shutdown bypasses the 1-bps operator cap and lets Bob take the USD
        # side even though his proportional tRFL side floors to zero.
        model.begin_shutdown("admin")
        before = accounting_state(model)
        with self.assertRaises(AccountingError):
            model.remove_liquidity(
                "bob", 5, min_rfl_output=1, min_usd_output=50
            )
        self.assertEqual(accounting_state(model), before)
        first = model.remove_liquidity(
            "bob", 5, min_rfl_output=0, min_usd_output=50
        )
        self.assertEqual((first.rfl_amount, first.usd_amount), (0, 50))
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), (1, 50))
        second = model.remove_liquidity(
            "alice", 5, min_rfl_output=1, min_usd_output=50
        )
        self.assertEqual((second.rfl_amount, second.usd_amount), (1, 50))
        self.assertTrue(second.final_exit)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), (0, 0))
        model.assert_invariants()

    def test_active_epoch_health_preflights_all_live_pool_paths(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        model.checkpoint_pool()
        self.assertGreater(model.lp_pending(1, "alice"), 0)
        epoch = model.active_lp_epoch()
        epoch.quarantined = True
        before = accounting_state(model)
        live_operations = (
            lambda: model.sell("bob", 100),
            lambda: model.buy("bob", 100),
            model.checkpoint_pool,
            lambda: model.add_liquidity("carol", 1_000, 2_000),
            lambda: model.remove_liquidity("alice", 1),
            lambda: model.transfer_lp_shares("alice", "bob", 1),
        )
        for operation in live_operations:
            with self.assertRaises(AccountingError):
                operation()
            self.assertEqual(accounting_state(model), before)

        # A claim against pre-quarantine index history remains live and must
        # not invoke the unhealthy active-epoch checkpoint.
        with patch.object(
            model,
            "_checkpoint_active",
            side_effect=AssertionError("quarantined claim checkpointed"),
        ):
            model.claim_lp("alice", 1, 1)

        epoch.quarantined = False
        original_shares = epoch.total_shares
        epoch.total_shares = 0
        with self.assertRaises(AccountingError):
            model.checkpoint_pool()
        epoch.total_shares = original_shares
        epoch.status = LP_CLAIM_ONLY
        with self.assertRaises(AccountingError):
            model.checkpoint_pool()
        epoch.status = LP_ACTIVE
        model.assert_invariants()

    def test_checkpoint_moves_exact_value_between_vaults_without_mutating_reserves(self) -> None:
        model = configured_model()
        model.sell("bob", 30_000)
        routed = model.pool_pending_rewards()
        self.assertGreater(routed, 0)
        before_core = model.reward_vault_balance
        before_lp = model.lp_vault_balance(1)
        before_reserves = (model.pool_rfl_reserve, model.pool_usd_reserve)
        before_k = model.pool_rfl_reserve * model.pool_usd_reserve
        self.assertEqual(model.checkpoint_pool(), routed)
        self.assertEqual(model.reward_vault_balance, before_core - routed)
        self.assertEqual(model.lp_vault_balance(1), before_lp + routed)
        self.assertEqual(model.pool_pending_rewards(), 0)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), before_reserves)
        self.assertEqual(model.pool_rfl_reserve * model.pool_usd_reserve, before_k)
        model.assert_invariants()

    def test_add_liquidity_checkpoints_before_mint_so_new_shares_capture_no_history(self) -> None:
        model = configured_model()
        model.sell("bob", 35_000)
        historical = model.pool_pending_rewards()
        self.assertGreater(historical, 0)
        alice_before = model.lp_pending(1, "alice")
        result = model.add_liquidity("carol", 20_000, 40_000)
        self.assertGreater(result.lp_shares, 0)
        self.assertEqual(model.lp_pending(1, "carol"), 0)
        self.assertGreater(model.lp_pending(1, "alice"), alice_before)
        self.assertEqual(model.lp_epoch(1).lifetime_received, historical)
        model.assert_invariants()

    def test_liquidity_add_uses_only_proportional_ceil_inputs(self) -> None:
        model = configured_model()
        carol_rfl = model.raw_balance("carol")
        carol_usd = model.quote_balance("carol")
        reserve_rfl = model.pool_rfl_reserve
        reserve_usd = model.pool_usd_reserve
        total = model.active_lp_epoch().total_shares
        expected = model.liquidity_mint_amounts(25_000, 100_000, reserve_rfl, reserve_usd, total)
        result = model.add_liquidity("carol", 25_000, 100_000)
        self.assertEqual((result.lp_shares, result.rfl_amount, result.usd_amount), expected)
        self.assertEqual(model.raw_balance("carol"), carol_rfl - result.rfl_amount)
        self.assertEqual(model.quote_balance("carol"), carol_usd - result.usd_amount)
        self.assertLess(result.usd_amount, 100_000)
        model.assert_invariants()

    def test_lp_transfer_preserves_prior_rewards_for_sender_and_recipient(self) -> None:
        model = configured_model()
        model.add_liquidity("carol", 30_000, 60_000)
        model.sell("bob", 30_000)
        model.checkpoint_pool()
        alice_before = model.lp_pending(1, "alice")
        carol_before = model.lp_pending(1, "carol")
        transfer = model.lp_shares(1, "alice") // 5
        model.transfer_lp_shares("alice", "carol", transfer)
        self.assertEqual(model.lp_pending(1, "alice"), alice_before)
        self.assertEqual(model.lp_pending(1, "carol"), carol_before)

        # A later route follows the new share ownership, proving that only
        # pre-transfer history stayed with the sender.
        model.sell("bob", 25_000)
        model.checkpoint_pool()
        self.assertGreater(model.lp_pending(1, "alice"), alice_before)
        self.assertGreater(model.lp_pending(1, "carol"), carol_before)
        model.assert_invariants()

    def test_partial_burn_retains_earned_lp_rewards_and_returns_proportional_reserves(self) -> None:
        model = configured_model()
        model.sell("bob", 30_000)
        model.checkpoint_pool()
        pending_before = model.lp_pending(1, "alice")
        shares = model.lp_shares(1, "alice") // 4
        reserve_before = (model.pool_rfl_reserve, model.pool_usd_reserve)
        total_before = model.active_lp_epoch().total_shares
        expected = model.liquidity_withdrawal_amounts(shares, total_before, *reserve_before)
        result = model.remove_liquidity("alice", shares)
        self.assertEqual((result.rfl_amount, result.usd_amount), expected)
        self.assertEqual(model.lp_pending(1, "alice"), pending_before)
        self.assertEqual(model.pool_rfl_reserve, reserve_before[0] - result.rfl_amount)
        self.assertEqual(model.custody_shares, model.pool_rfl_reserve)
        model.assert_invariants()

    def test_lp_claim_preserves_combined_value_and_enters_core_at_current_index(self) -> None:
        model = configured_model()
        model.sell("bob", 40_000)
        model.checkpoint_pool()
        pending = model.lp_pending(1, "alice")
        self.assertGreater(pending, 0)
        before_combined = model.combined_effective_balance("alice")
        before_core_pending = model.pending("alice")
        before_reserves = (model.pool_rfl_reserve, model.pool_usd_reserve)
        before_k = model.pool_rfl_reserve * model.pool_usd_reserve
        claimed = model.claim_lp("alice", 1, pending // 2)
        self.assertEqual(model.combined_effective_balance("alice"), before_combined)
        self.assertEqual(model.pending("alice"), before_core_pending)
        self.assertEqual(model.lp_pending(1, "alice"), pending - claimed)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), before_reserves)
        self.assertEqual(model.pool_rfl_reserve * model.pool_usd_reserve, before_k)
        model.assert_invariants()

    def test_shutdown_epoch_auto_pays_claims_and_reseed_uses_fresh_state(self) -> None:
        model = configured_model()
        model.sell("bob", 40_000)
        model.begin_shutdown("admin")
        old_shares = model.lp_shares(1, "alice")
        final = model.remove_liquidity("alice", old_shares)
        self.assertTrue(final.final_exit)
        self.assertEqual(model.lp_epoch(1).status, LP_CLAIM_ONLY)
        self.assertEqual(model.lp_pending(1, "alice"), 0)
        self.assertEqual(model.lp_epoch(1).aggregate_liability(), 0)
        self.assertEqual(
            model.lp_epoch(1).terminal_rounding_reserve,
            model.lp_vault_balance(1),
        )
        self.assertIsNone(model.active_epoch)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), (0, 0))
        normalized_custody = model.custody_settled * MAGNITUDE
        self.assertGreaterEqual(model.custody_correction, normalized_custody)
        self.assertLess(model.custody_correction, normalized_custody + MAGNITUDE)
        route_residue = model.custody_correction - normalized_custody

        reseeded = model.reseed_pool(
            "admin", 100_000, 200_000, beneficiary="bob", min_lp_shares=1
        )
        self.assertEqual(reseeded.epoch, 2)
        self.assertEqual(model.lp_epoch(2).status, LP_ACTIVE)
        self.assertEqual(model.lp_pending(2, "bob"), 0)
        route_events = [
            event
            for event in model.events
            if event["event"] == "CustodyEpochRouteOpened"
            and event["epoch"] == 2
        ]
        self.assertEqual(len(route_events), 1)
        self.assertEqual(
            route_events[0]["retired_residue_magnified"],
            route_residue,
        )
        model.configure_pool_pauses(
            "admin", pool_paused=False, liquidity_paused=False, lp_claims_paused=False
        )
        model.sell("carol", 10_000)
        new_pool_pending = model.pool_pending_rewards()
        new_index = model.lp_epoch(2).index
        new_vault = model.lp_vault_balance(2)
        reserves = (model.pool_rfl_reserve, model.pool_usd_reserve)
        model.lp_epoch(2).quarantined = True

        # The old epoch is terminal and has no claimable unit to redirect into
        # the new cohort. A rejected old claim never checkpoints or mutates the
        # fresh epoch, even if the active epoch is unhealthy.
        with self.assertRaises(AccountingError):
            model.claim_lp("alice", 1)
        self.assertEqual(model.pool_pending_rewards(), new_pool_pending)
        self.assertEqual(model.lp_epoch(2).index, new_index)
        self.assertEqual(model.lp_vault_balance(2), new_vault)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), reserves)
        self.assertEqual(model.lp_pending(1, "alice"), 0)
        model.lp_epoch(2).quarantined = False
        model.assert_invariants()

    def test_two_equal_lps_classify_terminal_fractional_dust_without_liability(self) -> None:
        model = ReflectionModel(fixed_supply=100, fee_bps=100, amm_fee_bps=30)
        model.register_wallet("alice")
        model.register_wallet("bob")
        model.mint_quote("admin", "admin", 4)
        model.seed_pool("admin", 1, 4, beneficiary="alice")
        self.assertEqual(model.lp_shares(1, "alice"), 2)
        model.transfer_lp_shares("alice", "bob", 1)
        self.assertEqual(model.lp_shares(1, "alice"), 1)
        self.assertEqual(model.lp_shares(1, "bob"), 1)

        # Create one fee base unit with custody as the only core share, then
        # route it across two equal LP shares. Each individual floor is zero,
        # while the aggregate index still names one fully backed unit.
        model._debit_excluded("distribution_vault", 1)
        model._credit_excluded("reward_vault", 1)
        model._advance_index(1)
        self.assertEqual(model.checkpoint_pool(), 1)
        epoch = model.lp_epoch(1)
        self.assertEqual(epoch.pending("alice"), 0)
        self.assertEqual(epoch.pending("bob"), 0)
        self.assertEqual(epoch.aggregate_liability(), 1)
        self.assertEqual(model.lp_vault_balance(1), 1)

        # Full transfer and burn normalize only the departing sub-base-unit
        # corrections. The physical unit is immutable terminal dust, never a
        # claim, admin sweep, last-LP bonus, or future-epoch entitlement.
        model.transfer_lp_shares("bob", "alice", 1)
        model.begin_shutdown("admin")
        model.remove_liquidity("alice", 2)
        self.assertEqual(epoch.status, LP_CLAIM_ONLY)
        self.assertEqual(epoch.total_shares, 0)
        self.assertEqual(epoch.pending("alice"), 0)
        self.assertEqual(epoch.pending("bob"), 0)
        self.assertEqual(epoch.aggregate_liability(), 0)
        self.assertEqual(epoch.rounding_reserve, 1)
        self.assertEqual(epoch.terminal_rounding_reserve, 1)
        self.assertEqual(epoch.retired_residue_magnified, MAGNITUDE)
        self.assertEqual(model.lp_vault_balance(1), 1)
        model.assert_invariants()

    def test_failed_post_checkpoint_liquidity_call_rolls_back_atomically(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        before = accounting_state(model)
        with self.assertRaises(AccountingError):
            model.add_liquidity("carol", 1, 1, min_lp_shares=10**12)
        self.assertEqual(accounting_state(model), before)

    def test_ten_fragmented_lps_classify_nine_units_without_redirect(self) -> None:
        model = ReflectionModel(fixed_supply=100, fee_bps=100, amm_fee_bps=30)
        owners = ["alice", *[f"lp-{index}" for index in range(1, 10)]]
        model.mint_quote("admin", "admin", 20)
        model.seed_pool("admin", 10, 10, beneficiary=owners[0])
        for owner in owners[1:]:
            model.register_wallet(owner)
            model.transfer_lp_shares(owners[0], owner, 1)
        self.assertTrue(all(model.lp_shares(1, owner) == 1 for owner in owners))

        model._debit_excluded("distribution_vault", 9)
        model._credit_excluded("reward_vault", 9)
        model._advance_index(9)
        self.assertEqual(model.checkpoint_pool(), 9)
        epoch = model.lp_epoch(1)
        self.assertEqual(sum(epoch.pending(owner) for owner in owners), 0)
        self.assertEqual(epoch.aggregate_liability(), 9)

        model.begin_shutdown("admin")
        for owner in owners[1:]:
            model.remove_liquidity(owner, 1)
        model.remove_liquidity(owners[0], 1)
        self.assertEqual(epoch.status, LP_CLAIM_ONLY)
        self.assertEqual(epoch.aggregate_liability(), 0)
        self.assertEqual(epoch.rounding_reserve, 9)
        self.assertEqual(epoch.terminal_rounding_reserve, 9)
        self.assertEqual(epoch.retired_residue_magnified, 9 * MAGNITUDE)
        terminal_events = [
            event
            for event in model.events
            if event["event"] == "LpEpochTerminalDustClassified"
            and event["epoch"] == 1
        ]
        self.assertEqual(len(terminal_events), 1)
        self.assertEqual(terminal_events[0]["terminal_rounding_base_units"], 9)

        model.reseed_pool("admin", 10, 10, beneficiary="fresh-lp")
        self.assertEqual(model.lp_pending(2, "fresh-lp"), 0)
        self.assertEqual(model.lp_vault_balance(2), 0)
        self.assertEqual(model.lp_vault_balance(1), 9)
        model.assert_invariants()

    def test_lp_claim_pause_aborts_zeroing_transfer_and_shutdown_atomically(self) -> None:
        transfer_model = configured_model()
        transfer_model.sell("bob", 40_000)
        transfer_model.configure_pool_pauses(
            "admin",
            pool_paused=False,
            liquidity_paused=False,
            lp_claims_paused=True,
        )
        before = accounting_state(transfer_model)
        with self.assertRaises(AccountingError):
            transfer_model.transfer_lp_shares(
                "alice",
                "bob",
                transfer_model.lp_shares(1, "alice"),
            )
        self.assertEqual(accounting_state(transfer_model), before)

        burn_model = configured_model()
        burn_model.sell("bob", 40_000)
        burn_model.configure_pool_pauses(
            "admin",
            pool_paused=False,
            liquidity_paused=False,
            lp_claims_paused=True,
        )
        before = accounting_state(burn_model)
        with self.assertRaises(AccountingError):
            burn_model.begin_shutdown("admin")
        self.assertEqual(accounting_state(burn_model), before)

        burn_model.configure_pool_pauses(
            "admin",
            pool_paused=False,
            liquidity_paused=False,
            lp_claims_paused=False,
        )
        burn_model.begin_shutdown("admin")
        result = burn_model.remove_liquidity(
            "alice",
            burn_model.lp_shares(1, "alice"),
        )
        self.assertTrue(result.final_exit)
        burn_model.assert_invariants()

    def test_zero_denominator_receipt_is_unallocated_and_quarantined(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        model.checkpoint_pool()
        pending = model.lp_pending(1, "alice")
        self.assertGreater(pending, 0)
        model.claim_lp("alice", 1, pending)
        model.sell("bob", 20_000)
        routed = model.pool_pending_rewards()
        self.assertGreater(routed, 0)

        received = model.force_zero_denominator_receipt_for_test("alice")
        self.assertEqual(received, routed)
        epoch = model.lp_epoch(1)
        self.assertEqual(epoch.status, LP_ACTIVE)
        self.assertEqual(epoch.total_shares, 0)
        self.assertTrue(epoch.quarantined)
        self.assertEqual(epoch.unallocated_rewards, routed)
        self.assertEqual(epoch.aggregate_liability(), 0)
        self.assertEqual(model.pool_pending_rewards(), 0)
        self.assertEqual(
            model.lp_vault_balance(1),
            epoch.unallocated_rewards + epoch.rounding_reserve,
        )
        model.assert_invariants()


class DeploymentParityTests(unittest.TestCase):
    def test_materialization_mode_is_immutable_after_construction(self) -> None:
        claim_backed = ReflectionModel(fixed_supply=1)
        self.assertFalse(claim_backed.automatic_materialization)
        with self.assertRaises(AttributeError):
            claim_backed.automatic_materialization = True

        compatibility = ReflectionModel(
            fixed_supply=1,
            automatic_materialization=True,
        )
        self.assertTrue(compatibility.automatic_materialization)
        with self.assertRaises(AttributeError):
            compatibility.automatic_materialization = False

    def test_claim_backed_default_rejects_pending_backed_spends(self) -> None:
        base = configured_model()
        base.configure_swap_limits("admin", 30, 10_000, 100_000_000_000)
        base.sell("bob", 40_000)
        self.assertGreater(base.pending("alice"), 0)

        wallet_model = copy.deepcopy(base)
        with self.assertRaises(AccountingError):
            wallet_model.transfer(
                "alice",
                "carol",
                wallet_model.raw_balance("alice") + 1,
            )

        sell_model = copy.deepcopy(base)
        with self.assertRaises(AccountingError):
            sell_model.sell("alice", sell_model.raw_balance("alice") + 1)

        liquidity_model = copy.deepcopy(base)
        with self.assertRaises(AccountingError):
            liquidity_model.add_liquidity(
                "carol",
                liquidity_model.raw_balance("carol") + 1,
                500_000,
            )

    def test_swap_limits_match_move_defaults_and_configuration_envelope(self) -> None:
        model = configured_model()
        self.assertEqual(model.swap_limits(), (30, 2_000, 100_000_000_000))
        before = accounting_state(model)
        with self.assertRaises(AccountingError):
            model.sell("bob", model.pool_rfl_reserve * 2_000 // 10_000 + 1)
        self.assertEqual(accounting_state(model), before)
        with self.assertRaises(AccountingError):
            model.buy("bob", model.pool_usd_reserve * 2_000 // 10_000 + 1)
        for limits in ((101, 2_000, 1), (30, 0, 1), (30, 10_001, 1)):
            with self.assertRaises(AccountingError):
                model.configure_swap_limits("admin", *limits)
        with self.assertRaises(AuthorizationError):
            model.configure_swap_limits("attacker", 30, 2_000, 1)

    def test_token_and_reserve_surface_is_u64_while_lp_shares_are_u128(self) -> None:
        ReflectionModel(fixed_supply=MAX_U64)
        with self.assertRaises(AccountingError):
            ReflectionModel(fixed_supply=MAX_U64 + 1)
        model = ReflectionModel(fixed_supply=1)
        model.mint_quote("admin", "alice", MAX_U64)
        with self.assertRaises(AccountingError):
            model.mint_quote("admin", "alice", 1)
        with self.assertRaises(AccountingError):
            model.configure_swap_limits("admin", 30, 2_000, MAX_U64 + 1)
        with self.assertRaises(AccountingError):
            model.transfer("alice", "bob", MAX_U64 + 1)

    def test_u256_lifetime_exhaustion_matches_move_and_rolls_back(self) -> None:
        fee_model = configured_model()
        fee_model.lifetime_fees = MAX_U256
        before = accounting_state(fee_model)
        with self.assertRaises(AccountingError):
            fee_model.sell("bob", 10_000)
        self.assertEqual(accounting_state(fee_model), before)

        materialize_model = configured_model()
        materialize_model.sell("bob", 20_000)
        self.assertGreater(materialize_model.pending("alice"), 0)
        materialize_model.lifetime_materialized = MAX_U256
        before = accounting_state(materialize_model)
        with self.assertRaises(AccountingError):
            materialize_model.claim("alice", 1)
        self.assertEqual(accounting_state(materialize_model), before)

        custody_model = configured_model()
        custody_model.sell("bob", 20_000)
        self.assertGreater(custody_model.pool_pending_rewards(), 0)
        custody_model.lifetime_custody_routed = MAX_U256
        before = accounting_state(custody_model)
        with self.assertRaises(AccountingError):
            custody_model.checkpoint_pool()
        self.assertEqual(accounting_state(custody_model), before)

        self.assertEqual(
            ReflectionModel._require_u256_sum(MAX_U256 - 1, 1, "boundary"),
            MAX_U256,
        )
        with self.assertRaises(AccountingError):
            ReflectionModel._require_u256_sum(MAX_U256, 1, "boundary")

    def test_fresh_bootstrap_beneficiaries_register_once_and_roles_fail_closed(self) -> None:
        model = ReflectionModel(fixed_supply=1_000)
        model.mint_quote("admin", "admin", 200)
        model.seed_pool("admin", 100, 100, beneficiary="fresh-alice")
        self.assertTrue(model.wallet_is_registered("fresh-alice"))
        model.register_wallet("fresh-alice")
        registrations = [
            event
            for event in model.events
            if event["event"] == "WalletRegistered"
            and event["account"] == "fresh-alice"
        ]
        self.assertEqual(len(registrations), 1)
        self.assertEqual(registrations[0]["primary_store"], "primary_store:fresh-alice")
        self.assertEqual(registrations[0]["registered_wallet_count"], 1)

        model.begin_shutdown("admin")
        model.remove_liquidity("fresh-alice", model.lp_shares(1, "fresh-alice"))
        model.reseed_pool("admin", 100, 100, beneficiary="fresh-bob")
        self.assertTrue(model.wallet_is_registered("fresh-bob"))
        self.assertEqual(
            len(
                [
                    event
                    for event in model.events
                    if event["event"] == "WalletRegistered"
                    and event["account"] == "fresh-bob"
                ]
            ),
            1,
        )

        for beneficiary in ("admin", "reflection_core", "test_assets", "test_amm"):
            rejected = ReflectionModel(fixed_supply=100)
            rejected.mint_quote("admin", "admin", 10)
            with self.assertRaises(AccountingError):
                rejected.seed_pool("admin", 1, 1, beneficiary=beneficiary)


class AdversarialTests(unittest.TestCase):
    def test_fake_admin_and_all_direct_custody_bypasses_are_rejected(self) -> None:
        model = configured_model()
        with self.assertRaises(AuthorizationError):
            model.set_fee_bps("attacker", 0)
        with self.assertRaises(AuthorizationError):
            model.seed_pool("attacker", 1, 1, beneficiary="alice")
        for sender, recipient in (
            ("alice", "pool"),
            ("pool", "alice"),
            ("alice", "reward_vault"),
            ("alice", "external-vault"),
        ):
            with self.assertRaises(PoolBypassError):
                model.transfer(sender, recipient, 1)
        self.assertEqual(model.pending("external-vault"), 0)
        model.assert_invariants()

    def test_unregistered_lp_recipient_and_direct_share_mutation_fail_closed(self) -> None:
        model = configured_model()
        before = accounting_state(model)
        with self.assertRaises(PoolBypassError):
            model.transfer_lp_shares("alice", "external-vault", 1)
        self.assertEqual(accounting_state(model), before)
        self.assertFalse(hasattr(model, "credit_external_lp_store"))

    def test_claim_twice_zero_value_and_reentrant_routes_are_rejected(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        model.claim("alice")
        with self.assertRaises(AccountingError):
            model.claim("alice")
        with self.assertRaises(AccountingError):
            model.transfer("alice", "bob", 0)
        with self.assertRaises(AccountingError):
            model.buy("alice", 0)
        with self.assertRaises(AccountingError):
            model.sell("alice", 0)
        model._lock = "swap"
        try:
            with self.assertRaises(AccountingError):
                model.checkpoint_pool()
            with self.assertRaises(AccountingError):
                model.claim_lp("alice", 1)
        finally:
            model._lock = None
        model.assert_invariants()

    def test_claim_pause_is_independent_from_custody_and_lp_claims(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        pending = model.pending("alice")
        custody_pending = model.pool_pending_rewards()
        self.assertGreater(pending, 0)
        self.assertGreater(custody_pending, 0)
        model.set_claims_paused("admin", True)
        with self.assertRaises(AccountingError):
            model.claim("alice")
        with self.assertRaises(AccountingError):
            model.transfer("alice", "carol", model.raw_balance("alice") + min(1, pending))
        self.assertEqual(model.checkpoint_pool(), custody_pending)
        lp_pending = model.lp_pending(1, "alice")
        self.assertGreater(lp_pending, 0)
        self.assertEqual(model.claim_lp("alice", 1, lp_pending), lp_pending)
        model.assert_invariants()

    def test_final_lp_exit_requires_shutdown(self) -> None:
        model = configured_model()
        with self.assertRaises(AccountingError):
            model.remove_liquidity("alice", model.lp_shares(1, "alice"))
        model.assert_invariants()


class RandomizedPropertyTests(unittest.TestCase):
    """Seeded mixed wallet/swap/custody/LP sequence with full audits."""

    def test_seeded_randomized_accounting(self) -> None:
        result = run_randomized_workload(config_from_environment())
        model = result.model
        self.assertEqual(
            result.counters.successful,
            result.config.successful_operations,
        )
        self.assertEqual(
            result.counters.attempts,
            result.counters.successful
            + result.counters.rejected
            + result.counters.no_op,
        )
        self.assertEqual(
            sum(result.counters.histogram.values()),
            result.counters.successful,
        )
        self.assertEqual(sum(model.raw.values()), model.fixed_supply)
        self.assertGreater(model.custody_shares, 0)
        self.assertGreaterEqual(model.lifetime_custody_routed, 0)
        self.assertEqual(
            model.reward_vault_balance,
            model.reflection_liability() + model.unallocated_fees + model.rounding_reserve,
        )


class RandomizedWorkloadHarnessTests(unittest.TestCase):
    def test_outcome_counters_and_histograms_reconcile(self) -> None:
        counters = WorkloadCounters()
        counters.record("transfer", APPLIED)
        counters.record("transfer", APPLIED)
        counters.record("add_liquidity", REJECTED)
        counters.record("claim", NOOP)

        self.assertEqual(counters.attempts, 4)
        self.assertEqual(counters.successful, 2)
        self.assertEqual(counters.rejected, 1)
        self.assertEqual(counters.no_op, 1)
        self.assertEqual(counters.histogram, {"transfer": 2})
        self.assertEqual(counters.rejected_histogram, {"add_liquidity": 1})
        self.assertEqual(counters.no_op_histogram, {"claim": 1})
        counters.assert_consistent()

    def test_gate_fails_after_bounded_non_applied_attempts(self) -> None:
        config = WorkloadConfig(
            successful_operations=1,
            holder_count=3,
            audit_frequency=1,
            max_attempts=3,
            seed="bounded-attempt-test",
        )
        with patch(
            "reflection_model.workload._attempt_random_operation",
            return_value=("forced_no_op", NOOP),
        ):
            with self.assertRaisesRegex(
                WorkloadExhaustedError,
                r"exhausted 3 attempts after 0/1 successful",
            ):
                run_randomized_workload(config)

    def test_small_gate_counts_realized_transitions_and_serializes_report(self) -> None:
        result = run_randomized_workload(
            WorkloadConfig(
                successful_operations=50,
                holder_count=4,
                audit_frequency=10,
                max_attempts=200,
                seed="small-model-gate-counter-test",
            )
        )
        report = result.report(GitProvenance(commit="f" * 40, clean=True))

        self.assertEqual(result.counters.successful, 50)
        self.assertLessEqual(result.counters.attempts, 200)
        self.assertEqual(report["requested_successful_operations"], 50)
        self.assertEqual(report["successful"], 50)
        self.assertEqual(report["materialization_mode"], "claim-backed")
        self.assertIs(report["automatic_materialization"], False)
        self.assertEqual(len(report["final_state_digest"]), 64)
        self.assertEqual(report["git_commit"], "f" * 40)
        self.assertTrue(report["git_clean"])
        self.assertEqual(json.loads(json.dumps(report)), report)


if __name__ == "__main__":
    unittest.main()
