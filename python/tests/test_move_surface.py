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


if __name__ == "__main__":
    unittest.main()
