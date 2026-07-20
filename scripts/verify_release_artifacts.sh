#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cedra_bin="${CEDRA_BIN:-cedra}"
packages=(
  "move/hook-probe"
  "move/reflection-core"
  "move/test-assets"
  "move/test-amm"
  "move/integration-tests"
)
max_publish_package_size=65536

cd "$repo_root"
printf 'cedra_cli_version=%s\n' "$("$cedra_bin" --version)"
for package in "${packages[@]}"; do
  (
    cd "$package"
    if [[ "$package" == "move/reflection-core" || "$package" == "move/test-assets" || "$package" == "move/test-amm" ]]; then
      grep -Fq 'upgrade_policy = "immutable"' Move.toml || {
        printf 'release package is not immutable: %s\n' "$package" >&2
        exit 1
      }
    fi
    # Concrete publisher addresses are intentionally unavailable before a
    # release is approved. Dev compilation validates the package graph; the
    # source digest below is address-independent and the operator records the
    # final named-address package digest after simulation.
    compile_args=(move compile --dev --skip-fetch-latest-git-deps)
    if [[ "$package" != "move/integration-tests" ]]; then
      compile_args+=(--save-metadata --included-artifacts sparse)
    fi
    "$cedra_bin" "${compile_args[@]}" >/dev/null
    digest="$({ find Move.toml sources tests -type f -print 2>/dev/null || true; } | sort | xargs -r sha256sum | sha256sum | cut -d ' ' -f 1)"
    printf '%s_source_digest=%s\n' "$package" "$digest"
    if [[ "$package" != "move/integration-tests" ]]; then
      metadata_file="$(find build -mindepth 2 -maxdepth 2 -type f -name package-metadata.bcs -print -quit)"
      if [[ -z "$metadata_file" ]]; then
        printf 'missing sparse package metadata for %s\n' "$package" >&2
        exit 1
      fi
      bytecode_dir="${metadata_file%/package-metadata.bcs}/bytecode_modules"
      bytecode_bytes="$(find "$bytecode_dir" -maxdepth 1 -type f -name '*.mv' -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')"
      metadata_bytes="$(stat -c '%s' "$metadata_file")"
      publish_payload_bytes=$((bytecode_bytes + metadata_bytes))
      printf '%s_publish_payload_components_bytes=%s\n' "$package" "$publish_payload_bytes"
      if (( publish_payload_bytes > max_publish_package_size )); then
        printf '%s exceeds the normal %s-byte publish boundary; obtain the official Testnet large-package route before proceeding\n' \
          "$package" "$max_publish_package_size" >&2
        exit 1
      fi
    fi
  )
done
