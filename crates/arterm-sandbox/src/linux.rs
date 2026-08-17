//! Linux Landlock LSM sandboxing via raw syscalls.
//!
//! Landlock is a Linux Security Module that allows unprivileged processes to
//! restrict their own filesystem access. It requires kernel ≥ 5.13 (ABI v1)
//! and ≥ 6.2 for network restrictions (ABI v4).
//!
//! This module uses raw syscalls (no libc crate) to avoid adding dependencies.
//! The syscall numbers are stable on x86_64, x86, aarch64, and arm.

use crate::policy::EgressDefault;
use crate::{SandboxConfig, SandboxMode, SandboxResult};
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;

// ─── Landlock syscall numbers ─────────────────────────────────────────────
//
// These are architecture-independent since Linux 4.17 (they use the
// architecture-generic range 440-449 on all platforms except MIPS).

#[cfg(target_arch = "x86_64")]
const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
#[cfg(target_arch = "x86_64")]
const SYS_LANDLOCK_ADD_RULE: i64 = 445;
#[cfg(target_arch = "x86_64")]
const SYS_LANDLOCK_RESTRICT_SELF: i64 = 446;

#[cfg(target_arch = "x86")]
const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
#[cfg(target_arch = "x86")]
const SYS_LANDLOCK_ADD_RULE: i64 = 445;
#[cfg(target_arch = "x86")]
const SYS_LANDLOCK_RESTRICT_SELF: i64 = 446;

#[cfg(target_arch = "aarch64")]
const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
#[cfg(target_arch = "aarch64")]
const SYS_LANDLOCK_ADD_RULE: i64 = 445;
#[cfg(target_arch = "aarch64")]
const SYS_LANDLOCK_RESTRICT_SELF: i64 = 446;

#[cfg(not(any(target_arch = "x86_64", target_arch = "x86", target_arch = "aarch64")))]
const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
#[cfg(not(any(target_arch = "x86_64", target_arch = "x86", target_arch = "aarch64")))]
const SYS_LANDLOCK_ADD_RULE: i64 = 445;
#[cfg(not(any(target_arch = "x86_64", target_arch = "x86", target_arch = "aarch64")))]
const SYS_LANDLOCK_RESTRICT_SELF: i64 = 446;

// ─── Landlock ABI / flags ─────────────────────────────────────────────────

/// `landlock_create_ruleset` flags: report ABI version without creating.
const LANDLOCK_CREATE_RULESET_VERSION: u64 = 1 << 0;

mod access;

// The kernel access-right table and the ABI gating over it. Split out so
// the contract with `include/uapi/linux/landlock.h` sits next to the test
// that pins it against the header.
use access::*;

/// Devices every ordinary command expects to write, allowed in every sandboxed
/// mode including read-only.
///
/// `cmd > /dev/null` is the most common redirection in shell, and `2>/dev/null`
/// is right behind it. Denying them does not protect anything -- these devices
/// hold no user data and writing to them cannot modify the filesystem -- while
/// making the sandbox read as broken rather than as protective, which is how it
/// gets switched off. `/dev` as a whole is deliberately NOT allowed: that would
/// hand out raw block devices along with them.
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

/// `landlock_ruleset_attr` as expected by the kernel.
#[repr(C)]
struct LandlockRulesetAttr {
    /// Bitmask of `LANDLOCK_ACCESS_FS_*` handled by this ruleset.
    handled_access_fs: u64,
    /// Bitmask of `LANDLOCK_ACCESS_NET_*` (ABI v4+, kernel ≥ 6.7). 0 = don't handle.
    handled_access_net: u64,
    /// Scoped (ABI v5+, kernel ≥ 6.10). 0 = don't scope.
    #[allow(dead_code)]
    scoped: u64,
}

/// `landlock_net_port_attr` for adding a network port rule (ABI v4+).
#[repr(C)]
struct LandlockNetPortAttr {
    /// The allowed access mask for this port.
    allowed_access: u64,
    /// The TCP port in host byte order.
    port: u64,
}

/// `landlock_path_beneath_attr` for adding a path rule.
#[repr(C)]
struct LandlockPathBeneathAttr {
    /// Bitmask of access rights allowed beneath this path.
    allowed_access: u64,
    /// File descriptor for the directory.
    parent_fd: i32,
}

// ─── raw syscall helpers ──────────────────────────────────────────────────

#[cfg(target_arch = "x86_64")]
unsafe fn syscall3(num: i64, a1: i64, a2: i64, a3: i64) -> i64 {
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") num => ret,
            in("rdi") a1,
            in("rsi") a2,
            in("rdx") a3,
            lateout("rcx") _,
            lateout("r11") _,
        );
    }
    ret
}

