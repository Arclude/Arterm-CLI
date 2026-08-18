//! Where a file write made *inside this process* is allowed to land.
//!
//! `arterm_sandbox` restricts a **child** process: bash applies Landlock in a
//! `pre_exec` hook (or wraps the command with Seatbelt on macOS), and the
//! arterm process itself never calls `landlock_restrict_self`. Every tool that
//! writes through `std::fs`/`tokio::fs` instead of shelling out -- write, edit,
//! multiedit, patch, apply_patch, undo -- therefore ran with no sandbox at all.
//! Measured: with `sandbox_mode = "workspace-write"`, `write` happily created a
//! file outside the workspace that bash was refused.
//!
//! This module is the missing half. It cannot use Landlock (that would restrict
//! the whole session, including the parts of arterm that legitimately write
//! outside the workspace), so it enforces the same policy in user space, before
//! the write happens.
//!
//! # The policy, and why it matches bash rather than being stricter
//!
//! A user learns what `workspace-write` means from whichever tool refuses them
//! first. If bash and `write` disagree about it, the word means nothing. So the
//! writable roots here mirror [`SandboxConfig::writable_paths`] in
//! `arterm-sandbox` exactly:
//!
//! - the session working directory,
//! - the system temp directory (`std::env::temp_dir()`),
//! - `$ARTERM_SCRATCH_DIR` when set,
//! - the directories named by the `sandbox_writable_roots` config key,
//! - the character devices in `ALWAYS_WRITABLE_DEVICES` (`/dev/null` and
//!   friends), which hold no user data and which the Landlock policy allows for
//!   the same reason.
//!
//! The fourth entry is where the parity is easiest to lose, so it is not
//! mirrored but *shared*: [`configured_roots`] is the one function that turns
//! the config key into directories, and `bash.rs` calls it to build the
//! `SandboxConfig` it hands to Landlock. The two paths cannot disagree about
//! which extra directories exist, because only one of them decides.
//!
//! `read-only` is the one deliberate divergence: Landlock still allows the temp
//! directory there, because bash needs a working `TMPDIR` for its own internal
//! files. That is an implementation necessity of running a shell, not a promise
//! to the user. A `write` call has no such need -- an agent asking to create a
//! temp file in read-only mode is asking to modify the filesystem -- so
//! read-only refuses every path.
//!
//! [`SandboxConfig::writable_paths`]: arterm_sandbox::SandboxConfig

use super::permission_gate::GateOutcome;
use super::{ToolContext, ToolExecutionMode};
use arterm_sandbox::SandboxMode;
use std::path::{Component, Path, PathBuf};

/// The context a tool call runs in, with its sandbox read from the live config.
///
/// Every production call site builds its context here rather than writing a
/// `ToolContext { .. }` literal, because the sandbox is two fields --
/// `sandbox_mode` and `sandbox_writable_roots` -- and naming one while
/// forgetting the other yields a session that reports a sandbox it is not
/// enforcing. Filling them is not a step a call site can skip, because filling
/// them is not a step a call site performs.
///
/// The remaining fields are written out rather than left to
/// `..Default::default()` on purpose: a new field on [`ToolContext`] should
/// stop the build here and make its author say what a tool call means by it.
/// `stdin_request_tx` and `graceful_shutdown_signal` are the two an agent turn
/// then fills in for itself -- see `Agent::tool_context`.
///
/// The three ids are in the same order as the struct declares them.
pub fn tool_context(
    session_id: String,
    message_id: String,
    tool_call_id: String,
    working_dir: Option<PathBuf>,
    execution_mode: ToolExecutionMode,
) -> ToolContext {
    let config = crate::config::config();
    ToolContext {
        session_id,
        message_id,
        tool_call_id,
        working_dir,
        stdin_request_tx: None,
        graceful_shutdown_signal: None,
        execution_mode,
        sandbox_mode: config.sandbox_mode.clone(),
        sandbox_writable_roots: config.sandbox_writable_root_paths(),
    }
}

/// How many symlinks one path may traverse before the boundary gives up and
/// refuses. Matches the kernel's own `ELOOP` ceiling closely enough: past this
/// point the path is a loop, and an unresolvable path is refused rather than
/// judged on its unresolved spelling.
const MAX_SYMLINK_HOPS: usize = 40;

