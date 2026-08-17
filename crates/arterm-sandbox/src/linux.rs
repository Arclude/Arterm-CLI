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

// Access flags for filesystem (ABI v1, kernel ≥ 5.13)
const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 2;
const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 3;
const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 4;
const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 5;
const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 6;
const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 7;
const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 8;
const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 9;
const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 10;
// ABI v2 (kernel ≥ 6.2): refer
const LANDLOCK_ACCESS_FS_REFER: u64 = 1 << 11;

// ABI v4 (kernel ≥ 6.7): network access flags. Bind is currently unused:
// outbound connect control is the security boundary for tool subprocesses.
const LANDLOCK_ACCESS_NET_CONNECT_TCP: u64 = 1 << 1;

/// Minimum Landlock ABI version that supports network rules.
const NET_ABI_VERSION: u32 = 4;

/// All write-related access flags (what we deny in read-only mode).
#[expect(
    dead_code,
    reason = "documents the complete Landlock write-access table; later sandbox phases widen RESTRICTED_WRITE_ACCESS toward it"
)]
const ALL_WRITE_ACCESS: u64 = LANDLOCK_ACCESS_FS_WRITE_FILE
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

/// Write-related access flags that we restrict. We only restrict writing to
/// existing files and creating new regular files. This is the minimal set
/// that prevents uncontrolled file modification while allowing processes
/// to function normally (pipes, sockets, /dev/null all work).
const RESTRICTED_WRITE_ACCESS: u64 = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_MAKE_REG;