#[cfg(target_arch = "x86_64")]
unsafe fn syscall4(num: i64, a1: i64, a2: i64, a3: i64, a4: i64) -> i64 {
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") num => ret,
            in("rdi") a1,
            in("rsi") a2,
            in("rdx") a3,
            in("r10") a4,
            lateout("rcx") _,
            lateout("r11") _,
        );
    }
    ret
}

#[cfg(not(target_arch = "x86_64"))]
unsafe fn syscall3(num: i64, a1: i64, a2: i64, a3: i64) -> i64 {
    // Fallback: use libc via extern
    unsafe extern "C" {
        fn syscall(num: std::ffi::c_long, ...) -> std::ffi::c_long;
    }
    unsafe { syscall(num, a1, a2, a3) }
}

#[cfg(not(target_arch = "x86_64"))]
unsafe fn syscall4(num: i64, a1: i64, a2: i64, a3: i64, a4: i64) -> i64 {
    unsafe extern "C" {
        fn syscall(num: std::ffi::c_long, ...) -> std::ffi::c_long;
    }
    unsafe { syscall(num, a1, a2, a3, a4) }
}

const AT_FDCWD: i32 = -100;

unsafe fn openat(dirfd: i32, path: *const std::os::raw::c_char, flags: i32) -> i32 {
    // openat syscall number
    #[cfg(target_arch = "x86_64")]
    {
        const SYS_OPENAT: i64 = 257;
        (unsafe { syscall3(SYS_OPENAT, dirfd as i64, path as i64, flags as i64) }) as i32
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        unsafe extern "C" {
            fn openat(
                dirfd: std::ffi::c_int,
                path: *const std::os::raw::c_char,
                flags: std::ffi::c_int,
            ) -> std::ffi::c_int;
        }
        openat(dirfd, path, flags)
    }
}

unsafe fn close(fd: i32) -> i32 {
    #[cfg(target_arch = "x86_64")]
    {
        const SYS_CLOSE: i64 = 3;
        (unsafe { syscall3(SYS_CLOSE, fd as i64, 0, 0) }) as i32
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        unsafe extern "C" {
            fn close(fd: std::ffi::c_int) -> std::ffi::c_int;
        }
        close(fd)
    }
}

// Linux open flags
const O_PATH: i32 = 0o010000000;
const O_CLOEXEC: i32 = 0o2000000;

/// Query the kernel's Landlock ABI version without creating a ruleset.
pub fn landlock_create_ruleset_version() -> u32 {
    unsafe {
        let ret = syscall3(
            SYS_LANDLOCK_CREATE_RULESET,
            std::ptr::null::<LandlockRulesetAttr>() as i64,
            0,
            LANDLOCK_CREATE_RULESET_VERSION as i64,
        );
        if ret < 0 { 0 } else { ret as u32 }
    }
}

/// Create a Landlock ruleset file descriptor.
///
/// `handled_access_net` is honored only on ABI v4+ kernels; the attr size
/// grows to include the network field when it is non-zero.
fn landlock_create_ruleset(handled_access_fs: u64, handled_access_net: u64) -> Result<i32, String> {
    let attr = LandlockRulesetAttr {
        handled_access_fs,
        handled_access_net,
        scoped: 0,
    };
    // Size 8 = handled_access_fs only (ABI v1 minimum). Size 16 also passes
    // handled_access_net, required for network rules on ABI v4+.
    let attr_size: usize = if handled_access_net != 0 { 16 } else { 8 };
    unsafe {
        let ret = syscall3(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const LandlockRulesetAttr as i64,
            attr_size as i64,
            0, // flags
        );
        if ret < 0 {
            Err(format!("landlock_create_ruleset failed (errno {})", -ret))
        } else {
            Ok(ret as i32)
        }
    }
}

/// Add a TCP port rule to the ruleset (ABI v4+).
///
/// `allowed_access` of 0 denies both bind and connect on the port, which is
/// Landlock's deny-by-default behavior for handled network access.
fn landlock_add_net_rule(ruleset_fd: i32, port: u16, allowed_access: u64) -> Result<(), String> {
    let net_attr = LandlockNetPortAttr {
        allowed_access,
        port: u64::from(port),
    };

    const LANDLOCK_RULE_NET_PORT: u64 = 2;

    unsafe {
        let ret = syscall4(
            SYS_LANDLOCK_ADD_RULE,
            ruleset_fd as i64,
            LANDLOCK_RULE_NET_PORT as i64,
            &net_attr as *const LandlockNetPortAttr as i64,
            0, // flags
        );
        if ret < 0 {
            Err(format!(
                "landlock_add_rule(net_port {}) failed (errno {})",
                port, -ret
            ))
        } else {
            Ok(())
        }
    }
}

