# Competitor CLI Coding Agent Research: Claude Code vs. OpenAI Codex CLI

> **Purpose:** Identify feature gaps for Arterm (Rust-based terminal AI coding agent)
> **Research date:** 2026-08-13
> **Sources:** Official documentation (docs.claude.com, developers.openai.com/codex), GitHub repos (openai/codex)

---

## Executive Summary

| Dimension | Claude Code (Anthropic) | Codex CLI (OpenAI) |
|---|---|---|
| **Language** | TypeScript/Node.js | Rust |
| **Primary models** | Claude Opus/Sonnet/Haiku/Fable | GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4 |
| **Multi-model** | Anthropic family + 3rd-party providers (Bedrock, Vertex, Foundry) | OpenAI family + custom providers (Ollama, LM Studio, any Responses/Chat API) |
| **Sub-agent architecture** | Built-in + custom markdown agents (`.claude/agents/`) | Built-in + custom TOML agents (`.codex/agents/`) |
| **MCP support** | Full (stdio, HTTP, SSE, WS) | Full (stdio, HTTP) |
| **Memory** | CLAUDE.md + auto-memory (MEMORY.md) | AGENTS.md + Memories (TOML config, off by default) |
| **Permission system** | Tiered: default/acceptEdits/plan/auto/dontAsk/bypass + sandbox | Tiered: read-only/workspace-write/danger-full-access + approval policies |
| **Hooks/extensions** | Extensive (command, HTTP, MCP, prompt, agent hooks) | Lifecycle hooks (command-based, in `hooks.json` or inline config) |
| **IDE integration** | VS Code, JetBrains, Desktop app, Web, Chrome | VS Code, Cursor, Windsurf, Desktop app, Web, Cloud |
| **Pricing** | Claude subscription ($20-200/mo) or API | ChatGPT plan ($0-200/mo) or API |

---

## 1. Claude Code (Anthropic)

### 1.1 Overview

Claude Code is Anthropic's agentic coding tool that reads codebases, edits files, runs commands, and integrates with development tools. Available across terminal, IDE extensions (VS Code, JetBrains), desktop app, web (claude.ai/code), and Chrome browser extension.

### 1.2 Full Tool/Feature List

**Built-in tools (named by canonical tool name):**

| Tool | Description |
|---|---|
| `Bash` | Execute shell commands; auto-backgrounding on timeout; output limits up to 150K chars |
| `PowerShell` | Native PowerShell on Windows (opt-in on Linux/macOS with pwsh 7+) |
| `Read` | Read file contents (no permission prompt within working dir) |
| `Grep` | Ripgrep-based pattern search; respects `.gitignore` |
| `Glob` | File pattern matching (`**/*.js`) |
| `Edit` | Exact string replacement in files |
| `Write` | Create or overwrite files |
| `NotebookEdit` | Jupyter notebook cell modification |
| `Agent` | Spawn subagents with own context window |
| `WebFetch` | Fetch URL content |
| `WebSearch` | Web search |
| `TodoWrite` / `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` | Task management (TodoWrite deprecated in favor of Task* tools) |
| `Monitor` | Run command in background, feed output lines back; WebSocket event monitoring |
| `LSP` | Code intelligence via language servers (definitions, references, type errors) |
| `Skill` | Execute packaged workflows |
| `Workflow` | Run dynamic multi-subagent orchestration scripts |
| `EnterPlanMode` / `ExitPlanMode` | Plan mode (read-only exploration before editing) |
| `EnterWorktree` / `ExitWorktree` | Git worktree isolation |
| `CronCreate` / `CronDelete` / `CronList` | Session-scoped scheduled tasks |
| `ScheduleWakeup` | Self-paced loop rescheduling |
| `Artifact` | Publish HTML/Markdown as shareable claude.ai artifact |
| `PushNotification` | Desktop + phone push notifications |
| `SendUserFile` | Send files to user's device |
| `SendMessage` / `ListAgents` | Cross-session messaging |
| `AskUserQuestion` | Multiple-choice clarification questions |
| `ToolSearch` | Deferred tool loading for large MCP server pools |
| `ReportFindings` | Structured code-review findings |
| `ShareOnboardingGuide` | Upload and share ONBOARDING.md |
| `ListMcpResourcesTool` / `ReadMcpResourceTool` | MCP resource access |
| `EndConversation` | Session termination (safety valve) |

