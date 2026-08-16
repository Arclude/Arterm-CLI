//! Pairing another machine without leaving the session.
//!
//! Pairing used to be four steps across two terminals: mint a token here, start
//! a listener there, carry the token over, connect once to finish. Every one of
//! those was a place to be told you had done it wrong, and none of them was
//! about the decision a person actually makes — *that machine, over there, is
//! mine*.
//!
//! This screen is that decision. Opening it does three things at once: it
//! announces this machine on the local network, listens for the others doing
//! the same, and puts a six-digit code on screen. So both people do the same
//! thing — open it, find the other machine in the list, type the code it shows
//! — and there is no inviter and joiner to keep straight.
//!
//! Announcing stops when the screen closes, so a machine is only findable while
//! someone is looking at this.

use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use arterm_device::identity::Fingerprint;
use arterm_device::invite::PendingInvites;
use arterm_device::{DeviceIdentity, Invite, PendingJoins, TrustStore};
use arterm_peer::tls::PeerCredentials;
use arterm_peer::{DEFAULT_PEER_PORT, DiscoveredDevice, PeerTarget, Presence, connect_to_peer};

/// How many digits a pairing code has. Fixed, so the field can submit itself.
const CODE_LEN: usize = 6;

/// A machine on this screen, whether it is paired, nearby, or both.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRow {
    pub name: String,
    pub address: String,
    pub fingerprint: Fingerprint,
    pub state: RowState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    /// Paired and announcing itself right now.
    PairedNearby,
    /// Paired, but not heard from — asleep, elsewhere, or not on this screen.
    PairedAway,
    /// Announcing itself and not paired yet: the row Enter acts on.
    Nearby,
}

impl RowState {
    pub fn is_paired(self) -> bool {
        matches!(self, Self::PairedNearby | Self::PairedAway)
    }

    /// What the row says about itself, in the reader's terms.
    pub fn label(self) -> &'static str {
        match self {
            Self::PairedNearby => "paired · here",
            Self::PairedAway => "paired",
            Self::Nearby => "press enter to pair",
        }
    }
}

/// What a pairing attempt did, as the screen needs to say it.
pub enum PairOutcome {
    Paired { name: String },
    Refused { name: String, reason: String },
}

/// The pairing screen's whole state.
pub struct DevicePairing {
    /// This machine, as the other screen shows it.
    pub name: String,
    pub fingerprint: Fingerprint,
    /// The code the other machine's user types. Held whole; shown spaced.
    code: String,
    /// Where this machine is reachable, when it could work that out.
    pub address: Option<String>,

    presence: Arc<Mutex<Option<Presence>>>,
    rows: Vec<DeviceRow>,
    selected: usize,
    /// Digits typed so far for the selected machine, when pairing with it.
    entry: Option<String>,
    status: Option<String>,
    pending: Option<Receiver<PairOutcome>>,
}

impl DevicePairing {
    /// Open the screen: mint this machine's code and start announcing it.
    ///
    /// The code is recorded as a pending invite before anything is shown, so a
    /// machine that reads it off the screen can spend it immediately.
    pub fn open() -> Result<Self> {
        let identity =
            DeviceIdentity::load_or_create().context("loading this device's identity")?;
        let address = match arterm_peer::subnet::default_bind_ip() {
            Ok(ip) => Some(format!("{ip}:{DEFAULT_PEER_PORT}")),
            // Off every network: there is nowhere for anyone to connect, and
            // the screen says that rather than showing an unusable code.
            Err(_no_network) => None,
        };

        // With no address there is nowhere for anyone to connect, so there is
        // no point minting a code — the screen says so instead of showing six
        // digits that cannot work.
        let code = match &address {
            Some(address) => {
                let invite = Invite::mint_code(address, identity.fingerprint())?;
                PendingInvites::load()
                    .context("loading pending invites")?
                    .record(&invite)
                    .context("recording this machine's pairing code")?;
                invite.secret
            }
            None => String::new(),
        };

        let presence = Arc::new(Mutex::new(None));
        spawn_presence(
            Arc::clone(&presence),
            identity.name().to_string(),
            identity.fingerprint(),
        );

        let mut screen = Self {
            name: identity.name().to_string(),
            fingerprint: identity.fingerprint(),
            code,
            address,
            presence,
            rows: Vec::new(),
            selected: 0,
            entry: None,
            status: None,
            pending: None,
        };
        screen.refresh();
        Ok(screen)
    }

    /// This machine's code, spaced the way it is read aloud.
    pub fn code(&self) -> String {
        if self.code.len() == CODE_LEN {
            format!("{} {}", &self.code[..3], &self.code[3..])
        } else {
            self.code.clone()
        }
    }

    /// Whether this machine is managing to announce itself at all.
    ///
    /// A network that refuses broadcast would otherwise leave both screens
    /// empty with nothing to say about why.
    pub fn is_announcing(&self) -> bool {
        match self.presence.lock() {
            Ok(presence) => presence.as_ref().is_some_and(Presence::is_announcing),
            // A poisoned lock means the announcing task panicked, which is
            // exactly the case where "we are announcing" would be a lie.
            Err(_poisoned) => false,
        }
    }

