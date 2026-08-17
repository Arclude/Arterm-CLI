//! Configuration file support for arterm
//!
//! Config is loaded from `~/.arterm/config.toml` (or `$ARTERM_HOME/config.toml`)
//! Environment variables override config file settings.

pub use arterm_config_types::{
    AgentsConfig, AmbientConfig, AuthConfig, AutoJudgeConfig, AutoReviewConfig, CompactionConfig,
    CompactionMode, CredentialsConfig, CrossProviderFailoverMode, DiagramDisplayMode,
    DiagramPanePosition, DiffDisplayMode, DisplayConfig, FeatureConfig, GatewayConfig,
    HookCommands, HooksConfig, KeybindingsConfig, LatexRenderingMode, LaunchHotkeyEntry,
    LaunchHotkeysConfig, MarkdownSpacingMode, NamedProviderAuth, NamedProviderConfig,
    NamedProviderModelConfig, NamedProviderType, NativeScrollbarConfig, NotificationsConfig,
    OverscrollStatusMode, PowerConfig, ProviderConfig, ReasoningDisplayMode, SafetyConfig,
    SessionPickerResumeAction, SponsorsConfig, SwarmSpawnMode, SwarmStripLayout, TerminalConfig,
    UpdateChannel, WebSearchConfig, WebSearchEngine,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant, SystemTime};

const CONFIG_CACHE_CHECK_INTERVAL: Duration = if cfg!(test) {
    Duration::ZERO
} else {
    Duration::from_millis(500)
};

