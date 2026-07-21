#!/usr/bin/bash -p
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s FINALIZED_RELEASE_MANIFEST_JSON TRUSTED_ALLOWED_SIGNERS_FILE\n' "$0" >&2
  /usr/bin/printf 'the allowed-signers file is an external trust anchor, never taken from the manifest bundle\n' >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
repo_root="$(builtin cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/.." && builtin pwd -P)"
[[ -f "$1" && ! -L "$1" && -f "$2" && ! -L "$2" ]] || {
  /usr/bin/printf 'release manifest and trust anchor must be regular non-symlink files\n' >&2
  exit 66
}
manifest="$(/usr/bin/readlink -f "$1")"
trusted_allowed_signers="$(/usr/bin/readlink -f "$2")"
evidence_validator="$repo_root/scripts/validate_release_evidence.sh"

[[ -f "$manifest" && ! -L "$manifest" ]] || {
  /usr/bin/printf 'release manifest must be a regular non-symlink file: %s\n' "$1" >&2
  exit 66
}
[[ -f "$trusted_allowed_signers" && ! -L "$trusted_allowed_signers" ]] || {
  /usr/bin/printf 'trusted allowed-signers file must be a regular non-symlink file\n' >&2
  exit 66
}
manifest_directory="$(/usr/bin/dirname "$manifest")"

