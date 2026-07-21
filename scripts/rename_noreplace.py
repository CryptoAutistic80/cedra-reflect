#!/usr/bin/env python3
"""Atomically publish one file or directory with Linux RENAME_NOREPLACE.

This helper is intentionally tiny and takes paths only as argv entries. It does
not invoke a shell and fails closed on non-Linux systems or libc implementations
without renameat2.
"""

from __future__ import annotations

import ctypes
import errno
import os
import stat
import sys


AT_FDCWD = -100
RENAME_NOREPLACE = 1


def fail(message: str, code: int = 65) -> "NoReturn":
    print(f"atomic no-replace publish failed: {message}", file=sys.stderr)
    raise SystemExit(code)


def main() -> int:
    if len(sys.argv) != 3:
        fail(f"usage: {sys.argv[0]} SOURCE_PATH DESTINATION_PATH", 64)
    if sys.platform != "linux":
        fail("Linux renameat2 is required; no portable fallback is permitted", 69)

    source = os.path.abspath(sys.argv[1])
    destination = os.path.abspath(sys.argv[2])
    if os.path.dirname(source) != os.path.dirname(destination):
        fail("source and destination must have the same parent")
    parent = os.path.dirname(source)
    if os.path.realpath(parent) != parent:
        fail("publish parent must not resolve through a symbolic link")
    try:
        source_stat = os.lstat(source)
    except OSError as exc:
        fail(f"cannot inspect source directory: {exc}", 66)
    if (not stat.S_ISDIR(source_stat.st_mode) and not stat.S_ISREG(source_stat.st_mode)) or stat.S_ISLNK(source_stat.st_mode):
        fail("source must be a real regular file or directory")

    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        fail("libc does not expose renameat2; refusing a racy fallback", 69)
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        AT_FDCWD,
        os.fsencode(source),
        AT_FDCWD,
        os.fsencode(destination),
        RENAME_NOREPLACE,
    )
    if result != 0:
        observed = ctypes.get_errno()
        if observed == errno.EEXIST:
            fail("destination already exists; no file or directory was replaced", 73)
        if observed in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP}:
            fail("kernel/filesystem does not support RENAME_NOREPLACE; refusing a racy fallback", 69)
        fail(os.strerror(observed), 74)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
