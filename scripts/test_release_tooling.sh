#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-}"
if [[ -z "$node_bin" ]]; then node_bin="$(type -P node || true)"; fi
if [[ -z "$node_bin" && -x /home/james/.nvm/versions/node/v24.11.1/bin/node ]]; then
  node_bin=/home/james/.nvm/versions/node/v24.11.1/bin/node
fi
for command_name in python3 jq ssh-keygen sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'release-tooling test dependency is unavailable: %s\n' "$command_name" >&2
    exit 69
  }
done
[[ -x "$node_bin" ]] || {
  printf 'release-tooling tests require Node.js\n' >&2
  exit 69
}

test_root="$(mktemp -d /tmp/cedra-release-tooling-test.XXXXXX)"
[[ "$test_root" == /tmp/cedra-release-tooling-test.* ]] || exit 70
cleanup() {
  [[ "$test_root" == /tmp/cedra-release-tooling-test.* ]] || return 1
  rm -rf -- "$test_root"
}
trap cleanup EXIT

# Central release checkout check must bind the live clean HEAD and tree, not a
# stale status captured by a candidate builder.
live_repo="$test_root/live-check-repository"
mkdir -m 0700 "$live_repo"
/usr/bin/git -C "$live_repo" init -q
/usr/bin/git -C "$live_repo" config user.name 'Release Tooling Test'
/usr/bin/git -C "$live_repo" config user.email 'release-tooling-test@example.invalid'
printf 'reviewed\n' >"$live_repo/source.txt"
/usr/bin/git -C "$live_repo" add source.txt
/usr/bin/git -C "$live_repo" commit -qm 'reviewed fixture'
live_commit="$(/usr/bin/git -C "$live_repo" rev-parse HEAD)"
live_tree="$(/usr/bin/git -C "$live_repo" rev-parse 'HEAD^{tree}')"
jq -n --arg commit "$live_commit" --arg tree "$live_tree" \
  '{schema_version:3,evidence_scope:"local-exact-address-build-only",working_tree_clean:true,application_commit:$commit,application_tree:$tree}' \
  >"$test_root/live-exact.json"
jq -n --arg commit "$live_commit" --arg tree "$live_tree" \
  '{application_commit:$commit,build_environment:{repository_head_commit:$commit,repository_head_tree:$tree}}' \
  >"$test_root/live-candidate.json"
checkout_component="$repo_root/scripts/validate_live_release_checkout_component.sh"
bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null
/usr/bin/git -C "$live_repo" worktree add -q --detach "$test_root/linked-worktree" "$live_commit"
if bash "$checkout_component" \
  "$test_root/linked-worktree" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'checkout component accepted a linked worktree with Git metadata outside the release root\n' >&2
  exit 1
fi
/usr/bin/git -C "$live_repo" worktree remove --force "$test_root/linked-worktree"
if bash "$repo_root/scripts/validate_live_release_checkout.sh" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'production checkout wrapper accepted a current-uid-owned developer checkout\n' >&2
  exit 1
fi
/usr/bin/git -C "$live_repo" update-index --assume-unchanged source.txt
printf 'hidden-assume-unchanged\n' >"$live_repo/source.txt"
if bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'checkout component accepted assume-unchanged tracked bytes\n' >&2
  exit 1
fi
/usr/bin/git -C "$live_repo" update-index --no-assume-unchanged source.txt
/usr/bin/git -C "$live_repo" restore source.txt
/usr/bin/git -C "$live_repo" update-index --skip-worktree source.txt
if bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'checkout component accepted a skip-worktree index flag\n' >&2
  exit 1
fi
/usr/bin/git -C "$live_repo" update-index --no-skip-worktree source.txt
/usr/bin/printf '#!/usr/bin/bash\n/usr/bin/printf "test-token\\n"\n' >"$test_root/fsmonitor-hook"
/usr/bin/chmod 0700 "$test_root/fsmonitor-hook"
/usr/bin/git -C "$live_repo" config core.fsmonitor "$test_root/fsmonitor-hook"
/usr/bin/git -C "$live_repo" update-index --fsmonitor
/usr/bin/git -C "$live_repo" update-index --fsmonitor-valid source.txt
if bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'checkout component accepted an fsmonitor-valid index flag\n' >&2
  exit 1
fi
/usr/bin/git -C "$live_repo" update-index --no-fsmonitor-valid source.txt
/usr/bin/git -C "$live_repo" update-index --no-fsmonitor 2>/dev/null
/usr/bin/git -C "$live_repo" config --unset core.fsmonitor
/usr/bin/git -C "$live_repo" config core.fileMode false
chmod 0755 "$live_repo/source.txt"
if bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'checkout component accepted a tracked executable-mode mismatch\n' >&2
  exit 1
fi
chmod 0644 "$live_repo/source.txt"
/usr/bin/git -C "$live_repo" config core.fileMode true
printf 'dirty\n' >>"$live_repo/source.txt"
if bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'central live checkout check accepted dirty tracked content\n' >&2
  exit 1
fi
/usr/bin/git -C "$live_repo" restore source.txt
printf 'untracked\n' >"$live_repo/untracked.txt"
if bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'central live checkout check accepted an untracked file\n' >&2
  exit 1
fi
rm "$live_repo/untracked.txt"
printf 'next\n' >>"$live_repo/source.txt"
/usr/bin/git -C "$live_repo" add source.txt
/usr/bin/git -C "$live_repo" commit -qm 'different head fixture'
if bash "$checkout_component" \
  "$live_repo" "$test_root/live-candidate.json" "$test_root/live-exact.json" >/dev/null 2>&1; then
  printf 'central live checkout check accepted a different live HEAD/tree\n' >&2
  exit 1
fi

# Snapshotting captures one private immutable input view. Later source swaps do
# not alter validated bytes, and symbolic-link input trees are rejected.
mkdir -m 0700 "$test_root/snapshot-source"
printf 'before-swap\n' >"$test_root/snapshot-source/input.json"
python3 "$repo_root/scripts/snapshot_release_inputs.py" "$test_root/snapshot" \
  "release=$test_root/snapshot-source"
printf 'after-swap\n' >"$test_root/snapshot-source/input.json"
[[ "$(<"$test_root/snapshot/release/input.json")" == before-swap \
  && "$(stat -c '%a' "$test_root/snapshot")" == 700 \
  && "$(stat -c '%a' "$test_root/snapshot/release/input.json")" == 600 ]] || {
  printf 'private release snapshot changed after its source was swapped\n' >&2
  exit 1
}
ln -s input.json "$test_root/snapshot-source/link.json"
if python3 "$repo_root/scripts/snapshot_release_inputs.py" "$test_root/snapshot-symlink" \
  "release=$test_root/snapshot-source" >/dev/null 2>&1; then
  printf 'release snapshot accepted a symbolic link\n' >&2
  exit 1
fi

# A deterministic read-time growth injection must be detected and the partial
# destination removed. This exercises the post-bound extra-byte and fstat gate.
python3 - "$repo_root/scripts/snapshot_release_inputs.py" "$test_root" <<'PY'
import importlib.util
import os
import sys
from pathlib import Path

