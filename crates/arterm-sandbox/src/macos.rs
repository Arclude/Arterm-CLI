//! macOS Seatbelt sandbox profile generation.
//!
//! macOS uses the `sandbox-exec` tool to apply Seatbelt policies. Unlike
//! Linux's Landlock (which is applied in-process via syscalls), Seatbelt
//! requires wrapping the command with `sandbox-exec -p '<profile>'`.

use crate::{SandboxConfig, SandboxMode};

/// Generate a Seatbelt profile string for the given sandbox config.
///
/// The profile is passed to `sandbox-exec -p '<profile>' -- <command>`.
pub fn generate_seatbelt_profile(config: &SandboxConfig) -> Result<String, String> {
    match config.mode {
        SandboxMode::FullAccess => {
            return Ok(String::new());
        }
        SandboxMode::Readonly => Ok(readonly_profile(config)),
        SandboxMode::WorkspaceWrite => Ok(workspace_write_profile(config)),
    }
}

fn readonly_profile(config: &SandboxConfig) -> String {
    let mut profile = String::new();
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n");

    // Allow reading from common paths
    profile.push_str("(allow process-fork)\n");
    profile.push_str("(allow process-exec (subpath \"/usr\"))\n");
    profile.push_str("(allow process-exec (subpath \"/bin\"))\n");
    profile.push_str("(allow signal (target self))\n");

    // File system: read-only everywhere
    profile.push_str("(allow file-read* (subpath \"/\"))\n");

    // Allow reading from working directory
    if let Some(ref wd) = config.working_dir {
        let wd_str = wd.to_string_lossy();
        profile.push_str(&format!(
            "(allow file-read* (subpath \"{wd_str}\"))\n"
        ));
    }

    // Deny all writes
    profile.push_str("(deny file-write*)\n");

    // Allow temp directory access for subprocess pipes (read-only)
    let tmp = std::env::temp_dir().to_string_lossy().to_string();
    profile.push_str(&format!(
        "(allow file-read* (subpath \"{tmp}\"))\n"
    ));

    // Deny network
    profile.push_str("(deny network*)\n");

    profile
}

fn workspace_write_profile(config: &SandboxConfig) -> String {
    let mut profile = String::new();
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n");

    // Allow process operations
    profile.push_str("(allow process-fork)\n");
    profile.push_str("(allow process-exec (subpath \"/usr\"))\n");
    profile.push_str("(allow process-exec (subpath \"/bin\"))\n");
    profile.push_str("(allow signal (target self))\n");

    // Read from everywhere
    profile.push_str("(allow file-read* (subpath \"/\"))\n");

    // Write to working directory
    if let Some(ref wd) = config.working_dir {
        let wd_str = wd.to_string_lossy();
        profile.push_str(&format!(
            "(allow file-write* (subpath \"{wd_str}\"))\n"
        ));
    }

    // Write to temp directories
    let tmp = std::env::temp_dir().to_string_lossy().to_string();
    profile.push_str(&format!(
        "(allow file-write* (subpath \"{tmp}\"))\n"
    ));

    // Write to scratch dir
    if let Some(ref scratch) = std::env::var_os("ARTERM_SCRATCH_DIR") {
        let s = scratch.to_string_lossy();
        profile.push_str(&format!(
            "(allow file-write* (subpath \"{s}\"))\n"
        ));
    }

    // Write to extra writable roots
    for root in &config.writable_roots {
        let r = root.to_string_lossy();
        profile.push_str(&format!(
            "(allow file-write* (subpath \"{r}\"))\n"
        ));
    }

    // Allow network (localhost and outbound)
    profile.push_str("(allow network*)\n");

    profile
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SandboxConfig;
    use std::path::PathBuf;

    #[test]
    fn readonly_profile_denies_writes() {
        let config = SandboxConfig::new(SandboxMode::Readonly, Some(PathBuf::from("/tmp/test")));
        let profile = generate_seatbelt_profile(&config).unwrap();
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn workspace_write_allows_working_dir() {
        let config =
            SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(PathBuf::from("/tmp/test")));
        let profile = generate_seatbelt_profile(&config).unwrap();
        assert!(profile.contains("/tmp/test"));
        assert!(profile.contains("file-write*"));
    }
}
