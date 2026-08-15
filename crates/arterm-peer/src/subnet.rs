//! Which addresses count as "this network".
//!
//! The user's requirement for peer sessions is that only machines on the same
//! network take part. That is a separate fact from being paired, and it does
//! not follow from anything else in this crate: a trust store entry survives
//! the laptop leaving the house, and a fingerprint check would happily admit it
//! from a coffee shop. So the rule gets its own code, on both ends of the
//! connection — a listener refuses an off-subnet source address, and a
//! connector refuses to dial an off-subnet destination.
//!
//! "Same network" means: the peer address falls inside the prefix of one of the
//! addresses this machine holds. Read from the interfaces themselves rather
//! than assumed, because a guessed netmask is wrong on exactly the networks
//! people actually run — a /16 home lab, a /22 office.

use anyhow::{Context, Result};
use std::net::{IpAddr, Ipv4Addr};

/// One address this machine holds, with the prefix that defines its subnet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalNetwork {
    pub ip: IpAddr,
    pub prefix_len: u8,
}

impl LocalNetwork {
    pub fn new(ip: IpAddr, prefix_len: u8) -> Self {
        Self { ip, prefix_len }
    }

    /// Whether `peer` sits inside this network.
    pub fn contains(&self, peer: IpAddr) -> bool {
        match (self.ip, peer) {
            (IpAddr::V4(local), IpAddr::V4(peer)) => {
                same_prefix(&local.octets(), &peer.octets(), self.prefix_len)
            }
            (IpAddr::V6(local), IpAddr::V6(peer)) => {
                // A dual-stack listener reports an IPv4 peer as
                // `::ffff:192.168.1.5`. That is the same host as its IPv4 form,
                // so compare it against the IPv4 networks instead of against a
                // v6 prefix it will never match.
                match peer.to_ipv4_mapped() {
                    Some(mapped) => match self.ip {
                        IpAddr::V6(_) => local.to_ipv4_mapped().is_some_and(|local_v4| {
                            same_prefix(&local_v4.octets(), &mapped.octets(), self.prefix_len)
                        }),
                        IpAddr::V4(_) => false,
                    },
                    None => same_prefix(&local.octets(), &peer.octets(), self.prefix_len),
                }
            }
            (IpAddr::V4(local), IpAddr::V6(peer)) => match peer.to_ipv4_mapped() {
                Some(mapped) => same_prefix(&local.octets(), &mapped.octets(), self.prefix_len),
                None => false,
            },
            (IpAddr::V6(_), IpAddr::V4(_)) => false,
        }
    }
}

/// Compare the first `prefix_len` bits of two equal-length addresses.
fn same_prefix(local: &[u8], peer: &[u8], prefix_len: u8) -> bool {
    if local.len() != peer.len() {
        return false;
    }
    let bits = usize::from(prefix_len).min(local.len() * 8);
    let whole_bytes = bits / 8;
    let leftover_bits = bits % 8;

    if local[..whole_bytes] != peer[..whole_bytes] {
        return false;
    }
    if leftover_bits == 0 {
        return true;
    }
    let mask = 0xffu8 << (8 - leftover_bits);
    (local[whole_bytes] & mask) == (peer[whole_bytes] & mask)
}

/// Every address this machine holds, with its prefix.
///
/// Loopback is included: two arterm homes on one machine talking over
/// `127.0.0.1` are as local as two addresses get, and excluding it would make
/// the feature untestable on a single box for no gain in safety.
pub fn local_networks() -> Result<Vec<LocalNetwork>> {
    let interfaces =
        if_addrs::get_if_addrs().context("reading this machine's network interfaces")?;
    Ok(interfaces
        .iter()
        .map(|interface| match &interface.addr {
            if_addrs::IfAddr::V4(v4) => LocalNetwork::new(IpAddr::V4(v4.ip), v4.prefixlen),
            if_addrs::IfAddr::V6(v6) => LocalNetwork::new(IpAddr::V6(v6.ip), v6.prefixlen),
        })
        .collect())
}

/// Whether `peer` is on one of `networks`.
pub fn is_local_peer(networks: &[LocalNetwork], peer: IpAddr) -> bool {
    networks.iter().any(|network| network.contains(peer))
}

/// Which source addresses a listener will take a connection from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubnetPolicy {
    /// Whatever networks this machine is on right now.
    ///
    /// Re-read per connection rather than cached: a laptop that moves between
    /// networks keeps its listener, and a list captured at bind time would go
    /// on admitting the subnet it used to be on.
    ThisMachine,
    /// An explicit list, for a machine whose owner wants to name the networks
    /// rather than take every interface it happens to hold.
    Fixed(Vec<LocalNetwork>),
}

impl SubnetPolicy {
    pub fn admits(&self, peer: IpAddr) -> Result<bool> {
        match self {
            Self::ThisMachine => Ok(is_local_peer(&local_networks()?, peer)),
            Self::Fixed(networks) => Ok(is_local_peer(networks, peer)),
        }
    }
}

/// The address a listener should bind to when the user names none.
///
/// A specific interface address, never `0.0.0.0`: binding the wildcard puts the
/// port on every network this machine can see, including ones the same-subnet
/// rule is meant to keep it off. The first non-loopback, non-link-local IPv4
/// address wins, sorted by interface name so the choice does not change between
/// runs on a machine with several.
pub fn default_bind_ip() -> Result<IpAddr> {
    let mut interfaces =
        if_addrs::get_if_addrs().context("reading this machine's network interfaces")?;
    interfaces.sort_by(|left, right| left.name.cmp(&right.name));

    for interface in &interfaces {
        if let if_addrs::IfAddr::V4(v4) = &interface.addr
            && is_bindable_v4(v4.ip)
        {
            return Ok(IpAddr::V4(v4.ip));
        }
    }

    anyhow::bail!(
        "this machine has no non-loopback IPv4 address, so there is no local network to listen \
         on — connect it to the network, or pass `--address <ip>:<port>` to choose one yourself"
    )
}

/// Whether an address is worth binding a peer listener to.
fn is_bindable_v4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !ip.is_multicast()
}

/// Whether an address is one of the wildcards a peer listener must never bind.
pub fn is_wildcard(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_unspecified(),
        IpAddr::V6(v6) => v6.is_unspecified(),
    }
}

#[cfg(test)]
#[path = "subnet_tests.rs"]
mod subnet_tests;
