#!/usr/bin/env python3
"""Decode the security-relevant prefix of Cedra PackageMetadata BCS.

The decoded values are the framework fields committed by package-metadata.bcs;
they are deliberately distinct from this repository's custom source digests.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise ValueError(message)


def read_uleb128(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    for _ in range(5):
        if offset >= len(data):
            fail("truncated ULEB128")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte & 0x80 == 0:
            if value < 0x80 and shift > 0:
                fail("non-canonical ULEB128")
            return value, offset
        shift += 7
    fail("oversized ULEB128")


def read_bytes(data: bytes, offset: int, length: int, label: str) -> tuple[bytes, int]:
    end = offset + length
    if length < 0 or end > len(data):
        fail(f"truncated {label}")
    return data[offset:end], end


def read_string(data: bytes, offset: int, label: str) -> tuple[str, int]:
    length, offset = read_uleb128(data, offset)
    raw, offset = read_bytes(data, offset, length, label)
    try:
        return raw.decode("utf-8"), offset
    except UnicodeDecodeError as exc:
        fail(f"{label} is not UTF-8: {exc}")


def decode(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    name, offset = read_string(data, 0, "package name")
    if offset >= len(data):
        fail("truncated upgrade policy")
    policy = data[offset]
    offset += 1
    raw_upgrade, offset = read_bytes(data, offset, 8, "upgrade number")
    upgrade_number = struct.unpack("<Q", raw_upgrade)[0]
    source_digest, offset = read_string(data, offset, "source digest")
    if re.fullmatch(r"[0-9A-F]{64}", source_digest) is None:
        fail("embedded source_digest is not 64 uppercase hexadecimal characters")
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name) is None:
        fail("embedded package name is invalid")
    if policy not in (0, 1, 2):
        fail("embedded upgrade policy is unsupported")
    if offset >= len(data):
        fail("PackageMetadata contains no manifest/modules after the decoded header")
    return {
        "name": name,
        "upgrade_policy_number": policy,
        "upgrade_number": str(upgrade_number),
        "source_digest": source_digest,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package_metadata_bcs", type=Path)
    args = parser.parse_args()
    try:
        result = decode(args.package_metadata_bcs)
    except (OSError, ValueError) as exc:
        print(f"package metadata decode failed: {exc}", file=sys.stderr)
        return 65
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
