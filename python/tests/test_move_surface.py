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
                "open_epoch",
                "assert_active_route",
                "assert_claim_vault",
                "assert_reserve",
            ),
        )

    def test_lp_ledger_mutators_are_not_public_abi(self) -> None:
        source = (ROOT / "move/test-amm/sources/lp_rewards.move").read_text()
        self.assert_package_only(
            source,
            (
                "initialize",
                "open_epoch",
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

    def test_core_uses_one_time_post_publish_mode_initialization(self) -> None:
        source = (ROOT / "move/reflection-core/sources/reflection_token.move").read_text()
        self.assertNotRegex(source, r"\bfun\s+init_module\s*\(")
        self.assertRegex(
            source,
            r"public\s+entry\s+fun\s+initialize\s*\(\s*admin:\s*&signer,\s*automatic_materialization:\s*bool",
        )
        self.assertIn("automatic_materialization_enabled", source)
        self.assertNotRegex(source, r"fun\s+set_automatic_materialization\s*\(")

    def test_core_event_emitters_are_not_publicly_forgeable(self) -> None:
        source = (ROOT / "move/reflection-core/sources/reflection_events.move").read_text()
        emitters = re.findall(r"public(?:\(package\))?\s+fun\s+([a-z_]+)\s*\(", source)
        self.assertGreater(len(emitters), 0)
        self.assertNotRegex(source, r"(?m)^\s*public\s+fun\s+[a-z_]+\s*\(")
        self.assertIn("public(package) fun protocol_initialized", source)

    def test_asset_metadata_is_public_and_unmistakably_testnet(self) -> None:
        core = (ROOT / "move/reflection-core/sources/reflection_token.move").read_text()
        quote = (ROOT / "move/test-assets/sources/mock_usd.move").read_text()
        self.assertNotIn("example.invalid", core + quote)
        self.assertIn("trfl-testnet.svg", core)
        self.assertIn("tusd-testnet.svg", quote)
        for asset in ("trfl-testnet.svg", "tusd-testnet.svg"):
            contents = (ROOT / "assets" / asset).read_text()
            self.assertIn("CEDRA TESTNET", contents)
            self.assertIn("NO VALUE", contents)

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


if __name__ == "__main__":
    unittest.main()
