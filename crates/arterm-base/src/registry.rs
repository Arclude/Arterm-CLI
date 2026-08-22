#![cfg_attr(test, allow(clippy::await_holding_lock))]

//! Server registry for multi-server architecture
//!
//! Tracks running servers in `~/.arterm/servers.json` for discovery by clients.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

use crate::storage::arterm_dir;

pub use crate::registry_host::ServerHost;

/// Information about a running server
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerInfo {
    /// Full server ID (e.g., "server_blazing_1705012345678")
    pub id: String,
    /// Short name (e.g., "blazing")
    pub name: String,
    /// Icon for display (e.g., "🔥")
    pub icon: String,
    /// Socket path
    pub socket: PathBuf,
    /// Debug socket path
    pub debug_socket: PathBuf,
    /// Git hash of the binary
    pub git_hash: String,
    /// Version string (e.g., "v0.1.123")
    pub version: String,
    /// Process ID
    pub pid: u32,
    /// When the server started (ISO 8601)
    pub started_at: String,
    /// Session names currently on this server
    #[serde(default)]
    pub sessions: Vec<String>,
    /// Which machine this server runs on.
    ///
    /// Absent in `servers.json` written before cross-machine sessions, so it
    /// defaults to [`ServerHost::Local`] and old files still load unchanged.
    #[serde(default)]
    pub host: ServerHost,
}

impl ServerInfo {
    /// Display name with icon (e.g., "🔥 blazing")
    pub fn display_name(&self) -> String {
        format!("{} {}", self.icon, self.name)
    }
}

/// The server registry file
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServerRegistry {
    /// Map from server name to server info
    #[serde(flatten)]
    pub servers: HashMap<String, ServerInfo>,
}

impl ServerRegistry {
    /// Load the registry from disk
    pub async fn load() -> Result<Self> {
        let path = registry_path()?;
        if !path.exists() {
            return Ok(Self::default());
        }

        let content = fs::read_to_string(&path).await?;
        let registry: Self = serde_json::from_str(&content)?;
        Ok(registry)
    }

