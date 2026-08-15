use super::*;
use crate::storage::lock_test_env;
#[cfg(unix)]
use crate::transport::Listener;
use std::ffi::OsString;

fn test_server_info(name: &str) -> ServerInfo {
    ServerInfo {
        id: format!("server_{}_123", name),
        name: name.to_string(),
        icon: "🔥".to_string(),
        socket: PathBuf::from(format!("/tmp/{}.sock", name)),
        debug_socket: PathBuf::from(format!("/tmp/{}-debug.sock", name)),
        git_hash: "abc1234".to_string(),
        version: "v0.1.123".to_string(),
        pid: std::process::id(),
        started_at: "2025-01-01T00:00:00Z".to_string(),
        sessions: Vec::new(),
        host: ServerHost::Local,
    }
}

#[test]
fn test_server_info_display_name() {
    let info = test_server_info("blazing");
    assert_eq!(info.display_name(), "🔥 blazing");
}

#[test]
fn old_servers_json_without_host_deserializes_as_local() {
    // A registry entry written before cross-machine sessions carries no `host`
    // key at all. It must still load, defaulting to a local server, or every
    // pre-upgrade `servers.json` would fail to parse.
    let old_format = r#"{
        "blazing": {
            "id": "server_blazing_123",
            "name": "blazing",
            "icon": "🔥",
            "socket": "/tmp/blazing.sock",
            "debug_socket": "/tmp/blazing-debug.sock",
            "git_hash": "abc1234",
            "version": "v0.1.123",
            "pid": 4242,
            "started_at": "2025-01-01T00:00:00Z",
            "sessions": ["fix-tests"]
        }
    }"#;

    let registry: ServerRegistry =
        serde_json::from_str(old_format).expect("old-format servers.json must still load");
    let info = registry
        .find_by_name("blazing")
        .expect("server present after loading old format");
    assert_eq!(info.host, ServerHost::Local);
    assert!(info.host.is_local());
    assert_eq!(info.sessions, vec!["fix-tests".to_string()]);
}

#[test]
fn remote_host_survives_a_registry_round_trip() {
    let mut registry = ServerRegistry::default();
    let mut info = test_server_info("windows-box");
    info.host = ServerHost::remote("deadbeef", Some("192.168.1.42:7420".to_string()));
    registry.register(info);

    let encoded = serde_json::to_string(&registry).expect("serialize registry");
    let decoded: ServerRegistry = serde_json::from_str(&encoded).expect("deserialize registry");
    let host = &decoded
        .find_by_name("windows-box")
        .expect("server present after round trip")
        .host;
    assert_eq!(host.fingerprint(), Some("deadbeef"));
    assert_eq!(host.address(), Some("192.168.1.42:7420"));
}

#[test]
fn test_registry_find_by_name() {
    let mut registry = ServerRegistry::default();
    let info = test_server_info("blazing");
    registry.register(info);

    assert!(registry.find_by_name("blazing").is_some());
    assert!(registry.find_by_name("frozen").is_none());
}

#[test]
fn find_server_by_socket_sync_returns_matching_server() {
    let _guard = lock_test_env();
    let temp_home = tempfile::tempdir().expect("temp home");
    let prev_home: Option<OsString> = std::env::var_os("ARTERM_HOME");
    crate::env::set_var("ARTERM_HOME", temp_home.path());

    let socket = PathBuf::from("/tmp/blazing.sock");
    let mut registry = ServerRegistry::default();
    let mut info = test_server_info("blazing");
    info.socket = socket.clone();
    registry.register(info.clone());
    std::fs::create_dir_all(temp_home.path()).expect("create temp home");
    std::fs::write(
        registry_path().expect("registry path"),
        serde_json::to_string(&registry).expect("serialize registry"),
    )
    .expect("write registry");

    let found = find_server_by_socket_sync(&socket).expect("find server by socket");
    assert_eq!(found.name, info.name);
    assert_eq!(found.icon, info.icon);

    if let Some(prev_home) = prev_home {
        crate::env::set_var("ARTERM_HOME", prev_home);
    } else {
        crate::env::remove_var("ARTERM_HOME");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_stale_preserves_live_socket_paths() {
    let _guard = lock_test_env();
    let temp_home = tempfile::tempdir().expect("temp home");
    let prev_home: Option<OsString> = std::env::var_os("ARTERM_HOME");
    crate::env::set_var("ARTERM_HOME", temp_home.path());

    let temp_runtime = tempfile::tempdir().expect("temp runtime");
    let socket = temp_runtime.path().join("arterm.sock");
    let debug_socket = temp_runtime.path().join("arterm-debug.sock");
    let _listener = Listener::bind(&socket).expect("bind live socket");
    let _debug_listener = Listener::bind(&debug_socket).expect("bind live debug socket");
    let dead_pid = {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn short-lived child");
        let pid = child.id();
        let _ = child.wait().expect("wait for short-lived child");
        pid
    };

    let mut registry = ServerRegistry::default();
    registry.register(ServerInfo {
        id: "server_old_1".to_string(),
        name: "old".to_string(),
        icon: "🪦".to_string(),
        socket: socket.clone(),
        debug_socket: debug_socket.clone(),
        git_hash: "deadbeef".to_string(),
        version: "v0.0.0".to_string(),
        pid: dead_pid,
        started_at: "2026-01-01T00:00:00Z".to_string(),
        sessions: Vec::new(),
        host: ServerHost::Local,
    });

    let removed = registry.cleanup_stale().await.expect("cleanup stale");
    assert_eq!(removed, vec!["old".to_string()]);
    assert!(
        socket.exists(),
        "cleanup_stale must not unlink a live server socket path"
    );
    assert!(
        debug_socket.exists(),
        "cleanup_stale must not unlink a live debug socket path"
    );

    if let Some(prev_home) = prev_home {
        crate::env::set_var("ARTERM_HOME", prev_home);
    } else {
        crate::env::remove_var("ARTERM_HOME");
    }
}