const CONFIG_ENV_KEYS: &[&str] = &[
    "HOME",
    "ARTERM_ACP_PROFILE",
    "ARTERM_ACP_TOOL_PROFILE",
    "ARTERM_ACTIVE_SESSIONS_MANAGER",
    "ARTERM_EXTERNAL_SESSIONS",
    "ARTERM_AMBIENT_ENABLED",
    "ARTERM_AMBIENT_MAX_INTERVAL",
    "ARTERM_AMBIENT_MIN_INTERVAL",
    "ARTERM_AMBIENT_MODEL",
    "ARTERM_AMBIENT_PROACTIVE",
    "ARTERM_AMBIENT_PROVIDER",
    "ARTERM_AMBIENT_VISIBLE",
    "ARTERM_ANIMATION_FPS",
    "ARTERM_AUTO_POKE",
    "ARTERM_AUTOJUDGE_ENABLED",
    "ARTERM_AUTOJUDGE_MODEL",
    "ARTERM_AUTOREVIEW_ENABLED",
    "ARTERM_AUTOREVIEW_MODEL",
    "ARTERM_AUTO_POKE",
    "ARTERM_AUTO_SERVER_RELOAD",
    "ARTERM_BING_API_KEY",
    "ARTERM_BING_API_KEY_ENV",
    "ARTERM_BING_MARKET",
    "ARTERM_CENTERED_TOGGLE_KEY",
    "ARTERM_CHAT_NATIVE_SCROLLBAR",
    "ARTERM_COMPACT_NOTIFICATIONS",
    "ARTERM_COPY_BADGE_ALT_LABEL",
    "ARTERM_COPY_SELECTION_TOGGLE_KEY",
    "ARTERM_COPILOT_PREMIUM",
    "ARTERM_CROSS_PROVIDER_FAILOVER",
    "ARTERM_DEBUG_SOCKET",
    "ARTERM_DEFAULT_REASONING_DISPLAY",
    "ARTERM_DICTATION_COMMAND",
    "ARTERM_DICTATION_KEY",
    "ARTERM_DICTATION_MODE",
    "ARTERM_DICTATION_TIMEOUT_SECS",
    "ARTERM_DIFF_LINE_WRAP",
    "ARTERM_DIFF_MODE",
    "ARTERM_DIFF_MODE_CYCLE_KEY",
    "ARTERM_DIAGRAM_PANE_TOGGLE_KEY",
    "ARTERM_DISABLE_BASE_TOOLS",
    "ARTERM_DISABLED_ANIMATIONS",
    "ARTERM_DISABLED_TOOLS",
    "ARTERM_DISPLAY_CENTERED",
    "ARTERM_EFFORT_DECREASE_KEY",
    "ARTERM_EFFORT_INCREASE_KEY",
    "ARTERM_EMAIL_REPLY_ENABLED",
    "ARTERM_EMAIL_TO",
    "ARTERM_FOCUS_HOOK",
    "ARTERM_GATEWAY_BIND_ADDR",
    "ARTERM_GATEWAY_ENABLED",
    "ARTERM_GATEWAY_PORT",
    "ARTERM_HOME",
    "ARTERM_HOOK_PRE_TOOL",
    "ARTERM_HOOK_PRE_TOOL_TIMEOUT_MS",
    "ARTERM_HOOK_POST_TOOL",
    "ARTERM_HOOK_SESSION_END",
    "ARTERM_HOOK_SESSION_START",
    "ARTERM_HOOK_TURN_END",
    "ARTERM_HOOK_TURN_START",
    "ARTERM_IDLE_ANIMATION",
    "ARTERM_IMAP_HOST",
    "ARTERM_INFO_WIDGET_TOGGLE_KEY",
    "ARTERM_JADE_RELAY_API_BASE",
    "ARTERM_JADE_RELAY_ENABLED",
    "ARTERM_JADE_RELAY_LAUNCH_ENABLED",
    "ARTERM_JADE_RELAY_LAUNCH_WORKING_DIR",
    "ARTERM_JADE_RELAY_REPLY_ENABLED",
    "ARTERM_JADE_RELAY_SESSION_ID",
    "ARTERM_JADE_RELAY_TOKEN",
    "ARTERM_JADE_RELAY_TOKEN_ID",
    "ARTERM_JADE_RELAY_USER_ID",
    "ARTERM_KV_CACHE_MISS_NOTICES",
    "ARTERM_LATEX_RENDERING",
    "ARTERM_MARKDOWN_SPACING",
    "ARTERM_MEMORY_EMBEDDING_BACKEND",
    "ARTERM_MEMORY_EMBEDDING_BASE_URL",
    "ARTERM_MEMORY_EMBEDDING_DIM",
    "ARTERM_MEMORY_EMBEDDING_MODEL",
    "ARTERM_MEMORY_ENABLED",
    "ARTERM_ENABLE_MERMAID",
    "ARTERM_MEMORY_MODEL",
    "ARTERM_MEMORY_SIDECAR_ENABLED",
    "ARTERM_PERSIST_MEMORY_INJECTIONS",
    "ARTERM_MESSAGE_TIMESTAMPS",
    "ARTERM_MODEL",
    "ARTERM_MODEL_SWITCH_KEY",
    "ARTERM_MODEL_SWITCH_PREV_KEY",
    "ARTERM_MOUSE_CAPTURE",
    "ARTERM_NEW_TERMINAL_KEY",
    "ARTERM_NO_EMOJI",
    "ARTERM_NTFY_SERVER",
    "ARTERM_NTFY_TOPIC",
    "ARTERM_OPENAI_NATIVE_COMPACTION_MODE",
    "ARTERM_OPENAI_NATIVE_COMPACTION_THRESHOLD_TOKENS",
    "ARTERM_OPENAI_REASONING_EFFORT",
    "ARTERM_OPENAI_SERVICE_TIER",
    "ARTERM_OPENAI_TRANSPORT",
    "ARTERM_ANTHROPIC_REASONING_EFFORT",
    "ARTERM_PRESERVE_REASONING_CONTEXT",
    "ARTERM_PERFORMANCE",
    "ARTERM_PIN_IMAGES",
    "ARTERM_PIN_TODOS",
    "ARTERM_PREVENT_SLEEP_WHILE_STREAMING",
    "ARTERM_PROVIDER",
    "ARTERM_PROMPT_ENTRY_ANIMATION",
    "ARTERM_QUEUE_MODE",
    "ARTERM_REASONING_DISPLAY",
    "ARTERM_REDRAW_FPS",
    "ARTERM_SAME_PROVIDER_ACCOUNT_FAILOVER",
    "ARTERM_SANDBOX_MODE",
    "ARTERM_SCROLL_BOOKMARK_KEY",
    "ARTERM_SCROLL_DOWN_FALLBACK_KEY",
    "ARTERM_SCROLL_DOWN_KEY",
    "ARTERM_SCROLL_PAGE_DOWN_KEY",
    "ARTERM_SCROLL_PAGE_UP_KEY",
    "ARTERM_SCROLL_PROMPT_DOWN_KEY",
    "ARTERM_SCROLL_PROMPT_UP_KEY",
    "ARTERM_SCROLL_UP_FALLBACK_KEY",
    "ARTERM_SCROLL_UP_KEY",
    "ARTERM_SEARXNG_URL",
    "ARTERM_SHOW_AGENTGREP_OUTPUT",
    "ARTERM_SHOW_DIFFS",
    "ARTERM_SHOW_THINKING",
    "ARTERM_SIDE_PANEL_TOGGLE_KEY",
    "ARTERM_SIDE_PANEL_NATIVE_SCROLLBAR",
    "ARTERM_SMTP_PASSWORD",
    "ARTERM_SPAWN_HOOK",
    "ARTERM_STREAM_IDLE_TIMEOUT_SECS",
    "ARTERM_SWARM_ENABLED",
    "ARTERM_SWARM_MODEL",
    "ARTERM_SWARM_MAX_CONCURRENT_AGENTS",
    "ARTERM_SWARM_SPAWN_MODE",
    "ARTERM_SWARM_STRIP_LAYOUT",
    "ARTERM_TELEGRAM_BOT_TOKEN",
    "ARTERM_TELEGRAM_CHAT_ID",
    "ARTERM_TELEGRAM_REPLY_ENABLED",
    "ARTERM_TOOL_CALL_DETAILS",
    "ARTERM_TOOL_PROFILE",
    "ARTERM_TOOLS",
    "ARTERM_TRUSTED_EXTERNAL_AUTH_SOURCES",
    "ARTERM_TYPING_SCROLL_LOCK_TOGGLE_KEY",
    "ARTERM_UPDATE_CHANNEL",
    "ARTERM_WEBSEARCH_ENGINE",
    "ARTERM_WEBSEARCH_FALLBACK_ENGINES",
    "ARTERM_WORKSPACE_DOWN_KEY",
    "ARTERM_WORKSPACE_LEFT_KEY",
    "ARTERM_WORKSPACE_RIGHT_KEY",
    "ARTERM_WORKSPACE_UP_KEY",
    "XDG_CONFIG_HOME",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigCacheFingerprint {
    path: Option<PathBuf>,
    modified: Option<SystemTime>,
    len: Option<u64>,
    env: Vec<(String, String)>,
}

impl ConfigCacheFingerprint {
    fn current() -> Self {
        let path = Config::path();
        let metadata = path.as_ref().and_then(|path| std::fs::metadata(path).ok());
        Self {
            path,
            modified: metadata
                .as_ref()
                .and_then(|metadata| metadata.modified().ok()),
            len: metadata.as_ref().map(std::fs::Metadata::len),
            env: config_env_fingerprint(),
        }
    }
}

struct ConfigCache {
    config: &'static Config,
    fingerprint: ConfigCacheFingerprint,
    last_checked: Instant,
    force_reload: bool,
}

static CONFIG_CACHE: LazyLock<RwLock<ConfigCache>> = LazyLock::new(|| {
    let config = leak_config(Config::load());
    // Fingerprint after the load: applying env overrides may set env vars
    // (e.g. copilot_premium -> ARTERM_COPILOT_PREMIUM), and fingerprinting
    // first would guarantee a spurious full reload on the next check.
    let fingerprint = ConfigCacheFingerprint::current();
    // Seed the global context-limit cache from named provider configs on first
    // load so every codepath (TUI info widget, compaction budget, model
    // switching) sees user-configured `context_window` values from the start.
    // Read from the loaded config directly to avoid recursing into config(),
    // which would deadlock on the still-initializing CONFIG_CACHE.
    populate_context_limits_from_config_ref(config);
    RwLock::new(ConfigCache {
        config,
        fingerprint,
        last_checked: Instant::now(),
        force_reload: false,
    })
});

fn leak_config(config: Config) -> &'static Config {
    Box::leak(Box::new(config))
}

