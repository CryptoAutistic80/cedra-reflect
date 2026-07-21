#!/usr/bin/bash -p
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s APPROVAL_ENVELOPE_JSON TRUSTED_ALLOWED_SIGNERS_FILE EXACT_ADDRESS_ARTIFACTS_JSON PUBLIC_PROFILE_EVIDENCE_JSON\n' "$0" >&2
  /usr/bin/printf 'the trusted allowed-signers file is an external trust anchor, not a file supplied by the envelope\n' >&2
  exit 64
}

[[ $# -eq 4 ]] || usage
repo_root="$(builtin cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/.." && builtin pwd -P)"
for variable in RELEASE_NODE_RUNTIME SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS; do
  [[ -n "${!variable:-}" ]] || {
    /usr/bin/printf '%s must be set explicitly for release-approval verification\n' "$variable" >&2
    exit 64
  }
done

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/validate_isolated_release_root.py" "$repo_root" >/dev/null

for input in "$1" "$2" "$3" "$4" "$RELEASE_NODE_RUNTIME" "$SDK_REVIEW_ATTESTATION" "$SDK_REVIEW_SIGNATURE" "$SDK_REVIEW_TRUSTED_SIGNERS"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'approval inputs must be regular non-symlink files: %s\n' "$input" >&2
    exit 66
  }
done
[[ -x "$RELEASE_NODE_RUNTIME" ]] || {
  /usr/bin/printf 'RELEASE_NODE_RUNTIME must be executable\n' >&2
  exit 66
}

envelope_original="$(/usr/bin/readlink -f "$1")"
approval_trust_original="$(/usr/bin/readlink -f "$2")"
exact_original="$(/usr/bin/readlink -f "$3")"
profile_original="$(/usr/bin/readlink -f "$4")"
runtime_original="$(/usr/bin/readlink -f "$RELEASE_NODE_RUNTIME")"
attestation_original="$(/usr/bin/readlink -f "$SDK_REVIEW_ATTESTATION")"
signature_original="$(/usr/bin/readlink -f "$SDK_REVIEW_SIGNATURE")"
sdk_trust_original="$(/usr/bin/readlink -f "$SDK_REVIEW_TRUSTED_SIGNERS")"
[[ "$runtime_original" == "$repo_root/"* ]] || {
  /usr/bin/printf 'reviewed Node runtime must reside inside the isolated release root\n' >&2
  exit 66
}

snapshot_root="$(/usr/bin/mktemp -d /tmp/cedra-approval-validation.XXXXXX)"
cleanup() {
  [[ "$snapshot_root" == /tmp/cedra-approval-validation.* ]] || return 1
  /usr/bin/rm -rf -- "$snapshot_root"
}
trap cleanup EXIT

release_source="$(/usr/bin/dirname "$envelope_original")"
exact_source="$(/usr/bin/dirname "$exact_original")"
profile_source="$(/usr/bin/dirname "$profile_original")"
snapshot_bindings=(
  "release=$release_source"
  "approval-trust=$approval_trust_original"
  "sdk-attestation=$attestation_original"
  "sdk-signature=$signature_original"
  "sdk-trust=$sdk_trust_original"
)
release_root="$snapshot_root/inputs/release"
if [[ "$exact_source" == "$release_source" ]]; then
  exact_root="$release_root"
else
  snapshot_bindings+=("exact=$exact_source")
  exact_root="$snapshot_root/inputs/exact"
fi
if [[ "$profile_source" == "$release_source" ]]; then
  profile_root="$release_root"
elif [[ "$profile_source" == "$exact_source" ]]; then
  profile_root="$exact_root"
else
  snapshot_bindings+=("profile=$profile_source")
  profile_root="$snapshot_root/inputs/profile"
fi

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/snapshot_release_inputs.py" "$snapshot_root/inputs" "${snapshot_bindings[@]}"

envelope="$release_root/$(/usr/bin/basename "$envelope_original")"
trusted_allowed_signers="$snapshot_root/inputs/approval-trust"
exact_artifacts="$exact_root/$(/usr/bin/basename "$exact_original")"
public_profile="$profile_root/$(/usr/bin/basename "$profile_original")"
attestation="$snapshot_root/inputs/sdk-attestation"
signature="$snapshot_root/inputs/sdk-signature"
sdk_trust="$snapshot_root/inputs/sdk-trust"

candidate_name="$(/usr/bin/jq -er '.candidate_file | select(. == "transaction-candidate.json")' "$envelope")"
candidate_file="$release_root/$candidate_name"
[[ -f "$candidate_file" && ! -L "$candidate_file" ]] || {
  /usr/bin/printf 'approval envelope candidate must be a regular non-symlink transaction-candidate.json\n' >&2
  exit 66
}

clean_release_env=(
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C TMPDIR=/tmp
  RELEASE_NODE_RUNTIME="$runtime_original"
  SDK_REVIEW_ATTESTATION="$attestation"
  SDK_REVIEW_SIGNATURE="$signature"
  SDK_REVIEW_TRUSTED_SIGNERS="$sdk_trust"
)
"${clean_release_env[@]}" /usr/bin/bash --noprofile --norc \
  "$repo_root/scripts/validate_transaction_candidate.sh" \
  "$candidate_file" "$exact_artifacts" "$public_profile" >/dev/null
"${clean_release_env[@]}" /usr/bin/python3 -I "$repo_root/scripts/release_evidence.py" \
  validate-envelope "$envelope" "$trusted_allowed_signers" "$exact_artifacts" "$public_profile" >/dev/null
"${clean_release_env[@]}" /usr/bin/bash --noprofile --norc \
  "$repo_root/scripts/verify_detached_ssh_signatures.sh" \
  "$envelope" "$trusted_allowed_signers" >/dev/null

/usr/bin/printf 'two distinct detached release approvals from distinct signing keys verified against trust anchor SHA-256 %s\n' \
  "$(/usr/bin/sha256sum "$trusted_allowed_signers" | /usr/bin/cut -d ' ' -f 1)"
