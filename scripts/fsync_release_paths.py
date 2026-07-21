#!/usr/bin/env python3
"""Fsync explicitly named regular files or directories without link following."""

from __future__ import annotations

import os
import stat
import sys


if len(sys.argv) < 2:
    raise SystemExit(f"usage: {sys.argv[0]} PATH [PATH ...]")

for path in sys.argv[1:]:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        mode = os.fstat(descriptor).st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise SystemExit(f"cannot fsync unsupported release path: {path}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