/// Seed the global context-limit cache from a config reference directly.
///
/// Used during CONFIG_CACHE initialization (where calling config() would
/// deadlock) and shares its logic with
/// `crate::provider::populate_context_limits_from_config`.
fn populate_context_limits_from_config_ref(cfg: &Config) {
    crate::provider::populate_context_limits_from_config_value(cfg);
}

/// Get the global config instance.
///
/// The returned reference is backed by a reloadable process cache. Calls check
/// the config file path/metadata and relevant environment overrides on a short
/// throttle, not every frame. When those inputs change, the next checked call
/// reloads config.toml and invalidates dependent auth/model caches. Older
/// references remain valid for the duration of any in-flight operation.
pub fn config() -> &'static Config {
    let now = Instant::now();
    if let Ok(cache) = CONFIG_CACHE.read()
        && !cache.force_reload
        && now.duration_since(cache.last_checked) < CONFIG_CACHE_CHECK_INTERVAL
    {
        return cache.config;
    }

    let mut reload_reason = None;
    let config = {
        let mut cache = CONFIG_CACHE
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let now = Instant::now();
        if !cache.force_reload
            && now.duration_since(cache.last_checked) < CONFIG_CACHE_CHECK_INTERVAL
        {
            return cache.config;
        }

        let fingerprint = ConfigCacheFingerprint::current();
        cache.last_checked = now;
        if cache.force_reload || cache.fingerprint != fingerprint {
            reload_reason = Some(describe_config_reload(
                cache.force_reload,
                &cache.fingerprint,
                &fingerprint,
            ));
            cache.config = leak_config(Config::load());
            // Loading applies env overrides that can themselves set env vars
            // (e.g. copilot_premium propagates config -> ARTERM_COPILOT_PREMIUM).
            // Re-fingerprint after the load so those self-inflicted env changes
            // don't trigger a guaranteed second reload on the next check.
            cache.fingerprint = ConfigCacheFingerprint::current();
            cache.force_reload = false;
        }
        cache.config
    };

    if let Some(reason) = reload_reason {
        crate::logging::info(&format!("CONFIG_RELOAD {}", reason));
        // A config reload can change config-derived system prompt sections
        // (feature toggles, sponsors, ...), which legitimately invalidates the
        // KV cache prefix of warm sessions. Document it so a subsequent
        // harness-attributed cache miss is surfaced with this cause instead of
        // as an unexplained prompt mutation.
        crate::cache_invalidation::record("config reload", &reason);
        notify_config_reloaded();
        // Re-seed the global context-limit cache so user edits to named
        // provider `context_window` values take effect without a restart.
        crate::provider::populate_context_limits_from_config();
    }

    config
}

