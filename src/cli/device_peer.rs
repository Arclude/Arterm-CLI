//! `arterm device listen` and `arterm device connect` — the peer transport,
//! wired to something a person can run.
//!
//! Both sides work by splicing, not by translating. The arterm protocol is
//! newline-delimited JSON over a Unix socket, and a peer connection carries
//! exactly those bytes once its handshake is done, so:
//!
//! - **listen** takes an authenticated peer and joins it to this machine's
//!   ordinary daemon socket. The server sees a client indistinguishable from a
//!   local one, because at the byte level it is one.
//! - **connect** puts a Unix socket in front of the peer connection and points
//!   `ARTERM_SOCKET` at it, so the ordinary TUI dials the ordinary path and
//!   never learns it is talking to another machine. That also survives the
//!   TUI's reconnect loop, which re-dials on every disconnect: each local
//!   connection opens its own TLS link.
//!
//! Kept out of `device.rs` so the subcommand file stays about the trust store,
//! and out of `dispatch.rs`, which is already at the oversized-file ratchet.

use anyhow::{Context, Result};
use arterm_device::identity::Fingerprint;
use arterm_device::{DeviceIdentity, PendingJoins, TrustStore, TrustedDevice};
use arterm_peer::gate::TrustGate;
use arterm_peer::listen::{Admitted, Arrival, PeerAdmitter, PeerListener, PendingPeer};
use arterm_peer::tls::PeerCredentials;
use arterm_peer::{DEFAULT_PEER_PORT, PeerTarget, connect_to_peer, subnet};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use crate::cli::device_sessions::local_session_summaries;

/// Serve this machine's sessions to the devices it has paired with.
pub(crate) async fn listen(address: Option<String>) -> Result<()> {
    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;
    let credentials = PeerCredentials::from_identity(&identity)?;
    let gate = TrustGate::for_this_device()?;
    let bind = resolve_bind_address(address.as_deref())?;

    // Answer a peer's session-list query from this machine's own registry, so
    // `arterm device sessions` on the other side sees real sessions rather than
    // the empty stub. Read fresh on each query — the list changes as sessions
    // come and go.
    let listener = PeerListener::bind(bind, &credentials, gate)
        .await?
        .with_local_sessions(Arc::new(local_session_summaries));
    let local_addr = listener.local_addr();

    println!("{} is accepting peer connections.", identity.name());
    println!();
    println!("  address      {local_addr}");
    println!("  fingerprint  {}", identity.fingerprint().to_display());
    println!();

    let paired = TrustStore::load().context("loading the trust store")?;
    if paired.devices().is_empty() {
        println!("No devices are paired yet, so nothing can connect. Run");
        println!("  arterm device invite");
        println!("here, then `arterm device join <token>` on the other machine.");
    } else {
        println!("{} paired device(s) may connect.", paired.devices().len());
    }

    // A peer session is spliced into whatever daemon owns this socket, and a
    // listener started from another arterm session's shell inherits that
    // session's ARTERM_SOCKET — silently relaying peers to the *wrong*
    // daemon. Say which daemon is about to receive them before anything
    // connects.
    let socket = crate::server::socket_path();
    println!("  daemon socket {}", socket.display());
    if let Some(note) = inherited_socket_note(
        std::env::var_os("ARTERM_SOCKET").as_deref(),
        &crate::storage::runtime_dir().join("arterm.sock"),
    ) {
        println!();
        println!("Note: {note}");
    }
    if !crate::server::has_live_listener(&socket).await {
        println!();
        println!("Note: no arterm server is running at {}.", socket.display());
        println!("Start one with `arterm serve` or a peer will connect to nothing.");
    }
    println!();

    loop {
        match listener.accept().await? {
            Arrival::Rejected(rejection) => {
                println!("Refused {}: {}", rejection.peer_addr, rejection.reason);
            }
            Arrival::Pending(pending) => {
                let peer_addr = pending.peer_addr();
                let admitter = listener.admitter();
                tokio::spawn(async move {
                    if let Err(error) = serve_one_peer(admitter, pending).await {
                        eprintln!("Peer connection from {peer_addr} ended: {error:#}");
                    }
                });
            }
        }
    }
}

