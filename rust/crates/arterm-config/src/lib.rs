use serde::{Deserialize, Serialize};

/// The top-level Arterm configuration, loaded from `~/.arterm/config.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TuiConfig {
    #[serde(default = "default_true")]
    pub fullscreen: bool,
    #[serde(default = "default_true")]
    pub mouse: bool,
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
