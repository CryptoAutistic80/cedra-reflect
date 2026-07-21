import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class MoveVisibilitySurfaceTests(unittest.TestCase):
    def assert_package_only(self, source: str, functions: tuple[str, ...]) -> None:
        for function in functions:
            with self.subTest(function=function):
                self.assertRegex(
                    source,
                    rf"public\(package\)\s+fun\s+{re.escape(function)}\s*\(",
                )
                self.assertNotRegex(
                    source,
                    rf"(?m)^\s*public\s+fun\s+{re.escape(function)}\s*\(",
                )

    def test_custody_registry_mutators_are_not_public_abi(self) -> None:
        source = (ROOT / "move/reflection-core/sources/custody_registry.move").read_text()
        self.assert_package_only(
            source,
            (
                "register",
                "assert_active_route",
                "assert_claim_vault",
                "assert_reserve",
            ),
        )
        self.assertNotRegex(source, r"\bfun\s+open_epoch\s*\(")

    def test_lp_ledger_mutators_are_not_public_abi(self) -> None:
        source = (ROOT / "move/test-amm/sources/lp_rewards.move").read_text()
        self.assert_package_only(
            source,
            (
                "initialize",
                "receive_routed_reward",
                "mint_active",
                "burn_active",
                "transfer_active",
                "prepare_claim",
                "mark_active_claim_only",
                "assert_active_epoch_healthy",
                "assert_epoch_backing",
            ),
        )
        self.assertNotRegex(source, r"\bfun\s+open_epoch\s*\(")

    def test_core_uses_one_time_post_publish_mode_initialization(self) -> None:
        source = (ROOT / "move/reflection-core/sources/reflection_token.move").read_text()
        self.assertNotRegex(source, r"\bfun\s+init_module\s*\(")
        self.assertRegex(
            source,
            r"public\s+entry\s+fun\s+initialize\s*\(\s*admin:\s*&signer\s*,"
            r"\s*reflection_fee_bps:\s*u64\s*\)",
        )
        self.assertNotRegex(
            source,
            r"public\s+entry\s+fun\s+initialize\s*\([^)]*\bbool\b",
        )
        self.assertNotIn("initialize_with_mode", source)
        self.assertIn("const MAX_FEE_BPS: u64 = 500", source)
        self.assertIn("assert!(reflection_fee_bps <= MAX_FEE_BPS", source)
        self.assertIn("automatic_materialization_enabled", source)
        self.assertNotRegex(source, r"fun\s+set_automatic_materialization\s*\(")
        for removed in ("set_fee_bps", "set_pause_state", "set_operational_admin"):
            self.assertNotRegex(source, rf"\bfun\s+{removed}\s*\(")

    def test_core_event_emitters_are_not_publicly_forgeable(self) -> None:
        source = (ROOT / "move/reflection-core/sources/reflection_events.move").read_text()
        emitters = re.findall(r"public(?:\(package\))?\s+fun\s+([a-z_]+)\s*\(", source)
        self.assertGreater(len(emitters), 0)
        self.assertNotRegex(source, r"(?m)^\s*public\s+fun\s+[a-z_]+\s*\(")
        self.assertIn("public(package) fun token_created", source)
        self.assertIn("public(package) fun core_launch_sealed", source)
        self.assertIn("public(package) fun core_pool_closed", source)

    def test_asset_metadata_is_public_and_unmistakably_testnet(self) -> None:
        core = (ROOT / "move/reflection-core/sources/reflection_token.move").read_text()
        quote = (ROOT / "move/test-assets/sources/mock_usd.move").read_text()
        self.assertNotIn("example.invalid", core + quote)
        self.assertIn('b"TESTNET ASSET NO VALUE tRFL"', core)
        self.assertIn('b"TESTNET ASSET NO VALUE tUSD"', quote)
        self.assertIn("trfl-testnet.svg", core)
        self.assertIn("tusd-testnet.svg", quote)
        for asset in ("trfl-testnet.svg", "tusd-testnet.svg"):
            contents = (ROOT / "assets" / asset).read_text()
            self.assertIn("TESTNET ASSET", contents)
            self.assertIn("NO MONETARY VALUE", contents)
            self.assertIn("STATE AND ADDRESSES MAY CHANGE", contents)

    def test_publishable_packages_are_immutable(self) -> None:
        for package in ("reflection-core", "test-assets", "test-amm"):
            with self.subTest(package=package):
                manifest = (ROOT / "move" / package / "Move.toml").read_text()
                self.assertIn('upgrade_policy = "immutable"', manifest)
                self.assertNotIn('upgrade_policy = "compatible"', manifest)

    def test_core_drops_mint_authority_after_fixed_supply_creation(self) -> None:
        source = (ROOT / "move/reflection-core/sources/reflection_token.move").read_text()
        state_body = re.search(
            r"struct\s+ReflectionState\s+has\s+key\s*\{(?P<body>.*?)\n\s*\}",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(state_body)
        self.assertNotIn("MintRef", state_body.group("body"))
        self.assertEqual(source.count("generate_mint_ref"), 1)
        self.assertEqual(source.count("fungible_asset::mint("), 1)

    def test_production_entry_abi_is_an_explicit_ownerless_allowlist(self) -> None:
        expected = {
            "move/reflection-core/sources/reflection_router.move": {"transfer"},
            "move/reflection-core/sources/reflection_token.move": {
                "initialize",
                "register_wallet",
                "claim",
                "claim_all",
            },
            "move/test-assets/sources/test_faucet.move": {
                "initialize",
                "claim_trfl",
                "claim_tusd",
            },
            "move/test-amm/sources/pool.move": {
                "launch",
                "add_liquidity",
                "remove_liquidity",
                "transfer_lp_shares",
                "claim_lp_rewards",
                "checkpoint_lp_rewards",
                "sell_trfl",
                "buy_trfl",
            },
            "move/test-amm/sources/swap.move": {"sell_trfl", "buy_trfl"},
            "move/test-amm/sources/liquidity.move": {
                "add",
                "remove",
                "claim_rewards",
                "checkpoint",
            },
            "move/test-amm/sources/lp_shares.move": {"transfer"},
        }
        observed: dict[str, set[str]] = {}
        for package in ("reflection-core", "test-assets", "test-amm"):
            for path in sorted((ROOT / "move" / package / "sources").glob("*.move")):
                relative = str(path.relative_to(ROOT))
                entries = set(
                    re.findall(
                        r"(?m)^\s*public\s+entry\s+fun\s+([a-zA-Z0-9_]+)\s*\(",
                        path.read_text(),
                    )
                )
                if entries:
                    observed[relative] = entries
        self.assertEqual(observed, expected)

    def test_forbidden_creator_authority_and_recovery_functions_do_not_exist(self) -> None:
        production = "\n".join(
            path.read_text()
            for package in ("reflection-core", "test-assets", "test-amm")
            for path in sorted((ROOT / "move" / package / "sources").glob("*.move"))
        )
        forbidden_functions = {
            "set_fee_bps",
            "set_pause_state",
            "set_paused",
            "configure",
            "configure_pauses",
            "configure_limits",
            "configure_liquidity_limits",
            "set_operational_admin",
            "rotate_admin",
            "rotate_operational_admin",
            "set_all_operational_admin",
            "begin_shutdown",
            "shutdown",
            "reseed_liquidity",
            "reseed_pool",
            "open_epoch",
            "register_store",
            "register_exclusion",
            "migrate",
            "upgrade",
            "sweep",
            "force_set_balance",
        }
        for function in forbidden_functions:
            with self.subTest(function=function):
                self.assertNotRegex(production, rf"\bfun\s+{function}\s*\(")

        forbidden_state_fields = {
            "operational_admin",
            "admin_rotation",
            "swaps_paused",
            "claims_paused",
            "liquidity_paused",
            "shutdown_mode",
        }
        for field in forbidden_state_fields:
            with self.subTest(field=field):
                self.assertNotRegex(production, rf"(?m)^\s*{field}\s*:")


if __name__ == "__main__":
    unittest.main()
