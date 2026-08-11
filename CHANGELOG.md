# Changelog

All notable changes to **arterm-cli** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Typing into a running turn now reaches the model during it.** A prompt
  submitted while the agent works used to wait for the whole turn to finish, so
  a correction arrived after the work it was meant to redirect. It is now folded
  into the conversation at the next safe point — after a tool round's results
  are recorded, before the next request — without cancelling anything and
  without re-sending the prompt. Turns that never reach such a point (a
  text-only reply) behave exactly as before: the message stays queued and is
  dispatched at the end, so nothing typed is ever dropped or sent twice.

- **Lifecycle hooks** (`hooks` in the config): external commands run at
  well-defined points, so another program can observe — and gate — the agent
  without forking it. `turnEnd`, `sessionStart`, `sessionEnd` and `postTool` are
  observers, spawned detached, unable to slow or fail a turn. `preTool` is a
  gate: it runs before each tool call, `exit 2` blocks the call, and the hook's
  stderr is handed to the model as the tool error so it can adapt. Every other
  outcome — any other exit code, a timeout, a missing binary — fails OPEN, on
  the same argument as the verify judge: policy that silently becomes mandatory
  the day it breaks is worse than none.

  Hooks get a **credential-scrubbed** environment (a hook is a spawned command,
  the same door `bash` was) and `ARTERM_HOOKS_DISABLED=1`, so a hook may call
  `arterm` without re-triggering itself. The tool's full input arrives on stdin,
  with a 16 KB copy in `ARTERM_HOOK_TOOL_INPUT`.

- **A turn at the cap that is still working gets another tranche**
  (`budget.autoExtendTurn`, default true). The iteration cap exists for the
  runaway turn, but it could not tell one from a long one, so auto mode died at
  exactly 50 iterations mid-task. The loop detector already owns that diagnosis:
  the boundary now extends unless the detector has CUT the turn. Set it to
  `false` for the old hard stop. Sub-agents and the verify judge are never
  extended either way.

### Fixed

- **A mid-turn message now survives the session it steered.** Something typed
  into a running turn reached the model, but was appended straight to the live
  message array — skipping the hook that writes history down. It shaped the
  answer and then vanished from the transcript and the checkpoint, so resuming
  replayed a conversation the correction never happened in.

- **`hooks.sessionEnd` runs.** It validated, it counted as a configured hook, and
  nothing ever fired it: a user who configured only that hook got the whole hook
  machinery installed and silence. It is now fired at the top of session
  teardown, while the session it describes still exists.

- **`turnEnd` no longer reports `ok` for a turn that failed.** The status was a
  literal, which made the hook useless for the thing an observer is mostly for.
  A failed turn now reports `error`, with the message in `ARTERM_HOOK_ERROR`.

- **A `pre_tool` gate that ignores stdin no longer takes the session down.**
  Writing the tool's input to a hook that exits without reading fails with an
  EPIPE delivered asynchronously, past the `try` guarding the write, where an
  unhandled error event ends the process — so the gate's own correct verdict
  killed the run.

- **A killed TUI actually dies.** The SIGINT handler installed with the terminal
  restore wrote the escape bytes and returned, and because registering any
  listener suppresses Node's default termination, `kill -INT` left the app
  running with its cursor shown, its mouse released and the alternate screen
  exited — a live TUI painting over the shell, immune to further INTs. It exits
  130 now. The `uncaughtException` handler did the same to a crash the CLI
  deliberately survives, and is gone.

- **The chat repaints more often while streaming.** The context gauge asks for
  the model's context window on every render, and that question walked the whole
  models.dev catalog — thousands of entries, each id normalized through a regex —
  once per repaint. Profiled against the built binary during a stream, that
  cluster was about a quarter of all active CPU. The lookup is now memoized
  against the (immutable) cached catalog and dropped whenever the catalog is
  refreshed. Measured on the same 1,200-chunk stream: 88 frames instead of 61.

- **A killed session gives the terminal back.** Only a clean exit restored it;
  SIGTERM, SIGHUP and crashes skipped Ink's teardown entirely, which is exactly
  when it matters — mouse reporting left enabled makes the shell print
  `^[[<0;12;34M` on every click until `reset`. All reporting modes, the cursor
  and the alternate screen are now restored from one writer on every exit path,
  with `writeSync` so the bytes actually land before the process leaves.

### Changed

