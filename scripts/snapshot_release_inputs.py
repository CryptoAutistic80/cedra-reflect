#!/usr/bin/env python3
"""Fd-pin and copy bounded release inputs into a new private snapshot.

Sources are opened relative to held directory descriptors with O_NOFOLLOW.
Every file is read to a preflighted bound, checked for growth, and fstat'ed
before and after. Directory descriptors are likewise checked for concurrent
entry mutation. Destination files use O_EXCL and are fsynced before their
directories. The exact bytes written are the only bytes callers subsequently
validate.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

MAX_FILES = 20_000
MAX_BYTES = 1 << 30
CHUNK = 1024 * 1024


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def stable_identity(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_gid,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def safe_name(value: str) -> str:
    if (
        not value
        or value in {".", ".."}
        or "/" in value
        or "\x00" in value
        or any(character in value for character in "\n\r\t")
    ):
        fail(f"unsafe snapshot name: {value!r}")
    return value


def open_parent_directory(path: Path, label: str) -> tuple[int, str]:
    """Open an absolute normalized path's parent without following symlinks."""
    raw = os.fspath(path)
    if not os.path.isabs(raw) or os.path.normpath(raw) != raw:
        fail(f"{label} must be an absolute normalized path: {path}")
    components = [component for component in raw.split("/") if component]
    if not components:
        fail(f"{label} must not be the filesystem root")
    final_name = safe_name(components.pop())
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in components:
            safe_name(component)
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor, final_name


@dataclass
class Budget:
    files: int = 0
    bytes: int = 0

    def reserve(self, size: int) -> None:
        if size < 0 or size > MAX_BYTES - self.bytes:
            fail("release snapshot exceeds the bounded byte limit")
        if self.files >= MAX_FILES:
            fail("release snapshot exceeds the bounded file-count limit")
        self.files += 1
        self.bytes += size


def write_all(descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written <= 0:
            fail("short write while creating release snapshot")
        offset += written


def copy_file_descriptors(
    source_fd: int,
    destination_parent_fd: int,
    destination_name: str,
    budget: Budget,
    label: str,
) -> None:
    before = os.fstat(source_fd)
    if not stat.S_ISREG(before.st_mode):
        fail(f"snapshot source is not a regular file: {label}")
    budget.reserve(before.st_size)
    destination_fd = os.open(
        destination_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=destination_parent_fd,
    )
    try:
        remaining = before.st_size
        while remaining:
            data = os.read(source_fd, min(CHUNK, remaining))
            if not data:
                fail(f"snapshot source shrank while being read: {label}")
            write_all(destination_fd, data)
            remaining -= len(data)
        if os.read(source_fd, 1):
            fail(f"snapshot source grew while being read: {label}")
        after = os.fstat(source_fd)
        if stable_identity(before) != stable_identity(after):
            fail(f"snapshot source changed while being read: {label}")
        os.fchmod(destination_fd, 0o600)
        os.fsync(destination_fd)
    finally:
        os.close(destination_fd)


def copy_directory_fd(
    source_fd: int,
    destination_parent_fd: int,
    destination_name: str,
    budget: Budget,
    label: str,
) -> None:
    before = os.fstat(source_fd)
    if not stat.S_ISDIR(before.st_mode):
        fail(f"snapshot source is not a directory: {label}")
    budget.reserve(0)
    os.mkdir(destination_name, mode=0o700, dir_fd=destination_parent_fd)
    destination_fd = os.open(
        destination_name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
        dir_fd=destination_parent_fd,
    )
    try:
        names: list[str] = []
        with os.scandir(source_fd) as entries:
            for entry in entries:
                if len(names) >= MAX_FILES - budget.files:
                    fail("release snapshot exceeds the bounded entry-count limit")
                names.append(entry.name)
        names.sort()
        for name in names:
            safe_name(name)
            child_label = f"{label}/{name}"
            child_info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            if stat.S_ISLNK(child_info.st_mode):
                fail(f"snapshot tree contains a symbolic link: {child_label}")
            if stat.S_ISDIR(child_info.st_mode):
                child_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                    dir_fd=source_fd,
                )
                try:
                    if stable_identity(child_info) != stable_identity(os.fstat(child_fd)):
                        fail(f"snapshot directory was replaced while opening: {child_label}")
                    copy_directory_fd(child_fd, destination_fd, name, budget, child_label)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(child_info.st_mode):
                child_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                    dir_fd=source_fd,
                )
                try:
                    if stable_identity(child_info) != stable_identity(os.fstat(child_fd)):
                        fail(f"snapshot file was replaced while opening: {child_label}")
                    copy_file_descriptors(child_fd, destination_fd, name, budget, child_label)
                finally:
                    os.close(child_fd)
            else:
                fail(f"snapshot tree contains an unsupported entry: {child_label}")
        after_names: list[str] = []
        with os.scandir(source_fd) as entries:
            for entry in entries:
                if len(after_names) >= len(names) + 1:
                    fail(f"snapshot directory entries changed while being read: {label}")
                after_names.append(entry.name)
        after_names.sort()
        if after_names != names:
            fail(f"snapshot directory entries changed while being read: {label}")
        after = os.fstat(source_fd)
        if stable_identity(before) != stable_identity(after):
            fail(f"snapshot directory changed while being read: {label}")
        os.fchmod(destination_fd, 0o700)
        os.fsync(destination_fd)
    finally:
        os.close(destination_fd)