module_path = Path(sys.argv[1])
root = Path(sys.argv[2])
source = root / "snapshot-growth-source.bin"
destination = root / "snapshot-growth-destination"
source.write_bytes(b"a" * 4096)
spec = importlib.util.spec_from_file_location("snapshot_release_inputs_test", module_path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
original_read = module.os.read
source_identity = os.stat(source).st_ino
injected = False

def growing_read(descriptor: int, size: int) -> bytes:
    global injected
    data = original_read(descriptor, size)
    if not injected and os.fstat(descriptor).st_ino == source_identity:
        injected = True
        with source.open("ab") as handle:
            handle.write(b"attacker-growth")
    return data

module.os.read = growing_read
sys.argv = [str(module_path), str(destination), f"input={source}"]
try:
    module.main()
except SystemExit as exc:
    if "grew while being read" not in str(exc) and "changed while being read" not in str(exc):
        raise
else:
    raise AssertionError("concurrent source growth was accepted")
if destination.exists() or destination.is_symlink():
    raise AssertionError("failed concurrent-growth snapshot left a partial destination")
PY

python3 -m py_compile \
  "$repo_root/scripts/release_evidence.py" \
  "$repo_root/scripts/decode_package_metadata_header.py" \
  "$repo_root/scripts/rename_noreplace.py" \
  "$repo_root/scripts/snapshot_release_inputs.py" \
  "$repo_root/scripts/validate_isolated_release_root.py" \
  "$repo_root/scripts/render_approval_statement_secure.py" \
  "$repo_root/scripts/verify_reviewed_sdk_pin.py"

# Secure statement publication rejects broad parents, symlink ancestors, and
# every pre-existing destination before it attempts to parse dummy evidence.
mkdir -m 0700 "$test_root/approval-output-private"
python3 - "$repo_root/scripts/render_approval_statement_secure.py" \
  "$test_root/approval-output-private" <<'PY'
import importlib.util
import contextlib
import io
import os
import stat
import sys
from pathlib import Path

module_path = Path(sys.argv[1])
parent = sys.argv[2]
spec = importlib.util.spec_from_file_location("secure_approval_publication_test", module_path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parent_fd, _ = module.open_absolute_directory(parent)
try:
    first_fd = os.open(".", os.O_RDWR | os.O_CLOEXEC | os.O_TMPFILE, 0o600, dir_fd=parent_fd)
    try:
        module.write_all(first_fd, b"canonical-fixture\n")
        os.fchmod(first_fd, 0o600)
        os.fsync(first_fd)
        module.publish_unnamed_file(first_fd, parent_fd, "published.json")
        os.fsync(parent_fd)
    finally:
        os.close(first_fd)
    second_fd = os.open(".", os.O_RDWR | os.O_CLOEXEC | os.O_TMPFILE, 0o600, dir_fd=parent_fd)
    try:
        module.write_all(second_fd, b"attacker-replacement\n")
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                module.publish_unnamed_file(second_fd, parent_fd, "published.json")
            except SystemExit:
                pass
            else:
                raise AssertionError("held-fd no-replace publication replaced an existing file")
    finally:
        os.close(second_fd)
finally:
    os.close(parent_fd)
published = Path(parent) / "published.json"
if published.read_bytes() != b"canonical-fixture\n" or stat.S_IMODE(published.stat().st_mode) != 0o600:
    raise AssertionError("held-fd approval publication changed bytes or mode")
PY
printf 'race-winner\n' >"$test_root/approval-output-private/existing.json"
if python3 "$repo_root/scripts/render_approval_statement_secure.py" \
  "$repo_root" /nonexistent/candidate /nonexistent/exact /nonexistent/profile \
  "$test_root/approval-output-private/existing.json" >/dev/null 2>&1; then
  printf 'secure approval renderer accepted a pre-existing output\n' >&2
  exit 1
fi
mkdir -m 0755 "$test_root/approval-output-broad"
if python3 "$repo_root/scripts/render_approval_statement_secure.py" \
  "$repo_root" /nonexistent/candidate /nonexistent/exact /nonexistent/profile \
  "$test_root/approval-output-broad/new.json" >/dev/null 2>&1; then
  printf 'secure approval renderer accepted a non-private output parent\n' >&2
  exit 1
fi
ln -s "$test_root/approval-output-private" "$test_root/approval-output-link"
if python3 "$repo_root/scripts/render_approval_statement_secure.py" \
  "$repo_root" /nonexistent/candidate /nonexistent/exact /nonexistent/profile \
  "$test_root/approval-output-link/new.json" >/dev/null 2>&1; then
  printf 'secure approval renderer followed a symlink output ancestor\n' >&2
  exit 1
fi
jq empty "$repo_root/ops/evidence/reviewed-cedra-sdk-2.2.8.json"
mkdir "$test_root/no-replace"
printf 'new\n' >"$test_root/no-replace/source"
printf 'race-winner\n' >"$test_root/no-replace/destination"
if python3 "$repo_root/scripts/rename_noreplace.py" \
  "$test_root/no-replace/source" "$test_root/no-replace/destination" >/dev/null 2>&1; then
  printf 'kernel no-replace helper overwrote an existing file\n' >&2
  exit 1
fi
[[ "$(<"$test_root/no-replace/destination")" == race-winner \
  && "$(<"$test_root/no-replace/source")" == new ]] || {
  printf 'kernel no-replace helper changed source or destination on collision\n' >&2
  exit 1
}
python3 "$repo_root/scripts/check_json_schemas.py" \
  "$repo_root/ops/schemas/approval-envelope.schema.json" \
  "$repo_root/ops/schemas/transaction-build-request.schema.json" \
  "$repo_root/ops/schemas/transaction-evidence.schema.json" \
  "$repo_root/ops/schemas/release-manifest.schema.json" \
  "$repo_root/ops/schemas/sdk-review-attestation.schema.json" \
  "$repo_root/ops/schemas/release-executable-closure.schema.json" >/dev/null

# PackageMetadata header fixture: name, immutable policy 2, upgrade 0, and the
# framework source digest. The custom release digest is intentionally absent.
python3 - "$test_root/package-metadata.bcs" <<'PY'
import sys
from pathlib import Path
name = b"ReflectionCore"
digest = b"A" * 64
Path(sys.argv[1]).write_bytes(bytes([len(name)]) + name + b"\x02" + b"\x00" * 8 + bytes([len(digest)]) + digest + b"\x00")
PY

# Generate the public-key/address seed used by the complete release fixtures.
"$node_bin" --input-type=module - "$test_root/public-profile.json" <<'JS'
import fs from "node:fs";
import { Ed25519PublicKey } from "@cedra-labs/ts-sdk";
const output = process.argv[2];
const roles = ["core_publisher","assets_publisher","amm_publisher","operations","bootstrap_lp"];
const profiles = {};
for (let index = 0; index < roles.length; index += 1) {
  const keyHex = `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`;
  const publicKey = new Ed25519PublicKey(keyHex);
  profiles[roles[index]] = {public_key:`ed25519-pub-${keyHex}`,account:publicKey.authKey().derivedAddress().toStringLongWithoutPrefix()};
}
fs.writeFileSync(output, JSON.stringify({profiles}));
JS

# Build one complete, approval-grade synthetic v3 exact-address bundle and
# public-profile record. This exercises the entire candidate-input call graph,
# including nested clean-verification, package inventory, CLI-oracle, compiled
# manifest, public-role, and OpenSSL authentication-key validation.
python3 - "$test_root/public-profile.json" "$test_root/release-inputs" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

public = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["profiles"]
root = Path(sys.argv[2])
base = root / "base"
provenance = base / "provenance"
provenance.mkdir(parents=True)

roles = ("core_publisher", "assets_publisher", "amm_publisher", "operations", "bootstrap_lp")
profile_names = {
    "core_publisher": "cedra-reflect-core-publisher",
    "assets_publisher": "cedra-reflect-assets-publisher",
    "amm_publisher": "cedra-reflect-amm-publisher",
    "operations": "cedra-reflect-operations",
    "bootstrap_lp": "cedra-reflect-bootstrap-lp",
}
addresses = {role: "0x" + (public[role]["account"].lstrip("0") or "0") for role in roles}
full_addresses = {role: "0x" + public[role]["account"] for role in roles}
commit = "a" * 40
tree = "b" * 40
framework = "c" * 40
release_source = "d" * 64
cli_sha = "e" * 64
generated_at = "2030-01-01T00:00:00Z"
toolchain = {"cedra_cli_path": "/fixture/cedra", "cedra_cli_sha256": cli_sha, "cedra_cli_version": "cedra fixture 1"}

def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()

def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = data if isinstance(data, bytes) else data.encode()
    path.write_bytes(encoded)
    return encoded

def write_json(path, value, *, compact=False):
    encoded = canonical(value) if compact else (json.dumps(value, indent=2) + "\n").encode()
    return write(path, encoded)

def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()

def sha_file(path):
    return sha_bytes(path.read_bytes())

role_candidate = {
    "schema_version": 1,
    "evidence_scope": "local-public-role-candidate",
    "recorded_date": "2030-01-01",
    "network_intent": "cedra-testnet",
    "source": "deterministic release-tooling fixture",
    "funding_status": "not-checked",
    "on_chain_status": "not-checked",
    "release_approval_status": "candidate-only",
    "contains_private_key_material": False,
    "roles": {
        role: {
            "address": full_addresses[role],
            "profile_name": profile_names[role],
            "intended_use": f"fixture {role}",
        }
        for role in roles
    },
    "evidence_boundaries": {
        "profile_state_read_by_release_tooling": False,
        "accounts_funded": False,
        "accounts_observed_on_chain": False,
        "release_authorized": False,
    },
}
role_path = provenance / "public-role-candidate.json"
write_json(role_path, role_candidate)
role_sha = sha_file(role_path)

profile_evidence = {
    "schema_version": 1,
    "evidence_scope": "local-public-profile-preflight",
    "generated_at": generated_at,
    "network_intent": "cedra-testnet",
    "config_working_directory": "/fixture/cedra-config",
    "config_directory_mode": "0700",
    "config_file_mode": "0600",
    "public_role_candidate_sha256": role_sha,
    "toolchain": toolchain,
    "profiles": {
        role: {
            "profile_name": profile_names[role],
            "network": "Testnet",
            "has_private_key": True,
            "public_key": public[role]["public_key"],
            "account": public[role]["account"],
            "rest_url": "https://testnet.cedra.dev",
            "faucet_url": "https://faucet-api.cedra.dev",
        }
        for role in roles
    },
    "authentication_key_validation": {
        "all_profile_authentication_keys_match": True,
        "derivation_method": "sha3-256(ed25519_public_key_bytes || 0x00)",
        "derivation_tool": "OpenSSL dgst -sha3-256",
    },
    "evidence_boundaries": {
        "public_profile_state_read": True,
        "private_key_values_read": False,
        "network_state_observed": False,
        "accounts_funded": False,
        "transaction_built": False,
        "transaction_signed": False,
        "transaction_submitted": False,
    },
}
write_json(base / "public-profile-evidence.json", profile_evidence)

def local_package(name, publishable, compiled, integration=False):
    return {
        "compiled_artifact_present": compiled,
        "compiled_artifact_sha256": (hashlib.sha256(name.encode()).hexdigest() if compiled else None),
        "dev_address_compiled_components_bytes": 0,
        "package_source_sha256": hashlib.sha256((name + " source").encode()).hexdigest(),
        "publishable": publishable,
        "upgrade_policy": "immutable" if publishable else "compatible",
    }

local_build = {
    "schema_version": 1,
    "evidence_scope": "local-release-build-verification",
    "network": "local-dev-address-build",
    "generated_at": generated_at,
    "application_commit": commit,
    "application_tree": tree,
    "working_tree_clean": True,
    "release_source_sha256": release_source,
    "framework_revision": framework,
    "approval_eligible": False,
    "toolchain": toolchain,
    "packages": {
        "reflection_core": local_package("reflection_core", True, True),
        "test_assets": local_package("test_assets", True, True),
        "test_amm": local_package("test_amm", True, True),
        "hook_probe": local_package("hook_probe", False, True),
        "integration_tests": local_package("integration_tests", False, False),
    },
    "evidence_boundaries": {
        "exact_publisher_addresses_used": False,
        "full_test_suite_executed": False,
        "network_state_observed": False,
        "transaction_simulated": False,
        "transaction_submitted": False,
    },
}
write_json(provenance / "local-release-build.json", local_build)
model_gate = {
    "schema": "cedra-reflection-model-gate/v1",
    "requested_successful_operations": 1000000,
    "successful": 1000000,
    "rejected": 1,
    "no_op": 1,
    "attempts": 1000002,
    "full_invariant_audits": 1,
    "final_state_digest": "f" * 64,
    "git_commit": commit,
    "git_clean": True,
}
write_json(provenance / "model-gate-report.json", model_gate)
write(provenance / "verification.log", "fixture verification succeeded\n")
verification_record = {
    "schema_version": 1,
    "evidence_scope": "local-clean-full-verification",
    "network": "local-only",
    "generated_at": generated_at,
    "application_commit": commit,
    "application_tree": tree,
    "working_tree_clean_before": True,
    "working_tree_clean_after": True,
    "verification_succeeded": True,
    "release_source_sha256": release_source,
    "framework_revision": framework,
    "toolchain": toolchain,
    "verification_commands": ["fixture command 1", "fixture command 2", "fixture command 3"],
    "verification_log": {"file": "verification.log", "sha256": sha_file(provenance / "verification.log")},
    "local_release_build_report": {"file": "local-release-build.json", "sha256": sha_file(provenance / "local-release-build.json")},
    "model_gate_report": {"file": "model-gate-report.json", "sha256": sha_file(provenance / "model-gate-report.json")},
    "evidence_boundaries": {
        "exact_publisher_addresses_used": False,
        "network_state_observed": False,
        "transaction_simulated": False,
        "transaction_submitted": False,
    },
}
write_json(provenance / "verification-record.json", verification_record)

named = {
    "reflection_core": addresses["core_publisher"],
    "test_assets": addresses["assets_publisher"],
    "test_amm": addresses["amm_publisher"],
}
package_definitions = {
    "reflection_core": ("ReflectionCore", "Reflection.mv"),
    "test_assets": ("TestAssets", "Assets.mv"),
    "test_amm": ("TestAmm", "Amm.mv"),
}
packages = {}
for index, (package_key, (package_name, module_name)) in enumerate(package_definitions.items(), start=1):
    directory = base / package_key
    module_directory = directory / "bytecode_modules"
    module_directory.mkdir(parents=True)
    source_digest = chr(64 + index) * 64
    name_bytes = package_name.encode()
    metadata = bytes([len(name_bytes)]) + name_bytes + b"\x02" + b"\x00" * 8 + bytes([64]) + source_digest.encode() + b"\x00"
    module = bytes([index, index + 1, index + 2, index + 3])
    write(directory / "package-metadata.bcs", metadata)
    write(module_directory / module_name, module)
    payload = {
        "type": "entry_function_payload",
        "function": "0x1::code::publish_package_txn",
        "type_arguments": [],
        "arguments": ["0x" + metadata.hex(), ["0x" + module.hex()]],
    }
    payload_bytes = write_json(directory / "publish-payload.json", payload, compact=True)
    oracle = {
        "function_id": payload["function"],
        "type_args": [],
        "args": [{"value": payload["arguments"][0]}, {"value": payload["arguments"][1]}],
    }
    oracle_bytes = write_json(directory / "cedra-cli-publish-payload.json", oracle, compact=True)
    compiled_names = [f"bytecode_modules/{module_name}", "package-metadata.bcs"]
    review_names = [f"bytecode_modules/{module_name}", "cedra-cli-publish-payload.json", "package-metadata.bcs", "publish-payload.json"]
    compiled_manifest = "".join(f"{sha_file(directory / name)}  {name}\n" for name in sorted(compiled_names))
    review_manifest = "".join(f"{sha_file(directory / name)}  {name}\n" for name in sorted(review_names))
    write(directory / "compiled-package-files.sha256", compiled_manifest)
    write(directory / "review-bundle-files.sha256", review_manifest)
    packages[package_key] = {
        "publisher": named[package_key],
        "event_source_address": named[package_key],
        "upgrade_policy": "immutable",
        "package_source_sha256": hashlib.sha256((package_key + " exact source").encode()).hexdigest(),
        "embedded_package_metadata": {"name": package_name, "source_digest": source_digest, "upgrade_number": "0", "upgrade_policy_number": 2},
        "compiled_package_files_manifest": "compiled-package-files.sha256",
        "compiled_package_files_manifest_sha256": sha_file(directory / "compiled-package-files.sha256"),
        "review_bundle_files_manifest": "review-bundle-files.sha256",
        "review_bundle_files_manifest_sha256": sha_file(directory / "review-bundle-files.sha256"),
        "metadata_bcs_file": "package-metadata.bcs",
        "metadata_bcs_sha256": sha_file(directory / "package-metadata.bcs"),
        "module_bytecode": [{"file": module_name, "sha256": sha_file(module_directory / module_name), "bytes": len(module)}],
        "publish_payload_file": "publish-payload.json",
        "publish_payload_sha256": sha_file(directory / "publish-payload.json"),
        "publish_payload_argument_bytes": len(metadata) + len(module),
        "publish_payload_json_bytes": len(payload_bytes),
        "cedra_cli_publish_payload_file": "cedra-cli-publish-payload.json",
        "cedra_cli_publish_payload_sha256": sha_bytes(oracle_bytes),
        "cedra_cli_publish_data_size_bytes": len(metadata) + len(module),
        "normal_publish_data_limit_bytes": 65536,
        "within_normal_publish_data_limit": True,
        "transaction_bcs_size_bytes": None,
        "normal_transaction_size_limit_bytes": 65536,
        "within_normal_transaction_size_limit": None,
        "named_addresses": named,
    }

exact = {
    "schema_version": 3,
    "evidence_scope": "local-exact-address-build-only",
    "network": "cedra-testnet",
    "generated_at": generated_at,
    "application_commit": commit,
    "application_tree": tree,
    "working_tree_clean": True,
    "release_source_sha256": release_source,
    "framework": {"git_url": "https://github.com/cedra-labs/cedra-framework.git", "revision": framework, "subdir": "cedra-framework"},
    "toolchain": toolchain,
    "named_addresses": named,
    "roles": addresses,
    "verification_binding": {
        "record_file": "provenance/verification-record.json",
        "record_sha256": sha_file(provenance / "verification-record.json"),
        "verification_log_file": "provenance/verification.log",
        "verification_log_sha256": sha_file(provenance / "verification.log"),
        "local_release_build_report_file": "provenance/local-release-build.json",
        "local_release_build_report_sha256": sha_file(provenance / "local-release-build.json"),
        "model_gate_report_file": "provenance/model-gate-report.json",
        "model_gate_report_sha256": sha_file(provenance / "model-gate-report.json"),
    },
    "public_role_candidate_binding": {"file": "provenance/public-role-candidate.json", "sha256": role_sha},
    "local_build_eligible_for_human_review": True,
    "approval_eligible": False,
    "approval_blockers": ["detached approvals required", "external signing required", "submission not performed"],
    "packages": packages,
    "evidence_boundaries": {
        "network_state_observed": False,
        "transaction_built": False,
        "transaction_signed": False,
        "transaction_simulated": False,
        "transaction_submitted": False,
        "finalized_testnet_state_observed": False,
    },
}
write_json(base / "exact-address-artifacts.json", exact)
PY

valid_inputs="$test_root/release-inputs/base"
timeout 20 bash "$repo_root/scripts/validate_candidate_release_inputs.sh" \
  "$valid_inputs/exact-address-artifacts.json" "$valid_inputs/public-profile-evidence.json" >/dev/null || {
  printf 'complete valid candidate inputs failed validation or recursed\n' >&2
  exit 1
}

expect_candidate_input_rejection() {
  local label="$1"
  local directory="$2"
  if timeout 20 bash "$repo_root/scripts/validate_candidate_release_inputs.sh" \
    "$directory/exact-address-artifacts.json" "$directory/public-profile-evidence.json" >/dev/null 2>&1; then
    printf 'adversarial candidate input was accepted: %s\n' "$label" >&2
    exit 1
  fi
}

for variant in dirty ineligible missing-provenance module-inventory cli-oracle compiled-manifest profile-role-digest; do
  cp -a "$valid_inputs" "$test_root/release-inputs/$variant"
done
jq '.working_tree_clean=false' "$test_root/release-inputs/dirty/exact-address-artifacts.json" \
  >"$test_root/release-inputs/dirty/exact-address-artifacts.tmp"
mv "$test_root/release-inputs/dirty/exact-address-artifacts.tmp" "$test_root/release-inputs/dirty/exact-address-artifacts.json"
jq '.local_build_eligible_for_human_review=false' "$test_root/release-inputs/ineligible/exact-address-artifacts.json" \
  >"$test_root/release-inputs/ineligible/exact-address-artifacts.tmp"
mv "$test_root/release-inputs/ineligible/exact-address-artifacts.tmp" "$test_root/release-inputs/ineligible/exact-address-artifacts.json"
rm "$test_root/release-inputs/missing-provenance/provenance/verification.log"
printf '\x01\x02' >"$test_root/release-inputs/module-inventory/reflection_core/bytecode_modules/Unbound.mv"
jq --arg digest "$(printf '%064d' 0)" '.public_role_candidate_sha256=$digest' \
  "$test_root/release-inputs/profile-role-digest/public-profile-evidence.json" \
  >"$test_root/release-inputs/profile-role-digest/public-profile-evidence.tmp"
mv "$test_root/release-inputs/profile-role-digest/public-profile-evidence.tmp" \
  "$test_root/release-inputs/profile-role-digest/public-profile-evidence.json"
jq '.args[0].value="0x01"' "$test_root/release-inputs/cli-oracle/reflection_core/cedra-cli-publish-payload.json" \
  >"$test_root/release-inputs/cli-oracle/reflection_core/cedra-cli-publish-payload.tmp"
mv "$test_root/release-inputs/cli-oracle/reflection_core/cedra-cli-publish-payload.tmp" \
  "$test_root/release-inputs/cli-oracle/reflection_core/cedra-cli-publish-payload.json"
(cd "$test_root/release-inputs/cli-oracle/reflection_core" && \
  sha256sum bytecode_modules/Reflection.mv cedra-cli-publish-payload.json package-metadata.bcs publish-payload.json \
    >review-bundle-files.sha256)
cli_oracle_sha="$(sha256sum "$test_root/release-inputs/cli-oracle/reflection_core/cedra-cli-publish-payload.json" | cut -d ' ' -f 1)"
cli_review_sha="$(sha256sum "$test_root/release-inputs/cli-oracle/reflection_core/review-bundle-files.sha256" | cut -d ' ' -f 1)"
jq --arg oracle "$cli_oracle_sha" --arg review "$cli_review_sha" \
  '.packages.reflection_core.cedra_cli_publish_payload_sha256=$oracle | .packages.reflection_core.review_bundle_files_manifest_sha256=$review' \
  "$test_root/release-inputs/cli-oracle/exact-address-artifacts.json" \
  >"$test_root/release-inputs/cli-oracle/exact-address-artifacts.tmp"
mv "$test_root/release-inputs/cli-oracle/exact-address-artifacts.tmp" \
  "$test_root/release-inputs/cli-oracle/exact-address-artifacts.json"
printf '%064d  bytecode_modules/Phantom.mv\n' 0 \
  >>"$test_root/release-inputs/compiled-manifest/reflection_core/compiled-package-files.sha256"
compiled_manifest_sha="$(sha256sum "$test_root/release-inputs/compiled-manifest/reflection_core/compiled-package-files.sha256" | cut -d ' ' -f 1)"
jq --arg digest "$compiled_manifest_sha" \
  '.packages.reflection_core.compiled_package_files_manifest_sha256=$digest' \
  "$test_root/release-inputs/compiled-manifest/exact-address-artifacts.json" \
  >"$test_root/release-inputs/compiled-manifest/exact-address-artifacts.tmp"
mv "$test_root/release-inputs/compiled-manifest/exact-address-artifacts.tmp" \
  "$test_root/release-inputs/compiled-manifest/exact-address-artifacts.json"

expect_candidate_input_rejection dirty "$test_root/release-inputs/dirty"
expect_candidate_input_rejection ineligible "$test_root/release-inputs/ineligible"
expect_candidate_input_rejection missing-provenance "$test_root/release-inputs/missing-provenance"
expect_candidate_input_rejection module-inventory "$test_root/release-inputs/module-inventory"
expect_candidate_input_rejection cli-oracle "$test_root/release-inputs/cli-oracle"
expect_candidate_input_rejection compiled-manifest "$test_root/release-inputs/compiled-manifest"
expect_candidate_input_rejection profile-role-digest "$test_root/release-inputs/profile-role-digest"

# The approval-side BCS validator has its own lockfile/package-tree hashing
# implementation. A modified loaded entrypoint must not match the pre-change
# integrity evidence even in a minimal isolated fixture.
"$node_bin" --input-type=module - "$repo_root" "$test_root/sdk-integrity" <<'JS'
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [repoRoot, root] = process.argv.slice(2);
process.chdir(repoRoot);
const { computeBuildIntegrity, validateBuildEnvironment } = await import(pathToFileURL(path.join(repoRoot, "scripts", "validate_release_transaction_bcs.mjs")).href);
fs.mkdirSync(path.join(root, "sdk"), { recursive: true });
const integrity = `sha512-${"A".repeat(86)}==`;
fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({packages:{"node_modules/@cedra-labs/ts-sdk":{version:"2.2.8",integrity}}}));
const packageJsonPath = path.join(root, "sdk", "package.json");
const packageJson = Buffer.from(JSON.stringify({name:"@cedra-labs/ts-sdk",version:"2.2.8"}));
fs.writeFileSync(packageJsonPath, packageJson);
const entrypoint = path.join(root, "sdk", "index.mjs");
const entrypointBytes = Buffer.from("export const reviewed = true;\n");
fs.writeFileSync(entrypoint, entrypointBytes);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const tree = sha(`${sha(entrypointBytes)}\u0000${entrypointBytes.length}\u0000index.mjs\n${sha(packageJson)}\u0000${packageJson.length}\u0000package.json\n`);
const pinDirectory = path.join(root, "ops", "evidence");
fs.mkdirSync(pinDirectory, {recursive:true});
fs.writeFileSync(path.join(pinDirectory, "reviewed-cedra-sdk-2.2.8.json"), JSON.stringify({
  schema_version:1,evidence_scope:"reviewed-npm-sdk-artifact",package_name:"@cedra-labs/ts-sdk",package_version:"2.2.8",
  registry_tarball_url:"https://registry.npmjs.org/@cedra-labs/ts-sdk/-/ts-sdk-2.2.8.tgz",npm_tarball_sha512_integrity:integrity,
  npm_tarball_sha256:"c".repeat(64),package_tree_digest_algorithm:"sha256(depth_first_lexicographic_path_components(sha256(file_bytes) NUL decimal_byte_length NUL posix_relative_path LF))",
  sdk_package_json_sha256:sha(packageJson),sdk_loaded_entrypoint:"index.mjs",sdk_loaded_entrypoint_sha256:sha(entrypointBytes),
  sdk_package_tree_sha256:tree,sdk_package_file_count:2,
}));
fs.writeFileSync(path.join(pinDirectory, "release-executable-closure.json"), JSON.stringify({test_only:true}));
const reviewPinPath = path.join(pinDirectory, "reviewed-cedra-sdk-2.2.8.json");
const sdkReviewTrustPath = path.join(root, "test-only-sdk-review.allowed_signers");
const sdkReviewSignaturePath = path.join(root, "test-only-sdk-review.sig");
const sdkReviewAttestationPath = path.join(root, "test-only-sdk-review-attestation.json");
fs.writeFileSync(sdkReviewTrustPath, "test-only-reviewer ssh-ed25519 TEST_ONLY\n");
fs.writeFileSync(sdkReviewSignaturePath, "TEST ONLY\n");
fs.writeFileSync(sdkReviewAttestationPath, JSON.stringify({
  evidence_scope:"independent-cedra-sdk-review-attestation",decision:"approved-for-testnet-candidate-assembly",
  reviewer_identity:"test-only-reviewer",sdk_review_pin_sha256:sha(fs.readFileSync(reviewPinPath)),
  sdk_package_tree_sha256:tree,sdk_package_file_count:2,
  trusted_allowed_signers_sha256:sha(fs.readFileSync(sdkReviewTrustPath)),
}));
const integrityArgs = {
  repoRoot:root,sdkPackageJsonPath:packageJsonPath,sdkEntrypointPath:entrypoint,
  sdkReviewAttestationPath,sdkReviewSignaturePath,sdkReviewTrustPath,
};
const before = computeBuildIntegrity(integrityArgs);
const candidate = {application_commit:"a".repeat(40),build_environment:{repository_head_commit:"a".repeat(40),repository_head_tree:"b".repeat(40),...before}};
validateBuildEnvironment(candidate, before);
fs.writeFileSync(entrypoint, "export const reviewed = false;\n");
let rejected = false;
try { computeBuildIntegrity(integrityArgs); } catch { rejected = true; }
if (!rejected) throw new Error("approval validator accepted a modified loaded SDK artifact");
JS
metadata_json="$(python3 "$repo_root/scripts/decode_package_metadata_header.py" "$test_root/package-metadata.bcs")"
[[ "$metadata_json" == '{"name":"ReflectionCore","source_digest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","upgrade_number":"0","upgrade_policy_number":2}' ]] || {
  printf 'PackageMetadata header decoder regression\n' >&2
  exit 1
}
python3 - "$test_root/package-metadata-invalid.bcs" <<'PY'
import sys
from pathlib import Path
name = b"ReflectionCore"
digest = b"a" * 64
Path(sys.argv[1]).write_bytes(bytes([len(name)]) + name + b"\x02" + b"\x00" * 8 + bytes([len(digest)]) + digest + b"\x00")
PY
if python3 "$repo_root/scripts/decode_package_metadata_header.py" "$test_root/package-metadata-invalid.bcs" >/dev/null 2>&1; then
  printf 'lowercase embedded PackageMetadata source digest was accepted\n' >&2
  exit 1
fi

# REST signature normalization must reject every fee-payer shape and hidden
# fee-payer field, while accepting the exact legacy Ed25519 shapes used here.
python3 - "$repo_root" <<'PY'
import importlib.util
import sys
from pathlib import Path

root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("release_evidence", root / "scripts/release_evidence.py")
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

payload = {"type":"entry_function_payload","function":"0x1::m::f","type_arguments":[],"arguments":[]}
base = {
    "sender":"0x1","sequence_number":"0","expiration_timestamp_secs":"1",
    "max_gas_amount":"1","gas_unit_price":"1","payload":payload,
    "signature":{"type":"ed25519_signature","public_key":"0x11","signature":"0x22"},
}
assert module.normalize_rest_transaction(base, "fixture")["secondary_signers"] == []

fee_payer = dict(base)
fee_payer["signature"] = {
    "type":"fee_payer_signature",
    "sender":{"type":"ed25519_signature","public_key":"0x11","signature":"0x22"},
    "secondary_signer_addresses":[],"secondary_signers":[],
    "fee_payer_address":"0x2",
    "fee_payer_signer":{"type":"ed25519_signature","public_key":"0x33","signature":"0x44"},
}
try:
    module.normalize_rest_transaction(fee_payer, "fee-payer fixture")
except module.EvidenceError:
    pass
else:
    raise AssertionError("fee_payer_signature was accepted")

hidden = dict(base)
hidden["signature"] = dict(base["signature"], fee_payer_address="0x2")
try:
    module.normalize_rest_transaction(hidden, "hidden fee-payer fixture")
except module.EvidenceError:
    pass
else:
    raise AssertionError("hidden fee_payer_address was accepted")
PY

# Generate five public-only SDK fixtures and prove a mismatched account fails.
"$node_bin" --input-type=module - "$test_root/public-profile.json" <<'JS'
import fs from "node:fs";
import { Ed25519PublicKey } from "@cedra-labs/ts-sdk";
const output = process.argv[2];
const roles = ["core_publisher","assets_publisher","amm_publisher","operations","bootstrap_lp"];
const profiles = {};
for (let index = 0; index < roles.length; index += 1) {
  const keyHex = `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`;
  const publicKey = new Ed25519PublicKey(keyHex);
  profiles[roles[index]] = {public_key:`ed25519-pub-${keyHex}`,account:publicKey.authKey().derivedAddress().toStringLongWithoutPrefix()};
}
fs.writeFileSync(output, JSON.stringify({profiles}));
JS
authentication_key_validation="$(bash "$repo_root/scripts/validate_public_profile_auth_keys.sh" "$test_root/public-profile.json")"
jq -e '
  . == {
    all_profile_authentication_keys_match:true,
    derivation_method:"sha3-256(ed25519_public_key_bytes || 0x00)",
    derivation_tool:"OpenSSL dgst -sha3-256"
  }
' <<<"$authentication_key_validation" >/dev/null
jq '.profiles.bootstrap_lp.account = .profiles.core_publisher.account' "$test_root/public-profile.json" >"$test_root/public-profile-mismatch.json"
if bash "$repo_root/scripts/validate_public_profile_auth_keys.sh" "$test_root/public-profile-mismatch.json" >/dev/null 2>&1; then
  printf 'shell authentication-key validator accepted a mismatched profile\n' >&2
  exit 1
fi

# Simulation evidence must bind every requested profile key in exact signer
# order and accept only the SDK's all-zero Ed25519 simulation signatures.
python3 - "$repo_root" "$test_root/public-profile.json" <<'PY'
import importlib.util
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("release_evidence", root / "scripts/release_evidence.py")
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
public = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["profiles"]
profiles = {
    role: {
        "address": module.canonical_address("0x" + public[role]["account"], role),
        "public_key": public[role]["public_key"],
    }
    for role in module.ROLE_KEYS
}
candidate = {"public_profile_binding": {"profiles": profiles}}
zero = module.ZERO_SIMULATION_SIGNATURE

def authenticator(role):
    return {
        "type": "ed25519_signature",
        "public_key": profiles[role]["public_key"].removeprefix("ed25519-pub-"),
        "signature": zero,
    }

single_tx = {"sender": profiles["core_publisher"]["address"], "secondary_signers": []}
single_response = {"signature": authenticator("core_publisher")}
module.validate_simulation_authenticator(single_response, candidate, single_tx)
changed = {"signature": dict(single_response["signature"], signature="0x01" + "00" * 63)}
try:
    module.validate_simulation_authenticator(changed, candidate, single_tx)
except module.EvidenceError:
    pass
else:
    raise AssertionError("nonzero simulation signature was accepted")

secondary_roles = ["assets_publisher", "amm_publisher"]
multi_tx = {
    "sender": profiles["core_publisher"]["address"],
    "secondary_signers": [profiles[role]["address"] for role in secondary_roles],
}
multi_response = {
    "signature": {
        "type": "multi_agent_signature",
        "sender": authenticator("core_publisher"),
        "secondary_signer_addresses": multi_tx["secondary_signers"],
        "secondary_signers": [authenticator(role) for role in secondary_roles],
    }
}
module.validate_simulation_authenticator(multi_response, candidate, multi_tx)
multi_response["signature"]["secondary_signers"][0]["public_key"] = "0x" + "ff" * 32
try:
    module.validate_simulation_authenticator(multi_response, candidate, multi_tx)
except module.EvidenceError:
    pass
else:
    raise AssertionError("wrong ordered secondary simulation key was accepted")
PY

# Exercise real OpenSSH detached signatures, including the regression where two
# allowed identities point at the same key.
namespace=cedra-reflect-testnet-release-v1
printf '{"decision":"test-only"}\n' >"$test_root/approval-statement.json"
ssh-keygen -q -t ed25519 -N '' -f "$test_root/key-1"
ssh-keygen -q -t ed25519 -N '' -f "$test_root/key-2"
ssh-keygen -Y sign -q -f "$test_root/key-1" -n "$namespace" "$test_root/approval-statement.json" >/dev/null 2>&1
mv "$test_root/approval-statement.json.sig" "$test_root/approver-1.sig"
ssh-keygen -Y sign -q -f "$test_root/key-2" -n "$namespace" "$test_root/approval-statement.json" >/dev/null 2>&1
mv "$test_root/approval-statement.json.sig" "$test_root/approver-2.sig"
printf 'approver-1 %s\napprover-2 %s\n' \
  "$(awk '{print $1" "$2}' "$test_root/key-1.pub")" \
  "$(awk '{print $1" "$2}' "$test_root/key-2.pub")" >"$test_root/allowed-signers"
fingerprint_1="$(ssh-keygen -lf "$test_root/key-1.pub" -E sha256 | awk '{print $2}')"
fingerprint_2="$(ssh-keygen -lf "$test_root/key-2.pub" -E sha256 | awk '{print $2}')"
jq -n \
  --arg namespace "$namespace" \
  --arg statement_sha "$(sha256sum "$test_root/approval-statement.json" | cut -d ' ' -f 1)" \
  --arg trust_sha "$(sha256sum "$test_root/allowed-signers" | cut -d ' ' -f 1)" \
  --arg fingerprint_1 "$fingerprint_1" \
  --arg fingerprint_2 "$fingerprint_2" \
  --arg signature_1 "$(sha256sum "$test_root/approver-1.sig" | cut -d ' ' -f 1)" \
  --arg signature_2 "$(sha256sum "$test_root/approver-2.sig" | cut -d ' ' -f 1)" \
  '{signature_namespace:$namespace,statement_file:"approval-statement.json",statement_sha256:$statement_sha,trusted_allowed_signers_sha256:$trust_sha,approvals:[{identity:"approver-1",key_fingerprint:$fingerprint_1,signature_file:"approver-1.sig",signature_sha256:$signature_1},{identity:"approver-2",key_fingerprint:$fingerprint_2,signature_file:"approver-2.sig",signature_sha256:$signature_2}]}' \
  >"$test_root/approval-envelope.json"
bash "$repo_root/scripts/verify_detached_ssh_signatures.sh" "$test_root/approval-envelope.json" "$test_root/allowed-signers" >/dev/null

# Exported functions, a hostile PATH, and BASH_ENV must not replace any
# verifier dependency. The genuine envelope still verifies and a forged
# envelope built from /etc fixture bytes still fails closed.
malicious_path="$test_root/malicious-path"
mkdir -m 0700 "$malicious_path" "$test_root/forged-approval"
for forged_command in jq sha256sum ssh-keygen bash python3 sed tail; do
  printf '#!/usr/bin/env sh\nexit 0\n' >"$malicious_path/$forged_command"
  chmod 0700 "$malicious_path/$forged_command"
done
printf '%s\n' \
  'jq(){ return 0; }' \
  'sha256sum(){ /usr/bin/printf "%064d  %s\\n" 0 "${1:-forged}"; }' \
  'ssh-keygen(){ /usr/bin/printf "Good signature for forged with ED25519 key SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n"; return 0; }' \
  'bash(){ return 0; }' \
  'python3(){ return 0; }' \
  'sed(){ /usr/bin/printf "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n"; }' \
  'tail(){ /usr/bin/printf "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n"; }' \
  'export -f jq sha256sum ssh-keygen bash python3 sed tail' \
  >"$test_root/malicious-bash-env"
BASH_ENV="$test_root/malicious-bash-env" PATH="$malicious_path" \
  /usr/bin/bash "$repo_root/scripts/verify_detached_ssh_signatures.sh" \
  "$test_root/approval-envelope.json" "$test_root/allowed-signers" >/dev/null
cp /etc/hosts "$test_root/forged-approval/approval-statement.json"
cp /etc/passwd "$test_root/forged-approval/approver-1.sig"
cp /etc/passwd "$test_root/forged-approval/approver-2.sig"
cp /etc/hosts "$test_root/forged-approval/allowed-signers"
printf '{}\n' >"$test_root/forged-approval/approval-envelope.json"
if BASH_ENV="$test_root/malicious-bash-env" PATH="$malicious_path" \
  /usr/bin/bash "$repo_root/scripts/verify_detached_ssh_signatures.sh" \
  "$test_root/forged-approval/approval-envelope.json" \
  "$test_root/forged-approval/allowed-signers" >/dev/null 2>&1; then
  printf 'ambient shell injection forged detached release approvals from /etc bytes\n' >&2
  exit 1
fi

# Production entrypoints are executed directly through their fixed bash -p
# shebang. A hostile BASH_ENV therefore cannot exit successfully before line 1.
printf 'exit 0\n' >"$test_root/pre-script-exit-bash-env"
for entrypoint in \
  run_candidate_assembler.sh \
  validate_transaction_candidate.sh \
  render_release_approval_statement.sh \
  verify_release_approvals.sh \
  collect_finalized_transaction_evidence.sh \
  validate_release_manifest.sh; do
  if BASH_ENV="$test_root/pre-script-exit-bash-env" \
    "$repo_root/scripts/$entrypoint" >/dev/null 2>&1; then
    printf 'hostile BASH_ENV bypassed production entrypoint before line 1: %s\n' "$entrypoint" >&2
    exit 1
  fi
done

ssh-keygen -Y sign -q -f "$test_root/key-1" -n "$namespace" "$test_root/approval-statement.json" >/dev/null 2>&1
mv "$test_root/approval-statement.json.sig" "$test_root/approver-2-same-key.sig"
printf 'approver-1 %s\napprover-2 %s\n' \
  "$(awk '{print $1" "$2}' "$test_root/key-1.pub")" \
  "$(awk '{print $1" "$2}' "$test_root/key-1.pub")" >"$test_root/allowed-signers-same-key"
jq \
  --arg trust_sha "$(sha256sum "$test_root/allowed-signers-same-key" | cut -d ' ' -f 1)" \
  --arg signature_2 "$(sha256sum "$test_root/approver-2-same-key.sig" | cut -d ' ' -f 1)" \
  '.trusted_allowed_signers_sha256=$trust_sha | .approvals[1].signature_file="approver-2-same-key.sig" | .approvals[1].signature_sha256=$signature_2' \
  "$test_root/approval-envelope.json" >"$test_root/approval-envelope-same-key.json"
if bash "$repo_root/scripts/verify_detached_ssh_signatures.sh" "$test_root/approval-envelope-same-key.json" "$test_root/allowed-signers-same-key" >/dev/null 2>&1; then
  printf 'two identities backed by one OpenSSH key were accepted\n' >&2
  exit 1
fi

# The production path has no ambient NODE_BIN escape hatch. A shell-only
# preflight authenticates runtime, compiler, emitted JS, SDK, and all loaded
# package files before any release Node process starts. This is a deliberately
# miniature test closure and an ephemeral test signer, not release evidence.
if rg -n 'NODE_BIN' "$repo_root/scripts" --glob '!test_release_tooling.sh' >/dev/null; then
  printf 'production release script still accepts ambient NODE_BIN\n' >&2
  exit 1
fi
closure_root="$test_root/closure-fixture"
mkdir -p \
  "$closure_root/ops/evidence" \
  "$closure_root/scripts" \
  "$closure_root/node_modules/typescript/bin" \
  "$closure_root/node_modules/typescript/lib" \
  "$closure_root/node_modules/@cedra-labs/ts-sdk" \
  "$closure_root/node_modules/transitive-fixture" \
  "$closure_root/fresh-dist/scripts"
chmod 0700 "$closure_root/fresh-dist"
printf '#!/usr/bin/env sh\nexit 0\n' >"$closure_root/reviewed-node"
chmod 0700 "$closure_root/reviewed-node"
closure_node="$closure_root/reviewed-node"
printf '{"name":"closure-fixture","private":true}\n' >"$closure_root/package.json"
printf '{"lockfileVersion":3,"packages":{}}\n' >"$closure_root/package-lock.json"
printf '#!/usr/bin/env node\n' >"$closure_root/node_modules/typescript/bin/tsc"
printf 'export const compilerFixture = true;\n' >"$closure_root/node_modules/typescript/lib/tsc.js"
printf '{"name":"@cedra-labs/ts-sdk","version":"2.2.8"}\n' >"$closure_root/node_modules/@cedra-labs/ts-sdk/package.json"
printf 'export const sdkFixture = true;\n' >"$closure_root/node_modules/@cedra-labs/ts-sdk/index.mjs"
printf 'export const transitiveFixture = true;\n' >"$closure_root/node_modules/transitive-fixture/index.js"
printf 'export const freshAssemblerFixture = true;\n' >"$closure_root/fresh-dist/scripts/assemble-testnet-transaction-candidate.js"
cp "$repo_root/scripts/release_tree_digest.sh" "$closure_root/scripts/"
cp "$repo_root/scripts/sdk_review_tree_digest.sh" "$closure_root/scripts/"
cp "$repo_root/scripts/verify_sdk_review_attestation.sh" "$closure_root/scripts/"
cp "$repo_root/scripts/validate_release_transaction_bcs.mjs" "$closure_root/scripts/"
cp "$repo_root/scripts/rename_noreplace.py" "$closure_root/scripts/"

read -r fixture_sdk_review_sha fixture_sdk_review_count < <(bash "$closure_root/scripts/sdk_review_tree_digest.sh" "$closure_root/node_modules/@cedra-labs/ts-sdk")
jq -n \
  --arg sdk_sha "$fixture_sdk_review_sha" \
  --argjson sdk_count "$fixture_sdk_review_count" \
  '{package_name:"@cedra-labs/ts-sdk",package_version:"2.2.8",sdk_package_tree_sha256:$sdk_sha,sdk_package_file_count:$sdk_count,npm_tarball_sha256:("c"*64)}' \
  >"$closure_root/ops/evidence/reviewed-cedra-sdk-2.2.8.json"

ssh-keygen -q -t ed25519 -N '' -f "$test_root/sdk-review-test-key"
printf 'sdk-review-test-fixture %s\n' "$(awk '{print $1" "$2}' "$test_root/sdk-review-test-key.pub")" \
  >"$test_root/sdk-review-test-allowed-signers"
jq -n \
  --arg trust "$(sha256sum "$test_root/sdk-review-test-allowed-signers" | cut -d ' ' -f 1)" \
  --arg pin "$(sha256sum "$closure_root/ops/evidence/reviewed-cedra-sdk-2.2.8.json" | cut -d ' ' -f 1)" \
  --arg sdk_sha "$fixture_sdk_review_sha" \
  --argjson sdk_count "$fixture_sdk_review_count" \
  '{
    schema_version:1,evidence_scope:"independent-cedra-sdk-review-attestation",
    reviewed_at:"2030-01-01T00:00:00Z",reviewer_identity:"sdk-review-test-fixture",
    independence_statement:"TEST ONLY: ephemeral reviewer is independent solely for deterministic tooling verification.",
    review_method:"TEST ONLY: fixture bytes and tree digests were independently compared.",
    review_report_reference:"test-only://ephemeral-sdk-review",
    decision:"approved-for-testnet-candidate-assembly",
    sdk_review_pin_file:"reviewed-cedra-sdk-2.2.8.json",sdk_review_pin_sha256:$pin,
    sdk_package:"@cedra-labs/ts-sdk",sdk_version:"2.2.8",npm_tarball_sha256:("c"*64),
    sdk_package_tree_sha256:$sdk_sha,sdk_package_file_count:$sdk_count,
    trusted_allowed_signers_sha256:$trust
  }' >"$test_root/sdk-review-test-attestation.json"