- **The wheel scrolls the chat, and can no longer type.** Scrolling used to move
  the chat in three-line jumps and, on a terminal set to one line per tick, put
  an old prompt back in the composer instead. Both are one mechanism: on the
  alternate screen there is no scrollback for the wheel to move, so the app asked
  the terminal to translate ticks into arrow keys (DECSET 1007) and read the
  scroll back out of them — and a one-line tick is byte-identical to pressing ↑,
  which no amount of timing can separate.

  The fix is to change the channel rather than guess better. The mouse is now
  captured with SGR reporting (`?1000h` + `?1006h`), where a tick arrives as
  `ESC[<64;x;yM`: the direction is in the bytes and no keypress can produce them,
  so the chat scrolls and history is never touched. Alternate scroll is never
  enabled again in either mode. This is what Claude Code does, measured off its
  own wire rather than assumed. The price is that plain left-drag belongs to the
  app while capture is on, so selecting text is **⇧+drag** — the status bar says
  so beside the scroll hint. `/mouse` toggles it for the session and
  `tui.mouse: false` is the persistent form; turning it off captures nothing at
  all (it does not fall back to 1007) and PgUp/PgDn scroll instead.

  PgUp/PgDn also now actually reach the bottom — paging alone could not, because
  scrolling up raises the "N satır yukarıda" row, which costs the viewport a
  line, so the page back down was always one row short. And ↑/↓ answer instantly:
  the old classifier held every arrow keypress for 25 ms waiting to see whether
  the wheel had sent a second one. `scripts/wheel-scroll-e2e.mjs` drives the
  built binary in a pty and can finally assert the reported case itself: 14/14
  after, **9/14** before.

  Classic rendering (`tui.fullscreen: false`) was tried as the default here and
  reverted before release. It hands the wheel back to the terminal, which is the
  right shape — but the redrawn region is content-sized there, so the moment the
  8-row live-message area collapses onto a committed answer the composer and
  status bar move up and leave the rows below them blank. Pinning them would
  take a region as tall as the window, which is exactly what must not happen in
  the normal buffer: at that height Ink clears and rewrites the whole terminal
  every render, scrollback included. A pinned footer and a terminal-owned
  scrollback cannot both be had.

## [0.9.1] — 2026-08-11

### Added

- **The dashboard takes the whole screen — and takes images.** The session
  panel now owns the window in fullscreen: list at the top, composer and key
  hints pinned to the bottom, where every other full-screen surface here keeps
  its prompt — instead of floating as a small box over nine-tenths of empty
  terminal. And a task typed there can carry pictures: drop a file onto the
  terminal and its path lands in the composer, or press `^V` to paste the
  clipboard image as an `[Image #1]` token. Held images ride into the
  background session and reach the model as real image parts; deleting the
  token detaches the image, and an empty clipboard says so in the panel's note
  line rather than failing silently.

### Fixed

- **Shift+Tab was dead while a turn ran — exactly when plan-mode denials say
  to press it.** The mode-cycle handler was gated on an idle status, so a
  model burning turns against "plan mode is read-only — switch to ask/auto
  (Shift+Tab)" could not be rescued without cancelling the turn. The gate is
  gone: the permission ladder reads the mode fresh on every tool call, so a
  mid-turn switch applies to the very next call the model makes. (The mention
  picker still owns Tab while it is up.)
- **A file dropped onto the dashboard was swallowed whole.** A drag arrives as
  one bracketed-paste chunk whose ESC-framed markers read as `meta`, and the
  panel's text branch was gated on `!meta` — so the entire path vanished
  before anything downstream could see it. Pastes are now handled before every
  other branch, newlines flattened to spaces.
- **Ctrl+Backspace deleted one character, indistinguishable from the plain
  key.** The terminal sends `0x08` for Ctrl+Backspace with no ctrl bit for the
  key parser to attach, so the word-delete branch was unreachable. `0x08`,
  `Ctrl+W` and `Alt+Backspace` now kill the word behind the cursor — and an
  `[Image #N]` token counts as one word, so one press removes the whole atom
  instead of leaving `[Image #` behind with the image still attached.

## [0.9.0] — 2026-08-11

### Added

- **The session panel is a dashboard, and a typed task starts in the
  background.** `←` now opens counts up top (awaiting approval · working ·
  completed), one row per session with status glyph, title, last result and a
  coarse age — an idle row says what CAME of the session (the first line of its
  last assistant message), not just that it stopped. The composer at the bottom
  creates a session that begins working immediately while the dashboard stays
  up: type the task, press Enter, stay where you are; the new row appears
  preselected and Enter opens it when wanted. Under the cosmetics, one real
  bug: the panel used to show every background session frozen at whatever it
  was doing when the panel opened.

### Fixed

- **The terminal's own cursor no longer haunts the screen.** The composer draws
  its cursor itself, and nothing ever hid the hardware one — it sat blinking
  wherever the last write ended, typically in the void below the session panel.
  Hidden for the whole run now, re-hidden on every resize (the same
  host-emulator reset healing the mouse modes get), and restored on exit while
  still on the alternate screen, so the primary buffer always comes back with a
  visible cursor.

