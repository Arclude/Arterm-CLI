#!/usr/bin/env python3
"""Minimal mock LSP server for tests: initialize + definition.

Reads Content-Length framed JSON-RPC from stdin, writes framed
responses to stdout. Answers `initialize` with capabilities and
`textDocument/definition` with a fixed location.
"""
import json
import sys


def read_msg():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line or line in (b"\r\n", b"\n"):
            break
        k, _, v = line.decode().partition(":")
        headers[k.strip().lower()] = v.strip()
    n = int(headers.get("content-length", 0))
    return json.loads(sys.stdin.buffer.read(n))


def write_msg(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode())
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


while True:
    try:
        msg = read_msg()
    except Exception:
        break
    method = msg.get("method", "")
    if method == "initialize":
        write_msg({
            "jsonrpc": "2.0",
            "id": msg["id"],
            "result": {"capabilities": {"definitionProvider": True}},
        })
    elif method == "textDocument/definition":
        write_msg({
            "jsonrpc": "2.0",
            "id": msg["id"],
            "result": {
                "uri": "file:///lib/src/defs.rs",
                "range": {"start": {"line": 10, "character": 4}, "end": {"line": 10, "character": 8}},
            },
        })
    elif method == "shutdown":
        write_msg({"jsonrpc": "2.0", "id": msg["id"], "result": None})
    elif method == "exit":
        break
