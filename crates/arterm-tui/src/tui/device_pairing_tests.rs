//! What the pairing screen shows and what a keystroke does to it.
//!
//! Announcing, hearing and the pairing handshake all need a second machine.
//! Everything between them is decided here — which machines appear, in what
//! state, and what Enter means for each — and that is where a screen goes wrong
//! in ways nobody notices until they are standing at two computers.

use super::*;
use arterm_device::TrustedDevice;

fn fingerprint(byte: &str) -> Fingerprint {
    Fingerprint::from_hex(&byte.repeat(32)).expect("fingerprint")
}

fn trusted(name: &str, byte: &str, address: Option<&str>) -> TrustedDevice {
    TrustedDevice {
        fingerprint: fingerprint(byte).to_hex(),
        name: name.to_string(),
        address: address.map(str::to_string),
        paired_at: "2026-08-17T00:00:00Z".to_string(),
    }
}

fn nearby(name: &str, byte: &str, address: &str) -> DiscoveredDevice {
    DiscoveredDevice {
        name: name.to_string(),
        fingerprint: fingerprint(byte),
        address: address.parse().expect("address"),
    }
}

/// The case the whole screen exists for: a machine nobody has paired with yet
/// is offered, and says so.
#[test]
fn an_unpaired_machine_nearby_is_offered() {
    let rows = merge_rows(&[], &[nearby("desktop", "ab", "192.168.1.108:7644")]);

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, RowState::Nearby);
    assert_eq!(rows[0].address, "192.168.1.108:7644");
    assert!(!rows[0].state.is_paired());
}

/// A machine that is both paired and announcing must appear once. Listed twice,
/// the screen stops answering "which machines are mine".
#[test]
fn a_paired_machine_that_is_also_nearby_appears_once() {
    let rows = merge_rows(
        &[trusted("desktop", "ab", Some("192.168.1.108:7644"))],
        &[nearby("desktop", "ab", "192.168.1.108:7644")],
    );

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, RowState::PairedNearby);
}

/// Pairing records a device under its address until the machines have spoken.
/// Once a beacon arrives with the real name, that is the better label.
#[test]
fn a_beacon_supplies_a_name_the_trust_store_never_learned() {
    let rows = merge_rows(
        &[trusted(
            "192.168.1.108:7644",
            "ab",
            Some("192.168.1.108:7644"),
        )],
        &[nearby("DESKTOP-4JQ47RH", "ab", "192.168.1.108:7644")],
    );

    assert_eq!(rows[0].name, "DESKTOP-4JQ47RH");
}

/// A paired machine that is asleep still belongs on the screen — leaving it out
/// would read as "it is gone" rather than "it is not awake".
#[test]
fn a_paired_machine_that_is_away_is_still_listed() {
    let rows = merge_rows(&[trusted("laptop", "cd", Some("192.168.1.7:7644"))], &[]);

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, RowState::PairedAway);
    assert!(rows[0].state.is_paired());
}

/// Paired machines keep the trust store's order and stay above strangers, so a
/// list someone has learned does not rearrange itself as laptops wake up.
#[test]
fn paired_machines_come_before_strangers() {
    let rows = merge_rows(
        &[
            trusted("laptop", "cd", Some("192.168.1.7:7644")),
            trusted("desktop", "ab", Some("192.168.1.108:7644")),
        ],
        &[nearby("stranger", "ef", "192.168.1.55:7644")],
    );

    let states: Vec<RowState> = rows.iter().map(|row| row.state).collect();
    assert_eq!(
        states,
        vec![RowState::PairedAway, RowState::PairedAway, RowState::Nearby]
    );
    assert_eq!(rows[0].name, "laptop", "trust store order is preserved");
}

/// A trust entry that cannot be parsed cannot be matched to a beacon or
/// dialled, so showing it would offer an action that cannot happen.
#[test]
fn an_unreadable_trust_entry_is_left_out() {
    let broken = TrustedDevice {
        fingerprint: "not-hex".to_string(),
        name: "broken".to_string(),
        address: None,
        paired_at: "2026-08-17T00:00:00Z".to_string(),
    };

    assert!(merge_rows(&[broken], &[]).is_empty());
}

/// Every state has to say something a person can act on, and none of them may
/// be blank.
#[test]
fn every_row_state_explains_itself() {
    for state in [
        RowState::PairedNearby,
        RowState::PairedAway,
        RowState::Nearby,
    ] {
        assert!(!state.label().is_empty(), "{state:?} says nothing");
    }
    assert_ne!(RowState::Nearby.label(), RowState::PairedAway.label());
}
