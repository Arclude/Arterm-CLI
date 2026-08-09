"""Harbor adapter for Arterm — run `arterm` as an agent under Terminal-Bench 2.x.

Harbor's installed-agent interface is three methods (`install`, `run`,
`populate_context_post_run`), so no fork of the harness is needed:

    harbor run -d terminal-bench@2.0 --agent bench.harbor.arterm_agent:ArtermAgent

Three things in here are deliberate rather than incidental, because each is a way
to publish a number that is not the number:

1. **No `--verify-cmd`, and no flag to add one.** A benchmark task's
   `tests/test.sh` is the hidden grader. Pointing our own verification gate at
   it turns "did the work" into "made the grader pass", which is reward hacking
   — and Terminal-Bench trajectories are published and read. The gate stays off
   here and the judge-only path is what gets measured. This is the one place in
   the codebase where the standing gate is deliberately absent.

2. **`--max-steps` is a HARD cap.** `autonomy.autoExtend` buys more steps for as
   long as anything is happening, which under a task timeout means the trial is
   killed mid-work and reports nothing. A pinned `--max-steps` is absolute in
   Arterm (never extended), so the run ends by REPORTING partial work instead.
   79% of Long-Horizon-Terminal-Bench failures are timeouts; the difference
   between "killed" and "stopped and said what it did" is most of that band.

3. **`--no-sandbox`.** The container IS the boundary. Nesting Arterm's own
   bubblewrap sandbox inside it buys nothing and fails outright where the
   runner forbids nested user namespaces. The choice is recorded in
   `harness.json`, because network policy is part of the score.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any, override
from urllib.parse import urlparse

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

#: Where the run's `--json` result lands inside the container. `/logs/agent` is
#: mounted from the trial dir, so the same file is `self.logs_dir / NAME` on the
#: host once the trial syncs.
RESULT_NAME = "arterm-result.json"
STDERR_NAME = "arterm-stderr.log"
HARNESS_NAME = "harness.json"

#: Default step cap. Generous enough for a real task, finite enough that the
#: run reports rather than being cut off by the harness timeout.
DEFAULT_MAX_STEPS = 200

#: The one credential each provider needs, named as ARTERM READS IT — this is
#: the variable set inside the container, so it must match the env var the
#: provider registry consults, not a name that merely reads well here.
#:
#: `openai-compat` is the trap: it is not one of the hosted presets, it is the
#: custom-host provider, and `registry.ts` resolves its key with
#: `apiKeyFor("openai-compat", "OPENAI_API_KEY")`. This map said
#: `OPENAI_COMPAT_API_KEY`, a name nothing in arterm reads. The container got a
#: variable it ignored, dialled the endpoint unauthenticated, and every request
#: 401'd — which the trial scored as the agent's work: `reward 0.0`,
#: `Exceptions 0`, and `usage.reported: false` as the only tell.
_PROVIDER_KEY = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openai-compat": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "xai": "XAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "mistral": "MISTRAL_API_KEY",
}

#: Extra names accepted ON THE HOST, tried before the container-side name.
#: Keeping `OPENAI_COMPAT_API_KEY` usable is not backwards compatibility for its
#: own sake: one machine can hold a real `OPENAI_API_KEY` for api.openai.com AND
#: a key for whatever compat endpoint is being measured, and silently shipping
#: the former to the latter is worse than a missing key. The distinction lives
#: on the host, where both exist; inside the container only one endpoint is
#: reachable, so the name collapses to the one arterm reads.
_HOST_KEY_ALIASES = {
    "openai-compat": ("OPENAI_COMPAT_API_KEY",),
}

#: Providers that ARE their endpoint. The rest have one fixed vendor URL, so
#: there is nothing to carry; for these two the address is the configuration,
#: and a run without it measures a provider error rather than an agent.
_PROVIDER_ENDPOINT = {
    "openai-compat": "OPENAI_COMPAT_HOST",
    "ollama": "OLLAMA_HOST",
}


class ArtermAgent(BaseInstalledAgent):
    """Installs the `arterm` CLI into the task container and runs one goal."""

    CLI_FLAGS = [
        CliFlag("max_steps", cli="--max-steps", type="int", default=DEFAULT_MAX_STEPS),
        CliFlag("autonomy_mode", cli="--autonomy-mode", type="str"),
        CliFlag("max_usd", cli="--max-usd", type="str"),
        CliFlag("max_tokens", cli="--max-tokens", type="int"),
    ]

    def __init__(self, *args: Any, tarball: str | None = None, **kwargs: Any):
        # The CLI is installed from a locally built tarball rather than from npm:
        # it is not published, and pinning a published version would measure a
        # different tree than the one under test. `bench/harbor/pack.sh` builds it.
        self._tarball = Path(
            tarball or os.environ.get("ARTERM_TARBALL") or _default_tarball()
        ).expanduser()
        super().__init__(*args, **kwargs)

    @staticmethod
    @override
    def name() -> str:
        return "arterm"

    @override
    def get_version_command(self) -> str | None:
        return "arterm --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[0].strip() if stdout.strip() else ""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not self._tarball.is_file():
            raise RuntimeError(
                f"arterm tarball not found at {self._tarball}. Build it first:\n"
                "  bash bench/harbor/pack.sh\n"
                "or point at one with --agent-kwarg tarball=<path> / ARTERM_TARBALL."
            )
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl ca-certificates",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        remote = "/installed-agent/arterm.tgz"
        await environment.upload_file(self._tarball, remote)
        # nvm leaves node on PATH only for the shell that loaded it, so both
        # binaries are symlinked into /usr/local/bin: `run()` is a separate exec
        # and would otherwise not find `arterm` at all.
        #
        # `node` is asked for SEPARATELY rather than derived from arterm's path.
        # They are not siblings: npm's global install puts a launcher in nvm's
        # `bin/` beside `node`, but `readlink -f` follows it through to the
        # package's own file — `…/lib/node_modules/arterm-cli/dist/main.js` —
        # whose directory contains no interpreter. The link pointed at nothing,
        # and `arterm`'s `#!/usr/bin/env node` shebang failed the install step
        # with `exit 127: 'node': No such file or directory`.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {shlex.quote(remote)} && "
                'readlink -f "$(command -v arterm)" > /tmp/arterm-real-path && '
                'readlink -f "$(command -v node)" > /tmp/node-real-path'
            ),
        )
        # `arterm --version` at the end is the assertion, not a courtesy: it is
        # the only thing here that proves the interpreter, the launcher and the
        # package resolve together, and it runs in a fresh exec — exactly like
        # `run()` will.
        await self.exec_as_root(
            environment,
            command=(
                'ln -sf "$(cat /tmp/arterm-real-path)" /usr/local/bin/arterm && '
                'ln -sf "$(cat /tmp/node-real-path)" /usr/local/bin/node && '
                "arterm --version"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, model = self._split_model()
        self._require_endpoint(provider)
        agent_dir = EnvironmentPaths.agent_dir.as_posix()
        result_path = f"{agent_dir}/{RESULT_NAME}"
        stderr_path = f"{agent_dir}/{STDERR_NAME}"

        command = (
            "arterm --print --json "
            f"--goal {shlex.quote(instruction)} "
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            "--autonomous --no-sandbox "
            f"{self.build_cli_flags()}"
        ).strip()

        # stdout is the JSON result and must stay uncontaminated; stderr carries
        # the mode announcements and any provider error. Both are kept, and
        # stderr is replayed at the end so Harbor's ERROR_PATTERNS can still
        # classify a rate limit or an auth failure from this exec's output.
        await self.exec_as_agent(
            environment,
            command=(
                f"arterm_out={shlex.quote(result_path)}; "
                f"arterm_err={shlex.quote(stderr_path)}; "
                f'{command} > "$arterm_out" 2> "$arterm_err"; '
                'rc=$?; cat "$arterm_err" >&2; exit $rc'
            ),
            env=self._provider_env(provider),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        result = self._read_result()
        self._write_harness_record(result)
        if result is None:
            self.logger.debug("No arterm result JSON; leaving context unpopulated")
            return

        usage = result.get("usage") or {}
        context.n_input_tokens = usage.get("inputTokens")
        context.n_output_tokens = usage.get("outputTokens")
        context.n_cache_tokens = usage.get("cacheTokens")
        # A local model genuinely costs $0. `unpriced` means the catalog had no
        # rate, which is a different fact — reporting 0 for it would understate
        # a paid run, so it becomes None (unknown) instead.
        context.cost_usd = None if usage.get("unpriced") else usage.get("usd")
        guards = result.get("guards") or {}
        context.metadata = {
            "state": result.get("state"),
            "steps": result.get("steps"),
            "verdicts": result.get("verdicts"),
            "loopSteers": guards.get("loopSteers"),
            "loopCuts": guards.get("loopCuts"),
            "extensions": guards.get("extensions"),
        }

    # ------------------------------------------------------------------ helpers

    def _split_model(self) -> tuple[str, str]:
        """Harbor hands models as `provider/model`; Arterm takes them apart."""
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Model name must be 'provider/model', e.g. 'anthropic/claude-opus-4-5'"
            )
        provider, model = self.model_name.split("/", 1)
        return provider, model

    @staticmethod
    def _provider_env(provider: str) -> dict[str, str]:
        """Pass through only what this provider needs, when the host has it.

        Deliberately narrow: handing the container every API key in the
        environment would put credentials for unrelated services inside a
        sandbox running model-authored commands.

        Narrow is not the same as key-only. Most providers have one fixed vendor
        URL compiled in, but `openai-compat` and `ollama` are defined BY their
        endpoint, and `arterm` reads it from the environment
        (`OPENAI_COMPAT_HOST`, `OLLAMA_HOST`) — so passing the key alone left the
        container dialing the default `http://localhost:1234/v1`, where nothing
        is listening. Every task would have failed with a provider error, and
        the trial would have reported that as the agent's score.
        """
        name = _PROVIDER_KEY.get(provider)
        passed = {}
        if name:
            for source in (*_HOST_KEY_ALIASES.get(provider, ()), name):
                value = os.environ.get(source)
                if value:
                    passed[name] = value
                    break
        endpoint = _PROVIDER_ENDPOINT.get(provider)
        if endpoint:
            value = os.environ.get(endpoint)
            if value:
                passed[endpoint] = value
        return passed

    @staticmethod
    def _require_endpoint(provider: str) -> None:
        """Refuse before the run when a provider's endpoint cannot reach anything.

        The failure this replaces is the expensive kind: a whole benchmark sweep
        where every task fails identically and the reason is one unset variable.
        Told once, up front, it costs nothing.

        `localhost` is rejected for the same reason it is checked at all — inside
        the task container it names the container, not the machine running
        harbor, so a local LM Studio or Ollama needs an address the container can
        actually route to (`host.docker.internal`, or the host's LAN address).
        """
        endpoint = _PROVIDER_ENDPOINT.get(provider)
        if not endpoint:
            return
        value = os.environ.get(endpoint, "").strip()
        if not value:
            raise ValueError(
                f"{provider} has no endpoint: set {endpoint} before `harbor run`. "
                f"Without it every task in the container dials arterm's default "
                f"and fails with a provider error, which scores as the agent's work."
            )
        host = urlparse(value).hostname or ""
        if host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
            raise ValueError(
                f"{endpoint}={value} points at localhost, which inside the task "
                f"container is the container itself. Use host.docker.internal or "
                f"the host's LAN address."
            )

    def _read_result(self) -> dict[str, Any] | None:
        path = self.logs_dir / RESULT_NAME
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            self.logger.debug(f"Could not read {path}: {exc}")
            return None

    def _write_harness_record(self, result: dict[str, Any] | None) -> None:
        """Record every knob that moves the score, next to the score.

        Measured, not asserted: the same model scored 46% and 80% under two
        different scaffolds, and a harness change is worth 8–21 pass@1 points.
        A number published without this file is not reproducible and should not
        be compared to anyone else's.

        `k` is not knowable from inside an agent — it belongs to the `harbor run
        -k` invocation — so it is recorded only when the runner puts it in
        ARTERM_BENCH_K. It is written as null rather than omitted, so a reader
        can tell "single run" from "we forgot to say".
        """
        record = {
            "agent": self.name(),
            "agentVersion": self._version,
            "model": self.model_name,
            "flags": {
                "maxSteps": self._resolved_flags.get("max_steps", DEFAULT_MAX_STEPS),
                "autonomyMode": self._resolved_flags.get("autonomy_mode"),
                "maxUsd": self._resolved_flags.get("max_usd"),
                "maxTokens": self._resolved_flags.get("max_tokens"),
                "autonomous": True,
                # Named explicitly because their ABSENCE is the claim being made.
                "verifyCmd": None,
                "sandbox": False,
            },
            "permissionMode": "yolo",
            # Which endpoint answered is part of the harness: "openai-compat"
            # names a protocol, not a model — the same string reaches Z.AI, a
            # local vLLM and an OpenRouter relay, and they do not score alike.
            # Scheme and host ONLY: some gateways carry a token in the path or
            # query, and this file is written next to a published trajectory.
            "endpoint": _endpoint_origin(self._split_model()[0]),
            "network": "container policy (harbor task config)",
            "k": _int_or_none(os.environ.get("ARTERM_BENCH_K")),
            "state": (result or {}).get("state"),
        }
        try:
            (self.logs_dir / HARNESS_NAME).write_text(
                json.dumps(record, indent=2) + "\n", encoding="utf-8"
            )
        except OSError as exc:
            self.logger.debug(f"Could not write {HARNESS_NAME}: {exc}")


def _default_tarball() -> str:
    """`bench/harbor/dist/arterm-cli.tgz`, relative to this file."""
    return str(Path(__file__).resolve().parent / "dist" / "arterm-cli.tgz")


def _endpoint_origin(provider: str) -> str | None:
    """`scheme://host[:port]` of a provider's configured endpoint, or None.

    Never the path or query. A number is only comparable beside the endpoint
    that produced it, but a gateway URL is also a place people put tokens, and
    this record ships next to a published trajectory.
    """
    name = _PROVIDER_ENDPOINT.get(provider)
    if not name:
        return None
    parsed = urlparse(os.environ.get(name, "").strip())
    if not parsed.scheme or not parsed.hostname:
        return None
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


def _int_or_none(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None
