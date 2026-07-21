#!/usr/bin/bash -p
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s EXACT_ADDRESS_ARTIFACTS_JSON PUBLIC_PROFILE_EVIDENCE_JSON BUILD_REQUEST_JSON OUTPUT_DIRECTORY\n' "$0" >&2
  /usr/bin/printf 'requires RELEASE_NODE_RUNTIME, RELEASE_EMITTED_JS_DIRECTORY, SDK_REVIEW_ATTESTATION, SDK_REVIEW_SIGNATURE, and SDK_REVIEW_TRUSTED_SIGNERS\n' >&2
  exit 64
}

[[ $# -eq 4 ]] || usage
umask 077
repo_root="$(builtin cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/.." && builtin pwd -P)"
for variable in RELEASE_NODE_RUNTIME RELEASE_EMITTED_JS_DIRECTORY SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS; do
  [[ -n "${!variable:-}" ]] || {
    /usr/bin/printf '%s must be set explicitly for candidate assembly\n' "$variable" >&2
    exit 64
  }
done
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/validate_isolated_release_root.py" "$repo_root" >/dev/null
for input in "$1" "$2" "$3" "$RELEASE_NODE_RUNTIME" "$SDK_REVIEW_ATTESTATION" "$SDK_REVIEW_SIGNATURE" "$SDK_REVIEW_TRUSTED_SIGNERS"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'candidate-assembly input must be a regular non-symlink file: %s\n' "$input" >&2
    exit 66
  }
done
runtime="$(/usr/bin/readlink -f "$RELEASE_NODE_RUNTIME")"
emitted_root="$(/usr/bin/readlink -f "$RELEASE_EMITTED_JS_DIRECTORY")"
[[ -d "$emitted_root" && ! -L "$RELEASE_EMITTED_JS_DIRECTORY" ]] || {
  /usr/bin/printf 'RELEASE_EMITTED_JS_DIRECTORY must be a real directory\n' >&2
  exit 66
}
[[ "$runtime" == "$repo_root/"* && "$emitted_root" == "$repo_root/"* ]] || {
  /usr/bin/printf 'reviewed Node and emitted JavaScript must reside inside the isolated release root\n' >&2
  exit 66
}
exact_original="$(/usr/bin/readlink -f "$1")"
profile_original="$(/usr/bin/readlink -f "$2")"
request_original="$(/usr/bin/readlink -f "$3")"
attestation_original="$(/usr/bin/readlink -f "$SDK_REVIEW_ATTESTATION")"
signature_original="$(/usr/bin/readlink -f "$SDK_REVIEW_SIGNATURE")"
trust_original="$(/usr/bin/readlink -f "$SDK_REVIEW_TRUSTED_SIGNERS")"
output_directory="$(/usr/bin/readlink -m "$4")"

snapshot_root="$(/usr/bin/mktemp -d /tmp/cedra-candidate-assembly.XXXXXX)"
cleanup() {
  [[ "$snapshot_root" == /tmp/cedra-candidate-assembly.* ]] || return 1
  /usr/bin/rm -rf -- "$snapshot_root"
}
trap cleanup EXIT
exact_source="$(/usr/bin/dirname "$exact_original")"
profile_source="$(/usr/bin/dirname "$profile_original")"
request_source="$(/usr/bin/dirname "$request_original")"
snapshot_bindings=("exact=$exact_source")
exact_root="$snapshot_root/inputs/exact"
if [[ "$profile_source" == "$exact_source" ]]; then
  profile_root="$exact_root"
else
  snapshot_bindings+=("profile=$profile_source")
  profile_root="$snapshot_root/inputs/profile"
fi
if [[ "$request_source" == "$exact_source" ]]; then
  request="$exact_root/$(/usr/bin/basename "$request_original")"
elif [[ "$request_source" == "$profile_source" ]]; then
  request="$profile_root/$(/usr/bin/basename "$request_original")"
else
  snapshot_bindings+=("request=$request_original")
  request="$snapshot_root/inputs/request"
fi
snapshot_bindings+=(
  "sdk-attestation=$attestation_original"
  "sdk-signature=$signature_original"
  "sdk-trust=$trust_original"
)
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repo_root/scripts/snapshot_release_inputs.py" "$snapshot_root/inputs" "${snapshot_bindings[@]}"

exact="$exact_root/$(/usr/bin/basename "$exact_original")"
profile="$profile_root/$(/usr/bin/basename "$profile_original")"
attestation="$snapshot_root/inputs/sdk-attestation"
signature="$snapshot_root/inputs/sdk-signature"
trust="$snapshot_root/inputs/sdk-trust"

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc "$repo_root/scripts/validate_live_release_checkout.sh" \
  "$repo_root" "$request" "$exact" >/dev/null
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc "$repo_root/scripts/preflight_release_executable_closure.sh" \
  "$repo_root" "$runtime" "$attestation" "$signature" "$trust" execution "$emitted_root" >/dev/null
/usr/bin/env -i LC_ALL=C LANG=C PATH=/usr/bin:/bin TMPDIR=/tmp \
  RELEASE_NODE_RUNTIME="$runtime" \
  SDK_REVIEW_ATTESTATION="$attestation" \
  SDK_REVIEW_SIGNATURE="$signature" \
  SDK_REVIEW_TRUSTED_SIGNERS="$trust" \
  "$runtime" "$emitted_root/scripts/assemble-testnet-transaction-candidate.js" \
  "$exact" "$profile" "$request" "$output_directory" "$attestation" "$signature" "$trust" \
  "$repo_root" "$emitted_root"