ssh-keygen -Y sign -q -f "$test_root/sdk-review-test-key" -n cedra-reflect-sdk-review-v1 \
  "$test_root/sdk-review-test-attestation.json" >/dev/null 2>&1
sdk_review_test_signature="$test_root/sdk-review-test-attestation.json.sig"
bash "$repo_root/scripts/verify_sdk_review_attestation.sh" \
  "$test_root/sdk-review-test-attestation.json" "$sdk_review_test_signature" \
  "$test_root/sdk-review-test-allowed-signers" \
  "$closure_root/ops/evidence/reviewed-cedra-sdk-2.2.8.json" >/dev/null
jq '.decision="rejected"' "$test_root/sdk-review-test-attestation.json" >"$test_root/sdk-review-test-attestation-tampered.json"
if bash "$repo_root/scripts/verify_sdk_review_attestation.sh" \
  "$test_root/sdk-review-test-attestation-tampered.json" "$sdk_review_test_signature" \
  "$test_root/sdk-review-test-allowed-signers" \
  "$closure_root/ops/evidence/reviewed-cedra-sdk-2.2.8.json" >/dev/null 2>&1; then
  printf 'tampered independent SDK-review attestation was accepted\n' >&2
  exit 1
fi

# Integrate the same ephemeral test signer with the repository's real pinned
# SDK and closure. This verifies the production preflight without representing
# the test identity as a human release approval.
actual_sdk_pin="$repo_root/ops/evidence/reviewed-cedra-sdk-2.2.8.json"
jq -n \
  --arg trust "$(sha256sum "$test_root/sdk-review-test-allowed-signers" | cut -d ' ' -f 1)" \
  --arg pin "$(sha256sum "$actual_sdk_pin" | cut -d ' ' -f 1)" \
  --arg package_name "$(jq -r '.package_name' "$actual_sdk_pin")" \
  --arg package_version "$(jq -r '.package_version' "$actual_sdk_pin")" \
  --arg tarball "$(jq -r '.npm_tarball_sha256' "$actual_sdk_pin")" \
  --arg sdk_sha "$(jq -r '.sdk_package_tree_sha256' "$actual_sdk_pin")" \
  --argjson sdk_count "$(jq -r '.sdk_package_file_count' "$actual_sdk_pin")" \
  '{
    schema_version:1,evidence_scope:"independent-cedra-sdk-review-attestation",
    reviewed_at:"2030-01-01T00:00:00Z",reviewer_identity:"sdk-review-test-fixture",
    independence_statement:"TEST ONLY: ephemeral reviewer is not production release approval evidence.",
    review_method:"TEST ONLY: production closure integration and signature gate verification.",
    review_report_reference:"test-only://production-closure-integration",
    decision:"approved-for-testnet-candidate-assembly",
    sdk_review_pin_file:"reviewed-cedra-sdk-2.2.8.json",sdk_review_pin_sha256:$pin,
    sdk_package:$package_name,sdk_version:$package_version,npm_tarball_sha256:$tarball,
    sdk_package_tree_sha256:$sdk_sha,sdk_package_file_count:$sdk_count,
    trusted_allowed_signers_sha256:$trust
  }' >"$test_root/sdk-review-production-closure-test.json"
