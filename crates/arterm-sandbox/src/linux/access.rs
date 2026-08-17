//! The Landlock access-right table and the ABI gating over it.
//!
//! This is the kernel contract, kept apart from the syscall plumbing that uses
//! it: the constants below are transcribed from `include/uapi/linux/landlock.h`
//! and are only correct insofar as they still match it. `access_tests.rs` pins
//! every one of them against the header's literals, which is the check that was
//! missing when the table drifted -- `READ_FILE` and `READ_DIR` had been left
//! out, shifting everything from `REMOVE_*` down by two bits, so the constant
//! named `MAKE_REG` was really `MAKE_CHAR` and the sandbox never handled file
//! creation at all.

// ─── the kernel's access-right table ──────────────────────────────────────
//
// Bit positions are ABI, not an implementation detail: a constant whose name
// and bit disagree silently hands out the right next door.

// ABI v1 (kernel ≥ 5.13)
pub(super) const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
pub(super) const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
pub(super) const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
pub(super) const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
pub(super) const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
pub(super) const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
pub(super) const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
pub(super) const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
pub(super) const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
pub(super) const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
pub(super) const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
pub(super) const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
pub(super) const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
// ABI v2 (kernel ≥ 6.2): reparent a file hierarchy across directories.
pub(super) const LANDLOCK_ACCESS_FS_REFER: u64 = 1 << 13;
// ABI v3 (kernel ≥ 6.2): truncate(2)/ftruncate(2)/creat(2)/O_TRUNC.
pub(super) const LANDLOCK_ACCESS_FS_TRUNCATE: u64 = 1 << 14;
// ABI v5 (kernel ≥ 6.10): ioctl(2) on character and block devices.
pub(super) const LANDLOCK_ACCESS_FS_IOCTL_DEV: u64 = 1 << 15;
// ABI v9: resolve pathname UNIX domain sockets from outside the domain.
pub(super) const LANDLOCK_ACCESS_FS_RESOLVE_UNIX: u64 = 1 << 16;

// ABI v4 (kernel ≥ 6.7): network access flags. Bind is currently unused:
// outbound connect control is the security boundary for tool subprocesses.
pub(super) const LANDLOCK_ACCESS_NET_CONNECT_TCP: u64 = 1 << 1;

// ─── ABI versions that introduced each right ──────────────────────────────

/// Minimum Landlock ABI version that supports network rules.
pub(super) const NET_ABI_VERSION: u32 = 4;

/// Minimum ABI for [`LANDLOCK_ACCESS_FS_REFER`].
pub(super) const REFER_ABI_VERSION: u32 = 2;

/// Minimum ABI for [`LANDLOCK_ACCESS_FS_TRUNCATE`].
pub(super) const TRUNCATE_ABI_VERSION: u32 = 3;

// ─── derived masks ────────────────────────────────────────────────────────

/// Every access flag the kernel can hand out, whether or not we handle it.
///
/// Kept as a complete table so the constants above can be diffed against
/// `/usr/include/linux/landlock.h` at a glance, and so a newly handled right
/// is a one-line move into [`RESTRICTED_WRITE_ACCESS`] rather than a fresh
/// constant nobody checks.
#[allow(dead_code)]
pub(super) const ALL_KNOWN_ACCESS: u64 = LANDLOCK_ACCESS_FS_EXECUTE
    | LANDLOCK_ACCESS_FS_READ_FILE
    | LANDLOCK_ACCESS_FS_READ_DIR
    | LANDLOCK_ACCESS_FS_IOCTL_DEV
    | LANDLOCK_ACCESS_FS_RESOLVE_UNIX
    | ALL_WRITE_ACCESS;

/// Every flag that lets a process change the filesystem.
#[allow(dead_code)]
pub(super) const ALL_WRITE_ACCESS: u64 = LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_TRUNCATE
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_CHAR
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_SOCK
    | LANDLOCK_ACCESS_FS_MAKE_FIFO
    | LANDLOCK_ACCESS_FS_MAKE_BLOCK
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER;

/// The write-related rights the sandbox handles, i.e. denies everywhere it has
/// not granted them. Everything omitted here is unrestricted in every mode.
///
/// The set covers each way a process can change data outside its writable
/// roots: open a file for writing, shorten one, delete a file or a directory,
/// or create a new file, directory, symlink or device node.
///
/// `TRUNCATE` is not optional. The kernel states that `WRITE_FILE` does not
/// imply truncation, so without it `cmd > existing_file` still empties the
/// file, and `truncate(2)` on a path is not checked by any other right.
///
/// `MAKE_CHAR` and `MAKE_BLOCK` are here because a device node is the one
/// created thing that reaches data no path rule covers -- a block node for the
/// root disk defeats the sandbox outright. Creating one needs `CAP_MKNOD`, so
/// this only bites a root-in-userns process, which is exactly the case worth
/// covering.
///
/// `MAKE_SOCK` and `MAKE_FIFO` are deliberately left out. Neither carries
/// data that survives the process, neither can destroy or expose anything,
/// and denying them breaks ordinary tools that put a control socket beside
/// their config (ssh multiplexing, agents, tmux) for no gain.
///
/// `IOCTL_DEV` is left out for a blunter reason: handling it would deny
/// `TCGETS` on `/dev/tty`, so every program that asks whether it has a
/// terminal would break. `RESOLVE_UNIX` is left out because reaching an
/// existing socket is an egress question, and the egress policy is the place
/// that answers it.
///
/// Character devices are NOT automatically fine: `WRITE_FILE` covers them too,
/// so `cmd > /dev/null` was denied in both sandboxed modes until the always
/// writable device list was allowed explicitly.
pub(super) const RESTRICTED_WRITE_ACCESS: u64 = LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_TRUNCATE
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_MAKE_CHAR
    | LANDLOCK_ACCESS_FS_MAKE_BLOCK
    | LANDLOCK_ACCESS_FS_REFER;

/// The subset of [`RESTRICTED_WRITE_ACCESS`] that applies to a non-directory.
///
/// Every `MAKE_*`, `REMOVE_*` and `REFER` right means "do this to the contents
/// of this directory", so passing one in a rule whose target is a file makes
/// `landlock_add_rule` fail with EINVAL. That failure was only ever an
/// `eprintln`, so a file-granular writable root looked accepted and silently
/// did nothing.
///
/// `TRUNCATE` belongs here alongside `WRITE_FILE`: a file-granular writable
/// root that cannot be truncated cannot be overwritten by `>` either.
pub(super) const FILE_WRITE_ACCESS: u64 =
    LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;

/// [`RESTRICTED_WRITE_ACCESS`] narrowed to the rights ABI version `abi` knows.
///
/// `landlock_create_ruleset` rejects a `handled_access_fs` containing a bit the
/// running kernel does not define, and it rejects it with EINVAL -- which
/// `apply_landlock` turns into an error and the caller into "no sandbox".
/// Asking for one right too many therefore costs every other right, so each
/// post-v1 flag is gated on the ABI that introduced it.
pub(super) fn restricted_write_access(abi: u32) -> u64 {
    let mut access = RESTRICTED_WRITE_ACCESS;
    if abi < REFER_ABI_VERSION {
        access &= !LANDLOCK_ACCESS_FS_REFER;
    }
    if abi < TRUNCATE_ABI_VERSION {
        access &= !LANDLOCK_ACCESS_FS_TRUNCATE;
    }
    access
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod access_tests;
