#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s EVIDENCE_JSON\n' "$0" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
repo_root="$(builtin cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/.." && builtin pwd -P)"
evidence_file="$1"
[[ -f "$evidence_file" && ! -L "$evidence_file" ]] || {
  /usr/bin/printf 'evidence must be a regular non-symlink file: %s\n' "$evidence_file" >&2
  exit 66
}

evidence_file="$(/usr/bin/readlink -f "$evidence_file")"
evidence_directory="$(/usr/bin/dirname "$evidence_file")"
scope="$(/usr/bin/jq -er '.evidence_scope | select(type == "string")' "$evidence_file")" || {
  /usr/bin/printf 'evidence JSON is invalid or has no evidence_scope: %s\n' "$evidence_file" >&2
  exit 65
}

validate_local_release_build() {
  /usr/bin/jq -e '
    def exact_keys($wanted): (keys | sort) == ($wanted | sort);
    def sha256: type == "string" and test("^[0-9a-f]{64}$");
    def commit: type == "string" and test("^[0-9a-f]{40}$");
    def rfc3339: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def package:
      exact_keys(["compiled_artifact_present", "compiled_artifact_sha256", "dev_address_compiled_components_bytes", "package_source_sha256", "publishable", "upgrade_policy"])
      and (.compiled_artifact_present | type == "boolean")
      and (if .compiled_artifact_present then (.compiled_artifact_sha256 | sha256) else .compiled_artifact_sha256 == null end)
      and (.package_source_sha256 | sha256)
      and (.dev_address_compiled_components_bytes | type == "number" and . >= 0 and floor == .)
      and (.publishable | type == "boolean")
      and (.upgrade_policy == "immutable" or .upgrade_policy == "compatible");
    exact_keys(["application_commit", "application_tree", "approval_eligible", "evidence_boundaries", "evidence_scope", "framework_revision", "generated_at", "network", "packages", "release_source_sha256", "schema_version", "toolchain", "working_tree_clean"])
    and .schema_version == 1
    and .evidence_scope == "local-release-build-verification"
    and .network == "local-dev-address-build"
    and (.generated_at | rfc3339)
    and (.application_commit | commit)
    and (.application_tree | commit)
    and (.working_tree_clean | type == "boolean")
    and (.release_source_sha256 | sha256)
    and (.framework_revision | commit)
    and .approval_eligible == false
    and (.toolchain | exact_keys(["cedra_cli_path", "cedra_cli_sha256", "cedra_cli_version"]))
    and (.toolchain.cedra_cli_path | type == "string" and startswith("/"))
    and (.toolchain.cedra_cli_sha256 | sha256)
    and (.toolchain.cedra_cli_version | type == "string" and length > 0)
    and (.packages | exact_keys(["hook_probe", "integration_tests", "reflection_core", "test_amm", "test_assets"]))
    and all(.packages[]; package)
    and (.packages.reflection_core.publishable == true and .packages.reflection_core.upgrade_policy == "immutable")
    and (.packages.test_assets.publishable == true and .packages.test_assets.upgrade_policy == "immutable")
    and (.packages.test_amm.publishable == true and .packages.test_amm.upgrade_policy == "immutable")
    and (.packages.hook_probe.publishable == false and .packages.integration_tests.publishable == false)
    and .packages.hook_probe.compiled_artifact_present == true
    and .packages.integration_tests.compiled_artifact_present == false
    and .packages.integration_tests.dev_address_compiled_components_bytes == 0
    and (.evidence_boundaries | exact_keys(["exact_publisher_addresses_used", "full_test_suite_executed", "network_state_observed", "transaction_simulated", "transaction_submitted"]))
    and (.evidence_boundaries == {
      exact_publisher_addresses_used:false,
      full_test_suite_executed:false,
      network_state_observed:false,
      transaction_simulated:false,
      transaction_submitted:false
    })
  ' "$evidence_file" >/dev/null
}