ssh-keygen -Y sign -q -f "$test_root/sdk-review-test-key" -n cedra-reflect-sdk-review-v1 \
  "$test_root/sdk-review-production-closure-test.json" >/dev/null 2>&1
bash "$repo_root/scripts/preflight_release_executable_closure.sh" \
  "$repo_root" "$node_bin" "$test_root/sdk-review-production-closure-test.json" \
  "$test_root/sdk-review-production-closure-test.json.sig" \
  "$test_root/sdk-review-test-allowed-signers" compiler >/dev/null

read -r fixture_modules_sha fixture_modules_count < <(bash "$closure_root/scripts/release_tree_digest.sh" "$closure_root/node_modules")
read -r fixture_typescript_sha fixture_typescript_count < <(bash "$closure_root/scripts/release_tree_digest.sh" "$closure_root/node_modules/typescript")
read -r fixture_sdk_sha fixture_sdk_count < <(bash "$closure_root/scripts/release_tree_digest.sh" "$closure_root/node_modules/@cedra-labs/ts-sdk")
read -r fixture_dist_sha fixture_dist_count < <(bash "$closure_root/scripts/release_tree_digest.sh" "$closure_root/fresh-dist")
jq -nS \
  --arg runtime_sha "$(sha256sum "$closure_node" | cut -d ' ' -f 1)" \
  --argjson runtime_bytes "$(stat -c '%s' "$closure_node")" \
  --arg python_runtime_sha "$(sha256sum /usr/bin/python3 | cut -d ' ' -f 1)" \
  --argjson python_runtime_bytes "$(stat -Lc '%s' /usr/bin/python3)" \
  --arg package_json_sha "$(sha256sum "$closure_root/package.json" | cut -d ' ' -f 1)" \
  --arg package_lock_sha "$(sha256sum "$closure_root/package-lock.json" | cut -d ' ' -f 1)" \
  --arg modules_sha "$fixture_modules_sha" --argjson modules_count "$fixture_modules_count" \
  --arg typescript_sha "$fixture_typescript_sha" --argjson typescript_count "$fixture_typescript_count" \
  --arg sdk_sha "$fixture_sdk_sha" --argjson sdk_count "$fixture_sdk_count" \
  --arg dist_sha "$fixture_dist_sha" --argjson dist_count "$fixture_dist_count" \
  --arg tsc_sha "$(sha256sum "$closure_root/node_modules/typescript/bin/tsc" | cut -d ' ' -f 1)" \
  --arg compiler_sha "$(sha256sum "$closure_root/node_modules/typescript/lib/tsc.js" | cut -d ' ' -f 1)" \
  --arg bcs_sha "$(sha256sum "$closure_root/scripts/validate_release_transaction_bcs.mjs" | cut -d ' ' -f 1)" \
  --arg rename_noreplace_sha "$(sha256sum "$closure_root/scripts/rename_noreplace.py" | cut -d ' ' -f 1)" \
  '{
    schema_version:1,evidence_scope:"reviewed-release-executable-closure",
    node_runtime:{sha256:$runtime_sha,byte_length:$runtime_bytes},
    python_runtime:{sha256:$python_runtime_sha,byte_length:$python_runtime_bytes},
    package_json_sha256:$package_json_sha,package_lock_sha256:$package_lock_sha,
    node_modules:{path:"node_modules",sha256:$modules_sha,file_count:$modules_count},
    typescript:{path:"node_modules/typescript",sha256:$typescript_sha,file_count:$typescript_count},
    sdk:{path:"node_modules/@cedra-labs/ts-sdk",sha256:$sdk_sha,file_count:$sdk_count},
    dist:{path:"fresh-private-tsc-outdir",sha256:$dist_sha,file_count:$dist_count},
    release_javascript:{typescript_bin_sha256:$tsc_sha,typescript_compiler_sha256:$compiler_sha,bcs_validator_sha256:$bcs_sha,rename_noreplace_helper_sha256:$rename_noreplace_sha}
  }' >"$closure_root/ops/evidence/release-executable-closure.json"

