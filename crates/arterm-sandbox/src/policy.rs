//! Runtime-neutral sandbox policy types.
//!
//! Modeled after the OpenSandbox architecture: the policy is plain data that
//! any runtime (Landlock, Seatbelt, a future container runtime) can enforce,
//! and every policy has observable outcomes (`SandboxResult` carries the
//! enforcement mode, what was applied, and what was skipped and why).
//!
//! Policy precedence follows OpenSandbox's "secure defaults with explicit
//! escape hatches": the filesystem mode implies a network policy unless the
//! user overrides it, and `deny` rules always win over `allow` rules.

use std::path::PathBuf;

/// The sandbox filesystem policy.
///
/// **The variant order is the policy order**, strictest first, and `Ord` is
/// derived from it. That is what lets a floor be expressed as
/// [`SandboxMode::strictest`] rather than as a table somebody has to remember
/// to extend. Reordering these variants silently reverses which mode wins a
/// clamp, so `mode_order_is_strictest_first` pins it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SandboxMode {
    /// No filesystem writes, no network access. Read-only exploration.
    Readonly,
    /// Write access to the working directory and temp directories only.
    /// Network follows the configured egress policy (default: localhost only).
    WorkspaceWrite,
    /// No sandbox restrictions. Equivalent to running without a sandbox.
    FullAccess,
}

impl SandboxMode {
    pub fn is_sandboxed(self) -> bool {
        !matches!(self, SandboxMode::FullAccess)
    }

    /// Whichever of the two grants less.
    ///
    /// Used to clamp a requested mode against a floor: the answer is never
    /// looser than either input, so a setting can tighten a floor and cannot
    /// widen one.
    pub fn strictest(self, other: Self) -> Self {
        self.min(other)
    }
}

impl std::fmt::Display for SandboxMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxMode::Readonly => write!(f, "read-only"),
            SandboxMode::WorkspaceWrite => write!(f, "workspace-write"),
            SandboxMode::FullAccess => write!(f, "full-access"),
        }
    }
}

impl std::str::FromStr for SandboxMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "read-only" | "readonly" => Ok(SandboxMode::Readonly),
            "workspace-write" | "workspace" => Ok(SandboxMode::WorkspaceWrite),
            "full-access" | "full" | "none" | "off" => Ok(SandboxMode::FullAccess),
            _ => Err(format!(
                "unknown sandbox mode '{s}'; expected read-only, workspace-write, or full-access"
            )),
        }
    }
}

/// Default action for outbound connections when no rule matches.
///
/// Mirrors OpenSandbox `NetworkPolicy.defaultAction`, except that an omitted
/// policy must never degrade to allow-all: Arterm's implied default is `Deny`
/// for sandboxed modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EgressDefault {
    #[default]
    Deny,
    Allow,
}

