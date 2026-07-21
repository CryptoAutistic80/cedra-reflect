#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

usage() {
  printf 'usage: %s PUBLIC_ROLE_CANDIDATE_JSON CONFIG_WORKING_DIRECTORY OUTPUT_DIRECTORY\n' "$0" >&2
  printf 'runs only: cedra config show-profiles --profile NAME (public information)\n' >&2
  exit 64
}

[[ $# -eq 3 ]] || usage
umask 077
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
role_file="$(readlink -f "$1")"
config_working_directory="$(readlink -f "$2")"
output_directory="$3"
cedra_bin="${CEDRA_BIN:-/usr/bin/cedra}"
validator="$repo_root/scripts/validate_release_evidence.sh"
auth_key_validator="$repo_root/scripts/validate_public_profile_auth_keys.sh"

for command_name in jq sha256sum stat git; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'required command is unavailable: %s\n' "$command_name" >&2
    exit 69
  }
done
[[ -x "$cedra_bin" && -d "$config_working_directory" ]] || {
  printf 'Cedra CLI or explicit config working directory is unavailable\n' >&2
  exit 66
}
[[ -f "$auth_key_validator" ]] || {
  printf 'Cedra Ed25519 public authentication-key validator is required\n' >&2
  exit 69
}
bash "$validator" "$role_file" >/dev/null

config_directory="$config_working_directory/.cedra"
config_file="$config_directory/config.yaml"
[[ -d "$config_directory" && -f "$config_file" && ! -L "$config_directory" && ! -L "$config_file" ]] || {
  printf 'explicit config working directory has no regular .cedra/config.yaml: %s\n' "$config_working_directory" >&2
  exit 66
}
config_directory_mode="$(stat -c '%a' "$config_directory")"
config_file_mode="$(stat -c '%a' "$config_file")"
[[ "$config_directory_mode" == 700 && "$config_file_mode" == 600 ]] || {
  printf 'Cedra config permissions must be exactly 0700/0600, observed %s/%s\n' "$config_directory_mode" "$config_file_mode" >&2
  exit 65
}

if [[ -e "$output_directory" ]]; then
  [[ -d "$output_directory" && -z "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    printf 'output directory must not exist or must be empty: %s\n' "$output_directory" >&2
    exit 66
  }
else
  mkdir -p "$output_directory"
fi
output_directory="$(cd "$output_directory" && pwd)"
if [[ "$output_directory" == "$repo_root" || "$output_directory" == "$repo_root/"* ]]; then
  git -C "$repo_root" check-ignore -q "$output_directory" || {
    printf 'in-repository profile evidence output must be ignored: %s\n' "$output_directory" >&2
    exit 66
  }
fi

profiles_json='{}'
for role_key in core_publisher assets_publisher amm_publisher operations bootstrap_lp; do
  profile_name="$(jq -er --arg role "$role_key" '.roles[$role].profile_name' "$role_file")"
  expected_address="$(jq -er --arg role "$role_key" '.roles[$role].address' "$role_file")"
  [[ "$profile_name" =~ ^cedra-reflect-[a-z0-9-]+$ ]] || {
    printf 'unsafe profile name in role candidate: %s\n' "$profile_name" >&2
    exit 65
  }
  raw_output="$output_directory/.profile-$role_key.json"
  (
    cd "$config_working_directory"
    "$cedra_bin" config show-profiles --profile "$profile_name"
  ) >"$raw_output"
  jq -e --arg profile "$profile_name" --arg expected "${expected_address#0x}" '
    keys == ["Result"]
    and (.Result | keys == [$profile])
    and (.Result[$profile] | keys == ["account", "faucet_url", "has_private_key", "network", "public_key", "rest_url"])
    and .Result[$profile].network == "Testnet"
    and .Result[$profile].has_private_key == true
    and (.Result[$profile].public_key | type == "string" and test("^ed25519-pub-0x[0-9a-f]{64}$"))
    and .Result[$profile].account == $expected
    and (.Result[$profile].account | test("^[0-9a-f]{64}$"))
    and .Result[$profile].rest_url == "https://testnet.cedra.dev"
    and .Result[$profile].faucet_url == "https://faucet-api.cedra.dev"
  ' "$raw_output" >/dev/null || {
    printf 'public Cedra profile output is unexpected or does not match role %s\n' "$role_key" >&2
    exit 65
  }
  public_profile="$(jq -c --arg profile "$profile_name" '.Result[$profile]' "$raw_output")"
  profiles_json="$(jq -cn --argjson profiles "$profiles_json" --arg role "$role_key" --arg profile "$profile_name" --argjson public "$public_profile" '$profiles + {($role):({profile_name:$profile} + $public)}')"
  rm -- "$raw_output"
done

generated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
role_file_sha256="$(sha256sum "$role_file" | cut -d ' ' -f 1)"
cedra_cli_path="$(readlink -f "$cedra_bin")"
jq -n \
  --arg generated_at "$generated_at" \
  --arg config_working_directory "$config_working_directory" \
  --arg config_directory_mode "0$config_directory_mode" \
  --arg config_file_mode "0$config_file_mode" \
  --arg role_file_sha256 "$role_file_sha256" \
  --arg cedra_cli_path "$cedra_cli_path" \
  --arg cedra_cli_version "$($cedra_bin --version)" \
  --arg cedra_cli_sha256 "$(sha256sum "$cedra_cli_path" | cut -d ' ' -f 1)" \
  --argjson profiles "$profiles_json" \
  '{
    schema_version:1,
    evidence_scope:"local-public-profile-preflight",
    generated_at:$generated_at,
    network_intent:"cedra-testnet",
    config_working_directory:$config_working_directory,
    config_directory_mode:$config_directory_mode,
    config_file_mode:$config_file_mode,
    public_role_candidate_sha256:$role_file_sha256,
    toolchain:{cedra_cli_path:$cedra_cli_path,cedra_cli_version:$cedra_cli_version,cedra_cli_sha256:$cedra_cli_sha256},
    profiles:$profiles,
    evidence_boundaries:{
      public_profile_state_read:true,
      private_key_values_read:false,
      network_state_observed:false,
      accounts_funded:false,
      transaction_built:false,
      transaction_signed:false,
      transaction_submitted:false
    }
  }' >"$output_directory/public-profile-evidence.json"

authentication_key_validation="$(/usr/bin/bash "$auth_key_validator" "$output_directory/public-profile-evidence.json")"
jq --argjson validation "$authentication_key_validation" \
  '. + {authentication_key_validation:$validation}' \
  "$output_directory/public-profile-evidence.json" >"$output_directory/.public-profile-evidence.json"
mv "$output_directory/.public-profile-evidence.json" "$output_directory/public-profile-evidence.json"

bash "$validator" "$output_directory/public-profile-evidence.json"
printf 'public-only Cedra profile evidence: %s\n' "$output_directory/public-profile-evidence.json"
printf 'no private key value was requested, printed, copied, or hashed\n'
