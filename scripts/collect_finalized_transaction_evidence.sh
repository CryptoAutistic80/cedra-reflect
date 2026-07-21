#!/usr/bin/bash -p
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s TRANSACTION_CANDIDATE_JSON APPROVAL_ENVELOPE_JSON TRUSTED_ALLOWED_SIGNERS_FILE EXACT_ADDRESS_ARTIFACTS_JSON PUBLIC_PROFILE_EVIDENCE_JSON TRANSACTION_HASH OUTPUT_DIRECTORY\n' "$0" >&2
  /usr/bin/printf 'performs only two HTTPS GET requests after immutable-snapshot candidate and approval verification\n' >&2
  exit 64
}

[[ $# -eq 7 ]] || usage
umask 077
repo_root="$(builtin cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/.." && builtin pwd -P)"
for variable in RELEASE_NODE_RUNTIME SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS; do
  [[ -n "${!variable:-}" ]] || {
    /usr/bin/printf '%s must be set explicitly for finalized evidence collection\n' "$variable" >&2
    exit 64
  }
done
for input in "$1" "$2" "$3" "$4" "$5" "$RELEASE_NODE_RUNTIME" "$SDK_REVIEW_ATTESTATION" "$SDK_REVIEW_SIGNATURE" "$SDK_REVIEW_TRUSTED_SIGNERS"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'collector input must be a regular non-symlink file: %s\n' "$input" >&2
    exit 66
  }
done