**Key features beyond tools:**
- Git integration (commits, PRs, branches)
- Inline diff review
- GitHub Actions / GitLab CI/CD integration for automated PR review
- GitHub Code Review (automatic review on every PR)
- Slack integration (`@Claude` for bug-to-PR workflow)
- Chrome browser debugging
- Remote Control (continue session from phone/browser)
- Channels (Telegram, Discord, iMessage, webhooks push events into session)
- Routines (cloud-scheduled recurring tasks)
- `/loop` (repeat prompt within session)
- `--teleport` (pull web/mobile task into terminal)
- Conversation search and session resume

### 1.3 Multi-Model Support

- **Anthropic models:** Claude Opus, Sonnet, Haiku, Fable (with tier aliases)
- **Third-party providers:** Amazon Bedrock, Google Cloud Agent Platform, Microsoft Foundry, Claude Platform on AWS
- **Third-party integrations:** Configurable base URLs for other API providers
- Per-subagent model selection (`model` field in agent definitions)
- Extended thinking configuration (inherited by subagents)
- Model allowlists for organizations (`availableModels`)
- Service tier selection (`fast` tier)

### 1.4 Agent / Sub-Agent Architecture

**Built-in subagents:**
- **Explore** - read-only codebase search/analysis (capped at Opus on API)
- **Plan** - research agent for plan mode
- **General-purpose** - full tool access for complex tasks
- **statusline-setup** - Sonnet-based status line config
- **claude-code-guide** - Haiku-based feature Q&A

**Custom subagents** (`.claude/agents/*.md` or `~/.claude/agents/*.md`):
- YAML frontmatter + markdown system prompt
- Fields: `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `effort`, `background`, `isolation` (worktree), `color`, `initialPrompt`
- Scopes: managed, CLI-defined, project, user, plugin
- Subagents run in own context window (background by default as of v2.1.198)
- Fork mode (inherit full parent conversation)
- Agent teams (coordinated team of sessions with task tools)
- Background agents (multiple full sessions in parallel, monitored from one screen)
- Cross-session messaging between agents

### 1.5 MCP (Model Context Protocol) Support

- **Transports:** stdio, HTTP (streamable), SSE (deprecated), WebSocket
- **Scopes:** local, project (`.mcp.json`), user, plugin-provided
- **OAuth 2.0** authentication for remote servers
- **Environment variable expansion** in `.mcp.json` (`${VAR}`, `${VAR:-default}`)
- **Dynamic tool updates** (`list_changed` notifications)
- **Automatic reconnection** with exponential backoff (HTTP/SSE)
- **Tool search** for large MCP pools (deferred loading)
- **Automatic backgrounding** of long MCP tool calls (>2 min)
- **MCP as channels** (servers can push messages into sessions)
- **Plugin MCP servers** (bundled with plugins)
- **Per-server timeouts**, idle timeouts, output token limits
- `claude mcp add/list/get/remove` CLI commands
- `/mcp` interactive panel

### 1.6 Memory / Context Management

**Two complementary systems:**

1. **CLAUDE.md files** (user-written instructions):
   - Scopes: managed policy, user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md`), local (`CLAUDE.local.md`)
   - Directory tree walking (load from root to cwd)
   - `@path` imports (recursive, max 4 hops)
   - `.claude/rules/` for path-scoped rules (glob patterns)
   - `/init` auto-generates CLAUDE.md
   - `/import` brings in other agent configs (Cursor, Copilot, AGENTS.md, etc.)
   - `claudeMdExcludes` for monorepos