/// A single egress rule: allow or deny a target.
///
/// Mirrors OpenSandbox `NetworkRule` (action + target). Landlock cannot
/// filter by FQDN, so targets are enforced at the port level; the domain
/// list is preserved for runtimes that can honor it and for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressRule {
    pub action: EgressAction,
    /// Target: a TCP port, or `*` for any port.
    pub target: EgressTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressAction {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressTarget {
    /// Any outbound TCP port.
    AnyPort,
    /// A specific TCP port.
    Port(u16),
    /// A domain (or wildcard domain like `*.example.com`). Kept for
    /// diagnostics and runtimes that can enforce FQDN policies.
    Domain(String),
}

impl EgressRule {
    pub fn allow_port(port: u16) -> Self {
        Self {
            action: EgressAction::Allow,
            target: EgressTarget::Port(port),
        }
    }

    pub fn allow_any() -> Self {
        Self {
            action: EgressAction::Allow,
            target: EgressTarget::AnyPort,
        }
    }

    pub fn deny_port(port: u16) -> Self {
        Self {
            action: EgressAction::Deny,
            target: EgressTarget::Port(port),
        }
    }

    /// Whether this rule permits an outbound connection to `port`.
    fn decides(&self, port: u16) -> Option<bool> {
        match self.target {
            EgressTarget::AnyPort => Some(self.action == EgressAction::Allow),
            EgressTarget::Port(p) if p == port => Some(self.action == EgressAction::Allow),
            _ => None,
        }
    }
}

/// The full runtime-neutral sandbox policy: filesystem + network.
///
/// Mirrors the OpenSandbox split between lifecycle request parameters
/// (here: `mode`, `working_dir`, `writable_roots`) and `networkPolicy`
/// (here: `egress`).
#[derive(Debug, Clone)]
pub struct SandboxConfig {
    pub mode: SandboxMode,
    /// The working directory the tool is executing in.
    pub working_dir: Option<PathBuf>,
    /// Extra directories that should be writable (e.g. cargo registry, cache).
    pub writable_roots: Vec<PathBuf>,
    /// Outbound network policy. `None` means the mode's implied default.
    pub egress: Option<NetworkPolicy>,
}

/// Outbound network policy, mirroring OpenSandbox `NetworkPolicy`.
#[derive(Debug, Clone)]
pub struct NetworkPolicy {
    pub default_action: EgressDefault,
    pub rules: Vec<EgressRule>,
}

impl NetworkPolicy {
    /// Port-only allowlist policy: allow the given ports, deny everything else.
    pub fn allow_ports(ports: &[u16]) -> Self {
        Self {
            default_action: EgressDefault::Deny,
            rules: ports.iter().map(|&p| EgressRule::allow_port(p)).collect(),
        }
    }

    /// Whether an outbound TCP connection to `port` is permitted.
    pub fn permits(&self, port: u16) -> bool {
        // Deny rules always win, mirroring "deny overrides allow" semantics.
        if self.rules.iter().any(|r| r.decides(port) == Some(false)) {
            return false;
        }
        if self.rules.iter().any(|r| r.decides(port) == Some(true)) {
            return true;
        }
        self.default_action == EgressDefault::Allow
    }

    /// Ports allowed by this policy, if enumerable. `None` means "not
    /// enumerable" (default allow, or a rule set too broad to enumerate).
    pub fn allowed_ports(&self) -> Option<Vec<u16>> {
        if self.default_action == EgressDefault::Allow {
            // Only enumerable when there is an explicit deny-everything rule.
            if self
                .rules
                .iter()
                .any(|r| r.action == EgressAction::Deny && r.target == EgressTarget::AnyPort)
            {
                return Some(Vec::new());
            }
            return None;
        }
        let mut ports: Vec<u16> = self
            .rules
            .iter()
            .filter(|r| {
                r.action == EgressAction::Allow && matches!(r.target, EgressTarget::Port(_))
            })
            .filter_map(|r| match r.target {
                EgressTarget::Port(p) => Some(p),
                _ => None,
            })
            .collect();
        ports.sort_unstable();
        ports.dedup();
        Some(ports)
    }
}

impl SandboxConfig {
    pub fn new(mode: SandboxMode, working_dir: Option<PathBuf>) -> Self {
        Self {
            mode,
            working_dir,
            writable_roots: Vec::new(),
            egress: None,
        }
    }

    pub fn with_writable_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.writable_roots = roots;
        self
    }

    pub fn with_egress(mut self, policy: NetworkPolicy) -> Self {
        self.egress = Some(policy);
        self
    }

    /// The effective network policy. The filesystem mode implies one when the
    /// user has not configured an explicit policy.
    pub fn effective_egress(&self) -> NetworkPolicy {
        if let Some(policy) = &self.egress {
            return policy.clone();
        }
        match self.mode {
            SandboxMode::Readonly => NetworkPolicy {
                default_action: EgressDefault::Deny,
                rules: vec![],
            },
            SandboxMode::WorkspaceWrite => NetworkPolicy::allow_ports(&[
                53,  // DNS
                80,  // HTTP
                443, // HTTPS
                // Local development servers
                3000, 5173, 8080, 9000,
            ]),
            SandboxMode::FullAccess => NetworkPolicy {
                default_action: EgressDefault::Allow,
                rules: vec![],
            },
        }
    }

    /// Collect all directories that should be writable in WorkspaceWrite mode.
    pub(crate) fn writable_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::new();

        // Working directory and all ancestors up to root (for traversal)
        if let Some(ref wd) = self.working_dir {
            paths.push(wd.clone());
        }

        // System temp directories
        if let Some(tmp) = std::env::temp_dir().to_str() {
            paths.push(PathBuf::from(tmp));
        }

        // Tool scratch directory
        if let Some(ref scratch) = std::env::var_os("ARTERM_SCRATCH_DIR") {
            paths.push(PathBuf::from(scratch));
        }

        // User-configured writable roots
        paths.extend(self.writable_roots.iter().cloned());

        paths
    }
}

/// The result of attempting to apply a sandbox.
#[derive(Debug)]
pub struct SandboxResult {
    /// Whether the sandbox was successfully applied.
    pub applied: bool,
    /// A human-readable description of what happened, for diagnostics.
    pub message: String,
}

impl SandboxResult {
    pub(crate) fn applied(msg: impl Into<String>) -> Self {
        Self {
            applied: true,
            message: msg.into(),
        }
    }

    pub(crate) fn skipped(msg: impl Into<String>) -> Self {
        Self {
            applied: false,
            message: msg.into(),
        }
    }
}