fn describe_config_reload(
    forced: bool,
    previous: &ConfigCacheFingerprint,
    next: &ConfigCacheFingerprint,
) -> String {
    let mut parts = Vec::new();
    if forced {
        parts.push("forced=true".to_string());
    }
    if previous.path != next.path {
        parts.push(format!(
            "path={:?}->{:?}",
            previous.path.as_ref().map(|p| p.display().to_string()),
            next.path.as_ref().map(|p| p.display().to_string())
        ));
    }
    if previous.modified != next.modified {
        parts.push("modified_changed=true".to_string());
    }
    if previous.len != next.len {
        parts.push(format!("len={:?}->{:?}", previous.len, next.len));
    }
    let env_changes = describe_env_changes(&previous.env, &next.env);
    if !env_changes.is_empty() {
        parts.push(format!("env=[{}]", env_changes.join(", ")));
    }
    if parts.is_empty() {
        "unchanged".to_string()
    } else {
        parts.join(" ")
    }
}

fn describe_env_changes(previous: &[(String, String)], next: &[(String, String)]) -> Vec<String> {
    let previous_map: BTreeMap<&str, &str> = previous
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let next_map: BTreeMap<&str, &str> = next
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let keys: BTreeSet<&str> = previous_map
        .keys()
        .chain(next_map.keys())
        .copied()
        .collect();

    keys.into_iter()
        .filter_map(|key| match (previous_map.get(key), next_map.get(key)) {
            (Some(previous), Some(next)) if previous != next => Some(format!(
                "{}:changed({}->{})",
                key,
                env_value_fingerprint(previous),
                env_value_fingerprint(next)
            )),
            (None, Some(next)) => Some(format!("{}:added({})", key, env_value_fingerprint(next))),
            (Some(previous), None) => Some(format!(
                "{}:removed({})",
                key,
                env_value_fingerprint(previous)
            )),
            _ => None,
        })
        .collect()
}