/// Finish one peer's handshake and join it to the local daemon socket.
pub(crate) async fn serve_one_peer(admitter: PeerAdmitter, pending: PendingPeer) -> Result<()> {
    match admitter.establish(pending).await? {
        Admitted::Rejected(rejection) => {
            println!("Refused {}: {}", rejection.peer_addr, rejection.reason);
            Ok(())
        }
        Admitted::Listed {
            peer_name,
            peer_addr,
            ..
        } => {
            // The session list was answered during the handshake; nothing more
            // to relay.
            println!("{peer_name} at {peer_addr} listed this machine's sessions.");
            Ok(())
        }
        Admitted::Session(session) => {
            let mut session = *session;
            if session.paired_now {
                println!(
                    "Paired with {} ({}).",
                    session.peer_name,
                    session.fingerprint.to_display()
                );
            }
            println!(
                "{} connected from {}.",
                session.peer_name, session.peer_addr
            );

            let socket = crate::server::socket_path();
            let mut local = crate::transport::Stream::connect(&socket)
                .await
                .with_context(|| {
                    format!(
                        "{} is paired, but no arterm server is listening at {} — start one with \
                     `arterm serve`",
                        session.peer_name,
                        socket.display()
                    )
                })?;

            let outcome = tokio::io::copy_bidirectional(&mut session.stream, &mut local).await;
            println!("{} disconnected.", session.peer_name);
            match outcome {
                Ok(_byte_counts) => Ok(()),
                // A peer closing its side mid-copy is an ordinary end to a
                // session, not a fault worth a non-zero exit.
                Err(error) if arterm_peer::is_ordinary_disconnect(&error) => Ok(()),
                Err(error) => {
                    Err(error).with_context(|| format!("relaying {}'s session", session.peer_name))
                }
            }
        }
    }
}

/// Drive a session on a paired device.
pub(crate) async fn connect(
    device: &str,
    address: Option<String>,
    remote_working_dir: Option<String>,
    proxy_socket: Option<PathBuf>,
) -> Result<()> {
    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;
    let credentials = Arc::new(PeerCredentials::from_identity(&identity)?);

    let trust = TrustStore::load().context("loading the trust store")?;
    let entry = trust.find_by_name_or_fingerprint(device).with_context(|| {
        format!("no paired device matches '{device}' — `arterm device list` shows them")
    })?;
    let fingerprint = Fingerprint::from_hex(&entry.fingerprint)?;

    let mut joins = PendingJoins::load().context("loading pending joins")?;
    let target = Arc::new(PeerTarget {
        address: peer_address(device, entry, &fingerprint, &joins, address)?,
        fingerprint: fingerprint.clone(),
    });
    let secret = joins.secret_for(&fingerprint).map(str::to_string);

    // One connection before the TUI takes the terminal. It completes the
    // pairing when a secret is still held, and it turns "the other machine has
    // not paired with you" into a sentence on a normal screen rather than an
    // error the TUI reports as a failed reconnect.
    //
    // No listen port is advertised: this process only connects, and claiming a
    // port nothing is listening on would have the far end record an address
    // that never answers.
    let probe = connect_to_peer(&credentials, &target, secret.as_deref(), None).await?;
    // The welcome carries the far listener's real device name. Legacy trust
    // entries may still carry an address as the name; learn the true one so
    // relay logs and aggregation stop saying "192.168.1.108:7644".
    TrustGate::for_this_device()?
        .record_name(&fingerprint, &probe.peer_name)
        .context("learning the peer's device name from the welcome")?;
    if probe.paired_now {
        println!(
            "Paired with {} — it now accepts connections from this device too.",
            probe.peer_name
        );
    }
    if secret.is_some() {
        joins.clear(&fingerprint)?;
    }
    println!("Connected to {} at {}.", probe.peer_name, probe.peer_addr);
    let peer_name = probe.peer_name.clone();
    drop(probe);

    let proxy_only = proxy_socket.is_some();
    let socket = match proxy_socket {
        Some(path) => path,
        None => default_proxy_socket(&fingerprint)?,
    };
    crate::transport::remove_socket(&socket);
    let listener = crate::transport::Listener::bind(&socket)
        .with_context(|| format!("putting a local socket at {}", socket.display()))?;
    restrict_to_owner(&socket)?;

    spawn_relay(listener, Arc::clone(&credentials), Arc::clone(&target));

    if proxy_only {
        println!();
        println!("{peer_name}'s server is available at {}.", socket.display());
        println!(
            "Point a client at it with `arterm --socket {}`.",
            socket.display()
        );
        println!("Press Ctrl-C to stop.");
        tokio::signal::ctrl_c()
            .await
            .context("waiting for Ctrl-C")?;
        crate::transport::remove_socket(&socket);
        return Ok(());
    }

    if remote_working_dir.is_none() {
        println!();
        println!("No --remote-working-dir given, so the session will use this machine's");
        println!("current directory path on the other machine. Pass one if that path");
        println!("does not exist there.");
    }

    crate::server::set_socket_path(
        socket
            .to_str()
            .context("the local peer socket path is not valid UTF-8")?,
    );
    let outcome =
        super::tui_launch::run_tui_client(None, None, false, false, remote_working_dir, false)
            .await;
    crate::transport::remove_socket(&socket);
    outcome
}

