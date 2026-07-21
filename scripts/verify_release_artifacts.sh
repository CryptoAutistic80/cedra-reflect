#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

usage() {
  printf 'usage: %s [OUTPUT_JSON]\n' "$0" >&2
  exit 64
}

[[ $# -le 1 ]] || usage

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cedra_bin="${CEDRA_BIN:-/usr/bin/cedra}"
output_json="${1:-}"
source_digest_script="$repo_root/scripts/compute_release_source_digest.sh"
evidence_validator="$repo_root/scripts/validate_release_evidence.sh"
packages=(
  "hook_probe|move/hook-probe|false"
  "reflection_core|move/reflection-core|true"
  "test_assets|move/test-assets|true"
  "test_amm|move/test-amm|true"
  "integration_tests|move/integration-tests|false"
)

for command_name in git jq sha256sum find sort stat awk sed xargs; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'required command is unavailable: %s\n' "$command_name" >&2
    exit 69
  }
done
[[ -x "$cedra_bin" ]] || {
  printf 'Cedra CLI is not executable: %s\n' "$cedra_bin" >&2
  exit 69
}

git_worktree_clean() {
  git -C "$repo_root" diff --quiet \
    && git -C "$repo_root" diff --cached --quiet \
    && [[ -z "$(git -C "$repo_root" ls-files --others --exclude-standard)" ]]
}

working_tree_clean=false
if git_worktree_clean; then
  working_tree_clean=true
fi
application_commit="$(git -C "$repo_root" rev-parse --verify HEAD)"
application_tree="$(git -C "$repo_root" rev-parse --verify 'HEAD^{tree}')"
release_source_sha256="$(bash "$source_digest_script" all)"
cedra_cli_path="$(readlink -f "$cedra_bin")"
cedra_cli_version="$($cedra_bin --version)"
cedra_cli_sha256="$(sha256sum "$cedra_cli_path" | cut -d ' ' -f 1)"
generated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

mapfile -t framework_revisions < <(
  sed -n 's/.*CedraFramework.*rev = "\([0-9a-fA-F]\{40\}\)".*/\1/p' \
    "$repo_root/move/hook-probe/Move.toml" \
    "$repo_root/move/reflection-core/Move.toml" \
    "$repo_root/move/test-assets/Move.toml" \
    "$repo_root/move/test-amm/Move.toml" \
    "$repo_root/move/integration-tests/Move.toml" \
    | tr '[:upper:]' '[:lower:]' \
    | sort -u
)
[[ ${#framework_revisions[@]} -eq 1 ]] || {
  printf 'all Move packages must pin one identical Cedra Framework revision\n' >&2
  exit 67
}
framework_revision="${framework_revisions[0]}"

if [[ -n "$output_json" ]]; then
  output_parent="$(dirname "$output_json")"
  mkdir -p "$output_parent"
  output_parent="$(cd "$output_parent" && pwd)"
  output_json="$output_parent/$(basename "$output_json")"
  [[ ! -e "$output_json" ]] || {
    printf 'output JSON already exists: %s\n' "$output_json" >&2
    exit 66
  }
  if [[ "$output_json" == "$repo_root/"* ]]; then
    git -C "$repo_root" check-ignore -q "$output_json" || {
      printf 'an in-repository report path must be ignored (use ops/local or /tmp): %s\n' "$output_json" >&2
      exit 66
    }
  fi
fi

tmp_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp_directory"
}
trap cleanup EXIT

printf 'cedra_cli_version=%s\n' "$cedra_cli_version"
printf 'cedra_cli_sha256=%s\n' "$cedra_cli_sha256"
printf 'application_commit=%s\n' "$application_commit"
printf 'application_tree=%s\n' "$application_tree"
printf 'working_tree_clean=%s\n' "$working_tree_clean"
printf 'release_source_sha256=%s\n' "$release_source_sha256"
printf 'framework_revision=%s\n' "$framework_revision"

for descriptor in "${packages[@]}"; do
  IFS='|' read -r package_key package_path publishable <<<"$descriptor"
  package_dir="$repo_root/$package_path"
  manifest_name="$(awk -F '"' '/^name = "/ { print $2; exit }' "$package_dir/Move.toml")"
  upgrade_policy="$(awk -F '"' '/^upgrade_policy = "/ { print $2; exit }' "$package_dir/Move.toml")"
  [[ -n "$manifest_name" && -n "$upgrade_policy" ]] || {
    printf 'cannot read package metadata: %s\n' "$package_path" >&2
    exit 67
  }
  if [[ "$publishable" == true && "$upgrade_policy" != immutable ]]; then
    printf 'release package is not immutable: %s\n' "$package_path" >&2
    exit 67
  fi

  compile_args=(move compile --package-dir "$package_dir" --dev --skip-fetch-latest-git-deps)
  if [[ "$package_key" != integration_tests ]]; then
    compile_args+=(--save-metadata --included-artifacts sparse)
  fi
  "$cedra_bin" "${compile_args[@]}" >/dev/null

  compiled_root="$package_dir/build/$manifest_name"
  bytecode_dir="$compiled_root/bytecode_modules"
  [[ -d "$bytecode_dir" ]] || {
    printf 'missing build output for %s\n' "$package_path" >&2
    exit 68
  }
  metadata_file="$compiled_root/package-metadata.bcs"
  compiled_artifact_present=true
  compiled_artifact_sha256_json=null
  compiled_components_bytes=0
  if [[ -n "$(find "$bytecode_dir" -maxdepth 1 -type f -name '*.mv' -print -quit)" ]]; then
    bytecode_bytes="$(find "$bytecode_dir" -maxdepth 1 -type f -name '*.mv' -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')"
    metadata_bytes=0
    if [[ -f "$metadata_file" ]]; then
      metadata_bytes="$(stat -c '%s' "$metadata_file")"
    fi
    compiled_components_bytes=$((bytecode_bytes + metadata_bytes))
    compiled_artifact_sha256="$({
      cd "$compiled_root"
      if [[ -f package-metadata.bcs ]]; then
        find package-metadata.bcs bytecode_modules -maxdepth 1 -type f -print0
      else
        find bytecode_modules -maxdepth 1 -type f -print0
      fi \
        | sort -z \
        | xargs -0 sha256sum \
        | sha256sum \
        | cut -d ' ' -f 1
    })"
    compiled_artifact_sha256_json="$(jq -cn --arg value "$compiled_artifact_sha256" '$value')"
  elif [[ "$package_key" == integration_tests ]]; then
    compiled_artifact_present=false
    compiled_artifact_sha256=not-produced
  else
    printf 'missing compiled bytecode for %s\n' "$package_path" >&2
    exit 68
  fi

  case "$package_key" in
    reflection_core|test_assets|test_amm)
      package_source_sha256="$(bash "$source_digest_script" "$package_key")"
      ;;
    *)
      package_source_sha256="$({
        cd "$package_dir"
        find Move.toml sources tests -type f -print0 2>/dev/null \
          | sort -z \
          | xargs -0 -r sha256sum \
          | sha256sum \
          | cut -d ' ' -f 1
      })"
      ;;
  esac

  printf '%s_source_sha256=%s\n' "$package_key" "$package_source_sha256"
  printf '%s_dev_address_compiled_components_bytes=%s\n' "$package_key" "$compiled_components_bytes"
  printf '%s_dev_address_artifact_sha256=%s\n' "$package_key" "$compiled_artifact_sha256"

  jq -n \
    --argjson publishable "$publishable" \
    --argjson compiled_artifact_present "$compiled_artifact_present" \
    --arg upgrade_policy "$upgrade_policy" \
    --arg package_source_sha256 "$package_source_sha256" \
    --argjson compiled_artifact_sha256 "$compiled_artifact_sha256_json" \
    --argjson compiled_components_bytes "$compiled_components_bytes" \
    '{
      publishable: $publishable,
      upgrade_policy: $upgrade_policy,
      package_source_sha256: $package_source_sha256,
      compiled_artifact_present: $compiled_artifact_present,
      compiled_artifact_sha256: $compiled_artifact_sha256,
      dev_address_compiled_components_bytes: $compiled_components_bytes
    }' >"$tmp_directory/$package_key.json"