preflight=(bash "$repo_root/scripts/preflight_release_executable_closure.sh" \
  "$closure_root" "$closure_node" "$test_root/sdk-review-test-attestation.json" \
  "$sdk_review_test_signature" "$test_root/sdk-review-test-allowed-signers")
"${preflight[@]}" compiler >/dev/null
"${preflight[@]}" validation >/dev/null
if "${preflight[@]}" execution "$closure_root/fresh-dist" >/dev/null 2>&1; then
  printf 'production execution preflight accepted current-uid-owned emitted JavaScript\n' >&2
  exit 1
fi
if bash "$repo_root/scripts/preflight_release_executable_closure.sh" \
  "$closure_root" /bin/true "$test_root/sdk-review-test-attestation.json" \
  "$sdk_review_test_signature" "$test_root/sdk-review-test-allowed-signers" validation >/dev/null 2>&1; then
  printf '/bin/true was accepted as the reviewed Node runtime\n' >&2
  exit 1
fi
printf '#!/usr/bin/env sh\nexit 0\n' >"$test_root/fake-node"
chmod 0700 "$test_root/fake-node"
if bash "$repo_root/scripts/preflight_release_executable_closure.sh" \
  "$closure_root" "$test_root/fake-node" "$test_root/sdk-review-test-attestation.json" \
  "$sdk_review_test_signature" "$test_root/sdk-review-test-allowed-signers" validation >/dev/null 2>&1; then
  printf 'modified Node runtime was accepted\n' >&2
  exit 1