2. **Auto memory** (Claude-written learnings):
   - `~/.claude/projects/<project>/memory/MEMORY.md` + topic files
   - First 200 lines / 25KB loaded each session
   - Claude decides what's worth remembering
   - Per-project, shared across worktrees
   - Subagent memory (`memory` field: user/project/local scope)
   - Toggle via `autoMemoryEnabled`

**Context management:**
- `/compact` for context compaction
- `/context` to view what loaded
- Context window visualization
- Survives compaction (project-root CLAUDE.md re-injected)

### 1.7 Permission / Safety System

**Permission modes:**
| Mode | Behavior |
|---|---|
| `default` (Manual) | Standard prompting on first use |
| `acceptEdits` | Auto-accept file edits + common filesystem commands |
| `plan` | Read-only exploration |
| `auto` | Background classifier auto-approves aligned actions |
| `dontAsk` | Auto-deny unless pre-approved |
| `bypassPermissions` | Skip prompts (circuit breakers still fire for `rm -rf /`) |

**Permission rules:**
- `Tool(specifier)` syntax (e.g., `Bash(npm run *)`, `Read(./.env)`, `WebFetch(domain:example.com)`)
- Evaluated: deny → ask → allow
- Compound command awareness (each subcommand checked independently)
- Wrapper stripping (`timeout`, `time`, `nice`, `nohup`, etc.)
- Read-only command set (ls, cat, grep, find, etc. run without prompt)
- Symlink resolution checking
- Protected paths (`.git`, `.claude`, `.vscode`, etc.)

**Sandboxing:**
- OS-level enforcement for Bash (filesystem + network restrictions)
- `sandbox.filesystem` + Read/Edit deny rules merged
- `autoAllowBashIfSandboxed` (sandbox substitutes for prompts)
- Network allowlist/denylist domains

**Ctrl+E command explanation** on permission prompts (risk assessment)

### 1.8 Background / Autonomous Execution

- Background Bash commands (`run_in_background: true`)
- Background subagents (default since v2.1.198)
- Background agents (multiple full sessions)
- Auto-backgrounding of timed-out commands
- Auto-backgrounding of long MCP calls (>2 min)
- `/tasks` to manage background tasks
- Routines (cloud-scheduled, survive computer off)
- Desktop scheduled tasks
- `/loop` for polling
- Agent teams with `TeammateIdle` hooks

### 1.9 Session Management

- Session resume (`--resume`, `--continue`)
- `--teleport` (pull web/mobile session to terminal)
- `/desktop` handoff (terminal → desktop app)
- Remote Control (phone/browser control of local session)
- Session transcripts with retention (`cleanupPeriodDays`)
- Cross-session messaging (v2.1.224+)
- `--resume` finds sessions from working directory

### 1.10 IDE Integration

- **VS Code** - inline diffs, @-mentions, plan review, conversation history, built-in IDE MCP server
- **JetBrains** (IntelliJ, PyCharm, WebStorm) - interactive diffs, selection context sharing
- **Desktop app** - visual diffs, side-by-side sessions, scheduled tasks, cloud sessions, preview pane
- **Web** (claude.ai/code) - no local setup, long-running tasks, parallel tasks
- **Chrome** extension - live web app debugging
- **Mobile** (iOS/Android) - Remote Control, Dispatch

### 1.11 Hooks / Extensions System

