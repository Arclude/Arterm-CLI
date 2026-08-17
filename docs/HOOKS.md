# Lifecycle Hooks

arterm can run external commands at well-defined lifecycle points so other
programs can observe or gate agent behavior without forking arterm. Hooks
complement the [spawn hook](SPAWN_HOOK.md) (which controls *where headed
sessions appear*); lifecycle hooks tell you *what is happening inside them*.

## Configuration

```toml
# ~/.arterm/config.toml
[hooks]
turn_end      = "~/bin/arterm-turn-notify"     # observer
session_start = ""                            # observer
session_end   = ""                            # observer
pre_tool      = "~/bin/arterm-tool-policy"     # gate
post_tool     = ""                            # observer
pre_tool_timeout_ms = 5000
```

Env overrides (always win; empty value disables a config hook):
`ARTERM_HOOK_TURN_END`, `ARTERM_HOOK_SESSION_START`, `ARTERM_HOOK_SESSION_END`,
`ARTERM_HOOK_PRE_TOOL`, `ARTERM_HOOK_POST_TOOL`, `ARTERM_HOOK_PRE_TOOL_TIMEOUT_MS`.

## Common contract

- A hook entry is either a **command**, an **`http(s)://` URL**, or (for
  `pre_tool` only) **`prompt:`** plus an optional instruction.
- Command lines are parsed shell-style (quotes and backslash escapes work)
  but executed **directly**, not through a shell. A leading `~/` in the
  program path is expanded.
- The hook runs in the session working directory when known.
- Every hook receives:

| Variable | Meaning |
| --- | --- |
| `ARTERM_HOOK_EVENT` | `turn_end`, `session_start`, `session_end`, `pre_tool`, `post_tool` |
| `ARTERM_HOOK_SESSION_ID` | Session the event belongs to |
| `ARTERM_HOOK_CWD` | Session working directory |
| `ARTERM_HOOK_PAYLOAD` | JSON object mirroring all fields (capped at 16 KB) |
| `ARTERM_HOOKS_DISABLED` | Always `1`; suppresses hooks in nested arterm calls (recursion guard) |

## Observer hooks

`turn_end`, `session_start`, `session_end`, and `post_tool` are
**observers**: spawned detached, fire-and-forget. They can never block or slow
the agent; failures are only logged.

### `turn_end`

Fires when an agent turn completes (streaming turn path, which covers TUI,
desktop, swarm workers, and headless sessions).

Extra fields: `ARTERM_HOOK_STATUS` (`ok`/`error`), `ARTERM_HOOK_DURATION_MS`,
`ARTERM_HOOK_MODEL`, `ARTERM_HOOK_LAST_ASSISTANT_TEXT` (first 4000 chars),
`ARTERM_HOOK_ERROR` (on failure).

### `session_start` / `session_end`

`session_start` fires when an agent session becomes active, with
`ARTERM_HOOK_SOURCE` = `create` (brand new), `attach` (existing session object
attached), or `resume` (restored by id). `session_end` fires on normal close
(`ARTERM_HOOK_SOURCE=close`).

### `post_tool`

Fires after every tool call. Extra fields: `ARTERM_HOOK_TOOL_NAME`,
`ARTERM_HOOK_STATUS`, `ARTERM_HOOK_DURATION_MS`, `ARTERM_HOOK_OUTPUT_BYTES` (on
success), `ARTERM_HOOK_ERROR` (on failure).

## HTTP hooks

Any hook slot may be an `http://` or `https://` URL instead of a command.
arterm POSTs `ARTERM_HOOK_PAYLOAD` as `application/json`. Observer HTTP posts
are detached and never block the agent. Failures are logged.

## Gate hook: `pre_tool`

`pre_tool` runs **synchronously before every tool call** and can block it.
Each configured entry is a command, an HTTP URL, or `prompt:`:

- **Command**: receives `ARTERM_HOOK_TOOL_NAME` plus the full tool input JSON
  on **stdin** (and a 16 KB-truncated copy in `ARTERM_HOOK_TOOL_INPUT`).
  **Exit 0** allows. **Exit 2** blocks; stderr (trimmed, capped at 2000
  chars) is returned to the model as the tool error.
- **HTTP**: POSTs the JSON payload. **403** or a 2xx body of
  `{"decision":"block","reason":"..."}` blocks. Other 4xx/5xx fail open.
- **`prompt:`**: asks the cheap sidecar LLM. Reply must start with `ALLOW`
  or `BLOCK <reason>`. Optional text after `prompt:` is extra policy.
  Missing credentials, timeouts, and unparseable replies fail open.
- **Anything else fails open** with a logged warning: other exit codes,
  timeout (`pre_tool_timeout_ms`, default 5s), missing binary, spawn/HTTP
  errors.

Fail-open is deliberate: a broken policy should degrade to "no policy"
rather than brick every session. If you need fail-closed semantics, make the
hook itself robust (it is your trust boundary, not arterm).

### Example policy script

```bash
#!/usr/bin/env bash
# ~/bin/arterm-tool-policy
# stdin: tool input JSON. Env: ARTERM_HOOK_TOOL_NAME, ARTERM_HOOK_SESSION_ID...
input=$(cat)

case "$ARTERM_HOOK_TOOL_NAME" in
  bash)
    if grep -qE 'rm -rf /([^a-zA-Z]|$)|mkfs|dd if=' <<<"$input"; then
      echo "blocked: destructive shell command" >&2
      exit 2
    fi
    ;;
  write|edit)
    if grep -q '"file_path":"/etc/' <<<"$input"; then
      echo "blocked: writes to /etc are not allowed" >&2
      exit 2
    fi
    ;;
esac
exit 0
```

## Example: tmux status + desktop notification on turn end

```bash
#!/usr/bin/env bash
# ~/bin/arterm-turn-notify
if [ "$ARTERM_HOOK_STATUS" = ok ]; then icon=✅; else icon=❌; fi
tmux display-message "arterm $icon ${ARTERM_HOOK_SESSION_ID:0:12}" 2>/dev/null
notify-send "arterm turn $ARTERM_HOOK_STATUS" \
  "${ARTERM_HOOK_LAST_ASSISTANT_TEXT:0:120}" 2>/dev/null
exit 0
```

## Example: JSON event log of all hook activity

Point several hooks at one script and fan out on `ARTERM_HOOK_EVENT`:

```bash
#!/usr/bin/env bash
# ~/bin/arterm-event-log
echo "$ARTERM_HOOK_PAYLOAD" >> ~/.local/state/arterm-events.jsonl
```

```toml
[hooks]
turn_end      = "~/bin/arterm-event-log"
session_start = "~/bin/arterm-event-log"
session_end   = "~/bin/arterm-event-log"
post_tool     = "~/bin/arterm-event-log"
```

## Design notes

- Hook lookups are config-driven and re-read on config reload; you can add or
  change hooks without restarting arterm.
- Hot paths (`pre_tool`/`post_tool`) check whether a hook is configured before
  building any payload, so unconfigured hooks cost ~nothing.
- The recursion guard (`ARTERM_HOOKS_DISABLED=1`) means a hook may safely call
  `arterm` CLI commands without re-triggering hooks in that nested process.
