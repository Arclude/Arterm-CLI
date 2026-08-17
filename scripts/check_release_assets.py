#!/usr/bin/env python3
"""Validate the asset set a release is about to publish.

The release workflow splits platforms into REQUIRED (what `install.sh` and the
Homebrew formula resolve) and optional (everything else). That split is right --
Windows needs a signing profile this repository does not always have and FreeBSD
builds in a VM that fails on its own -- but "optional" was implemented as
"silently absent", and the two meanings are not the same thing.

What that cost: `arterm-windows-aarch64.{exe,tar.gz}` stopped building at v0.10.4
and nobody noticed for three releases. Every run reported success, because a
failed optional build is not a failed release. The usual defence -- diff this
tag's assets against the previous tag -- cannot see it either: once a platform
has been missing for two releases running, consecutive tags agree.

So optional platforms are ratcheted instead:

- REQUIRED missing                      -> fail. Unchanged.
- optional missing, shipped last time   -> fail. A platform that regressed.
- optional missing, listed as a gap     -> report it. Known, with a reason.
- listed as a gap but present           -> fail. The gap closed; drop the entry
                                          so the next regression is caught.

The last rule is what keeps this honest. Without it a gap entry is a permanent
excuse, and the file drifts back into describing a repository that no longer
exists.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
INVENTORY_FILE = REPO_ROOT / "scripts" / "release_assets.json"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate release asset coverage")
    parser.add_argument(
        "--artifacts",
        default="artifacts",
        help="directory the platform build jobs downloaded into",
    )
    parser.add_argument(
        "--previous-assets",
        help=(
            "file listing the previous release's asset names, one per line. "
            "Omit when there is no previous release; the regression check is "
            "then skipped rather than guessed at."
        ),
    )
    parser.add_argument(
        "--inventory",
        default=str(INVENTORY_FILE),
        help="path to release_assets.json",
    )
    return parser.parse_args(argv)


def load_inventory(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    for key in ("required", "optional"):
        if not isinstance(data.get(key), list):
            raise ValueError(f"{path}: '{key}' must be a list")
    if not isinstance(data.get("known_gaps", {}), dict):
        raise ValueError(f"{path}: 'known_gaps' must be an object")
    unknown = set(data.get("known_gaps", {})) - set(data["optional"])
    if unknown:
        raise ValueError(
            f"{path}: known_gaps names assets that are not optional: {sorted(unknown)}"
        )
    return data


def read_previous_assets(path: Path | None) -> set[str] | None:
    """Asset *names* from the previous release, or None when unknown.

    None and the empty set mean different things: no previous release to compare
    against versus a previous release that published nothing. Only the second
    should let a regression through silently, and it cannot happen in practice.
    """
    if path is None:
        return None
    return {line.strip() for line in path.read_text().splitlines() if line.strip()}


def check(
    *,
    inventory: dict[str, Any],
    artifacts: Path,
    previous: set[str] | None,
) -> tuple[list[str], list[str]]:
    """Return (failures, notes)."""
    failures: list[str] = []
    notes: list[str] = []
    gaps: dict[str, str] = inventory.get("known_gaps", {})

    for rel in inventory["required"]:
        if not (artifacts / rel).is_file():
            failures.append(
                f"REQUIRED asset missing: {rel}. install.sh and the Homebrew "
                f"formula resolve this one, so the release cannot go public."
            )

    for rel in inventory["optional"]:
        present = (artifacts / rel).is_file()
        name = Path(rel).name
        if present:
            if rel in gaps:
                failures.append(
                    f"{rel} built, but scripts/release_assets.json still lists it "
                    f"as a known gap. Remove the entry: while it is there, this "
                    f"platform can disappear again without failing anything."
                )
            continue
        if rel in gaps:
            notes.append(f"known gap, not built: {rel}\n    {gaps[rel]}")
        elif previous is not None and name in previous:
            failures.append(
                f"{rel} shipped in the previous release and is missing now. "
                f"Either fix the build or record it in "
                f"scripts/release_assets.json under known_gaps, with the reason."
            )
        else:
            notes.append(f"optional, not built: {rel}")

    return failures, notes


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    inventory = load_inventory(Path(args.inventory))
    previous = read_previous_assets(
        Path(args.previous_assets) if args.previous_assets else None
    )
    if previous is None:
        print("note: no previous release supplied; regression check skipped")

    failures, notes = check(
        inventory=inventory,
        artifacts=Path(args.artifacts),
        previous=previous,
    )

    for note in notes:
        print(f"note: {note}")
    if failures:
        print("\nRelease asset check failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print("Release asset check OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
