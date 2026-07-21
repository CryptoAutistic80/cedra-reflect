#!/usr/bin/env python3
"""Copy one regular file without following links or replacing a destination."""

from __future__ import annotations

import os
import shutil
import stat
import sys


if len(sys.argv) != 3:
    raise SystemExit(f"usage: {sys.argv[0]} SOURCE DESTINATION")

source, destination = sys.argv[1:]
source_fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
try:
    source_stat = os.fstat(source_fd)
    if not stat.S_ISREG(source_stat.st_mode):
        raise SystemExit(f"source is not a regular non-symlink file: {source}")
    destination_fd = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        with os.fdopen(os.dup(source_fd), "rb") as reader:
            with os.fdopen(os.dup(destination_fd), "wb") as writer:
                shutil.copyfileobj(reader, writer, length=1024 * 1024)
                writer.flush()
        os.fchmod(destination_fd, 0o600)
        os.fsync(destination_fd)
    finally:
        os.close(destination_fd)
finally:
    os.close(source_fd)
