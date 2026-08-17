//! One line each way, then get out of the arterm protocol's way.
//!
//! The peer handshake needs to say two things TLS cannot: which of the two
//! things this connection is (a session, or a first pairing), and — for a
//! pairing — the one-time secret from the invite. Both are exchanged as a
//! single newline-terminated JSON object in each direction, and then the stream
//! carries nothing but the ordinary newline-delimited `Request` / `ServerEvent`
//! traffic a local Unix-socket client sends.
//!
//! Reading is done a byte at a time up to the newline. That looks wasteful and
//! is not: the bytes are already decrypted in rustls' buffer, so there is no
//! extra round trip, and a buffered reader would swallow protocol bytes that
//! arrived in the same TLS record — which then have to be handed to the splice
//! by some other route, or are silently lost.

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Wire format version, so two machines on different arterm builds fail with a
/// sentence instead of a parse error halfway through a session.
pub const PEER_PROTOCOL_VERSION: u32 = 1;

/// Longest handshake line accepted. A real one is a couple of hundred bytes;
/// the cap is what stops a peer that has passed the fingerprint check from
/// making the listener buffer without limit.
///
/// It bounds *handshake* lines and nothing else. The session list is data, and
/// reading data under a handshake's limit is what broke the cross-machine list
/// on every machine with more than a handful of sessions — see
/// [`MAX_SESSION_LIST_BYTES`], which is the limit that reply is read under.
pub const MAX_HELLO_BYTES: usize = 4096;

/// Longest [`PeerWelcome::Sessions`] line accepted.
///
/// Sized against the worst thing that can arrive rather than a round number. A
/// machine scans at most 100 sessions for a list; the JSON field names of one
/// [`RemoteSessionSummary`] are 211 bytes before a single value is written, and
/// the longest first prompt measured on a real machine here was 4,899
/// characters. A peer that predates pagination sends all of that as one line,
/// so clearing it takes roughly a megabyte; 4 MiB leaves that case four times
/// the room it needs and still bounds what a verified peer can make this side
/// hold. A paginating peer never comes near it — a full page of
/// [`SESSION_PAGE_LIMIT`] worst-case rows is under 400 KiB.
pub const MAX_SESSION_LIST_BYTES: usize = 4 * 1024 * 1024;

/// Sessions asked for, and answered with, per page.
///
/// Picked so a page stays far under [`MAX_SESSION_LIST_BYTES`] even when every
/// row is as fat as a row can be: previews cut to [`MAX_PREVIEW_CHARS`] plus a
/// path-length working directory is about 6 KiB, so 64 rows is under 400 KiB,
/// a tenth of the cap. It also settles a typical machine in two round trips,
/// and those round trips run on a TLS stream that is already open.
pub const SESSION_PAGE_LIMIT: usize = 64;

/// Most pages a client will collect before giving up.
///
/// A peer that keeps saying "there is more" forever would otherwise grow the
/// caller's list without limit. 64 pages is 4,096 sessions — forty times what
/// a machine actually scans — so reaching it means the far end is broken, and
/// a named error is a better answer than an unbounded read.
pub const MAX_SESSION_LIST_PAGES: usize = 64;

/// Longest `prompt` or `title` put on the wire.
///
/// A list row shows a one-line preview, so a 4,899-character first prompt is
/// bytes nobody reads. Cutting here is what makes a page's size a property of
/// the page size rather than hostage to one enormous session.
pub const MAX_PREVIEW_CHARS: usize = 200;

/// One session on a peer, with enough to draw a row without opening it.
///
/// Only what a list row and its preview header show. Anything richer (the
/// transcript, tool calls) belongs to the session itself, which is one
/// `connect_to_peer` away.
///
/// Times are epoch milliseconds rather than `DateTime`: the wire should not
/// carry a formatting choice, and a peer whose clock is skewed is easier to
/// reason about as a number.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RemoteSessionSummary {
    pub id: String,
    /// Short display name, already extracted from the id by the far end.
    pub short_name: String,
    pub icon: String,
    pub title: String,
    /// First visible user prompt, which is what a compact row shows.
    pub prompt: String,
    pub message_count: usize,
    pub user_message_count: usize,
    pub assistant_message_count: usize,
    pub created_at_ms: i64,
    pub last_message_at_ms: i64,
    pub working_dir: Option<String>,
    pub model: Option<String>,
    pub estimated_tokens: usize,
    /// Whether the far end considers this session live.
    pub is_active: bool,
}

