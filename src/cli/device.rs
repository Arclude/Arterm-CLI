//! `arterm device` — this machine's identity and the machines it trusts.
//!
//! Kept out of `args.rs` and `dispatch.rs` because both are near the
//! oversized-file ratchet's threshold, and a subcommand that will keep growing
//! as pairing lands should not be the thing that pushes them over.

use anyhow::{Context, Result};
use arterm_device::{DeviceIdentity, Invite, TrustStore, TrustedDevice, invite::PendingInvites};
use clap::Subcommand;

#[derive(Subcommand, Debug)]
pub(crate) enum DeviceCommand {
    /// Show this device's name and fingerprint
    Show {
        /// Emit JSON instead of human-readable output
        #[arg(long)]
        json: bool,
    },

    /// Mint a one-time invite for another device to pair with this one
    Invite {
        /// Address the other device should connect to, as host:port
        #[arg(long)]
        address: String,
    },

    /// Accept an invite minted by another device
    Join {
        /// The invite token, e.g. arterm://192.168.1.42:7420#<fingerprint>.<secret>
        token: String,

        /// Label for the other device; defaults to its address until the two connect
        #[arg(long)]
        name: Option<String>,
    },

    /// List the devices this one trusts
    List {
        /// Emit JSON instead of human-readable output
        #[arg(long)]
        json: bool,
    },

    /// Show sessions across this machine and paired devices, grouped by device
    Sessions,

    /// Remove a device from the trust store, by name or fingerprint
    Forget {
        /// Device name, or its fingerprint
        device: String,
    },

    /// Change this device's display name; its fingerprint is unaffected
    Rename {
        /// New name
        name: String,
    },
}

pub(crate) fn handle(command: DeviceCommand) -> Result<()> {
    match command {
        DeviceCommand::Show { json } => show(json),
        DeviceCommand::Invite { address } => invite(&address),
        DeviceCommand::Join { token, name } => join(&token, name.as_deref()),
        DeviceCommand::List { json } => list(json),
        DeviceCommand::Sessions => sessions(),
        DeviceCommand::Forget { device } => forget(&device),
        DeviceCommand::Rename { name } => rename(&name),
    }
}

fn show(json: bool) -> Result<()> {
    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;
    if json {
        let payload = serde_json::json!({
            "name": identity.name(),
            "fingerprint": identity.fingerprint().to_hex(),
            "fingerprint_short": identity.fingerprint().to_display(),
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    println!("Device:      {}", identity.name());
    println!("Fingerprint: {}", identity.fingerprint().to_display());
    println!();
    println!("Full fingerprint (this is what another device verifies):");
    println!("  {}", identity.fingerprint().to_hex());
    Ok(())
}

fn invite(address: &str) -> Result<()> {
    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;
    let invite = Invite::mint(address, identity.fingerprint())?;
    let mut pending = PendingInvites::load().context("loading pending invites")?;
    pending.record(&invite)?;

    println!(
        "Invite for {} — valid for 10 minutes, single use:",
        identity.name()
    );
    println!();
    println!("  {}", invite.to_token());
    println!();
    println!("Run this on the other device:");
    println!("  arterm device join {}", invite.to_token());
    println!();
    println!("It carries the address, a one-time secret, and this device's fingerprint.");
    println!(
        "Anyone holding it can pair until it expires, so send it the way you would a password."
    );
    Ok(())
}

fn join(token: &str, name: Option<&str>) -> Result<()> {
    let invite = Invite::parse(token)?;
    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;

    if invite.fingerprint == identity.fingerprint() {
        anyhow::bail!(
            "this invite was minted by this same device — run `arterm device invite` on the other machine"
        );
    }

    let mut trust = TrustStore::load().context("loading the trust store")?;
    trust.trust(TrustedDevice {
        fingerprint: invite.fingerprint.to_hex(),
        name: name.unwrap_or(&invite.address).to_string(),
        address: Some(invite.address.clone()),
        paired_at: chrono::Utc::now().to_rfc3339(),
    })?;

    println!(
        "Trusted {} at {}.",
        invite.fingerprint.to_display(),
        invite.address
    );
    println!();
    println!("This device will now accept that one. The other direction completes when the two");
    println!("first connect, which needs the peer transport — not in this build yet.");
    Ok(())
}

fn list(json: bool) -> Result<()> {
    let trust = TrustStore::load().context("loading the trust store")?;
    if json {
        println!("{}", serde_json::to_string_pretty(trust.devices())?);
        return Ok(());
    }
    if trust.devices().is_empty() {
        println!("No paired devices.");
        println!();
        println!("Run `arterm device invite --address <host:port>` here, then");
        println!("`arterm device join <token>` on the other machine.");
        return Ok(());
    }
    println!("{} paired device(s):", trust.devices().len());
    for device in trust.devices() {
        let address = device.address.as_deref().unwrap_or("address unknown");
        println!();
        println!("  {}", device.name);
        println!(
            "    fingerprint  {}",
            short_fingerprint(&device.fingerprint)
        );
        println!("    address      {address}");
        println!("    paired       {}", device.paired_at);
    }
    Ok(())
}

fn sessions() -> Result<()> {
    let trust = TrustStore::load().context("loading the trust store")?;
    let local = crate::registry::running_local_servers_sync()
        .context("reading this machine's running servers")?;

    // No transport in this build: paired devices report nothing, so they show up
    // under their names with "no sessions reported yet". That empty state is the
    // seam the peer transport fills — see `arterm_session_aggregation`.
    let groups = arterm_session_aggregation::aggregate(
        local,
        &trust,
        &arterm_session_aggregation::NullRemoteSessions,
    );
    print!("{}", arterm_session_aggregation::render_plain(&groups));

    println!();
    if trust.devices().is_empty() {
        println!("No paired devices yet — only this machine's sessions appear.");
        println!("Pair one with `arterm device invite` here and `arterm device join` there.");
    } else {
        println!(
            "Remote session reporting needs the peer transport, which is not in this build yet."
        );
    }
    Ok(())
}

fn forget(needle: &str) -> Result<()> {
    let mut trust = TrustStore::load().context("loading the trust store")?;
    match trust.forget(needle)? {
        Some(device) => {
            println!(
                "Removed {} ({}). It can no longer connect to this device.",
                device.name,
                short_fingerprint(&device.fingerprint)
            );
            Ok(())
        }
        None => {
            anyhow::bail!("no paired device matches '{needle}' — `arterm device list` shows them")
        }
    }
}

fn rename(name: &str) -> Result<()> {
    let mut identity =
        DeviceIdentity::load_or_create().context("loading this device's identity")?;
    identity.set_name(name)?;
    println!("Renamed to {}.", identity.name());
    println!("Fingerprint is unchanged, so existing pairings are unaffected.");
    Ok(())
}

/// Grouped short form for a stored hex fingerprint, falling back to the raw
/// value when it is not one we can parse.
fn short_fingerprint(hex: &str) -> String {
    match arterm_device::identity::Fingerprint::from_hex(hex) {
        Ok(fingerprint) => fingerprint.to_display(),
        Err(_) => hex.to_string(),
    }
}
