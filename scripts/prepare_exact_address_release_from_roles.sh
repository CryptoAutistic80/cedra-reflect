#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s PUBLIC_ROLE_CANDIDATE_JSON OUTPUT_DIRECTORY\n' "$0" >&2
  exit 64
}

[[ $# -eq 2 ]] || usage

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
role_file="$1"
output_directory="$2"

bash "$repo_root/scripts/validate_release_evidence.sh" "$role_file"
[[ "$(jq -r '.evidence_scope' "$role_file")" == "local-public-role-candidate" ]] || {
  printf 'role input is not a local public-role candidate\n' >&2
  exit 65
}

core_address="$(jq -er '.roles.core_publisher.address' "$role_file")"
assets_address="$(jq -er '.roles.assets_publisher.address' "$role_file")"
amm_address="$(jq -er '.roles.amm_publisher.address' "$role_file")"
operations_address="$(jq -er '.roles.operations.address' "$role_file")"
bootstrap_lp_address="$(jq -er '.roles.bootstrap_lp.address' "$role_file")"

CEDRA_BIN="${CEDRA_BIN:-/usr/bin/cedra}" \
  RELEASE_VERIFICATION_RECORD="${RELEASE_VERIFICATION_RECORD:-}" \
  PUBLIC_ROLE_CANDIDATE_FILE="$(readlink -f "$role_file")" \
  bash "$repo_root/scripts/prepare_exact_address_release.sh" \
    "$core_address" "$assets_address" "$amm_address" \
    "$operations_address" "$bootstrap_lp_address" "$output_directory"