fn env_value_fingerprint(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("len:{} hash:{:016x}", value.len(), hasher.finish())
}

fn config_env_fingerprint() -> Vec<(String, String)> {
    let mut values = std::env::vars_os()
        .filter_map(|(key, value)| {
            let key = key.to_string_lossy().to_string();
            if CONFIG_ENV_KEYS.contains(&key.as_str()) {
                Some((key, value.to_string_lossy().to_string()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.0.cmp(&right.0));
    values
}

pub fn invalidate_config_cache() {
    let mut cache = CONFIG_CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.force_reload = true;
    drop(cache);
    notify_config_reloaded();
}

fn notify_config_reloaded() {
    CONFIG_RELOAD_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    for listener in CONFIG_RELOAD_LISTENERS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
    {
        listener();
    }
}

/// Monotonic counter bumped every time the config cache reloads.
///
/// Callers that snapshot config-derived state (e.g. the TUI's parsed
/// keybindings) can poll this cheaply and re-derive their snapshot when the
/// generation changes, giving instant hot-reload of config edits without a
/// restart.
static CONFIG_RELOAD_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Current config reload generation. Increments after every cache reload.
pub fn config_reload_generation() -> u64 {
    CONFIG_RELOAD_GENERATION.load(std::sync::atomic::Ordering::Relaxed)
}

/// Listeners invoked after the config cache reloads.
///
/// Config is a foundational module, so instead of reaching up into higher-level
/// subsystems (auth cache, event bus) on reload, those subsystems register a
/// reaction here at startup. This keeps config free of upward dependencies and
/// breaks the config -> auth / config -> bus cycle edges.
/// Type of a config reload listener callback.
type ConfigReloadListener = fn();

static CONFIG_RELOAD_LISTENERS: LazyLock<RwLock<Vec<ConfigReloadListener>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));

/// Register a callback to run after the config cache reloads.
///
/// Callbacks must be cheap and non-blocking; they run on whichever thread
/// triggers the reload. Intended to be called once per subsystem during
/// process startup.
pub fn on_config_reloaded(listener: fn()) {
    CONFIG_RELOAD_LISTENERS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(listener);
}

/// Main configuration struct
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    /// Keybinding configuration
    pub keybindings: KeybindingsConfig,

    /// External dictation / speech-to-text integration
    pub dictation: DictationConfig,

    /// Display/UI configuration
    pub display: DisplayConfig,

    /// Feature toggles
    pub features: FeatureConfig,

    /// Web search tool configuration
    pub websearch: WebSearchConfig,

    /// Built-in tool exposure configuration
    pub tools: ToolConfig,

    /// Agent Client Protocol adapter configuration
    pub acp: AcpConfig,

    /// Auth trust / consent configuration
    pub auth: AuthConfig,

    /// Provider configuration
    pub provider: ProviderConfig,

    /// Named provider profiles, keyed by profile name.
    ///
    /// Example:
    /// [providers.my-gateway]
    /// type = "openai-compatible"
    /// base_url = "https://llm.example.com/v1"
    /// api_key_env = "MY_GATEWAY_API_KEY"
    pub providers: BTreeMap<String, NamedProviderConfig>,

    /// Agent-specific model defaults
    pub agents: AgentsConfig,

    /// Terminal window/pane spawning configuration
    pub terminal: TerminalConfig,

    /// Lifecycle hooks (external commands at turn/session/tool boundaries)
    pub hooks: HooksConfig,

    /// Ambient mode configuration
    pub ambient: AmbientConfig,

    /// Safety / notification configuration
    pub safety: SafetyConfig,

    /// OS-level sandbox mode for bash commands: "full-access" (default),
    /// "workspace-write", or "read-only". When set to a sandboxed mode, bash
    /// commands are restricted via Landlock (Linux) or Seatbelt (macOS).
    #[serde(default)]
    pub sandbox_mode: String,

    /// Desktop notifications for interactive sessions (e.g. turn completion)
    pub notifications: NotificationsConfig,

    /// WebSocket gateway configuration (for iOS/web clients)
    pub gateway: GatewayConfig,

    /// Compaction configuration
    pub compaction: CompactionConfig,

    /// Power-management configuration (prevent sleep while streaming)
    pub power: PowerConfig,

    /// Auto-review configuration
    pub autoreview: AutoReviewConfig,

    /// Auto-judge configuration
    pub autojudge: AutoJudgeConfig,

    /// Partner discovery configuration. Skipped when it matches the shipped
    /// default so saving config never bakes today's default into the file (see
    /// [`sponsors_is_default`]).
    #[serde(skip_serializing_if = "sponsors_is_default")]
    pub sponsors: SponsorsConfig,

    /// Global "launch a new arterm" hotkeys (macOS). Baked once by auto-import.
    pub launch_hotkeys: LaunchHotkeysConfig,

    /// What a spawned command is handed from the environment. Scrubbing is on
    /// by default, so the section is omitted from written config files until
    /// someone states an `allow`/`deny` or turns it off.
    #[serde(skip_serializing_if = "credentials_is_default")]
    pub credentials: CredentialsConfig,
}

/// Whether env hygiene carries no information beyond the shipped default.
fn credentials_is_default(credentials: &CredentialsConfig) -> bool {
    let default = CredentialsConfig::default();
    credentials.scrub == default.scrub
        && credentials.allow.is_empty()
        && credentials.deny.is_empty()
}

/// Agent Client Protocol adapter configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AcpConfig {
    /// Client compatibility profile: "standard" (default), "extended", or "full".
    pub profile: String,
    /// Tool profile to request when `arterm acp` starts a daemon itself.
    pub tool_profile: String,
}

