#!/usr/bin/env python3
"""Verify the reviewed Cedra SDK pin directly from its npm tarball.

The tarball is an explicit operator input. This script performs no network
request and never extracts archive paths to disk.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path
from typing import Any, NoReturn


PACKAGE = "@cedra-labs/ts-sdk"
VERSION = "2.2.8"
LOCK_KEY = "node_modules/@cedra-labs/ts-sdk"
ENTRYPOINT = "dist/esm/index.mjs"
ALGORITHM = "sha256(depth_first_lexicographic_path_components(sha256(file_bytes) NUL decimal_byte_length NUL posix_relative_path LF))"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SHA512_RE = re.compile(r"^sha512-[A-Za-z0-9+/]+={0,2}$")


def fail(message: str) -> NoReturn:
    print(f"reviewed SDK pin validation failed: {message}", file=sys.stderr)
    raise SystemExit(65)


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"cannot load {label}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def main() -> int:
    if len(sys.argv) != 4:
        print(f"usage: {sys.argv[0]} REVIEWED_PIN_JSON PACKAGE_LOCK_JSON SDK_TARBALL", file=sys.stderr)
        return 64
    pin_path, lock_path, tarball_path = map(Path, sys.argv[1:])
    for path, label in ((pin_path, "review pin"), (lock_path, "package lock"), (tarball_path, "SDK tarball")):
        try:
            stat = path.lstat()
        except OSError as exc:
            fail(f"cannot inspect {label}: {exc}")
        if not path.is_file() or path.is_symlink() or stat.st_nlink < 1:
            fail(f"{label} must be a regular non-symlink file")

    pin = load_object(pin_path, "review pin")
    expected_keys = {
        "schema_version", "evidence_scope", "package_name", "package_version",
        "registry_tarball_url", "npm_tarball_sha512_integrity", "npm_tarball_sha256",
        "package_tree_digest_algorithm", "sdk_package_json_sha256", "sdk_loaded_entrypoint",
        "sdk_loaded_entrypoint_sha256", "sdk_package_tree_sha256", "sdk_package_file_count",
    }
    if set(pin) != expected_keys:
        fail("review pin has missing or unexpected fields")
    lock = load_object(lock_path, "package lock")
    locked = lock.get("packages", {}).get(LOCK_KEY) if isinstance(lock.get("packages"), dict) else None
    if not isinstance(locked, dict):
        fail("package lock has no Cedra SDK entry")
    if pin["schema_version"] != 1 or pin["evidence_scope"] != "reviewed-npm-sdk-artifact":
        fail("review pin has the wrong version or scope")
    if pin["package_name"] != PACKAGE or pin["package_version"] != VERSION:
        fail("review pin has the wrong package identity")
    if pin["registry_tarball_url"] != f"https://registry.npmjs.org/@cedra-labs/ts-sdk/-/ts-sdk-{VERSION}.tgz":
        fail("review pin has the wrong canonical registry tarball URL")
    integrity = pin["npm_tarball_sha512_integrity"]
    if not isinstance(integrity, str) or not SHA512_RE.fullmatch(integrity):
        fail("review pin SHA-512 integrity is invalid")
    if locked.get("version") != VERSION or locked.get("integrity") != integrity:
        fail("review pin differs from the reviewed package-lock SDK entry")
    if pin["package_tree_digest_algorithm"] != ALGORITHM or pin["sdk_loaded_entrypoint"] != ENTRYPOINT:
        fail("review pin uses an unsupported tree algorithm or entrypoint")

    try:
        tarball = tarball_path.read_bytes()
    except OSError as exc:
        fail(f"cannot read SDK tarball: {exc}")
    observed_integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode("ascii")
    if observed_integrity != integrity:
        fail("tarball SHA-512 does not match package-lock/review pin")
    if sha256(tarball) != pin["npm_tarball_sha256"]:
        fail("tarball SHA-256 does not match review pin")

    records: list[tuple[tuple[str, ...], bytes]] = []
    package_json: bytes | None = None
    entrypoint: bytes | None = None
    try:
        with tarfile.open(tarball_path, "r:gz") as archive:
            members = archive.getmembers()
            for member in members:
                if member.isdir():
                    continue
                if not member.isfile() or member.issym() or member.islnk():
                    fail(f"tarball contains a non-regular entry: {member.name}")
                if not member.name.startswith("package/"):
                    fail(f"tarball entry escapes the package prefix: {member.name}")
                relative = member.name.removeprefix("package/")
                if not relative or relative.startswith("/") or ".." in relative.split("/"):
                    fail(f"tarball entry has an unsafe path: {member.name}")
                extracted = archive.extractfile(member)
                if extracted is None:
                    fail(f"cannot read tarball entry: {member.name}")
                data = extracted.read()
                if len(data) != member.size:
                    fail(f"tarball entry size mismatch: {member.name}")
                records.append((tuple(relative.split("/")), f"{sha256(data)}\0{len(data)}\0{relative}\n".encode("utf-8")))
                if relative == "package.json":
                    package_json = data
                if relative == ENTRYPOINT:
                    entrypoint = data
    except (OSError, tarfile.TarError) as exc:
        fail(f"cannot parse SDK tarball: {exc}")
    records.sort(key=lambda record: record[0])
    if package_json is None or entrypoint is None:
        fail("tarball omits package.json or the reviewed loaded entrypoint")
    try:
        manifest = json.loads(package_json)
    except (UnicodeError, json.JSONDecodeError) as exc:
        fail(f"tarball package.json is invalid: {exc}")
    if not isinstance(manifest, dict) or manifest.get("name") != PACKAGE or manifest.get("version") != VERSION:
        fail("tarball package.json has the wrong identity")
    observed = {
        "sdk_package_json_sha256": sha256(package_json),
        "sdk_loaded_entrypoint_sha256": sha256(entrypoint),
        "sdk_package_tree_sha256": sha256(b"".join(record for _, record in records)),
        "sdk_package_file_count": len(records),
    }
    for field, value in observed.items():
        if pin.get(field) != value:
            fail(f"tarball differs from review pin for {field}")
    for field in ("npm_tarball_sha256", "sdk_package_json_sha256", "sdk_loaded_entrypoint_sha256", "sdk_package_tree_sha256"):
        if not isinstance(pin[field], str) or not SHA256_RE.fullmatch(pin[field]):
            fail(f"review pin {field} is not a SHA-256 digest")
    print(f"valid independently reviewable {PACKAGE} {VERSION} npm artifact pin: {pin_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
