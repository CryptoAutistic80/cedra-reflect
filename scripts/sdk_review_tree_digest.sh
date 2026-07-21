#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

[[ $# -eq 1 ]] || {
  printf 'usage: %s SDK_PACKAGE_DIRECTORY\n' "$0" >&2
  exit 64
}
[[ -d "$1" && ! -L "$1" ]] || {
  printf 'SDK tree root must be a real directory\n' >&2
  exit 66
}
root="$(/usr/bin/readlink -f "$1")"
[[ -z "$(/usr/bin/find "$root" -mindepth 1 ! -type d ! -type f -print -quit)" ]] || {
  printf 'reviewed SDK tree contains a symbolic link or unsupported entry\n' >&2
  exit 65
}
records="$(/usr/bin/mktemp /tmp/cedra-sdk-review-records.XXXXXX)"
paths="$(/usr/bin/mktemp /tmp/cedra-sdk-review-paths.XXXXXX)"
cleanup() { /usr/bin/rm -f -- "$records" "$paths"; }
trap cleanup EXIT
count=0
visit() {
  local directory="$1" path relative
  /usr/bin/find "$directory" -mindepth 1 -maxdepth 1 -print0 | /usr/bin/sort -z >"$paths"
  local -a entries=()
  while IFS= read -r -d '' path; do entries+=("$path"); done <"$paths"
  for path in "${entries[@]}"; do
    if [[ -d "$path" ]]; then
      visit "$path"
      continue
    fi
    relative="${path#"$root"/}"
    [[ -f "$path" && ! -L "$path" && -n "$relative" && "$relative" != "$path" && "$relative" != *$'\n'* ]] || {
      printf 'reviewed SDK tree has an unsafe path or changed entry type\n' >&2
      exit 65
    }
    printf '%s\0%s\0%s\n' \
      "$(/usr/bin/sha256sum "$path" | /usr/bin/cut -d ' ' -f 1)" \
      "$(/usr/bin/stat -c '%s' "$path")" \
      "$relative" >>"$records"
    count=$((count + 1))
  done
}
visit "$root"
[[ "$count" -gt 0 ]] || {
  printf 'reviewed SDK tree is empty\n' >&2
  exit 65
}
printf '%s %s\n' "$(/usr/bin/sha256sum "$records" | /usr/bin/cut -d ' ' -f 1)" "$count"
