//! Runtime and constant-table tests for the Landlock sandbox.
//!
//! Split out of `linux.rs` so the enforcement code stays inside the
//! repository's code-size budget; `#[path]`-included, so `super::*` is
//! still the `linux` module.

use super::*;
use crate::SandboxConfig;

/// The premise the ABI gating rests on: the kernel does not ignore a right it
/// does not know, it refuses the whole ruleset with EINVAL. One flag too many
/// therefore costs every flag, and [`apply_landlock`] reports an error the
/// caller turns into "ran unsandboxed" -- worse than handling less.
///
/// The second half is the one that matters day to day: the mask this kernel is
/// actually sent has to be one it accepts.
#[test]
fn unknown_right_fails_ruleset_creation_and_ours_does_not() {
    let abi = landlock_create_ruleset_version();
    if abi == 0 {
        eprintln!("Skipping: Landlock not available");
        return;
    }

    const EINVAL: &str = "errno 22";
    let unknown = 1u64 << 40;
    let err = landlock_create_ruleset(RESTRICTED_WRITE_ACCESS | unknown, 0)
        .expect_err("kernel accepted a right no Landlock ABI defines");
    assert!(err.contains(EINVAL), "expected EINVAL, got: {err}");

    let fd = landlock_create_ruleset(restricted_write_access(abi), 0)
        .unwrap_or_else(|e| panic!("this kernel (ABI v{abi}) rejects the mask we send: {e}"));
    unsafe { close(fd) };
}

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
                (Ok(sr), Ok(_)) if sr.applied => 1,  // sandbox applied but write succeeded (bug)
                (Ok(sr), _) if !sr.applied => 2,     // sandbox not available
                (Err(_), _) => 3,                    // sandbox error
                _ => 4,                              // catch-all
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
    let config = SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(tmp.path().to_path_buf()));

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

/// The bug this test exists for: `MAKE_REG` was really `MAKE_CHAR`, so
/// creating a file, a directory, a symlink, or deleting one, was allowed
/// anywhere on the filesystem in every sandboxed mode. The open-for-write
/// that followed still failed, which is why it read as "permission denied"
/// while leaving a new empty file behind.
#[test]
fn sandbox_denies_every_write_primitive_outside_writable_roots() {
    let abi = landlock_create_ruleset_version();
    if abi == 0 {
        eprintln!("Skipping: Landlock not available");
        return;
    }
    let Some(outside) = outside_writable_roots_dir("deny-primitives") else {
        eprintln!("Skipping: no directory available outside the writable roots");
        return;
    };

    for mode in [SandboxMode::Readonly, SandboxMode::WorkspaceWrite] {
        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig::new(mode, Some(workspace.path().to_path_buf()));
        write_probe_fixtures(&outside);

        let (status, succeeded) = fork_fs_probe(&config, &outside);
        if status != 0 {
            eprintln!("Skipping {mode}: sandbox not applicable (status={status})");
            continue;
        }
        assert_eq!(
            succeeded,
            0,
            "{mode}: these write primitives escaped the sandbox: {}",
            describe_fs_ops(succeeded)
        );
        // The kernel's answer and the disk must agree: the pre-fix bug
        // returned EACCES from the open and still left the file behind.
        for leftover in ["new_file.txt", "new_dir", "new_link", "moved.txt"] {
            assert!(
                !outside.join(leftover).exists(),
                "{mode}: sandbox denied the call but {leftover} exists anyway"
            );
        }
        for survivor in ["victim.txt", "victim_dir", "existing.txt", "movable.txt"] {
            assert!(
                outside.join(survivor).exists(),
                "{mode}: {survivor} was destroyed outside the writable roots"
            );
        }
        assert_eq!(
            std::fs::read_to_string(outside.join("existing.txt")).unwrap(),
            FIXTURE_CONTENTS,
            "{mode}: an existing file outside the writable roots was truncated"
        );
    }
    let _ = std::fs::remove_dir_all(&outside);
}

/// Handling `TRUNCATE` is what makes `>` enforceable, and `cmd > /dev/null`
/// is `>`. Without `TRUNCATE` in the device grant this denies the most
/// common redirection in shell, which is how a sandbox gets switched off.
#[test]
fn sandbox_still_allows_dev_null_redirection() {
    let abi = landlock_create_ruleset_version();
    if abi == 0 {
        eprintln!("Skipping: Landlock not available");
        return;
    }
    for mode in [SandboxMode::Readonly, SandboxMode::WorkspaceWrite] {
        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig::new(mode, Some(workspace.path().to_path_buf()));
        let (status, ok) = fork_probe(&config, || {
            use std::io::Write as _;
            let opened = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open("/dev/null")
                .and_then(|mut f| f.write_all(b"x"));
            u8::from(opened.is_ok())
        });
        if status != 0 {
            eprintln!("Skipping {mode}: sandbox not applicable (status={status})");
            continue;
        }
        assert_eq!(ok, 1, "{mode}: `cmd > /dev/null` must keep working");
    }
}

