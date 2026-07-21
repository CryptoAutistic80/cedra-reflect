#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

usage() {
  printf 'usage: %s {reflection_core|test_assets|test_amm|all}\n' "$0" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$1" in
  reflection_core)
    roots=(move/reflection-core/Move.toml move/reflection-core/sources)
    ;;
  test_assets)
    roots=(move/test-assets/Move.toml move/test-assets/sources)
    ;;
  test_amm)
    roots=(move/test-amm/Move.toml move/test-amm/sources)
    ;;
  all)
    roots=(
      move/reflection-core/Move.toml
      move/reflection-core/sources
      move/test-assets/Move.toml
      move/test-assets/sources
      move/test-amm/Move.toml
      move/test-amm/sources
    )
    ;;
  *)
    usage
    ;;
esac

for root in "${roots[@]}"; do
  [[ -e "$repo_root/$root" ]] || {
    printf 'missing release source path: %s\n' "$root" >&2
    exit 66
  }
done

(
  cd "$repo_root"
  find "${roots[@]}" -type f -print0 \
    | sort -z \
    | xargs -0 -r sha256sum \
    | sha256sum \
    | cut -d ' ' -f 1
)