validate_clean_full_verification() {
  /usr/bin/jq -e '
    def exact_keys($wanted): (keys | sort) == ($wanted | sort);
    def sha256: type == "string" and test("^[0-9a-f]{64}$");
    def commit: type == "string" and test("^[0-9a-f]{40}$");
    def rfc3339: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def file_binding:
      exact_keys(["file", "sha256"])
      and (.file | type == "string" and test("^[A-Za-z0-9._-]+$") and (contains("..") | not))
      and (.sha256 | sha256);
    exact_keys(["application_commit", "application_tree", "evidence_boundaries", "evidence_scope", "framework_revision", "generated_at", "local_release_build_report", "model_gate_report", "network", "release_source_sha256", "schema_version", "toolchain", "verification_commands", "verification_log", "verification_succeeded", "working_tree_clean_after", "working_tree_clean_before"])
    and .schema_version == 1
    and .evidence_scope == "local-clean-full-verification"
    and .network == "local-only"
    and (.generated_at | rfc3339)
    and (.application_commit | commit)
    and (.application_tree | commit)
    and .working_tree_clean_before == true
    and .working_tree_clean_after == true
    and .verification_succeeded == true
    and (.release_source_sha256 | sha256)
    and (.framework_revision | commit)
    and (.toolchain | exact_keys(["cedra_cli_path", "cedra_cli_sha256", "cedra_cli_version"]))
    and (.toolchain.cedra_cli_path | type == "string" and startswith("/"))
    and (.toolchain.cedra_cli_sha256 | sha256)
    and (.toolchain.cedra_cli_version | type == "string" and length > 0)
    and (.verification_commands | type == "array" and length == 3 and all(.[]; type == "string" and length > 0))
    and (.verification_log | file_binding)
    and (.local_release_build_report | file_binding)
    and (.model_gate_report | file_binding)
    and (.evidence_boundaries | exact_keys(["exact_publisher_addresses_used", "network_state_observed", "transaction_simulated", "transaction_submitted"]))
    and (.evidence_boundaries == {
      exact_publisher_addresses_used:false,
      network_state_observed:false,
      transaction_simulated:false,
      transaction_submitted:false
    })
  ' "$evidence_file" >/dev/null

  local log_file build_report model_report
  log_file="$(/usr/bin/jq -r '.verification_log.file' "$evidence_file")"
  build_report="$(/usr/bin/jq -r '.local_release_build_report.file' "$evidence_file")"
  model_report="$(/usr/bin/jq -r '.model_gate_report.file' "$evidence_file")"
  [[ -f "$evidence_directory/$log_file" && -f "$evidence_directory/$build_report" && -f "$evidence_directory/$model_report" ]] || {
    /usr/bin/printf 'clean verification record is missing a bound file\n' >&2
    return 1
  }
  [[ "$(/usr/bin/sha256sum "$evidence_directory/$log_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.verification_log.sha256' "$evidence_file")" ]] || {
    /usr/bin/printf 'verification log digest mismatch\n' >&2
    return 1
  }
  [[ "$(/usr/bin/sha256sum "$evidence_directory/$build_report" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.local_release_build_report.sha256' "$evidence_file")" ]] || {
    /usr/bin/printf 'local release build report digest mismatch\n' >&2
    return 1
  }
  [[ "$(/usr/bin/sha256sum "$evidence_directory/$model_report" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.model_gate_report.sha256' "$evidence_file")" ]] || {
    /usr/bin/printf 'model-gate report digest mismatch\n' >&2
    return 1
  }
  /usr/bin/jq -e --arg commit "$(/usr/bin/jq -r '.application_commit' "$evidence_file")" '
    .schema == "cedra-reflection-model-gate/v2"
    and .release == "testnet-v0.2.0-ownerless"
    and .materialization_mode == "automatic-interaction"
    and .automatic_materialization == true
    and .lifecycle == "LIVE"
    and .requested_successful_operations >= 1000000
    and .successful == .requested_successful_operations
    and .attempts == (.successful + .rejected + .no_op)
    and .full_invariant_audits > 0
    and (.final_state_digest | type == "string" and test("^[0-9a-f]{64}$"))
    and .git_commit == $commit
    and .git_clean == true
  ' "$evidence_directory/$model_report" >/dev/null || {
    /usr/bin/printf 'model-gate report does not satisfy the release gate\n' >&2
    return 1
  }
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
    /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_release_evidence.sh" \
    "$evidence_directory/$build_report" >/dev/null
}