impl RemoteSessionSummary {
    /// This summary with its previews cut to [`MAX_PREVIEW_CHARS`].
    ///
    /// Applied by the side that answers, so the bound holds for every producer
    /// rather than for whichever one remembered.
    pub fn trimmed_for_wire(mut self) -> Self {
        self.title = trim_preview(self.title);
        self.prompt = trim_preview(self.prompt);
        self
    }
}

/// Cut a preview to [`MAX_PREVIEW_CHARS`], marking that it was cut.
///
/// Counted in characters rather than bytes: cutting UTF-8 by byte index splits
/// a multi-byte character, and this text is as often Turkish as English.
fn trim_preview(text: String) -> String {
    if text.chars().count() <= MAX_PREVIEW_CHARS {
        return text;
    }
    let mut cut: String = text.chars().take(MAX_PREVIEW_CHARS).collect();
    cut.push('…');
    cut
}

/// One server on a peer, as it appears in another machine's session list.
///
/// A trimmed [`arterm_base::registry::ServerInfo`] — this crate does not depend
/// on `arterm-base`, and the fields a remote list needs are only these. The CLI
/// that owns both sides converts to and from `ServerInfo`.
///
/// `sessions` and `details` describe the same sessions twice on purpose. A
/// build that predates `details` sends only the id list and ignores the field
/// it does not know, so pairing across versions keeps working in both
/// directions — an id-only list is a thin row, not a failed connection. That is
/// why this is an added field rather than a [`PEER_PROTOCOL_VERSION`] bump:
/// nothing on the wire had to change meaning.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RemoteServerSummary {
    pub name: String,
    pub icon: String,
    pub version: String,
    pub sessions: Vec<String>,
    #[serde(default)]
    pub details: Vec<RemoteSessionSummary>,
}

impl RemoteServerSummary {
    /// The sessions to display, preferring the detailed list.
    ///
    /// Falls back to synthesizing rows from the id list, so a peer on an older
    /// build still appears — with its sessions named but not described.
    pub fn display_sessions(&self) -> Vec<RemoteSessionSummary> {
        if !self.details.is_empty() {
            return self.details.clone();
        }
        self.sessions
            .iter()
            .map(|id| RemoteSessionSummary {
                id: id.clone(),
                short_name: id.clone(),
                ..RemoteSessionSummary::default()
            })
            .collect()
    }

    /// How many sessions this server is reporting.
    ///
    /// The larger of the two lists, because they are the same sessions twice
    /// and an older peer fills in only one of them. Paging counts sessions, so
    /// this is the unit an offset moves in.
    pub fn session_count(&self) -> usize {
        self.details.len().max(self.sessions.len())
    }

    /// This server carrying only sessions `start..end`, counted within itself.
    fn slice(&self, start: usize, end: usize) -> Self {
        Self {
            name: self.name.clone(),
            icon: self.icon.clone(),
            version: self.version.clone(),
            sessions: slice_of(&self.sessions, start, end),
            details: slice_of(&self.details, start, end),
        }
    }
}

/// `items[start..end]`, with both ends pulled inside the slice first.
///
/// The two lists on a server can be different lengths — an older peer sends
/// ids and no details — so a window computed from one must not index the other
/// out of bounds.
fn slice_of<T: Clone>(items: &[T], start: usize, end: usize) -> Vec<T> {
    let start = start.min(items.len());
    let end = end.min(items.len()).max(start);
    items[start..end].to_vec()
}