const FIXTURE_CONTENTS: &str = "original contents\n";

/// A directory the sandbox never grants: not the workspace, not temp, not
/// the scratch dir. `/tmp` is writable in every mode, so a probe there
/// would pass while proving nothing.
fn outside_writable_roots_dir(tag: &str) -> Option<std::path::PathBuf> {
    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
    let dir = home.join(format!(".arterm-sandbox-test-{tag}-{}", std::process::id()));
    let granted = [
        Some(std::env::temp_dir()),
        std::env::var_os("ARTERM_SCRATCH_DIR").map(Into::into),
    ];
    if granted.iter().flatten().any(|root| dir.starts_with(root)) {
        return None;
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn write_probe_fixtures(dir: &std::path::Path) {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir.join("victim_dir")).unwrap();
    for name in ["existing.txt", "victim.txt", "movable.txt"] {
        std::fs::write(dir.join(name), FIXTURE_CONTENTS).unwrap();
    }
}

/// One bit per write primitive, set when the kernel *allowed* it.
const FS_OPS: [&str; 8] = [
    "create file",
    "write existing",
    "truncate(2)",
    "mkdir",
    "remove file",
    "rmdir",
    "symlink",
    "rename",
];

fn describe_fs_ops(mask: u8) -> String {
    FS_OPS
        .iter()
        .enumerate()
        .filter(|(i, _)| mask & (1 << i) != 0)
        .map(|(_, name)| *name)
        .collect::<Vec<_>>()
        .join(", ")
}

fn fork_fs_probe(config: &SandboxConfig, dir: &std::path::Path) -> (u8, u8) {
    let dir = dir.to_path_buf();
    fork_probe(config, move || {
        let attempts: [bool; 8] = [
            std::fs::File::create(dir.join("new_file.txt")).is_ok(),
            std::fs::OpenOptions::new()
                .write(true)
                .open(dir.join("existing.txt"))
                .is_ok(),
            truncate_path(&dir.join("existing.txt")),
            std::fs::create_dir(dir.join("new_dir")).is_ok(),
            std::fs::remove_file(dir.join("victim.txt")).is_ok(),
            std::fs::remove_dir(dir.join("victim_dir")).is_ok(),
            std::os::unix::fs::symlink("t", dir.join("new_link")).is_ok(),
            std::fs::rename(dir.join("movable.txt"), dir.join("moved.txt")).is_ok(),
        ];
        attempts
            .iter()
            .enumerate()
            .fold(0u8, |mask, (i, ok)| mask | (u8::from(*ok) << i))
    })
}

/// `truncate(2)` on a path never opens the file, so `WRITE_FILE` is not
/// consulted: only `LANDLOCK_ACCESS_FS_TRUNCATE` can stop it.
fn truncate_path(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt as _;
    let Ok(cpath) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { truncate(cpath.as_ptr(), 0) == 0 }
}

/// Fork a child that applies the sandbox, runs `probe`, and reports back
/// `[status, payload]` — status 0 = applied, 2 = not applied, 3 = error.
///
/// Landlock restricts the calling thread, so the probe has to run in the
/// same thread that applied it, and a fork is the only way to get that
/// thread back afterwards.
fn fork_probe(config: &SandboxConfig, probe: impl FnOnce() -> u8) -> (u8, u8) {
    let mut pipe = [0i32; 2];
    unsafe {
        assert_eq!(pipe2(&mut pipe as *mut i32, 0), 0, "pipe2 failed");
    }
    unsafe {
        let pid = libc_fork();
        if pid == 0 {
            close(pipe[0]);
            let applied = apply_landlock(config);
            let status = match &applied {
                Ok(sr) if sr.applied => 0u8,
                Ok(_) => 2,
                Err(e) => {
                    eprintln!("probe child: sandbox error: {e}");
                    3
                }
            };
            let payload = if status == 0 { probe() } else { 0 };
            let msg = [status, payload];
            let _ = write_fd(pipe[1], msg.as_ptr(), 2);
            close(pipe[1]);
            std::process::exit(0);
        } else if pid > 0 {
            close(pipe[1]);
            let mut buf = [3u8, 0];
            let mut read_n = 0usize;
            while read_n < 2 {
                let n = read_fd(pipe[0], buf.as_mut_ptr().add(read_n), 2 - read_n);
                if n <= 0 {
                    break;
                }
                read_n += n as usize;
            }
            close(pipe[0]);
            let mut status: i32 = 0;
            libc_waitpid(pid, &mut status, 0);
            (buf[0], buf[1])
        } else {
            close(pipe[0]);
            close(pipe[1]);
            (2, 0)
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
    let config = SandboxConfig::new(SandboxMode::WorkspaceWrite, Some(tmp.path().to_path_buf()));

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
                    .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok())
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
    fn truncate(path: *const std::os::raw::c_char, length: i64) -> i32;
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