validate_exact_address_build() {
  /usr/bin/jq -e '
    def exact_keys($wanted): (keys | sort) == ($wanted | sort);
    def sha256: type == "string" and test("^[0-9a-f]{64}$");
    def commit: type == "string" and test("^[0-9a-f]{40}$");
    def address: type == "string" and test("^0x[1-9a-f][0-9a-f]{0,63}$");
    def rfc3339: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def binding:
      exact_keys(["local_release_build_report_file", "local_release_build_report_sha256", "model_gate_report_file", "model_gate_report_sha256", "record_file", "record_sha256", "verification_log_file", "verification_log_sha256"])
      and (.record_file == "provenance/verification-record.json")
      and (.verification_log_file == "provenance/verification.log")
      and (.local_release_build_report_file == "provenance/local-release-build.json")
      and (.model_gate_report_file == "provenance/model-gate-report.json")
      and (.record_sha256 | sha256)
      and (.verification_log_sha256 | sha256)
      and (.local_release_build_report_sha256 | sha256)
      and (.model_gate_report_sha256 | sha256);
    def role_binding:
      exact_keys(["file", "sha256"])
      and .file == "provenance/public-role-candidate.json"
      and (.sha256 | sha256);
    def module_binding:
      exact_keys(["bytes", "file", "sha256"])
      and (.file | type == "string" and test("^[A-Za-z_][A-Za-z0-9_]*\\.mv$"))
      and (.sha256 | sha256)
      and (.bytes | type == "number" and . > 0 and floor == .);
    def embedded_metadata:
      exact_keys(["name", "source_digest", "upgrade_number", "upgrade_policy_number"])
      and (.name | IN("ReflectionCore", "TestAssets", "TestAmm"))
      and (.source_digest | type == "string" and test("^[0-9A-F]{64}$"))
      and .upgrade_number == "0"
      and .upgrade_policy_number == 2;
    def package:
      exact_keys(["cedra_cli_publish_data_size_bytes", "cedra_cli_publish_payload_file", "cedra_cli_publish_payload_sha256", "compiled_package_files_manifest", "compiled_package_files_manifest_sha256", "embedded_package_metadata", "event_source_address", "metadata_bcs_file", "metadata_bcs_sha256", "module_bytecode", "named_addresses", "normal_publish_data_limit_bytes", "normal_transaction_size_limit_bytes", "package_source_sha256", "publish_payload_argument_bytes", "publish_payload_file", "publish_payload_json_bytes", "publish_payload_sha256", "publisher", "review_bundle_files_manifest", "review_bundle_files_manifest_sha256", "transaction_bcs_size_bytes", "upgrade_policy", "within_normal_publish_data_limit", "within_normal_transaction_size_limit"])
      and (.publisher | address)
      and .event_source_address == .publisher
      and .upgrade_policy == "immutable"
      and (.package_source_sha256 | sha256)
      and (.embedded_package_metadata | embedded_metadata)
      and .compiled_package_files_manifest == "compiled-package-files.sha256"
      and (.compiled_package_files_manifest_sha256 | sha256)
      and .review_bundle_files_manifest == "review-bundle-files.sha256"
      and (.review_bundle_files_manifest_sha256 | sha256)
      and .metadata_bcs_file == "package-metadata.bcs"
      and (.metadata_bcs_sha256 | sha256)
      and (.module_bytecode | type == "array" and length > 0 and all(.[]; module_binding))
      and (.module_bytecode as $modules | [$modules[].file] | unique | length == ($modules | length))
      and .publish_payload_file == "publish-payload.json"
      and (.publish_payload_sha256 | sha256)
      and (.publish_payload_argument_bytes | type == "number" and . > 0 and floor == .)
      and (.publish_payload_json_bytes | type == "number" and . > 0 and floor == .)
      and .cedra_cli_publish_payload_file == "cedra-cli-publish-payload.json"
      and (.cedra_cli_publish_payload_sha256 | sha256)
      and (.cedra_cli_publish_data_size_bytes | type == "number" and . > 0 and floor == .)
      and .normal_publish_data_limit_bytes == 65536
      and .within_normal_publish_data_limit == true
      and .cedra_cli_publish_data_size_bytes <= .normal_publish_data_limit_bytes
      and .transaction_bcs_size_bytes == null
      and .normal_transaction_size_limit_bytes == 65536
      and .within_normal_transaction_size_limit == null
      and (.named_addresses | exact_keys(["bootstrap_lp", "reflection_core", "test_amm", "test_assets"]))
      and all(.named_addresses[]; address);
    exact_keys(["application_commit", "application_tree", "approval_blockers", "approval_eligible", "evidence_boundaries", "evidence_scope", "framework", "generated_at", "local_build_eligible_for_human_review", "named_addresses", "network", "packages", "public_role_candidate_binding", "release_source_sha256", "roles", "schema_version", "toolchain", "verification_binding", "working_tree_clean"])
    and .schema_version == 3
    and .evidence_scope == "local-exact-address-build-only"
    and .network == "cedra-testnet"
    and (.generated_at | rfc3339)
    and (.application_commit | commit)
    and (.application_tree | commit)
    and (.working_tree_clean | type == "boolean")
    and (.release_source_sha256 | sha256)
    and (.framework | exact_keys(["git_url", "revision", "subdir"]))
    and .framework.git_url == "https://github.com/cedra-labs/cedra-framework.git"
    and .framework.subdir == "cedra-framework"
    and (.framework.revision | commit)
    and (.toolchain | exact_keys(["cedra_cli_path", "cedra_cli_sha256", "cedra_cli_version"]))
    and (.toolchain.cedra_cli_path | type == "string" and startswith("/"))
    and (.toolchain.cedra_cli_sha256 | sha256)
    and (.toolchain.cedra_cli_version | type == "string" and length > 0)
    and (.named_addresses | exact_keys(["bootstrap_lp", "reflection_core", "test_amm", "test_assets"]))
    and all(.named_addresses[]; address)
    and ([.named_addresses[]] | unique | length == 4)
    and (.roles | exact_keys(["amm_publisher", "assets_publisher", "bootstrap_lp", "core_publisher"]))
    and all(.roles[]; address)
    and ([.roles[]] | unique | length == 4)
    and .roles.core_publisher == .named_addresses.reflection_core
    and .roles.assets_publisher == .named_addresses.test_assets
    and .roles.amm_publisher == .named_addresses.test_amm
    and .roles.bootstrap_lp == .named_addresses.bootstrap_lp
    and (.verification_binding == null or (.verification_binding | binding))
    and (.public_role_candidate_binding == null or (.public_role_candidate_binding | role_binding))
    and (.local_build_eligible_for_human_review | type == "boolean")
    and (if .local_build_eligible_for_human_review then .working_tree_clean and (.verification_binding != null) and (.public_role_candidate_binding != null) else true end)
    and .approval_eligible == false
    and (.approval_blockers | type == "array" and length >= 3 and all(.[]; type == "string" and length > 0))
    and (.packages | exact_keys(["reflection_core", "test_amm", "test_assets"]))
    and all(.packages[]; package)
    and .packages.reflection_core.publisher == .named_addresses.reflection_core
    and .packages.test_assets.publisher == .named_addresses.test_assets
    and .packages.test_amm.publisher == .named_addresses.test_amm
    and all(.packages[]; .named_addresses == $named)
    and (.evidence_boundaries | exact_keys(["finalized_testnet_state_observed", "network_state_observed", "transaction_built", "transaction_signed", "transaction_simulated", "transaction_submitted"]))
    and (.evidence_boundaries == {
      network_state_observed:false,
      transaction_built:false,
      transaction_signed:false,
      transaction_simulated:false,
      transaction_submitted:false,
      finalized_testnet_state_observed:false
    })
  ' --argjson named "$(/usr/bin/jq -c '.named_addresses' "$evidence_file")" "$evidence_file" >/dev/null

  local package_key compiled_manifest_file review_manifest_file
  for package_key in reflection_core test_assets test_amm; do
    compiled_manifest_file="$evidence_directory/$package_key/compiled-package-files.sha256"
    review_manifest_file="$evidence_directory/$package_key/review-bundle-files.sha256"
    [[ -f "$compiled_manifest_file" && -f "$review_manifest_file" ]] || {
      /usr/bin/printf 'compiled/review file manifest missing for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$(/usr/bin/sha256sum "$compiled_manifest_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r ".packages.$package_key.compiled_package_files_manifest_sha256" "$evidence_file")" \
      && "$(/usr/bin/sha256sum "$review_manifest_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r ".packages.$package_key.review_bundle_files_manifest_sha256" "$evidence_file")" ]] || {
      /usr/bin/printf 'compiled/review file manifest digest mismatch for %s\n' "$package_key" >&2
      return 1
    }
    (cd "$evidence_directory/$package_key" && /usr/bin/sha256sum --check --strict compiled-package-files.sha256 >/dev/null && /usr/bin/sha256sum --check --strict review-bundle-files.sha256 >/dev/null) || {
      /usr/bin/printf 'compiled/review file digest mismatch for %s\n' "$package_key" >&2
      return 1
    }
    local expected_compiled_files recorded_compiled_files expected_review_files recorded_review_files
    expected_compiled_files="$(cd "$evidence_directory/$package_key" && /usr/bin/find package-metadata.bcs bytecode_modules -type f -printf '%p\n' | sort)"
    recorded_compiled_files="$(/usr/bin/awk '{print $2}' "$compiled_manifest_file" | sort)"
    expected_review_files="$(cd "$evidence_directory/$package_key" && /usr/bin/find package-metadata.bcs publish-payload.json cedra-cli-publish-payload.json bytecode_modules -type f -printf '%p\n' | sort)"
    recorded_review_files="$(/usr/bin/awk '{print $2}' "$review_manifest_file" | sort)"
    [[ "$expected_compiled_files" == "$recorded_compiled_files" && "$expected_review_files" == "$recorded_review_files" ]] || {
      /usr/bin/printf 'compiled/review file manifest inventory mismatch for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$(/usr/bin/jq -r ".packages.$package_key.metadata_bcs_sha256" "$evidence_file")" == "$(/usr/bin/sha256sum "$evidence_directory/$package_key/package-metadata.bcs" | /usr/bin/cut -d ' ' -f 1)" ]] || {
      /usr/bin/printf 'package metadata digest mismatch for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C /usr/bin/python3 -I "$repo_root/scripts/decode_package_metadata_header.py" "$evidence_directory/$package_key/package-metadata.bcs")" == "$(/usr/bin/jq -cS ".packages.$package_key.embedded_package_metadata" "$evidence_file")" ]] || {
      /usr/bin/printf 'embedded PackageMetadata header binding mismatch for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$(/usr/bin/jq -r ".packages.$package_key.publish_payload_sha256" "$evidence_file")" == "$(/usr/bin/sha256sum "$evidence_directory/$package_key/publish-payload.json" | /usr/bin/cut -d ' ' -f 1)" \
      && "$(/usr/bin/jq -r ".packages.$package_key.publish_payload_json_bytes" "$evidence_file")" == "$(/usr/bin/stat -c '%s' "$evidence_directory/$package_key/publish-payload.json")" ]] || {
      /usr/bin/printf 'publish payload file binding mismatch for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$(/usr/bin/jq -r ".packages.$package_key.cedra_cli_publish_payload_sha256" "$evidence_file")" == "$(/usr/bin/sha256sum "$evidence_directory/$package_key/cedra-cli-publish-payload.json" | /usr/bin/cut -d ' ' -f 1)" ]] || {
      /usr/bin/printf 'Cedra CLI publish-payload oracle digest mismatch for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$(/usr/bin/jq -cS . "$evidence_directory/$package_key/publish-payload.json")" == "$(<"$evidence_directory/$package_key/publish-payload.json")" ]] || {
      /usr/bin/printf 'publish payload is not canonical sorted compact JSON for %s\n' "$package_key" >&2
      return 1
    }
    /usr/bin/jq -e '
      keys == ["arguments", "function", "type", "type_arguments"]
      and .type == "entry_function_payload"
      and .function == "0x1::code::publish_package_txn"
      and .type_arguments == []
      and (.arguments | type == "array" and length == 2)
      and (.arguments[0] | type == "string" and test("^0x[0-9a-f]+$") and ((length - 2) % 2 == 0))
      and (.arguments[1] | type == "array" and length > 0 and all(.[]; type == "string" and test("^0x[0-9a-f]+$") and ((length - 2) % 2 == 0)))
    ' "$evidence_directory/$package_key/publish-payload.json" >/dev/null || {
      /usr/bin/printf 'publish payload has an invalid exact-entry-function shape for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$(/usr/bin/jq -r '.arguments[0]' "$evidence_directory/$package_key/publish-payload.json")" == "0x$(/usr/bin/xxd -p -c 0 "$evidence_directory/$package_key/package-metadata.bcs")" ]] || {
      /usr/bin/printf 'publish payload metadata bytes mismatch for %s\n' "$package_key" >&2
      return 1
    }
    local oracle_payload
    oracle_payload="$(/usr/bin/jq -cS '{type:"entry_function_payload",function:.function_id,type_arguments:.type_args,arguments:[.args[0].value,.args[1].value]}' "$evidence_directory/$package_key/cedra-cli-publish-payload.json")"
    [[ "$oracle_payload" == "$(/usr/bin/jq -cS . "$evidence_directory/$package_key/publish-payload.json")" ]] || {
      /usr/bin/printf 'publish payload differs from Cedra CLI metadata/module byte order for %s\n' "$package_key" >&2
      return 1
    }
    local actual_payload_bytes recorded_payload_bytes actual_modules_hex recorded_modules_hex
    actual_payload_bytes="$(
      /usr/bin/find "$evidence_directory/$package_key/bytecode_modules" -maxdepth 1 -type f -name '*.mv' -printf '%s\n' \
        | /usr/bin/awk '{ total += $1 } END { print total + 0 }'
    )"
    actual_payload_bytes=$((actual_payload_bytes + $(/usr/bin/stat -c '%s' "$evidence_directory/$package_key/package-metadata.bcs")))
    recorded_payload_bytes="$(/usr/bin/jq -r ".packages.$package_key.publish_payload_argument_bytes" "$evidence_file")"
    [[ "$actual_payload_bytes" == "$recorded_payload_bytes" ]] || {
      /usr/bin/printf 'publish payload component size mismatch for %s\n' "$package_key" >&2
      return 1
    }
    actual_modules_hex='[]'
    local module_file module_recorded_sha module_recorded_bytes module_index=0
    while IFS= builtin read -r module_file; do
      module_recorded_sha="$(/usr/bin/jq -r ".packages.$package_key.module_bytecode[$module_index].sha256" "$evidence_file")"
      module_recorded_bytes="$(/usr/bin/jq -r ".packages.$package_key.module_bytecode[$module_index].bytes" "$evidence_file")"
      [[ -f "$evidence_directory/$package_key/bytecode_modules/$module_file" \
        && "$module_recorded_sha" == "$(/usr/bin/sha256sum "$evidence_directory/$package_key/bytecode_modules/$module_file" | /usr/bin/cut -d ' ' -f 1)" \
        && "$module_recorded_bytes" == "$(/usr/bin/stat -c '%s' "$evidence_directory/$package_key/bytecode_modules/$module_file")" ]] || {
        /usr/bin/printf 'compiled module binding mismatch for %s/%s\n' "$package_key" "$module_file" >&2
        return 1
      }
      actual_modules_hex="$(/usr/bin/jq -cn --argjson modules "$actual_modules_hex" --arg encoded "0x$(/usr/bin/xxd -p -c 0 "$evidence_directory/$package_key/bytecode_modules/$module_file")" '$modules + [$encoded]')"
      module_index=$((module_index + 1))
    done < <(/usr/bin/jq -r ".packages.$package_key.module_bytecode[].file" "$evidence_file")
    [[ "$module_index" == "$(/usr/bin/jq -r ".packages.$package_key.module_bytecode | length" "$evidence_file")" ]] || {
      /usr/bin/printf 'compiled module inventory count mismatch for %s\n' "$package_key" >&2
      return 1
    }
    [[ "$module_index" == "$(/usr/bin/find "$evidence_directory/$package_key/bytecode_modules" -maxdepth 1 -type f -name '*.mv' | /usr/bin/wc -l)" ]] || {
      /usr/bin/printf 'compiled module inventory contains unbound files for %s\n' "$package_key" >&2
      return 1
    }
    recorded_modules_hex="$(/usr/bin/jq -c '.arguments[1]' "$evidence_directory/$package_key/publish-payload.json")"
    [[ "$actual_modules_hex" == "$recorded_modules_hex" ]] || {
      /usr/bin/printf 'publish payload module bytes or order mismatch for %s\n' "$package_key" >&2
      return 1
    }
  done

  if [[ "$(/usr/bin/jq -r '.verification_binding == null' "$evidence_file")" == false ]]; then
    local record_file log_file build_file model_file
    record_file="$evidence_directory/$(/usr/bin/jq -r '.verification_binding.record_file' "$evidence_file")"
    log_file="$evidence_directory/$(/usr/bin/jq -r '.verification_binding.verification_log_file' "$evidence_file")"
    build_file="$evidence_directory/$(/usr/bin/jq -r '.verification_binding.local_release_build_report_file' "$evidence_file")"
    model_file="$evidence_directory/$(/usr/bin/jq -r '.verification_binding.model_gate_report_file' "$evidence_file")"
    [[ -f "$record_file" && -f "$log_file" && -f "$build_file" && -f "$model_file" ]] || {
      /usr/bin/printf 'exact-address bundle is missing bound verification evidence\n' >&2
      return 1
    }
    [[ "$(/usr/bin/sha256sum "$record_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.verification_binding.record_sha256' "$evidence_file")" \
      && "$(/usr/bin/sha256sum "$log_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.verification_binding.verification_log_sha256' "$evidence_file")" \
      && "$(/usr/bin/sha256sum "$build_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.verification_binding.local_release_build_report_sha256' "$evidence_file")" \
      && "$(/usr/bin/sha256sum "$model_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.verification_binding.model_gate_report_sha256' "$evidence_file")" ]] || {
      /usr/bin/printf 'exact-address verification binding digest mismatch\n' >&2
      return 1
    }
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
      /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_release_evidence.sh" "$record_file" >/dev/null
  fi

  if [[ "$(/usr/bin/jq -r '.public_role_candidate_binding == null' "$evidence_file")" == false ]]; then
    local role_file
    role_file="$evidence_directory/$(/usr/bin/jq -r '.public_role_candidate_binding.file' "$evidence_file")"
    [[ -f "$role_file" ]] || {
      /usr/bin/printf 'exact-address bundle is missing its public role candidate\n' >&2
      return 1
    }
    [[ "$(/usr/bin/sha256sum "$role_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.public_role_candidate_binding.sha256' "$evidence_file")" ]] || {
      /usr/bin/printf 'public role candidate digest mismatch\n' >&2
      return 1
    }
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
      /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_release_evidence.sh" "$role_file" >/dev/null
    local bound_roles
    bound_roles="$(/usr/bin/jq -c '{core_publisher:.roles.core_publisher.address,assets_publisher:.roles.assets_publisher.address,amm_publisher:.roles.amm_publisher.address,bootstrap_lp:.roles.bootstrap_lp.address} | with_entries(.value |= (ascii_downcase | sub("^0x0+"; "0x")))' "$role_file")"
    [[ "$bound_roles" == "$(/usr/bin/jq -c '.roles' "$evidence_file")" ]] || {
      /usr/bin/printf 'exact-address role map does not match its bound public role candidate\n' >&2
      return 1
    }
  fi
}

validate_public_role_candidate() {
  /usr/bin/jq -e '
    def exact_keys($wanted): (keys | sort) == ($wanted | sort);
    def full_address: type == "string" and test("^0x[0-9a-f]{64}$") and (test("^0x0+$") | not);
    def role:
      exact_keys(["address", "intended_use", "profile_name"])
      and (.address | full_address)
      and (.profile_name | type == "string" and test("^cedra-reflect-[a-z0-9-]+$"))
      and (.intended_use | type == "string" and length > 0);
    exact_keys(["contains_private_key_material", "evidence_boundaries", "evidence_scope", "funding_status", "network_intent", "on_chain_status", "recorded_date", "release_approval_status", "roles", "schema_version", "source"])
    and .schema_version == 1
    and .evidence_scope == "local-public-role-candidate"
    and (.recorded_date | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))
    and .network_intent == "cedra-testnet"
    and (.source | type == "string" and length > 0)
    and .funding_status == "not-checked"
    and .on_chain_status == "not-checked"
    and .release_approval_status == "candidate-only"
    and .contains_private_key_material == false
    and (.roles | exact_keys(["amm_publisher", "assets_publisher", "bootstrap_lp", "core_publisher"]))
    and all(.roles[]; role)
    and ([.roles[].address] | unique | length == 4)
    and ([.roles[].profile_name] | unique | length == 4)
    and (.evidence_boundaries | exact_keys(["accounts_funded", "accounts_observed_on_chain", "profile_state_read_by_release_tooling", "release_authorized"]))
    and (.evidence_boundaries == {
      profile_state_read_by_release_tooling:false,
      accounts_funded:false,
      accounts_observed_on_chain:false,
      release_authorized:false
    })
  ' "$evidence_file" >/dev/null
}