/usr/bin/jq -e '
  def exact_keys($wanted): (keys | sort) == ($wanted | sort);
  def sha256: type == "string" and test("^[0-9a-f]{64}$");
  def framework_digest: type == "string" and test("^[0-9A-F]{64}$");
  def commit: type == "string" and test("^[0-9a-f]{40}$");
  def address: type == "string" and test("^0x[1-9a-f][0-9a-f]{0,63}$");
  def txhash: type == "string" and test("^0x[0-9a-f]{64}$");
  def decimal: type == "string" and test("^(0|[1-9][0-9]*)$");
  def positive_decimal: decimal and (tonumber > 0);
  def binding:
    exact_keys(["file", "sha256"])
    and (.file | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$") and (test("(^|/)\\.\\.(/|$)|//") | not))
    and (.sha256 | sha256);
  def transaction_binding:
    exact_keys(["file", "sha256", "transaction_hash"])
    and ({file:.file,sha256:.sha256} | binding)
    and (.transaction_hash | txhash);
  def package:
    exact_keys(["compiled_package_files_manifest_sha256", "custom_package_source_sha256", "embedded_package_metadata_source_digest", "event_source_address", "finalized_ledger_version", "gas_used", "metadata_bcs_sha256", "on_chain_package_metadata_source_digest", "on_chain_upgrade_number", "on_chain_upgrade_policy_number", "publish_payload_sha256", "publish_transaction", "publisher", "review_bundle_files_manifest_sha256", "upgrade_policy"])
    and (.publisher | address)
    and .event_source_address == .publisher
    and .upgrade_policy == "immutable"
    and (.custom_package_source_sha256 | sha256)
    and (.metadata_bcs_sha256 | sha256)
    and (.compiled_package_files_manifest_sha256 | sha256)
    and (.review_bundle_files_manifest_sha256 | sha256)
    and (.publish_payload_sha256 | sha256)
    and (.embedded_package_metadata_source_digest | framework_digest)
    and .on_chain_package_metadata_source_digest == .embedded_package_metadata_source_digest
    and .on_chain_upgrade_number == "0"
    and .on_chain_upgrade_policy_number == 2
    and (.publish_transaction | txhash)
    and (.gas_used | decimal)
    and (.finalized_ledger_version | decimal);
  def no_placeholders:
    [.. | strings | select(test("RECORD_|RFC3339_TIMESTAMP|draft-template-not-valid|PENDING_"))] | length == 0;

  exact_keys(["api_url", "application_commit", "approval_policy", "bootstrap_liquidity", "chain_id", "contract_configuration", "deployment_id", "event_schema_version", "evidence_scope", "execution_order", "external_execution_boundary", "framework_commit", "hook_probe", "initial_reconciliation_snapshot", "initialization", "metadata", "network", "no_value_notice", "objects", "operational_authority", "packages", "provenance", "release", "review", "roles", "schema_version", "status", "transactions"])
  and .schema_version == 2
  and .evidence_scope == "finalized-testnet-release-manifest"
  and .status == "finalized"
  and .network == "cedra-testnet"
  and .chain_id == "2"
  and .api_url == "https://testnet.cedra.dev/v1"
  and (.deployment_id | type == "string" and test("^[A-Za-z0-9._-]{1,80}$"))
  and (.release | type == "string" and test("^testnet-v[0-9]+\\.[0-9]+\\.[0-9]+([+-][A-Za-z0-9.-]+)?$"))
  and .event_schema_version == 1
  and .no_value_notice == "TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE"
  and (.framework_commit | commit)
  and (.application_commit | commit)
  and (.roles | exact_keys(["amm_publisher", "assets_publisher", "bootstrap_lp", "core_publisher", "operations"]))
  and all(.roles[]; address)
  and ([.roles[]] | unique | length == 5)
  and (.provenance | exact_keys(["application_tree", "clean_verification_record", "exact_address_artifacts", "public_profile_preflight", "public_role_candidate", "release_source_sha256", "working_tree_clean"]))
  and (.provenance.application_tree | commit)
  and .provenance.working_tree_clean == true
  and (.provenance.release_source_sha256 | sha256)
  and (.provenance.public_role_candidate | binding)
  and (.provenance.public_profile_preflight | binding)
  and (.provenance.clean_verification_record | binding)
  and (.provenance.exact_address_artifacts | binding)
  and (.approval_policy | exact_keys(["required_distinct_identities", "required_distinct_signing_keys", "signature_namespace", "trusted_allowed_signers_sha256"]))
  and .approval_policy.signature_namespace == "cedra-reflect-testnet-release-v1"
  and (.approval_policy.trusted_allowed_signers_sha256 | sha256)
  and .approval_policy.required_distinct_identities == 2
  and .approval_policy.required_distinct_signing_keys == 2
  and .external_execution_boundary == {
    repository_reads_private_keys:false,
    repository_signs_transactions:false,
    repository_submits_transactions:false,
    approved_candidate_may_be_rebuilt:false,
    external_signing_and_submission_ceremony_required:true
  }
  and .execution_order == ["core_publish", "core_initialize", "assets_publish", "amm_publish", "faucet_initialize", "amm_tusd_claim", "pool_initialize", "atomic_operational_handoff", "pool_seed"]
  and (.packages | exact_keys(["reflection_core", "test_amm", "test_assets"]))
  and all(.packages[]; package)
  and .packages.reflection_core.publisher == .roles.core_publisher
  and .packages.test_assets.publisher == .roles.assets_publisher
  and .packages.test_amm.publisher == .roles.amm_publisher
  and (.transactions | exact_keys(["amm_publish", "amm_tusd_claim", "assets_publish", "atomic_operational_handoff", "core_initialize", "core_publish", "faucet_initialize", "pool_initialize", "pool_seed"]))
  and all(.transactions[]; transaction_binding)
  and ([.transactions[].transaction_hash] | unique | length == 9)
  and .packages.reflection_core.publish_transaction == .transactions.core_publish.transaction_hash
  and .packages.test_assets.publish_transaction == .transactions.assets_publish.transaction_hash
  and .packages.test_amm.publish_transaction == .transactions.amm_publish.transaction_hash
  and (.contract_configuration | exact_keys(["arbitrary_external_vaults_supported", "automatic_materialization", "initial_reflection_fee_bps", "maximum_reflection_fee_bps", "supported_custody_adapters", "trfl_decimals", "trfl_fixed_supply_base_units"]))
  and .contract_configuration.trfl_decimals == 6
  and .contract_configuration.trfl_fixed_supply_base_units == "1000000000000000"
  and (.contract_configuration.initial_reflection_fee_bps | type == "number" and floor == . and . >= 0 and . <= 100)
  and .contract_configuration.maximum_reflection_fee_bps == 100
  and .contract_configuration.initial_reflection_fee_bps <= .contract_configuration.maximum_reflection_fee_bps
  and .contract_configuration.automatic_materialization == false
  and .contract_configuration.supported_custody_adapters == 1
  and .contract_configuration.arbitrary_external_vaults_supported == false
  and (.metadata | exact_keys(["project_url", "trfl_icon_sha256", "trfl_icon_url", "tusd_icon_sha256", "tusd_icon_url"]))
  and (.metadata.project_url | startswith("https://"))
  and (.metadata.trfl_icon_url | startswith("https://"))
  and (.metadata.tusd_icon_url | startswith("https://"))
  and (.metadata.trfl_icon_sha256 | sha256)
  and (.metadata.tusd_icon_sha256 | sha256)
  and (.operational_authority | exact_keys(["address", "atomic_handoff_transaction", "reconciled_ledger_version"]))
  and .operational_authority.address == .roles.operations
  and .operational_authority.atomic_handoff_transaction == .transactions.atomic_operational_handoff.transaction_hash
  and (.operational_authority.reconciled_ledger_version | decimal)
  and (.bootstrap_liquidity | exact_keys(["beneficiary", "minimum_lp_shares", "rfl_amount", "seed_transaction", "usd_amount"]))
  and .bootstrap_liquidity.beneficiary == .roles.bootstrap_lp
  and (.bootstrap_liquidity.rfl_amount | positive_decimal)
  and (.bootstrap_liquidity.usd_amount | positive_decimal)
  and (.bootstrap_liquidity.minimum_lp_shares | positive_decimal)
  and .bootstrap_liquidity.seed_transaction == .transactions.pool_seed.transaction_hash
  and (.objects | exact_keys(["active_lp_epoch", "active_lp_state", "distribution_vault", "lp_epoch_registry", "lp_reward_vault", "lp_share_representation", "mock_usd_metadata", "pool", "pool_custody_store", "pool_quote_reserve_store", "reward_vault", "token_metadata"]))
  and .objects.lp_share_representation == "account-bound-table"
  and (.objects.active_lp_epoch | decimal)
  and all(.objects | to_entries[] | select(.key != "active_lp_epoch" and .key != "lp_share_representation") | .value; address)
  and (.initialization | exact_keys(["automatic_materialization", "core_transaction", "faucet_transaction", "finalized_ledger_version", "pool_transaction"]))
  and .initialization.automatic_materialization == false
  and .initialization.core_transaction == .transactions.core_initialize.transaction_hash
  and .initialization.faucet_transaction == .transactions.faucet_initialize.transaction_hash
  and .initialization.pool_transaction == .transactions.pool_initialize.transaction_hash
  and (.initialization.finalized_ledger_version | decimal)
  and (.initial_reconciliation_snapshot | binding)
  and (.hook_probe | exact_keys(["file", "mode", "sha256"]))
  and .hook_probe.mode == "claim-backed"
  and ({file:.hook_probe.file,sha256:.hook_probe.sha256} | binding)
  and (.review | exact_keys(["independent_review", "unresolved_critical_findings", "unresolved_high_findings"]))
  and (.review.independent_review | binding)
  and .review.unresolved_critical_findings == 0
  and .review.unresolved_high_findings == 0
  and no_placeholders
' "$manifest" >/dev/null || {
  /usr/bin/printf 'release manifest failed strict structural or semantic validation: %s\n' "$manifest" >&2
  exit 65
}

