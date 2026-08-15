use super::*;

#[test]
fn local_is_the_default() {
    assert_eq!(ServerHost::default(), ServerHost::Local);
    assert!(ServerHost::default().is_local());
    assert_eq!(ServerHost::default().fingerprint(), None);
    assert_eq!(ServerHost::default().address(), None);
}

#[test]
fn remote_exposes_fingerprint_and_address() {
    let host = ServerHost::remote("a1b2c3", Some("192.168.1.42:7420".to_string()));
    assert!(!host.is_local());
    assert_eq!(host.fingerprint(), Some("a1b2c3"));
    assert_eq!(host.address(), Some("192.168.1.42:7420"));
}

#[test]
fn local_serializes_with_its_tag() {
    let json = serde_json::to_string(&ServerHost::Local).expect("serialize local host");
    assert_eq!(json, r#"{"kind":"local"}"#);
    let back: ServerHost = serde_json::from_str(&json).expect("deserialize local host");
    assert_eq!(back, ServerHost::Local);
}

#[test]
fn remote_round_trips_and_omits_absent_address() {
    let host = ServerHost::remote("deadbeef", None);
    let json = serde_json::to_string(&host).expect("serialize remote host");
    assert_eq!(json, r#"{"kind":"remote","fingerprint":"deadbeef"}"#);
    let back: ServerHost = serde_json::from_str(&json).expect("deserialize remote host");
    assert_eq!(back, host);
}