/// Devices a sandboxed command may write, mirroring `ALWAYS_WRITABLE_DEVICES`
/// in `arterm-sandbox/src/linux.rs`. Kept as a copy rather than a shared
/// constant because that one is private to the Landlock implementation; the
/// list is stable, and the parity it buys is what matters. `/dev` as a whole is
/// deliberately *not* here -- that would hand out raw block devices.
const ALWAYS_WRITABLE_DEVICES: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/ptmx",
    "/dev/pts",
];

/// Refuse the write unless `sandbox_mode` permits it.
///
/// The call site is one `?` in each in-process writer, before it touches disk
/// (and before it records an undo checkpoint, so a refused write leaves no
/// trace).
pub(super) fn ensure_writable(ctx: &ToolContext, path: &Path) -> anyhow::Result<()> {
    match check(ctx, path) {
        GateOutcome::Allow => Ok(()),
        GateOutcome::Blocked { message, .. } => Err(anyhow::anyhow!(message)),
    }
}

/// The decision, in the same vocabulary the permission gate uses.
pub(super) fn check(ctx: &ToolContext, path: &Path) -> GateOutcome {
    match Boundary::from_context(ctx) {
        Some(boundary) => boundary.judge(path),
        None => GateOutcome::Allow,
    }
}

/// One session's writable region.
struct Boundary {
    mode: SandboxMode,
    /// Directory a relative path is resolved against: the session working
    /// directory, or the process cwd when the session has none.
    base: PathBuf,
    /// Resolved directories a write may land in. Empty in read-only mode.
    roots: Vec<PathBuf>,
}

impl Boundary {
    /// `None` when nothing is enforced: `full-access`, an empty mode, or a
    /// spelling that does not parse. The unparseable case fails *open* on
    /// purpose -- it is exactly what `bash.rs` does with the same string, and a
    /// typo that silently disabled bash's sandbox while stopping `write` would
    /// be a worse surprise than one that disables both.
    fn from_context(ctx: &ToolContext) -> Option<Self> {
        let Ok(mode) = ctx.sandbox_mode.trim().parse::<SandboxMode>() else {
            return None;
        };
        if !mode.is_sandboxed() {
            return None;
        }
        let base = base_dir(ctx);
        let extra = configured_roots_within(mode, &base, &ctx.sandbox_writable_roots);
        let roots = writable_roots(mode, Some(&base), &extra);
        Some(Self::new(mode, base, roots))
    }

    /// Roots are resolved once, here, so that a workspace reached through a
    /// symlink (`/tmp` on macOS, a symlinked checkout) still recognises its own
    /// files. A root that cannot be resolved is dropped: an unresolvable root
    /// grants nothing rather than granting everything.
    fn new(mode: SandboxMode, base: PathBuf, roots: Vec<PathBuf>) -> Self {
        let base = resolve(&base, Path::new("/")).unwrap_or(base);
        let roots = roots
            .iter()
            .filter_map(|root| match resolve(root, &base) {
                Ok(resolved) if !resolved.as_os_str().is_empty() => Some(resolved),
                _ => None,
            })
            .collect();
        Self { mode, base, roots }
    }

    fn judge(&self, path: &Path) -> GateOutcome {
        let resolved = match resolve(path, &self.base) {
            Ok(resolved) => resolved,
            Err(why) => {
                return GateOutcome::Blocked {
                    reason: "sandbox boundary: the path could not be resolved",
                    message: format!(
                        "sandbox_mode = \"{}\" refused this write: {} could not be resolved ({}), \
                         so it cannot be shown to be inside the workspace. This is the sandbox \
                         refusing the write, not a missing file.",
                        self.mode,
                        path.display(),
                        why
                    ),
                };
            }
        };
        if self.permits(&resolved) {
            return GateOutcome::Allow;
        }
        GateOutcome::Blocked {
            reason: "sandbox boundary: path outside the writable roots",
            message: self.refusal(path, &resolved),
        }
    }