resolve_binding() {
  local jq_path="$1"
  local label="$2"
  local relative expected full resolved
  relative="$(/usr/bin/jq -er "$jq_path.file" "$manifest")"
  expected="$(/usr/bin/jq -er "$jq_path.sha256" "$manifest")"
  [[ "$relative" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$ \
    && "$relative" != /* \
    && "$relative" != *//* \
    && ! "/$relative/" =~ /\.\.?/ ]] || {
    /usr/bin/printf 'unsafe relative evidence path for %s: %s\n' "$label" "$relative" >&2
    exit 65
  }
  full="$manifest_directory/$relative"
  [[ -f "$full" && ! -L "$full" ]] || {
    /usr/bin/printf 'bound evidence is missing or is a symlink for %s: %s\n' "$label" "$full" >&2
    exit 66
  }
  resolved="$(/usr/bin/readlink -f "$full")"
  [[ "$resolved" == "$manifest_directory/"* ]] || {
    /usr/bin/printf 'bound evidence escapes the manifest directory for %s\n' "$label" >&2
    exit 65
  }
  [[ "$(/usr/bin/sha256sum "$resolved" | /usr/bin/cut -d ' ' -f 1)" == "$expected" ]] || {
    /usr/bin/printf 'bound evidence digest mismatch for %s\n' "$label" >&2
    exit 65
  }
  /usr/bin/printf '%s' "$resolved"
}

[[ "$(/usr/bin/sha256sum "$trusted_allowed_signers" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.approval_policy.trusted_allowed_signers_sha256' "$manifest")" ]] || {
  /usr/bin/printf 'release manifest trust-anchor digest mismatch\n' >&2
  exit 65
}

role_candidate="$(resolve_binding '.provenance.public_role_candidate' 'public role candidate')"
profile_preflight="$(resolve_binding '.provenance.public_profile_preflight' 'public profile preflight')"
clean_verification="$(resolve_binding '.provenance.clean_verification_record' 'clean verification')"
exact_artifacts="$(resolve_binding '.provenance.exact_address_artifacts' 'exact-address artifacts')"
snapshot="$(resolve_binding '.initial_reconciliation_snapshot' 'initial reconciliation snapshot')"
hook_probe="$(resolve_binding '.hook_probe' 'hook probe')"
independent_review="$(resolve_binding '.review.independent_review' 'independent review')"

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc -p "$evidence_validator" "$role_candidate" >/dev/null
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc -p "$evidence_validator" "$profile_preflight" >/dev/null
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc -p "$evidence_validator" "$clean_verification" >/dev/null
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc -p "$evidence_validator" "$exact_artifacts" >/dev/null

manifest_roles="$(/usr/bin/jq -cS '.roles' "$manifest")"
candidate_roles="$(/usr/bin/jq -cS '{core_publisher:.roles.core_publisher.address,assets_publisher:.roles.assets_publisher.address,amm_publisher:.roles.amm_publisher.address,operations:.roles.operations.address,bootstrap_lp:.roles.bootstrap_lp.address} | with_entries(.value |= (ascii_downcase | sub("^0x0+"; "0x")))' "$role_candidate")"
profile_roles="$(/usr/bin/jq -cS '.profiles | with_entries(.value = ("0x" + .value.account | ascii_downcase | sub("^0x0+"; "0x")))' "$profile_preflight")"
[[ "$manifest_roles" == "$candidate_roles" && "$manifest_roles" == "$profile_roles" ]] || {
  /usr/bin/printf 'five-role addresses differ across manifest, role candidate, and public profiles\n' >&2
  exit 65
}
[[ "$(/usr/bin/jq -r '.public_role_candidate_sha256' "$profile_preflight")" == "$(/usr/bin/sha256sum "$role_candidate" | /usr/bin/cut -d ' ' -f 1)" ]] || {
  /usr/bin/printf 'public profile preflight is not bound to the manifest role candidate\n' >&2
  exit 65
}
[[ "$(/usr/bin/jq -r '.application_commit' "$manifest")" == "$(/usr/bin/jq -r '.application_commit' "$clean_verification")" \
  && "$(/usr/bin/jq -r '.application_commit' "$manifest")" == "$(/usr/bin/jq -r '.application_commit' "$exact_artifacts")" \
  && "$(/usr/bin/jq -r '.provenance.application_tree' "$manifest")" == "$(/usr/bin/jq -r '.application_tree' "$clean_verification")" \
  && "$(/usr/bin/jq -r '.provenance.release_source_sha256' "$manifest")" == "$(/usr/bin/jq -r '.release_source_sha256' "$clean_verification")" \
  && "$(/usr/bin/jq -r '.provenance.release_source_sha256' "$manifest")" == "$(/usr/bin/jq -r '.release_source_sha256' "$exact_artifacts")" ]] || {
  /usr/bin/printf 'manifest commit/tree/custom source provenance does not cross-bind clean and exact-address evidence\n' >&2
  exit 65
}
[[ "$(/usr/bin/jq -cS '.roles' "$exact_artifacts")" == "$manifest_roles" ]] || {
  /usr/bin/printf 'exact-address role map differs from release manifest\n' >&2
  exit 65
}
[[ "$(/usr/bin/jq -r '.toolchain.cedra_cli_sha256' "$clean_verification")" == "$(/usr/bin/jq -r '.toolchain.cedra_cli_sha256' "$exact_artifacts")" \
  && "$(/usr/bin/jq -r '.toolchain.cedra_cli_sha256' "$exact_artifacts")" == "$(/usr/bin/jq -r '.toolchain.cedra_cli_sha256' "$profile_preflight")" ]] || {
  /usr/bin/printf 'Cedra CLI binary digest differs across public preflight, clean verification, and exact build\n' >&2
  exit 65
}

declare -A transaction_files
for operation in core_publish core_initialize assets_publish amm_publish faucet_initialize amm_tusd_claim pool_initialize atomic_operational_handoff pool_seed; do
  transaction_files[$operation]="$(resolve_binding ".transactions.$operation" "$operation transaction")"
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
    EXACT_ADDRESS_ARTIFACTS_FILE="$exact_artifacts" \
    PUBLIC_PROFILE_EVIDENCE_FILE="$profile_preflight" \
    TRUSTED_ALLOWED_SIGNERS_FILE="$trusted_allowed_signers" \
    RELEASE_NODE_RUNTIME="${RELEASE_NODE_RUNTIME:-}" \
    SDK_REVIEW_ATTESTATION="${SDK_REVIEW_ATTESTATION:-}" \
    SDK_REVIEW_SIGNATURE="${SDK_REVIEW_SIGNATURE:-}" \
    SDK_REVIEW_TRUSTED_SIGNERS="${SDK_REVIEW_TRUSTED_SIGNERS:-}" \
    /usr/bin/bash --noprofile --norc -p "$evidence_validator" "${transaction_files[$operation]}" >/dev/null
  /usr/bin/jq -e \
    --arg operation "$operation" \
    --arg commit "$(/usr/bin/jq -r '.application_commit' "$manifest")" \
    --arg deployment "$(/usr/bin/jq -r '.deployment_id' "$manifest")" \
    --arg exact_sha "$(/usr/bin/sha256sum "$exact_artifacts" | /usr/bin/cut -d ' ' -f 1)" \
    --arg profile_sha "$(/usr/bin/sha256sum "$profile_preflight" | /usr/bin/cut -d ' ' -f 1)" \
    --arg role_sha "$(/usr/bin/sha256sum "$role_candidate" | /usr/bin/cut -d ' ' -f 1)" \
    --arg trust_sha "$(/usr/bin/sha256sum "$trusted_allowed_signers" | /usr/bin/cut -d ' ' -f 1)" \
    --arg txhash "$(/usr/bin/jq -r ".transactions.$operation.transaction_hash" "$manifest")" \
    --argjson roles "$manifest_roles" '
      .operation_key == $operation
      and .application_commit == $commit
      and .deployment_id == $deployment
      and .exact_address_artifacts_sha256 == $exact_sha
      and .public_profile_evidence_sha256 == $profile_sha
      and .public_role_candidate_sha256 == $role_sha
      and .approval.trusted_allowed_signers_sha256 == $trust_sha
      and .transaction_hash == $txhash
      and .roles == $roles
      and .approval.authenticated == true
      and (.approval.signatures | length == 2)
      and ([.approval.signatures[].identity] | unique | length == 2)
      and ([.approval.signatures[].key_fingerprint] | unique | length == 2)
    ' "${transaction_files[$operation]}" >/dev/null || {
      /usr/bin/printf 'transaction evidence does not cross-bind release manifest for %s\n' "$operation" >&2
      exit 65
    }
done

for mapping in 'reflection_core:core_publish:ReflectionCore' 'test_assets:assets_publish:TestAssets' 'test_amm:amm_publish:TestAmm'; do
  IFS=: builtin read -r package operation package_name <<<"$mapping"
  tx_file="${transaction_files[$operation]}"
  /usr/bin/jq -e \
    --arg package "$package" \
    --arg publisher "$(/usr/bin/jq -r ".packages.$package.publisher" "$manifest")" \
    --arg custom_source "$(/usr/bin/jq -r ".packages.$package.custom_package_source_sha256" "$manifest")" \
    --arg metadata_sha "$(/usr/bin/jq -r ".packages.$package.metadata_bcs_sha256" "$manifest")" \
    --arg compiled_sha "$(/usr/bin/jq -r ".packages.$package.compiled_package_files_manifest_sha256" "$manifest")" \
    --arg review_sha "$(/usr/bin/jq -r ".packages.$package.review_bundle_files_manifest_sha256" "$manifest")" \
    --arg payload_sha "$(/usr/bin/jq -r ".packages.$package.publish_payload_sha256" "$manifest")" \
    --arg embedded_digest "$(/usr/bin/jq -r ".packages.$package.embedded_package_metadata_source_digest" "$manifest")" \
    --arg package_name "$package_name" '
      .packages[$package]
      | .publisher == $publisher
      and .event_source_address == $publisher
      and .package_source_sha256 == $custom_source
      and .metadata_bcs_sha256 == $metadata_sha
      and .compiled_package_files_manifest_sha256 == $compiled_sha
      and .review_bundle_files_manifest_sha256 == $review_sha
      and .publish_payload_sha256 == $payload_sha
      and .embedded_package_metadata == {name:$package_name,source_digest:$embedded_digest,upgrade_number:"0",upgrade_policy_number:2}
    ' "$exact_artifacts" >/dev/null || {
      /usr/bin/printf 'release package fields differ from exact-address artifact for %s\n' "$package" >&2
      exit 65
    }
  /usr/bin/jq -e \
    --arg digest "$(/usr/bin/jq -r ".packages.$package.on_chain_package_metadata_source_digest" "$manifest")" \
    --arg publisher "$(/usr/bin/jq -r ".packages.$package.publisher" "$manifest")" \
    --arg package_name "$package_name" \
    --arg gas "$(/usr/bin/jq -r ".packages.$package.gas_used" "$manifest")" \
    --arg ledger "$(/usr/bin/jq -r ".packages.$package.finalized_ledger_version" "$manifest")" '
      .collection.package_registry == {resource_address:$publisher,resource_type:"0x1::code::PackageRegistry",package_name:$package_name,source_digest:$digest,upgrade_number:"0",upgrade_policy_number:2}
      and .collection.gas_used == $gas
      and .collection.ledger_version == $ledger
    ' "$tx_file" >/dev/null || {
      /usr/bin/printf 'release package on-chain PackageRegistry/gas/ledger fields differ from finalized evidence for %s\n' "$package" >&2
      exit 65
    }
done

/usr/bin/jq -e \
  --arg rfl "$(/usr/bin/jq -r '.bootstrap_liquidity.rfl_amount' "$manifest")" \
  --arg usd "$(/usr/bin/jq -r '.bootstrap_liquidity.usd_amount' "$manifest")" \
  --arg min_lp "$(/usr/bin/jq -r '.bootstrap_liquidity.minimum_lp_shares' "$manifest")" \
  '.collection.payload.arguments == [$rfl,$usd,$min_lp]' "${transaction_files[pool_seed]}" >/dev/null || {
  /usr/bin/printf 'bootstrap liquidity amounts differ from the approved/finalized seed transaction\n' >&2
  exit 65
}

[[ -s "$snapshot" && -s "$hook_probe" && -s "$independent_review" ]] || {
  /usr/bin/printf 'release-level reconciliation, hook, or independent-review evidence is empty\n' >&2
  exit 65
}

/usr/bin/printf 'valid cryptographically cross-bound finalized Testnet release manifest: %s\n' "$manifest"
/usr/bin/printf 'all nine finalized transactions retain their exact BCS candidate, simulation, two distinct-key approvals, and raw Testnet responses\n'
/usr/bin/printf 'custom release/package source digests remain separate from the verified embedded/on-chain PackageMetadata.source_digest values\n'