fi

expect_closure_rejection() {
  local label="$1" phase="$2"
  shift 2
  if "${preflight[@]}" "$phase" "$@" >/dev/null 2>&1; then
    printf 'tampered closure component was accepted: %s\n' "$label" >&2
    exit 1
  fi
}
cp "$closure_root/node_modules/@cedra-labs/ts-sdk/index.mjs" "$test_root/sdk-index.backup"
printf 'tamper\n' >>"$closure_root/node_modules/@cedra-labs/ts-sdk/index.mjs"
expect_closure_rejection SDK validation
cp "$test_root/sdk-index.backup" "$closure_root/node_modules/@cedra-labs/ts-sdk/index.mjs"
cp "$closure_root/node_modules/transitive-fixture/index.js" "$test_root/transitive.backup"
printf 'tamper\n' >>"$closure_root/node_modules/transitive-fixture/index.js"
expect_closure_rejection transitive validation
cp "$test_root/transitive.backup" "$closure_root/node_modules/transitive-fixture/index.js"
cp "$closure_root/node_modules/typescript/lib/tsc.js" "$test_root/typescript.backup"
printf 'tamper\n' >>"$closure_root/node_modules/typescript/lib/tsc.js"
expect_closure_rejection TypeScript compiler
cp "$test_root/typescript.backup" "$closure_root/node_modules/typescript/lib/tsc.js"
cp "$closure_root/scripts/rename_noreplace.py" "$test_root/rename-noreplace.backup"
printf '# tamper\n' >>"$closure_root/scripts/rename_noreplace.py"
expect_closure_rejection no-replace-helper validation
cp "$test_root/rename-noreplace.backup" "$closure_root/scripts/rename_noreplace.py"
cp "$closure_root/fresh-dist/scripts/assemble-testnet-transaction-candidate.js" "$test_root/dist.backup"
printf 'tamper\n' >>"$closure_root/fresh-dist/scripts/assemble-testnet-transaction-candidate.js"
read -r tampered_dist_sha tampered_dist_count < <(bash "$closure_root/scripts/release_tree_digest.sh" "$closure_root/fresh-dist")
[[ "$tampered_dist_sha" != "$fixture_dist_sha" && "$tampered_dist_count" == "$fixture_dist_count" ]] || {
  printf 'emitted-JS component digest did not detect tampering\n' >&2
  exit 1
}
cp "$test_root/dist.backup" "$closure_root/fresh-dist/scripts/assemble-testnet-transaction-candidate.js"