    fn permits(&self, resolved: &Path) -> bool {
        self.roots.iter().any(|root| resolved.starts_with(root))
    }

    fn refusal(&self, requested: &Path, resolved: &Path) -> String {
        let mut message = format!(
            "sandbox_mode = \"{}\" refused this write: {}",
            self.mode,
            requested.display()
        );
        if resolved != requested {
            message.push_str(&format!(" (which resolves to {})", resolved.display()));
        }
        // The way out differs by mode, and naming the wrong one wastes the
        // reader's time: `sandbox_writable_roots` widens `workspace-write` by
        // one directory but does nothing at all in read-only, where the only
        // answer is a different mode.
        match self.mode {
            SandboxMode::Readonly => {
                message.push_str(
                    ". read-only mode modifies no files at all. This is the sandbox refusing \
                     the write, not a missing file or a failed write -- nothing was changed on \
                     disk. A session that needs to write files needs a different sandbox_mode \
                     in config.toml.",
                );
            }
            _ => {
                message.push_str(&format!(
                    ". It is outside every writable root: {}. This is the sandbox refusing the \
                     write, not a missing file or a failed write -- nothing was changed on disk. \
                     Write inside the workspace instead, or add the directory to \
                     sandbox_writable_roots in config.toml to make just that one writable \
                     (it must already exist) -- sandbox_mode = \"full-access\" turns the whole \
                     sandbox off and is rarely what is wanted.",
                    self.roots_summary()
                ));
            }
        }
        message
    }