validate_public_profile_preflight() {
  /usr/bin/jq -e '
    def exact_keys($wanted): (keys | sort) == ($wanted | sort);
    def sha256: type == "string" and test("^[0-9a-f]{64}$");
    def rfc3339: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def profile($name):
      exact_keys(["account", "faucet_url", "has_private_key", "network", "profile_name", "public_key", "rest_url"])
      and .profile_name == $name
      and .network == "Testnet"
      and .has_private_key == true
      and (.public_key | type == "string" and test("^ed25519-pub-0x[0-9a-f]{64}$"))
      and (.account | type == "string" and test("^[0-9a-f]{64}$") and (test("^0+$") | not))
      and .rest_url == "https://testnet.cedra.dev"
      and .faucet_url == "https://faucet-api.cedra.dev";
    exact_keys(["authentication_key_validation", "config_directory_mode", "config_file_mode", "config_working_directory", "evidence_boundaries", "evidence_scope", "generated_at", "network_intent", "profiles", "public_role_candidate_sha256", "schema_version", "toolchain"])
    and .schema_version == 1
    and .evidence_scope == "local-public-profile-preflight"
    and (.generated_at | rfc3339)
    and .network_intent == "cedra-testnet"
    and (.config_working_directory | type == "string" and startswith("/"))
    and .config_directory_mode == "0700"
    and .config_file_mode == "0600"
    and (.public_role_candidate_sha256 | sha256)
    and (.toolchain | exact_keys(["cedra_cli_path", "cedra_cli_sha256", "cedra_cli_version"]))
    and (.toolchain.cedra_cli_path | type == "string" and startswith("/"))
    and (.toolchain.cedra_cli_sha256 | sha256)
    and (.toolchain.cedra_cli_version | type == "string" and length > 0)
    and (.profiles | exact_keys(["amm_publisher", "assets_publisher", "bootstrap_lp", "core_publisher"]))
    and (.profiles.core_publisher | profile("cedra-reflect-core-publisher"))
    and (.profiles.assets_publisher | profile("cedra-reflect-assets-publisher"))
    and (.profiles.amm_publisher | profile("cedra-reflect-amm-publisher"))
    and (.profiles.bootstrap_lp | profile("cedra-reflect-bootstrap-lp"))
    and ([.profiles[].account] | unique | length == 4)
    and ([.profiles[].public_key] | unique | length == 4)
    and (.authentication_key_validation | exact_keys(["all_profile_authentication_keys_match", "derivation_method", "derivation_tool"]))
    and .authentication_key_validation.derivation_method == "sha3-256(ed25519_public_key_bytes || 0x00)"
    and .authentication_key_validation.derivation_tool == "OpenSSL dgst -sha3-256"
    and .authentication_key_validation.all_profile_authentication_keys_match == true
    and (.evidence_boundaries == {
      public_profile_state_read:true,
      private_key_values_read:false,
      network_state_observed:false,
      accounts_funded:false,
      transaction_built:false,
      transaction_signed:false,
      transaction_submitted:false
    })
  ' "$evidence_file" >/dev/null
}