printf '{"schema_version":2,"transaction_identity":{"transactionBcsHex":"0xzz"}}\n' >"$test_root/malformed-bcs-candidate.json"
if "$node_bin" "$repo_root/scripts/validate_release_transaction_bcs.mjs" \
  "$test_root/malformed-bcs-candidate.json" \
  "$test_root/sdk-review-test-attestation.json" "$sdk_review_test_signature" \
  "$test_root/sdk-review-test-allowed-signers" >/dev/null 2>&1; then
  printf 'malformed candidate BCS was accepted\n' >&2
  exit 1
fi

# Collector must reject every pre-existing final path and an unsafe writable
# parent before it snapshots, validates, or performs any HTTPS request.
collector_snapshot_line="$(awk '/snapshot_release_inputs.py/ { print NR; exit }' \
  "$repo_root/scripts/collect_finalized_transaction_evidence.sh")"
collector_stage_line="$(awk '/stage=.*\.cedra-finalized-stage/ { print NR; exit }' \
  "$repo_root/scripts/collect_finalized_transaction_evidence.sh")"
[[ -n "$collector_snapshot_line" && -n "$collector_stage_line" \
  && "$collector_snapshot_line" -lt "$collector_stage_line" ]] || {
  printf 'collector creates same-parent staging before it snapshots release inputs\n' >&2
  exit 1
}
if rg -n '\$stage/inputs' "$repo_root/scripts/collect_finalized_transaction_evidence.sh" >/dev/null; then
  printf 'collector still routes immutable inputs through mutable publication staging\n' >&2
  exit 1
