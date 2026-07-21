import hashlib
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
        self.assertEqual(manifest["schema_version"], 2)
        self.assertEqual(manifest["event_schema_version"], 2)
        self.assertEqual(manifest["network"], "cedra-testnet")
        self.assertEqual(manifest["chain_id"], "2")
        self.assertEqual(manifest["release"], "testnet-v0.2.0")
        self.assertEqual(
            set(manifest["roles"]),
            {"core_publisher", "assets_publisher", "amm_publisher", "bootstrap_lp"},
        )
        self.assertEqual(
            set(manifest["packages"]),
            {"reflection_core", "test_assets", "test_amm"},
        )
        for package in manifest["packages"].values():
            self.assertTrue(
                {
                    "publisher",
                    "event_source_address",
                    "upgrade_policy",
                    "custom_package_source_sha256",
                    "metadata_bcs_sha256",
                    "compiled_package_files_manifest_sha256",
                    "review_bundle_files_manifest_sha256",
                    "publish_payload_sha256",
                    "embedded_package_metadata_source_digest",
                    "on_chain_package_metadata_source_digest",
                    "on_chain_upgrade_number",
                    "on_chain_upgrade_policy_number",
                    "publish_transaction",
                    "gas_used",
                    "finalized_ledger_version",
                }.issubset(package)
            )
            self.assertEqual(package["upgrade_policy"], "immutable")
            self.assertEqual(package["event_source_address"], package["publisher"])

        configuration = manifest["contract_configuration"]
        self.assertEqual(configuration["trfl_fixed_supply_base_units"], "1000000000000000")
        self.assertEqual(configuration["initial_reflection_fee_bps"], 100)
        self.assertEqual(configuration["maximum_reflection_fee_bps"], 500)
        self.assertTrue(configuration["automatic_materialization"])
        self.assertEqual(configuration["lifecycle"], "LIVE")
        self.assertTrue(configuration["ownerless"])
        self.assertIsNone(configuration["privileged_address"])
        self.assertFalse(configuration["arbitrary_external_vaults_supported"])
        for symbol in ("trfl", "tusd"):
            asset = ROOT / "assets" / f"{symbol}-testnet.svg"
            digest = hashlib.sha256(asset.read_bytes()).hexdigest()
            self.assertEqual(manifest["metadata"][f"{symbol}_icon_sha256"], digest)

        self.assertNotIn("operational_authority", manifest)
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
            manifest["bootstrap_liquidity"],
            {
                "beneficiary": manifest["roles"]["bootstrap_lp"],
                "rfl_amount": "500000000",
                "usd_amount": "500000000",
                "initial_lp_shares": "500000000",
                "launch_transaction": manifest["transactions"]["pool_launch"]["transaction_hash"],
            },
        )
        self.assertTrue(manifest["initialization"]["automatic_materialization"])
        self.assertIn("core_transaction", manifest["initialization"])
        self.assertEqual(
            manifest["initialization"]["launch_transaction"],
            manifest["transactions"]["pool_launch"]["transaction_hash"],
        )
        self.assertEqual(
            set(manifest["hook_probe"]),
            {"file", "sha256", "mode"},
        )
        self.assertEqual(manifest["hook_probe"]["mode"], "automatic-materialisation")
        self.assertEqual(manifest["approval_policy"]["required_distinct_identities"], 1)
        self.assertEqual(manifest["approval_policy"]["required_distinct_signing_keys"], 1)
        approval_envelope = self.load_json(
            "ops/evidence/transaction-approval-envelope.template.json"
        )
        self.assertEqual(len(approval_envelope["approvals"]), 1)
        expected_operations = {
            "core_publish",
            "core_initialize",
            "assets_publish",
            "amm_publish",
            "pool_launch",
        }
        self.assertEqual(len(manifest["execution_order"]), 5)
        self.assertEqual(set(manifest["execution_order"]), expected_operations)
        self.assertEqual(set(manifest["transactions"]), expected_operations)
        self.assertFalse(manifest["external_execution_boundary"]["repository_signs_transactions"])
        self.assertFalse(manifest["external_execution_boundary"]["repository_submits_transactions"])
        self.assertFalse(manifest["external_execution_boundary"]["repository_reads_private_keys"])
        self.assertEqual(manifest["review"]["unresolved_critical_findings"], 0)
        self.assertEqual(manifest["review"]["unresolved_high_findings"], 0)

    def test_transaction_templates_use_only_the_ownerless_v02_roles(self) -> None:
        expected_roles = {"core_publisher", "assets_publisher", "amm_publisher", "bootstrap_lp"}

        build_request = self.load_json("ops/evidence/transaction-build-request.template.json")
        self.assertEqual(set(build_request["roles"]), expected_roles)
        self.assertEqual(set(build_request["profile_public_keys"]), expected_roles)
        self.assertNotIn("seed_amounts", build_request)

        transaction = self.load_json("ops/evidence/transaction-evidence.template.json")
        self.assertEqual(set(transaction["roles"]), expected_roles)
        self.assertEqual(set(transaction["public_profile_binding"]["profiles"]), expected_roles)

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
        self.assertEqual(report["mode_decision"], "automatic-materialisation")

    def test_finalized_hook_probe_record_is_complete_and_claim_backed(self) -> None:
        report = self.load_json("ops/evidence/hook-probe-testnet.json")
        experiments = report["experiments"]
        self.assertEqual(
            {entry["experiment"] for entry in experiments},
            {f"H{number}" for number in range(1, 9)},
        )
        self.assertTrue(all(entry["result"] == "pass" for entry in experiments[:7]))
        self.assertEqual(experiments[7]["result"], "fail")
        self.assertEqual(report["mode_decision"], "claim-backed")
        self.assertNotIn("RECORD_", json.dumps(report))
        self.assertNotIn("PENDING_", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
