use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The top-level Arterm configuration, loaded from `~/.arterm/config.json`.
///
/// Mirrors the TypeScript Arterm's `config.json` format. Every field uses
/// `#[serde(default)]` so a partial user file (or an empty one) is always
/// valid and fills in the defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtermConfig {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub openai_compat_host: Option<String>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub openai_compat_key: Option<String>,
    #[serde(default)]
    pub tui: TuiConfig,
    /// Filesystem confinement for shell commands (see TS `sandbox`).
    #[serde(default)]
    pub sandbox: Option<SandboxConfig>,
    /// Autonomous goal-loop defaults (`/goal`).
    #[serde(default)]
    pub autonomy: Option<AutonomyConfig>,
    /// Custom system-prompt override; when `None` the built-in
    /// [`default_system_prompt`] is used.
    #[serde(default)]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TuiConfig {
    #[serde(default = "default_true")]
    pub fullscreen: bool,
    #[serde(default = "default_true")]
    pub mouse: bool,
}

/// Sandbox / execution-boundary settings for `bash`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfig {
    /// Master switch. `None` means "unstated" — the active mode decides.
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Extra writable paths beyond the session root and temp dir.
    #[serde(default)]
    pub allow_write: Vec<String>,
}

/// Autonomous goal-loop defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutonomyConfig {
    /// Safety step cap for bounded ("once") autonomy runs.
    #[serde(default)]
    pub max_steps: Option<u32>,
}

impl Default for ArtermConfig {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            model: default_model(),
            openai_compat_host: None,
            mode: default_mode(),
            openai_compat_key: None,
            tui: TuiConfig::default(),
            sandbox: None,
            autonomy: None,
            system_prompt: None,
        }
    }
}

impl Default for TuiConfig {
    fn default() -> Self {
        Self { fullscreen: true, mouse: true }
    }
}

fn default_provider() -> String { "ollama".into() }
fn default_model() -> String { "qwen2.5:7b".into() }
fn default_mode() -> String { "ask".into() }
fn default_true() -> bool { true }

/// Where config files live: `$ARTERM_HOME` or `~/.arterm`.
pub fn arterm_home() -> std::path::PathBuf {
    std::env::var("ARTERM_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir().unwrap_or_default().join(".arterm")
        })
}

/// Load config from disk, falling back to defaults on any error.
pub fn load_config() -> ArtermConfig {
    let path = arterm_home().join("config.json");
    match std::fs::read_to_string(&path) {
        Ok(body) => serde_json::from_str(&body).unwrap_or_default(),
        Err(_) => ArtermConfig::default(),
    }
}

/// Write the config back to `~/.arterm/config.json`, creating the directory
/// if needed. Pretty-prints for human-readable diffs.
pub fn save_config(config: &ArtermConfig) -> Result<()> {
    let home = arterm_home();
    std::fs::create_dir_all(&home)
        .with_context(|| format!("creating arterm home at {}", home.display()))?;
    let path = home.join("config.json");
    let body = serde_json::to_string_pretty(config)
        .context("serializing arterm config")?;
    std::fs::write(&path, body)
        .with_context(|| format!("writing config to {}", path.display()))?;
    Ok(())
}

/// The built-in system prompt used when `config.system_prompt` is `None`.
///
/// A concise but complete coding-agent persona: autonomous, tool-driven, and
/// honest about uncertainty — the same posture the TS Arterm ships.
pub fn default_system_prompt() -> String {
    "\
You are Arterm, an autonomous coding agent that works in a terminal.

Goals
- Accomplish the user's stated task fully. Make the code work, not just look like it works.
- Prefer action over narration: use your tools to read, edit, build, and verify.
- Iterate in a closed feedback loop. After a change, run the tests/build/check and fix what fails.
- Keep going through setbacks. When something breaks, diagnose the root cause and repair it rather than reporting it and stopping.

Conduct
- Be concise. Say what you are doing and why, then do it. No filler, no em dashes.
- Be honest about uncertainty. Say \"I don't know\" and investigate instead of guessing confidently.
- Prefer reversible, minimal changes. Match the style of the surrounding code.
- Ask before destructive or irreversible actions (deleting data, force pushes, payments).
- Never invent facts about the codebase. Read the file before you describe it; run the command before you claim its output.

Tools
- Read files and search before editing. Understand the context around a change.
- Run builds and tests to verify your work. A change is not done until the suite says so.
- Commit your work as you go, in coherent chunks.

Report the outcome, what you verified, and what to check next."
        .to_string()
}

/// Resolve the API key to use for an OpenAI-compatible provider.
///
/// Precedence: explicit `config.openai_compat_key`, then the `ARTERM_API_KEY`
/// environment variable, then the standard `OPENAI_API_KEY`.
pub fn resolve_api_key(config: &ArtermConfig) -> Option<String> {
    if let Some(key) = &config.openai_compat_key {
        if !key.trim().is_empty() {
            return Some(key.clone());
        }
    }
    if let Ok(key) = std::env::var("ARTERM_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }
    if let Ok(key) = std::env::var("OPENAI_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }
    None
}
