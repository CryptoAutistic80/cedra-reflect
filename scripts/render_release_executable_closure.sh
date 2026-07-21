#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
umask 077

[[ $# -eq 2 ]] || {
  printf 'usage: %s REPOSITORY_ROOT REVIEWED_NODE_RUNTIME\n' "$0" >&2
  exit 64
}
[[ -d "$1" && ! -L "$1" && -f "$2" && ! -L "$2" && -x "$2" ]] || {
  printf 'closure rendering requires a real repository and explicit executable Node.js runtime\n' >&2
  exit 66
}
repo="$(/usr/bin/readlink -f "$1")"
runtime="$(/usr/bin/readlink -f "$2")"
for path in \
  "$repo/package.json" \
  "$repo/package-lock.json" \
  "$repo/node_modules/typescript/bin/tsc" \
  "$repo/node_modules/typescript/lib/tsc.js" \
  "$repo/scripts/validate_release_transaction_bcs.mjs" \
  "$repo/scripts/rename_noreplace.py"; do
  [[ -f "$path" && ! -L "$path" ]] || {
    printf 'closure component is absent or not a regular file: %s\n' "$path" >&2
    exit 66
  }
done
python_runtime="$(/usr/bin/readlink -f /usr/bin/python3)"
[[ -f "$python_runtime" && ! -L "$python_runtime" && -x "$python_runtime" ]] || {
  printf 'fixed Python runtime for no-replace publication is unavailable\n' >&2
  exit 66
}

/usr/bin/mkdir -p -m 0700 "$repo/ops/local"
[[ "$(/usr/bin/stat -c '%u' "$repo/ops/local")" == "$(/usr/bin/id -u)" \
  && $((8#$(/usr/bin/stat -c '%a' "$repo/ops/local") & 8#022)) -eq 0 ]] || {
  printf 'ops/local must be current-euid owned and not group/world-writable for deterministic closure rendering\n' >&2
  exit 66
}
emitted="$(/usr/bin/mktemp -d "$repo/ops/local/.cedra-closure-render.XXXXXX")"
cleanup() {
  [[ "$emitted" == "$repo"/ops/local/.cedra-closure-render.* ]] && /usr/bin/rm -rf -- "$emitted"
}
trap cleanup EXIT
/usr/bin/chmod 0700 "$emitted"
/usr/bin/env -i LC_ALL=C LANG=C PATH=/usr/bin:/bin TMPDIR=/tmp \
  "$runtime" "$repo/node_modules/typescript/bin/tsc" -p "$repo/tsconfig.json" --outDir "$emitted"
[[ -z "$(/usr/bin/find "$emitted" -mindepth 1 -type l -print -quit)" ]] || {
  printf 'fresh TypeScript output unexpectedly contains a symbolic link\n' >&2
  exit 65
}

read -r node_modules_sha node_modules_count < <(/usr/bin/bash "$repo/scripts/release_tree_digest.sh" "$repo/node_modules")
read -r typescript_sha typescript_count < <(/usr/bin/bash "$repo/scripts/release_tree_digest.sh" "$repo/node_modules/typescript")
read -r sdk_sha sdk_count < <(/usr/bin/bash "$repo/scripts/release_tree_digest.sh" "$repo/node_modules/@cedra-labs/ts-sdk")
read -r dist_sha dist_count < <(/usr/bin/bash "$repo/scripts/release_tree_digest.sh" "$emitted")

/usr/bin/jq -nS \
  --arg runtime_sha "$(/usr/bin/sha256sum "$runtime" | /usr/bin/cut -d ' ' -f 1)" \
  --argjson runtime_bytes "$(/usr/bin/stat -c '%s' "$runtime")" \
  --arg python_runtime_sha "$(/usr/bin/sha256sum "$python_runtime" | /usr/bin/cut -d ' ' -f 1)" \
  --argjson python_runtime_bytes "$(/usr/bin/stat -c '%s' "$python_runtime")" \
  --arg package_json_sha "$(/usr/bin/sha256sum "$repo/package.json" | /usr/bin/cut -d ' ' -f 1)" \
  --arg package_lock_sha "$(/usr/bin/sha256sum "$repo/package-lock.json" | /usr/bin/cut -d ' ' -f 1)" \
  --arg node_modules_sha "$node_modules_sha" \
  --argjson node_modules_count "$node_modules_count" \
  --arg typescript_sha "$typescript_sha" \
  --argjson typescript_count "$typescript_count" \
  --arg sdk_sha "$sdk_sha" \
  --argjson sdk_count "$sdk_count" \
  --arg dist_sha "$dist_sha" \
  --argjson dist_count "$dist_count" \
  --arg typescript_bin_sha "$(/usr/bin/sha256sum "$repo/node_modules/typescript/bin/tsc" | /usr/bin/cut -d ' ' -f 1)" \
  --arg typescript_compiler_sha "$(/usr/bin/sha256sum "$repo/node_modules/typescript/lib/tsc.js" | /usr/bin/cut -d ' ' -f 1)" \
  --arg bcs_validator_sha "$(/usr/bin/sha256sum "$repo/scripts/validate_release_transaction_bcs.mjs" | /usr/bin/cut -d ' ' -f 1)" \
  --arg rename_noreplace_sha "$(/usr/bin/sha256sum "$repo/scripts/rename_noreplace.py" | /usr/bin/cut -d ' ' -f 1)" \
  '{
    schema_version:1,
    evidence_scope:"reviewed-release-executable-closure",
    node_runtime:{sha256:$runtime_sha,byte_length:$runtime_bytes},
    python_runtime:{sha256:$python_runtime_sha,byte_length:$python_runtime_bytes},
    package_json_sha256:$package_json_sha,
    package_lock_sha256:$package_lock_sha,
    node_modules:{path:"node_modules",sha256:$node_modules_sha,file_count:$node_modules_count},
    typescript:{path:"node_modules/typescript",sha256:$typescript_sha,file_count:$typescript_count},
    sdk:{path:"node_modules/@cedra-labs/ts-sdk",sha256:$sdk_sha,file_count:$sdk_count},
    dist:{path:"fresh-private-tsc-outdir",sha256:$dist_sha,file_count:$dist_count},
    release_javascript:{
      typescript_bin_sha256:$typescript_bin_sha,
      typescript_compiler_sha256:$typescript_compiler_sha,
      bcs_validator_sha256:$bcs_validator_sha,
      rename_noreplace_helper_sha256:$rename_noreplace_sha
    }
  }'