impl Default for AcpConfig {
    fn default() -> Self {
        Self {
            profile: "standard".to_string(),
            tool_profile: "acp".to_string(),
        }
    }
}

/// Controls which tools are sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ToolConfig {
    /// Tool profile: "full" (default), "acp", "minimal"/"lite", or "none".
    pub profile: String,
    /// Explicit allow-list. When set, only these tools are exposed.
    /// Use "*" or "all" to expose all tools without an allow-list.
    pub enabled: Vec<String>,
    /// Tools to remove after applying profile/enabled.
    pub disabled: Vec<String>,
    /// Disable all built-in tools unless `enabled` is provided.
    pub disable_base_tools: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolSelection {
    pub allowed_tools: Option<HashSet<String>>,
    pub disabled_tools: HashSet<String>,
}

impl ToolConfig {
    pub fn selection(&self) -> ToolSelection {
        let mut allowed_tools = self.base_allowed_tools();
        let disabled_tools: HashSet<String> = self
            .disabled
            .iter()
            .map(|name| normalize_tool_name(name))
            .filter(|name| !name.is_empty())
            .collect();

        if let Some(allowed) = allowed_tools.as_mut() {
            for name in &disabled_tools {
                allowed.remove(name);
            }
        }

        ToolSelection {
            allowed_tools,
            disabled_tools,
        }
    }

    pub fn allowed_tools(&self) -> Option<HashSet<String>> {
        self.selection().allowed_tools
    }

    pub fn apply_to_allowed_set(&self, allowed: &mut HashSet<String>) {
        let selection = self.selection();
        if let Some(global_allowed) = selection.allowed_tools {
            allowed.retain(|name| global_allowed.contains(name));
        }
        for disabled in selection.disabled_tools {
            allowed.remove(&disabled);
        }
    }

