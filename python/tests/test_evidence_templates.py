import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class EvidenceTemplateTests(unittest.TestCase):
    def load_json(self, relative_path: str) -> dict:
        with (ROOT / relative_path).open(encoding="utf-8") as handle:
            return json.load(handle)

    def test_release_manifest_covers_every_package_authority_and_state_identity(self) -> None:
        manifest = self.load_json("ops/release-manifest.template.json")
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["network"], "cedra-testnet")
        self.assertEqual(
            set(manifest["packages"]),
            {"reflection_core", "test_assets", "test_amm"},
        )
        for package in manifest["packages"].values():
            self.assertTrue(
                {
                    "publisher",
                    "source_digest",
                    "compiled_package_digest",
                    "publish_payload_bytes",
                    "publish_transaction",
                    "gas_used",
                    "finalized_ledger_version",
                }.issubset(package)
            )

        self.assertTrue(
            {
                "address",
                "core_handoff_transaction",
                "faucet_handoff_transaction",
                "amm_handoff_transaction",
                "reconciled_ledger_version",
            }.issubset(manifest["operational_authority"])
        )
        self.assertTrue(
            {
                "token_metadata",
                "reward_vault",
                "distribution_vault",
                "pool",
                "pool_custody_store",
                "pool_quote_reserve_store",
                "lp_share_representation",
                "lp_epoch_registry",
                "active_lp_epoch",
                "active_lp_state",
                "lp_reward_vault",
                "mock_usd_metadata",
            }.issubset(manifest["objects"])
        )
        self.assertEqual(manifest["objects"]["lp_share_representation"], "account-bound-table")
        self.assertEqual(
            set(manifest["hook_probe"]),
            {"testnet_report", "mode"},
        )
        self.assertEqual(len(manifest["approvals"]), 2)
        self.assertEqual(len({entry["role"] for entry in manifest["approvals"]}), 2)
        self.assertEqual(manifest["review"]["unresolved_critical_findings"], 0)
        self.assertEqual(manifest["review"]["unresolved_high_findings"], 0)

    def test_hook_probe_template_has_one_complete_slot_for_h1_through_h8(self) -> None:
        report = self.load_json("ops/evidence/hook-probe.template.json")
        self.assertEqual(report["schema_version"], 1)
        self.assertEqual(report["network"], "cedra-testnet")
        experiments = report["experiments"]
        self.assertEqual(len(experiments), 8)
        self.assertEqual(
            {entry["experiment"] for entry in experiments},
            {f"H{number}" for number in range(1, 9)},
        )
        for entry in experiments:
            self.assertTrue(
                {
                    "name",
                    "transaction_hash",
                    "finalized_ledger_version",
                    "gas_used",
                    "result",
                    "observations",
                    "evidence_references",
                }.issubset(entry)
            )
            self.assertTrue(entry["evidence_references"])
        self.assertEqual(len(report["approved_by"]), 2)


if __name__ == "__main__":
    unittest.main()
