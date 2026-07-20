#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s CORE_ADDRESS ASSETS_ADDRESS AMM_ADDRESS OUTPUT_DIRECTORY\n' "$0" >&2
  exit 64
}

[[ $# -eq 4 ]] || usage

core_address="$1"
assets_address="$2"
amm_address="$3"
output_directory="$4"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cedra_bin="${CEDRA_BIN:-/usr/bin/cedra}"
max_publish_package_size=65536

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
    printf 'publisher addresses must be non-zero\n' >&2
    exit 65
  }
  printf '0x%s' "$digits"
}

core_address="$(canonical_address "$core_address")"
assets_address="$(canonical_address "$assets_address")"
amm_address="$(canonical_address "$amm_address")"

[[ "$core_address" != "$assets_address" && "$core_address" != "$amm_address" && "$assets_address" != "$amm_address" ]] || {
  printf 'core, asset, and AMM publisher addresses must be distinct\n' >&2
  exit 65
}

if [[ -e "$output_directory" ]]; then
  [[ -d "$output_directory" && -z "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    printf 'output directory must not exist or must be empty: %s\n' "$output_directory" >&2
    exit 66
  }
else
  mkdir -p "$output_directory"
fi
output_directory="$(cd "$output_directory" && pwd)"

for manifest in \
  "$repo_root/move/reflection-core/Move.toml" \
  "$repo_root/move/test-assets/Move.toml" \
  "$repo_root/move/test-amm/Move.toml"; do
  grep -Fq 'upgrade_policy = "immutable"' "$manifest" || {
    printf 'release package is not immutable: %s\n' "$manifest" >&2
    exit 67
  }
done

compile_package() {
  local package_name="$1"
  local package_dir="$2"
  local named_addresses="$3"
  local bundle_dir="$output_directory/$package_name"

  "$cedra_bin" move compile \
    --package-dir "$package_dir" \
    --named-addresses "$named_addresses" \
    --save-metadata \
    --included-artifacts sparse \
    --skip-fetch-latest-git-deps \
    --fail-on-warning >/dev/null

  local metadata_file
  metadata_file="$(find "$package_dir/build" -mindepth 2 -maxdepth 2 -type f -name package-metadata.bcs -print -quit)"
  [[ -n "$metadata_file" ]] || {
    printf 'missing package metadata for %s\n' "$package_name" >&2
    exit 68
  }
  local compiled_root="${metadata_file%/package-metadata.bcs}"
  mkdir -p "$bundle_dir"
  cp "$metadata_file" "$bundle_dir/package-metadata.bcs"
  cp -R "$compiled_root/bytecode_modules" "$bundle_dir/bytecode_modules"
  local artifact_root="$bundle_dir"
  local bytecode_dir="$artifact_root/bytecode_modules"
  local bytecode_bytes
  local metadata_bytes
  local payload_bytes
  local artifact_digest
  bytecode_bytes="$(find "$bytecode_dir" -maxdepth 1 -type f -name '*.mv' -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')"
  metadata_bytes="$(stat -c '%s' "$metadata_file")"
  payload_bytes=$((bytecode_bytes + metadata_bytes))
  (( payload_bytes <= max_publish_package_size )) || {
    printf '%s exceeds the normal %s-byte publish boundary\n' "$package_name" "$max_publish_package_size" >&2
    exit 69
  }
  artifact_digest="$(
    cd "$artifact_root"
    find package-metadata.bcs bytecode_modules -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | cut -d ' ' -f 1
  )"
  printf '%s|%s|%s\n' "$package_name" "$payload_bytes" "$artifact_digest"
}

core_result="$(compile_package \
  reflection_core \
  "$repo_root/move/reflection-core" \
  "reflection_core=$core_address")"
assets_result="$(compile_package \
  test_assets \
  "$repo_root/move/test-assets" \
  "test_assets=$assets_address,reflection_core=$core_address")"
amm_result="$(compile_package \
  test_amm \
  "$repo_root/move/test-amm" \
  "test_amm=$amm_address,reflection_core=$core_address,test_assets=$assets_address")"

IFS='|' read -r _ core_bytes core_digest <<<"$core_result"
IFS='|' read -r _ assets_bytes assets_digest <<<"$assets_result"
IFS='|' read -r _ amm_bytes amm_digest <<<"$amm_result"

application_commit="$(git -C "$repo_root" rev-parse HEAD)"
generated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
working_tree_clean=true
if ! git -C "$repo_root" diff --quiet \
  || ! git -C "$repo_root" diff --cached --quiet \
  || [[ -n "$(git -C "$repo_root" ls-files --others --exclude-standard)" ]]; then
  working_tree_clean=false
fi
cat >"$output_directory/exact-address-artifacts.json" <<EOF
{
  "schema_version": 1,
  "generated_at": "$generated_at",
  "network": "cedra-testnet",
  "application_commit": "$application_commit",
  "working_tree_clean": $working_tree_clean,
  "approval_eligible": false,
  "approval_blockers": [
    "Testnet simulation not recorded",
    "two-person approval not recorded",
    "on-chain package digest and publication policy not finalized"
  ],
  "cedra_cli_version": "$($cedra_bin --version)",
  "packages": {
    "reflection_core": {
      "publisher": "$core_address",
      "event_source_address": "$core_address",
      "upgrade_policy": "immutable",
      "publish_payload_components_bytes": $core_bytes,
      "artifact_bundle_sha256": "$core_digest"
    },
    "test_assets": {
      "publisher": "$assets_address",
      "event_source_address": "$assets_address",
      "upgrade_policy": "immutable",
      "publish_payload_components_bytes": $assets_bytes,
      "artifact_bundle_sha256": "$assets_digest"
    },
    "test_amm": {
      "publisher": "$amm_address",
      "event_source_address": "$amm_address",
      "upgrade_policy": "immutable",
      "publish_payload_components_bytes": $amm_bytes,
      "artifact_bundle_sha256": "$amm_digest"
    }
  },
  "state_changes": false,
  "simulation_required_before_publish": true,
  "two_person_approval_required_before_publish": true
}
EOF

printf 'exact-address artifact bundle: %s\n' "$output_directory/exact-address-artifacts.json"
printf 'no transaction was built, signed, simulated, or submitted\n'
if [[ "$working_tree_clean" != true ]]; then
  printf 'warning: working tree is dirty; this bundle is test evidence only and is not approval-eligible\n' >&2
fi