    fn base_allowed_tools(&self) -> Option<HashSet<String>> {
        let (explicit, enables_all_tools) = self.normalized_enabled_tools();

        let profile = self.profile.trim().to_ascii_lowercase();
        if enables_all_tools {
            None
        } else if !explicit.is_empty() {
            Some(explicit)
        } else if self.disable_base_tools || matches!(profile.as_str(), "none" | "off" | "disabled")
        {
            Some(HashSet::new())
        } else if matches!(profile.as_str(), "acp") {
            Some(
                [
                    "bash",
                    "read",
                    "write",
                    "edit",
                    "multiedit",
                    "apply_patch",
                    "patch",
                    "agentgrep",
                    "ls",
                    "batch",
                    "mcp",
                ]
                .into_iter()
                .map(|name| name.to_string())
                .collect(),
            )
        } else if matches!(profile.as_str(), "minimal" | "lite" | "small") {
            Some(
                [
                    "bash",
                    "read",
                    "write",
                    "edit",
                    "multiedit",
                    "apply_patch",
                    "patch",
                    "agentgrep",
                    "ls",
                ]
                .into_iter()
                .map(|name| name.to_string())
                .collect(),
            )
        } else {
            None
        }
    }

    fn normalized_enabled_tools(&self) -> (HashSet<String>, bool) {
        let mut enabled = HashSet::new();
        let mut enables_all_tools = false;

        for name in &self.enabled {
            let normalized = normalize_tool_name(name);
            if normalized.is_empty() {
                continue;
            }
            if normalized == "*" || normalized.eq_ignore_ascii_case("all") {
                enables_all_tools = true;
            } else {
                enabled.insert(normalized);
            }
        }

        (enabled, enables_all_tools)
    }
}

fn normalize_tool_name(name: &str) -> String {
    let trimmed = name.trim().trim_matches('"');
    arterm_tool_types::resolve_tool_name(trimmed).to_string()
}

/// External dictation / speech-to-text integration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DictationConfig {
    /// Shell command to run. Must print the transcript to stdout.
    pub command: String,
    /// How to apply the resulting transcript.
    pub mode: crate::protocol::TranscriptMode,
    /// Optional in-app hotkey to trigger dictation.
    pub key: String,
    /// Maximum time to wait for the command to finish (0 = no timeout).
    pub timeout_secs: u64,
}

impl Default for DictationConfig {
    fn default() -> Self {
        Self {
            command: String::new(),
            mode: crate::protocol::TranscriptMode::Send,
            key: "off".to_string(),
            timeout_secs: 90,
        }
    }
}

pub mod change_report;
mod config_file;
mod default_file;
mod display_summary;
mod env_overrides;

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "config_color_tests.rs"]
mod color_tests;

/// Whether integration discovery settings carry no information beyond the shipped
/// default, so `[sponsors]` can be left out of written config files.
///
/// Config saves serialize the whole struct, so a section written while one
/// default was in force freezes that value into the user's file and survives
/// every later change of mind. Upstream learned this in the opt-in direction:
/// discovery shipped `enabled = false`, saves froze it, and users stayed
/// opted out after the default flipped on. This fork has flipped it back off
/// (the endpoint is not ours — see `SponsorsConfig`), so the same mechanism
/// now threatens the opposite: a file carrying `enabled = true` nobody chose,
/// silently contacting a third party. Tracking the CURRENT default rather
/// than a pinned value is what makes the omission safe in both directions.
fn sponsors_is_default(sponsors: &SponsorsConfig) -> bool {
    sponsors.enabled == SponsorsConfig::default().enabled
        && is_default_discovery_endpoint(&sponsors.endpoint)
}

/// Endpoints that only ever came from a shipped default, never a user choice.
pub(crate) fn is_default_discovery_endpoint(endpoint: &str) -> bool {
    let endpoint = endpoint.trim_end_matches('/');
    endpoint == arterm_config_types::DEFAULT_DISCOVERY_ENDPOINT
        || endpoint == arterm_config_types::LEGACY_DISCOVERY_ENDPOINT
}
