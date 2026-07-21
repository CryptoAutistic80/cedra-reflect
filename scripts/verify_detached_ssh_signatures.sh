#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s APPROVAL_ENVELOPE_JSON TRUSTED_ALLOWED_SIGNERS_FILE\n' "$0" >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
envelope="$(/usr/bin/readlink -f "$1")"
trusted_allowed_signers="$(/usr/bin/readlink -f "$2")"
[[ -f "$envelope" && ! -L "$envelope" && -f "$trusted_allowed_signers" && ! -L "$trusted_allowed_signers" ]] || {
  /usr/bin/printf 'approval envelope and trust anchor must be regular non-symlink files\n' >&2
  exit 66
}
envelope_directory="$(/usr/bin/dirname "$envelope")"
/usr/bin/jq -e '
  .signature_namespace == "cedra-reflect-testnet-release-v2"
  and (.statement_file | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))
  and (.statement_sha256 | type == "string" and test("^[0-9a-f]{64}$"))
  and (.trusted_allowed_signers_sha256 | type == "string" and test("^[0-9a-f]{64}$"))
  and (.approvals | type == "array" and length == 1)
  and all(.approvals[];
    (keys | sort) == (["identity", "key_fingerprint", "signature_file", "signature_sha256"] | sort)
    and (.identity | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$"))
    and (.key_fingerprint | type == "string" and test("^SHA256:[A-Za-z0-9+/=]{43,44}$"))
    and (.signature_file | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))
    and (.signature_sha256 | type == "string" and test("^[0-9a-f]{64}$")))
  and ([.approvals[].identity] | unique | length == 1)
  and ([.approvals[].key_fingerprint] | unique | length == 1)
  and ([.approvals[].signature_file] | unique | length == 1)
' "$envelope" >/dev/null || {
  /usr/bin/printf 'detached signature envelope identity/key/file structure is invalid\n' >&2
  exit 65
}
[[ "$(/usr/bin/sha256sum "$trusted_allowed_signers" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.trusted_allowed_signers_sha256' "$envelope")" ]] || {
  /usr/bin/printf 'detached signature trust-anchor digest mismatch\n' >&2
  exit 65
}
statement_name="$(/usr/bin/jq -r '.statement_file' "$envelope")"
statement_file="$envelope_directory/$statement_name"
[[ -f "$statement_file" && ! -L "$statement_file" \
  && "$(/usr/bin/sha256sum "$statement_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r '.statement_sha256' "$envelope")" ]] || {
  /usr/bin/printf 'detached signature statement file/digest mismatch\n' >&2
  exit 65
}
namespace="$(/usr/bin/jq -r '.signature_namespace' "$envelope")"
verified_fingerprints=()
for index in 0; do
  identity="$(/usr/bin/jq -r ".approvals[$index].identity" "$envelope")"
  expected_fingerprint="$(/usr/bin/jq -r ".approvals[$index].key_fingerprint" "$envelope")"
  signature_name="$(/usr/bin/jq -r ".approvals[$index].signature_file" "$envelope")"
  signature_file="$envelope_directory/$signature_name"
  [[ -f "$signature_file" && ! -L "$signature_file" \
    && "$(/usr/bin/sha256sum "$signature_file" | /usr/bin/cut -d ' ' -f 1)" == "$(/usr/bin/jq -r ".approvals[$index].signature_sha256" "$envelope")" ]] || {
    /usr/bin/printf 'detached signature file/digest mismatch for identity: %s\n' "$identity" >&2
    exit 65
  }
  verification_output="$(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C /usr/bin/ssh-keygen -Y verify \
    -f "$trusted_allowed_signers" \
    -I "$identity" \
    -n "$namespace" \
    -s "$signature_file" <"$statement_file" 2>&1)" || {
      /usr/bin/printf 'detached release approval failed cryptographic verification for identity: %s\n' "$identity" >&2
      exit 65
    }
  verified_fingerprint="$(/usr/bin/sed -n 's/.* key \(SHA256:[A-Za-z0-9+/=]*\)$/\1/p' <<<"$verification_output" | /usr/bin/tail -n 1)"
  [[ -n "$verified_fingerprint" && "$verified_fingerprint" == "$expected_fingerprint" ]] || {
    /usr/bin/printf 'verified signing-key fingerprint does not match the approval envelope for identity: %s\n' "$identity" >&2
    exit 65
  }
  verified_fingerprints+=("$verified_fingerprint")
done

/usr/bin/printf 'one detached operator identity and OpenSSH signing-key fingerprint verified\n'
