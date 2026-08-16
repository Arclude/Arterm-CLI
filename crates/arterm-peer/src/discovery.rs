//! Finding the other machine instead of being told where it is.
//!
//! Pairing used to mean carrying a token between two computers. The token
//! existed to answer two questions — *which machine* and *is it really that
//! machine* — and only the first of those needs a human. This module answers it
//! by broadcasting on the local network: every machine with its pairing screen
//! open says its name, its fingerprint and its peer port, and hears the others
//! doing the same.
//!
//! **A beacon carries no authority.** Anyone on the network can send one, with
//! any name and any fingerprint. That is fine, because nothing is trusted on
//! its word: the fingerprint in a beacon is only a claim about who will answer,
//! and pairing still completes over mutual TLS, where a machine that does not
//! hold the matching private key cannot finish the handshake. The short code
//! covers the other half — it is what stops you pairing with a machine that is
//! genuinely itself but not the one you meant.
//!
//! Announcing happens only while a pairing screen is open, so a machine sitting
//! idle says nothing at all.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use arterm_device::identity::Fingerprint;
use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use crate::DEFAULT_PEER_PORT;

/// The port beacons are sent to and heard on. Distinct from the peer port so a
/// stray datagram can never reach the TLS listener.
pub const DISCOVERY_PORT: u16 = 7645;

/// How often a machine repeats itself while its pairing screen is open.
const BEACON_INTERVAL: Duration = Duration::from_millis(900);

/// How long a machine stays in the list after its last beacon. Long enough to
/// survive a dropped datagram, short enough that a closed laptop leaves.
const FORGET_AFTER: Duration = Duration::from_secs(5);

/// The wire form of a beacon. Small on purpose: it fits in one datagram with
/// room to spare, and every field is something the receiver would otherwise
/// have to be told by hand.
#[derive(Serialize, Deserialize)]
struct Beacon {
    /// Protocol marker, so a datagram from something else is dropped cheaply.
    arterm: u8,
    name: String,
    fingerprint: String,
    port: u16,
}

/// The version this build speaks. A beacon with any other value is ignored.
const BEACON_VERSION: u8 = 1;

/// A machine heard from on the local network.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredDevice {
    pub name: String,
    pub fingerprint: Fingerprint,
    /// Where its peer listener is, ready to be dialled.
    pub address: SocketAddr,
}

impl DiscoveredDevice {
    /// `host:port`, the form an invite carries.
    pub fn address_string(&self) -> String {
        self.address.to_string()
    }
}

/// Announcing this machine and listening for others, for as long as this lives.
///
/// Dropping it stops both, which is what ties discoverability to a screen being
/// open rather than to a setting someone has to remember.
pub struct Presence {
    seen: Arc<Mutex<HashMap<String, (DiscoveredDevice, std::time::Instant)>>>,
    announced: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}

