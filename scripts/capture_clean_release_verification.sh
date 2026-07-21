#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

usage() {
  printf 'usage: %s OUTPUT_DIRECTORY\n' "$0" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -n "${RELEASE_NODE_RUNTIME:-}" && -f "$RELEASE_NODE_RUNTIME" \
  && ! -L "$RELEASE_NODE_RUNTIME" && -x "$RELEASE_NODE_RUNTIME" ]] || {
  printf 'set RELEASE_NODE_RUNTIME to the explicit reviewed Node.js binary\n' >&2
  exit 64
}
release_node_runtime="$(/usr/bin/readlink -f "$RELEASE_NODE_RUNTIME")"
output_directory="$1"
cedra_bin="${CEDRA_BIN:-/usr/bin/cedra}"
source_digest_script="$repo_root/scripts/compute_release_source_digest.sh"
evidence_validator="$repo_root/scripts/validate_release_evidence.sh"

for command_name in git jq sha256sum tee make; do
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

git_worktree_clean || {
  printf 'refusing to capture release verification from a dirty working tree\n' >&2
  exit 67
}

application_commit_before="$(git -C "$repo_root" rev-parse --verify HEAD)"
application_tree="$(git -C "$repo_root" rev-parse --verify 'HEAD^{tree}')"
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

verification_log="$output_directory/verification.log"
local_build_report="$output_directory/local-release-build.json"
model_gate_report="$output_directory/model-gate-report.json"

(
  printf 'evidence_scope=local-clean-full-verification\n'
  printf 'application_commit=%s\n' "$application_commit_before"
  printf 'application_tree=%s\n' "$application_tree"
  printf 'release_source_sha256=%s\n' "$release_source_sha256_before"
  printf 'command=make verify RELEASE_NODE_RUNTIME=%s\n' "$release_node_runtime"
  make -C "$repo_root" verify RELEASE_NODE_RUNTIME="$release_node_runtime"
  printf 'command=make pilot-gate with provenance report\n'
  REFLECTION_MODEL_REPORT="$model_gate_report" make -C "$repo_root" pilot-gate
  printf 'command=CEDRA_BIN=%s bash scripts/verify_release_artifacts.sh local-release-build.json\n' "$cedra_bin"
  CEDRA_BIN="$cedra_bin" bash "$repo_root/scripts/verify_release_artifacts.sh" "$local_build_report"
) 2>&1 | tee "$verification_log"

git_worktree_clean || {
  printf 'working tree changed during release verification; no clean record was created\n' >&2
  exit 70
}
application_commit_after="$(git -C "$repo_root" rev-parse --verify HEAD)"
release_source_sha256_after="$(bash "$source_digest_script" all)"
[[ "$application_commit_before" == "$application_commit_after" && "$release_source_sha256_before" == "$release_source_sha256_after" ]] || {
  printf 'release source changed during verification; no clean record was created\n' >&2
  exit 70
}

cedra_cli_path="$(readlink -f "$cedra_bin")"
cedra_cli_version="$($cedra_bin --version)"
cedra_cli_sha256="$(sha256sum "$cedra_cli_path" | cut -d ' ' -f 1)"
framework_revision="$(jq -r '.framework_revision' "$local_build_report")"
verification_log_sha256="$(sha256sum "$verification_log" | cut -d ' ' -f 1)"
local_build_report_sha256="$(sha256sum "$local_build_report" | cut -d ' ' -f 1)"
model_gate_report_sha256="$(sha256sum "$model_gate_report" | cut -d ' ' -f 1)"
generated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

jq -n \
  --arg generated_at "$generated_at" \
  --arg application_commit "$application_commit_before" \
  --arg application_tree "$application_tree" \
  --arg release_source_sha256 "$release_source_sha256_before" \
  --arg framework_revision "$framework_revision" \
  --arg cedra_cli_version "$cedra_cli_version" \
  --arg cedra_cli_path "$cedra_cli_path" \
  --arg cedra_cli_sha256 "$cedra_cli_sha256" \
  --arg verification_command "make verify RELEASE_NODE_RUNTIME=$release_node_runtime" \
  --arg release_build_command "CEDRA_BIN=$cedra_cli_path bash scripts/verify_release_artifacts.sh local-release-build.json" \
  --arg verification_log_sha256 "$verification_log_sha256" \
  --arg local_build_report_sha256 "$local_build_report_sha256" \
  --arg model_gate_report_sha256 "$model_gate_report_sha256" \
  '{
    schema_version: 1,
    evidence_scope: "local-clean-full-verification",
    generated_at: $generated_at,
    network: "local-only",
    application_commit: $application_commit,
    application_tree: $application_tree,
    working_tree_clean_before: true,
    working_tree_clean_after: true,
    verification_succeeded: true,
    release_source_sha256: $release_source_sha256,
    framework_revision: $framework_revision,
    toolchain: {
      cedra_cli_version: $cedra_cli_version,
      cedra_cli_path: $cedra_cli_path,
      cedra_cli_sha256: $cedra_cli_sha256
    },
    verification_commands: [
      $verification_command,
      "REFLECTION_MODEL_REPORT=model-gate-report.json make pilot-gate",
      $release_build_command
    ],
    verification_log: {
      file: "verification.log",
      sha256: $verification_log_sha256
    },
    local_release_build_report: {
      file: "local-release-build.json",
      sha256: $local_build_report_sha256
    },
    model_gate_report: {
      file: "model-gate-report.json",
      sha256: $model_gate_report_sha256
    },
    evidence_boundaries: {
      exact_publisher_addresses_used: false,
      network_state_observed: false,
      transaction_simulated: false,
      transaction_submitted: false
    }
  }' >"$output_directory/verification-record.json"

chmod 0600 "$verification_log" "$local_build_report" "$model_gate_report" "$output_directory/verification-record.json"
bash "$evidence_validator" "$output_directory/verification-record.json"
printf 'clean release verification record: %s\n' "$output_directory/verification-record.json"
printf 'scope: local tests and dev-address builds only; no Testnet state was observed or changed\n'