/// Sessions across every server, which is what a page offset counts in.
pub fn total_sessions(servers: &[RemoteServerSummary]) -> usize {
    servers.iter().map(RemoteServerSummary::session_count).sum()
}

/// One page of `servers`, and whether anything is left after it.
///
/// Sessions are numbered across the whole list — servers in the order given,
/// sessions in the order within each — so a window is a plain range and the
/// client's next offset is just "however many I was sent".
///
/// A server with nothing running rides on the first page only. It is real
/// information (that machine is listening and idle), and repeating it on every
/// page would make the client merge it into itself over and over.
pub fn page_of_servers(
    servers: &[RemoteServerSummary],
    offset: usize,
    limit: usize,
) -> (Vec<RemoteServerSummary>, bool) {
    let end = offset.saturating_add(limit);
    let mut page = Vec::new();
    let mut counted = 0usize;
    for server in servers {
        let count = server.session_count();
        let start = counted;
        counted += count;
        if count == 0 {
            if offset == 0 {
                page.push(server.clone());
            }
            continue;
        }
        let from = offset.max(start);
        let to = end.min(counted);
        if from < to {
            page.push(server.slice(from - start, to - start));
        }
    }
    (page, counted > end)
}

/// Fold one page into what the earlier pages already produced.
///
/// A server straddles a page boundary whenever its sessions do, so the same
/// server arrives more than once and its sessions have to be appended to the
/// copy already collected rather than pushed as a second heading. Matched by
/// name, which is what groups sessions on both sides of the wire.
pub fn merge_session_pages(
    collected: &mut Vec<RemoteServerSummary>,
    page: Vec<RemoteServerSummary>,
) {
    for server in page {
        match collected.iter_mut().find(|seen| seen.name == server.name) {
            Some(seen) => {
                seen.sessions.extend(server.sessions);
                seen.details.extend(server.details);
            }
            None => collected.push(server),
        }
    }
}

/// What the connecting device asks for.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerHello {
    /// Drive a session. Sent by a device that is already paired.
    Session {
        version: u32,
        name: String,
        /// Port this device accepts peer connections on, so the far end can
        /// record an address it can dial back on rather than guessing one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        listen_port: Option<u16>,
    },
    /// First contact: present the one-time secret from the invite.
    Pair {
        version: u32,
        name: String,
        secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        listen_port: Option<u16>,
    },
    /// Ask what sessions this device is running, without opening one. Answered
    /// with [`PeerWelcome::Sessions`] — this is what backs the cross-machine
    /// session list, distinct from driving a session. Only a paired device
    /// (past the fingerprint gate) may ask.
    ///
    /// Asking again on the same connection is how the rest of a long list is
    /// collected; the connection closes when a reply says there is no more.
    List {
        version: u32,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page: Option<SessionPage>,
    },
}

/// Which slice of a peer's session list to answer with.
///
/// Its *absence* is the signal that matters. A build that predates pagination
/// sends no `page` and reads exactly one reply, under [`MAX_HELLO_BYTES`], so a
/// device answering a request with no page has to answer it in one short line —
/// see [`sessions_within_budget`]. A request that carries a page came from a
/// build that will keep asking, and can be answered a page at a time.
///
/// This is an added optional field rather than a [`PEER_PROTOCOL_VERSION`]
/// bump, for the same reason `RemoteServerSummary::details` was: nothing on the
/// wire changed meaning, and both directions still work. A bump would be worse
/// than useless here — the listener refuses a version it does not recognise
/// outright, so bumping would turn a pairing that degrades gracefully into one
/// that stops working until both machines are updated.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionPage {
    /// Sessions to skip, counted across all servers in the order they are sent.
    #[serde(default)]
    pub offset: usize,
    /// Most sessions wanted. Zero means "you choose", and the answering side
    /// caps it at [`SESSION_PAGE_LIMIT`] regardless — a client asking for a
    /// page too big to read is answered with one it can read, and told there is
    /// more.
    #[serde(default)]
    pub limit: usize,
}