impl Presence {
    /// Start announcing this machine and collecting the others.
    ///
    /// Being unable to *receive* is not fatal: another arterm on this machine
    /// may already hold the port, and a machine that can only announce is still
    /// pairable from the other side.
    pub async fn open(name: &str, fingerprint: &Fingerprint, peer_port: u16) -> Result<Self> {
        let beacon = serde_json::to_vec(&Beacon {
            arterm: BEACON_VERSION,
            name: name.to_string(),
            fingerprint: fingerprint.to_hex(),
            port: peer_port,
        })
        .context("encoding this machine's beacon")?;

        let sender = UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
            .await
            .context("opening a socket to announce this machine")?;
        sender
            .set_broadcast(true)
            .context("enabling broadcast on the announce socket")?;

        let seen: Arc<Mutex<HashMap<String, (DiscoveredDevice, std::time::Instant)>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut tasks = Vec::new();

        let targets = broadcast_targets();
        let announced = Arc::new(AtomicBool::new(false));
        let announced_by_task = Arc::clone(&announced);
        tasks.push(tokio::spawn(async move {
            loop {
                for target in &targets {
                    // Whether a send worked is the difference between "nobody
                    // is out there" and "this network does not carry broadcast
                    // at all", and the screen showing this presence is the only
                    // place that distinction can be told to anyone.
                    if sender.send_to(&beacon, target).await.is_ok() {
                        announced_by_task.store(true, Ordering::Relaxed);
                    }
                }
                tokio::time::sleep(BEACON_INTERVAL).await;
            }
        }));

        match UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], DISCOVERY_PORT))).await {
            Ok(listener) => {
                let seen = Arc::clone(&seen);
                let own = fingerprint.to_hex();
                tasks.push(tokio::spawn(async move {
                    listen_for_beacons(listener, seen, own).await;
                }));
            }
            Err(_busy) => {
                // Send-only. The other machine can still find and pair us.
            }
        }

        Ok(Self {
            seen,
            announced,
            tasks,
        })
    }

    /// Whether this machine has managed to put a beacon on the network at all.
    ///
    /// False after the first moment means no send has ever succeeded — a
    /// network that refuses broadcast, or an interface with nowhere to send —
    /// and the other machine will never see this one no matter how long anyone
    /// waits. Worth saying out loud rather than showing an empty list.
    pub fn is_announcing(&self) -> bool {
        self.announced.load(Ordering::Relaxed)
    }

    /// The machines heard from recently, newest name order, minus this one.
    pub fn seen(&self) -> Vec<DiscoveredDevice> {
        let Ok(mut seen) = self.seen.lock() else {
            return Vec::new();
        };
        seen.retain(|_, (_, at)| at.elapsed() < FORGET_AFTER);
        let mut devices: Vec<DiscoveredDevice> =
            seen.values().map(|(device, _)| device.clone()).collect();
        devices.sort_by(|left, right| left.name.cmp(&right.name));
        devices
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn listen_for_beacons(
    listener: UdpSocket,
    seen: Arc<Mutex<HashMap<String, (DiscoveredDevice, std::time::Instant)>>>,
    own_fingerprint: String,
) {
    let mut buffer = vec![0u8; 1024];
    loop {
        let Ok((len, from)) = listener.recv_from(&mut buffer).await else {
            return;
        };
        let Some(device) = device_from_beacon(&buffer[..len], from, &own_fingerprint) else {
            continue;
        };
        if let Ok(mut seen) = seen.lock() {
            seen.insert(
                device.fingerprint.to_hex(),
                (device, std::time::Instant::now()),
            );
        }
    }
}

/// A datagram as a device, or `None` when it is not one of ours.
///
/// The sender's own address is used rather than any address inside the beacon:
/// a machine cannot be wrong about where its packets come from, and it removes
/// a field someone could use to point us at a third party.
fn device_from_beacon(
    datagram: &[u8],
    from: SocketAddr,
    own_fingerprint: &str,
) -> Option<DiscoveredDevice> {
    // The port is shared with whatever else broadcasts on this network, so a
    // datagram that is not ours is the common case, not a fault.
    let Ok(beacon) = serde_json::from_slice::<Beacon>(datagram) else {
        return None;
    };
    if beacon.arterm != BEACON_VERSION || beacon.fingerprint == own_fingerprint {
        return None;
    }
    // A fingerprint that cannot be parsed cannot be verified against the
    // certificate later either, so the row would be unpairable.
    let Ok(fingerprint) = Fingerprint::from_hex(&beacon.fingerprint) else {
        return None;
    };
    let port = if beacon.port == 0 {
        DEFAULT_PEER_PORT
    } else {
        beacon.port
    };
    Some(DiscoveredDevice {
        name: beacon.name,
        fingerprint,
        address: SocketAddr::new(from.ip(), port),
    })
}

/// Where to send beacons: every interface's own broadcast address, plus the
/// limited broadcast as a fallback.
///
/// Directed broadcast reaches machines that some networks keep from seeing
/// `255.255.255.255`, and the limited one covers interfaces that report no
/// broadcast address at all. Sending to both costs two datagrams a second.
fn broadcast_targets() -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::BROADCAST,
        DISCOVERY_PORT,
    ))];

    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if let if_addrs::IfAddr::V4(v4) = interface.addr
                && let Some(broadcast) = v4.broadcast
                && !v4.ip.is_loopback()
            {
                targets.push(SocketAddr::new(IpAddr::V4(broadcast), DISCOVERY_PORT));
            }
        }
    }

    targets
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod discovery_tests;
