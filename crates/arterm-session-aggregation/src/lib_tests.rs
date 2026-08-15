use super::*;
use std::path::PathBuf;

/// 64-hex-char (32-byte) fingerprints, so `short_fingerprint` parses them.
const WINDOWS_FP: &str = "abababababababababababababababababababababababababababababababcd";
const LAPTOP_FP: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdab";

fn server(name: &str, sessions: &[&str]) -> ServerInfo {
    ServerInfo {
        id: format!("server_{name}_123"),
        name: name.to_string(),
        icon: "🔥".to_string(),
        socket: PathBuf::from(format!("/tmp/{name}.sock")),
        debug_socket: PathBuf::from(format!("/tmp/{name}-debug.sock")),
        git_hash: "abc1234".to_string(),
        version: "v0.1.123".to_string(),
        pid: 4242,
        started_at: "2026-01-01T00:00:00Z".to_string(),
        sessions: sessions.iter().map(|s| s.to_string()).collect(),
        host: ServerHost::Local,
    }
}

fn device(name: &str, fingerprint: &str, address: Option<&str>) -> TrustedDevice {
    TrustedDevice {
        fingerprint: fingerprint.to_string(),
        name: name.to_string(),
        address: address.map(|a| a.to_string()),
        paired_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

/// Build a trust store on a temp path (never process-global state), seeded with
/// `devices`.
fn trust_store_with(dir: &tempfile::TempDir, devices: &[TrustedDevice]) -> TrustStore {
    let mut store =
        TrustStore::load_at(dir.path().join("trusted.json")).expect("load empty trust store");
    for device in devices {
        store.trust(device.clone()).expect("trust device");
    }
    store
}

/// A transport double: reports the given servers for one named device only.
struct FakeTransport {
    for_fingerprint: String,
    servers: Vec<ServerInfo>,
}

impl RemoteSessionSource for FakeTransport {
    fn servers_for(&self, device: &TrustedDevice) -> Vec<ServerInfo> {
        if device.fingerprint == self.for_fingerprint {
            self.servers.clone()
        } else {
            Vec::new()
        }
    }
}

#[test]
fn with_no_paired_devices_there_is_only_the_local_group() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trust = trust_store_with(&dir, &[]);

    let groups = aggregate(
        vec![server("blazing", &["fix"])],
        &trust,
        &NullRemoteSessions,
    );

    assert_eq!(groups.len(), 1);
    assert!(groups[0].is_local());
    assert_eq!(groups[0].name, LOCAL_DEVICE_NAME);
    assert_eq!(groups[0].fingerprint(), None);
    assert_eq!(groups[0].session_count(), 1);
}

#[test]
fn local_group_is_always_first() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trust = trust_store_with(
        &dir,
        &[device("windows-box", WINDOWS_FP, Some("192.168.1.42:7420"))],
    );

    let groups = aggregate(Vec::new(), &trust, &NullRemoteSessions);

    assert_eq!(groups.len(), 2);
    assert!(groups[0].is_local(), "local must lead the list");
    assert_eq!(groups[1].name, "windows-box");
}

#[test]
fn paired_device_with_no_reports_still_appears_under_its_name() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trust = trust_store_with(
        &dir,
        &[device("windows-box", WINDOWS_FP, Some("192.168.1.42:7420"))],
    );

    let groups = aggregate(Vec::new(), &trust, &NullRemoteSessions);
    let remote = &groups[1];

    assert_eq!(remote.name, "windows-box");
    assert_eq!(remote.fingerprint(), Some(WINDOWS_FP));
    assert!(!remote.has_reports(), "no transport, so nothing reported");
    assert_eq!(remote.session_count(), 0);

    let rendered = render_plain(&groups);
    assert!(rendered.contains("windows-box"));
    assert!(rendered.contains("no sessions reported"));
    // The fingerprint is shown in the short grouped form, not the raw 64-char hex.
    assert!(rendered.contains("ABAB-ABAB-ABAB-ABAB"));
    assert!(!rendered.contains(WINDOWS_FP));
}

#[test]
fn paired_devices_are_ordered_by_name_after_local() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trust = trust_store_with(
        &dir,
        &[
            device("zulu", WINDOWS_FP, None),
            device("alpha", LAPTOP_FP, None),
        ],
    );

    let groups = aggregate(Vec::new(), &trust, &NullRemoteSessions);

    let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, vec![LOCAL_DEVICE_NAME, "alpha", "zulu"]);
}

#[test]
fn a_transport_feeds_remote_sessions_and_the_host_is_stamped() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trust = trust_store_with(
        &dir,
        &[device("windows-box", WINDOWS_FP, Some("192.168.1.42:7420"))],
    );

    // The transport returns a server with a *local* host on purpose: aggregate
    // must re-stamp it as remote-owned by the device it came from.
    let transport = FakeTransport {
        for_fingerprint: WINDOWS_FP.to_string(),
        servers: vec![server("frozen", &["build", "test"])],
    };

    let groups = aggregate(Vec::new(), &trust, &transport);
    let remote = &groups[1];

    assert!(remote.has_reports());
    assert_eq!(remote.session_count(), 2);
    let host = &remote.servers[0].host;
    assert_eq!(host.fingerprint(), Some(WINDOWS_FP));
    assert_eq!(host.address(), Some("192.168.1.42:7420"));
    assert!(!host.is_local(), "a device's server must not read as local");
}

#[test]
fn local_servers_are_forced_local_even_if_passed_a_remote_host() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trust = trust_store_with(&dir, &[]);

    let mut mislabeled = server("blazing", &["fix"]);
    mislabeled.host = ServerHost::remote("deadbeef", None);

    let groups = aggregate(vec![mislabeled], &trust, &NullRemoteSessions);
    assert!(groups[0].servers[0].host.is_local());
}

#[test]
fn render_lists_each_session_under_its_server() {
    let dir = tempfile::tempdir().expect("temp dir");
    let trust = trust_store_with(&dir, &[]);

    let groups = aggregate(
        vec![server("blazing", &["fix-tests", "refactor"])],
        &trust,
        &NullRemoteSessions,
    );
    let rendered = render_plain(&groups);

    assert!(rendered.contains("🖥  this machine"));
    assert!(rendered.contains("blazing v0.1.123 — 2 session(s)"));
    assert!(rendered.contains("• fix-tests"));
    assert!(rendered.contains("• refactor"));
}