case "$scope" in
  local-release-build-verification)
    validate_local_release_build
    ;;
  local-clean-full-verification)
    validate_clean_full_verification
    ;;
  local-exact-address-build-only)
    validate_exact_address_build
    ;;
  finalized-testnet-transaction)
    [[ -n "${EXACT_ADDRESS_ARTIFACTS_FILE:-}" && -n "${PUBLIC_PROFILE_EVIDENCE_FILE:-}" && -n "${TRUSTED_ALLOWED_SIGNERS_FILE:-}" ]] || {
      /usr/bin/printf 'finalized transaction validation requires EXACT_ADDRESS_ARTIFACTS_FILE, PUBLIC_PROFILE_EVIDENCE_FILE, and TRUSTED_ALLOWED_SIGNERS_FILE\n' >&2
      exit 65
    }
    for variable in RELEASE_NODE_RUNTIME SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS; do
      [[ -n "${!variable:-}" ]] || {
        /usr/bin/printf '%s must be set for finalized transaction validation\n' "$variable" >&2
        exit 65
      }
    done
    clean_release_env=(
      /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C TMPDIR=/tmp
      RELEASE_NODE_RUNTIME="$RELEASE_NODE_RUNTIME"
      SDK_REVIEW_ATTESTATION="$SDK_REVIEW_ATTESTATION"
      SDK_REVIEW_SIGNATURE="$SDK_REVIEW_SIGNATURE"
      SDK_REVIEW_TRUSTED_SIGNERS="$SDK_REVIEW_TRUSTED_SIGNERS"
    )
    "${clean_release_env[@]}" /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_transaction_candidate.sh" \
      "$evidence_directory/transaction-candidate.json" "$(/usr/bin/readlink -f "$EXACT_ADDRESS_ARTIFACTS_FILE")" \
      "$(/usr/bin/readlink -f "$PUBLIC_PROFILE_EVIDENCE_FILE")" >/dev/null
    "${clean_release_env[@]}" /usr/bin/bash --noprofile --norc "$repo_root/scripts/verify_release_approvals.sh" \
      "$evidence_directory/approval-envelope.json" "$(/usr/bin/readlink -f "$TRUSTED_ALLOWED_SIGNERS_FILE")" \
      "$(/usr/bin/readlink -f "$EXACT_ADDRESS_ARTIFACTS_FILE")" "$(/usr/bin/readlink -f "$PUBLIC_PROFILE_EVIDENCE_FILE")" >/dev/null
    "${clean_release_env[@]}" /usr/bin/python3 -I "$repo_root/scripts/release_evidence.py" validate-finalized \
      "$evidence_file" "$(/usr/bin/readlink -f "$EXACT_ADDRESS_ARTIFACTS_FILE")" \
      "$(/usr/bin/readlink -f "$PUBLIC_PROFILE_EVIDENCE_FILE")" "$(/usr/bin/readlink -f "$TRUSTED_ALLOWED_SIGNERS_FILE")" >/dev/null
    ;;
  testnet-transaction-candidate)
    [[ -n "${EXACT_ADDRESS_ARTIFACTS_FILE:-}" && -n "${PUBLIC_PROFILE_EVIDENCE_FILE:-}" ]] || {
      /usr/bin/printf 'transaction candidate validation requires EXACT_ADDRESS_ARTIFACTS_FILE and PUBLIC_PROFILE_EVIDENCE_FILE\n' >&2
      exit 65
    }
    for variable in RELEASE_NODE_RUNTIME SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS; do
      [[ -n "${!variable:-}" ]] || {
        /usr/bin/printf '%s must be set for transaction candidate validation\n' "$variable" >&2
        exit 65
      }
    done
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C TMPDIR=/tmp \
      RELEASE_NODE_RUNTIME="$RELEASE_NODE_RUNTIME" \
      SDK_REVIEW_ATTESTATION="$SDK_REVIEW_ATTESTATION" \
      SDK_REVIEW_SIGNATURE="$SDK_REVIEW_SIGNATURE" \
      SDK_REVIEW_TRUSTED_SIGNERS="$SDK_REVIEW_TRUSTED_SIGNERS" \
      /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_transaction_candidate.sh" \
      "$evidence_file" "$(/usr/bin/readlink -f "$EXACT_ADDRESS_ARTIFACTS_FILE")" \
      "$(/usr/bin/readlink -f "$PUBLIC_PROFILE_EVIDENCE_FILE")" >/dev/null
    ;;
  local-public-role-candidate)
    validate_public_role_candidate
    ;;
  local-public-profile-preflight)
    validate_public_profile_preflight
    authentication_key_validation="$(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
      /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_public_profile_auth_keys.sh" "$evidence_file")"
    [[ "$(/usr/bin/jq -cS . <<<"$authentication_key_validation")" == "$(/usr/bin/jq -cS '.authentication_key_validation' "$evidence_file")" ]] || {
      /usr/bin/printf 'public profile authentication-key binding does not match the Cedra Ed25519 authentication-key derivation\n' >&2
      exit 65
    }
    ;;
  *)
    /usr/bin/printf 'unsupported release evidence scope: %s\n' "$scope" >&2
    exit 65
    ;;
esac

/usr/bin/printf 'valid release evidence: %s (%s)\n' "$evidence_file" "$scope"
