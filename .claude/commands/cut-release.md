---
description: Cut a new arterm release — write the changelog entry, commit it, and tag through quick-release.sh
argument-hint: <version, e.g. v0.11.0>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Cut release `$ARGUMENTS` of arterm.

The changelog entry is the point of this command. `scripts/generate_release_notes.sh`
renders `changelog/v<version>.json` into the GitHub release body when it exists, and
silently falls back to raw commit subjects when it does not — which is how v0.9.0
through v0.10.3 shipped with contributor shorthand as their release notes. Do not
reach the tagging step without the entry written and validated.

## 1. Preconditions

Stop and report if any of these fail — do not "fix" them as part of the release:

- The version argument is present and looks like `vX.Y.Z`. If it is missing, ask
  which version to cut; do not infer one.
- The tag does not already exist locally or on origin (`git tag -l`, `git ls-remote --tags origin`).
- You are on `main`, the working tree has no tracked modifications, and `main` is
  level with `origin/main`.
- CI is green on the commit being released: `gh run list --branch main --limit 3`.
  A red or in-progress run means stop and say so.

## 2. Read what the release contains

```
scripts/changelog_entry.py commits $ARGUMENTS
```

This lists every non-merge commit since the previous tag. Commits whose
conventional-commit prefix is internal (`test`, `ci`, `chore`, `refactor`, `style`,
`build`, `gate`) are marked `[internal?]` as a drafting hint — read them, do not
trust the mark blindly, and never filter silently.

Read the actual diffs where a subject is not self-explanatory. The commit log is the
source of truth; the changelog is a user-facing layer over it.

## 3. Write `changelog/v<version>.json`

Follow the schema and writing guidelines in `changelog/README.md`. In short:

- Describe the **effect on the user**, not the implementation.
- One sentence per item.
- `highlights` holds only the 1-3 changes a user would actually notice. Everything
  else goes in `improvements` or `fixes`.
- Omit empty arrays entirely. Omit `title` unless the release has an obvious theme.
- Skip internal-only changes. If the whole release is internal, say so in a single
  `improvements` item rather than padding the entry.
- `version` is the number without the leading `v`; `date` is today in `YYYY-MM-DD`.

Then register and verify it:

```
scripts/changelog_entry.py index $ARGUMENTS
scripts/changelog_entry.py check $ARGUMENTS
```

`index` upserts into `changelog/index.json` newest-first and is idempotent. `check`
is the gate — it fails if the entry is missing, malformed, or absent from the index.

## 4. Preview the real release body

```
scripts/generate_release_notes.sh $ARGUMENTS
```

Show the rendered markdown to the user. If it opens with `### Other changes` and
lists commit subjects, the entry was not picked up — the version in the filename does
not match the tag. Fix that before continuing.

## 5. Commit the release metadata

Commit `changelog/` **and the version bump**: set `version` in `Cargo.toml` to the
number without the `v`, then refresh `Cargo.lock` (`cargo update -p arterm --offline`).
`quick-release.sh` rejects a release commit that touches anything beyond those three.

The bump is not cosmetic. A released binary takes its version from the tag via
`ARTERM_BUILD_SEMVER`, but a build made from source reports `Cargo.toml`'s version,
and `version_is_newer` compares both as `(major, minor, patch)` numbers. While this
file said `9.1.0` and the tags ran on `0.10.x`, every source build concluded it was
already ahead of every release and no self-update was ever offered — silently, and
only for the people who build from source. `require_version_matches_tag` in
`quick-release.sh` now refuses to tag when the two disagree.

Push it to `main` and wait for CI to go green before tagging.

## 6. Tag and publish — ask first

Tagging publishes a release to the public repo and is not reversible. Show the user
the version, the rendered notes, and the commit being tagged, and get an explicit go
ahead before running:

```
scripts/quick-release.sh --remote $ARGUMENTS
```

`--remote` pushes the tag and lets CI gate publication. Do not hand-roll `git tag`.

## 7. Verify

Watch the release run, then confirm the published result rather than assuming it:

- `gh release view $ARGUMENTS` — the body shows the changelog sections, not
  `### Other changes`.
- The asset list is complete. Compare it against the previous tag's assets; a green
  run can still be missing a platform, because the optional jobs do not fail the run.

Report what actually published, including anything missing.
