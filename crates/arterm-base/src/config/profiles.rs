//! Named config profiles: overlay sections in config.toml applied on
//! top of the base config so one flag (`--profile work` or
//! `ARTERM_PROFILE=work`) can switch a coherent bundle of settings.
//!
//! Policy as data: a profile only lists what it overrides; everything
//! else inherits from the base config. Unknown profile names fail
//! loudly with the list of defined profiles instead of silently
//! producing the base config (observable failures).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::Config;

/// Fields a profile may override. Every field is optional; `None`
/// means "inherit from the base config".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProfileConfig {
    /// Default model id (e.g. "claude-opus-4-6").
    pub default_model: Option<String>,
    /// Default provider id (e.g. "anthropic").
    pub default_provider: Option<String>,
    /// Named [providers.<name>] entry to route through.
    pub provider_profile: Option<String>,
    /// OpenAI reasoning effort.
    pub openai_reasoning_effort: Option<String>,
    /// Anthropic reasoning effort.
    pub anthropic_reasoning_effort: Option<String>,
    /// Sandbox mode: "full-access" | "workspace-write" | "read-only".
    pub sandbox_mode: Option<String>,
    /// Commit touched files after file-mutating tools.
    pub git_auto_commit: Option<bool>,
    /// Built-in tool exposure profile: "full" | "minimal" | "none".
    pub tool_profile: Option<String>,
    /// Extra permission rules appended after the base rules.
    pub permission_rules: Vec<String>,
}

/// Root config section: written as `[profiles.<name>]` in config.toml
/// (serde rename), stored as `profiles_section` on Config.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfilesConfig {
    #[serde(flatten)]
    pub profiles: BTreeMap<String, ProfileConfig>,
}

impl ProfilesConfig {
    pub fn get(&self, name: &str) -> Option<&ProfileConfig> {
        self.profiles.get(name)
    }

    pub fn names(&self) -> Vec<&str> {
        self.profiles.keys().map(String::as_str).collect()
    }

    /// Whether the section carries no information worth writing.
    pub fn is_empty(&self) -> bool {
        self.profiles.is_empty()
    }
}