    pub fn rows(&self) -> &[DeviceRow] {
        &self.rows
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Digits typed so far, when a machine has been chosen.
    pub fn entry(&self) -> Option<&str> {
        self.entry.as_deref()
    }

    pub fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    /// The machine Enter would act on.
    pub fn selected_row(&self) -> Option<&DeviceRow> {
        self.rows.get(self.selected)
    }

    /// Rebuild the list and collect any finished pairing. Called every tick.
    ///
    /// Returns whether anything changed, so the caller only redraws when it did.
    pub fn tick(&mut self) -> bool {
        let before = (self.rows.clone(), self.status.clone());
        self.collect_pairing_result();
        self.refresh();
        (self.rows.clone(), self.status.clone()) != before
    }

    fn collect_pairing_result(&mut self) {
        let Some(receiver) = &self.pending else {
            return;
        };
        match receiver.try_recv() {
            Ok(PairOutcome::Paired { name }) => {
                self.status = Some(format!("Paired with {name}."));
                self.pending = None;
                self.entry = None;
            }
            Ok(PairOutcome::Refused { name, reason }) => {
                self.status = Some(format!("{name} refused the code: {reason}"));
                self.pending = None;
                self.entry = None;
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.status = Some("The pairing attempt stopped before it finished.".to_string());
                self.pending = None;
                self.entry = None;
            }
        }
    }

    /// Merge what is paired with what is nearby.
    ///
    /// A paired machine that is also announcing appears once, as paired: the
    /// list answers "which machines are mine" first and "which are here"
    /// second, and a machine listed twice makes both questions harder.
    fn refresh(&mut self) {
        let nearby = match self.presence.lock() {
            // `None` is the ordinary case for the first moments: the socket is
            // still opening, so nothing has been heard yet.
            Ok(presence) => presence.as_ref().map_or_else(Vec::new, Presence::seen),
            Err(_poisoned) => Vec::new(),
        };
        let trusted = match TrustStore::load() {
            Ok(store) => store.devices().to_vec(),
            // An unreadable trust store costs the paired half of the list, not
            // the screen: machines nearby can still be seen and paired with.
            Err(_unreadable) => Vec::new(),
        };

        self.rows = merge_rows(&trusted, &nearby);
        self.selected = self.selected.min(self.rows.len().saturating_sub(1));
    }

    pub fn move_selection(&mut self, delta: isize) {
        if self.rows.is_empty() {
            return;
        }
        let last = self.rows.len() - 1;
        self.selected = match delta {
            d if d < 0 => self.selected.saturating_sub(d.unsigned_abs()),
            d => (self.selected + d as usize).min(last),
        };
        // Choosing a different machine abandons the digits typed for the last
        // one, which is what someone who just moved the cursor expects.
        self.entry = None;
    }

    /// Enter on the selected row: start typing a code, or spend the one typed.
    ///
    /// Returns false when there is nothing to act on, so the caller can leave
    /// the key to whatever else wants it.
    pub fn activate(&mut self) -> bool {
        let Some(row) = self.rows.get(self.selected).cloned() else {
            return false;
        };
        if row.state.is_paired() {
            self.status = Some(format!("{} is already paired.", row.name));
            return true;
        }
        match self.entry.take() {
            Some(code) if code.len() == CODE_LEN => {
                self.begin_pairing(row, code);
                true
            }
            Some(code) => {
                self.entry = Some(code);
                self.status = Some(format!("The code is {CODE_LEN} digits."));
                true
            }
            None => {
                self.entry = Some(String::new());
                self.status = Some(format!("Type the code shown on {}.", row.name));
                true
            }
        }
    }

    /// A digit typed while a machine is chosen. Submits itself when full.
    pub fn push_digit(&mut self, digit: char) -> bool {
        let Some(entry) = &mut self.entry else {
            return false;
        };
        if !digit.is_ascii_digit() || entry.len() >= CODE_LEN {
            return false;
        }
        entry.push(digit);
        if entry.len() == CODE_LEN {
            self.activate();
        }
        true
    }

    pub fn pop_digit(&mut self) -> bool {
        let Some(entry) = &mut self.entry else {
            return false;
        };
        entry.pop();
        true
    }

    /// Escape: give up the code being typed, or ask to close the screen.
    pub fn cancel_entry(&mut self) -> bool {
        if self.entry.take().is_some() {
            self.status = None;
            return true;
        }
        false
    }

    fn begin_pairing(&mut self, row: DeviceRow, code: String) {
        let (sender, receiver) = std::sync::mpsc::channel();
        self.pending = Some(receiver);
        self.status = Some(format!("Pairing with {}…", row.name));

        tokio::spawn(async move {
            let name = row.name.clone();
            let outcome = match pair_with(&row, &code).await {
                Ok(()) => PairOutcome::Paired { name },
                Err(error) => PairOutcome::Refused {
                    name,
                    reason: format!("{error:#}"),
                },
            };
            let _delivered = sender.send(outcome);
        });
    }
}

/// The list, from what is paired and what is nearby.
///
/// A paired machine that is also announcing appears once, as paired: the screen
/// answers "which machines are mine" first and "which are here" second, and a
/// machine listed twice makes both questions harder to answer.
///
/// Paired rows come first and keep the trust store's order, so a list someone
/// has learned does not rearrange itself every time a laptop wakes up.
fn merge_rows(
    trusted: &[arterm_device::TrustedDevice],
    nearby: &[DiscoveredDevice],
) -> Vec<DeviceRow> {
    let mut rows = Vec::new();

    for device in trusted {
        // A trust entry whose fingerprint cannot be parsed cannot be matched
        // against a beacon or dialled, so it is not a machine anyone can act on.
        let Ok(fingerprint) = Fingerprint::from_hex(&device.fingerprint) else {
            continue;
        };
        let here = nearby.iter().find(|seen| seen.fingerprint == fingerprint);
        rows.push(DeviceRow {
            // A device recorded before the two machines ever spoke is named
            // after its address; a beacon knows the machine's real name.
            name: here.map_or_else(|| device.name.clone(), |seen| seen.name.clone()),
            address: match here {
                Some(seen) => seen.address_string(),
                // Paired but never connected, so no address was ever recorded.
                // An em dash reads as "nothing here"; a blank reads as a bug.
                None => device.address.clone().unwrap_or_else(|| "—".to_string()),
            },
            fingerprint,
            state: if here.is_some() {
                RowState::PairedNearby
            } else {
                RowState::PairedAway
            },
        });
    }

    for device in nearby {
        if rows.iter().any(|row| row.fingerprint == device.fingerprint) {
            continue;
        }
        rows.push(DeviceRow {
            name: device.name.clone(),
            address: device.address_string(),
            fingerprint: device.fingerprint.clone(),
            state: RowState::Nearby,
        });
    }

    rows
}

/// Trust the chosen machine, then spend the code on it.
///
/// Both halves are needed and in this order: recording trust first is what lets
/// the connection be made at all, and the connection is what makes the *other*
/// machine record this one. Stopping after the first would leave a pairing that
/// looks done on one side only.
async fn pair_with(row: &DeviceRow, code: &str) -> Result<()> {
    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;
    if row.fingerprint == identity.fingerprint() {
        anyhow::bail!("that is this machine");
    }

    let invite = Invite {
        address: row.address.clone(),
        fingerprint: row.fingerprint.clone(),
        secret: code.to_string(),
    };

    let mut trust = TrustStore::load().context("loading the trust store")?;
    trust.trust(arterm_device::TrustedDevice {
        fingerprint: row.fingerprint.to_hex(),
        name: row.name.clone(),
        address: Some(row.address.clone()),
        paired_at: chrono::Utc::now().to_rfc3339(),
    })?;
    PendingJoins::load()
        .context("loading pending joins")?
        .record(&invite)?;

    let credentials = PeerCredentials::from_identity(&identity)?;
    let target = PeerTarget {
        address: row.address.clone(),
        fingerprint: row.fingerprint.clone(),
    };
    let link = connect_to_peer(&credentials, &target, Some(code), Some(DEFAULT_PEER_PORT)).await?;
    if !link.paired_now {
        anyhow::bail!("the code was not accepted");
    }
    Ok(())
}

/// Start announcing in the background, since opening a socket is async and the
/// screen has to appear now.
fn spawn_presence(slot: Arc<Mutex<Option<Presence>>>, name: String, fingerprint: Fingerprint) {
    tokio::spawn(async move {
        match Presence::open(&name, &fingerprint, DEFAULT_PEER_PORT).await {
            Ok(presence) => {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(presence);
                }
            }
            Err(error) => {
                crate::logging::warn(&format!("Could not announce this machine: {error:#}"));
            }
        }
    });
}

/// The pairing screen as the renderer needs it, borrowed rather than copied.
///
/// A separate type because drawing happens through `TuiState`, which the screen
/// itself cannot cross: the trait is implemented for things that are not an
/// `App` at all.
pub struct DevicePairingView<'a> {
    pub name: &'a str,
    pub fingerprint: String,
    pub code: String,
    pub address: Option<&'a str>,
    pub announcing: bool,
    pub rows: &'a [DeviceRow],
    pub selected: usize,
    pub entry: Option<&'a str>,
    pub status: Option<&'a str>,
}

impl DevicePairing {
    /// Everything the screen draws, in one borrow.
    pub fn view(&self) -> DevicePairingView<'_> {
        DevicePairingView {
            name: &self.name,
            fingerprint: self.fingerprint.to_display(),
            code: self.code(),
            address: self.address.as_deref(),
            announcing: self.is_announcing(),
            rows: &self.rows,
            selected: self.selected,
            entry: self.entry.as_deref(),
            status: self.status.as_deref(),
        }
    }
}

#[cfg(test)]
#[path = "device_pairing_tests.rs"]
mod device_pairing_tests;
