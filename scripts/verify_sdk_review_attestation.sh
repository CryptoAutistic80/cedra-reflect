#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s SDK_REVIEW_ATTESTATION_JSON SDK_REVIEW_SIGNATURE TRUSTED_ALLOWED_SIGNERS SDK_REVIEW_PIN_JSON\n' "$0" >&2
  exit 64
}

[[ $# -eq 4 ]] || usage
for input in "$1" "$2" "$3" "$4"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'SDK-review verification inputs must be regular non-symlink files: %s\n' "$input" >&2
    exit 66
  }
done
attestation="$(/usr/bin/readlink -f "$1")"
signature="$(/usr/bin/readlink -f "$2")"
trusted_signers="$(/usr/bin/readlink -f "$3")"
review_pin="$(/usr/bin/readlink -f "$4")"

attestation_sha256="$(/usr/bin/sha256sum "$attestation" | /usr/bin/cut -d ' ' -f 1)"
signature_sha256="$(/usr/bin/sha256sum "$signature" | /usr/bin/cut -d ' ' -f 1)"
trusted_signers_sha256="$(/usr/bin/sha256sum "$trusted_signers" | /usr/bin/cut -d ' ' -f 1)"
review_pin_sha256="$(/usr/bin/sha256sum "$review_pin" | /usr/bin/cut -d ' ' -f 1)"

/usr/bin/jq -e \
  --arg trust "$trusted_signers_sha256" \
  --arg pin "$review_pin_sha256" \
  --arg package_name "$(/usr/bin/jq -er '.package_name' "$review_pin")" \
  --arg package_version "$(/usr/bin/jq -er '.package_version' "$review_pin")" \
  --arg package_tree "$(/usr/bin/jq -er '.sdk_package_tree_sha256' "$review_pin")" \
  --argjson package_files "$(/usr/bin/jq -er '.sdk_package_file_count' "$review_pin")" \
  --arg tarball "$(/usr/bin/jq -er '.npm_tarball_sha256' "$review_pin")" '
  def exact_keys($wanted): (keys | sort) == ($wanted | sort);
  def sha256: type == "string" and test("^[0-9a-f]{64}$");
  exact_keys([
    "decision", "evidence_scope", "independence_statement", "npm_tarball_sha256",
    "review_method", "review_report_reference", "reviewed_at", "reviewer_identity",
    "schema_version", "sdk_package", "sdk_package_file_count", "sdk_package_tree_sha256",
    "sdk_review_pin_file", "sdk_review_pin_sha256", "sdk_version",
    "trusted_allowed_signers_sha256"
  ])
  and .schema_version == 1
  and .evidence_scope == "independent-cedra-sdk-review-attestation"
  and .decision == "approved-for-testnet-candidate-assembly"
  and (.reviewed_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and (.reviewer_identity | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._@+-]{2,127}$"))
  and (.independence_statement | type == "string" and length >= 40)
  and (.review_method | type == "string" and length >= 20)
  and (.review_report_reference | type == "string" and length >= 8)
  and .trusted_allowed_signers_sha256 == $trust
  and .sdk_review_pin_file == "reviewed-cedra-sdk-2.2.8.json"
  and .sdk_review_pin_sha256 == $pin
  and .sdk_package == $package_name
  and .sdk_version == $package_version
  and .sdk_package_tree_sha256 == $package_tree
  and .sdk_package_file_count == $package_files
  and .npm_tarball_sha256 == $tarball
  and (.sdk_review_pin_sha256 | sha256)
  and (.sdk_package_tree_sha256 | sha256)
  and (.npm_tarball_sha256 | sha256)
  and (.trusted_allowed_signers_sha256 | sha256)
' "$attestation" >/dev/null || {
  /usr/bin/printf 'independent SDK-review attestation is invalid or does not bind the reviewed SDK pin and external trust anchor\n' >&2
  exit 65
}

reviewer_identity="$(/usr/bin/jq -er '.reviewer_identity' "$attestation")"
principals="$(/usr/bin/ssh-keygen -Y find-principals -f "$trusted_signers" -n cedra-reflect-sdk-review-v1 -s "$signature" <"$attestation" 2>/dev/null)" || {
  /usr/bin/printf 'SDK-review signature does not authenticate against the external trust anchor\n' >&2
  exit 65
}
[[ "$principals" == "$reviewer_identity" ]] || {
  /usr/bin/printf 'SDK-review signature principal differs from reviewer_identity or is ambiguous\n' >&2
  exit 65
}
/usr/bin/ssh-keygen -Y verify \
  -f "$trusted_signers" \
  -I "$reviewer_identity" \
  -n cedra-reflect-sdk-review-v1 \
  -s "$signature" <"$attestation" >/dev/null 2>&1 || {
  /usr/bin/printf 'independent SDK-review signature verification failed\n' >&2
  exit 65
}

/usr/bin/jq -cn \
  --arg reviewer_identity "$reviewer_identity" \
  --arg attestation_sha256 "$attestation_sha256" \
  --arg signature_sha256 "$signature_sha256" \
  --arg trusted_allowed_signers_sha256 "$trusted_signers_sha256" \
  '{reviewer_identity:$reviewer_identity,attestation_sha256:$attestation_sha256,signature_sha256:$signature_sha256,trusted_allowed_signers_sha256:$trusted_allowed_signers_sha256}'