**30+ hook events:**
- Session: `SessionStart`, `SessionEnd`, `Setup`
- Turn: `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`
- Tool: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`
- Subagent: `SubagentStart`, `SubagentStop`
- Task: `TaskCreated`, `TaskCompleted`
- Compaction: `PreCompact`, `PostCompact`
- File/Dir: `FileChanged`, `CwdChanged`, `DirectoryAdded`, `WorktreeCreate`, `WorktreeRemove`
- Display: `Notification`, `MessageDisplay`
- Config: `ConfigChange`, `InstructionsLoaded`
- Team: `TeammateIdle`
- MCP: `Elicitation`, `ElicitationResult`

**Hook handler types:**
1. **Command hooks** - shell scripts (exec form or shell form)
2. **HTTP hooks** - POST to URL endpoint
3. **MCP tool hooks** - call MCP server tool
4. **Prompt hooks** - LLM single-turn evaluation (yes/no decision)
5. **Agent hooks** - spawn subagent for verification

**Hook features:**
- Matcher patterns (exact, regex, tool-specific)
- `if` conditions (permission rule syntax)
- Async hooks (background execution)
- `asyncRewake` (wake Claude on completion)
- Scoped to skills and agents (frontmatter)
- Plugin hooks
- `$CLAUDE_PROJECT_DIR`, `$CLAUDE_PLUGIN_ROOT`, `$CLAUDE_PLUGIN_DATA` placeholders
- Per-hook timeouts, status messages

### 1.12 Plugins & Skills

**Skills:**
- Packaged repeatable workflows (`/skillname`)
- `SKILL.md` format
- `context: fork` (inject skill content into specified agent)
- `disable-model-invocation` (user-only)
- `allowed-tools` restriction
- Run in subagent context
- Marketplace distribution

**Plugins:**
- Bundle: agents, MCP servers, hooks, skills, commands
- `plugin.json` manifest
- Marketplace system (`/plugin marketplace add`)
- Path placeholders (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`)
- Persistent data directory
- Enterprise controls (`enabledPlugins`)
- `mcp-server-dev` official plugin for scaffolding MCP servers

### 1.13 Pricing

- **Claude Pro:** ~$20/month (limited Claude Code access)
- **Claude Max:** ~$100-200/month (higher limits)
- **Team/Enterprise:** Custom pricing
- **Anthropic Console:** Pay-per-token API pricing
- Subscriptions required for most surfaces; Terminal CLI and VS Code support third-party providers

### 1.14 Standout / Unique Features

1. **Dynamic Workflows** - script-based orchestration of many subagents (`Workflow` tool)
2. **Agent Teams** - coordinated multi-session teams with task DAGs
3. **Cross-session messaging** - agents communicate across sessions and machines
4. **Channels** - external events (Telegram, Discord, iMessage, webhooks) push into sessions
5. **Monitor tool** - background command/WebSocket watching with reactive event injection
6. **LSP integration** - real-time type errors after edits
7. **Plan Mode** - structured exploration before editing
8. **Worktree isolation** - subagents in temporary git worktrees
9. **Remote Control** - phone/browser control of local session
10. **Chrome debugging** - live web app inspection
11. **Artifacts** - shareable HTML/Markdown pages
12. **Auto-memory with topic files** - self-organizing persistent knowledge
13. **Tool search** - scale to hundreds of MCP tools via deferred loading
14. **Prompt hooks & Agent hooks** - LLM-powered permission decisions
15. **Granular permission matching** - parameter-level (`Agent(model:opus)`, `Bash(run_in_background:true)`)
16. **EndConversation safety valve** - model can end abusive sessions
17. **5 hook handler types** including HTTP and MCP tool hooks

---

## 2. OpenAI Codex CLI

### 2.1 Overview

Codex CLI is OpenAI's local coding agent, written in **Rust** (Apache-2.0 licensed, open source at github.com/openai/codex). Runs in terminal, IDE (VS Code, Cursor, Windsurf), desktop app, web (chatgpt.com/codex), and Codex Cloud.

### 2.2 Full Tool/Feature List

**Built-in tools:**

| Tool | Description |
|---|---|
| `shell` | Unified PTY-backed exec tool (stable, default except Windows) |
| `exec` | Non-interactive command execution (`codex exec`) |
| File read/edit | Inspect and modify files |
| `apply_patch` | Apply Codex-style unified patches |
| `web_search` | Live or cached web search (`--search` flag) |
| `spawn_agent` / `send_input` / `resume_agent` / `wait_agent` / `close_agent` | Multi-agent tools |
| `request_permissions` | Permission request tool |
| MCP tools | Via connected MCP servers |
| Browser | Built-in browser tool (desktop/web) |
| Computer use | Desktop automation |
| Image generation | GPT-Image-2 |
| Image inputs | `--image` flag for visual context |
| Voice | ChatGPT Voice (desktop) |

