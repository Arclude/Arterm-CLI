#!/usr/bin/env bash
# Run the forked Rust CLI without touching anything the installed TypeScript CLI
# owns, and without needing a real API key.
#
# Two things this exists to get right, both learned the hard way:
#
#   1. ARTERM_HOME is redirected to a throwaway directory. The fork resolves its
#      state to ~/.arterm — the same directory the installed TS CLI keeps
#      config.json, key, secrets.json, sessions and chronicle in — and running
#      it there mixes two agents' state in two formats. It has already happened
#      once: the fork's telemetry tests left telemetry_id and friends in the
#      real home.
#
#   2. It can point at a FAKE model server, so `./dev-run.sh --fake` is a
#      complete end-to-end turn with no key, no spend, and no network. That is
#      the cheapest honest answer to "does the thing work" — the TUI opening
#      proves the UI renders, and nothing else.
#
# Note what neither of those covers: launch hotkeys used to be written to the
# DESKTOP (~/.config/kglobalshortcutsrc), which ARTERM_HOME cannot redirect.
# That is now opt-in, but the general shape of the risk is worth remembering
# when adding anything that writes outside the process.
#
# Usage:
#   scripts/dev-run.sh --fake            # fake server on :8131, throwaway home
#   scripts/dev-run.sh --fake --port N   # …on another port
#   scripts/dev-run.sh --glm             # real z.ai GLM; needs GLM_API_KEY
#   scripts/dev-run.sh --home DIR        # pin the throwaway home (keeps sessions)
#   scripts/dev-run.sh -- --resume ID    # everything after -- goes to arterm

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode=""
port=8131
home_dir=""
passthrough=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fake) mode=fake; shift ;;
    --glm) mode=glm; shift ;;
    --port) port="$2"; shift 2 ;;
    --home) home_dir="$2"; shift 2 ;;
    --) shift; passthrough=("$@"); break ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$mode" ]]; then
  echo "pick a mode: --fake (no key needed) or --glm (needs GLM_API_KEY)" >&2
  exit 2
fi

binary="$repo_root/target/debug/arterm"
if [[ ! -x "$binary" ]]; then
  echo "building $binary …" >&2
  (cd "$repo_root" && cargo build -p arterm --bin arterm)
fi

# A throwaway home by default: a fresh one per run makes every launch a
# first-run, which is usually what you want when testing. --home keeps one.
if [[ -z "$home_dir" ]]; then
  home_dir="$(mktemp -d "${TMPDIR:-/tmp}/arterm-dev-home.XXXXXX")"
  echo "throwaway ARTERM_HOME: $home_dir" >&2
fi
mkdir -p "$home_dir"

fake_pid=""
cleanup() {
  [[ -n "$fake_pid" ]] && kill "$fake_pid" 2>/dev/null || true
}
trap cleanup EXIT

case "$mode" in
  fake)
    # The fake server lives in the TypeScript tree; it speaks the
    # OpenAI-compatible API this profile targets.
    fake_server="$repo_root/../scripts/fault-server.mjs"
    if [[ ! -f "$fake_server" ]]; then
      echo "fake server not found at $fake_server" >&2
      exit 1
    fi
    node "$fake_server" --mode ok --port "$port" \
      --answer "This answer came from the fake server, so the whole path works." \
      >"$home_dir/fake-server.log" 2>&1 &
    fake_pid=$!
    # Wait for it rather than sleeping a guessed interval.
    for _ in $(seq 1 50); do
      if curl -sf -m 1 "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done
    cat > "$home_dir/config.toml" <<TOML
[provider]
default_provider = "fakeco"
default_model = "fake"

[providers.fakeco]
type = "openai-compatible"
base_url = "http://127.0.0.1:$port/v1"
auth = "bearer"
api_key = "not-a-real-key"
default_model = "fake"

  [[providers.fakeco.models]]
  id = "fake"
  context_window = 200000
TOML
    echo "fake server on :$port (log: $home_dir/fake-server.log)" >&2
    ;;
  glm)
    if [[ -z "${GLM_API_KEY:-}" ]]; then
      echo "GLM_API_KEY is not set; export it or use --fake" >&2
      exit 2
    fi
    cat > "$home_dir/config.toml" <<'TOML'
[provider]
default_provider = "glm"
default_model = "glm-5.2"

[providers.glm]
type = "openai-compatible"
base_url = "https://api.z.ai/api/coding/paas/v4"
auth = "bearer"
api_key_env = "GLM_API_KEY"
default_model = "glm-5.2"

  [[providers.glm.models]]
  id = "glm-5.2"
  context_window = 200000
TOML
    ;;
esac

ARTERM_HOME="$home_dir" exec "$binary" "${passthrough[@]}"
