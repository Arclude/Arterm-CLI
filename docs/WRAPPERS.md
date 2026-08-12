# arterm wrapper / scripting guide

This document describes the non-interactive CLI surface intended for wrappers, scripts, and other tools that invoke `arterm`.

## Recommended flags

Use these flags by default in wrappers:

```bash
arterm --quiet --no-update --no-selfdev ...
```

- `--quiet` suppresses non-error CLI/status chatter
- `--no-update` avoids update-check noise/work
- `--no-selfdev` avoids repository auto-detection changing runtime behavior

## Discover available models

List model names that can be passed to `-m/--model`:

```bash
arterm --quiet model list
arterm --quiet model list --json
arterm --quiet --provider openai model list --json
```

## Discover providers and current selection

List provider IDs you can pass to `-p/--provider`:

```bash
arterm --quiet provider list
arterm --quiet provider list --json
```

Inspect the currently requested and resolved provider/model selection:

```bash
arterm --quiet provider current
arterm --quiet --provider openai --model gpt-5.4 provider current --json
```

Verbose human summary:

```bash
arterm --quiet model list --verbose
```

## Run one prompt and return JSON

```bash
arterm --quiet run --json "Reply with exactly OK"
```

## Stream one prompt as NDJSON

```bash
arterm --quiet run --ndjson "Reply with exactly OK"
```

Typical event types:

- `start`
- `connection_phase`
- `connection_type`
- `text_delta`
- `text_replace`
- `tool_start`
- `tool_input`
- `tool_exec`
- `tool_done`
- `tokens`
- `done`
- `error`

The final `done` event includes the assembled text and usage summary.

Example shape:

```json
{
  "session_id": "session_...",
  "provider": "OpenAI",
  "model": "gpt-5.4",
  "text": "OK",
  "usage": {
    "input_tokens": 123,
    "output_tokens": 7,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": null
  }
}
```

## Inspect authentication state

```bash
arterm --quiet auth status
arterm --quiet auth status --json
```

JSON output includes:

- `any_available`
- `providers[]`
  - `id`
  - `display_name`
  - `status`
  - `method`
  - `auth_kind`
  - `recommended`

## Inspect build/version details

```bash
arterm --quiet version
arterm --quiet version --json
```

JSON output includes:

- `version`
- `git_hash`
- `git_tag`
- `build_time`
- `git_date`
- `release_build`

## Notes

- JSON commands are designed so the intended machine-readable result is printed to `stdout`
- With `--quiet`, wrapper-oriented commands should keep `stderr` empty unless there is a real warning/error
- `arterm model list` and `arterm run --json` do not require the TUI
- `arterm model list` does not require an already-running shared server
