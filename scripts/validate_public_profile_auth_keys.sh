#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

[[ $# -eq 1 ]] || {
  /usr/bin/printf 'usage: %s PUBLIC_PROFILE_EVIDENCE_JSON\n' "$0" >&2
  exit 64
}
profile="$1"
[[ -f "$profile" && ! -L "$profile" ]] || {
  /usr/bin/printf 'public-profile evidence must be a regular non-symlink file\n' >&2
  exit 66
}

for role in core_publisher assets_publisher amm_publisher operations bootstrap_lp; do
  public_key="$(/usr/bin/jq -er --arg role "$role" '.profiles[$role].public_key | select(test("^ed25519-pub-0x[0-9a-f]{64}$"))' "$profile")"
  account="$(/usr/bin/jq -er --arg role "$role" '.profiles[$role].account | select(test("^[0-9a-f]{64}$"))' "$profile")"
  public_key_hex="${public_key#ed25519-pub-0x}"
  derived="$(/usr/bin/printf '%s00' "$public_key_hex" \
    | /usr/bin/xxd -r -p \
    | /usr/bin/openssl dgst -sha3-256 -binary \
    | /usr/bin/xxd -p -c 256)"
  [[ "$derived" == "$account" ]] || {
    /usr/bin/printf 'public profile authentication key mismatch for %s\n' "$role" >&2
    exit 65
  }
done

/usr/bin/jq -cn '{
  all_profile_authentication_keys_match:true,
  derivation_method:"sha3-256(ed25519_public_key_bytes || 0x00)",
  derivation_tool:"OpenSSL dgst -sha3-256"
}'