**Key features:**
- `/init` - create AGENTS.md
- `/status` - session configuration + usage limits
- `/permissions` - sandbox and approval settings
- `/model` - model + reasoning effort selection
- `/review` - dedicated code review (uncommitted, commit, or base branch)
- `/agent` - switch between agent threads
- `/personality` - communication style (none/friendly/pragmatic)
- Git checkpoint creation (before/after tasks)
- `codex resume` - reopen saved chats
- `codex exec` - non-interactive mode for CI/scripts
- `codex cloud` - move work to cloud
- `codex mcp` - manage MCP servers
- `codex completion` - shell completions
- Shell snapshots (speed up repeated commands)
- Request compression (zstd)
- Prevent idle sleep (experimental)

### 2.3 Multi-Model Support

- **GPT-5.6 family:** Sol (flagship), Terra (balanced), Luna (fast/affordable)
- **GPT-5.3-Codex-Spark** (research preview, Pro only, near-instant iteration)
- **GPT-5.5, GPT-5.4, GPT-5.4-mini** (legacy, deprecating)
- **Daybreak** models (cybersecurity, Trusted Access required)
- **Custom providers:** Ollama, LM Studio (`--oss` flag), any Responses API provider
- **Amazon Bedrock** built-in provider
- Custom `model_providers` with env keys, bearer tokens, command-backed auth
- Reasoning effort: `minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`
- Reasoning summary detail: `auto`/`concise`/`detailed`/`none`
- Model verbosity: `low`/`medium`/`high`
- Per-subagent model + reasoning effort
- Fast mode (service tier selection)
- Model catalog JSON for custom model lists
- Auto-compaction token limits

### 2.4 Agent / Sub-Agent Architecture

**Built-in agents:**
- `default` - general-purpose fallback
- `worker` - execution-focused implementation/fixes
- `explorer` - read-heavy codebase exploration

