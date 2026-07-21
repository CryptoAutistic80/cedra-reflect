from __future__ import annotations

import unittest

from reflection_model import (
    AccountingError,
    AuthorizationError,
    CLOSED,
    CONFIGURING,
    LIVE,
    OwnerlessReflectionModel,
    TRIGGER_BUY_POST,
    TRIGGER_SELL_POST,
    TRIGGER_SEND,
    V02_BOOTSTRAP_LP,
    V02_FAUCET_ACTOR,
    V02_FAUCET_GRANT,
    V02_FAUCET_TUSD_GRANT,
    V02_FIXED_SUPPLY,
    V02_INITIAL_RFL_LIQUIDITY,
    V02_INITIAL_TUSD_LIQUIDITY,
)
from reflection_model.workload import WorkloadConfig, run_randomized_workload


def live_model(*accounts: str, fee_bps: int = 100) -> OwnerlessReflectionModel:
    model = OwnerlessReflectionModel(reflection_fee_bps=fee_bps)
    model.seed_pool(
        "creator",
        V02_INITIAL_RFL_LIQUIDITY,
        V02_INITIAL_TUSD_LIQUIDITY,
        beneficiary=V02_BOOTSTRAP_LP,
    )
    model.seal_launch("creator")
    for account in accounts:
        model.faucet_grant(V02_FAUCET_ACTOR, account, V02_FAUCET_GRANT)
        model.faucet_grant_tusd(V02_FAUCET_ACTOR, account, V02_FAUCET_TUSD_GRANT)
    model.assert_invariants()
    return model


class OwnerlessCreationTests(unittest.TestCase):
    def test_creation_fee_boundaries_and_source_constants(self) -> None:
        for fee in (0, 1, 100, 500):
            with self.subTest(fee=fee):
                model = OwnerlessReflectionModel(reflection_fee_bps=fee)
                self.assertEqual(model.lifecycle, CONFIGURING)
                self.assertEqual(model.reflection_fee_bps, fee)
                self.assertEqual(model.fixed_supply, V02_FIXED_SUPPLY)
                self.assertEqual(model.decimals, 6)
                self.assertTrue(model.automatic_materialization)
                self.assertEqual(model.events[0]["event"], "TokenCreated")
                model.assert_invariants()
        with self.assertRaises(AccountingError):
            OwnerlessReflectionModel(reflection_fee_bps=501)
        with self.assertRaises(AccountingError):
            OwnerlessReflectionModel(fixed_supply=V02_FIXED_SUPPLY - 1)
        with self.assertRaises(AccountingError):
            OwnerlessReflectionModel(decimals=8)

    def test_launch_is_exact_once_and_bootstrap_is_source_bound(self) -> None:
        model = OwnerlessReflectionModel()
        for changed in (
            (V02_INITIAL_RFL_LIQUIDITY - 1, V02_INITIAL_TUSD_LIQUIDITY, V02_BOOTSTRAP_LP),
            (V02_INITIAL_RFL_LIQUIDITY, V02_INITIAL_TUSD_LIQUIDITY - 1, V02_BOOTSTRAP_LP),
            (V02_INITIAL_RFL_LIQUIDITY, V02_INITIAL_TUSD_LIQUIDITY, "creator"),
        ):
            with self.subTest(changed=changed), self.assertRaises(AccountingError):
                model.seed_pool("creator", changed[0], changed[1], beneficiary=changed[2])
        model.seed_pool(
            "creator",
            V02_INITIAL_RFL_LIQUIDITY,
            V02_INITIAL_TUSD_LIQUIDITY,
            beneficiary=V02_BOOTSTRAP_LP,
        )
        model.seal_launch("creator")
        self.assertEqual(model.lifecycle, LIVE)
        with self.assertRaises(AuthorizationError):
            model.seal_launch("creator")
        with self.assertRaises(AuthorizationError):
            model.set_fee_bps("creator", 0)
        for removed in (
            model.set_swaps_paused,
            model.set_claims_paused,
            model.configure_pool_pauses,
            model.configure_swap_limits,
            model.configure_liquidity_limits,
            model.begin_shutdown,
            model.reseed_pool,
        ):
            with self.subTest(method=removed.__name__), self.assertRaises(AuthorizationError):
                removed()
        with self.assertRaises(AccountingError):
            model.apply_operation({"op": "set_fee_bps", "actor": "creator", "fee_bps": 0})

    def test_faucet_grants_and_cooldowns_are_fixed(self) -> None:
        model = live_model("alice")
        with self.assertRaises(AccountingError):
            model.faucet_grant(V02_FAUCET_ACTOR, "alice", V02_FAUCET_GRANT)
        with self.assertRaises(AccountingError):
            model.faucet_grant_tusd(V02_FAUCET_ACTOR, "alice", V02_FAUCET_TUSD_GRANT)
        model.advance_time(model.faucet_cooldown_seconds)
        model.faucet_grant(V02_FAUCET_ACTOR, "alice", V02_FAUCET_GRANT)
        model.faucet_grant_tusd(V02_FAUCET_ACTOR, "alice", V02_FAUCET_TUSD_GRANT)
        with self.assertRaises(AuthorizationError):
            model.faucet_grant(V02_FAUCET_ACTOR, "alice", V02_FAUCET_GRANT - 1)
        model.assert_invariants()


