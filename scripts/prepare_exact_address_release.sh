#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

usage() {
  printf 'usage: %s CORE_ADDRESS ASSETS_ADDRESS AMM_ADDRESS OPERATIONS_ADDRESS BOOTSTRAP_LP_ADDRESS OUTPUT_DIRECTORY\n' "$0" >&2
  printf 'optional: RELEASE_VERIFICATION_RECORD=/path/to/verification-record.json\n' >&2
  exit 64
}

[[ $# -eq 6 ]] || usage

core_address="$1"
assets_address="$2"
amm_address="$3"
operations_address="$4"
bootstrap_lp_address="$5"
output_directory="$6"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cedra_bin="${CEDRA_BIN:-/usr/bin/cedra}"
source_digest_script="$repo_root/scripts/compute_release_source_digest.sh"
evidence_validator="$repo_root/scripts/validate_release_evidence.sh"
metadata_decoder="$repo_root/scripts/decode_package_metadata_header.py"

for command_name in git jq sha256sum find sort stat awk sed xargs xxd wc python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'required command is unavailable: %s\n' "$command_name" >&2
    exit 69
  }
done
[[ -x "$cedra_bin" ]] || {
  printf 'Cedra CLI is not executable: %s\n' "$cedra_bin" >&2
  exit 69
}
[[ -f "$source_digest_script" && -f "$evidence_validator" && -f "$metadata_decoder" ]] || {
  printf 'release provenance scripts are missing\n' >&2
  exit 69
}

canonical_address() {
  local input="$1"
  [[ "$input" =~ ^0x[0-9a-fA-F]{1,64}$ ]] || {
    printf 'invalid Cedra address: %s\n' "$input" >&2
    exit 65
  }
  local digits="${input:2}"
  digits="${digits,,}"
  while [[ ${#digits} -gt 1 && "${digits:0:1}" == "0" ]]; do
    digits="${digits:1}"
  done
  [[ "$digits" != "0" ]] || {
    printf 'release-role addresses must be non-zero\n' >&2
    exit 65
  }
  printf '0x%s' "$digits"
}

git_worktree_clean() {
  git -C "$repo_root" diff --quiet \
    && git -C "$repo_root" diff --cached --quiet \
    && [[ -z "$(git -C "$repo_root" ls-files --others --exclude-standard)" ]]
}

core_address="$(canonical_address "$core_address")"
assets_address="$(canonical_address "$assets_address")"
amm_address="$(canonical_address "$amm_address")"
operations_address="$(canonical_address "$operations_address")"
bootstrap_lp_address="$(canonical_address "$bootstrap_lp_address")"

role_addresses_json="$(jq -cn \
  --arg core "$core_address" \
  --arg assets "$assets_address" \
  --arg amm "$amm_address" \
  --arg operations "$operations_address" \
  --arg bootstrap "$bootstrap_lp_address" \
  '{core_publisher:$core,assets_publisher:$assets,amm_publisher:$amm,operations:$operations,bootstrap_lp:$bootstrap}')"
[[ "$(jq -r '[.[]] | unique | length' <<<"$role_addresses_json")" == 5 ]] || {
  printf 'all five release-role addresses must be distinct\n' >&2
  exit 65
}

application_commit_before="$(git -C "$repo_root" rev-parse --verify HEAD)"
application_tree="$(git -C "$repo_root" rev-parse --verify 'HEAD^{tree}')"
[[ "$application_commit_before" =~ ^[0-9a-f]{40}$ && "$application_tree" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'release source must be in a Git worktree with a valid HEAD\n' >&2
  exit 67
}
working_tree_clean=false
if git_worktree_clean; then
  working_tree_clean=true
fi
release_source_sha256_before="$(bash "$source_digest_script" all)"

if [[ -e "$output_directory" ]]; then
  [[ -d "$output_directory" && -z "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    printf 'output directory must not exist or must be empty: %s\n' "$output_directory" >&2
    exit 66
  }
else
  mkdir -p "$output_directory"
fi
output_directory="$(cd "$output_directory" && pwd)"

if [[ "$output_directory" == "$repo_root" || "$output_directory" == "$repo_root/"* ]]; then
  git -C "$repo_root" check-ignore -q "$output_directory" || {
    printf 'an in-repository output directory must be ignored (use ops/local or /tmp): %s\n' "$output_directory" >&2
    exit 66
  }
fi

release_manifests=(
  "$repo_root/move/reflection-core/Move.toml"
  "$repo_root/move/test-assets/Move.toml"
  "$repo_root/move/test-amm/Move.toml"
)
for manifest in "${release_manifests[@]}"; do
  grep -Fq 'upgrade_policy = "immutable"' "$manifest" || {
    printf 'release package is not immutable: %s\n' "$manifest" >&2
    exit 67
  }
done

mapfile -t framework_revisions < <(
  sed -n 's/.*CedraFramework.*rev = "\([0-9a-fA-F]\{40\}\)".*/\1/p' "${release_manifests[@]}" \
    | tr '[:upper:]' '[:lower:]' \
    | sort -u
)
[[ ${#framework_revisions[@]} -eq 1 ]] || {
  printf 'release packages must pin one identical 40-character Cedra Framework revision\n' >&2
  exit 67
}
framework_revision="${framework_revisions[0]}"
framework_git_url="https://github.com/cedra-labs/cedra-framework.git"
framework_subdir="cedra-framework"

cedra_cli_path="$(readlink -f "$cedra_bin")"
cedra_cli_version="$($cedra_bin --version)"
cedra_cli_sha256="$(sha256sum "$cedra_cli_path" | cut -d ' ' -f 1)"

payload_oracle_root="$output_directory/.payload-oracle-source/move"
mkdir -p "$payload_oracle_root"
copy_package_source_without_build() {
  local source_directory="$1"
  local destination_directory="$2"
  local source_file relative_file
  mkdir -p "$destination_directory"
  while IFS= read -r -d '' source_file; do
    relative_file="${source_file#"$source_directory/"}"
    mkdir -p "$destination_directory/$(dirname "$relative_file")"
    cp "$source_file" "$destination_directory/$relative_file"
  done < <(find "$source_directory" -path "$source_directory/build" -prune -o -type f -print0)
}
copy_package_source_without_build "$repo_root/move/reflection-core" "$payload_oracle_root/reflection-core"
copy_package_source_without_build "$repo_root/move/test-assets" "$payload_oracle_root/test-assets"
copy_package_source_without_build "$repo_root/move/test-amm" "$payload_oracle_root/test-amm"

compile_package() {
  local package_key="$1"
  local package_dir="$2"
  local named_addresses="$3"
  local named_addresses_json="$4"
  local publisher="$5"
  local bundle_dir="$output_directory/$package_key"
  local oracle_package_dir="$payload_oracle_root/$(basename "$package_dir")"
  local package_manifest_name
  package_manifest_name="$(awk -F '"' '/^name = "/ { print $2; exit }' "$package_dir/Move.toml")"
  [[ -n "$package_manifest_name" ]] || {
    printf 'cannot read package name from %s/Move.toml\n' "$package_dir" >&2
    exit 68
  }

  "$cedra_bin" move compile \
    --package-dir "$oracle_package_dir" \
    --named-addresses "$named_addresses" \
    --save-metadata \
    --included-artifacts sparse \
    --skip-fetch-latest-git-deps \
    --fail-on-warning >/dev/null

  local compiled_root="$oracle_package_dir/build/$package_manifest_name"
  local metadata_file="$compiled_root/package-metadata.bcs"
  local compiled_bytecode_dir="$compiled_root/bytecode_modules"
  [[ -f "$metadata_file" && -d "$compiled_bytecode_dir" ]] || {
    printf 'missing sparse package artifacts for %s\n' "$package_key" >&2
    exit 68
  }
  [[ -n "$(find "$compiled_bytecode_dir" -maxdepth 1 -type f -name '*.mv' -print -quit)" ]] || {
    printf 'compiled package has no bytecode modules: %s\n' "$package_key" >&2
    exit 68
  }

  mkdir -p "$bundle_dir"
  cp "$metadata_file" "$bundle_dir/package-metadata.bcs"
  cp -R "$compiled_bytecode_dir" "$bundle_dir/bytecode_modules"

  local oracle_log="$output_directory/.payload-oracle-$package_key.log"
  "$cedra_bin" move build-publish-payload \
    --package-dir "$oracle_package_dir" \
    --named-addresses "$named_addresses" \
    --included-artifacts sparse \
    --skip-fetch-latest-git-deps \
    --sender-account "$publisher" \
    --json-output-file "$bundle_dir/cedra-cli-publish-payload.json" \
    >"$oracle_log" 2>&1 || {
      sed -n '1,120p' "$oracle_log" >&2
      printf 'Cedra CLI publish-payload oracle failed for %s\n' "$package_key" >&2
      exit 68
    }
  jq -e '
    keys == ["args", "function_id", "type_args"]
    and .function_id == "0x1::code::publish_package_txn"
    and .type_args == []
    and (.args | type == "array" and length == 2)
    and .args[0].type == "hex"
    and (.args[0].value | type == "string" and test("^0x[0-9a-f]+$"))
    and .args[1].type == "hex"
    and (.args[1].value | type == "array" and length > 0 and all(.[]; type == "string" and test("^0x[0-9a-f]+$")))
  ' "$bundle_dir/cedra-cli-publish-payload.json" >/dev/null || {
    printf 'Cedra CLI publish-payload oracle returned an unexpected shape for %s\n' "$package_key" >&2
    exit 68
  }
  local metadata_hex
  metadata_hex="0x$(xxd -p -c 0 "$bundle_dir/package-metadata.bcs")"
  [[ "$(jq -r '.args[0].value' "$bundle_dir/cedra-cli-publish-payload.json")" == "$metadata_hex" ]] || {
    printf 'isolated metadata differs from Cedra CLI publish-payload semantics for %s\n' "$package_key" >&2
    exit 68
  }

  # Cedra CLI determines the publish order; filesystem ordering is not a
  # transaction semantic. Bind every oracle byte string back to exactly one
  # isolated compiler output, and record the modules in the oracle order.
  local module_bytecode_json='[]'
  local module_hex module_file candidate_file matches
  while IFS= read -r module_hex; do
    matches=0
    module_file=''
    while IFS= read -r candidate_file; do
      if [[ "$module_hex" == "0x$(xxd -p -c 0 "$bundle_dir/bytecode_modules/$candidate_file")" ]]; then
        module_file="$candidate_file"
        matches=$((matches + 1))
      fi
    done < <(find "$bundle_dir/bytecode_modules" -maxdepth 1 -type f -name '*.mv' -printf '%f\n' | sort)
    [[ "$matches" == 1 ]] || {
      printf 'Cedra CLI module bytes do not bind one-to-one to compiler output for %s\n' "$package_key" >&2
      exit 68
    }
    module_bytecode_json="$(jq -cn \
      --argjson modules "$module_bytecode_json" \
      --arg file "$module_file" \
      --arg sha256 "$(sha256sum "$bundle_dir/bytecode_modules/$module_file" | cut -d ' ' -f 1)" \
      --argjson bytes "$(stat -c '%s' "$bundle_dir/bytecode_modules/$module_file")" \
      '$modules + [{file:$file,sha256:$sha256,bytes:$bytes}]')"
  done < <(jq -r '.args[1].value[]' "$bundle_dir/cedra-cli-publish-payload.json")
  [[ "$(jq -r 'length' <<<"$module_bytecode_json")" == "$(find "$bundle_dir/bytecode_modules" -maxdepth 1 -type f -name '*.mv' | wc -l)" \
    && "$(jq -r '[.[].file] | unique | length' <<<"$module_bytecode_json")" == "$(jq -r 'length' <<<"$module_bytecode_json")" ]] || {
    printf 'Cedra CLI module inventory differs from isolated compiler output for %s\n' "$package_key" >&2
    exit 68
  }
  jq -cS '{type:"entry_function_payload",function:.function_id,type_arguments:.type_args,arguments:[.args[0].value,.args[1].value]}' \
    "$bundle_dir/cedra-cli-publish-payload.json" >"$bundle_dir/publish-payload.json"
  local cedra_cli_publish_data_size_bytes
  cedra_cli_publish_data_size_bytes="$(sed -n 's/^package size \([0-9][0-9]*\) bytes$/\1/p' "$oracle_log" | tail -n 1)"
  [[ "$cedra_cli_publish_data_size_bytes" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Cedra CLI did not report a publish data size for %s\n' "$package_key" >&2
    exit 68
  }

  local bytecode_bytes
  local metadata_bytes
  local payload_argument_bytes
  bytecode_bytes="$(find "$bundle_dir/bytecode_modules" -maxdepth 1 -type f -name '*.mv' -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')"
  metadata_bytes="$(stat -c '%s' "$bundle_dir/package-metadata.bcs")"
  payload_argument_bytes=$((bytecode_bytes + metadata_bytes))

  (
    cd "$bundle_dir"
    find package-metadata.bcs bytecode_modules -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum >compiled-package-files.sha256
    sha256sum --check --strict compiled-package-files.sha256 >/dev/null
    find package-metadata.bcs publish-payload.json cedra-cli-publish-payload.json bytecode_modules -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum >review-bundle-files.sha256
    sha256sum --check --strict review-bundle-files.sha256 >/dev/null
  )
  local compiled_package_files_manifest_sha256
  local review_bundle_files_manifest_sha256
  compiled_package_files_manifest_sha256="$(sha256sum "$bundle_dir/compiled-package-files.sha256" | cut -d ' ' -f 1)"
  review_bundle_files_manifest_sha256="$(sha256sum "$bundle_dir/review-bundle-files.sha256" | cut -d ' ' -f 1)"
  local source_sha256
  source_sha256="$(bash "$source_digest_script" "$package_key")"
  local embedded_package_metadata
  embedded_package_metadata="$(python3 "$metadata_decoder" "$bundle_dir/package-metadata.bcs")"
  [[ "$(jq -r '.name' <<<"$embedded_package_metadata")" == "$package_manifest_name" \
    && "$(jq -r '.upgrade_policy_number' <<<"$embedded_package_metadata")" == 2 \
    && "$(jq -r '.upgrade_number' <<<"$embedded_package_metadata")" == 0 ]] || {
    printf 'embedded PackageMetadata header is not the expected initial immutable package for %s\n' "$package_key" >&2
    exit 68
  }
  jq -n \
    --arg publisher "$publisher" \
    --arg event_source_address "$publisher" \
    --argjson named_addresses "$named_addresses_json" \
    --arg source_sha256 "$source_sha256" \
    --arg compiled_package_files_manifest_sha256 "$compiled_package_files_manifest_sha256" \
    --arg review_bundle_files_manifest_sha256 "$review_bundle_files_manifest_sha256" \
    --arg metadata_bcs_sha256 "$(sha256sum "$bundle_dir/package-metadata.bcs" | cut -d ' ' -f 1)" \
    --arg publish_payload_sha256 "$(sha256sum "$bundle_dir/publish-payload.json" | cut -d ' ' -f 1)" \
    --arg cedra_cli_publish_payload_sha256 "$(sha256sum "$bundle_dir/cedra-cli-publish-payload.json" | cut -d ' ' -f 1)" \
    --argjson payload_argument_bytes "$payload_argument_bytes" \
    --argjson publish_payload_json_bytes "$(stat -c '%s' "$bundle_dir/publish-payload.json")" \
    --argjson cedra_cli_publish_data_size_bytes "$cedra_cli_publish_data_size_bytes" \
    --argjson module_bytecode "$module_bytecode_json" \
    --argjson embedded_package_metadata "$embedded_package_metadata" \
    '{
      publisher: $publisher,
      event_source_address: $event_source_address,
      named_addresses: $named_addresses,
      upgrade_policy: "immutable",
      package_source_sha256: $source_sha256,
      embedded_package_metadata: $embedded_package_metadata,
      metadata_bcs_file: "package-metadata.bcs",
      metadata_bcs_sha256: $metadata_bcs_sha256,
      module_bytecode: $module_bytecode,
      publish_payload_file: "publish-payload.json",
      publish_payload_sha256: $publish_payload_sha256,
      publish_payload_argument_bytes: $payload_argument_bytes,
      publish_payload_json_bytes: $publish_payload_json_bytes,
      cedra_cli_publish_payload_file: "cedra-cli-publish-payload.json",
      cedra_cli_publish_payload_sha256: $cedra_cli_publish_payload_sha256,
      cedra_cli_publish_data_size_bytes: $cedra_cli_publish_data_size_bytes,
      normal_publish_data_limit_bytes: 65536,
      within_normal_publish_data_limit: true,
      transaction_bcs_size_bytes: null,
      normal_transaction_size_limit_bytes: 65536,
      within_normal_transaction_size_limit: null,
      compiled_package_files_manifest: "compiled-package-files.sha256",
      compiled_package_files_manifest_sha256: $compiled_package_files_manifest_sha256,
      review_bundle_files_manifest: "review-bundle-files.sha256",
      review_bundle_files_manifest_sha256: $review_bundle_files_manifest_sha256
    }' >"$output_directory/.$package_key.json"

  # Keep peak release-build disk use bounded. These are compiler caches inside
  # the controlled isolated source copy; all reviewable artifacts were already
  # copied and digested above.
  local isolated_build_directory
  while IFS= read -r -d '' isolated_build_directory; do
    [[ "$isolated_build_directory" == "$payload_oracle_root/"*/build ]] || {
      printf 'refusing unsafe isolated compiler-cache cleanup: %s\n' "$isolated_build_directory" >&2
      exit 70
    }
    rm -rf -- "$isolated_build_directory"
  done < <(find "$payload_oracle_root" -type d -name build -prune -print0)
}

compile_package \
  reflection_core \
  "$repo_root/move/reflection-core" \
  "reflection_core=$core_address,test_assets=$assets_address,test_amm=$amm_address" \
  "$(jq -cn --arg core "$core_address" --arg assets "$assets_address" --arg amm "$amm_address" '{reflection_core:$core,test_assets:$assets,test_amm:$amm}')" \
  "$core_address"
compile_package \
  test_assets \
  "$repo_root/move/test-assets" \
  "test_assets=$assets_address,reflection_core=$core_address,test_amm=$amm_address" \
  "$(jq -cn --arg core "$core_address" --arg assets "$assets_address" --arg amm "$amm_address" '{reflection_core:$core,test_assets:$assets,test_amm:$amm}')" \
  "$assets_address"
compile_package \
  test_amm \
  "$repo_root/move/test-amm" \
  "test_amm=$amm_address,reflection_core=$core_address,test_assets=$assets_address" \
  "$(jq -cn --arg core "$core_address" --arg assets "$assets_address" --arg amm "$amm_address" '{reflection_core:$core,test_assets:$assets,test_amm:$amm}')" \
  "$amm_address"

application_commit_after="$(git -C "$repo_root" rev-parse --verify HEAD)"
release_source_sha256_after="$(bash "$source_digest_script" all)"
[[ "$application_commit_before" == "$application_commit_after" && "$release_source_sha256_before" == "$release_source_sha256_after" ]] || {
  printf 'release source changed while exact-address artifacts were being built\n' >&2
  exit 70
}

verification_binding_json=null
verification_bound=false
if [[ -n "${RELEASE_VERIFICATION_RECORD:-}" ]]; then
  verification_record="$(readlink -f "$RELEASE_VERIFICATION_RECORD")"
  [[ -f "$verification_record" ]] || {
    printf 'verification record does not exist: %s\n' "$RELEASE_VERIFICATION_RECORD" >&2
    exit 71
  }
  bash "$evidence_validator" "$verification_record"
  [[ "$(jq -r '.evidence_scope' "$verification_record")" == "local-clean-full-verification" ]] || {
    printf 'verification binding must be a clean full-verification record\n' >&2
    exit 71
  }
  [[ "$(jq -r '.application_commit' "$verification_record")" == "$application_commit_before" \
    && "$(jq -r '.application_tree' "$verification_record")" == "$application_tree" \
    && "$(jq -r '.release_source_sha256' "$verification_record")" == "$release_source_sha256_before" \
    && "$(jq -r '.toolchain.cedra_cli_sha256' "$verification_record")" == "$cedra_cli_sha256" ]] || {
    printf 'verification record does not bind this commit, source, and Cedra CLI\n' >&2
    exit 71
  }
  [[ "$working_tree_clean" == true ]] || {
    printf 'a clean verification record cannot be bound to a dirty working tree\n' >&2
    exit 71
  }

  verification_directory="$(dirname "$verification_record")"
  verification_log_file="$(jq -r '.verification_log.file' "$verification_record")"
  local_build_report_file="$(jq -r '.local_release_build_report.file' "$verification_record")"
  model_gate_report_file="$(jq -r '.model_gate_report.file' "$verification_record")"
  [[ "$verification_log_file" != */* && "$local_build_report_file" != */* && "$model_gate_report_file" != */* ]] || {
    printf 'verification record evidence file names must be local basenames\n' >&2
    exit 71
  }
  [[ -f "$verification_directory/$verification_log_file" && -f "$verification_directory/$local_build_report_file" && -f "$verification_directory/$model_gate_report_file" ]] || {
    printf 'verification record is missing its bound log, build report, or model-gate report\n' >&2
    exit 71
  }
  [[ "$(sha256sum "$verification_directory/$verification_log_file" | cut -d ' ' -f 1)" == "$(jq -r '.verification_log.sha256' "$verification_record")" \
    && "$(sha256sum "$verification_directory/$local_build_report_file" | cut -d ' ' -f 1)" == "$(jq -r '.local_release_build_report.sha256' "$verification_record")" \
    && "$(sha256sum "$verification_directory/$model_gate_report_file" | cut -d ' ' -f 1)" == "$(jq -r '.model_gate_report.sha256' "$verification_record")" ]] || {
    printf 'verification record evidence digest mismatch\n' >&2
    exit 71
  }

  mkdir -p "$output_directory/provenance"
  cp "$verification_record" "$output_directory/provenance/verification-record.json"
  cp "$verification_directory/$verification_log_file" "$output_directory/provenance/verification.log"
  cp "$verification_directory/$local_build_report_file" "$output_directory/provenance/local-release-build.json"
  cp "$verification_directory/$model_gate_report_file" "$output_directory/provenance/model-gate-report.json"
  verification_record_sha256="$(sha256sum "$output_directory/provenance/verification-record.json" | cut -d ' ' -f 1)"
  verification_log_sha256="$(sha256sum "$output_directory/provenance/verification.log" | cut -d ' ' -f 1)"
  local_build_report_sha256="$(sha256sum "$output_directory/provenance/local-release-build.json" | cut -d ' ' -f 1)"
  model_gate_report_sha256="$(sha256sum "$output_directory/provenance/model-gate-report.json" | cut -d ' ' -f 1)"
  verification_binding_json="$(jq -cn \
    --arg record_sha256 "$verification_record_sha256" \
    --arg log_sha256 "$verification_log_sha256" \
    --arg build_sha256 "$local_build_report_sha256" \
    --arg model_sha256 "$model_gate_report_sha256" \
    '{
      record_file:"provenance/verification-record.json",
      record_sha256:$record_sha256,
      verification_log_file:"provenance/verification.log",
      verification_log_sha256:$log_sha256,
      local_release_build_report_file:"provenance/local-release-build.json",
      local_release_build_report_sha256:$build_sha256,
      model_gate_report_file:"provenance/model-gate-report.json",
      model_gate_report_sha256:$model_sha256
    }')"
  verification_bound=true
fi

public_role_candidate_binding_json=null
public_role_candidate_bound=false
if [[ -n "${PUBLIC_ROLE_CANDIDATE_FILE:-}" ]]; then
  public_role_candidate_file="$(readlink -f "$PUBLIC_ROLE_CANDIDATE_FILE")"
  bash "$evidence_validator" "$public_role_candidate_file"
  candidate_roles_json="$(jq -c '{
    core_publisher:.roles.core_publisher.address,
    assets_publisher:.roles.assets_publisher.address,
    amm_publisher:.roles.amm_publisher.address,
    operations:.roles.operations.address,
    bootstrap_lp:.roles.bootstrap_lp.address
  }' "$public_role_candidate_file")"
  candidate_roles_json="$(jq -c 'with_entries(.value |= (ascii_downcase | sub("^0x0+"; "0x")))' <<<"$candidate_roles_json")"
  [[ "$candidate_roles_json" == "$role_addresses_json" ]] || {
    printf 'public role candidate does not match all five requested release addresses\n' >&2
    exit 71
  }
  mkdir -p "$output_directory/provenance"
  cp "$public_role_candidate_file" "$output_directory/provenance/public-role-candidate.json"
  public_role_candidate_sha256="$(sha256sum "$output_directory/provenance/public-role-candidate.json" | cut -d ' ' -f 1)"
  public_role_candidate_binding_json="$(jq -cn \
    --arg sha256 "$public_role_candidate_sha256" \
    '{file:"provenance/public-role-candidate.json",sha256:$sha256}')"
  public_role_candidate_bound=true
fi

local_build_eligible=false
if [[ "$working_tree_clean" == true && "$verification_bound" == true && "$public_role_candidate_bound" == true ]]; then
  local_build_eligible=true
fi

approval_blockers=(
  "Testnet simulation evidence not recorded"
  "two distinct human release approvals not recorded"
  "finalized on-chain package digest and immutable publication policy not observed"
)
if [[ "$working_tree_clean" != true ]]; then
  approval_blockers+=("working tree is not clean")
fi
if [[ "$verification_bound" != true ]]; then
  approval_blockers+=("clean full-verification record is not bound")
fi
if [[ "$public_role_candidate_bound" != true ]]; then
  approval_blockers+=("validated five-role candidate is not bound")
fi
approval_blockers_json="$(printf '%s\n' "${approval_blockers[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"

generated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
jq -n \
  --arg generated_at "$generated_at" \
  --arg application_commit "$application_commit_before" \
  --arg application_tree "$application_tree" \
  --argjson working_tree_clean "$working_tree_clean" \
  --arg release_source_sha256 "$release_source_sha256_before" \
  --arg framework_git_url "$framework_git_url" \
  --arg framework_subdir "$framework_subdir" \
  --arg framework_revision "$framework_revision" \
  --arg cedra_cli_version "$cedra_cli_version" \
  --arg cedra_cli_path "$cedra_cli_path" \
  --arg cedra_cli_sha256 "$cedra_cli_sha256" \
  --arg core_address "$core_address" \
  --arg assets_address "$assets_address" \
  --arg amm_address "$amm_address" \
  --argjson roles "$role_addresses_json" \
  --argjson verification_binding "$verification_binding_json" \
  --argjson public_role_candidate_binding "$public_role_candidate_binding_json" \
  --argjson local_build_eligible "$local_build_eligible" \
  --argjson approval_blockers "$approval_blockers_json" \
  --slurpfile reflection_core "$output_directory/.reflection_core.json" \
  --slurpfile test_assets "$output_directory/.test_assets.json" \
  --slurpfile test_amm "$output_directory/.test_amm.json" \
  '{
    schema_version: 3,
    evidence_scope: "local-exact-address-build-only",
    generated_at: $generated_at,
    network: "cedra-testnet",
    application_commit: $application_commit,
    application_tree: $application_tree,
    working_tree_clean: $working_tree_clean,
    release_source_sha256: $release_source_sha256,
    framework: {
      git_url: $framework_git_url,
      subdir: $framework_subdir,
      revision: $framework_revision
    },
    toolchain: {
      cedra_cli_version: $cedra_cli_version,
      cedra_cli_path: $cedra_cli_path,
      cedra_cli_sha256: $cedra_cli_sha256
    },
    named_addresses: {
      reflection_core: $core_address,
      test_assets: $assets_address,
      test_amm: $amm_address
    },
    roles: $roles,
    verification_binding: $verification_binding,
    public_role_candidate_binding: $public_role_candidate_binding,
    local_build_eligible_for_human_review: $local_build_eligible,
    approval_eligible: false,
    approval_blockers: $approval_blockers,
    packages: {
      reflection_core: $reflection_core[0],
      test_assets: $test_assets[0],
      test_amm: $test_amm[0]
    },
    evidence_boundaries: {
      network_state_observed: false,
      transaction_built: false,
      transaction_signed: false,
      transaction_simulated: false,
      transaction_submitted: false,
      finalized_testnet_state_observed: false
    }
  }' >"$output_directory/exact-address-artifacts.json"

rm "$output_directory/.reflection_core.json" "$output_directory/.test_assets.json" "$output_directory/.test_amm.json"
[[ "$output_directory/.payload-oracle-source" == "$output_directory/"* ]] || {
  printf 'refusing unsafe isolated build cleanup\n' >&2
  exit 70
}
rm -rf -- "$output_directory/.payload-oracle-source"
rm -- "$output_directory"/.payload-oracle-*.log
bash "$evidence_validator" "$output_directory/exact-address-artifacts.json"
(
  cd "$output_directory"
  sha256sum exact-address-artifacts.json >exact-address-artifacts.sha256
  sha256sum --check --strict exact-address-artifacts.sha256 >/dev/null
)

printf 'exact-address artifact bundle: %s\n' "$output_directory/exact-address-artifacts.json"
printf 'scope: local exact-address compilation only; no transaction was built, signed, simulated, submitted, or observed on Testnet\n'
if [[ "$local_build_eligible" != true ]]; then
  printf 'warning: bundle is not eligible for human release review; inspect approval_blockers\n' >&2
fi