**Custom agents** (`~/.codex/agents/*.toml` or `.codex/agents/*.toml`):
- TOML format (heavier than markdown, can override any session config)
- Required fields: `name`, `description`, `developer_instructions`
- Optional: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`
- Global `[agents]` settings: `enabled`, `max_concurrent_threads_per_session`, `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message`

**Multi-agent features:**
- Parallel subagent spawning
- `/agent` for thread inspection/switching
- Subagents inherit parent sandbox policy
- Runtime override inheritance (live `/permissions` changes passed to children)
- Approval requests surface from inactive threads
- `features.multi_agent` toggle (stable, on by default)
- Goals feature (persisted goals, automatic continuation)

### 2.5 MCP Support

- **Transports:** stdio, streamable HTTP
- **Auth:** OAuth, ChatGPT session, bearer tokens, static/env HTTP headers
- **Per-server config:** command, args, env, cwd, url, startup_timeout, tool_timeout, enabled_tools/disabled_tools
- **Per-tool approval mode:** `auto`/`prompt`/`writes`/`approve`
- **Remote placement** (experimental): stdio via remote executor
- **OAuth scopes and resource parameters**
- **Required servers** (fail startup if can't initialize)
- `codex mcp` CLI for management
- Secure MCP Tunnel (connect private servers without public exposure)

### 2.6 Memory / Context Management

**AGENTS.md** (standard, shared across agents):
- Global scope: `~/.codex/AGENTS.md` or `AGENTS.override.md`
- Project scope: walks from project root to cwd
- `project_doc_fallback_filenames` (custom filenames)
- `project_doc_max_bytes` (32KB default)
- Layered with Code Review Rules sections

**Memories** (TOML config, off by default):
- `memories.generate_memories` / `memories.use_memories`
- `memories.extract_model` / `memories.consolidation_model`
- Raw memory consolidation (max 256 retained)
- Max unused days (30 default)
- Max rollout age (30 days)
- Rate-limit-aware generation (won't generate when <25% limit remaining)
- Disable on external context (MCP/web search)

**Chronicle** - additional memory system (referenced in docs)

**Context management:**
- `model_auto_compact_token_limit` (auto-compaction threshold)
- `model_auto_compact_token_limit_scope` (`total` vs `body_after_prefix`)
- `compact_prompt` / `experimental_compact_prompt_file`

### 2.7 Permission / Safety System

**Sandbox modes:**
| Mode | Behavior |
|---|---|
| `read-only` | No filesystem writes, no network |
| `workspace-write` | Write within workspace + configured writable roots |
| `danger-full-access` | Full filesystem + network access |

**Approval policies:**
| Policy | Behavior |
|---|---|
| `untrusted` | Most restrictive |
| `on-request` | Interactive approval (default for interactive) |
| `never` | No approval prompts (CI/non-interactive) |
| `granular` | Fine-grained: `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval` |

**Reviewer:** `user` (default) or `auto_review` (reviewer subagent)

**Auto-review (Approve for me):**
- Automatic review of requests that cross sandbox boundary
- Local Markdown policy instructions
- Managed `guardian_policy_config` takes precedence
- Elevated risk acknowledgment

**Additional safety:**
- `sandbox_workspace_write.writable_roots` (additional write paths)
- `sandbox_workspace_write.network_access` toggle
- `shell_environment_policy` (env var filtering, secret exclusion)
- Windows sandbox (unelevated/elevated, private desktop)
- Computer Use always-allowed app IDs
- Network proxy with domain allowlist/denylist (SOCKS5 support)
- Protected paths in writable roots
- `allow_login_shell` toggle

### 2.8 Background / Autonomous Execution

- `codex exec` - non-interactive mode for scripts/CI
- `codex cloud` - move work to cloud environment
- Scheduled tasks (automations)
- Long-running work support
- Codex SDK for programmatic agent building
- GitHub Action for CI/CD
- App Server for integration
- Background mode (Responses API)
- Subagents run in parallel
- Goals (persisted, automatic continuation)
- Prevent idle sleep during turns

### 2.9 Session Management

- `codex resume` - reopen saved chats, search across local chats
- Session transcripts (JSONL)
- SQLite-backed state DB
- Rollout tracking
- Record & Replay
- Config profiles (`--profile`)
- `$CODEX_HOME` for isolated profiles

### 2.10 IDE Integration

- **VS Code** - Codex IDE extension
- **Cursor** - extension support
- **Windsurf** - extension support
- **Desktop app** - full GUI with browser, computer use, voice
- **Web** (chatgpt.com/codex) - cloud-based
- **Codex Cloud** - configured cloud environments
- **Codex Remote** - remote engineering from phone
- **GitHub** integration - `@Codex` for PRs, code review, auto-review
- **Slack** integration
- **Linear** integration
- Integrated terminal (within IDE)

### 2.11 Hooks / Extensions System

- **Lifecycle hooks** loaded from `hooks.json` or inline `[hooks]` in config
- Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop`
- Command hooks (currently supported; prompt/agent hooks parsed but skipped)
- Async hooks (background execution)
- `additionalContextLimit` (token threshold for oversized context)
- `commandWindows` (Windows-specific command override)
- `features.hooks` toggle

### 2.12 Skills & Plugins

**Skills:**
- `SKILL.md` format
- `skills.config` in config.toml (per-skill enablement)
- `features.skill_mcp_dependency_install` (auto-install MCP deps)
- Build skills workflow
- Plugin marketplace (1751+ plugins available)

**Plugins:**
- Plugin architecture (MCP servers + skills + UI)
- OpenAI Curated, Workspace, Shared categories
- Remote plugin catalog (`features.remote_plugin`)
- App/connector controls (per-app enable, destructive/open-world toggles)
- Tool suggestion system (`tool_suggest.discoverables`/`disabled_tools`)

