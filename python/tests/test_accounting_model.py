"""Deterministic, invariant, adversarial, epoch, and randomized model tests.

The default randomized workload is bounded for normal CI.  Set
``REFLECTION_MODEL_OPERATIONS=1000000`` and increase
``REFLECTION_MODEL_HOLDERS`` for the quantitative long-run gate.
"""

from __future__ import annotations

import copy
import json
import os
import random
import unittest
from pathlib import Path

from reflection_model import (
    AccountingError,
    AuthorizationError,
    LP_ACTIVE,
    LP_CLAIM_ONLY,
    PoolBypassError,
    ReflectionModel,
)
from reflection_model.model import MAGNITUDE, MAX_U128


ROOT = Path(__file__).resolve().parents[2]
VECTOR_PATH = ROOT / "python" / "test_vectors" / "basic_accounting.json"


def configured_model() -> ReflectionModel:
    model = ReflectionModel(fixed_supply=5_000_000, fee_bps=100, amm_fee_bps=30)
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
        model = configured_model()
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
            lambda: model.claim_lp("alice", 1, 1),
        )
        for operation in live_operations:
            with self.assertRaises(AccountingError):
                operation()
            self.assertEqual(accounting_state(model), before)

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

    def test_shutdown_epoch_retains_claims_and_reseed_uses_fresh_state(self) -> None:
        model = configured_model()
        model.sell("bob", 40_000)
        model.begin_shutdown("admin")
        old_shares = model.lp_shares(1, "alice")
        final = model.remove_liquidity("alice", old_shares)
        self.assertTrue(final.final_exit)
        self.assertEqual(model.lp_epoch(1).status, LP_CLAIM_ONLY)
        old_pending = model.lp_pending(1, "alice")
        self.assertGreater(old_pending, 0)
        self.assertIsNone(model.active_epoch)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), (0, 0))

        reseeded = model.reseed_pool(
            "admin", 100_000, 200_000, beneficiary="bob", min_lp_shares=1
        )
        self.assertEqual(reseeded.epoch, 2)
        self.assertEqual(model.lp_epoch(2).status, LP_ACTIVE)
        self.assertEqual(model.lp_pending(2, "bob"), 0)
        model.configure_pool_pauses(
            "admin", pool_paused=False, liquidity_paused=False, lp_claims_paused=False
        )
        model.sell("carol", 10_000)
        new_pool_pending = model.pool_pending_rewards()
        new_index = model.lp_epoch(2).index
        new_vault = model.lp_vault_balance(2)
        reserves = (model.pool_rfl_reserve, model.pool_usd_reserve)
        model.lp_epoch(2).quarantined = True

        # Claiming an old epoch never checkpoints the current pool or mutates
        # the fresh epoch's index/vault/table, even if that active epoch is
        # unhealthy and every live pool operation is fail-closed.
        model.claim_lp("alice", 1)
        self.assertEqual(model.pool_pending_rewards(), new_pool_pending)
        self.assertEqual(model.lp_epoch(2).index, new_index)
        self.assertEqual(model.lp_vault_balance(2), new_vault)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), reserves)
        self.assertEqual(model.lp_pending(1, "alice"), 0)
        model.assert_invariants()

    def test_two_equal_lps_leave_one_base_unit_as_terminal_named_liability(self) -> None:
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

        # Consolidate only the withdrawable shares; each account's fractional
        # history remains in its correction. Final reserve exit leaves the old
        # epoch permanently CLAIM_ONLY with the aggregate unit named and backed.
        model.transfer_lp_shares("bob", "alice", 1)
        model.begin_shutdown("admin")
        model.remove_liquidity("alice", 2)
        self.assertEqual(epoch.status, LP_CLAIM_ONLY)
        self.assertEqual(epoch.total_shares, 0)
        self.assertEqual(epoch.pending("alice"), 0)
        self.assertEqual(epoch.pending("bob"), 0)
        self.assertEqual(epoch.aggregate_liability(), 1)
        self.assertEqual(epoch.rounding_reserve, 0)
        self.assertEqual(model.lp_vault_balance(1), 1)
        model.assert_invariants()

    def test_failed_post_checkpoint_liquidity_call_rolls_back_atomically(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        before = accounting_state(model)
        with self.assertRaises(AccountingError):
            model.add_liquidity("carol", 1, 1, min_lp_shares=10**12)
        self.assertEqual(accounting_state(model), before)


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

    def test_claim_pause_blocks_wallet_materialisation_and_custody_checkpoint(self) -> None:
        model = configured_model()
        model.sell("bob", 20_000)
        pending = model.pending("alice")
        model.set_claims_paused("admin", True)
        with self.assertRaises(AccountingError):
            model.claim("alice")
        with self.assertRaises(AccountingError):
            model.checkpoint_pool()
        with self.assertRaises(AccountingError):
            model.transfer("alice", "carol", model.raw_balance("alice") + min(1, pending))
        model.assert_invariants()

    def test_final_lp_exit_requires_shutdown(self) -> None:
        model = configured_model()
        with self.assertRaises(AccountingError):
            model.remove_liquidity("alice", model.lp_shares(1, "alice"))
        model.assert_invariants()


class RandomizedPropertyTests(unittest.TestCase):
    """Seeded mixed wallet/swap/custody/LP sequence with full audits."""

    SEED = "cedra-trfl-wallet-custody-lp-2026-07-20"

    @staticmethod
    def _random_model(holder_count: int) -> tuple[ReflectionModel, list[str]]:
        required_supply = 8_000_000 + holder_count * 30_000
        model = ReflectionModel(fixed_supply=required_supply, fee_bps=100, amm_fee_bps=30)
        holders = [f"holder-{number:04d}" for number in range(holder_count)]
        for holder in holders:
            model.faucet_grant("admin", holder, 30_000)
            model.mint_quote("admin", holder, 100_000)
        model.mint_quote("admin", "admin", 3_000_000)
        model.seed_pool(
            "admin", 5_000_000, 2_000_000, beneficiary=holders[0], min_lp_shares=1
        )
        model.assert_invariants()
        return model, holders

    def test_seeded_randomized_accounting(self) -> None:
        operations = int(os.environ.get("REFLECTION_MODEL_OPERATIONS", "20000"))
        holder_count = int(os.environ.get("REFLECTION_MODEL_HOLDERS", "32"))
        checkpoint = int(os.environ.get("REFLECTION_MODEL_CHECKPOINT", "500"))
        self.assertGreaterEqual(operations, 1)
        self.assertGreaterEqual(holder_count, 3)
        self.assertGreaterEqual(checkpoint, 1)
        rng = random.Random(self.SEED)
        model, holders = self._random_model(holder_count)

        for step in range(operations):
            first = holders[rng.randrange(holder_count)]
            second = holders[rng.randrange(holder_count)]
            if first == second:
                second = holders[(holders.index(first) + 1) % holder_count]
            kind = rng.randrange(100)
            try:
                if kind < 24:
                    available = model.effective_balance(first)
                    if available:
                        model.transfer(first, second, rng.randint(1, min(available, 2_000)))
                elif kind < 43:
                    available = model.effective_balance(first)
                    if available:
                        model.sell(first, rng.randint(1, min(available, 2_000)))
                elif kind < 60:
                    available_quote = model.quote_balance(first)
                    if available_quote:
                        model.buy(first, rng.randint(1, min(available_quote, 2_000)))
                elif kind < 68:
                    pending = model.pending(first)
                    if pending:
                        model.claim(first, rng.randint(1, pending))
                elif kind < 73:
                    model.checkpoint_pool()
                elif kind < 80:
                    if model.raw_balance(first) and model.quote_balance(first):
                        model.add_liquidity(
                            first,
                            rng.randint(1, min(model.effective_balance(first), 1_000)),
                            rng.randint(1, min(model.quote_balance(first), 2_000)),
                        )
                elif kind < 86:
                    owned = model.lp_shares(1, first)
                    if owned:
                        model.transfer_lp_shares(first, second, rng.randint(1, owned))
                elif kind < 91:
                    pending = model.lp_pending(1, first)
                    if pending:
                        model.claim_lp(first, 1, rng.randint(1, pending))
                elif kind < 96:
                    owned = model.lp_shares(1, first)
                    total = model.active_lp_epoch().total_shares
                    if owned and total > 1:
                        model.remove_liquidity(first, rng.randint(1, min(owned, total - 1)))
                else:
                    model.set_fee_bps("admin", rng.randint(0, 100))
            except AccountingError:
                # Tiny AMM/liquidity values and imbalanced maximum inputs can
                # legitimately round to zero. Atomic methods restore any
                # checkpoint that preceded a rejected operation.
                pass

            model.assert_fast_invariants()
            if (step + 1) % checkpoint == 0:
                model.assert_invariants()

        model.assert_invariants()
        self.assertEqual(sum(model.raw.values()), model.fixed_supply)
        self.assertGreater(model.custody_shares, 0)
        self.assertGreaterEqual(model.lifetime_custody_routed, 0)
        self.assertEqual(
            model.reward_vault_balance,
            model.reflection_liability() + model.unallocated_fees + model.rounding_reserve,
        )


if __name__ == "__main__":
    unittest.main()