## [0.8.0] — 2026-08-10

### Fixed

- **The fleet leader integrates through a turn that cannot act.** The
  parallel/team "integrate the round's results" step used to be a full agent
  turn with the whole tool roster offered and the sentence "Do not call any
  tools." appended — a request, not a gate. A fake model that answers the
  integration prompt with a write tool call proves the pre-fix binary executes
  it: a file no worker wrote, recorded without a worker id. The step now runs
  through `Agent.note()` — history, no tools — so a leader that answers with
  work produces text nobody runs.
- **A red suite between claims becomes the next round's steer.** The
  verification gate used to fire only on a completion claim, and a live
  parallel run showed the cost: 19/21 tests green, the leader proposing no
  further work, and the run idling out with the two failures never surfaced to
  anyone. With a standing command configured (`verify.command` /
  `--verify-cmd`), it now also runs at round boundaries in the parallel and
  team loops — red skips the "is the goal done?" reflection, resets the
  idle-out counter, and lands in the next round's prompt exactly like a
  rejection's must-fix list. Without a standing command, rounds behave as
  before.
- **User agent definitions load on the headless path too.** `.arterm/agents/`
  (project) and `~/.arterm/agents/` (global) definitions — `/team` members and
  `spawn` roles — were registered only by the interactive bootstrap, so a
  headless `--goal` run quietly fell back to the five built-in roles. Headless
  is where fleets actually run unattended; both paths now register them.

### Changed

- **The config file carries your choices, not a fossil of old defaults.**
  `saveConfig` used to serialize the whole resolved config, which pinned every
  default at whatever the current version's value was — so a release changing a
  default could never reach an existing home. Measured with v0.6.0's sandbox
  flip: it applied only to freshly created homes, because every existing config
  carried `sandbox.enabled: false` written by the previous full persist. The
  file now carries the DELTA against the defaults: on your first clean exit it
  shrinks to the keys you actually chose (a real one went from 2.5KB to 310
  bytes), values equal to the current default un-pin and track the product from
  then on, and values that differ — including old defaults, which are
  indistinguishable from choices — survive whole. Unknown keys survive too.
  The one thing a delta cannot express is "I choose today's default and want it
  frozen against tomorrow's"; state a differing value to mean that.

### Added

- **Retention for the stores nothing bounded.** Spooled tool output
  (`~/.arterm/tool-output/`, measured at 39MB after three weeks) now ages out
  after `retention.spoolDays` (default 7), and chronicle ledgers after
  `retention.chronicleDays` (default 90 — it is the audit record, so it
  deliberately outlives the runs it describes). Pruning is by mtime, so an
  actively appended file is safe by construction; it runs best-effort at
  startup on both the TUI and headless paths, and deletes whole files only —
  never individual chronicle records, which is what the hash chain exists to
  catch. Sessions already had retention (`session.maxSessions` / `maxAgeDays`);
  this closes the gap for the other two stores.

## [0.6.1] — 2026-08-10

### Security

- **`git` no longer inherits the session's environment.** It was the last
  process-spawning tool still handed the full environment — `bash`, `exec` and
  the project scripts had all been scrubbed. `git` is deliberately not
  sandboxed (it is a fixed list of read-only subcommands with the code-running
  flags refused), so the environment was the only thing standing between a
  repository's own config and your provider keys: a repo can point git at an
  external program through `diff.external` or `core.fsmonitor`, and that
  program inherits whatever git was spawned with.

### Added

- **[SECURITY.md](./SECURITY.md)** — the threat model, the controls in the
  current source, and, at equal length, the gaps that are known and accepted:
  the sandbox confines commands rather than Arterm (MCP servers, the verify
  command and plugins are outside it), the transcript is an exfiltration
  channel no egress rule can see, the allowlist prevents an arbitrary channel
  rather than every channel, and reads are less constrained than writes.

## [0.6.0] — 2026-08-10

### Changed

