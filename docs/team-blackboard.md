# Team coordination ("blackboard") — how members share context

> **Accuracy note (verify before you rely on this).** The Round 1 findings this
> doc was requested from describe a member-to-member messaging feature with a
> `message` tool, a `BoardEntry` data structure, and per-member next-round
> delivery in `packages/core/src/blackboard.ts` + `packages/tools/src/message.ts`.
> **Those files and that API do not exist in this repository.** There is no
> `message` tool exported from `packages/tools` and no `BoardEntry` type anywhere
> in the source. This doc documents the team-coordination mechanism that the code
> **actually** implements today, and explicitly flags where it differs from the
> requested description so nobody ships docs for code that isn't there.
>
> Files this is based on (read and verified): `packages/core/src/team.ts`,
> `packages/core/src/autonomy.ts` (`runTeamLoop`, `assembleTeam`, `assignWork`,
> `aggregate`), and `packages/cli/src/session.ts` (fleet wiring / isolation /
> merge).

## What "team mode" actually is

Team mode is a **leader-mediated** loop, not a peer-to-peer message board. One
leader agent owns the shared context; specialist *members* run in isolation and
never talk to each other directly.

The loop lives in `AutonomyEngine.runTeamLoop()`
(`packages/core/src/autonomy.ts`):

1. **Assemble the roster (once).** `assembleTeam()` asks the leader to design up
   to `teamFanout` members (default 4, hard cap 16). Members are parsed by
   `parseRoster()` in `team.ts`: names matching a loaded agent definition adopt
   that definition's instruction/tools; unknown names become "ad-hoc" members
   from the leader's brief. An unusable roster falls back to a built-in
   `implementer` + `reviewer` pair. Each member gets a stable `id`
   (`m1-reviewer`) and a lowercased `name`.

2. **Assign work each round.** `assignWork()` asks the leader for up to
   `teamFanout` **independent** tasks (`buildTeamDecomposePrompt` /
   `parseAssignments`), one per member by name. The prompt instructs the leader
   to give each member its own files so two members never edit the same file.

3. **Run the fleet concurrently.** Each assignment becomes an `AutonomyTask`
   (`{ task, role, id, instruction | systemPrompt, toolNames }`) and the injected
   `runFleet` runner executes them in parallel. Write-capable members run in
   their own git worktree; read-only members share the cwd
   (`memberIsolation()` in `team.ts`, wired in `session.ts`).

4. **Integrate + reflect.** `aggregate()` folds every member's output back into
   the **leader's** history as one combined message, then `agent.assess()`
   decides whether the goal is done. The loop repeats until assess-done,
   `/stop`, two idle rounds, or the `teamRounds` cap (default 6, hard cap 20).

## How context is shared (the real "board")

There is exactly one place shared context lives: **the leader's conversation
history.**

- Members do **not** read each other's output. Within a round they run
  concurrently and in isolation.
- After a round, `aggregate()` concatenates all member results into a single
  prompt (`### Subtask N: <task>\n<output>`) and feeds it to the leader. Only the
  leader accumulates cross-member context.
- The next round's assignments are derived from that accumulated leader context.
  So information flows **member → leader → (next round) member**, always through
  the leader — never member → member directly.

Live activity is *observable* (the `/team` TUI board bridges each member's
private event bus so you can watch progress — see `eventBus.ts` and
`teamFeed.ts`), but that is a read-only view, not a channel members can post to.

## Mapping the requested concepts to reality

| Requested (Round 1 report) | Actual state in this repo |
| --- | --- |
| `message` tool (`packages/tools/src/message.ts`) | Does not exist. No `message` tool is registered or exported. |
| `BoardEntry` data structure | Does not exist. |
| `blackboard.ts` send/store/read functions | Does not exist. |
| Directed (`to: <name>`) vs broadcast addressing | Not implemented. The only name-addressing is the **leader → member** task assignment in `parseAssignments()`. |
| Next-round delivery of messages | The closest real behavior is the round boundary: member output reaches the leader after the round via `aggregate()`, and can influence next-round assignments. There is no per-member inbox. |

## Known limitations / caveats

These are the real, code-backed caveats for team coordination as implemented.
(The reviewer's caveats about a `message` tool are omitted because that tool is
not present.)

- **No member-to-member messaging.** Members cannot send notes to one another. If
  two tasks truly depend on each other, they must be split across rounds so the
  leader can carry the result forward — the round prompt explicitly asks for
  *independent* tasks only.

- **Name matching is case-insensitive but name-collapsing.** `parseRoster()` and
  `parseAssignments()` lowercase and trim names (`byName` keyed on
  `name.toLowerCase()`). Two members whose names differ only by case collapse to
  one entry (`seen` set), and duplicate roster names are dropped.

- **Unknown/blank assignee falls back silently.** If the leader names a member
  that isn't on the roster (or omits the name), `parseAssignments()` round-robins
  the task onto an existing member rather than failing. A misspelled name can
  therefore run a task on the wrong member.

- **Isolation means no shared working tree mid-round.** Write-capable members work
  in separate worktrees; their changes are only merged back sequentially after
  the round (`session.ts`, merge strategy defaults to `apply`). Members cannot see
  each other's uncommitted edits during a round.

- **Bounded rounds / fanout.** Assignments per round are capped at `teamFanout`
  (default 4, max 16); rounds are capped at `teamRounds` (default 6, max 20). Work
  that needs more concurrency or more rounds than the caps is truncated/stopped.

- **Idle-round stop.** Two consecutive rounds with no proposed work stop the run
  ("no further team work proposed"), even if the goal isn't complete.

## If the blackboard feature is planned

If member-to-member messaging is on the roadmap, this doc should be rewritten
once `packages/core/src/blackboard.ts` and a `message` tool actually land — at
that point the `BoardEntry` shape, send/store/read flow, addressing semantics,
and next-round delivery can be documented against real code.
