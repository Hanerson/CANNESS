#!/usr/bin/env python3
"""Retain recent completed evaluation and submission validation attempts."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys


UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
EVAL_ATTEMPT = re.compile(r'attempt-' + UUID)
VALIDATION_ATTEMPT = re.compile(r'submission-validation-' + UUID)
GENERATION = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*')
EVAL_STATUSES = ('pass', 'compile_fail', 'accuracy_fail', 'perf_fail', 'timeout', 'error')
VALIDATION_STATUSES = ('installed', 'validated', 'partial', 'failed', 'blocked', 'unsupported')


def plain_type(path: Path, check) -> bool:
    try:
        details = path.lstat()
    except OSError:
        return False
    attributes = getattr(details, 'st_file_attributes', 0)
    return check(details.st_mode) and not attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT


@contextmanager
def pinned_directory(path: Path):
    """Anchor remote Linux operations to directory descriptors without following links."""
    if sys.platform != 'linux':
        if not all(plain_type(part, stat.S_ISDIR) for part in (path, *path.parents)):
            raise NotADirectoryError(str(path))
        yield path
        return

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(path.anchor, flags)
    try:
        for part in path.parts[1:]:
            child_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child_fd
        # rmtree checks inodes during recursion, and this kernel path also
        # keeps the parent anchored on Python 3.10, before rmtree had dir_fd.
        yield Path(f'/proc/self/fd/{fd}')
    finally:
        os.close(fd)


def regular_file_open(path, flags):
    return os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))


def completion_time(path: Path, generation: str | None) -> int | None:
    try:
        with pinned_directory(path.parent) as parent:
            marker = parent / path.name
            if not plain_type(marker, stat.S_ISREG):
                return None
            with open(marker, encoding='utf-8', opener=regular_file_open) as stream:
                details = os.fstat(stream.fileno())
                if not stat.S_ISREG(details.st_mode):
                    return None
                report = json.load(stream)
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(report, dict):
        return None
    if generation is not None:
        completed = report.get('generationId') == generation and report.get('status') in EVAL_STATUSES
    else:
        completed = report.get('status') in VALIDATION_STATUSES
    return details.st_mtime_ns if completed else None


def attempt_names(path: Path, pattern: re.Pattern[str]) -> list[str]:
    try:
        with pinned_directory(path) as parent:
            return [child.name for child in parent.iterdir()
                    if pattern.fullmatch(child.name) and plain_type(child, stat.S_ISDIR)]
    except OSError:
        return []


def ignore_already_removed(_operation, _path, error):
    if not isinstance(error[1], FileNotFoundError):
        raise error[1]


def remove_attempt(path: Path) -> None:
    try:
        with pinned_directory(path.parent) as parent:
            attempt = parent / path.name
            if plain_type(attempt, stat.S_ISDIR):
                shutil.rmtree(attempt, onerror=ignore_already_removed)
    except (FileNotFoundError, NotADirectoryError):
        # Another cleanup may have removed the same attempt first.
        pass


def prune(inbox: Path, outbox: Path | None, generation: str | None, current: str, keep: int) -> None:
    if keep == 0:
        return
    completed = []
    if generation is not None and outbox is not None:
        for name in attempt_names(inbox / generation, EVAL_ATTEMPT):
            outgoing = outbox / generation / name
            timestamp = completion_time(outgoing / generation / 'results.json', generation)
            if timestamp is not None:
                completed.append((timestamp, name, (inbox / generation / name, outgoing)))
    else:
        for name in attempt_names(inbox, VALIDATION_ATTEMPT):
            attempt = inbox / name
            timestamp = completion_time(attempt / 'validation-result.json', None)
            if timestamp is not None:
                completed.append((timestamp, name, (attempt,)))

    for _, name, paths in sorted(completed, reverse=True)[keep:]:
        if name == current:
            continue
        if any(path == root or path in root.parents for path in paths for root in (inbox, outbox) if root is not None):
            continue
        for path in dict.fromkeys(paths):
            remove_attempt(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    eval_parser = modes.add_parser('eval')
    eval_parser.add_argument('--outbox', required=True)
    eval_parser.add_argument('--generation', required=True)
    validation_parser = modes.add_parser('validation')
    for mode in (eval_parser, validation_parser):
        mode.add_argument('--inbox', required=True)
        mode.add_argument('--current', required=True)
        mode.add_argument('--keep', type=int, required=True)
    args = parser.parse_args()
    generation = getattr(args, 'generation', None)
    outbox = getattr(args, 'outbox', None)
    for root in (args.inbox, outbox):
        if root is not None and (not root or '..' in Path(root).parts):
            parser.error('cleanup roots must be nonempty paths without parent traversal')
    pattern = EVAL_ATTEMPT if args.mode == 'eval' else VALIDATION_ATTEMPT
    if not pattern.fullmatch(args.current) or (generation is not None and not GENERATION.fullmatch(generation)):
        parser.error('invalid current attempt or generation name')
    if args.keep < 0:
        parser.error('--keep must be nonnegative')
    prune(Path(args.inbox).absolute(), Path(outbox).absolute() if outbox is not None else None,
          generation, args.current, args.keep)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
