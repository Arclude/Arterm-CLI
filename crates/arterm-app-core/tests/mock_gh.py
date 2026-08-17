#!/usr/bin/env python3
"""Mock `gh` for github-tool tests. Speaks the subset the tool invokes."""
import json
import sys


def main(argv):
    if argv[:2] == ["repo", "view"]:
        print("owner/demo")
        return 0
    if argv[:2] == ["issue", "list"] or argv[:2] == ["pr", "list"]:
        print(json.dumps([
            {
                "number": 7,
                "title": "fix login",
                "state": "OPEN",
                "author": {"login": "alice"},
                "labels": [{"name": "bug"}],
            }
        ]))
        return 0
    if argv[:2] == ["issue", "view"] or argv[:2] == ["pr", "view"]:
        print(json.dumps({
            "number": int(argv[2]),
            "title": "hello",
            "state": "OPEN",
            "author": {"login": "bob"},
            "url": f"https://github.com/owner/demo/issues/{argv[2]}",
            "body": "please look",
            "baseRefName": "main",
            "headRefName": "feat/x",
            "additions": 1,
            "deletions": 0,
            "changedFiles": 1,
        }))
        return 0
    if argv[:2] == ["issue", "comment"]:
        print(f"https://github.com/owner/demo/issues/{argv[2]}#issuecomment-1")
        return 0
    print("unexpected args:", argv, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