### 2.13 Pricing

| Plan | Price | Notes |
|---|---|---|
| Free | $0 | Quick tasks exploration |
| Go | $8/mo | Lightweight coding |
| Plus | $20/mo | GPT-5.6 family, web/CLI/IDE/iOS, cloud integrations |
| Pro 5x | $100/mo | 5x Plus limits, Codex-Spark preview |
| Pro 20x | $200/mo | 20x Plus limits, unlimited Voice |
| Business | $20/user/mo | Team workspace, SAML SSO |
| Enterprise/Edu | Custom | SCIM, EKM, RBAC, audit logs |
| API Key | Pay-per-token | No cloud features, standard API rates |

**Credit system:** Credits per million tokens (e.g., GPT-5.6 Sol: 125 input / 750 output credits)

### 2.14 Standout / Unique Features

1. **Rust-based** (fast, memory-safe, open-source Apache-2.0)
2. **OS-level sandbox** (Seatbelt on macOS, seccomp/landlock on Linux, native Windows sandbox)
3. **Auto-review** (AI-powered approval reviewer subagent)
4. **`codex exec`** - clean non-interactive/CI mode
5. **Codex Cloud** - seamless local↔cloud handoff
6. **Reasoning effort granularity** (minimal→ultra, 7 levels)
7. **Network proxy** (sandboxed SOCKS5 with domain policies)
8. **Shell snapshot** (speed optimization)
9. **Request compression** (zstd)
10. **Config profiles** (`--profile` for different setups)
11. **Plugin marketplace** (1751+ plugins)
12. **GitHub/Slack/Linear** native integrations
13. **Computer Use** (desktop automation)
14. **ChatGPT Voice** (duplex voice model + task coordination)
15. **Codex-Spark** (near-instant real-time coding model)
16. **Daybreak** cybersecurity models (Trusted Access)
17. **Secure MCP Tunnel** (private server access)
18. **Image generation** built-in
19. **Goals** (persisted goals with automatic continuation)
20. **Codex SDK** + App Server (programmatic agent building)

---

## 3. Feature Gap Analysis vs. Arterm

Based on what Arterm already has (swarm agents, MCP, memory, skills, browser, gmail, scheduling, web search/fetch, todos, side panel, debug socket, self-dev), the following are potential gaps relative to the competitors:

### High Priority Gaps

| Gap | Source | Description |
|---|---|---|
| **OS-level sandbox** | Both | Seatbelt/seccomp/landlock enforcement for Bash commands (beyond permission rules) |
| **Granular permission rules** | Claude Code | `Tool(specifier)` syntax with deny→ask→allow precedence, compound command parsing |
| **Plan Mode** | Claude Code | Read-only exploration mode before editing (structured planning) |
| **Auto-memory** | Claude Code | Agent self-writes learnings to MEMORY.md + topic files across sessions |
| **Worktree isolation** | Claude Code | Subagents in temporary git worktrees for parallel safety |
| **`codex exec` equivalent** | Codex | Clean non-interactive/CI mode (Arterm has `run` but dedicated exec is cleaner) |
| **Cloud execution** | Codex | Local↔cloud handoff for long-running tasks |
| **GitHub/Slack/Linear integrations** | Codex | Native CI/CD and team chat integrations |

### Medium Priority Gaps

