#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s EXACT_ADDRESS_ARTIFACTS_JSON PUBLIC_PROFILE_EVIDENCE_JSON\n' "$0" >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
repo_root="$(builtin cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/.." && builtin pwd -P)"
for input in "$1" "$2"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'release input must be a regular non-symlink file: %s\n' "$input" >&2
    exit 66
  }
done
exact_artifacts="$(/usr/bin/readlink -f "$1")"
public_profile="$(/usr/bin/readlink -f "$2")"
validator="$repo_root/scripts/validate_release_evidence.sh"

# Scope checks make the call graph explicit: this helper invokes the general
# validator only for exact-address and profile evidence. It can never feed a
# transaction candidate back into validate_transaction_candidate.sh.
[[ "$(/usr/bin/jq -er '.evidence_scope' "$exact_artifacts")" == local-exact-address-build-only ]] || {
  /usr/bin/printf 'candidate exact input has the wrong evidence scope\n' >&2
  exit 65
}
[[ "$(/usr/bin/jq -er '.evidence_scope' "$public_profile")" == local-public-profile-preflight ]] || {
  /usr/bin/printf 'candidate profile input has the wrong evidence scope\n' >&2
  exit 65
}

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc "$validator" "$exact_artifacts" >/dev/null
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc "$validator" "$public_profile" >/dev/null

/usr/bin/jq -e '
  .schema_version == 3
  and .working_tree_clean == true
  and .local_build_eligible_for_human_review == true
  and .approval_eligible == false
  and .verification_binding != null
  and .public_role_candidate_binding != null
' "$exact_artifacts" >/dev/null || {
  /usr/bin/printf 'candidate exact-address evidence is dirty, ineligible, or missing required provenance\n' >&2
  exit 65
}

exact_roles="$(/usr/bin/jq -cS '.roles' "$exact_artifacts")"
profile_roles="$(/usr/bin/jq -cS '.profiles | with_entries(.value = ("0x" + .value.account | ascii_downcase | sub("^0x0+"; "0x")))' "$public_profile")"
[[ "$exact_roles" == "$profile_roles" ]] || {
  /usr/bin/printf 'public profile addresses differ from the exact-address four-role map\n' >&2
  exit 65
}
[[ "$(/usr/bin/jq -r '.public_role_candidate_binding.sha256' "$exact_artifacts")" == "$(/usr/bin/jq -r '.public_role_candidate_sha256' "$public_profile")" ]] || {
  /usr/bin/printf 'public profile and exact-address evidence bind different role-candidate digests\n' >&2
  exit 65
}

/usr/bin/printf 'valid approval-grade exact-address and public-profile inputs\n'
