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
#   3. ARTERM_RUNTIME_DIR is redirected too, and that one is not optional.
#      arterm is client+server, and the server's socket lives in the RUNTIME
#      directory, which ARTERM_HOME does not cover — so a second launch finds
#      the first launch's server and silently uses ITS config. Observed exactly
#      that way: a session started with a real z.ai profile kept answering from
#      a fake server left running by an earlier `--fake` run, and the model name
#      on screen was the fake one. Isolating the home without isolating the
#      runtime isolates nothing.
#
#      The path has to stay SHORT. A Unix socket path is capped near 108 bytes
#      (SUN_LEN), and a long one fails as "Server exited before signalling
#      ready" — which reads like a crash, and the fallback provider printed
#      beneath it reads like a config error. Hence /tmp and a short name.
#
# Note what none of those covers: launch hotkeys used to be written to the
# DESKTOP (~/.config/kglobalshortcutsrc), which ARTERM_HOME cannot redirect.
# That is now opt-in, but the general shape of the risk is worth remembering
# when adding anything that writes outside the process.
#
# Usage:
#   scripts/dev-run.sh --fake            # fake server on :8131, throwaway home
#   scripts/dev-run.sh --fake --port N   # …on another port
#   scripts/dev-run.sh --zai             # real z.ai GLM through the built-in profile
#   scripts/dev-run.sh --home DIR        # pin the home (keeps sessions and logins)
#   scripts/dev-run.sh -- --resume ID    # everything after -- goes to arterm
#
# First time with --zai, log in once (the key is stored under the pinned home):
#   ARTERM_HOME=~/.arterm-rs target/debug/arterm login zai

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode=""
port=8131
home_dir=""
passthrough=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fake) mode=fake; shift ;;
    # --glm is the old spelling; it hand-wrote a TOML profile before anyone
    # noticed the catalog already ships one.
    --zai|--glm) mode=zai; shift ;;
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
  zai)
    # No hand-written profile: `zai` ships in the provider catalog, already
    # pointed at the CODING endpoint (api.z.ai/api/coding/paas/v4, pinned by
    # provider_catalog_tests) rather than the standard paas one. Writing our
    # own profile beside it would be a second copy of that URL to drift.
    key_file="$home_dir/config/arterm/zai.env"
    if [[ ! -s "$key_file" && -z "${ZHIPU_API_KEY:-}" ]]; then
      cat >&2 <<EOF
No z.ai credential for this home.

  log in once (stores the key under this home):
    ARTERM_HOME=$home_dir $binary login zai

  or pass it for one run:
    ZHIPU_API_KEY=… $0 --zai --home $home_dir

  jcode users: the same file already exists as ~/.config/jcode/zai.env
    mkdir -p $(dirname "$key_file") && cp ~/.config/jcode/zai.env "$key_file"
EOF
      exit 2
    fi
    # Only the defaults; the profile itself comes from the catalog.
    cat > "$home_dir/config.toml" <<'TOML'
[provider]
default_provider = "zai"
default_model = "glm-4.7"
TOML
    ;;
esac

# Short and under /tmp on purpose: this becomes a Unix socket path, and past
# ~108 bytes (SUN_LEN) the server fails to start with a message that reads like
# a crash. Derived from the home so two pinned homes get two servers, hashed so
# the length does not depend on how long the home's path is.
runtime_dir="/tmp/arterm-rt-$(printf '%s' "$home_dir" | cksum | cut -d' ' -f1)"
mkdir -p "$runtime_dir"

ARTERM_HOME="$home_dir" ARTERM_RUNTIME_DIR="$runtime_dir" \
  exec "$binary" "${passthrough[@]}"
