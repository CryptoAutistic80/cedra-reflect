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

cd "$repo_root"
printf 'cedra_cli_version=%s\n' "$("$cedra_bin" --version)"
for package in "${packages[@]}"; do
  (
    cd "$package"
    # Concrete publisher addresses are intentionally unavailable before a
    # release is approved. Dev compilation validates the package graph; the
    # source digest below is address-independent and the operator records the
    # final named-address package digest after simulation.
    "$cedra_bin" move compile --dev --skip-fetch-latest-git-deps >/dev/null
    digest="$({ find Move.toml sources tests -type f -print 2>/dev/null || true; } | sort | xargs -r sha256sum | sha256sum | cut -d ' ' -f 1)"
    printf '%s_source_digest=%s\n' "$package" "$digest"
  )
done
