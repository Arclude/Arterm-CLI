//! Serving paired devices for as long as the daemon lives.
//!
//! `arterm device listen` works, but it asks the wrong thing of a person: hold
//! a second terminal open, forever, or the machine you paired is unreachable.
//! Nothing about pairing suggests that, and a machine that looks paired but
//! answers nothing is the most confusing state this feature has.
//!
//! So the daemon serves peers itself. Pairing is the only thing anyone does,
//! and it is also the consent: the listener binds only once this machine trusts
//! at least one device, and every connection still has to pass the same mTLS
//! and same-subnet checks as before. A machine that has paired with nobody
//! opens no port at all.
//!
//! The trust store is re-read rather than captured, so pairing for the first
//! time starts the service without a restart.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use arterm_device::{DeviceIdentity, TrustStore};
use arterm_peer::gate::TrustGate;
use arterm_peer::listen::{Arrival, PeerListener};
use arterm_peer::tls::PeerCredentials;
use arterm_peer::{DEFAULT_PEER_PORT, subnet};

use crate::cli::device_sessions::local_session_summaries;

/// Set to `1` to keep the daemon from ever opening the peer port.
const OPT_OUT_ENV: &str = "ARTERM_NO_PEER_SERVICE";

/// How long to wait before looking again for a first paired device.
const IDLE_RECHECK: Duration = Duration::from_secs(20);

/// How long to wait after a failure before rebinding. Long enough that a
/// permanently taken port does not spin, short enough that a laptop rejoining
/// its network is reachable again without anyone noticing it was not.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60);

/// Start serving paired devices in the background, for the life of this process.
pub(crate) fn spawn() {
    if std::env::var(OPT_OUT_ENV).is_ok_and(|value| value == "1") {
        crate::logging::info("Peer service disabled by ARTERM_NO_PEER_SERVICE=1");
        return;
    }

    tokio::spawn(async {
        loop {
            let wait = match serve().await {
                Ok(()) => IDLE_RECHECK,
                Err(error) => {
                    // Expected often enough not to be an error the user sees:
                    // the port can be held by a foreground `arterm device
                    // listen`, and a machine between networks has no address to
                    // bind. Both fix themselves; the log says which it was.
                    crate::logging::warn(&format!("Peer service not listening: {error:#}"));
                    RETRY_AFTER_FAILURE
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

/// Serve paired devices, or return immediately when there are none.
///
/// Returns `Ok(())` only when there is nothing to serve. Once the listener is
/// bound this runs until the accept loop fails, which is the signal to rebind.
async fn serve() -> Result<()> {
    if TrustStore::load()
        .context("loading the trust store")?
        .devices()
        .is_empty()
    {
        return Ok(());
    }

    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;
    let credentials = PeerCredentials::from_identity(&identity)?;
    let gate = TrustGate::for_this_device()?;
    let bind = SocketAddr::new(subnet::default_bind_ip()?, DEFAULT_PEER_PORT);

    let listener = PeerListener::bind(bind, &credentials, gate)
        .await
        .with_context(|| format!("binding the peer port at {bind}"))?
        .with_local_sessions(Arc::new(local_session_summaries));

    crate::logging::info(&format!(
        "Peer service accepting paired devices on {}",
        listener.local_addr()
    ));

    loop {
        match listener.accept().await? {
            Arrival::Rejected(rejection) => {
                crate::logging::warn(&format!(
                    "Refused peer {}: {}",
                    rejection.peer_addr, rejection.reason
                ));
            }
            Arrival::Pending(pending) => {
                let peer_addr = pending.peer_addr();
                let admitter = listener.admitter();
                tokio::spawn(async move {
                    if let Err(error) = super::device_peer::serve_one_peer(admitter, pending).await
                    {
                        crate::logging::warn(&format!(
                            "Peer connection from {peer_addr} ended: {error:#}"
                        ));
                    }
                });
            }
        }
    }
}