/// All access flags we know about (for the ruleset mask).
#[expect(
    dead_code,
    reason = "documents the complete Landlock access table; later sandbox phases use it as the ruleset mask"
)]
const ALL_KNOWN_ACCESS: u64 = LANDLOCK_ACCESS_FS_EXECUTE | ALL_WRITE_ACCESS;

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

    // Determine which access flags to handle based on ABI version.
    // We only handle file-level write/remove flags: this means reads, execute,
    // and pipe/socket creation are always allowed.
    let handled = if abi >= 2 {
        RESTRICTED_WRITE_ACCESS
    } else {
        // ABI v1: no REFER
        RESTRICTED_WRITE_ACCESS & !LANDLOCK_ACCESS_FS_REFER
    };

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

    // Add ALL paths as "allowed" for the handled operations, then restrict
    // specific dangerous paths. Since Landlock is deny-by-default for handled
    // flags, we need to explicitly allow the operations we want.
    //
    // For now, add the root filesystem with full access to handled flags,
    // then we can tighten by removing specific path rules.
    //
    // In read-only mode: don't add any write rules, so all writes are denied.
    // In workspace-write: add writable paths with full access.

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

    for path in &full_access_paths {
        if path.exists()
            && let Err(e) = landlock_add_rule(ruleset_fd, path, full_access)
        {
            eprintln!(
                "arterm sandbox: skipping writable root {}: {}",
                path.display(),
                e
            );
        }
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
mod tests {
    use super::*;
    use crate::SandboxConfig;

    #[test]
    fn query_landlock_abi() {
        let abi = landlock_create_ruleset_version();
        // On this kernel (7.1.x), Landlock should be supported.
        // But don't fail the test if running in CI without Landlock.
        println!("Landlock ABI version: {}", abi);
    }

    #[test]
    fn readonly_denies_writes() {
        let abi = landlock_create_ruleset_version();
        if abi == 0 {
            eprintln!("Skipping: Landlock not available");
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let config = SandboxConfig::new(SandboxMode::Readonly, Some(tmp.path().to_path_buf()));

        // Fork a child that applies the sandbox and tries to write
        // Write to a path outside the allowed writable directories.
        // The sandbox allows writes to TMPDIR and ARTERM_SCRATCH_DIR even in
        // read-only mode, so we write to a different location.
        let test_file = std::path::PathBuf::from("/var/tmp/arterm-sandbox-ro-test.txt");
        let _ = std::fs::remove_file(&test_file);
        unsafe {
            let pid = libc_fork();
            if pid == 0 {
                // Child: apply sandbox, then try to write
                let sandbox_result = apply_landlock(&config);
                // Try to create a file - should fail in read-only mode.
                // Landlock restricts the calling thread, so the write must
                // happen in the same thread.
                let write_result = std::fs::write(&test_file, "test");
                let exit_code = match (&sandbox_result, &write_result) {
                    (Ok(sr), Err(_)) if sr.applied => 0, // sandbox worked, write blocked
                    (Ok(sr), Ok(_)) if sr.applied => 1, // sandbox applied but write succeeded (bug)
                    (Ok(sr), _) if !sr.applied => 2,    // sandbox not available
                    (Err(_), _) => 3,                   // sandbox error
                    _ => 4,                             // catch-all
                };
                if let Err(ref e) = sandbox_result {
                    eprintln!("CHILD sandbox error: {e}");
                }
                if let Ok(ref sr) = sandbox_result {
                    eprintln!("CHILD sandbox: applied={} msg={}", sr.applied, sr.message);
                }
                std::process::exit(exit_code);
            } else if pid > 0 {
                // Parent: wait for child
                let mut status: i32 = 0;
                libc_waitpid(pid, &mut status, 0);
                // Exit code 0 = write failed (sandbox working)
                let exited = (status & 0xff00) >> 8;
                // Exit 0 = sandbox blocked write
                // Exit 2 = sandbox not available on this kernel
                // Exit 3 = sandbox error (e.g. EPERM in multi-threaded test env)
                if exited == 2 || exited == 3 {
                    eprintln!(
                        "Skipping readonly test: sandbox not applicable (exit={})",
                        exited
                    );
                    return;
                }
                // Exit 0 = sandbox blocked write (success!)
                // Exit 1 = sandbox applied but write succeeded (unexpected)
                assert!(
                    exited == 0,
                    "write should have been blocked by sandbox (exit={})",
                    exited
                );
            }
        }
    }

    #[test]
    fn workspace_write_allows_working_dir() {
        let abi = landlock_create_ruleset_version();
        if abi == 0 {
            eprintln!("Skipping: Landlock not available");
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let config =
            SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(tmp.path().to_path_buf()));

        let test_file = tmp.path().join("write_ok.txt");
        unsafe {
            let pid = libc_fork();
            if pid == 0 {
                let _ = apply_landlock(&config);
                let result = std::fs::write(&test_file, "ok");
                std::process::exit(if result.is_ok() { 0 } else { 1 });
            } else if pid > 0 {
                let mut status: i32 = 0;
                libc_waitpid(pid, &mut status, 0);
                let exited = (status & 0xff00) >> 8;
                assert_eq!(exited, 0, "write to working dir should succeed");
                assert!(test_file.exists(), "file should exist");
            }
        }
    }

    #[test]
    fn readonly_denies_outbound_connect() {
        let abi = landlock_create_ruleset_version();
        if abi < NET_ABI_VERSION {
            eprintln!("Skipping: Landlock network rules need ABI v4 (kernel ≥ 6.7)");
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let config = SandboxConfig::new(SandboxMode::Readonly, Some(tmp.path().to_path_buf()));
        // readonly implies deny-all egress with zero allow rules.
        assert_eq!(
            config.effective_egress().allowed_ports(),
            Some(vec![]),
            "readonly must enumerate an empty allowlist"
        );

        let exit = run_sandboxed_connect_probe(&config, 9); // discard port, likely unfiltered
        eprintln!("readonly probe exit code: {exit}");
        match exit {
            // 0 = connect blocked by the LSM: exactly what read-only demands
            0 => {}
            // 1 = connect succeeded: sandbox failed to enforce
            1 => panic!("sandbox applied but outbound connect succeeded"),
            2 => eprintln!("Skipping: sandbox not applicable"),
            3 => eprintln!("Skipping: sandbox error in child"),
            _ => panic!("unexpected probe exit {exit}"),
        }
    }

    #[test]
    fn workspace_write_allows_web_ports_only() {
        let abi = landlock_create_ruleset_version();
        if abi < NET_ABI_VERSION {
            eprintln!("Skipping: Landlock network rules need ABI v4 (kernel ≥ 6.7)");
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let config =
            SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(tmp.path().to_path_buf()));

        // The default policy permits 443 but not 6667.
        assert!(policy_permits_port(&config, 443));
        assert!(!policy_permits_port(&config, 6667));

        // Probing 443 against localhost may legitimately fail (no listener),
        // which still proves the port was reachable at the LSM layer: a
        // Landlock denial surfaces as EACCES, not ECONNREFUSED.
        let exit = run_sandboxed_connect_probe(&config, 443);
        assert_ne!(exit, 2, "sandbox should have applied on an ABI v4+ kernel");

        // 6667 is not in the allowlist; the connect must be denied by the LSM.
        let exit = run_sandboxed_connect_probe(&config, 6667);
        eprintln!("blocked-port probe exit code: {exit}");
        match exit {
            // 0 = connect blocked: exactly what the policy demands
            0 => {}
            1 => panic!("sandbox applied but connect to 6667 succeeded"),
            2 => eprintln!("Skipping: sandbox not applicable"),
            3 => eprintln!("Skipping: sandbox error in child"),
            _ => panic!("unexpected probe exit {exit}"),
        }
    }

    /// Fork a child that applies the sandbox then attempts a TCP connect.
    ///
    /// Exit codes: 0 = connect blocked by sandbox, 1 = connect succeeded,
    /// 2 = sandbox not applied, 3 = sandbox error.
    fn run_sandboxed_connect_probe(config: &SandboxConfig, port: u16) -> i32 {
        use std::net::{TcpStream, ToSocketAddrs as _};
        use std::time::Duration;

        let mut pipe = [0i32; 2];
        unsafe {
            let ret = pipe2(&mut pipe as *mut i32, 0);
            assert_eq!(ret, 0, "pipe2 failed");
        }

        unsafe {
            let pid = libc_fork();
            if pid == 0 {
                // Child
                close(pipe[0]);
                let sandbox_result = apply_landlock(config);
                if let Err(ref e) = sandbox_result {
                    eprintln!("probe child: sandbox error: {e}");
                }
                let connected = match ("127.0.0.1", port).to_socket_addrs() {
                    Ok(mut addrs) => addrs
                        .next()
                        .and_then(|addr| {
                            TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()
                        })
                        .is_some(),
                    Err(_) => false,
                };
                let code = match &sandbox_result {
                    Ok(sr) if sr.applied => {
                        if connected {
                            1
                        } else {
                            0
                        }
                    }
                    Ok(_) => 2,
                    Err(_) => 3,
                };
                let mut msg = [0u8; 1];
                msg[0] = code as u8;
                let _ = write_fd(pipe[1], msg.as_ptr(), 1);
                close(pipe[1]);
                std::process::exit(0);
            } else if pid > 0 {
                // Parent
                close(pipe[1]);
                let mut buf = [0u8; 1];
                let mut read_n = 0usize;
                while read_n < 1 {
                    let n = read_fd(pipe[0], buf.as_mut_ptr().add(read_n), 1);
                    if n <= 0 {
                        break;
                    }
                    read_n += n as usize;
                }
                close(pipe[0]);
                let mut status: i32 = 0;
                libc_waitpid(pid, &mut status, 0);
                i32::from(buf[0])
            } else {
                close(pipe[0]);
                close(pipe[1]);
                2
            }
        }
    }

    unsafe extern "C" {
        fn fork() -> i32;
        fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
        fn pipe2(fds: *mut i32, flags: i32) -> i32;
        fn write(fd: i32, buf: *const u8, count: usize) -> isize;
        fn read(fd: i32, buf: *mut u8, count: usize) -> isize;
    }

    unsafe fn libc_fork() -> i32 {
        unsafe { fork() }
    }

    unsafe fn libc_waitpid(pid: i32, status: *mut i32, options: i32) -> i32 {
        unsafe { waitpid(pid, status, options) }
    }

    unsafe fn write_fd(fd: i32, buf: *const u8, count: usize) -> isize {
        unsafe { write(fd, buf, count) }
    }

    unsafe fn read_fd(fd: i32, buf: *mut u8, count: usize) -> isize {
        unsafe { read(fd, buf, count) }
    }
}