/// Serve the local socket, opening one TLS link per client that dials it.
///
/// One link per connection rather than one shared link: the TUI re-dials on
/// every reconnect, and a single multiplexed link would have to invent framing
/// the arterm protocol does not have.
fn spawn_relay(
    listener: crate::transport::Listener,
    credentials: Arc<PeerCredentials>,
    target: Arc<PeerTarget>,
) {
    tokio::spawn(async move {
        // Windows' named-pipe listener accepts through `&mut self`; the Unix
        // socket listener does not, so the `mut` is unused there.
        #[cfg_attr(unix, allow(unused_mut))]
        let mut listener = listener;
        loop {
            let mut local = match listener.accept().await {
                Ok((stream, _addr)) => stream,
                Err(error) => {
                    eprintln!("The local peer socket stopped accepting: {error}");
                    return;
                }
            };
            let credentials = Arc::clone(&credentials);
            let target = Arc::clone(&target);
            tokio::spawn(async move {
                // Dialling and splicing live in `arterm-peer` so a client that
                // reaches a peer from inside its own process does exactly what
                // this loop does, rather than a second implementation of it.
                if let Err(error) =
                    arterm_peer::relay_local_stream(&credentials, &target, &mut local).await
                {
                    eprintln!("The peer session ended: {error:#}");
                }
            });
        }
    });
}

/// Restrict the local peer socket to the user who opened it.
///
/// Stricter than the daemon socket beside it, deliberately. That one is a door
/// to this machine, which whoever reaches the runtime directory is already on;
/// this one is a door to a *different* machine's agent, and it should not be
/// walkable by anyone who happens to share the host.
fn restrict_to_owner(path: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("restricting permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _unused = path;
    }
    Ok(())
}

/// Where to reach the named device.
fn peer_address(
    needle: &str,
    entry: &TrustedDevice,
    fingerprint: &Fingerprint,
    joins: &PendingJoins,
    override_address: Option<String>,
) -> Result<String> {
    if let Some(address) = override_address {
        return Ok(address);
    }
    if let Some(address) = entry.address.clone() {
        return Ok(address);
    }
    // A device paired from the other direction has no address recorded until it
    // connects here, but the invite that paired it named one.
    if let Some(address) = joins.address_for(fingerprint) {
        return Ok(address.to_string());
    }
    anyhow::bail!(
        "no address is recorded for '{needle}' — pass `--address <host>:<port>`, or let it \
         connect here once and the address it came from is remembered"
    )
}

/// Parse `--address`, filling in the default port when only an IP is given.
///
/// Wildcard refusal (`0.0.0.0` / `::`) lives in [`PeerListener::bind`], not here,
/// so callers can distinguish "bad syntax" from "parsed but not bindable".
fn resolve_bind_address(address: Option<&str>) -> Result<SocketAddr> {
    let Some(address) = address else {
        let ip = subnet::default_bind_ip()?;
        return Ok(SocketAddr::new(ip, DEFAULT_PEER_PORT));
    };

    let address = address.trim();
    if let Ok(parsed) = address.parse::<SocketAddr>() {
        return Ok(parsed);
    }
    let ip: IpAddr = address.parse().with_context(|| {
        format!("'{address}' is neither an address nor an address and port, e.g. 192.168.1.5:7644")
    })?;
    Ok(SocketAddr::new(ip, DEFAULT_PEER_PORT))
}

/// Path for the local socket that fronts a peer connection.
///
/// Named after the device so two peer sessions on one machine do not collide,
/// and kept well away from `arterm.sock` so nothing mistakes it for the local
/// daemon.
fn default_proxy_socket(fingerprint: &Fingerprint) -> Result<PathBuf> {
    let short = fingerprint
        .to_hex()
        .get(..16)
        .context("a device fingerprint is shorter than expected")?
        .to_string();
    Ok(crate::storage::runtime_dir().join(format!("arterm-peer-{short}.sock")))
}

/// The note `listen` prints when ARTERM_SOCKET came from the environment
/// rather than this machine's own runtime dir.
///
/// The listener joins peers to whatever daemon owns [`crate::server::socket_path`],
/// and a listener started from another arterm session's shell inherits that
/// session's `ARTERM_SOCKET` — pointing peers at a daemon whose sessions are
/// not the ones this machine shows. There is no reliable way to detect the
/// wrong daemon from inside (the inherited path can even be the default
/// path of a different runtime dir), so the note fires whenever the
/// environment supplies a socket at all: the banner already names the exact
/// socket that will be used, and this tells the reader why.
fn inherited_socket_note(
    inherited: Option<&std::ffi::OsStr>,
    default_socket: &std::path::Path,
) -> Option<String> {
    let inherited = inherited?;
    let inherited_path = std::path::Path::new(inherited);
    if inherited_path == default_socket {
        // The environment names this machine's own socket; nothing surprising.
        return None;
    }
    Some(format!(
        "ARTERM_SOCKET={} was inherited from this shell's environment, so peers will be \
         joined to the daemon at that path. Unset it to serve this machine's own daemon.",
        inherited_path.display()
    ))
}

#[cfg(test)]
#[path = "device_peer_tests.rs"]
mod device_peer_tests;