impl SessionPage {
    /// A page starting at `offset`, sized the way this build asks for them.
    pub fn at(offset: usize) -> Self {
        Self {
            offset,
            limit: SESSION_PAGE_LIMIT,
        }
    }

    /// The limit to actually answer with, whatever was asked for.
    pub fn effective_limit(&self) -> usize {
        match self.limit {
            0 => SESSION_PAGE_LIMIT,
            limit => limit.min(SESSION_PAGE_LIMIT),
        }
    }
}

impl PeerHello {
    pub fn version(&self) -> u32 {
        match self {
            Self::Session { version, .. }
            | Self::Pair { version, .. }
            | Self::List { version, .. } => *version,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Session { name, .. } | Self::Pair { name, .. } | Self::List { name, .. } => name,
        }
    }

    pub fn listen_port(&self) -> Option<u16> {
        match self {
            Self::Session { listen_port, .. } | Self::Pair { listen_port, .. } => *listen_port,
            Self::List { .. } => None,
        }
    }
}

/// What the accepting device answers.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerWelcome {
    /// Already paired. Everything after this line is the arterm protocol.
    Ready { version: u32, name: String },
    /// Pairing completed and recorded. Everything after this line is the
    /// arterm protocol, on the same connection — a second dial would prove
    /// nothing the secret has not already proved.
    Paired { version: u32, name: String },
    /// Answer to [`PeerHello::List`]: one page of the servers this device is
    /// running. Read under [`MAX_SESSION_LIST_BYTES`], not [`MAX_HELLO_BYTES`],
    /// because this line is data rather than a handshake.
    Sessions {
        version: u32,
        name: String,
        servers: Vec<RemoteServerSummary>,
        /// Whether another page is waiting and this connection is holding open
        /// for the [`PeerHello::List`] that asks for it.
        ///
        /// Not "sessions were left out" — a peer that asked without pagination
        /// is answered once, with as much as it can read, and told `false`
        /// because nothing further will be exchanged. `total` is where the
        /// honest count lives. Absent on the wire when false, which is also
        /// what a peer that predates pagination sends, so the default is what
        /// makes an old reply parse.
        #[serde(default, skip_serializing_if = "is_false")]
        more: bool,
        /// How many sessions exist across all pages, when the answering side
        /// knows. `None` from a peer that predates pagination.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total: Option<usize>,
    },
    /// Nothing further will be read from this connection.
    Refused { reason: String },
}

/// `skip_serializing_if` for a flag that is absent rather than false on the
/// wire, so a reply with nothing to paginate stays the shape an older peer
/// sends.
fn is_false(value: &bool) -> bool {
    !*value
}

impl PeerWelcome {
    pub fn peer_name(&self) -> Option<&str> {
        match self {
            Self::Ready { name, .. } | Self::Paired { name, .. } | Self::Sessions { name, .. } => {
                Some(name)
            }
            Self::Refused { .. } => None,
        }
    }
}

