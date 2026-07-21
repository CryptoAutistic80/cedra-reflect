#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

[[ $# -eq 3 ]] || {
  /usr/bin/printf 'usage: %s REPOSITORY_ROOT CANDIDATE_OR_BUILD_REQUEST_JSON EXACT_ADDRESS_ARTIFACTS_JSON\n' "$0" >&2
  exit 64
}
repository="$(/usr/bin/readlink -f "$1")"

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/python3 -I "$repository/scripts/validate_isolated_release_root.py" "$repository" >/dev/null
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc "$repository/scripts/validate_live_release_checkout_component.sh" \
  "$repository" "$2" "$3"
