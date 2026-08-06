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
        # nvm leaves node on PATH only for the shell that loaded it, so the
        # global bin is symlinked into /usr/local/bin: `run()` is a separate
        # exec and would otherwise not find `arterm` at all.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {shlex.quote(remote)} && "
                "readlink -f \"$(command -v arterm)\" > /tmp/arterm-real-path"
            ),
        )
        await self.exec_as_root(
            environment,
            command=(
                'ln -sf "$(cat /tmp/arterm-real-path)" /usr/local/bin/arterm && '
                'ln -sf "$(dirname "$(cat /tmp/arterm-real-path)")/node" /usr/local/bin/node && '
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
        """Pass through only the key this provider needs, when the host has it.

        Deliberately narrow: handing the container every API key in the
        environment would put credentials for unrelated services inside a
        sandbox running model-authored commands.
        """
        names = {
            "anthropic": "ANTHROPIC_API_KEY",
            "openai": "OPENAI_API_KEY",
            "openai-compat": "OPENAI_COMPAT_API_KEY",
            "gemini": "GEMINI_API_KEY",
            "xai": "XAI_API_KEY",
            "deepseek": "DEEPSEEK_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "mistral": "MISTRAL_API_KEY",
        }
        name = names.get(provider)
        value = os.environ.get(name) if name else None
        return {name: value} if name and value else {}

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


def _int_or_none(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None
