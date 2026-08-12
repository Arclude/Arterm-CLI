#!/usr/bin/env bash
# Rebrand the forked tree from jcode to Arterm.
#
# This is a one-shot migration, kept in the tree so the transformation is
# auditable rather than a mystery in the history. Run from the repo root.
#
# What it deliberately does NOT touch:
#   - LICENSE. MIT requires the copyright notice to survive in copies, so the
#     upstream notice stays exactly as it is; ours is added beside it.
#   - Links to the upstream repository. They are attribution and provenance;
#     rewriting them would point readers at a URL that does not exist.
#
# Ordering note: the replacements are case-SENSITIVE and non-overlapping, so
# they can run in any order. `jcode` alone already covers `jcode-`, `jcode_`
# and `.jcode`, which is why those are not listed separately — a separate pass
# for each would double-apply on the second run.

set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"

UPSTREAM_SENTINEL="__ARTERM_UPSTREAM_URL__"
dry_run=0
[[ "${1:-}" == "--dry-run" ]] && dry_run=1

# Text files mentioning jcode in any case. `-I` skips binaries, so the icon
# and font assets are never rewritten.
mapfile -t files < <(grep -rIl -e jcode -e Jcode -e JCODE -e JCode . \
    --exclude-dir=.git --exclude-dir=target --exclude=rebrand_to_arterm.sh || true)

echo "text files to rewrite: ${#files[@]}"

if (( dry_run )); then
    echo "--- dry run: counting only ---"
    grep -rIc -e jcode -e Jcode -e JCODE . --exclude-dir=.git --exclude-dir=target \
        --exclude=rebrand_to_arterm.sh 2>/dev/null |
        awk -F: '{s+=$2} END {print s" matching lines"}'
    exit 0
fi

for f in "${files[@]}"; do
    # LICENSE keeps the upstream copyright verbatim.
    [[ "$f" == "./LICENSE" ]] && continue

    # Park upstream URLs so the generic replacement cannot rewrite them, then
    # restore them afterwards.
    perl -pi -e "s{github\.com/1jehuang/jcode}{$UPSTREAM_SENTINEL}g" "$f"

    perl -pi -e '
        s/JCODE/ARTERM/g;
        s/Jcode/Arterm/g;
        s/JCode/Arterm/g;
        s/jcode/arterm/g;
    ' "$f"

    perl -pi -e "s{$UPSTREAM_SENTINEL}{github.com/1jehuang/jcode}g" "$f"
done

# Paths, deepest first so a renamed parent cannot invalidate a child's path.
find . -depth \( -path ./.git -o -path ./target \) -prune -o \
    -name '*jcode*' -print | while read -r p; do
    d=$(dirname "$p")
    b=$(basename "$p")
    nb=${b//jcode/arterm}
    nb=${nb//Jcode/Arterm}
    nb=${nb//JCODE/ARTERM}
    [[ "$b" == "$nb" ]] && continue
    mv "$p" "$d/$nb"
done

echo "done. remaining mentions (upstream URLs and LICENSE are expected):"
grep -rIn -e jcode -e Jcode -e JCODE . --exclude-dir=.git --exclude-dir=target \
    --exclude=rebrand_to_arterm.sh 2>/dev/null | wc -l
