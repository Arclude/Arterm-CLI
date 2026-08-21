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

/// PeerListener::accept asks the policy with `peer_addr.ip()` only, so a Fixed
/// fe80::/64 list must admit every link-local peer IP regardless of the
/// SocketAddrV6 scope_id / interface the kernel attached on arrival.
#[test]
fn a_fixed_fe80_slash_64_admits_any_link_local_ip_regardless_of_scope() {
    use std::net::{SocketAddr, SocketAddrV6};

    let policy = SubnetPolicy::Fixed(vec![LocalNetwork::new(v6("fe80::1"), 64)]);

    for peer in [
        "fe80::1",
        "fe80::abcd",
        "fe80::dead:beef",
        "fe80::ffff:ffff:ffff:ffff",
    ] {
        assert!(
            policy.admits(v6(peer)).expect("policy answers"),
            "{peer} is inside fe80::/64"
        );
    }
    assert!(!policy.admits(v6("fe81::1")).expect("policy answers"));
    assert!(!policy.admits(v6("fd00::1")).expect("policy answers"));

    // Same IP under different zone ids is still the same IpAddr after .ip().
    for scope_id in [0u32, 1, 2, 42, u32::MAX] {
        let addr = SocketAddr::V6(SocketAddrV6::new(
            Ipv6Addr::from_str("fe80::a:b:c:d").expect("valid address"),
            7644,
            0,
            scope_id,
        ));
        assert_eq!(addr.ip(), v6("fe80::a:b:c:d"));
        assert!(
            policy.admits(addr.ip()).expect("policy answers"),
            "scope_id={scope_id} must not affect Fixed fe80::/64 admission"
        );
    }
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

/// The case that sent a real machine's listener to an address no peer could
/// reach: Cloudflare WARP's point-to-point `/32` beat the LAN address purely on
/// interface name order.
#[test]
fn a_vpn_point_to_point_address_ranks_below_a_lan_address() {
    let lan = if_addrs::Ifv4Addr {
        ip: Ipv4Addr::from_str("192.168.1.100").expect("valid address"),
        netmask: Ipv4Addr::from_str("255.255.255.0").expect("valid mask"),
        prefixlen: 24,
        broadcast: None,
    };
    let warp = if_addrs::Ifv4Addr {
        ip: Ipv4Addr::from_str("172.16.0.2").expect("valid address"),
        netmask: Ipv4Addr::from_str("255.255.255.255").expect("valid mask"),
        prefixlen: 32,
        broadcast: None,
    };

    assert!(
        bind_rank_v4(&lan) > bind_rank_v4(&warp),
        "a LAN address must outrank a VPN's /32, whatever the interfaces are called"
    );
}

/// Both are real subnets, so neither is disqualified — but two paired machines
/// look for each other on a local network, so the private one is the better bet.
#[test]
fn a_private_subnet_outranks_a_public_one() {
    let private = if_addrs::Ifv4Addr {
        ip: Ipv4Addr::from_str("10.0.0.5").expect("valid address"),
        netmask: Ipv4Addr::from_str("255.0.0.0").expect("valid mask"),
        prefixlen: 8,
        broadcast: None,
    };
    let public = if_addrs::Ifv4Addr {
        ip: Ipv4Addr::from_str("203.0.113.5").expect("valid address"),
        netmask: Ipv4Addr::from_str("255.255.255.0").expect("valid mask"),
        prefixlen: 24,
        broadcast: None,
    };

    assert!(bind_rank_v4(&private) > bind_rank_v4(&public));
}

/// Docker and libvirt bridges sit in `172.16/12` as `/16`s. Rank 2 for every
/// private address used to pick them over `wlan0` because `br-*` sorts first.
#[test]
fn a_lan_slash_24_outranks_a_docker_slash_16() {
    let lan = if_addrs::Ifv4Addr {
        ip: Ipv4Addr::from_str("192.168.1.100").expect("valid address"),
        netmask: Ipv4Addr::from_str("255.255.255.0").expect("valid mask"),
        prefixlen: 24,
        broadcast: None,
    };
    let docker = if_addrs::Ifv4Addr {
        ip: Ipv4Addr::from_str("172.22.0.1").expect("valid address"),
        netmask: Ipv4Addr::from_str("255.255.0.0").expect("valid mask"),
        prefixlen: 16,
        broadcast: None,
    };

    assert!(
        bind_rank_v4(&lan) > bind_rank_v4(&docker),
        "a LAN /24 must outrank a container bridge /16, whatever the interfaces are called"
    );
}

/// A machine with only a VPN still has to be able to listen somewhere: ranking
/// last is not the same as being excluded.
#[test]
fn a_point_to_point_address_is_still_bindable() {
    assert!(is_bindable_v4(
        Ipv4Addr::from_str("172.16.0.2").expect("valid address")
    ));
}
