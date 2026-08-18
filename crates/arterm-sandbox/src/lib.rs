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

    #[cfg(not(target_os = "linux"))]
    {
        let _ = config;
        Ok(SandboxResult::skipped(no_sandbox_here()))
    }
}

/// Why this platform restricts nothing from a `pre_exec` hook.
///
/// macOS is called out separately because it is the one that used to claim
/// otherwise. This branch built a Seatbelt profile string here and reported
/// `applied(...)` for having built it -- but `apply` runs after `fork`, and
/// Seatbelt is applied by wrapping the command with `sandbox-exec` when it is
/// *spawned*, which no production code does. There is no "restrict the calling
/// process" syscall to reach for the way `landlock_restrict_self` is reached
/// for on Linux. So every sandboxed macOS session ran unrestricted while
/// reporting a sandbox, in the one field callers read to decide whether to
/// warn -- there was not even a line of output to notice it by.
/// `macos::generate_seatbelt_profile` stays as the policy a future wrapper
/// needs; what it does not stay as is an answer to this question.
#[cfg(not(target_os = "linux"))]
fn no_sandbox_here() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Seatbelt applies by wrapping the command with sandbox-exec, which this process does not do yet"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "sandbox not supported on this platform"
    }
}

// ─── platform modules ────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux;

// Not gated on the target: the profile is a string, built from paths and a
// mode, with nothing macOS-specific in the building of it. Compiled everywhere
// so that its tests -- above all the one that pastes a hostile path into it --
// run on every platform CI builds, instead of only on the one job that could
// not catch the bug before it shipped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
        // `sandbox-exec` ships with macOS, but shipping is not the question
        // this answers: nothing here runs it, so no command this crate helps
        // spawn is restricted. Claiming availability would put the same lie
        // `apply` used to tell behind a second name.
        false
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    /// The floor clamps with `min`, so the variant order *is* the policy.
    ///
    /// Nothing else in the code says out loud that read-only grants less than
    /// workspace-write, which grants less than full-access. Reorder the enum and
    /// every clamp silently reverses -- a floor of workspace-write would start
    /// permitting full-access -- while every existing test still passes, because
    /// they all name modes rather than compare them.
    #[test]
    fn mode_order_is_strictest_first() {
        use super::SandboxMode::*;
        assert!(Readonly < WorkspaceWrite);
        assert!(WorkspaceWrite < FullAccess);
        assert_eq!(FullAccess.strictest(WorkspaceWrite), WorkspaceWrite);
        assert_eq!(WorkspaceWrite.strictest(Readonly), Readonly);
        assert_eq!(FullAccess.strictest(FullAccess), FullAccess);
    }

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
