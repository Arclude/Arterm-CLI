//! macOS Seatbelt sandbox profile generation.
//!
//! macOS uses the `sandbox-exec` tool to apply Seatbelt policies. Unlike
//! Linux's Landlock (which is applied in-process via syscalls), Seatbelt
//! requires wrapping the command with `sandbox-exec -p '<profile>'`.
//!
//! **Nothing runs that wrapper yet.** [`crate::apply`] reports `skipped` on
//! macOS for exactly this reason, so what is below is the policy a future
//! wrapper will hand to `sandbox-exec` rather than a policy in force. It is
//! kept honest anyway -- see [`quote`] -- because a hole left in an unused
//! profile becomes a hole the day someone wires it up, and the wiring is the
//! part that looks finished.

use crate::{SandboxConfig, SandboxMode};

/// One path as a Seatbelt string literal, with the two characters that end a
/// literal escaped.
///
/// The profile is an S-expression, and a path is pasted into it between double
/// quotes. A path containing a quote therefore closes the literal early and
/// everything after it is read as profile source: a working directory named
///
/// ```text
/// /tmp/x")(allow file-write* (subpath "/
/// ```
///
/// would have appended a rule granting the whole filesystem. Working
/// directories are not a trusted input here -- a session's is chosen by
/// whoever starts it, including the model -- so the profile has to survive
/// one. Backslash is escaped first, or escaping the quote would be undone by
/// the reader treating our own backslash as the escape's subject.
fn quote(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// Generate a Seatbelt profile string for the given sandbox config.
///
/// The profile is passed to `sandbox-exec -p '<profile>' -- <command>`.
pub fn generate_seatbelt_profile(config: &SandboxConfig) -> Result<String, String> {
    match config.mode {
        SandboxMode::FullAccess => Ok(String::new()),
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
        profile.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", quote(wd)));
    }

    // Deny all writes
    profile.push_str("(deny file-write*)\n");

    // Allow temp directory access for subprocess pipes (read-only)
    let tmp = quote(&std::env::temp_dir());
    profile.push_str(&format!("(allow file-read* (subpath \"{tmp}\"))\n"));

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
        profile.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            quote(wd)
        ));
    }

    // Write to temp directories
    let tmp = quote(&std::env::temp_dir());
    profile.push_str(&format!("(allow file-write* (subpath \"{tmp}\"))\n"));

    // Write to scratch dir
    if let Some(ref scratch) = std::env::var_os("ARTERM_SCRATCH_DIR") {
        let s = quote(std::path::Path::new(scratch));
        profile.push_str(&format!("(allow file-write* (subpath \"{s}\"))\n"));
    }

    // Write to extra writable roots
    for root in &config.writable_roots {
        let r = quote(root);
        profile.push_str(&format!("(allow file-write* (subpath \"{r}\"))\n"));
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
        let config = SandboxConfig::new(
            SandboxMode::WorkspaceWrite,
            Some(PathBuf::from("/tmp/test")),
        );
        let profile = generate_seatbelt_profile(&config).unwrap();
        assert!(profile.contains("/tmp/test"));
        assert!(profile.contains("file-write*"));
    }

    /// How many quotes on this line actually delimit a string literal.
    ///
    /// Escaped ones do not, so they are removed first -- and `\\` is removed
    /// before `\"` so that a literal backslash at the end of a path cannot be
    /// mistaken for the escape of the quote that closes it.
    fn delimiting_quotes(line: &str) -> usize {
        line.replace("\\\\", "")
            .replace("\\\"", "")
            .matches('"')
            .count()
    }

    /// A path is data, and must not be able to become policy.
    ///
    /// The profile is an S-expression and paths are pasted into it between
    /// quotes, so before `quote` a working directory could close its own
    /// literal and append rules of its own. This one tries to grant itself the
    /// filesystem; the profile must come back with it still inside the string
    /// it was placed in.
    #[test]
    fn a_hostile_working_directory_cannot_add_rules_to_the_profile() {
        let hostile = PathBuf::from("/tmp/x\")(allow file-write* (subpath \"/");
        let config = SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(hostile));
        let profile = generate_seatbelt_profile(&config).unwrap();

        for line in profile.lines() {
            assert_eq!(
                delimiting_quotes(line) % 2,
                0,
                "an odd number of delimiting quotes means a path escaped its literal: {line}"
            );
        }

        let workspace_rule = profile
            .lines()
            .find(|line| line.contains("/tmp/x"))
            .expect("the working directory should still appear in the profile");
        assert_eq!(
            delimiting_quotes(workspace_rule),
            2,
            "the whole path belongs in one literal, not spread across new rules: {workspace_rule}"
        );
    }

    /// The same, for the character that escapes the escape.
    ///
    /// A path ending in a backslash would otherwise escape the quote meant to
    /// close it, which swallows the rest of the profile rather than adding to
    /// it -- a different failure, and just as much a way out of the literal.
    #[test]
    fn a_backslash_in_a_path_does_not_escape_the_quote_that_closes_it() {
        let config = SandboxConfig::new(
            SandboxMode::WorkspaceWrite,
            Some(PathBuf::from("/tmp/ends-in-a-backslash\\")),
        );
        let profile = generate_seatbelt_profile(&config).unwrap();

        let workspace_rule = profile
            .lines()
            .find(|line| line.contains("ends-in-a-backslash"))
            .expect("the working directory should still appear in the profile");
        assert_eq!(delimiting_quotes(workspace_rule), 2, "{workspace_rule}");
        assert!(
            workspace_rule.contains("ends-in-a-backslash\\\\"),
            "the backslash should survive as a backslash: {workspace_rule}"
        );
    }

    /// A configured root is a path too, and reaches the profile by its own way in.
    #[test]
    fn a_hostile_configured_root_cannot_add_rules_either() {
        let config = SandboxConfig::new(
            SandboxMode::WorkspaceWrite,
            Some(PathBuf::from("/tmp/workspace")),
        )
        .with_writable_roots(vec![PathBuf::from("/tmp/r\")(allow network* ;")]);
        let profile = generate_seatbelt_profile(&config).unwrap();

        for line in profile.lines() {
            assert_eq!(delimiting_quotes(line) % 2, 0, "{line}");
        }
    }
}