candidate_original="$(/usr/bin/readlink -f "$1")"
envelope_original="$(/usr/bin/readlink -f "$2")"
approval_trust_original="$(/usr/bin/readlink -f "$3")"
exact_original="$(/usr/bin/readlink -f "$4")"
profile_original="$(/usr/bin/readlink -f "$5")"
transaction_hash="${6,,}"
output_directory="$7"
[[ "$output_directory" == /* && "$(/usr/bin/readlink -m "$output_directory")" == "$output_directory" ]] || {
  /usr/bin/printf 'collector output must be an absolute normalized path with no symbolic-link traversal\n' >&2
  exit 66
}
sdk_attestation_original="$(/usr/bin/readlink -f "$SDK_REVIEW_ATTESTATION")"
sdk_signature_original="$(/usr/bin/readlink -f "$SDK_REVIEW_SIGNATURE")"
sdk_trust_original="$(/usr/bin/readlink -f "$SDK_REVIEW_TRUSTED_SIGNERS")"
runtime="$(/usr/bin/readlink -f "$RELEASE_NODE_RUNTIME")"
validator="$repo_root/scripts/validate_release_evidence.sh"

[[ "$transaction_hash" =~ ^0x[0-9a-f]{64}$ ]] || {
  /usr/bin/printf 'invalid finalized transaction hash\n' >&2
  exit 65
}
[[ "$(/usr/bin/basename "$candidate_original")" == transaction-candidate.json ]] || {
  /usr/bin/printf 'approved candidate filename must be transaction-candidate.json\n' >&2
  exit 65
}
[[ "$(/usr/bin/basename "$envelope_original")" == approval-envelope.json \
  && "$(/usr/bin/dirname "$envelope_original")" == "$(/usr/bin/dirname "$candidate_original")" ]] || {
  /usr/bin/printf 'collector requires the exact supplied approval-envelope.json beside the exact candidate\n' >&2
  exit 65
}

[[ ! -e "$output_directory" && ! -L "$output_directory" ]] || {
  /usr/bin/printf 'collector output must not already exist, including as an empty directory or symbolic link: %s\n' "$output_directory" >&2
  exit 66
}
output_parent="$(/usr/bin/dirname "$output_directory")"
[[ -d "$output_parent" && ! -L "$output_parent" ]] || {
  /usr/bin/printf 'collector output parent must already exist as a private real directory\n' >&2
  exit 66
}
resolved_parent="$(/usr/bin/readlink -f "$output_parent")"
[[ "$resolved_parent" == "$output_parent" && -d "$output_parent" && ! -L "$output_parent" ]] || {
  /usr/bin/printf 'collector output parent must be a real directory without symlink traversal\n' >&2
  exit 66
}
parent_owner="$(/usr/bin/stat -c '%u' "$output_parent")"
parent_mode="$(/usr/bin/stat -c '%a' "$output_parent")"
[[ "$parent_owner" == "$(/usr/bin/id -u)" && "$parent_mode" == 700 ]] || {
  /usr/bin/printf 'collector output parent must be owned by the current euid with exact mode 0700\n' >&2
  exit 66
}
if [[ "$output_directory" == "$repo_root/"* ]]; then
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
    /usr/bin/git -c "safe.directory=$repo_root" -C "$repo_root" \
    check-ignore -q "$output_directory" || {
    /usr/bin/printf 'an in-repository collector output must be ignored: %s\n' "$output_directory" >&2
    exit 66
  }
fi

# No repository code, snapshot helper, release validator, or network client is
# executed until the externally prepared root-owned release filesystem passes.
[[ -x "$runtime" && "$runtime" == "$repo_root/"* ]] || {
  /usr/bin/printf 'reviewed executable Node runtime must reside inside the isolated release root\n' >&2
  exit 66
}
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/validate_isolated_release_root.py" "$repo_root" >/dev/null

snapshot_root="$(/usr/bin/mktemp -d /tmp/cedra-finalized-inputs.XXXXXX)"
stage=""
published=false
cleanup() {
  if [[ "$snapshot_root" == /tmp/cedra-finalized-inputs.* && -d "$snapshot_root" ]]; then
    /usr/bin/rm -rf -- "$snapshot_root"
  fi
  if [[ "$published" == false && -n "$stage" && "$stage" == "$output_parent"/.cedra-finalized-stage.* ]]; then
    /usr/bin/rm -rf -- "$stage"
  elif [[ "$published" == true && -n "$stage" && -d "$stage" && "$stage" == "$output_parent"/.cedra-finalized-stage.* ]]; then
    /usr/bin/rm -rf -- "$stage" || true
  fi
}
trap cleanup EXIT
/usr/bin/chmod 0700 "$snapshot_root"

release_source_directory="$(/usr/bin/dirname "$candidate_original")"
exact_source_directory="$(/usr/bin/dirname "$exact_original")"
profile_source_directory="$(/usr/bin/dirname "$profile_original")"
snapshot_bindings=(
  "release=$release_source_directory"
  "approval-trust=$approval_trust_original"
  "sdk-attestation=$sdk_attestation_original"
  "sdk-signature=$sdk_signature_original"
  "sdk-trust=$sdk_trust_original"
)
release_snapshot_root="$snapshot_root/inputs/release"
if [[ "$exact_source_directory" == "$release_source_directory" ]]; then
  exact_snapshot_root="$release_snapshot_root"
else
  snapshot_bindings+=("exact=$exact_source_directory")
  exact_snapshot_root="$snapshot_root/inputs/exact"
fi
if [[ "$profile_source_directory" == "$release_source_directory" ]]; then
  profile_snapshot_root="$release_snapshot_root"
elif [[ "$profile_source_directory" == "$exact_source_directory" ]]; then
  profile_snapshot_root="$exact_snapshot_root"
else
  snapshot_bindings+=("profile=$profile_source_directory")
  profile_snapshot_root="$snapshot_root/inputs/profile"
fi
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/snapshot_release_inputs.py" "$snapshot_root/inputs" "${snapshot_bindings[@]}"

candidate_file="$release_snapshot_root/transaction-candidate.json"
approval_envelope="$release_snapshot_root/approval-envelope.json"
trusted_allowed_signers="$snapshot_root/inputs/approval-trust"
exact_artifacts="$exact_snapshot_root/$(/usr/bin/basename "$exact_original")"
public_profile="$profile_snapshot_root/$(/usr/bin/basename "$profile_original")"
sdk_attestation="$snapshot_root/inputs/sdk-attestation"
sdk_signature="$snapshot_root/inputs/sdk-signature"
sdk_trust="$snapshot_root/inputs/sdk-trust"

envelope_candidate_name="$(/usr/bin/jq -er '.candidate_file | select(. == "transaction-candidate.json")' "$approval_envelope")"
[[ "$release_snapshot_root/$envelope_candidate_name" == "$candidate_file" ]] || {
  /usr/bin/printf 'exact supplied approval envelope does not bind the exact supplied candidate\n' >&2
  exit 65
}

clean_release_env=(
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C TMPDIR=/tmp
  RELEASE_NODE_RUNTIME="$runtime"
  SDK_REVIEW_ATTESTATION="$sdk_attestation"
  SDK_REVIEW_SIGNATURE="$sdk_signature"
  SDK_REVIEW_TRUSTED_SIGNERS="$sdk_trust"
)
"${clean_release_env[@]}" /usr/bin/bash --noprofile --norc \
  "$repo_root/scripts/validate_transaction_candidate.sh" \
  "$candidate_file" "$exact_artifacts" "$public_profile" >/dev/null
"${clean_release_env[@]}" /usr/bin/bash --noprofile --norc \
  "$repo_root/scripts/verify_release_approvals.sh" \
  "$approval_envelope" "$trusted_allowed_signers" "$exact_artifacts" "$public_profile" >/dev/null

api_url="$(/usr/bin/jq -er '.api_url' "$candidate_file")"
[[ "$api_url" == "https://testnet.cedra.dev/v1" && "$(/usr/bin/jq -er '.chain_id' "$candidate_file")" == 2 ]] || {
  /usr/bin/printf 'collector is pinned to Cedra Testnet chain id 2\n' >&2
  exit 65
}

# Create same-parent publication staging only after the complete input
# snapshot and approval checks. This prevents a finalized output inside the
# candidate directory from recursively entering its own input snapshot.
stage="$(/usr/bin/mktemp -d "$output_parent/.cedra-finalized-stage.XXXXXX")"
/usr/bin/chmod 0700 "$stage"

bundle="$stage/bundle"
/usr/bin/mkdir -m 0700 "$bundle"
transaction_response="$bundle/transaction-response.json"
ledger_response="$bundle/ledger-info-response.json"
(
  set -o noclobber
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C HOME=/nonexistent \
    /usr/bin/curl --fail --silent --show-error \
    --proto '=https' --tlsv1.2 --retry 2 --retry-all-errors \
    --connect-timeout 10 --max-time 30 \
    "$api_url/transactions/by_hash/$transaction_hash" >"$transaction_response"
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C HOME=/nonexistent \
    /usr/bin/curl --fail --silent --show-error \
    --proto '=https' --tlsv1.2 --retry 2 --retry-all-errors \
    --connect-timeout 10 --max-time 30 \
    "$api_url/" >"$ledger_response"
)
/usr/bin/chmod 0600 "$transaction_response" "$ledger_response"

(
  set -o noclobber
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
    /usr/bin/python3 -I "$repo_root/scripts/release_evidence.py" validate-observed \
    "$candidate_file" "$exact_artifacts" "$public_profile" \
    "$transaction_response" "$ledger_response" "$transaction_hash" \
    >"$stage/observed-summary.json"
)
/usr/bin/chmod 0600 "$stage/observed-summary.json"

simulation_name="$(/usr/bin/jq -er '.simulation.raw_response_file | select(. == "simulation-response.json")' "$candidate_file")"
statement_name="$(/usr/bin/jq -er '.statement_file | select(. == "approval-statement.json")' "$approval_envelope")"
signature_name_1="$(/usr/bin/jq -er '.approvals[0].signature_file | select(test("^[A-Za-z0-9._-]+$") and (contains("..") | not))' "$approval_envelope")"
signature_name_2="$(/usr/bin/jq -er '.approvals[1].signature_file | select(test("^[A-Za-z0-9._-]+$") and (contains("..") | not))' "$approval_envelope")"
[[ "$signature_name_1" != "$signature_name_2" ]] || {
  /usr/bin/printf 'approval signature filenames must be distinct\n' >&2
  exit 65
}
for reserved in transaction-candidate.json simulation-response.json approval-statement.json approval-envelope.json transaction-response.json ledger-info-response.json transaction-evidence.json; do
  [[ "$signature_name_1" != "$reserved" && "$signature_name_2" != "$reserved" ]] || {
    /usr/bin/printf 'approval signature filename collides with a reserved bundle filename\n' >&2
    exit 65
  }
done

copy_exclusive=(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C /usr/bin/python3 -I "$repo_root/scripts/copy_regular_exclusive.py")
"${copy_exclusive[@]}" "$candidate_file" "$bundle/transaction-candidate.json"
"${copy_exclusive[@]}" "$release_snapshot_root/$simulation_name" "$bundle/simulation-response.json"
"${copy_exclusive[@]}" "$release_snapshot_root/$statement_name" "$bundle/approval-statement.json"
"${copy_exclusive[@]}" "$release_snapshot_root/$signature_name_1" "$bundle/$signature_name_1"
"${copy_exclusive[@]}" "$release_snapshot_root/$signature_name_2" "$bundle/$signature_name_2"
"${copy_exclusive[@]}" "$approval_envelope" "$bundle/approval-envelope.json"

candidate_sha256="$(/usr/bin/sha256sum "$bundle/transaction-candidate.json" | /usr/bin/cut -d ' ' -f 1)"
simulation_sha256="$(/usr/bin/sha256sum "$bundle/simulation-response.json" | /usr/bin/cut -d ' ' -f 1)"
envelope_sha256="$(/usr/bin/sha256sum "$bundle/approval-envelope.json" | /usr/bin/cut -d ' ' -f 1)"
statement_sha256="$(/usr/bin/sha256sum "$bundle/approval-statement.json" | /usr/bin/cut -d ' ' -f 1)"
transaction_response_sha256="$(/usr/bin/sha256sum "$transaction_response" | /usr/bin/cut -d ' ' -f 1)"
ledger_response_sha256="$(/usr/bin/sha256sum "$ledger_response" | /usr/bin/cut -d ' ' -f 1)"
transaction_identity_sha256="$(/usr/bin/jq -cS '.transaction_identity' "$candidate_file" | /usr/bin/sha256sum | /usr/bin/cut -d ' ' -f 1)"
collected_at="$(/usr/bin/date -u +'%Y-%m-%dT%H:%M:%SZ')"
approval_signatures="$(/usr/bin/jq -c '[.approvals[] | {identity,key_fingerprint,signature_file,signature_sha256}]' "$approval_envelope")"

(
  set -o noclobber
  /usr/bin/jq -n \
    --arg deployment_id "$(/usr/bin/jq -r '.deployment_id' "$candidate_file")" \
    --arg application_commit "$(/usr/bin/jq -r '.application_commit' "$candidate_file")" \
    --arg exact_address_artifacts_sha256 "$(/usr/bin/jq -r '.exact_address_artifacts_sha256' "$candidate_file")" \
    --arg public_profile_evidence_sha256 "$(/usr/bin/jq -r '.public_profile_binding.evidence_sha256' "$candidate_file")" \
    --arg public_role_candidate_sha256 "$(/usr/bin/jq -r '.public_profile_binding.public_role_candidate_sha256' "$candidate_file")" \
    --argjson roles "$(/usr/bin/jq -c '.roles' "$candidate_file")" \
    --arg transaction_kind "$(/usr/bin/jq -r '.transaction_kind' "$candidate_file")" \
    --arg operation_key "$(/usr/bin/jq -r '.operation_key' "$candidate_file")" \
    --arg transaction_hash "$transaction_hash" \
    --arg candidate_sha256 "$candidate_sha256" \
    --arg semantics_sha256 "$(/usr/bin/jq -r '.transaction_semantics_sha256' "$candidate_file")" \
    --arg transaction_identity_sha256 "$transaction_identity_sha256" \
    --arg raw_transaction_sha256 "$(/usr/bin/jq -r '.transaction_identity.rawTransactionSha256' "$candidate_file")" \
    --arg transaction_sha256 "$(/usr/bin/jq -r '.transaction_identity.transactionSha256' "$candidate_file")" \
    --arg signing_message_sha256 "$(/usr/bin/jq -r '.transaction_identity.signingMessageSha256' "$candidate_file")" \
    --arg simulation_sha256 "$simulation_sha256" \
    --arg envelope_sha256 "$envelope_sha256" \
    --arg statement_sha256 "$statement_sha256" \
    --arg trusted_allowed_signers_sha256 "$(/usr/bin/jq -r '.trusted_allowed_signers_sha256' "$approval_envelope")" \
    --argjson approval_signatures "$approval_signatures" \
    --arg collected_at "$collected_at" \
    --arg transaction_response_sha256 "$transaction_response_sha256" \
    --arg ledger_response_sha256 "$ledger_response_sha256" \
    --slurpfile observed "$stage/observed-summary.json" \
    '{
      schema_version:2,
      evidence_scope:"finalized-testnet-transaction",
      status:"finalized",
      network:"cedra-testnet",
      api_url:"https://testnet.cedra.dev/v1",
      chain_id:"2",
      deployment_id:$deployment_id,
      application_commit:$application_commit,
      exact_address_artifacts_sha256:$exact_address_artifacts_sha256,
      public_profile_evidence_sha256:$public_profile_evidence_sha256,
      public_role_candidate_sha256:$public_role_candidate_sha256,
      roles:$roles,
      transaction_kind:$transaction_kind,
      operation_key:$operation_key,
      transaction_hash:$transaction_hash,
      candidate:{
        file:"transaction-candidate.json",sha256:$candidate_sha256,
        transaction_semantics_sha256:$semantics_sha256,
        transaction_identity_sha256:$transaction_identity_sha256,
        raw_transaction_sha256:$raw_transaction_sha256,
        transaction_sha256:$transaction_sha256,
        signing_message_sha256:$signing_message_sha256
      },
      simulation:{file:"simulation-response.json",sha256:$simulation_sha256},
      approval:{
        envelope_file:"approval-envelope.json",envelope_sha256:$envelope_sha256,
        statement_file:"approval-statement.json",statement_sha256:$statement_sha256,
        trusted_allowed_signers_sha256:$trusted_allowed_signers_sha256,
        signatures:$approval_signatures,authenticated:true,
        verifier:"OpenSSH ssh-keygen -Y verify"
      },
      collection:($observed[0] + {
        collected_at:$collected_at,
        raw_transaction_response_file:"transaction-response.json",
        raw_transaction_response_sha256:$transaction_response_sha256,
        ledger_info_response_file:"ledger-info-response.json",
        ledger_info_response_sha256:$ledger_response_sha256,
        read_only_requests:["GET /transactions/by_hash/{hash}","GET /"]
      }),
      state_changes_performed_by_collector:false
    }' >"$bundle/transaction-evidence.json"
)
/usr/bin/chmod 0600 "$bundle/transaction-evidence.json"

"${clean_release_env[@]}" \
  EXACT_ADDRESS_ARTIFACTS_FILE="$exact_artifacts" \
  PUBLIC_PROFILE_EVIDENCE_FILE="$public_profile" \
  TRUSTED_ALLOWED_SIGNERS_FILE="$trusted_allowed_signers" \
  /usr/bin/bash --noprofile --norc "$validator" "$bundle/transaction-evidence.json" >/dev/null

expected_inventory="$(/usr/bin/printf '%s\n' \
  approval-envelope.json approval-statement.json ledger-info-response.json simulation-response.json \
  transaction-candidate.json transaction-evidence.json transaction-response.json \
  "$signature_name_1" "$signature_name_2" | /usr/bin/sort)"
actual_inventory="$(/usr/bin/find "$bundle" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | /usr/bin/sort)"
[[ "$actual_inventory" == "$expected_inventory" \
  && -z "$(/usr/bin/find "$bundle" -mindepth 1 ! -type f -print -quit)" ]] || {
  /usr/bin/printf 'collector staging bundle has a partial or unexpected inventory\n' >&2
  exit 65
}
while IFS= builtin read -r file; do
  [[ "$(/usr/bin/stat -c '%a' "$bundle/$file")" == 600 ]] || {
    /usr/bin/printf 'collector staging file is not private: %s\n' "$file" >&2
    exit 65
  }
done <<<"$actual_inventory"
[[ "$(/usr/bin/stat -c '%a' "$bundle")" == 700 ]] || {
  /usr/bin/printf 'collector staging directory is not private\n' >&2
  exit 65
}

fsync_paths=(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C /usr/bin/python3 -I "$repo_root/scripts/fsync_release_paths.py")
while IFS= builtin read -r file; do
  "${fsync_paths[@]}" "$bundle/$file"
done <<<"$actual_inventory"
"${fsync_paths[@]}" "$bundle" "$stage" "$output_parent"
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/rename_noreplace.py" "$bundle" "$output_directory"
published=true
[[ "$stage" == "$output_parent"/.cedra-finalized-stage.* ]] || {
  /usr/bin/printf 'refusing unsafe finalized-evidence staging cleanup path\n' >&2
  exit 70
}
cleanup_failed=false
if ! /usr/bin/rm -rf -- "$stage"; then
  cleanup_failed=true
fi
if ! "${fsync_paths[@]}" "$output_parent"; then
  /usr/bin/printf 'finalized evidence was published at %s, but directory durability is unknown\n' "$output_directory" >&2
  exit 74
fi
if [[ "$cleanup_failed" == true ]]; then
  /usr/bin/printf 'finalized evidence was published durably at %s, but private staging cleanup failed\n' "$output_directory" >&2
  exit 74
fi

/usr/bin/printf 'finalized read-only Cedra Testnet transaction evidence: %s/transaction-evidence.json\n' "$output_directory"
/usr/bin/printf 'collector submitted no transaction and read no Cedra CLI profile or private key\n'