/// The largest [`PeerWelcome::Sessions`] answer that encodes to under `budget`.
///
/// For the one peer that cannot be paginated: a build predating [`SessionPage`]
/// reads exactly one reply and reads it under [`MAX_HELLO_BYTES`], so the only
/// way to answer it at all is to send as much as fits. Fewer sessions than
/// exist is a poor answer; it is a far better one than the parse error that
/// build gets today, and `total` still says how many there really are.
///
/// The search is by session count, which encoded length grows monotonically
/// with, so bisecting it is exact. If not even an empty page fits, the empty
/// page is sent anyway — there is nothing smaller to send, and the peer is no
/// worse off than before.
pub fn sessions_within_budget(
    version: u32,
    name: &str,
    servers: &[RemoteServerSummary],
    budget: usize,
) -> PeerWelcome {
    let total = total_sessions(servers);
    let build = |limit: usize| {
        let (page, _more) = page_of_servers(servers, 0, limit);
        PeerWelcome::Sessions {
            version,
            name: name.to_string(),
            servers: page,
            more: false,
            total: Some(total),
        }
    };
    let fits = |welcome: &PeerWelcome| match serde_json::to_vec(welcome) {
        // Strictly under, because the last byte of the budget is the newline
        // `write_line` appends.
        Ok(encoded) => encoded.len() < budget,
        // A summary that will not encode is not a summary that will fit.
        Err(_unencodable) => false,
    };

    let mut largest = 0usize;
    let mut low = 0usize;
    let mut high = total;
    while low <= high {
        let mid = low + (high - low) / 2;
        if fits(&build(mid)) {
            largest = mid;
            low = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }
    build(largest)
}

/// Send one JSON object followed by a newline.
pub async fn write_line<W, T>(writer: &mut W, value: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut encoded = serde_json::to_vec(value).context("encoding a peer handshake line")?;
    encoded.push(b'\n');
    writer
        .write_all(&encoded)
        .await
        .context("sending a peer handshake line")?;
    writer
        .flush()
        .await
        .context("flushing a peer handshake line")
}

/// Why a line could not be read.
///
/// Split because the caller's response differs: a peer that went away is the
/// ordinary case a cross-machine list is built to expect, while a line that
/// arrived and could not be used means something is actually wrong and has to
/// be visible. Collapsing the two is what let a 4 KiB cap on a data payload
/// hide behind "that machine must be asleep".
#[derive(Debug)]
pub enum LineError {
    /// The connection failed or ended mid-line. The far end went away.
    Transport(anyhow::Error),
    /// Something arrived, and it is not a line this side accepts: longer than
    /// the limit, or not the JSON expected here.
    Protocol(anyhow::Error),
}

impl LineError {
    /// The wrapped cause, whichever kind this is.
    pub fn cause(&self) -> &anyhow::Error {
        match self {
            Self::Transport(error) | Self::Protocol(error) => error,
        }
    }
}

impl std::fmt::Display for LineError {
    /// Always the full chain, alternate flag or not. Whatever wraps this — a
    /// context line, an `anyhow::Error`, a log call — the detail that names the
    /// real fault has to survive, and losing it is the failure mode this type
    /// exists to prevent.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.cause())
    }
}

impl std::error::Error for LineError {}

/// Read one newline-terminated JSON object, and not a byte more.
///
/// Bounded by [`MAX_HELLO_BYTES`], which is the right limit for a handshake and
/// the wrong one for anything larger — see [`read_line_with_limit`].
pub async fn read_line<R, T>(reader: &mut R) -> Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    read_line_with_limit(reader, MAX_HELLO_BYTES)
        .await
        .map_err(anyhow::Error::from)
}

/// Read one newline-terminated JSON object under a limit the caller picks.
///
/// The limit is an argument rather than a constant because the two things read
/// this way are not the same size: a handshake line is a couple of hundred
/// bytes and should never be more, while a session list is data whose size
/// follows from how many sessions a machine has. Baking the handshake's limit
/// into the reader made every list longer than 4 KiB fail as if the peer had
/// hung up.
///
/// Bounded either way. An unbounded read here is a peer that can make this
/// process allocate until it dies.
pub async fn read_line_with_limit<R, T>(reader: &mut R, max_bytes: usize) -> Result<T, LineError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut line = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let read = match reader.read(&mut byte).await {
            Ok(read) => read,
            Err(error) => {
                return Err(LineError::Transport(
                    anyhow::Error::new(error).context("reading a peer handshake line"),
                ));
            }
        };
        if read == 0 {
            return Err(LineError::Transport(anyhow::anyhow!(
                "the peer closed the connection before finishing its handshake line"
            )));
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() >= max_bytes {
            return Err(LineError::Protocol(anyhow::anyhow!(
                "the peer sent more than {max_bytes} bytes without ending its handshake line"
            )));
        }
        line.push(byte[0]);
    }
    serde_json::from_slice(&line)
        .context("this does not look like an arterm peer handshake")
        .map_err(LineError::Protocol)
}

#[cfg(test)]
#[path = "hello_tests.rs"]
mod hello_tests;
