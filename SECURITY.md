# Security

Arterm runs a language model's output on your machine. This document says what
is constrained, what is **not**, and which of the gaps are known and accepted —
so that a control is not read as a guarantee it cannot give.

Reviewed against the source at **v0.6.0**.

## Reporting a vulnerability

Open a [security advisory](https://github.com/Arclude/Arterm-CLI/security/advisories/new),
or email **info@arclude.com**. Please do not open a public issue for something
exploitable. A working reproduction against the built binary is worth more than
a description; the `scripts/*-e2e.mjs` files are the shape we can act on
fastest.

## Threat model

The adversary is **untrusted model output and untrusted content that reaches
the model's context** — a file it reads, a page it fetches, an MCP server's
response, a dependency's README. The controls here raise the cost of that
content turning into an action you did not ask for.

The adversary is **not the operator**. Arterm runs with your account's
authority, and anything you can do at a shell you can do through Arterm by
asking for it. Nothing here is a defence against yourself, and none of it is an
isolation boundary for hostile *code you chose to run*.

## Controls in the current source

**The permission ladder** (`core/src/permissions.ts`). `evaluate()` is the whole
policy — a pure function returning `allow | deny | prompt` plus the trace of
every rule it consulted. Read-only tools auto-allow; tools that write files or
run commands ask, with a per-tool "always allow" that persists. Four modes
(`ask` / `auto` / `plan` / `yolo`). `arterm permissions list` and
`arterm permissions explain` evaluate the same function, so an inspector can
never describe a policy nobody runs. What it decides is *whether* a command
runs; it has nothing to say about what an allowed command then reaches.

**The risk arbiter** (`core/src/arbiter.ts`). Grades a proposed command before
the ladder's answer is final. Two facts about it are worth stating plainly:

- `CRITICAL_BASH` / `HIGH_BASH` are deny-lists, and a deny-list **fails open** —
  what it does not recognise it grades `medium`, which runs without a prompt
  under `auto` and `yolo`.
- `OPAQUE_BASH` is the half that fails closed. It does not guess the payload of
  `echo … | base64 -d | sh`; it matches the *hiding* and grades it `high`.
  Reading `~/.arterm/key` or `~/.arterm/secrets.json` is graded `critical` — the
  one grade that means "no legitimate call exists" — and third-party credential
  reads (`~/.ssh/id_*`, `~/.aws/credentials`, `~/.netrc`, `~/.npmrc`) are `high`
  and marked `attendedOnly`, so where nobody would answer the prompt they are
  refused rather than allowed.

**The execution sandbox** (`core/src/sandbox.ts` policy,
`tools/src/sandbox.ts` mechanism over `@anthropic-ai/sandbox-runtime`:
bubblewrap + seccomp on Linux, Seatbelt on macOS, WFP on Windows).
**On by default since v0.6.0**, in attended sessions as well as `--autonomous`
ones. A confined command may write only the session's working directory and the
OS temp dir; it may reach only an allowlist of hosts (package registries and
source hosts; SSH denied); and it cannot read Arterm's own key material
whatever else it is granted. The boundary is derived at boot from the session's
cwd and never from a tool call's arguments — a boundary a tool call can name is
not a boundary (CVE-2025-59532, CVE-2026-50548). The wrapped command is spawned
as argv, never through a shell.

**Credential withholding** (`core/src/credentials.ts`). A command is not handed
the keys you gave Arterm. Variables are judged by **name**, never by value —
value-sniffing eventually eats a `PATH` entry, and a control that breaks the
toolchain is one people switch off. On in every mode, and default-closed even
when unwired, so a sub-agent or a test is not the one path that still hands them
over. Covers `bash`, `exec`, the project scripts (`test` / `lint` / `format` /
`install`), the `git` tool, and the verification command.

**File tools are confined to the working directory** (`tools/src/paths.ts`).
`read`, `write`, `edit`, `ls`, `glob`, `grep` refuse absolute paths, `..`
segments, and symlinks that escape — the check is re-run after resolving
symlinks, because a lexical prefix test cannot see them.

**Files you name yourself are deliberately NOT confined**
(`core/src/attachments.ts`, `core/src/mentions.ts`). A path typed into the
composer is not model output: you named a file on your own machine and pressed
Enter. What keeps the exception honest is structural — nothing in the tool layer
may call these — plus a magic-number check on images, a NUL-byte check on text,
size ceilings, and a refusal that always names the file.

**A tamper-evident record of what a run did** (`core/src/chronicle.ts`). One
hash-chained JSONL per session under `$ARTERM_HOME/chronicle/`, built from the
seam rather than from the model's summary: the tool's own path and diff, and a
content hash read back off the disk. Shell writes are measured by digesting the
tree around the call. `arterm chronicle verify` exits 1 on a broken chain.

**Key material at rest** (`core/src/keystore.ts`). `$ARTERM_HOME/key` is written
`0600` (a no-op on Windows) and holds the master key for `secrets.json`.

## Known gaps

Treat these as known and accepted rather than as new findings.

**The sandbox confines commands, not Arterm.** It covers `bash`, `exec`, and the
project scripts. It does **not** cover: Arterm's own process; MCP servers, which
are spawned from your config by the SDK's stdio transport; the verification
command, which is scrubbed but not sandboxed; the `git` tool, which is instead a
fixed list of read-only subcommands with the code-running flags (`-c`,
`--exec`, `--exec-path`, `--upload-pack`, `--receive-pack`, `-o`) refused; and
plugins and skills, which are loaded into the process. If you need one boundary
around all of it, run Arterm inside a container.

**The transcript is an exfiltration channel and no egress rule sees it.**
Anything a command prints goes into the conversation and is sent to your model
provider on the next turn. The sandbox's allowlist governs what a *command* can
dial; it has nothing to say about our own request to the model. Credential
withholding and the keystore denial exist because that channel cannot be closed.

**The egress allowlist prevents an arbitrary channel, not every channel.** It
carries `github.com`, `gitlab.com`, and the package registries, because a run
that cannot reach them fails on its first install. Each is a destination whose
contents are already public; none is a destination a determined exfiltration
attempt could not use.

**Reads are less constrained than writes.** A confined command may read most of
the filesystem — only the write roots, the egress list, and the keystore denial
are enforced. The arbiter is what stands in front of `cat ~/.ssh/id_rsa`, and it
is a pattern list.

**Hiding split across calls is not detected.** `curl … > /tmp/x` in one call and
`sh /tmp/x` in the next reads as ordinary on both sides, and a rule wide enough
to catch the pair fires on `wget deps.tar && python3 setup.py`. What bounds this
is the egress allowlist, not a pattern.

**An attended session continues without a boundary if one cannot be
established** (no user namespaces, an unsupported platform), with a warning on
stderr. Unattended runs refuse to start instead. This is deliberate: a session
that refuses to open earns `--no-sandbox` in a shell alias, and then nothing is
confined at all.

**Prompt injection is not solved here.** The controls narrow what an injected
instruction can accomplish; they do not detect one.

## Supported versions

Fixes land on the latest minor. There are no backports to earlier lines.
