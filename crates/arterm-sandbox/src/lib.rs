//! OS-level sandboxing for command execution, structured after the
//! OpenSandbox architecture:
//!
//! - **Policy as data** (`policy.rs`): a runtime-neutral `SandboxConfig`
//!   holding the filesystem mode and the outbound `NetworkPolicy`.
//! - **Runtime-specific enforcement**: Linux Landlock (`linux.rs`) and macOS
//!   Seatbelt (`macos.rs`). Other platforms report an observable skip.
//! - **Secure defaults with explicit escape hatches**: sandboxed modes imply
//!   a deny-by-default egress policy; `full-access` is the explicit opt-out.
//! - **Observable failures**: `apply` reports whether the sandbox was
//!   enforced, and why, so callers can refuse to run unsandboxed.
//!
//! # Sandbox modes
//!
//! - `Readonly`: No filesystem writes, no network
//! - `WorkspaceWrite`: Write only to the working directory + temp dirs,
//!   outbound network limited by the egress policy (DNS/HTTP/HTTPS by default)
//! - `FullAccess`: No restrictions (equivalent to no sandbox)
//!
//! # Usage
//!
//! The caller applies the sandbox in a `pre_exec` hook on the child process.
//! On Linux this restricts the child (and all its descendants) via Landlock.
//! On macOS the caller should wrap the command with `sandbox-exec`.

#![cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]

mod policy;

pub use policy::{
    EgressAction, EgressDefault, EgressRule, EgressTarget, NetworkPolicy, SandboxConfig,
    SandboxMode, SandboxResult,
};

/// Apply the sandbox. This must be called from a `pre_exec` hook on the child
/// process, after `fork()` but before `exec()`.
///
/// On platforms without sandbox support, this is a no-op that reports a skip.
pub fn apply(config: &SandboxConfig) -> Result<SandboxResult, String> {
    if !config.mode.is_sandboxed() {
        return Ok(SandboxResult::skipped("full-access mode, no sandbox"));
    }

    #[cfg(target_os = "linux")]
    {
        linux::apply_landlock(config)
    }

    #[cfg(target_os = "macos")]
    {
        macos::generate_seatbelt_profile(config)
            .map(|profile| SandboxResult::applied(format!("seatbelt profile: {profile}")))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = config;
        Ok(SandboxResult::skipped(
            "sandbox not supported on this platform",
        ))
    }
}

// ─── platform modules ────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
mod macos;

/// Generate a macOS Seatbelt profile string for the given config.
///
/// On macOS, the caller wraps the command with `sandbox-exec -p '<profile>'`
/// rather than using `pre_exec`.
#[cfg(target_os = "macos")]
pub fn seatbelt_profile(config: &SandboxConfig) -> Result<String, String> {
    macos::generate_seatbelt_profile(config)
}

/// Check whether the current kernel supports Landlock.
///
/// Returns the Landlock ABI version (≥ 1) if supported, or 0 if not.
#[cfg(target_os = "linux")]
pub fn landlock_abi_version() -> u32 {
    linux::landlock_create_ruleset_version()
}

/// Check whether sandboxing is available on this platform.
pub fn is_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        landlock_abi_version() > 0
    }

    #[cfg(target_os = "macos")]
    {
        // sandbox-exec ships with macOS
        true
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_mode_parses() {
        assert_eq!(
            "read-only".parse::<SandboxMode>().unwrap(),
            SandboxMode::Readonly
        );
        assert_eq!(
            "workspace-write".parse::<SandboxMode>().unwrap(),
            SandboxMode::WorkspaceWrite
        );
        assert_eq!(
            "none".parse::<SandboxMode>().unwrap(),
            SandboxMode::FullAccess
        );
        assert_eq!(
            "off".parse::<SandboxMode>().unwrap(),
            SandboxMode::FullAccess
        );
    }

    #[test]
    fn sandbox_mode_display() {
        assert_eq!(SandboxMode::Readonly.to_string(), "read-only");
        assert_eq!(SandboxMode::WorkspaceWrite.to_string(), "workspace-write");
        assert_eq!(SandboxMode::FullAccess.to_string(), "full-access");
    }

    #[test]
    fn full_access_is_not_sandboxed() {
        assert!(!SandboxMode::FullAccess.is_sandboxed());
        assert!(SandboxMode::Readonly.is_sandboxed());
        assert!(SandboxMode::WorkspaceWrite.is_sandboxed());
    }

    #[test]
    fn readonly_denies_all_egress_by_default() {
        let config = SandboxConfig::new(SandboxMode::Readonly, None);
        let policy = config.effective_egress();
        assert!(!policy.permits(443));
        assert!(!policy.permits(53));
        assert_eq!(policy.allowed_ports(), Some(vec![]));
    }

    #[test]
    fn workspace_write_allows_web_ports_by_default() {
        let config = SandboxConfig::new(SandboxMode::WorkspaceWrite, None);
        let policy = config.effective_egress();
        assert!(policy.permits(443));
        assert!(policy.permits(53));
        assert!(
            !policy.permits(6667),
            "IRC should not be allowed by default"
        );
    }

    #[test]
    fn explicit_egress_overrides_mode_default() {
        let config = SandboxConfig::new(SandboxMode::WorkspaceWrite, None)
            .with_egress(NetworkPolicy::allow_ports(&[443]));
        let policy = config.effective_egress();
        assert!(policy.permits(443));
        assert!(!policy.permits(80), "explicit policy replaces the default");
    }

    #[test]
    fn deny_rules_override_allow() {
        let policy = NetworkPolicy {
            default_action: EgressDefault::Allow,
            rules: vec![EgressRule::allow_any(), EgressRule::deny_port(6667)],
        };
        assert!(policy.permits(443));
        assert!(!policy.permits(6667));
    }

    #[test]
    fn allow_ports_enumerates() {
        let policy = NetworkPolicy::allow_ports(&[443, 80, 443]);
        assert_eq!(policy.allowed_ports(), Some(vec![80, 443]));
    }

    #[test]
    fn full_access_allows_all_egress_by_default() {
        let config = SandboxConfig::new(SandboxMode::FullAccess, None);
        let policy = config.effective_egress();
        assert!(policy.permits(6667));
        assert_eq!(policy.allowed_ports(), None);
    }

    #[test]
    fn writable_paths_includes_working_dir_and_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        let config =
            SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(tmp.path().to_path_buf()));
        let paths = config.writable_paths();
        assert!(paths.contains(&tmp.path().to_path_buf()));
    }
}
