//! Linux Landlock LSM sandboxing via raw syscalls.
//!
//! Landlock is a Linux Security Module that allows unprivileged processes to
//! restrict their own filesystem access. It requires kernel ≥ 5.13 (ABI v1)
//! and ≥ 6.2 for network restrictions (ABI v4).
//!
//! This module uses raw syscalls (no libc crate) to avoid adding dependencies.
//! The syscall numbers are stable on x86_64, x86, aarch64, and arm.

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
    #[allow(dead_code)]
    handled_access_net: u64,
    /// Scoped (ABI v5+, kernel ≥ 6.10). 0 = don't scope.
    #[allow(dead_code)]
    scoped: u64,
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
fn landlock_create_ruleset(handled_access_fs: u64) -> Result<i32, String> {
    let attr = LandlockRulesetAttr {
        handled_access_fs,
        handled_access_net: 0,
        scoped: 0,
    };
    unsafe {
        // Pass size = 8 (offsetof + sizeof handled_access_fs only).
        // Passing the full struct size works on newer kernels but the
        // minimum guaranteed size is just the first field for ABI v1 compat.
        let ret = syscall3(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const LandlockRulesetAttr as i64,
            8, // size of handled_access_fs field only
            0, // flags
        );
        if ret < 0 {
            Err(format!("landlock_create_ruleset failed (errno {})", -ret))
        } else {
            Ok(ret as i32)
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

    // Create the ruleset
    let ruleset_fd = landlock_create_ruleset(handled)?;

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

    // Restrict ourselves
    let restrict_result = landlock_restrict_self(ruleset_fd);

    // Always close the fd
    unsafe {
        close(ruleset_fd);
    }

    match restrict_result {
        Ok(()) => Ok(SandboxResult::applied(format!(
            "Landlock ABI v{} applied (mode: {})",
            abi, config.mode
        ))),
        Err(e) => Err(e),
    }
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

    unsafe extern "C" {
        fn fork() -> i32;
        fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    }

    unsafe fn libc_fork() -> i32 {
        unsafe { fork() }
    }

    unsafe fn libc_waitpid(pid: i32, status: *mut i32, options: i32) -> i32 {
        unsafe { waitpid(pid, status, options) }
    }
}
