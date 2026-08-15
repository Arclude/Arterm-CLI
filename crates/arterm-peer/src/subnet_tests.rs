//! The same-subnet rule is a security control, so its arithmetic is pinned
//! here rather than left to be exercised only by whichever network the machine
//! running the suite happens to be on.

use super::*;
use std::net::Ipv6Addr;
use std::str::FromStr;

fn v4(text: &str) -> IpAddr {
    IpAddr::V4(Ipv4Addr::from_str(text).expect("test address is a valid IPv4 address"))
}

fn v6(text: &str) -> IpAddr {
    IpAddr::V6(Ipv6Addr::from_str(text).expect("test address is a valid IPv6 address"))
}

fn network(text: &str, prefix_len: u8) -> LocalNetwork {
    LocalNetwork::new(v4(text), prefix_len)
}

#[test]
fn a_slash_24_holds_its_own_last_octet_and_nothing_beyond() {
    let home = network("192.168.1.5", 24);
    assert!(home.contains(v4("192.168.1.1")));
    assert!(home.contains(v4("192.168.1.254")));
    assert!(!home.contains(v4("192.168.2.1")));
    assert!(!home.contains(v4("10.0.0.1")));
}

/// The reason the netmask is read from the interface instead of assumed: a /16
/// admits addresses a guessed /24 would have turned away.
#[test]
fn a_wider_prefix_admits_what_a_narrower_one_refuses() {
    let wide = network("192.168.1.5", 16);
    let narrow = network("192.168.1.5", 24);
    assert!(wide.contains(v4("192.168.99.7")));
    assert!(!narrow.contains(v4("192.168.99.7")));
}

#[test]
fn a_slash_32_holds_only_itself() {
    let single = network("192.168.1.5", 32);
    assert!(single.contains(v4("192.168.1.5")));
    assert!(!single.contains(v4("192.168.1.6")));
}

/// A prefix that is not a whole number of bytes has to mask the partial byte,
/// which is where this kind of arithmetic usually goes wrong.
#[test]
fn a_prefix_inside_a_byte_masks_that_byte() {
    let office = network("10.1.0.1", 22);
    assert!(office.contains(v4("10.1.3.255")));
    assert!(!office.contains(v4("10.1.4.1")));
}

#[test]
fn loopback_holds_the_whole_127_range() {
    let loopback = network("127.0.0.1", 8);
    assert!(loopback.contains(v4("127.0.0.1")));
    assert!(loopback.contains(v4("127.1.2.3")));
    assert!(!loopback.contains(v4("128.0.0.1")));
}

/// A dual-stack listener reports an IPv4 peer as `::ffff:a.b.c.d`. Refusing it
/// would turn away machines that are plainly on the same wire.
#[test]
fn a_v4_mapped_peer_is_measured_against_the_v4_network() {
    let home = network("192.168.1.5", 24);
    assert!(home.contains(v6("::ffff:192.168.1.9")));
    assert!(!home.contains(v6("::ffff:192.168.2.9")));
}

#[test]
fn a_real_v6_peer_is_not_matched_against_a_v4_network() {
    let home = network("192.168.1.5", 24);
    assert!(!home.contains(v6("fe80::1")));
}

#[test]
fn a_v6_network_compares_v6_prefixes() {
    let link_local = LocalNetwork::new(v6("fe80::1"), 64);
    assert!(link_local.contains(v6("fe80::abcd")));
    assert!(!link_local.contains(v6("fd00::1")));
    assert!(!link_local.contains(v4("192.168.1.5")));
}

#[test]
fn a_public_address_is_not_local_to_a_private_network() {
    let networks = vec![network("192.168.1.5", 24), network("127.0.0.1", 8)];
    assert!(!is_local_peer(&networks, v4("203.0.113.5")));
    assert!(is_local_peer(&networks, v4("192.168.1.44")));
    assert!(is_local_peer(&networks, v4("127.0.0.1")));
}

#[test]
fn a_machine_on_no_network_admits_nobody() {
    assert!(!is_local_peer(&[], v4("192.168.1.44")));
    assert!(!is_local_peer(&[], v4("127.0.0.1")));
}

#[test]
fn both_wildcards_are_recognised_as_wildcards() {
    assert!(is_wildcard(v4("0.0.0.0")));
    assert!(is_wildcard(v6("::")));
    assert!(!is_wildcard(v4("192.168.1.5")));
    assert!(!is_wildcard(v4("127.0.0.1")));
}

#[test]
fn a_fixed_policy_answers_from_its_own_list() {
    let policy = SubnetPolicy::Fixed(vec![network("10.0.0.1", 8)]);
    assert!(policy.admits(v4("10.9.9.9")).expect("policy answers"));
    assert!(!policy.admits(v4("127.0.0.1")).expect("policy answers"));

    let nowhere = SubnetPolicy::Fixed(Vec::new());
    assert!(!nowhere.admits(v4("127.0.0.1")).expect("policy answers"));
}

/// This machine is on at least loopback, whatever else it is plugged into, so
/// the interface read has one answer that is true everywhere the suite runs.
#[test]
fn this_machine_is_on_its_own_loopback() {
    let policy = SubnetPolicy::ThisMachine;
    assert!(
        policy
            .admits(v4("127.0.0.1"))
            .expect("reading this machine's interfaces")
    );
    assert!(
        !policy
            .admits(v4("203.0.113.5"))
            .expect("reading this machine's interfaces")
    );
}

#[test]
fn a_bindable_address_is_neither_loopback_nor_link_local() {
    assert!(is_bindable_v4(
        Ipv4Addr::from_str("192.168.1.5").expect("valid address")
    ));
    assert!(!is_bindable_v4(
        Ipv4Addr::from_str("127.0.0.1").expect("valid address")
    ));
    assert!(!is_bindable_v4(
        Ipv4Addr::from_str("169.254.1.1").expect("valid address")
    ));
    assert!(!is_bindable_v4(
        Ipv4Addr::from_str("0.0.0.0").expect("valid address")
    ));
}
