#!/usr/bin/env bash
# Build the arterm tarball the Harbor adapter installs into each task container.
#
# Not `npm install -g arterm-cli`: a published version would measure a different
# tree than the one under test, which is the whole point of running the bench.
# The CLI's tsup inlines every @arterm/* workspace package into dist/main.js and
# leaves only third-party deps external, so this tarball is installable on its
# own — `npm i -g` resolves the rest from the registry.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/dist"

cd "$root"
pnpm -r build
mkdir -p "$out"
rm -f "$out"/*.tgz "$out/arterm-cli.tgz"

cd "$root/packages/cli"
tarball="$(npm pack --silent --pack-destination "$out")"
# A stable name so the adapter's default path does not move with the version.
mv "$out/$tarball" "$out/arterm-cli.tgz"

echo "built $out/arterm-cli.tgz ($(du -h "$out/arterm-cli.tgz" | cut -f1))"
