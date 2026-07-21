#!/usr/bin/env python3
"""Fail closed unless a release root is root-owned and immutable to this uid.

This is a filesystem predicate, not proof that the surrounding account or
container is isolated. The operator must separately establish that human gate.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"isolated release root rejected: {message}")


def validate_metadata(path: Path, info: os.stat_result) -> None:
    if info.st_uid != 0:
        fail(f"path is not owned by root: {path}")
    if info.st_mode & 0o022:
        fail(f"path is group/world-writable: {path}")
    kind = stat.S_IFMT(info.st_mode)
    if kind not in {stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK}:
        fail(f"unsupported filesystem object: {path}")
    if not stat.S_ISLNK(info.st_mode) and os.access(path, os.W_OK, follow_symlinks=False):
        fail(f"path is writable by the release euid, including through ACLs: {path}")


def main() -> None:
    if len(sys.argv) != 2:
        fail(f"usage: {sys.argv[0]} RELEASE_ROOT")
    if os.geteuid() == 0:
        fail("release commands must not run as root; use a dedicated unprivileged release uid")

    supplied = Path(sys.argv[1])
    if not supplied.is_absolute():
        fail("release root must be an absolute path")
    absolute = Path(os.path.abspath(supplied))
    if Path(os.path.realpath(absolute)) != absolute:
        fail("release root or an ancestor resolves through a symbolic link")

    ancestors = list(absolute.parents)
    ancestors.reverse()
    for path in [*ancestors, absolute]:
        try:
            info = os.lstat(path)
        except OSError as exc:
            fail(f"cannot inspect ancestor {path}: {exc}")
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail(f"release-root ancestor is not a real directory: {path}")
        validate_metadata(path, info)

    for directory, names, files, directory_fd in os.fwalk(
        absolute,
        topdown=True,
        follow_symlinks=False,
    ):
        directory_path = Path(directory)
        directory_info = os.fstat(directory_fd)
        validate_metadata(directory_path, directory_info)
        for name in [*names, *files]:
            try:
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except OSError as exc:
                fail(f"cannot inspect {directory_path / name}: {exc}")
            path = directory_path / name
            validate_metadata(path, info)
            if stat.S_ISLNK(info.st_mode):
                resolved = Path(os.path.realpath(path))
                try:
                    resolved.relative_to(absolute)
                except ValueError:
                    fail(f"symbolic link escapes the isolated release root: {path}")
                if not resolved.exists():
                    fail(f"symbolic link target is missing: {path}")

    print(f"isolated root-owned release filesystem verified: {absolute}")


if __name__ == "__main__":
    main()
