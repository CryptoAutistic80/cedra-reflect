#!/usr/bin/env python3
"""Render and exclusively publish a canonical approval statement.

The destination is reached relative to held directory descriptors, the parent
must be a private directory owned by the invoking euid, and publication uses
an unnamed O_TMPFILE plus kernel no-replace linkat from the held descriptor.
Existing paths are never opened, truncated, or replaced.
"""

from __future__ import annotations

import ctypes
import errno
import importlib.util
import os
import stat
import sys
from pathlib import Path
from types import ModuleType
from typing import NoReturn


AT_EMPTY_PATH = 0x1000
AT_FDCWD = -100
AT_SYMLINK_FOLLOW = 0x400


def fail(message: str, code: int = 66) -> NoReturn:
    print(f"secure approval statement rejected: {message}", file=sys.stderr)
    raise SystemExit(code)


def open_absolute_directory(path: str) -> tuple[int, str]:
    if not os.path.isabs(path):
        fail("output path must be absolute")
    normalized = os.path.normpath(path)
    if normalized != path:
        fail("output path must already be normalized")
    components = [component for component in path.split("/") if component]
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    traversed = ""
    try:
        for component in components:
            traversed += "/" + component
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
            info = os.fstat(descriptor)
            if not stat.S_ISDIR(info.st_mode):
                fail(f"output ancestor is not a directory: {traversed}")
        return descriptor, traversed or "/"
    except BaseException:
        os.close(descriptor)
        raise


def load_release_evidence(repo_root: Path) -> ModuleType:
    module_path = repo_root / "scripts" / "release_evidence.py"
    spec = importlib.util.spec_from_file_location("cedra_release_evidence", module_path)
    if spec is None or spec.loader is None:
        fail("cannot load the authenticated release-evidence module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            fail("short write while rendering approval statement", 74)
        offset += written


def publish_unnamed_file(file_descriptor: int, parent_descriptor: int, name: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    linkat = libc.linkat
    linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    linkat.restype = ctypes.c_int
    encoded_name = os.fsencode(name)
    if linkat(file_descriptor, b"", parent_descriptor, encoded_name, AT_EMPTY_PATH) == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.EEXIST:
        fail(f"refusing to overwrite approval statement: {name}")
    if error_number not in {errno.ENOENT, errno.EPERM, errno.EINVAL}:
        fail(f"kernel no-replace publication failed: {os.strerror(error_number)}", 74)

    # Some kernels/filesystem mounts disallow AT_EMPTY_PATH for an
    # unprivileged caller. /proc/self/fd still names this exact held unnamed
    # inode; AT_SYMLINK_FOLLOW links its target to the held destination dirfd.
    proc_descriptor = os.fsencode(f"/proc/self/fd/{file_descriptor}")
    if linkat(AT_FDCWD, proc_descriptor, parent_descriptor, encoded_name, AT_SYMLINK_FOLLOW) != 0:
        fallback_error = ctypes.get_errno()
        if fallback_error == errno.EEXIST:
            fail(f"refusing to overwrite approval statement: {name}")
        fail(f"kernel no-replace publication failed: {os.strerror(fallback_error)}", 74)


def main() -> None:
    if len(sys.argv) != 6:
        fail(
            f"usage: {sys.argv[0]} REPOSITORY_ROOT CANDIDATE_JSON "
            "EXACT_ADDRESS_JSON PUBLIC_PROFILE_JSON OUTPUT_JSON",
            64,
        )
    repo_root = Path(sys.argv[1])
    candidate = Path(sys.argv[2])
    exact = Path(sys.argv[3])
    profile = Path(sys.argv[4])
    output = sys.argv[5]
    output_parent, output_name = os.path.split(output)
    if not output_parent or not output_name or output_name in {".", ".."} or "/" in output_name:
        fail("output must have a safe basename and explicit absolute parent")

    parent_descriptor, rendered_parent = open_absolute_directory(output_parent)
    unnamed_descriptor = -1
    published = False
    try:
        parent_info = os.fstat(parent_descriptor)
        if parent_info.st_uid != os.geteuid() or stat.S_IMODE(parent_info.st_mode) != 0o700:
            fail("output parent must be owned by the current euid with exact mode 0700")
        try:
            os.stat(output_name, dir_fd=parent_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail(f"refusing to overwrite approval statement: {output}")

        unnamed_descriptor = os.open(
            ".",
            os.O_RDWR | os.O_CLOEXEC | os.O_TMPFILE,
            0o600,
            dir_fd=parent_descriptor,
        )
        evidence = load_release_evidence(repo_root)
        statement = evidence.approval_statement(candidate, exact, profile)
        payload = evidence.canonical_json_bytes(statement)
        write_all(unnamed_descriptor, payload)
        os.fchmod(unnamed_descriptor, 0o600)
        os.fsync(unnamed_descriptor)
        publish_unnamed_file(unnamed_descriptor, parent_descriptor, output_name)
        published = True
        try:
            os.fsync(parent_descriptor)
        except OSError as exc:
            fail(
                f"statement was published at {rendered_parent}/{output_name}, "
                f"but directory durability is unknown: {exc}",
                74,
            )
    except OSError as exc:
        location = f" after publication at {rendered_parent}/{output_name}" if published else ""
        fail(f"filesystem operation failed{location}: {exc}", 74)
    finally:
        if unnamed_descriptor >= 0:
            os.close(unnamed_descriptor)
        os.close(parent_descriptor)

    print(f"canonical approval statement: {rendered_parent}/{output_name}")


if __name__ == "__main__":
    main()