done

if [[ -n "$output_json" ]]; then
  jq -n \
    --arg generated_at "$generated_at" \
    --arg application_commit "$application_commit" \
    --arg application_tree "$application_tree" \
    --argjson working_tree_clean "$working_tree_clean" \
    --arg release_source_sha256 "$release_source_sha256" \
    --arg framework_revision "$framework_revision" \
    --arg cedra_cli_version "$cedra_cli_version" \
    --arg cedra_cli_path "$cedra_cli_path" \
    --arg cedra_cli_sha256 "$cedra_cli_sha256" \
    --slurpfile hook_probe "$tmp_directory/hook_probe.json" \
    --slurpfile reflection_core "$tmp_directory/reflection_core.json" \
    --slurpfile test_assets "$tmp_directory/test_assets.json" \
    --slurpfile test_amm "$tmp_directory/test_amm.json" \
    --slurpfile integration_tests "$tmp_directory/integration_tests.json" \
    '{
      schema_version: 1,
      evidence_scope: "local-release-build-verification",
      generated_at: $generated_at,
      network: "local-dev-address-build",
      application_commit: $application_commit,
      application_tree: $application_tree,
      working_tree_clean: $working_tree_clean,
      release_source_sha256: $release_source_sha256,
      framework_revision: $framework_revision,
      toolchain: {
        cedra_cli_version: $cedra_cli_version,
        cedra_cli_path: $cedra_cli_path,
        cedra_cli_sha256: $cedra_cli_sha256
      },
      packages: {
        hook_probe: $hook_probe[0],
        reflection_core: $reflection_core[0],
        test_assets: $test_assets[0],
        test_amm: $test_amm[0],
        integration_tests: $integration_tests[0]
      },
      approval_eligible: false,
      evidence_boundaries: {
        exact_publisher_addresses_used: false,
        full_test_suite_executed: false,
        network_state_observed: false,
        transaction_simulated: false,
        transaction_submitted: false
      }
    }' >"$output_json"
  bash "$evidence_validator" "$output_json"
  printf 'local_release_build_report=%s\n' "$output_json"
fi