def copy_binding(source: Path, destination_fd: int, name: str, budget: Budget) -> None:
    source_parent_fd, source_name = open_parent_directory(source, "snapshot source")
    try:
        source_info = os.stat(source_name, dir_fd=source_parent_fd, follow_symlinks=False)
    except OSError as exc:
        os.close(source_parent_fd)
        fail(f"cannot inspect snapshot source {source}: {exc}")
    try:
        if stat.S_ISLNK(source_info.st_mode):
            fail(f"snapshot source must not be a symbolic link: {source}")
        if stat.S_ISDIR(source_info.st_mode):
            source_fd = os.open(
                source_name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=source_parent_fd,
            )
            try:
                if stable_identity(source_info) != stable_identity(os.fstat(source_fd)):
                    fail(f"snapshot directory was replaced while opening: {source}")
                copy_directory_fd(source_fd, destination_fd, name, budget, str(source))
            finally:
                os.close(source_fd)
        elif stat.S_ISREG(source_info.st_mode):
            source_fd = os.open(
                source_name,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=source_parent_fd,
            )
            try:
                if stable_identity(source_info) != stable_identity(os.fstat(source_fd)):
                    fail(f"snapshot file was replaced while opening: {source}")
                copy_file_descriptors(source_fd, destination_fd, name, budget, str(source))
            finally:
                os.close(source_fd)
        else:
            fail(f"unsupported snapshot source type: {source}")
    finally:
        os.close(source_parent_fd)


def main() -> None:
    if len(sys.argv) < 3:
        fail(f"usage: {sys.argv[0]} DESTINATION NAME=SOURCE [NAME=SOURCE ...]")
    destination = Path(sys.argv[1])
    destination_parent_fd, destination_name = open_parent_directory(destination, "snapshot destination")
    try:
        os.mkdir(destination_name, mode=0o700, dir_fd=destination_parent_fd)
        destination_fd = os.open(
            destination_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=destination_parent_fd,
        )
    except FileExistsError:
        os.close(destination_parent_fd)
        fail(f"snapshot destination already exists: {destination}")
    except BaseException:
        os.close(destination_parent_fd)
        raise
    try:
        seen: set[str] = set()
        budget = Budget()
        for binding in sys.argv[2:]:
            if "=" not in binding:
                fail(f"invalid snapshot binding: {binding}")
            raw_name, raw_source = binding.split("=", 1)
            name = safe_name(raw_name)
            if name in seen:
                fail(f"duplicate snapshot name: {name}")
            seen.add(name)
            source = Path(raw_source)
            if not source.is_absolute():
                fail(f"snapshot source must be absolute: {source}")
            copy_binding(source, destination_fd, name, budget)
        os.fchmod(destination_fd, 0o700)
        os.fsync(destination_fd)
    except BaseException:
        os.close(destination_fd)
        os.close(destination_parent_fd)
        shutil.rmtree(destination, ignore_errors=True)
        raise
    else:
        os.close(destination_fd)
        os.fsync(destination_parent_fd)
        os.close(destination_parent_fd)


if __name__ == "__main__":
    main()
