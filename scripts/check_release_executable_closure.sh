#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || {
  printf 'usage: %s REPOSITORY_ROOT REVIEWED_NODE_RUNTIME\n' "$0" >&2
  exit 64
}
repo="$(/usr/bin/readlink -f "$1")"
manifest="$repo/ops/evidence/release-executable-closure.json"
[[ -f "$manifest" && ! -L "$manifest" ]] || {
  printf 'checked-in release executable-closure manifest is missing\n' >&2
  exit 65
}
rendered="$(/usr/bin/mktemp /tmp/cedra-release-closure.XXXXXX)"
cleanup() { /usr/bin/rm -f -- "$rendered"; }
trap cleanup EXIT
/usr/bin/bash "$repo/scripts/render_release_executable_closure.sh" "$repo" "$2" >"$rendered"
/usr/bin/cmp -s "$rendered" "$manifest" || {
  printf 'checked-in release executable closure is stale; regenerate it only after final source and dist settle\n' >&2
  /usr/bin/diff -u "$manifest" "$rendered" >&2 || true
  exit 65
}
printf 'checked-in release executable closure matches runtime, compiler, emitted JS, SDK, and transitive package trees\n'
