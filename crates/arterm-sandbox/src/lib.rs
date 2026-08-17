//! OS-level sandboxing for command execution.
//!
//! Provides filesystem access restriction via:
//! - **Linux**: Landlock LSM (kernel ≥ 5.13) via raw syscalls
//! - **macOS**: Seatbelt (`sandbox-exec`) via profile generation
//! - **Other platforms**: No-op (returns success with a notice)
//!
//! # Sandbox modes
//!
//! - `Readonly`: No filesystem writes, no network
//! - `WorkspaceWrite`: Write only to the working directory + temp dirs
//! - `FullAccess`: No restrictions (equivalent to no sandbox)
//!
//! # Usage
//!
//! The caller applies the sandbox in a `pre_exec` hook on the child process.
//! On Linux this restricts the child (and all its descendants) via Landlock.
//! On macOS the caller should wrap the command with `sandbox-exec`.

#![cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]

use std::path::PathBuf;

/// The sandbox policy to enforce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    /// No filesystem writes, no network access. Read-only exploration.
    Readonly,
    /// Write access to the working directory and temp directories only.
    /// Network access allowed for localhost.
    WorkspaceWrite,
    /// No sandbox restrictions. Equivalent to running without a sandbox.
    FullAccess,
}

impl SandboxMode {
    pub fn is_sandboxed(self) -> bool {
        !matches!(self, SandboxMode::FullAccess)
    }
}

impl std::fmt::Display for SandboxMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxMode::Readonly => write!(f, "read-only"),
            SandboxMode::WorkspaceWrite => write!(f, "workspace-write"),
            SandboxMode::FullAccess => write!(f, "full-access"),
        }
    }
}

impl std::str::FromStr for SandboxMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "read-only" | "readonly" => Ok(SandboxMode::Readonly),
            "workspace-write" | "workspace" => Ok(SandboxMode::WorkspaceWrite),
            "full-access" | "full" | "none" | "off" => Ok(SandboxMode::FullAccess),
            _ => Err(format!(
                "unknown sandbox mode '{s}'; expected read-only, workspace-write, or full-access"
            )),
        }
    }
}

/// Configuration for applying a sandbox to a child process.
#[derive(Debug, Clone)]
pub struct SandboxConfig {
    pub mode: SandboxMode,
    /// The working directory the tool is executing in.
    pub working_dir: Option<PathBuf>,
    /// Extra directories that should be writable (e.g. cargo registry, cache).
    pub writable_roots: Vec<PathBuf>,
}

impl SandboxConfig {
    pub fn new(mode: SandboxMode, working_dir: Option<PathBuf>) -> Self {
        Self {
            mode,
            working_dir,
            writable_roots: Vec::new(),
        }
    }

    pub fn with_writable_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.writable_roots = roots;
        self
    }

    /// Collect all directories that should be writable in WorkspaceWrite mode.
    fn writable_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::new();

        // Working directory and all ancestors up to root (for traversal)
        if let Some(ref wd) = self.working_dir {
            paths.push(wd.clone());
        }

        // System temp directories
        if let Some(tmp) = std::env::temp_dir().to_str() {
            paths.push(PathBuf::from(tmp));
        }

        // Tool scratch directory
        if let Some(ref scratch) = std::env::var_os("ARTERM_SCRATCH_DIR") {
            paths.push(PathBuf::from(scratch));
        }

        // User-configured writable roots
        paths.extend(self.writable_roots.iter().cloned());

        paths
    }
}

/// The result of attempting to apply a sandbox.
#[derive(Debug)]
pub struct SandboxResult {
    /// Whether the sandbox was successfully applied.
    pub applied: bool,
    /// A human-readable description of what happened, for diagnostics.
    pub message: String,
}

impl SandboxResult {
    fn applied(msg: impl Into<String>) -> Self {
        Self {
            applied: true,
            message: msg.into(),
        }
    }

    fn skipped(msg: impl Into<String>) -> Self {
        Self {
            applied: false,
            message: msg.into(),
        }
    }
}

// ─── platform modules ────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
mod macos;

/// Apply the sandbox. This must be called from a `pre_exec` hook on the child
/// process, after `fork()` but before `exec()`.
///
/// On platforms without sandbox support, this is a no-op that logs a notice.
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
    fn writable_paths_includes_working_dir_and_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        let config =
            SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(tmp.path().to_path_buf()));
        let paths = config.writable_paths();
        assert!(paths.contains(&tmp.path().to_path_buf()));
    }

    #[test]
    fn full_access_returns_skipped() {
        let config = SandboxConfig::new(SandboxMode::FullAccess, None);
        let result = apply(&config).unwrap();
        assert!(!result.applied);
    }
}