- **`bash` is confined by default, in every session.** `sandbox.enabled` was
  true only for `--autonomous` runs; it is now the default for attended ones as
  well. Shell commands write to the working directory and the temp dir, reach a
  short allowlist of hosts, and cannot read Arterm's own key material. The
  argument this reverses is that an attended session has the permission prompt
  as its control — but the prompt answers a different question: "yes, run `pnpm
  test`" is not consent for `pnpm test` to write outside the project or dial an
  arbitrary host, the same reasoning that already put the credential scrub in
  every mode. What stays asymmetric is the response to a boundary that cannot be
  **established**: an unattended run still refuses to start, while an attended
  one warns and continues, because a session that refuses to OPEN over a missing
  bubblewrap earns `--no-sandbox` in a shell alias by lunchtime. Turn it off with
  `--no-sandbox` or `sandbox.enabled: false`.
- **A refused command now says so — to the model as well as to you.** A write
  the boundary stopped came back as the kernel's own sentence and nothing else
  (`Read-only file system`, `[exit code 1]`), so the model's next move was
  `sudo`, another path, or telling you your disk was broken. Failing commands in
  a confined session now carry a note naming the path, the writable roots, and
  the way out. It is failure-coupled and evidence-coupled — silent on success,
  and silent on a failing test suite that never left the project — and it matches
  PATHS rather than the kernel's phrasing, which arrives translated on a
  non-English host. The session also states the boundary in force at startup.

## [0.5.0] — 2026-08-10

### Added

- **A ledger of what a run DID, apart from what it said it did.** Every tool
  call appends a hash-chained record (`$ARTERM_HOME/chronicle/`) built from the
  seam rather than the story: the path and diff come from the TOOL, the content
  hash is read back off the disk, and none of the three can be written by a
  model composing a summary. Sub-agents write into the parent's chain, stamped
  with which worker made each change, so a fan-out has one order instead of
  three. The judge is now handed that evidence beside the claim — a run told not
  to touch `slug.ts` was passed with *"the record shows only README.md +38/-0,
  confirming slug.ts was not modified"*, which is the question the documented
  failure got wrong by assuming. `bash` has no write to declare, so its writes
  are MEASURED: the tree is digested before and after the call and only what
  moved is recorded, with the other processes that were live at both ends listed
  beside it — a watcher can prove a file changed, never who changed it.
  `arterm chronicle verify` exits 1 on a broken chain.
- **Roughly forty new tools**, all permission-gated: four LSP tools (the
  compiler's answers, not a name match), a call graph from a real parser,
  `patch` with a diff it can actually apply, a project runner (typecheck,
  install, audit, outdated, logs), a work list that survives compaction, plans
  and task graphs the model writes on the shape `/sdd` executes, memory / meta /
  llm / skill / MCP tools, a fleet the model drives rather than the engine, and
  fifteen browser tools whose screenshots come back inline. The roster is a tax,
  so it is measurable and adjustable per run.
- **`@file` in the composer.** Typing `@` opens a picker over the project —
  eight rows that SCROLL, with `3/47` saying where you are — and the file's
  contents ride out with the message, fenced under the path you typed, so a
  question about a file costs no turn spent on the model reading it. Ignored
  files are not offered and can still be typed in full; an over-large file is
  clipped at both ends and says so inside the text.
- **Images the USER hands over.** `Message.images` promised "a picture you
  pasted" from the day it was written and nothing ever filled it. Drag one onto
  the prompt or press `Ctrl+V`: a terminal delivers a drop as a PATH, so the
  submitted line is read for one. The bytes decide what an image is, never the
  file's name, and a refusal always NAMES the file. `[Image #1]` holds its place
  in the sentence, and one Backspace takes both the token and the attachment.
- **`gen_ai.*` telemetry.** Model and tool spans come from pipeline stages, not
  from the bus, so tool time never hides inside the provider's latency.
  Attribute names are pinned to one semconv release and stated on every export.
  Telemetry can never fail a run: a bad endpoint degrades to one stderr line.
- **A clock, not just a step count.** `--max-duration` (`budget.runSeconds`)
  makes a run stop ITSELF while it can still report, with a reserve phase past
  `budget.softRatio`; a killed run emits its result document on SIGTERM instead
  of leaving a 0-byte file where fifteen minutes of paid work should be. The
  deadline signal is armed once and shared by every agent and sub-agent, so the
  call after the abort stops too.
- **`bench/harbor`** — a Harbor adapter that runs `arterm` under Terminal-Bench
  with no fork of the harness, and records the harness it ran under, because a
  number without one is not comparable to anyone else's.
- **A terminal UI with a palette, a glyph language and a ruler** — status chips,
  one frame for the boards, `/context` saying what is filling the window,
  `/rewind` to undo a turn's file changes, `/limits`, `/mouse`, AUTONOMOUS on
  Shift+Tab, and drag-select by default. Reasoning is shown while it happens:
  a backend that streams only `reasoning_content` used to look like a hang.

### Changed

- **Prompt caching pays for itself from the second iteration.** All four
  Anthropic breakpoints are now spent, including one anchored on the last
  COMPLETED tool round-trip — the longest prefix guaranteed to be re-sent
  byte-identical for the rest of the run. Measured on a real session: 10,662
  tokens of fixed prefix per request, 223k over a twenty-call turn, for text
  that never varied.
- **Independent tool calls run together.** The loop plans batches; the TOOL
  declares whether it may overlap, and absent means no. Batches are runs, not a
  partition — nothing is hoisted past an unsafe neighbour — and every execution
  finishes before any result is recorded, so history reads in the order the
  model asked. 1.79× on four concurrent greps over this repo.
- **`--autonomous` adds a control instead of only removing them**: `bash` runs
  confined to the session's write roots with egress on an allowlist. The
  boundary never comes from model output. Unattended fails closed, attended
  warns and continues, and `--no-sandbox` is a loud escape hatch.
- **A command is no longer HANDED the keys.** The environment is scrubbed by
  name for every tool call and for the verify command, in every mode, default-
  closed even when unwired — and the keystore files are denied to a sandboxed
  read, since `cat ~/.arterm/secrets.json` yields more than the environment ever
  held. The arbiter grades a command it cannot READ (`base64 -d | sh`) as high
  rather than letting a deny-list fail open, and refuses the unreadable and the
  secret-reading ones where nobody is there to answer the prompt.

### Fixed

- **Every GLM session believed its context window was 8k.** The models.dev
  cache was warmed on the TUI path only, so a headless run — that is, every
  benchmark trial — read the 8192 written for a local GGUF and compacted a
  1M-window model every 6,144 tokens. A prompt the provider answered is now a
  floor under the belief, and a boot-time note says when the window was ASSUMED.
- **The `@` picker moved two rows per ↓ and could not reach its ninth match.**
  Fullscreen reads arrows off raw stdin while ink's `useInput` reads the same
  emitter, so one keypress was answered twice; and eight rows was a truncation
  rather than a window.
- **A sandboxed run did its work, printed its verdict, and never exited** —
  host-side boundary processes held the event loop open, which reports as a
  failed run whatever it accomplished. The deadline had the mirror bug: the run
  stopped on time, then teardown's digest call ran unbounded for another eighty
  seconds.
- **A failed merge no longer leaves conflict markers in your source files.**
  `git apply --3way` writes them on conflict *and* exits non-zero, so the caller
  was correctly told "this did not apply" over files that no longer parsed.
- **The leader was silent, uncounted, invisible and misread**: planning calls
  now show on screen, meter their usage, surface their errors instead of
  reporting "no further work proposed" with exit 0, and a reply that reads
  "let me verify before declaring done" is no longer parsed as DONE.
- **`pnpm test` overwrote the developer's own `~/.arterm/config.json`**, the
  status server wrote there too, and the redirect turned out to be per package.
  Three instances of one mistake, now guarded as a rule rather than as files.
- **Three observables said "nothing happened" the same way they said "this never
  ran"**: a skipped verdict, a spend of zero, and an empty witness list are each
  stated explicitly now, because a missing key and a false one read alike.
- Windows is supported rather than assumed: path separators, file URIs, newline
  policy in the diff round-trip, and the deterministic gate that passed
  everything there.

## [0.4.0] — 2026-08-05

### Added

- **Result verification, on by default.** Every mode's completion claim now
  passes one gate (`gateClaim()`): a deterministic command check that **fails
  closed** — an exit code is not an opinion — with an LLM judge behind it that
  **fails open**, so an unreachable judge can never turn finished work into a
  rejection. The verdict is data, never prose: the judge reports via a
  `submit_verdict` tool call read off its private bus, and only
  `pass === false` blocks. A task can declare its own gate with a
  `verify: <cmd>` line; `verify.command` / `--verify-cmd` is the **standing
  gate** that runs when the work declares nothing — it comes from config or
  argv, never from the model, so a worker can narrow the gate but never widen
  or remove it. A rejection queues its `mustFix` items as steers into every
  mode's next prompt; `--persist` keeps working past the rejection cap, up to
  the mode's own step bound.
- **Unattended runs: `--autonomous`.** One flag flips the five switches a
  walk-away run needs — yolo permissions, verify-persist, sub-agent
  auto-approve (workers get a fail-closed policy whose asker answers "deny"
  instead of hanging on a prompt no one will answer), progress-gated step
  extension, and the loop detector — and announces itself on stderr. It warns
  when no standing gate exists (the judge only reads the result — it cannot
  catch work that contradicts the goal), and the loop detector is the one
  switch that overrides an explicit `loopDetect.enabled: false`, with its own
  warning: persist plus auto-extend without the detector runs unbounded.
- **Loop detector.** Fingerprints each iteration (tool names + first call's
  args) and a sliding window of individual calls, so verbatim repetition and
  A-B-A-B alternation are both caught: a corrective steer note at 3 repeats, a
  turn cut at 5 — for the main agent and sub-agents alike, with
  `loop_detected`/`loop_cut` bridged to the parent board.
- **Progress-gated step cap.** `autonomy.autoExtend` grants more steps at the
  cap only if tool calls or verification attempts happened since the last
  grant; an explicit `--max-steps` is absolute (`hardCap`) and bounds eternal
  too, which is what makes eternal runs testable in CI. Eternal itself gains
  continuation mechanics: a journal of classified steps prepended to each
  directive, a pivot to ONE different task after `failureBudget` consecutive
  non-ok steps, abort-aware 2s→60s backoff on retryable provider errors, and
  a stop after two exhausted budgets when the provider never once succeeded.
- **Headless goal runs.** `arterm --print --goal "…"` drives any autonomy mode
  without a terminal and streams its verdicts; `--json` adds a structured
  run + verdict list plus a `guards` block (`loopSteers`, `loopCuts`,
  `extensions`) — a run the loop detector killed twice no longer prints
  exactly like a run that had nothing to do.
- **Inspectable permissions + remote approval.** `arterm permissions explain
  <tool>` prints the full rule trace for one proposed call and `arterm
  permissions list` tables every tool — both through the same `evaluate()`
  the runtime uses, so the inspectors cannot drift from the policy. Pending
  permission prompts can be approved remotely through the status server.
- **Provider resilience.** A bounded retry budget with a typed error taxonomy,
  a fallback model chain (`fallbackModels`) that short-circuits refusals to
  the next model, and a rule the Anthropic provider enforces: the vendor SDK
  never owns the retry loop, so an hour-long `Retry-After` can no longer
  become an hour-long sleep the fallback chain cannot see. Exercised by a
  fault-injection e2e (`scripts/provider-resilience-e2e.mjs`) and a manual
  fault server (`scripts/fault-server.mjs`).
- **Concurrent sessions.** Multiple sessions in one TUI with a session panel,
  Ctrl+X close, and recorded sessions resumable via `--resume <id>` /
  `--continue`.
- **/sdd workers get their context.** Each task's prompt now carries the spec
  its graph was cut from and the quoted output of every finished dependency —
  the only channel between waves — with a scope sentence that keeps a worker
  on its own task. The kanban is navigable, runs are keyed by their own task
  ids, and stranded work is surfaced instead of hidden.

### Fixed

- A turn now actually finishes when its work does, and sub-agents inherit the
  parent's token/context limits instead of running uncapped.
- Free-text slash commands no longer flatten what was typed after them.
- Mouse capture modes are re-asserted on resize, healing host-emulator resets.

## [0.3.3] — 2026-07-12

### Added

- **Fullscreen mode (default).** The TUI now owns the whole window on the
  alternate screen, like Claude Code's fullscreen renderer: the input and
  status bar stay pinned to the bottom **even while scrolling**, and the wheel
  scrolls the chat in-app (SGR mouse capture — direction is encoded in the
  bytes; text selection uses the terminal's Shift+drag bypass). PgUp/PgDn page;
  ↑ still recalls prompt history; a hint row shows how far back you are.
  `tui.fullscreen: false` restores the classic native-scrollback mode, and
  `tui.mouse: false` swaps capture for alternate-scroll arrows (plain
  drag-select, terminal-dependent wheel direction).
- **Type while the model works + message queue.** The prompt stays live during
  a turn; Enter queues each message (dimmed ⏳ lines above the input) and the
  queue dispatches FIFO as the loop returns to idle. Esc cancels the turn and
  drops the queue; `/clear` empties it too.
- **`/copy`** copies the last assistant reply to the clipboard via OSC 52.
- **Degenerate tool-call recovery.** Small local models that emit
  `{"<tool>": {…}}` (no name/arguments wrapper) are now recovered — gated on
  real tool names so ordinary JSON in prose can never be mistaken for a call.

### Fixed

- **Flicker-free rendering.** All of Ink's repaint writes are coalesced into
  single frames wrapped in DEC 2026 synchronized output (skipped under tmux),
  and the worst-case full clear can no longer wipe the terminal's scrollback.
- **Fullscreen scrollback actually scrolls.** The old margin-based viewport
  never revealed older rows (it only shrank the visible slice — reading as an
  inverted wheel); the new cutter-window viewport gives line-precise
  scrollback, verified by content-level tests.
- **Footer stays glued to the bottom** in classic mode (AnchoredRegion: the
  dynamic region's height never shrinks mid-flight, so Ink's top-anchored
  repaints can't strand it) — including across resizes.
- **Expired OAuth sessions recover cleanly.** A dead refresh token
  (invalid_grant) is dropped and reported as one actionable line instead of a
  raw 400 dump on every turn.
- Wheel scroll direction restored (wheel up = older lines); typing no longer
  garbles around fast submits (input handlers read state through refs).

## [0.3.2] — 2026-07-11

### Added

- **Team board navigation.** ↑/↓ on an empty prompt select a member on the
  /team board (❯ marker), Enter drills into the selected member's live
  activity feed (tool calls, results, messages — last 100 lines per member),
  Esc closes it. Works during the run and after it finishes.

### Fixed

- **Sub-agent failures are no longer silent.** A sub-agent whose provider
  call failed (e.g. a 401/quota error) used to report "(sub-agent produced
  no output)" while the real reason stayed invisible on its private bus; the
  error now comes back as the sub-agent's result and the member/worker is
  marked failed on the board and in the round summary.

## [0.3.1] — 2026-07-11

### Performance

- **Startup is ~2× faster** (≈2.2s → ≈1.1s to the TUI; `--version` and headless
  bootstrap dropped from ~1s to ~130ms):
  - The OpenAI-compatible host reachability probe no longer blocks startup — it
    runs in the background after the session is up (a WAN round-trip to a relay
    cost ~1s on every launch) and surfaces as an in-TUI warning if it fails.
  - Heavy dependencies load lazily on first use instead of at startup: `execa`
    (shell/git/project tools), `fast-glob` (glob/grep), the MCP SDK server
    modules (`arterm mcp`), and the Ink/yoga rendering stack — the published
    bundle is now code-split so non-TUI commands never load the UI at all.

## [0.3.0] — 2026-07-11

### Added

- **Agent teams (`/team <task>`).** A new autonomy mode where the leader assembles a
  named team of specialist members and assigns work per round: roster (from your
  agent definitions, or ad-hoc) → parallel rounds with per-member git-worktree
  isolation for write-capable members → integration → reflect/repeat. A live member
  board in the TUI shows each member's state, current assignment, and last tool
  activity; `/pause /resume /stop` and plain-text steering work as with `/goal`.
  Also reachable as `/autonomy team <goal>`, and configurable via the new
  `config.team` block (`fanout`, `maxRounds`, `isolation`, `mergeStrategy`, `suggest`).
- **Agent definition files (`/agents`).** Define reusable specialist sub-agents as
  markdown: `<project>/.arterm/agents/*.md` and `~/.arterm/agents/*.md` (project wins
  on name collisions). Frontmatter `name` / `description` / `tools` (allowlist), body
  = the member's system prompt. Definitions also extend the role set used by the
  parallel/phased autonomy modes and `/sdd`, and reload live via `/plugins reload`.
- **Team auto-suggestion.** A large-looking prompt (multiple enumerated items or
  chained scopes) gets a one-line y/N offer to run as a team instead — never a
  silent switch. Disable with `config.team.suggest = false`.
- **Patch auto-apply (`mergeStrategy`).** Worktree patches from team members are
  applied back onto the main tree with `git apply --3way` (team default). A conflict
  marks the member failed and keeps its `arterm/fleet/*` branch for manual recovery;
  `"surface"` keeps the old report-only behavior. The previously dormant
  `config.fleet.mergeStrategy` is now honored for plain fleet runs too.
- **Member observability.** Team members bridge whitelisted events (tool calls,
  messages — never token deltas) off their private bus with a stable member id;
  the HQ dashboard gained a Team panel driven by the same id-keyed events.

### Removed

- **The HQ web dashboard.** The multi-agent aggregator, WebSocket reporter, the
  Next.js web app, the `arterm hq` subcommand, the `--hq`/`--hq-port`/`--hq-connect`
  flags, the `/web`·`/hq` TUI commands, and the `config.hq` block are gone (a
  leftover `hq` block in an existing config file is ignored harmlessly). Live
  multi-agent visibility now lives in the TUI itself (the /team member board).

### Fixed

- **Spurious "host not reachable" warning at startup.** The openai-compat
  preflight probe now carries the stored API key and the configured custom
  headers, so gateways that gate on them (e.g. agentrouter) no longer make a
  perfectly working setup warn on every launch.
- **Sub-agents now inherit MCP/plugin/memory tools.** `spawn`, `spawn_parallel`,
  parallel/phased autonomy workers, and `/sdd` tasks previously ran with only the
  built-in tool set; they now read the live tool roster at spawn time (delegation
  tools still excluded — depth stays one level).

## [0.2.0] — 2026-07-05

A large feature release: subscription login, a multi-agent web dashboard, richer
tooling for small models, a persistent-memory engine, and a Windows-hardening pass.
Backward compatible with 0.1.x configs.

### Added

- **Subscription (OAuth) login for Claude.** Sign in with a Claude Pro/Max account
  instead of an API key: `arterm login [provider]` / `arterm logout [provider]`,
  PKCE flow, encrypted token store with automatic refresh. The TUI login overlay
  gained an inline OAuth step (open browser → paste the `code#state`).
- **HQ monitoring dashboard.** A multi-agent web UI to watch and control live
  sessions: `/web` (alias `/hq`) in the TUI or `--hq` at startup spins up a shared
  aggregator (auto-picks a free port) and reports the session to it; other sessions
  attach with `--hq-connect <url>`. Pause/resume/stop/steer/set-goal from the browser.
  Built as a static Next.js app served by the aggregator. Headless `--print` runs can
  also report with `--hq`.
- **`@arterm/memory` engine (opt-in).** A richer claude-mem-style persistent memory
  (structured observations, progressive-disclosure legend, SQLite/FTS5, semantic
  search). Enable with `config.memory.engine = "cmem"`; the legacy memory stays the
  default. Project memory is scoped to the git repo root.
- **More tools for small models.** `web_search` (keyless), `git` / `git_commit`,
  `test` / `lint` / `format` (package-manager auto-detected), `search` (BM25 code
  search), `symbols` (symbol-level code index), and the `tool_search` / `batch`
  meta-tools so weaker models stop hallucinating tool names.
- **Worktree isolation for the fleet.** Parallel/phased autonomy and `spawn_parallel`
  workers can each run in their own git worktree (`config.fleet.isolation`).
- **Spec-Driven Development.** `/sdd <brief>` runs an interactive interview → spec →
  task-graph → DAG execution, with a live kanban board and phased coordinator.
- **models.dev catalog** lookups for real context windows, pricing, and native-tool
  capability; `arterm models` is enriched, and a `/cost` command shows token usage
  and estimated spend.
- **Headless / scripting mode:** `--print <prompt>` (and piped stdin) run one turn
  without the TUI; `--json` emits `{response, usage, toolCalls}`.
- **Session resume:** `--resume <id>` / `--continue` plus `arterm sessions`.
- **Setup & config UX:** `arterm init` wizard, `/config` editor, login overlay,
  markdown-rendered assistant output, a startup banner, and rich line-numbered edit
  diffs with a per-turn “N files changed” summary.

### Changed

- **Auto permission mode is now “smart”:** safe shell commands screened by the risk
  arbiter run without a prompt, while critical/destructive commands are still gated.
- The context gauge and auto-compaction now use each model's real context window from
  the catalog instead of a fixed 8k.
- The single-agent inline dashboard was replaced by the aggregator + web app as the
  one dashboard.
- CI added (GitHub Actions); line endings normalized to LF.

### Fixed

- **Windows command screening gap:** the arbiter and `bash` deny-list now cover
  Windows-native destructive commands (`rd /s`, `del`, `format`, `reg delete`, …),
  closing a hole in smart-auto mode.
- `bash` process tree-kill on Windows (a hang on cancellation).
- OAuth login URL on Windows opened via `rundll32` so `&` in the URL isn't truncated.
- Memory digest falls back to the main model when `summarizeModel` is invalid.
- Provider requests retry transient failures; config is validated (zod + deep-merge)
  and warns on malformed JSON instead of silently resetting.
- Mouse-wheel scroll direction in the transcript; assorted TUI status-bar spacing.

### Security / robustness

- `EventBus.emit()` isolates each listener in try/catch so one bad subscriber can't
  crash a turn.
- Global `unhandledRejection` / `uncaughtException` handlers; `agent.assess()` /
  `agent.plan()` guarded against provider errors; `agent.run()` turn teardown no
  longer leaks on pre-loop I/O failures.
- Ollama embedder fetch has a 10s timeout.
- Headless mode is fail-closed: tools needing a permission prompt are denied unless
  `--yolo` / an auto mode is set.

## [0.1.2] — 2026-06-26

- Correctness and robustness fixes from a full-codebase audit (stream timeout, symlink
  confinement, Ollama tool handling, search cache, context gauge).
- Provider-aware startup preflight.

## [0.1.1] — 2026-06-25

- Ran the agent loop on the DI kernel (Container / RunController / Pipeline migration,
  D1–D6).

## [0.1.0] — 2026-06-24

- First npm-ready release: WrongStack-parity safety (risk tiers, yolo fail-closed),
  parallel autonomy, the DI kernel, responsive status bar, edit diffs + `multi_edit`,
  persistent project memory, a memory viewer web UI, and an `arterm mcp` stdio server.

[0.2.0]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.2.0
[0.1.2]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.1.2
[0.1.1]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.1.1
[0.1.0]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.1.0
