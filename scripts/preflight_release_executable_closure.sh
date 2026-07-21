#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s REPOSITORY_ROOT NODE_RUNTIME SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS compiler|validation|execution [REVIEWED_EMITTED_JS_DIRECTORY]\n' "$0" >&2
  exit 64
}

[[ $# -eq 6 || $# -eq 7 ]] || usage
repo_input="$1"
runtime_input="$2"
attestation_input="$3"
signature_input="$4"
trust_input="$5"
phase="$6"
emitted_directory="${7:-}"
[[ "$phase" == compiler || "$phase" == validation || "$phase" == execution ]] || usage
if [[ "$phase" == execution ]]; then
  [[ $# -eq 7 && -d "$emitted_directory" && ! -L "$emitted_directory" ]] || usage
else
  [[ $# -eq 6 ]] || usage
fi
[[ -d "$repo_input" && ! -L "$repo_input" ]] || {
  /usr/bin/printf 'release repository must be a real directory\n' >&2
  exit 66
}
[[ -f "$runtime_input" && ! -L "$runtime_input" && -x "$runtime_input" ]] || {
  /usr/bin/printf 'RELEASE_NODE_RUNTIME must name an executable regular non-symlink file\n' >&2
  exit 66
}
repo="$(/usr/bin/readlink -f "$repo_input")"
runtime="$(/usr/bin/readlink -f "$runtime_input")"
if [[ "$phase" != compiler ]]; then
  [[ "$runtime" == "$repo/"* ]] || {
    /usr/bin/printf 'reviewed Node runtime must reside inside the release repository root\n' >&2
    exit 66
  }
fi
manifest="$repo/ops/evidence/release-executable-closure.json"
review_pin="$repo/ops/evidence/reviewed-cedra-sdk-2.2.8.json"
for input in "$manifest" "$review_pin" "$attestation_input" "$signature_input" "$trust_input"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'release closure input must be a regular non-symlink file: %s\n' "$input" >&2
    exit 66
  }
done

/usr/bin/jq -e '
  def exact_keys($wanted): (keys | sort) == ($wanted | sort);
  def sha256: type == "string" and test("^[0-9a-f]{64}$");
  def tree: exact_keys(["file_count", "path", "sha256"]) and (.path | type == "string" and length > 0) and (.sha256 | sha256) and (.file_count | type == "number" and floor == . and . > 0);
  exact_keys(["dist", "evidence_scope", "node_modules", "node_runtime", "package_json_sha256", "package_lock_sha256", "python_runtime", "release_javascript", "schema_version", "sdk", "typescript"])
  and .schema_version == 1
  and .evidence_scope == "reviewed-release-executable-closure"
  and (.node_runtime | exact_keys(["byte_length", "sha256"]) and (.sha256 | sha256) and (.byte_length | type == "number" and floor == . and . > 0))
  and (.python_runtime | exact_keys(["byte_length", "sha256"]) and (.sha256 | sha256) and (.byte_length | type == "number" and floor == . and . > 0))
  and (.package_json_sha256 | sha256)
  and (.package_lock_sha256 | sha256)
  and (.node_modules | tree and .path == "node_modules")
  and (.typescript | tree and .path == "node_modules/typescript")
  and (.sdk | tree and .path == "node_modules/@cedra-labs/ts-sdk")
  and (.dist | tree and .path == "fresh-private-tsc-outdir")
  and (.release_javascript | exact_keys(["bcs_validator_sha256", "rename_noreplace_helper_sha256", "typescript_bin_sha256", "typescript_compiler_sha256"]))
  and all(.release_javascript[]; sha256)
' "$manifest" >/dev/null || {
  /usr/bin/printf 'release executable-closure manifest is invalid\n' >&2
  exit 65
}

assert_file_digest() {
  local path="$1" expected="$2" label="$3"
  [[ -f "$path" && ! -L "$path" ]] || {
    /usr/bin/printf '%s is not a regular non-symlink file\n' "$label" >&2
    exit 65
  }
  [[ "$(/usr/bin/sha256sum "$path" | /usr/bin/cut -d ' ' -f 1)" == "$expected" ]] || {
    /usr/bin/printf '%s digest differs from the reviewed executable closure\n' "$label" >&2
    exit 65
  }
}

assert_tree() {
  local key="$1" path expected_digest expected_count observed_digest observed_count
  path="$(/usr/bin/jq -er --arg key "$key" '.[$key].path' "$manifest")"
  expected_digest="$(/usr/bin/jq -er --arg key "$key" '.[$key].sha256' "$manifest")"
  expected_count="$(/usr/bin/jq -er --arg key "$key" '.[$key].file_count' "$manifest")"
  builtin read -r observed_digest observed_count < <(
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
      /usr/bin/bash --noprofile --norc "$repo/scripts/release_tree_digest.sh" "$repo/$path"
  )
  [[ "$observed_digest" == "$expected_digest" && "$observed_count" == "$expected_count" ]] || {
    /usr/bin/printf '%s tree differs from the reviewed executable closure\n' "$key" >&2
    exit 65
  }
}

assert_file_digest "$runtime" "$(/usr/bin/jq -er '.node_runtime.sha256' "$manifest")" 'Node.js runtime'
[[ "$(/usr/bin/stat -c '%s' "$runtime")" == "$(/usr/bin/jq -er '.node_runtime.byte_length' "$manifest")" ]] || {
  /usr/bin/printf 'Node.js runtime byte length differs from the reviewed executable closure\n' >&2
  exit 65
}
python_runtime="$(/usr/bin/readlink -f /usr/bin/python3)"
assert_file_digest "$python_runtime" "$(/usr/bin/jq -er '.python_runtime.sha256' "$manifest")" 'Python no-replace runtime'
[[ "$(/usr/bin/stat -c '%s' "$python_runtime")" == "$(/usr/bin/jq -er '.python_runtime.byte_length' "$manifest")" ]] || {
  /usr/bin/printf 'Python runtime byte length differs from the reviewed executable closure\n' >&2
  exit 65
}
assert_file_digest "$repo/package.json" "$(/usr/bin/jq -er '.package_json_sha256' "$manifest")" 'package.json'
assert_file_digest "$repo/package-lock.json" "$(/usr/bin/jq -er '.package_lock_sha256' "$manifest")" 'package-lock.json'
assert_tree node_modules
assert_tree typescript
assert_tree sdk
builtin read -r reviewed_sdk_sha reviewed_sdk_count < <(
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
    /usr/bin/bash --noprofile --norc "$repo/scripts/sdk_review_tree_digest.sh" "$repo/node_modules/@cedra-labs/ts-sdk"
)
[[ "$reviewed_sdk_sha" == "$(/usr/bin/jq -er '.sdk_package_tree_sha256' "$review_pin")" \
  && "$reviewed_sdk_count" == "$(/usr/bin/jq -er '.sdk_package_file_count' "$review_pin")" ]] || {
  /usr/bin/printf 'installed Cedra SDK differs from the independently reviewable SDK pin\n' >&2
  exit 65
}
assert_file_digest "$repo/node_modules/typescript/bin/tsc" "$(/usr/bin/jq -er '.release_javascript.typescript_bin_sha256' "$manifest")" 'TypeScript launcher'
assert_file_digest "$repo/node_modules/typescript/lib/tsc.js" "$(/usr/bin/jq -er '.release_javascript.typescript_compiler_sha256' "$manifest")" 'TypeScript compiler'
assert_file_digest "$repo/scripts/validate_release_transaction_bcs.mjs" "$(/usr/bin/jq -er '.release_javascript.bcs_validator_sha256' "$manifest")" 'Cedra BCS validator'
assert_file_digest "$repo/scripts/rename_noreplace.py" "$(/usr/bin/jq -er '.release_javascript.rename_noreplace_helper_sha256' "$manifest")" 'kernel no-replace publication helper'

/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/bash --noprofile --norc "$repo/scripts/verify_sdk_review_attestation.sh" \
  "$attestation_input" "$signature_input" "$trust_input" "$review_pin" >/dev/null

if [[ "$phase" == execution ]]; then
  emitted="$(/usr/bin/readlink -f "$emitted_directory")"
  [[ "$emitted" == "$repo/"* ]] || {
    /usr/bin/printf 'reviewed emitted JavaScript must reside inside the release repository root\n' >&2
    exit 65
  }
  emitted_mode="$(/usr/bin/stat -c '%a' "$emitted")"
  emitted_owner="$(/usr/bin/stat -c '%u' "$emitted")"
  [[ "$emitted_owner" == 0 && $((8#$emitted_mode & 8#022)) -eq 0 \
    && -z "$(/usr/bin/find "$emitted" -mindepth 1 -type l -print -quit)" ]] || {
    /usr/bin/printf 'reviewed emitted-JS directory must be root-owned, non-writable by group/other, and contain no symbolic links\n' >&2
    exit 65
  }
  builtin read -r emitted_sha emitted_count < <(
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
      /usr/bin/bash --noprofile --norc "$repo/scripts/release_tree_digest.sh" "$emitted"
  )
  [[ "$emitted_sha" == "$(/usr/bin/jq -er '.dist.sha256' "$manifest")" \
    && "$emitted_count" == "$(/usr/bin/jq -er '.dist.file_count' "$manifest")" ]] || {
    /usr/bin/printf 'reviewed emitted JavaScript differs from the reviewed executable closure\n' >&2
    exit 65
  }
  [[ -f "$emitted/scripts/assemble-testnet-transaction-candidate.js" \
    && ! -L "$emitted/scripts/assemble-testnet-transaction-candidate.js" ]] || {
    /usr/bin/printf 'reviewed emitted candidate assembler entrypoint is absent\n' >&2
    exit 65
  }
fi

/usr/bin/printf 'release executable closure verified for %s phase with explicit runtime %s\n' "$phase" "$runtime"
