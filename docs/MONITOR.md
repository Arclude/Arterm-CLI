# Monitor Tool

Watch a command or WebSocket in the background and inject matching lines
into the current session. This is the reactive counterpart to `bg`:
`bg` reports when a task finishes, `monitor` interrupts the agent as
soon as a pattern hits.

## Actions

| Action | Required | Effect |
| --- | --- | --- |
| `start` | `command` **or** `ws` | Begin a watch |
| `list` | — | List watches in this session |
| `stop` | `monitor_id` | Cancel a watch |

`command` and `ws` are mutually exclusive. `ws` must be `ws://` or `wss://`.

## Pattern matching

`pattern` is a Rust regex. An empty pattern matches every line.

If the regex fails to compile, the watch fail-opens to a
case-insensitive substring match so a typo never silently drops events.

## Injection

Each match is published as a `MonitorMatched` bus event. The server
queues a soft interrupt for the session (`SoftInterruptSource::BackgroundTask`).
If the session is not live, the interrupt is persisted and replayed on restore.

Matches are rate-limited (`cooldown_ms`, default 2000) and capped
(`max_matches`, default 20). The watch stops after the cap.

## Examples

```json
{"action":"start","command":"tail -f /var/log/app.log","pattern":"ERROR|FATAL","intent":"watch app errors"}
{"action":"start","ws":"ws://127.0.0.1:9001/events","pattern":"\"status\":\"failed\"","intent":"watch CI socket"}
{"action":"list","intent":"list watches"}
{"action":"stop","monitor_id":"monab12","intent":"stop watch"}
```

Plan Mode blocks `monitor` the same way it blocks `bash`.
