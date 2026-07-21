#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

[[ $# -eq 1 ]] || {
  printf 'usage: %s DIRECTORY\n' "$0" >&2
  exit 64
}
[[ -d "$1" && ! -L "$1" ]] || {
  printf 'tree digest root must be a real directory\n' >&2
  exit 66
}
root="$(/usr/bin/readlink -f "$1")"
records="$(/usr/bin/mktemp /tmp/cedra-release-tree-records.XXXXXX)"
paths="$(/usr/bin/mktemp /tmp/cedra-release-tree-paths.XXXXXX)"
cleanup() {
  /usr/bin/rm -f -- "$records" "$paths"
}
trap cleanup EXIT

unsupported="$(/usr/bin/find "$root" -mindepth 1 ! -type d ! -type f ! -type l -print -quit)"
[[ -z "$unsupported" ]] || {
  printf 'tree contains an unsupported filesystem entry: %s\n' "$unsupported" >&2
  exit 65
}
/usr/bin/find "$root" -mindepth 1 \( -type f -o -type l \) -print0 | /usr/bin/sort -z >"$paths"

entries=0
while IFS= read -r -d '' path; do
  relative="${path#"$root"/}"
  [[ -n "$relative" && "$relative" != "$path" && "$relative" != *$'\n'* && "$relative" != *$'\t'* ]] || {
    printf 'tree contains an unsafe relative path\n' >&2
    exit 65
  }
  if [[ -L "$path" ]]; then
    target="$(/usr/bin/readlink "$path")"
    resolved="$(/usr/bin/readlink -f "$path")"
    [[ "$resolved" == "$root/"* && -f "$resolved" ]] || {
      printf 'tree symbolic link escapes the root or does not resolve to a file: %s\n' "$relative" >&2
      exit 65
    }
    target_sha="$(printf '%s' "$target" | /usr/bin/sha256sum | /usr/bin/cut -d ' ' -f 1)"
    target_bytes="$(printf '%s' "$target" | /usr/bin/wc -c | /usr/bin/awk '{print $1}')"
    printf 'L\0%s\0%s\0%s\0%s\n' "$target_sha" "$target_bytes" "$relative" "$target" >>"$records"
  else
    [[ -f "$path" ]] || {
      printf 'tree file changed type while hashing: %s\n' "$relative" >&2
      exit 65
    }
    file_sha="$(/usr/bin/sha256sum "$path" | /usr/bin/cut -d ' ' -f 1)"
    file_bytes="$(/usr/bin/stat -c '%s' "$path")"
    printf 'F\0%s\0%s\0%s\n' "$file_sha" "$file_bytes" "$relative" >>"$records"
  fi
  entries=$((entries + 1))
done <"$paths"
[[ "$entries" -gt 0 ]] || {
  printf 'tree digest root is empty\n' >&2
  exit 65
}
digest="$(/usr/bin/sha256sum "$records" | /usr/bin/cut -d ' ' -f 1)"
printf '%s %s\n' "$digest" "$entries"
