#!/usr/bin/bash -p
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s TRANSACTION_CANDIDATE_JSON EXACT_ADDRESS_ARTIFACTS_JSON PUBLIC_PROFILE_EVIDENCE_JSON OUTPUT_STATEMENT_JSON\n' "$0" >&2
  exit 64
}

[[ $# -eq 4 ]] || usage
umask 077
repo_root="$(builtin cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/.." && builtin pwd -P)"
for variable in RELEASE_NODE_RUNTIME SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS; do
  [[ -n "${!variable:-}" ]] || {
    /usr/bin/printf '%s must be set explicitly before rendering an approval statement\n' "$variable" >&2
    exit 64
  }
done

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/validate_isolated_release_root.py" "$repo_root" >/dev/null

for input in "$1" "$2" "$3" "$RELEASE_NODE_RUNTIME" "$SDK_REVIEW_ATTESTATION" "$SDK_REVIEW_SIGNATURE" "$SDK_REVIEW_TRUSTED_SIGNERS"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'approval-statement inputs must be regular non-symlink files: %s\n' "$input" >&2
    exit 66
  }
done
[[ -x "$RELEASE_NODE_RUNTIME" ]] || {
  /usr/bin/printf 'RELEASE_NODE_RUNTIME must be executable\n' >&2
  exit 66
}

candidate_original="$(/usr/bin/readlink -f "$1")"
exact_original="$(/usr/bin/readlink -f "$2")"
profile_original="$(/usr/bin/readlink -f "$3")"
runtime_original="$(/usr/bin/readlink -f "$RELEASE_NODE_RUNTIME")"
attestation_original="$(/usr/bin/readlink -f "$SDK_REVIEW_ATTESTATION")"
signature_original="$(/usr/bin/readlink -f "$SDK_REVIEW_SIGNATURE")"
trust_original="$(/usr/bin/readlink -f "$SDK_REVIEW_TRUSTED_SIGNERS")"
output="$4"

[[ "$runtime_original" == "$repo_root/"* ]] || {
  /usr/bin/printf 'reviewed Node runtime must reside inside the isolated release root\n' >&2
  exit 66
}

snapshot_root="$(/usr/bin/mktemp -d /tmp/cedra-approval-statement.XXXXXX)"
cleanup() {
  [[ "$snapshot_root" == /tmp/cedra-approval-statement.* ]] || return 1
  /usr/bin/rm -rf -- "$snapshot_root"
}
trap cleanup EXIT

candidate_source="$(/usr/bin/dirname "$candidate_original")"
exact_source="$(/usr/bin/dirname "$exact_original")"
profile_source="$(/usr/bin/dirname "$profile_original")"
snapshot_bindings=("candidate=$candidate_source")
candidate_root="$snapshot_root/inputs/candidate"
if [[ "$exact_source" == "$candidate_source" ]]; then
  exact_root="$candidate_root"
else
  snapshot_bindings+=("exact=$exact_source")
  exact_root="$snapshot_root/inputs/exact"
fi
if [[ "$profile_source" == "$candidate_source" ]]; then
  profile_root="$candidate_root"
elif [[ "$profile_source" == "$exact_source" ]]; then
  profile_root="$exact_root"
else
  snapshot_bindings+=("profile=$profile_source")
  profile_root="$snapshot_root/inputs/profile"
fi
snapshot_bindings+=(
  "sdk-attestation=$attestation_original"
  "sdk-signature=$signature_original"
  "sdk-trust=$trust_original"
)
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/snapshot_release_inputs.py" "$snapshot_root/inputs" "${snapshot_bindings[@]}"

candidate="$candidate_root/$(/usr/bin/basename "$candidate_original")"
exact_artifacts="$exact_root/$(/usr/bin/basename "$exact_original")"
public_profile="$profile_root/$(/usr/bin/basename "$profile_original")"
attestation="$snapshot_root/inputs/sdk-attestation"
signature="$snapshot_root/inputs/sdk-signature"
trust="$snapshot_root/inputs/sdk-trust"

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C TMPDIR=/tmp \
  RELEASE_NODE_RUNTIME="$runtime_original" \
  SDK_REVIEW_ATTESTATION="$attestation" \
  SDK_REVIEW_SIGNATURE="$signature" \
  SDK_REVIEW_TRUSTED_SIGNERS="$trust" \
  /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_transaction_candidate.sh" \
  "$candidate" "$exact_artifacts" "$public_profile" >/dev/null

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/render_approval_statement_secure.py" \
  "$repo_root" "$candidate" "$exact_artifacts" "$public_profile" "$output"
/usr/bin/printf 'sign with: /usr/bin/ssh-keygen -Y sign -n cedra-reflect-testnet-release-v1 -f APPROVER_PRIVATE_KEY %s\n' "$output"
