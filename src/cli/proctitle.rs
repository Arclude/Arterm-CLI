//! Mapping from parsed CLI arguments to an initial process title.
//!
//! This logic depends on the clap `Args`/`Command` types defined in `cli`, so
//! it lives in the CLI layer. The low-level title-setting primitives it uses
//! (`compact_process_title`, `session_name`, `set_title`) live in the
//! `process_title` core module.

use crate::cli::args::{AmbientCommand, Args, Command};
use crate::process_title::{compact_process_title, session_name, set_title};

pub(crate) fn initial_title(args: &Args) -> String {
    match &args.command {
        Some(Command::Serve { .. }) => "arterm:server".to_string(),
        Some(Command::Acp) => "arterm acp".to_string(),
        Some(Command::Server { .. }) => "arterm server".to_string(),
        Some(Command::Connect) => "arterm:client".to_string(),
        #[cfg(unix)]
        Some(Command::ApiBridge { .. }) => "arterm api-bridge".to_string(),
        Some(Command::Run { .. }) => "arterm run".to_string(),
        Some(Command::Login { .. }) => "arterm login".to_string(),
        Some(Command::Account { .. }) => "arterm account".to_string(),
        Some(Command::Repl) => "arterm repl".to_string(),
        Some(Command::Update) => "arterm update".to_string(),
        Some(Command::Version { .. }) => "arterm version".to_string(),
        Some(Command::Usage { .. }) => "arterm usage".to_string(),
        Some(Command::SelfDev { .. }) => "arterm:selfdev".to_string(),
        Some(Command::Debug { .. }) => "arterm debug".to_string(),
        Some(Command::Auth(_)) => "arterm auth".to_string(),
        Some(Command::Provider(_)) => "arterm provider".to_string(),
        Some(Command::Memory(_)) => "arterm memory".to_string(),
        Some(Command::Session(_)) => "arterm session".to_string(),
        Some(Command::Ambient(subcommand)) => match subcommand {
            AmbientCommand::RunVisible => "arterm ambient visible".to_string(),
            _ => "arterm ambient".to_string(),
        },
        Some(Command::Cloud(_)) => "arterm cloud".to_string(),
        Some(Command::Pair { .. }) => "arterm pair".to_string(),
        Some(Command::Permissions) => "arterm permissions".to_string(),
        Some(Command::Transcript { .. }) => "arterm transcript".to_string(),
        Some(Command::Dictate { .. }) => "arterm dictate".to_string(),
        Some(Command::SetupHotkey {
            listen_macos_hotkey,
            notify_cli_launch,
            listen_windows_hotkey,
            uninstall,
        }) => {
            if *listen_macos_hotkey || *listen_windows_hotkey {
                "arterm hotkey listener".to_string()
            } else if notify_cli_launch.is_some() {
                "arterm shortcut reminder".to_string()
            } else if *uninstall {
                "arterm hotkey uninstall".to_string()
            } else {
                "arterm hotkey setup".to_string()
            }
        }
        Some(Command::Browser { .. }) => "arterm browser".to_string(),
        Some(Command::Replay { .. }) => "arterm replay".to_string(),
        Some(Command::Model(_)) => "arterm model".to_string(),
        Some(Command::ProviderTestCoverage { .. }) => "arterm provider-test-coverage".to_string(),
        Some(Command::ProviderDoctor { .. }) => "arterm provider-doctor".to_string(),
        Some(Command::AuthTest { .. }) => "arterm auth-test".to_string(),
        Some(Command::Restart { .. }) => "arterm restart".to_string(),
        Some(Command::Menubar { .. }) => "arterm menubar".to_string(),
        Some(Command::SetupLauncher) => "arterm setup-launcher".to_string(),
        None => {
            if let Some(resume) = args.resume.as_deref().filter(|resume| !resume.is_empty()) {
                let prefix = if crate::cli::selfdev::client_selfdev_requested() {
                    "arterm:d:"
                } else {
                    "arterm:c:"
                };
                compact_process_title(prefix, Some(&session_name(resume)))
            } else if crate::cli::selfdev::client_selfdev_requested() {
                "arterm:selfdev".to_string()
            } else {
                "arterm:client".to_string()
            }
        }
    }
}

pub(crate) fn set_initial_title(args: &Args) {
    set_title(initial_title(args));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::lock_test_env;
    use clap::Parser;

    const SELFDEV_ENV: &str = arterm_selfdev_types::CLIENT_SELFDEV_ENV;

    fn with_selfdev_env_removed<T>(f: impl FnOnce() -> T) -> T {
        let _guard = lock_test_env();
        let previous = std::env::var_os(SELFDEV_ENV);
        crate::env::remove_var(SELFDEV_ENV);
        let result = f();
        if let Some(value) = previous {
            crate::env::set_var(SELFDEV_ENV, value);
        }
        result
    }

    #[test]
    fn initial_title_labels_server() {
        with_selfdev_env_removed(|| {
            let args = Args::parse_from(["arterm", "serve"]);
            assert_eq!(initial_title(&args), "arterm:server");
        });
    }

    #[test]
    fn initial_title_labels_resume_client_with_short_name() {
        with_selfdev_env_removed(|| {
            let args = Args::parse_from(["arterm", "--resume", "session_fox_123"]);
            assert_eq!(initial_title(&args), "arterm:c:fox");
        });
    }

    #[test]
    fn initial_title_labels_selfdev_command() {
        with_selfdev_env_removed(|| {
            let args = Args::parse_from(["arterm", "self-dev"]);
            assert_eq!(initial_title(&args), "arterm:selfdev");
        });
    }

    #[test]
    fn initial_title_labels_windows_hotkey_listener() {
        let args = Args::parse_from(["arterm", "setup-hotkey", "--listen-windows-hotkey"]);
        assert_eq!(initial_title(&args), "arterm hotkey listener");
    }

    #[test]
    fn initial_title_labels_hotkey_uninstall() {
        let args = Args::parse_from(["arterm", "setup-hotkey", "--uninstall"]);
        assert_eq!(initial_title(&args), "arterm hotkey uninstall");
    }
}