    /// Load the registry synchronously, for callers with no async runtime
    /// (e.g. the `arterm device` CLI, which is sync end to end).
    ///
    /// Unlike [`Self::load`] this does no stale-entry cleanup: it reports the
    /// registry exactly as written. A missing file is an empty registry.
    pub fn load_sync() -> Result<Self> {
        let path = registry_path()?;
        match std::fs::read_to_string(&path) {
            Ok(content) => Ok(serde_json::from_str(&content)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Save the registry to disk
    pub async fn save(&self) -> Result<()> {
        let path = registry_path()?;

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
            if let Err(e) = crate::platform::set_directory_permissions_owner_only(parent) {
                crate::logging::info(&format!(
                    "Registry save: failed to harden directory permissions for {}: {}",
                    parent.display(),
                    e
                ));
            }
        }

        let content = serde_json::to_string_pretty(self)?;
        fs::write(&path, content).await?;
        if let Err(e) = crate::platform::set_permissions_owner_only(&path) {
            crate::logging::info(&format!(
                "Registry save: failed to harden file permissions for {}: {}",
                path.display(),
                e
            ));
        }
        Ok(())
    }

    /// Register a server
    pub fn register(&mut self, mut info: ServerInfo) {
        // A re-register of the same server (startup race, self-dev reload)
        // must not drop the session ownership recorded against it — the
        // incoming info carries an empty list by construction.
        if let Some(existing) = self.servers.get(&info.name) {
            info.sessions = existing.sessions.clone();
        }
        self.servers.insert(info.name.clone(), info);
    }

    /// Unregister a server by name
    pub fn unregister(&mut self, name: &str) {
        self.servers.remove(name);
    }

    /// Find a server by name
    pub fn find_by_name(&self, name: &str) -> Option<&ServerInfo> {
        self.servers.get(name)
    }

    /// Get all servers sorted by started_at (newest first)
    pub fn servers_by_time(&self) -> Vec<&ServerInfo> {
        let mut servers: Vec<_> = self.servers.values().collect();
        servers.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        servers
    }

    /// Clean up stale entries (servers that are no longer running or have been superseded).
    ///
    /// Socket path ownership is managed by the server process itself. Registry
    /// cleanup must not unlink those paths because a new live server can reuse
    /// the same published socket after a reboot or reload while an older
    /// registry entry still references it.
    pub async fn cleanup_stale(&mut self) -> Result<Vec<String>> {
        let mut removed = Vec::new();

        // First pass: remove entries whose process is dead
        let names: Vec<_> = self.servers.keys().cloned().collect();
        for name in &names {
            if let Some(info) = self.servers.get(name) {
                let pid = info.pid;
                if !is_process_running(pid) {
                    removed.push(name.clone());
                    self.servers.remove(name);
                }
            }
        }

        // Second pass: if multiple entries share the same socket path (happens
        // after server exec/reload), keep only the newest one.
        let remaining: Vec<_> = self.servers.keys().cloned().collect();
        let mut socket_to_newest: std::collections::HashMap<PathBuf, (String, String)> =
            std::collections::HashMap::new();
        for name in &remaining {
            if let Some(info) = self.servers.get(name) {
                let entry = socket_to_newest
                    .entry(info.socket.clone())
                    .or_insert_with(|| (name.clone(), info.started_at.clone()));
                if info.started_at > entry.1 {
                    *entry = (name.clone(), info.started_at.clone());
                }
            }
        }
        for name in &remaining {
            if let Some(info) = self.servers.get(name)
                && let Some((newest_name, _)) = socket_to_newest.get(&info.socket)
                && newest_name != name
            {
                removed.push(name.clone());
                self.servers.remove(name);
            }
        }

        if !removed.is_empty() {
            self.save().await?;
        }

        Ok(removed)
    }

    /// Add a session to a server
    pub fn add_session(&mut self, server_name: &str, session_name: &str) {
        if let Some(info) = self.servers.get_mut(server_name)
            && !info.sessions.contains(&session_name.to_string())
        {
            info.sessions.push(session_name.to_string());
        }
    }

    /// Remove a session from a server
    pub fn remove_session(&mut self, server_name: &str, session_name: &str) {
        if let Some(info) = self.servers.get_mut(server_name) {
            info.sessions.retain(|s| s != session_name);
        }
    }
}

/// Get the path to the registry file
pub fn registry_path() -> Result<PathBuf> {
    Ok(arterm_dir()?.join("servers.json"))
}

/// Get the socket directory path
pub fn socket_dir() -> Result<PathBuf> {
    Ok(crate::storage::runtime_dir().join("arterm"))
}

/// Get the socket path for a named server
pub fn server_socket_path(name: &str) -> PathBuf {
    socket_dir()
        .map(|d| d.join(format!("{}.sock", name)))
        .unwrap_or_else(|_| std::env::temp_dir().join(format!("arterm-{}.sock", name)))
}

/// Get the debug socket path for a named server
pub fn server_debug_socket_path(name: &str) -> PathBuf {
    socket_dir()
        .map(|d| d.join(format!("{}-debug.sock", name)))
        .unwrap_or_else(|_| std::env::temp_dir().join(format!("arterm-{}-debug.sock", name)))
}

/// Check if a process is still running
fn is_process_running(pid: u32) -> bool {
    crate::platform::is_process_running(pid)
}

/// Unregister a server from the registry
pub async fn unregister_server(name: &str) -> Result<()> {
    let mut registry = ServerRegistry::load().await?;
    registry.unregister(name);
    registry.save().await?;
    Ok(())
}

/// Record that a session is owned by this server, so the session picker (and
/// `arterm device sessions`) can attach the session to its server instead of
/// filing it under orphaned "sessions".
///
/// The registry key is the session's short name (e.g. `fox`), matching what
/// [`ServerRegistry::add_session`] documents and what the picker matches on.
/// Best-effort: a registry write failure logs and continues rather than
/// failing the session that owns it.
pub async fn register_session_on_server(server_name: &str, session_name: &str) {
    let mut registry = match ServerRegistry::load().await {
        Ok(registry) => registry,
        Err(error) => {
            crate::logging::warn(&format!(
                "failed to load server registry to record session {session_name}: {error}"
            ));
            return;
        }
    };
    registry.add_session(server_name, session_name);
    if let Err(error) = registry.save().await {
        crate::logging::warn(&format!(
            "failed to save server registry after recording session {session_name}: {error}"
        ));
    }
}

/// Remove a session's ownership record from its server. Best-effort for the
/// same reasons as [`register_session_on_server`].
pub async fn unregister_session_from_server(server_name: &str, session_name: &str) {
    let mut registry = match ServerRegistry::load().await {
        Ok(registry) => registry,
        Err(error) => {
            crate::logging::warn(&format!(
                "failed to load server registry to drop session {session_name}: {error}"
            ));
            return;
        }
    };
    registry.remove_session(server_name, session_name);
    if let Err(error) = registry.save().await {
        crate::logging::warn(&format!(
            "failed to save server registry after dropping session {session_name}: {error}"
        ));
    }
}

/// List all running servers
pub async fn list_servers() -> Result<Vec<ServerInfo>> {
    let mut registry = ServerRegistry::load().await?;
    registry.cleanup_stale().await?;
    Ok(registry.servers_by_time().into_iter().cloned().collect())
}

/// Live local servers, newest first, read synchronously.
///
/// For sync callers (the `arterm device` CLI) that want the same "only servers
/// whose process is still alive" view [`list_servers`] gives, without an async
/// runtime and without rewriting `servers.json` as a side effect.
pub fn running_local_servers_sync() -> Result<Vec<ServerInfo>> {
    let registry = ServerRegistry::load_sync()?;
    let mut servers: Vec<ServerInfo> = registry
        .servers
        .into_values()
        .filter(|info| is_process_running(info.pid))
        .collect();
    servers.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(servers)
}

/// Best-effort sync lookup for a server by socket path.
///
/// This is used by client-side window title code before the async runtime is fully
/// established or in synchronous spawn helpers.
pub fn find_server_by_socket_sync(socket: &std::path::Path) -> Option<ServerInfo> {
    let path = registry_path().ok()?;
    let content = std::fs::read_to_string(path).ok()?;
    let registry: ServerRegistry = serde_json::from_str(&content).ok()?;
    registry
        .servers
        .values()
        .find(|info| info.socket == socket)
        .cloned()
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod registry_tests;