/// Resolve the active profile name: explicit argument first, then
/// `ARTERM_PROFILE`. Empty/missing means no profile.
pub fn active_profile_name(cli_profile: Option<&str>) -> Option<String> {
    if let Some(name) = cli_profile {
        let trimmed = name.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    std::env::var("ARTERM_PROFILE")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Apply a profile overlay onto a loaded config.
///
/// Precedence (low to high): base config file < profile overlay <
/// explicit env overrides (env overrides already ran in `Config::load`
/// before this; callers that need env to win over the profile must
/// re-apply it after, which `Config::load_with_profile` does).
///
/// Errors with the defined profile names when `name` is unknown.
pub fn apply_profile(config: &mut Config, name: &str) -> anyhow::Result<()> {
    let Some(profile) = config.profiles_section.profiles.get(name) else {
        let names = config.profiles_section.names().join(", ");
        anyhow::bail!(
            "unknown config profile `{name}` (defined: [{}])",
            if names.is_empty() { "none" } else { &names }
        );
    };

    if let Some(model) = &profile.default_model {
        config.provider.default_model = Some(model.clone());
    }
    if let Some(provider) = &profile.default_provider {
        config.provider.default_provider = Some(provider.clone());
    }
    if let Some(effort) = &profile.openai_reasoning_effort {
        config.provider.openai_reasoning_effort = Some(effort.clone());
    }
    if let Some(effort) = &profile.anthropic_reasoning_effort {
        config.provider.anthropic_reasoning_effort = Some(effort.clone());
    }
    if let Some(mode) = &profile.sandbox_mode {
        config.sandbox_mode = mode.clone();
    }
    if let Some(auto) = profile.git_auto_commit {
        config.git_auto_commit = auto;
    }
    if let Some(tool_profile) = &profile.tool_profile {
        config.tools.profile = tool_profile.clone();
    }
    if !profile.permission_rules.is_empty() {
        let extra: Vec<String> = profile.permission_rules.clone();
        config.permission_rules.extend_rules(extra);
    }

    crate::logging::info(&format!("CONFIG_PROFILE applied: {name}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> Config {
        Config::default()
    }

    fn profile(overrides: ProfileConfig) -> Config {
        let mut cfg = base_config();
        cfg.profiles_section
            .profiles
            .insert("test".into(), overrides);
        cfg
    }

    #[test]
    fn unknown_profile_lists_defined_names() {
        let mut cfg = profile(ProfileConfig::default());
        cfg.profiles_section.profiles.insert(
            "work".into(),
            ProfileConfig {
                sandbox_mode: Some("read-only".into()),
                ..Default::default()
            },
        );
        let err = apply_profile(&mut cfg, "nope").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unknown config profile `nope`"), "{msg}");
        assert!(msg.contains("test"), "{msg}");
        assert!(msg.contains("work"), "{msg}");
    }

    #[test]
    fn empty_profiles_section_reports_none() {
        let mut cfg = base_config();
        let err = apply_profile(&mut cfg, "x").unwrap_err();
        assert!(err.to_string().contains("[none]"), "{}", err);
    }

    #[test]
    fn overlay_overrides_only_set_fields() {
        let mut cfg = profile(ProfileConfig {
            default_model: Some("m2".into()),
            sandbox_mode: Some("workspace-write".into()),
            git_auto_commit: Some(true),
            ..Default::default()
        });
        cfg.provider.default_model = Some("m1".into());
        cfg.sandbox_mode = "full-access".into();
        cfg.provider.openai_reasoning_effort = Some("high".into());

        apply_profile(&mut cfg, "test").unwrap();
        assert_eq!(cfg.provider.default_model.as_deref(), Some("m2"));
        assert_eq!(cfg.sandbox_mode, "workspace-write");
        assert!(cfg.git_auto_commit);
        // Untouched fields keep base values.
        assert_eq!(
            cfg.provider.openai_reasoning_effort.as_deref(),
            Some("high")
        );
        assert_eq!(cfg.provider.default_provider, None);
    }

    #[test]
    fn permission_rules_append_after_base() {
        let mut cfg = profile(ProfileConfig {
            permission_rules: vec!["deny Bash(rm -rf *)".into()],
            ..Default::default()
        });
        let base_count = cfg.permission_rules.rules_len();
        apply_profile(&mut cfg, "test").unwrap();
        assert_eq!(cfg.permission_rules.rules_len(), base_count + 1);
    }

    #[test]
    fn active_profile_prefers_cli_over_env() {
        // Not using set_var unsafe here: read both inputs through the
        // same function with explicit arguments.
        assert_eq!(active_profile_name(Some("cli")), Some("cli".into()));
        assert_eq!(active_profile_name(Some("  ")), None);
        assert_eq!(
            active_profile_name(None),
            std::env::var("ARTERM_PROFILE")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        );
    }

    /// Integration: a config.toml with [profiles.*] plus ARTERM_PROFILE
    /// flows through Config::load end to end.
    #[test]
    fn config_load_applies_active_profile() {
        let home = std::env::temp_dir().join(format!("prof-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("config.toml"),
            r#"
[profiles.strict]
sandbox_mode = "read-only"
git_auto_commit = true
default_model = "prof-model"
"#,
        )
        .unwrap();
        // Rust 2024: env mutation is unsafe.
        unsafe {
            std::env::set_var("ARTERM_HOME", &home);
            std::env::set_var("ARTERM_PROFILE", "strict");
        }
        super::super::invalidate_config_cache();
        let cfg = Config::load();
        unsafe {
            std::env::remove_var("ARTERM_PROFILE");
            std::env::remove_var("ARTERM_HOME");
        }
        super::super::invalidate_config_cache();
        let _ = std::fs::remove_dir_all(&home);

        assert_eq!(cfg.sandbox_mode, "read-only");
        assert!(cfg.git_auto_commit);
        assert_eq!(cfg.provider.default_model.as_deref(), Some("prof-model"));
    }

    #[test]
    fn profiles_roundtrip_through_toml() {
        // The [profiles.<name>] section parses as part of the full Config.
        let toml_src = r#"
[profiles.work]
default_model = "opus"
sandbox_mode = "read-only"
git_auto_commit = true
permission_rules = ["deny Bash(sudo *)"]

[profiles.fast]
default_model = "haiku"

[provider]
"#;
        let parsed: Config = toml::from_str(toml_src).unwrap();
        let parsed = &parsed.profiles_section;
        assert_eq!(parsed.names(), vec!["fast", "work"]);
        let work = parsed.get("work").unwrap();
        assert_eq!(work.default_model.as_deref(), Some("opus"));
        assert_eq!(work.sandbox_mode.as_deref(), Some("read-only"));
        assert!(work.git_auto_commit == Some(true));
        assert_eq!(work.permission_rules.len(), 1);
        let fast = parsed.get("fast").unwrap();
        assert_eq!(fast.default_model.as_deref(), Some("haiku"));
        assert_eq!(fast.sandbox_mode, None);
    }
}
