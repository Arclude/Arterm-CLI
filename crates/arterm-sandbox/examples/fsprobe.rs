// Standalone single-threaded filesystem probe: apply the sandbox in this
// process, then attempt one write primitive per line and print whether the
// kernel allowed it. An escape shows up as ALLOWED on a path the mode is
// supposed to deny.
//
// Usage: fsprobe <read-only|workspace-write|full-access> <workspace-dir> <outside-dir>
//
// Both directories and the fixtures the destructive probes consume
// (existing.txt, victim.txt, victim_dir/, movable.txt, sub_a/reparent.txt,
// sub_b/) must exist before this runs -- creating them afterwards is exactly
// what is being measured. Keep the directories outside /tmp: temp is writable
// in every sandboxed mode, so a probe there passes while proving nothing.
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::os::unix::ffi::OsStrExt as _;
use std::path::Path;

fn report(label: &str, result: std::io::Result<()>) {
    match result {
        Ok(()) => println!("  {label:<26} ALLOWED"),
        Err(e) => println!(
            "  {label:<26} DENIED errno={} ({e})",
            e.raw_os_error().unwrap_or(-1)
        ),
    }
}

fn make_reg(dir: &Path) -> std::io::Result<()> {
    File::create(dir.join("probe_new_file.txt")).map(drop)
}

fn write_existing(dir: &Path) -> std::io::Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .open(dir.join("existing.txt"))?;
    f.write_all(b"clobbered")
}

/// `open(O_WRONLY|O_TRUNC)` -- what the shell's `>` does to an existing file.
fn truncate_via_open(dir: &Path) -> std::io::Result<()> {
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(dir.join("existing.txt"))
        .map(drop)
}

/// `truncate(2)` on a path. No open, so `WRITE_FILE` is never consulted: only
/// `LANDLOCK_ACCESS_FS_TRUNCATE` stands between this and an emptied file.
fn truncate_via_path(dir: &Path) -> std::io::Result<()> {
    unsafe extern "C" {
        fn truncate(path: *const std::os::raw::c_char, length: i64) -> i32;
    }
    let path = dir.join("existing.txt");
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::other("path contains NUL"))?;
    if unsafe { truncate(path.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn probe_dir(label: &str, dir: &Path) {
    println!("{label} ({}):", dir.display());
    report("create regular file", make_reg(dir));
    report("write existing file", write_existing(dir));
    report("truncate via truncate(2)", truncate_via_path(dir));
    report("truncate via open O_TRUNC", truncate_via_open(dir));
    report("mkdir", fs::create_dir(dir.join("probe_new_dir")));
    report("remove file", fs::remove_file(dir.join("victim.txt")));
    report("rmdir", fs::remove_dir(dir.join("victim_dir")));
    report(
        "symlink",
        std::os::unix::fs::symlink("target", dir.join("probe_link")),
    );
    report(
        "rename within dir",
        fs::rename(dir.join("movable.txt"), dir.join("probe_moved.txt")),
    );
    report(
        "rename across dirs",
        fs::rename(
            dir.join("sub_a/reparent.txt"),
            dir.join("sub_b/reparent.txt"),
        ),
    );
}

/// `cmd > /dev/null`: O_WRONLY|O_CREAT|O_TRUNC, then a write.
fn probe_dev_null() -> std::io::Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open("/dev/null")?;
    f.write_all(b"redirection still works\n")
}

/// The reported repro, at the layer it was reported from: a Landlock domain is
/// inherited across `exec`, so a shell spawned here runs under the same rules.
/// The bug looked like `bash: permission denied` *plus* a new empty file.
fn probe_shell_redirect(script: &str) {
    let output = std::process::Command::new("bash")
        .arg("-c")
        .arg(script)
        .output();
    match output {
        Ok(out) => println!(
            "  bash -c {script:?}\n    exit={} stderr={}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => println!("  bash -c {script:?} could not run: {e}"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, mode, workspace, outside] = args.as_slice() else {
        eprintln!("usage: fsprobe <mode> <workspace-dir> <outside-dir>");
        std::process::exit(64);
    };
    let mode: arterm_sandbox::SandboxMode = mode.parse().unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(64);
    });
    let (workspace, outside) = (Path::new(workspace), Path::new(outside));

    let config = arterm_sandbox::SandboxConfig::new(mode, Some(workspace.to_path_buf()));
    println!("landlock ABI: v{}", arterm_sandbox::landlock_abi_version());
    match arterm_sandbox::apply(&config) {
        Ok(result) => println!("sandbox: applied={} msg={}", result.applied, result.message),
        Err(e) => {
            eprintln!("sandbox: apply failed: {e}");
            std::process::exit(1);
        }
    }

    probe_dir("OUTSIDE writable roots", outside);
    probe_dir("INSIDE workspace root", workspace);
    println!("DEVICES:");
    report("write /dev/null", probe_dev_null());
    println!("SHELL (domain inherited across exec):");
    probe_shell_redirect(&format!(
        "echo hi > {}/shell_outside.txt",
        outside.display()
    ));
    probe_shell_redirect(&format!(
        "echo hi > {}/shell_inside.txt",
        workspace.display()
    ));
    probe_shell_redirect("echo hi > /dev/null");
}
