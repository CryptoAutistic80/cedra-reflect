#!/usr/bin/env python3
"""Dependency-free structural checks for the repository's local JSON schemas.

This is intentionally not a replacement for a full Draft 2020-12 validator.
It catches malformed JSON, unresolved local references, duplicate/missing
required properties, invalid regular expressions, and malformed combinators
without introducing an undeclared Python package dependency.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


DRAFT = "https://json-schema.org/draft/2020-12/schema"


def fail(path: Path, location: str, message: str) -> None:
    raise ValueError(f"{path}:{location}: {message}")


def resolve_pointer(document: Any, pointer: str, path: Path, location: str) -> Any:
    if not pointer.startswith("#/"):
        fail(path, location, f"only local JSON Pointer references are allowed: {pointer}")
    value = document
    for token in pointer[2:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            fail(path, location, f"unresolved local reference: {pointer}")
        value = value[token]
    return value


def walk(schema: Any, document: dict[str, Any], path: Path, location: str = "#") -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        fail(path, location, "schema node must be an object or boolean")
    if "$ref" in schema:
        reference = schema["$ref"]
        if not isinstance(reference, str):
            fail(path, location, "$ref must be a string")
        resolve_pointer(document, reference, path, location)
    if "pattern" in schema:
        try:
            re.compile(schema["pattern"])
        except (TypeError, re.error) as exc:
            fail(path, location, f"invalid pattern: {exc}")
    required = schema.get("required")
    properties = schema.get("properties")
    if required is not None:
        if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
            fail(path, location, "required must be a string array")
        if len(set(required)) != len(required):
            fail(path, location, "required contains duplicates")
        if isinstance(properties, dict):
            missing = set(required) - set(properties)
            if missing:
                fail(path, location, f"required properties are undefined: {sorted(missing)}")
    if properties is not None and not isinstance(properties, dict):
        fail(path, location, "properties must be an object")
    for keyword in ("oneOf", "anyOf", "allOf"):
        if keyword in schema and (not isinstance(schema[keyword], list) or not schema[keyword]):
            fail(path, location, f"{keyword} must be a non-empty array")
    for key, value in schema.items():
        child = f"{location}/{key}"
        if key in ("properties", "$defs") and isinstance(value, dict):
            for name, nested in value.items():
                walk(nested, document, path, f"{child}/{name}")
        elif key in ("items", "additionalProperties", "not") and isinstance(value, (dict, bool)):
            walk(value, document, path, child)
        elif key in ("oneOf", "anyOf", "allOf") and isinstance(value, list):
            for index, nested in enumerate(value):
                walk(nested, document, path, f"{child}/{index}")


def check(path: Path) -> None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path}: invalid schema JSON: {exc}") from exc
    if not isinstance(document, dict) or document.get("$schema") != DRAFT:
        fail(path, "#", f"$schema must be {DRAFT}")
    walk(document, document, path)


def main() -> int:
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} SCHEMA_JSON [SCHEMA_JSON ...]", file=sys.stderr)
        return 64
    try:
        for argument in sys.argv[1:]:
            check(Path(argument))
    except ValueError as exc:
        print(f"schema check failed: {exc}", file=sys.stderr)
        return 65
    print(f"checked {len(sys.argv) - 1} local Draft 2020-12 schema(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