fi
collector_source="$test_root/collector-source"
mkdir -m 0700 "$collector_source"
printf '{}\n' >"$collector_source/transaction-candidate.json"
printf '{"candidate_file":"transaction-candidate.json"}\n' >"$collector_source/approval-envelope.json"
printf '{}\n' >"$collector_source/exact.json"
printf '{}\n' >"$collector_source/profile.json"
printf 'fixture trust\n' >"$collector_source/approval-trust"
mkdir -m 0700 "$test_root/existing-final"
collector_environment=(
  RELEASE_NODE_RUNTIME="$node_bin"
  SDK_REVIEW_ATTESTATION="$test_root/sdk-review-test-attestation.json"
  SDK_REVIEW_SIGNATURE="$sdk_review_test_signature"
  SDK_REVIEW_TRUSTED_SIGNERS="$test_root/sdk-review-test-allowed-signers"
)
mkdir -m 0700 "$test_root/elsewhere-envelope"
printf '{"candidate_file":"transaction-candidate.json"}\n' \
  >"$test_root/elsewhere-envelope/approval-envelope.json"
if env "${collector_environment[@]}" bash "$repo_root/scripts/collect_finalized_transaction_evidence.sh" \
  "$collector_source/transaction-candidate.json" \
  "$test_root/elsewhere-envelope/approval-envelope.json" \
  "$collector_source/approval-trust" "$collector_source/exact.json" "$collector_source/profile.json" \
  "0x$(printf '0%.0s' {1..64})" "$test_root/exact-envelope-rejection" >/dev/null 2>&1; then
  printf 'collector selected a nearby envelope instead of rejecting the exact supplied envelope path\n' >&2
  exit 1
fi
if env "${collector_environment[@]}" bash "$repo_root/scripts/collect_finalized_transaction_evidence.sh" \
  "$collector_source/transaction-candidate.json" "$collector_source/approval-envelope.json" \
  "$collector_source/approval-trust" "$collector_source/exact.json" "$collector_source/profile.json" \
  "0x$(printf '1%.0s' {1..64})" "$test_root/existing-final" >/dev/null 2>&1; then
  printf 'collector accepted a pre-existing final directory\n' >&2
  exit 1
fi
mkdir -m 0700 "$test_root/broad-parent"
chmod 0777 "$test_root/broad-parent"
if env "${collector_environment[@]}" bash "$repo_root/scripts/collect_finalized_transaction_evidence.sh" \
  "$collector_source/transaction-candidate.json" "$collector_source/approval-envelope.json" \
  "$collector_source/approval-trust" "$collector_source/exact.json" "$collector_source/profile.json" \
  "0x$(printf '2%.0s' {1..64})" "$test_root/broad-parent/final" >/dev/null 2>&1; then
  printf 'collector accepted a group/world-writable output parent\n' >&2
  exit 1
fi

# Templates are intentionally unapprovable and must fail closed.
if bash "$repo_root/scripts/validate_release_manifest.sh" \
  "$repo_root/ops/release-manifest.template.json" "$test_root/allowed-signers" >/dev/null 2>&1; then
  printf 'draft release manifest template was accepted\n' >&2
  exit 1
fi

printf 'release tooling local security tests passed\n'