| Gap | Source | Description |
|---|---|---|
| **LSP integration** | Claude Code | Real-time type errors after edits, go-to-definition, find references |
| **Monitor tool** | Claude Code | Background command/WebSocket watching with reactive event injection |
| **Prompt/Agent hooks** | Claude Code | LLM-powered hook decisions (yes/no evaluation, subagent verification) |
| **HTTP hooks** | Claude Code | POST hook events to URL endpoints (not just command hooks) |
| **Channels** | Claude Code | External event push (Telegram, Discord, webhooks) into sessions |
| **Tool search** | Claude Code | Deferred MCP tool loading for large tool pools |
| **Artifacts** | Claude Code | Shareable HTML/Markdown pages from agent output |
| **Dynamic workflows** | Claude Code | Script-based orchestration of many subagents |
| **Auto-review** | Codex | AI-powered approval reviewer for sandbox boundary crossing |
| **Reasoning effort control** | Codex | Fine-grained reasoning levels (minimal→ultra) |
| **Config profiles** | Codex | `--profile` for different setup configurations |
| **Network proxy sandbox** | Codex | Sandboxed SOCKS5 with domain policies |
| **Image generation** | Codex | Built-in image generation tool |
| **Computer Use** | Codex | Desktop automation beyond browser |

### Lower Priority / Niche

| Gap | Source | Description |
|---|---|---|
| **Remote Control** | Claude Code | Phone/browser control of local session |
| **Chrome debugging** | Claude Code | Live web app inspection extension |
| **`--teleport`** | Claude Code | Pull web/mobile session to terminal |
| **Cross-session messaging** | Claude Code | Agents communicate across sessions/machines |
| **Routines** | Claude Code | Cloud-scheduled recurring tasks (survive computer off) |
| **Push notifications** | Claude Code | Desktop + phone push |
| **Codex SDK / App Server** | Codex | Programmatic agent building framework |
| **Voice** | Codex | ChatGPT Voice (duplex voice model) |
| **Shell snapshots** | Codex | Speed optimization for repeated commands |
| **Request compression** | Codex | zstd compression for API requests |

### Areas Where Arterm Already Competes Strongly

- **Swarm architecture** (Arterm's swarm with task DAGs, deep/light modes, channels, DMs)
- **MCP support** (Arterm has full MCP with list, connect, disconnect, reload)
- **Skills system** (Arterm has load, list, reload, read)
- **Browser tool** (Arterm has comprehensive browser automation)
- **Memory** (Arterm has remember, recall, search, list, forget, tag, link, related)
- **Scheduling** (Arterm has create, list, cancel with background_context)
- **Side panel** (Arterm has write, append, load, focus, delete)
- **Debug socket** (Arterm has state inspection, testers, frames)
- **Self-dev builds** (Arterm has coordinated build-reload workflow)
- **Web search/fetch** (Arterm has both, though DuckDuckGo appears blocked on this machine)
- **Gmail integration** (Arterm has full Gmail tool)
- **Todo management** (Arterm has structured todos with goal-level assessments)
- **Initiative tracking** (Arterm has durable initiatives with milestones)

---

## 4. Key Takeaways for Arterm

1. **Safety is table stakes:** Both competitors have OS-level sandboxing. Arterm's permission system should evolve toward granular `Tool(specifier)` rules + sandbox enforcement.

2. **Autonomous modes are diverging:** Claude Code's `auto` mode (background classifier) and Codex's `auto_review` (reviewer subagent) both use AI to approve actions. This is a differentiator Arterm could adopt.

3. **Memory is critical:** Claude Code's auto-memory (agent writes its own learnings) is a significant UX advantage over manually-maintained config files.

4. **Worktree isolation enables safe parallelism:** As Arterm's swarm grows, worktree-isolated subagents prevent file conflicts.

5. **Cloud is the future:** Codex's seamless local↔cloud handoff represents where the market is heading. Long-running tasks in cloud, results applied locally.

6. **Plugin ecosystems drive adoption:** Codex's 1751+ plugin marketplace shows the value of an extension ecosystem. Arterm's skills system is a foundation for this.

7. **IDE integration matters:** Both competitors have deep IDE integration. Arterm is terminal-focused but IDE bridges could expand reach.

8. **Reasoning control is valuable:** Codex's 7 reasoning effort levels give users fine-grained cost/quality control.

---

*Report compiled from official documentation fetched 2026-08-13. All features verified against primary sources (docs.claude.com, developers.openai.com/codex, github.com/openai/codex).*
