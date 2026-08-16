#!/usr/bin/env python3
"""Changelog entry helper for `/cut-release`.

The prose in a changelog entry is written by hand (or by the agent driving
/cut-release). Everything mechanical around it lives here so it cannot be
skipped: finding the commits a release covers, validating the entry against
the schema `scripts/generate_release_notes.sh` consumes, and keeping
`changelog/index.json` newest-first and in sync.

Usage:
  scripts/changelog_entry.py commits  <version>          commits since the previous tag
  scripts/changelog_entry.py validate <version>          check changelog/v<num>.json
  scripts/changelog_entry.py index    <version> [date]   upsert into index.json
  scripts/changelog_entry.py check    <version>          release gate: validate + index

<version> is accepted as `v0.11.0` or `0.11.0`.
"""

import json
import re
import subprocess
import sys
from datetime import date as date_cls
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHANGELOG_DIR = REPO / "changelog"
INDEX = CHANGELOG_DIR / "index.json"

SECTIONS = ("highlights", "improvements", "fixes")
# Conventional-commit prefixes whose changes users never see. Used only to
# flag commits as likely-skippable when drafting; never to filter silently.
INTERNAL_PREFIXES = ("test", "ci", "chore", "refactor", "style", "build", "gate")


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def normalize(version):
    num = version[1:] if version.startswith("v") else version
    if not re.fullmatch(r"\d+\.\d+\.\d+", num):
        die(f"version must look like v1.2.3 or 1.2.3, got {version!r}")
    return num, f"v{num}"


def entry_path(num):
    return CHANGELOG_DIR / f"v{num}.json"


def git(*args):
    return subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def previous_tag(tag):
    """Newest release tag that is not `tag`, by creation date."""
    tags = [t for t in git("tag", "--sort=-creatordate").splitlines() if t and t != tag]
    return tags[0] if tags else ""


def cmd_commits(version):
    _, tag = normalize(version)
    prev = previous_tag(tag)
    end = tag if subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "-q", "--verify", f"{tag}^{{commit}}"],
        capture_output=True,
    ).returncode == 0 else "HEAD"
    rng = f"{prev}..{end}" if prev else end

    lines = git("log", "--no-merges", "--format=%h\t%s", rng).splitlines()
    if not lines:
        print(f"(no commits in {rng})")
        return

    print(f"# {len(lines)} commit(s) in {rng}\n")
    for line in lines:
        sha, _, subject = line.partition("\t")
        prefix = subject.split(":", 1)[0].split("(", 1)[0].strip().lower()
        mark = "  [internal?]" if prefix in INTERNAL_PREFIXES else ""
        print(f"{sha}  {subject}{mark}")


def load_entry(num):
    path = entry_path(num)
    if not path.exists():
        die(
            f"{path.relative_to(REPO)} does not exist.\n"
            f"       Write it before tagging — without it the release body falls back\n"
            f"       to raw commit subjects (see changelog/README.md for the schema)."
        )
    try:
        return json.loads(path.read_text(encoding="utf-8")), path
    except json.JSONDecodeError as exc:
        die(f"{path.relative_to(REPO)} is not valid JSON: {exc}")


def cmd_validate(version, quiet=False):
    num, _ = normalize(version)
    entry, path = load_entry(num)
    rel = path.relative_to(REPO)
    problems, warnings = [], []

    if entry.get("version") != num:
        problems.append(f'"version" is {entry.get("version")!r}, expected {num!r}')

    entry_date = entry.get("date")
    if not isinstance(entry_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", entry_date or ""):
        problems.append(f'"date" must be YYYY-MM-DD, got {entry_date!r}')

    if "title" in entry and not (isinstance(entry["title"], str) and entry["title"].strip()):
        problems.append('"title" is present but empty — omit it instead')

    populated = 0
    for key in SECTIONS:
        if key not in entry:
            continue
        items = entry[key]
        if not isinstance(items, list):
            problems.append(f'"{key}" must be a list')
            continue
        if not items:
            warnings.append(f'"{key}" is an empty list — omit the key instead')
            continue
        populated += len(items)
        for i, item in enumerate(items):
            if not isinstance(item, str) or not item.strip():
                problems.append(f'"{key}"[{i}] must be a non-empty string')

    if populated == 0:
        problems.append("entry has no content in highlights, improvements or fixes")

    highlights = entry.get("highlights") or []
    if isinstance(highlights, list) and len(highlights) > 3:
        warnings.append(
            f"{len(highlights)} highlights — the guideline is the 1-3 changes a user "
            f"would actually notice; move the rest to improvements"
        )

    unknown = set(entry) - {"version", "date", "title", *SECTIONS}
    if unknown:
        warnings.append(f"unrecognized key(s) ignored by the renderer: {', '.join(sorted(unknown))}")

    for w in warnings:
        print(f"warning: {rel}: {w}", file=sys.stderr)
    if problems:
        for p in problems:
            print(f"error: {rel}: {p}", file=sys.stderr)
        sys.exit(1)
    if not quiet:
        print(f"ok: {rel} is valid ({populated} item(s))")
    return entry


def read_index():
    if not INDEX.exists():
        return {"entries": []}
    try:
        data = json.loads(INDEX.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        die(f"{INDEX.relative_to(REPO)} is not valid JSON: {exc}")
    data.setdefault("entries", [])
    return data


def version_key(v):
    return tuple(int(p) for p in v.split("."))


def cmd_index(version, when=None):
    num, _ = normalize(version)
    entry = load_entry(num)[0]
    when = when or entry.get("date") or date_cls.today().isoformat()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", when):
        die(f"date must be YYYY-MM-DD, got {when!r}")

    data = read_index()
    entries = [e for e in data["entries"] if e.get("version") != num]
    changed = len(entries) != len(data["entries"])
    entries.append({"version": num, "date": when})
    # Newest-first by date, not by version. This repo carries two version
    # lines that do not compare — the crate is 9.1.0 while releases are
    # tagged v0.10.x — so sorting by semver puts a three-day-old entry above
    # today's and tells arterm.dev the wrong release is the latest. The date
    # is the one field that means the same thing in both lines; version
    # breaks ties within a day.
    entries.sort(key=lambda e: (e["date"], version_key(e["version"])), reverse=True)
    data["entries"] = entries

    INDEX.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    verb = "updated" if changed else "added"
    print(f"ok: {verb} {num} ({when}) in {INDEX.relative_to(REPO)}")


def cmd_check(version):
    num, _ = normalize(version)
    cmd_validate(version, quiet=True)
    listed = {e.get("version") for e in read_index()["entries"]}
    if num not in listed:
        die(
            f"{num} is missing from {INDEX.relative_to(REPO)}.\n"
            f"       Run: scripts/changelog_entry.py index v{num}"
        )
    print(f"ok: changelog is ready for v{num}")


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)
    action, version = sys.argv[1], sys.argv[2]
    if action == "commits":
        cmd_commits(version)
    elif action == "validate":
        cmd_validate(version)
    elif action == "index":
        cmd_index(version, sys.argv[3] if len(sys.argv) > 3 else None)
    elif action == "check":
        cmd_check(version)
    else:
        die(f"unknown action {action!r} (expected commits, validate, index or check)")


if __name__ == "__main__":
    main()
