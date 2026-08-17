#!/usr/bin/env python3
"""Tests for check_release_assets.

The cases that matter are the ones the old inline check got wrong: an optional
platform vanishing between releases, and a recorded gap outliving the bug that
caused it.
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

import check_release_assets as checker


REQUIRED = ["a/a.tar.gz"]
OPTIONAL = ["w/w.exe", "f/f.tar.gz"]


def inventory(known_gaps: dict[str, str] | None = None) -> dict:
    return {
        "version": 1,
        "required": list(REQUIRED),
        "optional": list(OPTIONAL),
        "known_gaps": dict(known_gaps or {}),
    }


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.artifacts = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def build(self, *rels: str) -> None:
        for rel in rels:
            path = self.artifacts / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("binary")

    def run_check(self, inv: dict, previous: set[str] | None):
        return checker.check(inventory=inv, artifacts=self.artifacts, previous=previous)

    def test_everything_built_passes(self) -> None:
        self.build(*REQUIRED, *OPTIONAL)
        failures, _ = self.run_check(inventory(), {"a.tar.gz", "w.exe", "f.tar.gz"})
        self.assertEqual(failures, [])

    def test_missing_required_fails(self) -> None:
        self.build(*OPTIONAL)
        failures, _ = self.run_check(inventory(), set())
        self.assertEqual(len(failures), 1)
        self.assertIn("REQUIRED asset missing", failures[0])

    def test_optional_that_shipped_last_time_and_vanished_fails(self) -> None:
        # The v0.10.4 case: Windows ARM64 built for v0.10.3 and then stopped.
        self.build(*REQUIRED, "f/f.tar.gz")
        failures, _ = self.run_check(inventory(), {"a.tar.gz", "w.exe", "f.tar.gz"})
        self.assertEqual(len(failures), 1)
        self.assertIn("shipped in the previous release", failures[0])

    def test_optional_never_shipped_is_only_a_note(self) -> None:
        self.build(*REQUIRED, "f/f.tar.gz")
        failures, notes = self.run_check(inventory(), {"a.tar.gz", "f.tar.gz"})
        self.assertEqual(failures, [])
        self.assertTrue(any("w/w.exe" in note for note in notes))

    def test_known_gap_absent_is_only_a_note(self) -> None:
        self.build(*REQUIRED, "f/f.tar.gz")
        inv = inventory({"w/w.exe": "upstream cannot build it"})
        failures, notes = self.run_check(inv, {"a.tar.gz", "w.exe", "f.tar.gz"})
        self.assertEqual(failures, [])
        self.assertTrue(any("upstream cannot build it" in note for note in notes))

    def test_known_gap_that_built_again_fails_so_the_entry_is_removed(self) -> None:
        self.build(*REQUIRED, *OPTIONAL)
        inv = inventory({"w/w.exe": "upstream cannot build it"})
        failures, _ = self.run_check(inv, {"a.tar.gz", "f.tar.gz"})
        self.assertEqual(len(failures), 1)
        self.assertIn("still lists it", failures[0])

    def test_no_previous_release_skips_the_regression_check(self) -> None:
        self.build(*REQUIRED)
        failures, _ = self.run_check(inventory(), None)
        self.assertEqual(failures, [])


class InventoryTest(unittest.TestCase):
    def test_repo_inventory_and_the_release_workflow_describe_the_same_platforms(
        self,
    ) -> None:
        """Both directions, because both have gone wrong.

        An inventoried platform nothing builds is reported missing at every
        release forever. A platform the workflow builds but nobody inventoried
        is the Windows ARM64 bug in its next form: it can stop shipping without
        failing anything.
        """
        data = checker.load_inventory(checker.INVENTORY_FILE)
        workflow = (
            checker.REPO_ROOT / ".github" / "workflows" / "release.yml"
        ).read_text()
        built = set(re.findall(r"(?:artifact|name): (arterm-[\w.-]+)", workflow))
        inventoried = {
            Path(rel).parts[0] for rel in data["required"] + data["optional"]
        }

        self.assertEqual(
            inventoried - built,
            set(),
            "inventoried platforms the release workflow never builds",
        )
        self.assertEqual(
            built - inventoried,
            set(),
            "platforms the release workflow builds but scripts/release_assets.json "
            "never mentions; decide whether each is required or optional",
        )

    def test_known_gap_for_an_unlisted_asset_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "inv.json"
            path.write_text(json.dumps(inventory({"nope/nope.exe": "why"})))
            with self.assertRaises(ValueError):
                checker.load_inventory(path)


if __name__ == "__main__":
    unittest.main()