    fn roots_summary(&self) -> String {
        if self.roots.is_empty() {
            return "none".to_string();
        }
        self.roots
            .iter()
            // The device allowances are noise in a refusal about a file path.
            .filter(|root| !ALWAYS_WRITABLE_DEVICES.contains(&root.to_string_lossy().as_ref()))
            .map(|root| root.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// The kernel-level sandbox this context asks for, or `None` for none.
///
/// Lives here rather than in `bash.rs` because this module owns what the
/// policy *is*; `bash.rs` only hands the result to `pre_exec`. Keeping both
/// halves in one file is also what makes it obvious that they read the same
/// [`configured_roots`].
///
/// A mode that does not parse yields `None`, i.e. no sandbox. That failure is
/// open on purpose and [`Boundary::from_context`] does the same with the same
/// string: a typo that silently disabled bash's sandbox while still stopping
/// `write` would be a worse surprise than one that disables both.
pub(super) fn sandbox_config_from_context(
    ctx: &ToolContext,
) -> Option<arterm_sandbox::SandboxConfig> {
    let Ok(mode) = ctx.sandbox_mode.parse::<SandboxMode>() else {
        return None;
    };
    if !mode.is_sandboxed() {
        return None;
    }
    Some(
        arterm_sandbox::SandboxConfig::new(mode, ctx.working_dir.clone())
            .with_writable_roots(configured_roots(ctx)),
    )
}

/// The directory a relative path is resolved against: the session working
/// directory, or the process cwd when the session has none.
///
/// A session that recorded no working directory is judged against the process
/// cwd, which is where `ToolContext::resolve_path` would have put its relative
/// writes anyway -- so the workspace it is confined to is the one it was
/// already writing into.
fn base_dir(ctx: &ToolContext) -> PathBuf {
    match ctx.working_dir.clone() {
        Some(dir) => dir,
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

/// The extra writable directories this session's `sandbox_writable_roots` asks
/// for, ready to hand to a sandbox runtime.
///
/// **This is the shared half.** `bash.rs` calls it to build the `SandboxConfig`
/// that becomes Landlock/Seatbelt rules, and [`Boundary::from_context`] calls
/// it for the in-process check. One implementation, so a directory is writable
/// through `bash` exactly when it is writable through `write`.
pub(super) fn configured_roots(ctx: &ToolContext) -> Vec<PathBuf> {
    let Ok(mode) = ctx.sandbox_mode.trim().parse::<SandboxMode>() else {
        return Vec::new();
    };
    configured_roots_within(mode, &base_dir(ctx), &ctx.sandbox_writable_roots)
}

/// Two rules decide what a configured entry becomes, and both exist to keep
/// the two enforcement paths honest:
///
/// - **Only `workspace-write` grants anything.** `read-only` writes no files
///   anywhere, so widening it is meaningless; and `full-access` has no
///   boundary to widen. Returning nothing here is what keeps the key out of
///   read-only in *both* paths rather than in one of them.
/// - **A directory that does not exist grants nothing.** Landlock can only
///   name a directory it can open, so a missing root is silently absent from
///   the kernel's ruleset no matter what we pass it. Honouring it in-process
///   would mean `write ~/typo/x` succeeds while `bash` is refused -- the exact
///   disagreement this module exists to prevent. A typo therefore grants
///   nothing, which is also the safer way to be wrong; the fix is to create
///   the directory.
fn configured_roots_within(mode: SandboxMode, base: &Path, configured: &[PathBuf]) -> Vec<PathBuf> {
    if mode != SandboxMode::WorkspaceWrite {
        return Vec::new();
    }
    configured
        .iter()
        .map(|root| {
            if root.is_absolute() {
                root.clone()
            } else {
                base.join(root)
            }
        })
        .filter(|root| root.is_dir())
        .collect()
}

/// The directories a write may land in, mirroring `writable_paths` in
/// `arterm-sandbox`. See the module comment for why read-only keeps none of
/// them.
fn writable_roots(
    mode: SandboxMode,
    working_dir: Option<&Path>,
    extra: &[PathBuf],
) -> Vec<PathBuf> {
    if mode == SandboxMode::Readonly {
        return Vec::new();
    }
    let mut roots = Vec::new();
    if let Some(dir) = working_dir {
        roots.push(dir.to_path_buf());
    }
    roots.push(std::env::temp_dir());
    if let Some(scratch) = std::env::var_os("ARTERM_SCRATCH_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        roots.push(scratch);
    }
    roots.extend(extra.iter().cloned());
    roots.extend(ALWAYS_WRITABLE_DEVICES.iter().map(PathBuf::from));
    roots
}

/// Resolve `path` the way the kernel would, without requiring it to exist.
///
/// `canonicalize` is unusable here: the file a `write` creates does not exist
/// yet, and canonicalizing only the nearest existing ancestor leaves two holes
/// wide enough to walk a boundary check straight through --
///
/// - a trailing `..` in the non-existent remainder (`ws/nope/../../../etc/x`),
/// - a *dangling* symlink as the final component, which `exists()` reports as
///   absent while a write still follows it to wherever it points.
///
/// So the walk is done a component at a time: every component that turns out to
/// be a symlink is expanded before the next one is appended, and `..` is
/// applied to the already-resolved prefix -- which is what the kernel does, and
/// the reason `a/..` where `a` is a symlink to `/x` means `/`, not `.`.
fn resolve(path: &Path, base: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut resolved = PathBuf::new();
    let mut hops = 0usize;
    walk(&absolute, &mut resolved, &mut hops)?;
    Ok(resolved)
}

fn walk(path: &Path, out: &mut PathBuf, hops: &mut usize) -> Result<(), String> {
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                out.clear();
                out.push(prefix.as_os_str());
            }
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                out.push(name);
                expand_link(out, hops)?;
            }
        }
    }
    Ok(())
}

/// Replace `out` with its symlink target while it names a symlink.
///
/// A path that does not exist is left as written: that is the normal case for
/// the file a `write` is about to create.
fn expand_link(out: &mut PathBuf, hops: &mut usize) -> Result<(), String> {
    while std::fs::symlink_metadata(&*out)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        *hops += 1;
        if *hops > MAX_SYMLINK_HOPS {
            return Err(format!("more than {MAX_SYMLINK_HOPS} symbolic links"));
        }
        let target = std::fs::read_link(&*out).map_err(|err| err.to_string())?;
        let joined = match out.parent() {
            Some(parent) if target.is_relative() => parent.join(target),
            _ => target,
        };
        let mut next = PathBuf::new();
        walk(&joined, &mut next, hops)?;
        *out = next;
    }
    Ok(())
}

#[cfg(test)]
#[path = "sandbox_boundary_tests.rs"]
mod sandbox_boundary_tests;