/// Grant write access to one path, choosing the mask its file type accepts.
///
/// Missing paths are skipped silently: `/dev/ptmx` and friends are absent in
/// some containers, and that is not an error worth printing on every command.
fn add_writable_rule(ruleset_fd: i32, path: &std::path::Path, full_access: u64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    let access = if metadata.is_dir() {
        full_access
    } else {
        full_access & FILE_WRITE_ACCESS
    };
    if let Err(e) = landlock_add_rule(ruleset_fd, path, access) {
        eprintln!(
            "arterm sandbox: skipping writable root {}: {}",
            path.display(),
            e
        );
    }
}

/// Add a path rule to the ruleset.
fn landlock_add_rule(
    ruleset_fd: i32,
    path: &std::path::Path,
    allowed_access: u64,
) -> Result<(), String> {
    let path_bytes =
        CString::new(path.as_os_str().as_bytes()).map_err(|e| format!("path contains NUL: {e}"))?;

    unsafe {
        let parent_fd = openat(AT_FDCWD, path_bytes.as_ptr(), O_PATH | O_CLOEXEC);
        if parent_fd < 0 {
            return Err(format!(
                "openat({}) failed for path {} (errno {})",
                path.display(),
                path.display(),
                -parent_fd
            ));
        }

        let path_attr = LandlockPathBeneathAttr {
            allowed_access,
            parent_fd,
        };

        const LANDLOCK_RULE_PATH_BENEATH: u64 = 1;

        let ret = syscall4(
            SYS_LANDLOCK_ADD_RULE,
            ruleset_fd as i64,
            LANDLOCK_RULE_PATH_BENEATH as i64,
            &path_attr as *const LandlockPathBeneathAttr as i64,
            0, // flags
        );

        close(parent_fd);

        if ret < 0 {
            Err(format!("landlock_add_rule failed (errno {})", -ret))
        } else {
            Ok(())
        }
    }
}

/// Restrict the calling thread to the ruleset.
///
/// Requires `PR_SET_NO_NEW_PRIVS` to be set first, otherwise returns EPERM
/// when running without CAP_SYS_ADMIN.
fn landlock_restrict_self(ruleset_fd: i32) -> Result<(), String> {
    // prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) — needs 5 args
    #[cfg(target_arch = "x86_64")]
    {
        const SYS_PRCTL: i64 = 157;
        const PR_SET_NO_NEW_PRIVS: i64 = 38;
        unsafe {
            let ret: i64;
            std::arch::asm!(
                "syscall",
                inlateout("rax") SYS_PRCTL => ret,
                in("rdi") PR_SET_NO_NEW_PRIVS,
                in("rsi") 1i64,
                in("rdx") 0i64,
                in("r10") 0i64,
                in("r8") 0i64,
                lateout("rcx") _,
                lateout("r11") _,
            );
            if ret < 0 {
                return Err(format!(
                    "prctl(PR_SET_NO_NEW_PRIVS) failed (errno {})",
                    -ret
                ));
            }
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        unsafe extern "C" {
            fn prctl(option: std::ffi::c_int, arg2: std::ffi::c_ulong, ...) -> std::ffi::c_int;
        }
        const PR_SET_NO_NEW_PRIVS: std::ffi::c_int = 38;
        let ret = unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1) };
        if ret < 0 {
            return Err(format!("prctl(PR_SET_NO_NEW_PRIVS) failed (ret {})", ret));
        }
    }

    unsafe {
        let ret = syscall3(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd as i64, 0, 0);
        if ret < 0 {
            Err(format!("landlock_restrict_self failed (errno {})", -ret))
        } else {
            Ok(())
        }
    }
}