class OwnerlessInteractionTests(unittest.TestCase):
    def test_swaps_materialize_trader_and_post_checkpoint_pool(self) -> None:
        model = live_model("alice", "bob", "carol", "dave")
        result = model.sell("alice", 1_000_000)
        self.assertEqual(result.reflection_fee, 10_000)
        self.assertEqual(model.pending("alice"), 0)
        self.assertEqual(model.pool_pending_rewards(), 0)
        self.assertGreater(model.lp_pending(1, V02_BOOTSTRAP_LP), 0)
        self.assertGreater(model.pending("bob"), 0)
        self.assertGreater(model.effective_balance("bob"), model.raw_balance("bob"))

        raw_before = model.raw_balance("alice")
        bought = model.buy("alice", 1_000_000)
        self.assertEqual(model.pending("alice"), 0)
        self.assertEqual(model.pool_pending_rewards(), 0)
        self.assertGreater(model.raw_balance("alice"), raw_before + bought.net_rfl_amount)
        triggers = {
            event.get("trigger")
            for event in model.events
            if event["event"] == "RewardsMaterialized"
        }
        self.assertIn(TRIGGER_SELL_POST, triggers)
        self.assertIn(TRIGGER_BUY_POST, triggers)
        model.assert_invariants()

    def test_transfer_materializes_both_endpoints_and_registers_receiver(self) -> None:
        model = live_model("alice", "bob")
        model.sell("alice", 1_000_000)
        self.assertGreater(model.pending("bob"), 0)
        bob_effective = model.effective_balance("bob")
        model.transfer("bob", "new-recipient", 1)
        self.assertEqual(model.pending("bob"), 0)
        self.assertEqual(model.raw_balance("bob"), bob_effective - 1)
        self.assertTrue(model.wallet_is_registered("new-recipient"))
        self.assertEqual(model.raw_balance("new-recipient"), 1)
        self.assertTrue(
            any(
                event["event"] == "RewardsMaterialized"
                and event.get("trigger") == TRIGGER_SEND
                and event.get("account") == "bob"
                for event in model.events
            )
        )
        model.assert_invariants()

    def test_manual_wallet_and_lp_claims_allow_partial_amounts(self) -> None:
        model = live_model("alice", "bob")
        model.sell("alice", 2_000_000)
        pending = model.pending("bob")
        claimed = model.claim("bob", pending // 2)
        self.assertEqual(claimed, pending // 2)
        self.assertEqual(model.pending("bob"), pending - claimed)

        lp_pending = model.lp_pending(1, V02_BOOTSTRAP_LP)
        lp_claimed = model.claim_lp(V02_BOOTSTRAP_LP, 1, lp_pending // 2)
        self.assertEqual(lp_claimed, lp_pending // 2)
        self.assertEqual(model.lp_pending(1, V02_BOOTSTRAP_LP), lp_pending - lp_claimed)
        model.assert_invariants()

    def test_lp_transfer_materializes_both_old_weights_before_transfer(self) -> None:
        model = live_model("trader")
        model.sell("trader", 2_000_000)
        bootstrap_pending = model.lp_pending(1, V02_BOOTSTRAP_LP)
        self.assertGreater(bootstrap_pending, 0)
        half = model.lp_shares(1, V02_BOOTSTRAP_LP) // 2
        model.transfer_lp_shares(V02_BOOTSTRAP_LP, "external-lp", half)
        self.assertEqual(model.lp_pending(1, V02_BOOTSTRAP_LP), 0)
        self.assertEqual(model.lp_shares(1, "external-lp"), half)

        model.sell("trader", 2_000_000)
        self.assertGreater(model.lp_pending(1, "external-lp"), 0)
        model.transfer_lp_shares("external-lp", "second-lp", 1)
        self.assertEqual(model.lp_pending(1, "external-lp"), 0)
        self.assertTrue(model.wallet_is_registered("external-lp"))
        model.assert_invariants()

    def test_final_lp_exit_is_permissionless_exact_and_closure_is_irreversible(self) -> None:
        model = live_model("alice")
        shares = model.lp_shares(1, V02_BOOTSTRAP_LP)
        model.transfer_lp_shares(V02_BOOTSTRAP_LP, "alice", shares)
        before = (model.pool_rfl_reserve, model.pool_usd_reserve)
        result = model.remove_liquidity("alice", model.lp_shares(1, "alice"))
        self.assertTrue(result.final_exit)
        self.assertEqual((result.rfl_amount, result.usd_amount), before)
        self.assertEqual(model.lifecycle, CLOSED)
        self.assertEqual((model.pool_rfl_reserve, model.pool_usd_reserve), (0, 0))
        self.assertEqual(model.pool_pending_rewards(), 0)
        model.transfer("alice", "post-close-recipient", 1)
        self.assertEqual(model.raw_balance("post-close-recipient"), 1)
        with self.assertRaises(AccountingError):
            model.sell("alice", 1)
        with self.assertRaises(AuthorizationError):
            model.reseed_pool()
        model.assert_invariants()


class OwnerlessWorkloadTests(unittest.TestCase):
    def test_randomized_gate_uses_ownerless_automatic_production_mode(self) -> None:
        result = run_randomized_workload(
            WorkloadConfig(
                successful_operations=2_000,
                holder_count=16,
                audit_frequency=250,
                max_attempts=8_000,
                seed="ownerless-v0.2-python-test",
            )
        )
        self.assertEqual(result.counters.successful, 2_000)
        self.assertIsInstance(result.model, OwnerlessReflectionModel)
        self.assertEqual(result.model.lifecycle, LIVE)
        self.assertTrue(result.model.automatic_materialization)
        self.assertEqual(result.model.pool_pending_rewards(), 0)
        result.model.assert_invariants()


if __name__ == "__main__":
    unittest.main()
