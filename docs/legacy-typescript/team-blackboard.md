# Team coordination — how members share context

Team mode (`/team`) runs a **leader** agent that assembles a roster of specialist
**members** and assigns each one independent work per round. Members run
concurrently and in isolation, so they cannot see each other live. Two channels
carry context across round boundaries:

- the **shared blackboard** — what a member tells the team (member → member);
- **per-member memory** — what a member tells its own future self (member → itself).

Both are per-run and in-memory, owned by the CLI session and handed to the engine.

Files this documents: `packages/core/src/blackboard.ts`,
`packages/core/src/memberMemory.ts`, `packages/tools/src/message.ts`,
`packages/tools/src/memo.ts`, `packages/core/src/team.ts`,
`packages/core/src/autonomy.ts` (`runTeamLoop`, `assembleTeam`, `assignWork`,
`aggregate`), and `packages/cli/src/session.ts` (fleet wiring / isolation / merge).

## The loop

`AutonomyEngine.runTeamLoop()` (`packages/core/src/autonomy.ts`):

1. **Assemble the roster (once).** `assembleTeam()` asks the leader to design up to
   `teamFanout` members (default 4, hard cap 16). `parseRoster()` (`team.ts`) matches
   names against loaded agent definitions — a match adopts that definition's
   instruction/tools, an unknown name becomes an "ad-hoc" member from the leader's
   brief. An unusable roster falls back to a built-in `implementer` + `reviewer` pair.
   Each member gets a stable `id` (`m1-reviewer`) and a lowercased `name`.

2. **Assign work each round.** `assignWork()` asks the leader for up to `teamFanout`
   **independent** tasks, one per member by name. Each member's task is prefixed with
   its own memory digest, then the board digest meant for it (see below).

3. **Run the fleet concurrently.** Each assignment becomes an `AutonomyTask` and the
   injected `runFleet` runner executes them in parallel. Write-capable members run in
   their own git worktree; read-only members share the cwd (`memberIsolation()` in
   `team.ts`, wired in `session.ts`).

4. **Integrate + reflect.** Every non-failed member's output is posted to the board
   and recapped into that member's own memory. `aggregate()` also folds the outputs
   into the leader's history, then `agent.assess()` decides whether the goal is done.
   The loop repeats until assess-done, `/stop`, two idle rounds, or the round cap.

## The shared blackboard (member → member)

`Blackboard` (`packages/core/src/blackboard.ts`) holds `BoardEntry` postings:

```ts
interface BoardEntry {
  from: string;        // author member id (or "leader")
  fromName: string;
  to?: string;         // target member id — a directed message; omitted = broadcast
  toName?: string;
  round: number;       // the round the entry was posted in
  kind: "result" | "message";
  text: string;        // trimmed to 600 chars
}
```

Two things write to it:

- **The engine**, at each round boundary: every non-failed member's output is posted
  as `kind: "result"` (a broadcast — `to` is always absent).
- **Members**, via the `message` tool (`packages/tools/src/message.ts`): a
  `kind: "message"` note, either addressed to a teammate (`to: "<name>"`, resolved
  case-insensitively against the roster by `resolve()`) or broadcast when `to` is
  omitted. An unresolvable `to` falls back to a broadcast rather than dropping the
  note. The tool is built per member and pushed onto the member's tool set in
  `session.ts`, independent of any `tools:` allowlist.

**Delivery** is `briefFor(memberId)`, rendered into the member's next task prefix.
A member receives entries that are: from an **earlier** round (members run in
parallel, so same-round work is invisible), authored by **someone else**, and either
a broadcast/result or addressed to it. Directed messages are surfaced first, since
they expect a response. A member never sees its own postings echoed back — that is
what memory is for.

Switch: `config.team.blackboard` (default `true`). `false` restores the pure star
topology, where all coordination funnels through the leader's aggregation.

## Per-member memory (member → its future self)

`MemberMemory` (`packages/core/src/memberMemory.ts`) holds private `MemoryEntry`
lists keyed by member id — no member ever reads another's:

```ts
interface MemoryEntry {
  round: number;
  kind: "note" | "recap";
  text: string;        // trimmed to 600 chars
}
```

Members are isolated and re-created each round, so without this a member starts every
round with no memory of its own work. Two things write to it:

- **Members**, via the `memo` tool (`packages/tools/src/memo.ts`): a deliberate
  `kind: "note"` for their future self — a decision, an approach already ruled out,
  something deferred. Capped at the last 12.
- **The engine**, at each round boundary: the member's own output as a
  `kind: "recap"`, so continuity survives even when the member never calls `memo`.
  Capped at the last 3 — a stale recap is noise, while a decision stays true.

**Delivery** is `recall(memberId)`, prefixed to the member's next task ahead of the
board digest: notes first (they encode decisions), then recent output. Everything in
it was written by the member itself, so nothing is filtered by author.

Switch: `config.team.memory` (default `true`). `false` makes members start each round
with no memory of their own earlier work.

Note the three neighbouring tools are distinct: `message` shares with teammates,
`memo` is private to one member for one run, and `remember`
(`packages/tools/src/memoryTools.ts`) persists across sessions.

## Observing it

Live member activity is observable but read-only: the `/team` TUI board bridges each
member's private event bus (`eventBus.ts`, `teamFeed.ts`). Both channels also surface
as bus events consumed by the desktop app — `team_message` for board postings and
`team_memory` for `memo` notes. Recaps are deliberately not emitted as `team_memory`;
they are already on the wire as the matching `kind: "result"` `team_message`. See
`docs/desktop-integration.md` §6 for the wire contract.

## Known limitations / caveats

- **Coordination lands at round boundaries, not live.** Members run concurrently and
  isolated, so a note or result written during round N is only read entering round
  N+1. Two tasks that truly depend on each other still need splitting across rounds —
  the round prompt asks the leader for *independent* tasks.

- **Name matching is case-insensitive but name-collapsing.** `parseRoster()` and
  `parseAssignments()` lowercase and trim names. Two members whose names differ only
  by case collapse to one entry, and duplicate roster names are dropped.

- **Unknown/blank assignee falls back silently.** If the leader names a member that
  isn't on the roster (or omits the name), `parseAssignments()` round-robins the task
  onto an existing member rather than failing. A misspelled name can therefore run a
  task on the wrong member.

- **Isolation means no shared working tree mid-round.** Write-capable members work in
  separate worktrees; their changes are merged back sequentially after the round
  (`session.ts`, merge strategy defaults to `apply`). Members cannot see each other's
  uncommitted edits during a round.

- **Everything is truncated and capped.** Board entries and memory entries are cut at
  600 chars; memory keeps 12 notes + 3 recaps per member. Long outputs reach teammates
  and future rounds abridged.

- **Failed rounds leave no trace.** A member slot that errored is neither posted to the
  board nor recapped into memory — its output is an error string, not useful context.

- **Bounded rounds / fanout.** Assignments per round are capped at `teamFanout`
  (default 4, max 16); rounds are capped at `teamRounds` (default 6, max 20). Work
  needing more concurrency or rounds than the caps is truncated/stopped.

- **Idle-round stop.** Two consecutive rounds with no proposed work stop the run ("no
  further team work proposed"), even if the goal isn't complete.

- **Nothing persists past the run.** Both the board and member memory are per-run and
  in-memory; a new team run starts blank (`clear()`).