/// Apply Landlock restrictions based on the sandbox config.
///
/// This must be called from `pre_exec`, after fork but before exec.
pub fn apply_landlock(config: &SandboxConfig) -> Result<SandboxResult, String> {
    let abi = landlock_create_ruleset_version();
    if abi == 0 {
        return Ok(SandboxResult::skipped(
            "Landlock not supported by kernel (need ≥ 5.13)",
        ));
    }

    // Which of the write flags this kernel is willing to hear about. Reads,
    // execute, ioctl and pipe/socket creation stay unhandled, so they are
    // always allowed.
    let handled = restricted_write_access(abi);

    // Network enforcement: Landlock ABI v4+ (kernel ≥ 6.7). When the
    // effective egress policy is enumerably restrictive, handle TCP connect
    // so that only allowed ports can be reached. When the kernel is older,
    // report the gap instead of silently running unrestricted.
    let egress = config.effective_egress();
    let ports = egress.allowed_ports();
    let net_enforced = abi >= NET_ABI_VERSION && ports.is_some();
    let handled_net = if net_enforced {
        LANDLOCK_ACCESS_NET_CONNECT_TCP
    } else {
        0
    };

    // Create the ruleset
    let ruleset_fd = landlock_create_ruleset(handled, handled_net)?;

    // Landlock is deny-by-default for every handled right, so the rules below
    // are the only places those rights exist. Anything not listed is denied,
    // which is why `handled` must not name a right nothing grants back.
    //
    // In read-only mode the list is temp and scratch only; in workspace-write
    // it also carries the working directory and the caller's extra roots.

    let full_access = handled;

    // Add writable paths with full write access.
    // In workspace-write mode: working dir + temp + scratch + extra roots.
    // In read-only mode: only temp/scratch (bash needs TMPDIR for internal use).
    let full_access_paths: Vec<std::path::PathBuf> = match config.mode {
        SandboxMode::WorkspaceWrite => config.writable_paths(),
        SandboxMode::Readonly => {
            let mut paths = Vec::new();
            // Bash and other tools need TMPDIR for internal temp files
            if let Some(tmp) = std::env::temp_dir().to_str() {
                paths.push(std::path::PathBuf::from(tmp));
            }
            if let Some(ref scratch) = std::env::var_os("ARTERM_SCRATCH_DIR") {
                paths.push(std::path::PathBuf::from(scratch));
            }
            paths
        }
        SandboxMode::FullAccess => Vec::new(),
    };

    // Devices first: they are allowed in every sandboxed mode, read-only
    // included, so that redirection keeps working under the sandbox. They get
    // the non-directory mask even where the path is a directory (`/dev/pts`):
    // `cmd > /dev/null` needs write and truncate, and nothing needs to create
    // or delete entries under /dev.
    let device_access = full_access & FILE_WRITE_ACCESS;
    let device_paths = ALWAYS_WRITABLE_DEVICES.iter().map(std::path::Path::new);

    for path in full_access_paths.iter().map(std::path::PathBuf::as_path) {
        add_writable_rule(ruleset_fd, path, full_access);
    }
    for path in device_paths {
        add_writable_rule(ruleset_fd, path, device_access);
    }

    // Egress enforcement (ABI v4+): Landlock is deny-by-default for handled
    // net access, so each allow rule opens exactly one port. Deny rules in
    // the policy are already covered by the default-deny; explicit port
    // denials simply do not get an allow rule. A deny-everything policy with
    // zero allow rules denies all outbound TCP.
    let mut net_rule_failures = 0usize;
    if net_enforced && let Some(ports) = ports.as_ref() {
        for &port in ports {
            if let Err(e) = landlock_add_net_rule(ruleset_fd, port, LANDLOCK_ACCESS_NET_CONNECT_TCP)
            {
                net_rule_failures += 1;
                eprintln!("arterm sandbox: egress rule for port {port} failed: {e}");
            }
        }
    }

    // Restrict ourselves
    let restrict_result = landlock_restrict_self(ruleset_fd);

    // Always close the fd
    unsafe {
        close(ruleset_fd);
    }

    match restrict_result {
        Ok(()) => {
            let mut message = format!("Landlock ABI v{} applied (mode: {}", abi, config.mode);
            if net_enforced {
                let count = ports.as_ref().map(|p| p.len()).unwrap_or(0);
                message.push_str(&format!(
                    ", egress: {count} port(s) allowed, {} denied",
                    if net_rule_failures > 0 {
                        format!("{net_rule_failures} rule(s) failed")
                    } else {
                        "rest".to_string()
                    }
                ));
            } else if abi < NET_ABI_VERSION {
                message
                    .push_str(", egress: NOT enforced (kernel < 6.7 lacks Landlock network rules)");
            } else if egress.default_action == EgressDefault::Allow {
                message.push_str(", egress: allow-all policy");
            }
            message.push(')');
            Ok(SandboxResult::applied(message))
        }
        Err(e) => Err(e),
    }
}

/// Whether the effective egress policy would allow a TCP connect to `port`.
/// Exposed for tests and diagnostics; the kernel enforces the real policy.
#[cfg(test)]
pub(crate) fn policy_permits_port(config: &SandboxConfig, port: u16) -> bool {
    config.effective_egress().permits(port)
}

#[cfg(test)]
#[path = "linux_tests.rs"]
mod linux_tests;
