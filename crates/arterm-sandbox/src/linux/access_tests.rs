//! Pins the access-right table in `access.rs` against the kernel UAPI header.
//!
//! These are pure bit checks with no syscalls in them; the tests that ask the
//! running kernel what it enforces live in `linux_tests.rs`.

use super::*;

/// Every filesystem right, pinned to the bit the kernel gives it in
/// `include/uapi/linux/landlock.h`.
///
/// Nothing compared these two tables before, and they had drifted: the
/// constants omitted `READ_FILE` and `READ_DIR`, which shifted every name from
/// `REMOVE_*` down by two bits. `MAKE_REG` was really `MAKE_CHAR`, so the one
/// right the sandbox meant to hold -- "do not create files here" -- was never
/// handled at all.
#[test]
fn fs_access_flags_match_kernel_uapi() {
    let kernel: &[(&str, u64, u32)] = &[
        ("EXECUTE", LANDLOCK_ACCESS_FS_EXECUTE, 0),
        ("WRITE_FILE", LANDLOCK_ACCESS_FS_WRITE_FILE, 1),
        ("READ_FILE", LANDLOCK_ACCESS_FS_READ_FILE, 2),
        ("READ_DIR", LANDLOCK_ACCESS_FS_READ_DIR, 3),
        ("REMOVE_DIR", LANDLOCK_ACCESS_FS_REMOVE_DIR, 4),
        ("REMOVE_FILE", LANDLOCK_ACCESS_FS_REMOVE_FILE, 5),
        ("MAKE_CHAR", LANDLOCK_ACCESS_FS_MAKE_CHAR, 6),
        ("MAKE_DIR", LANDLOCK_ACCESS_FS_MAKE_DIR, 7),
        ("MAKE_REG", LANDLOCK_ACCESS_FS_MAKE_REG, 8),
        ("MAKE_SOCK", LANDLOCK_ACCESS_FS_MAKE_SOCK, 9),
        ("MAKE_FIFO", LANDLOCK_ACCESS_FS_MAKE_FIFO, 10),
        ("MAKE_BLOCK", LANDLOCK_ACCESS_FS_MAKE_BLOCK, 11),
        ("MAKE_SYM", LANDLOCK_ACCESS_FS_MAKE_SYM, 12),
        ("REFER", LANDLOCK_ACCESS_FS_REFER, 13),
        ("TRUNCATE", LANDLOCK_ACCESS_FS_TRUNCATE, 14),
        ("IOCTL_DEV", LANDLOCK_ACCESS_FS_IOCTL_DEV, 15),
        ("RESOLVE_UNIX", LANDLOCK_ACCESS_FS_RESOLVE_UNIX, 16),
    ];
    for &(name, ours, bit) in kernel {
        assert_eq!(
            ours,
            1u64 << bit,
            "LANDLOCK_ACCESS_FS_{name} must be bit {bit}"
        );
    }
    let union = kernel.iter().fold(0u64, |acc, &(_, flag, _)| acc | flag);
    assert_eq!(
        union.count_ones() as usize,
        kernel.len(),
        "two rights share a bit"
    );
    assert_eq!(ALL_KNOWN_ACCESS, union, "ALL_KNOWN_ACCESS misses a right");
}

#[test]
fn net_access_flags_match_kernel_uapi() {
    // BIND_TCP is 1 << 0 and deliberately unhandled; CONNECT_TCP is 1 << 1.
    assert_eq!(LANDLOCK_ACCESS_NET_CONNECT_TCP, 1u64 << 1);
}

/// The handled set, spelled out. A right that leaves this set stops being
/// denied anywhere, which is a security change and should read as one.
#[test]
fn restricted_write_access_covers_every_way_to_change_a_file() {
    for (name, flag) in [
        ("WRITE_FILE", LANDLOCK_ACCESS_FS_WRITE_FILE),
        ("TRUNCATE", LANDLOCK_ACCESS_FS_TRUNCATE),
        ("REMOVE_FILE", LANDLOCK_ACCESS_FS_REMOVE_FILE),
        ("REMOVE_DIR", LANDLOCK_ACCESS_FS_REMOVE_DIR),
        ("MAKE_REG", LANDLOCK_ACCESS_FS_MAKE_REG),
        ("MAKE_DIR", LANDLOCK_ACCESS_FS_MAKE_DIR),
        ("MAKE_SYM", LANDLOCK_ACCESS_FS_MAKE_SYM),
        ("MAKE_CHAR", LANDLOCK_ACCESS_FS_MAKE_CHAR),
        ("MAKE_BLOCK", LANDLOCK_ACCESS_FS_MAKE_BLOCK),
        ("REFER", LANDLOCK_ACCESS_FS_REFER),
    ] {
        assert_ne!(
            RESTRICTED_WRITE_ACCESS & flag,
            0,
            "{name} must be handled, or it is allowed everywhere"
        );
    }
    // Documented exclusions, each for a reason on RESTRICTED_WRITE_ACCESS.
    for (name, flag) in [
        ("MAKE_SOCK", LANDLOCK_ACCESS_FS_MAKE_SOCK),
        ("MAKE_FIFO", LANDLOCK_ACCESS_FS_MAKE_FIFO),
        ("IOCTL_DEV", LANDLOCK_ACCESS_FS_IOCTL_DEV),
        ("RESOLVE_UNIX", LANDLOCK_ACCESS_FS_RESOLVE_UNIX),
        ("READ_FILE", LANDLOCK_ACCESS_FS_READ_FILE),
        ("READ_DIR", LANDLOCK_ACCESS_FS_READ_DIR),
        ("EXECUTE", LANDLOCK_ACCESS_FS_EXECUTE),
    ] {
        assert_eq!(
            RESTRICTED_WRITE_ACCESS & flag,
            0,
            "{name} is handled but nothing grants it; that denies it everywhere"
        );
    }
    assert_eq!(
        RESTRICTED_WRITE_ACCESS & !ALL_WRITE_ACCESS,
        0,
        "handled set escaped the write table"
    );
}

/// A `handled_access_fs` with a bit the kernel does not know fails ruleset
/// creation outright, so asking for one right too many costs all of them.
#[test]
fn restricted_write_access_drops_rights_older_kernels_reject() {
    let v1 = restricted_write_access(1);
    assert_eq!(v1 & LANDLOCK_ACCESS_FS_REFER, 0, "REFER needs ABI v2");
    assert_eq!(v1 & LANDLOCK_ACCESS_FS_TRUNCATE, 0, "TRUNCATE needs ABI v3");

    let v2 = restricted_write_access(REFER_ABI_VERSION);
    assert_ne!(v2 & LANDLOCK_ACCESS_FS_REFER, 0);
    assert_eq!(v2 & LANDLOCK_ACCESS_FS_TRUNCATE, 0);

    let v3 = restricted_write_access(TRUNCATE_ABI_VERSION);
    assert_ne!(v3 & LANDLOCK_ACCESS_FS_TRUNCATE, 0);
    assert_eq!(
        v3, RESTRICTED_WRITE_ACCESS,
        "nothing we handle needs an ABI above v3"
    );
    assert_eq!(restricted_write_access(u32::MAX), RESTRICTED_WRITE_ACCESS);

    // Whatever survives the v1 narrowing must itself be an ABI v1 right.
    const V1_RIGHTS: u64 = LANDLOCK_ACCESS_FS_EXECUTE
        | LANDLOCK_ACCESS_FS_WRITE_FILE
        | LANDLOCK_ACCESS_FS_READ_FILE
        | LANDLOCK_ACCESS_FS_READ_DIR
        | LANDLOCK_ACCESS_FS_REMOVE_DIR
        | LANDLOCK_ACCESS_FS_REMOVE_FILE
        | LANDLOCK_ACCESS_FS_MAKE_CHAR
        | LANDLOCK_ACCESS_FS_MAKE_DIR
        | LANDLOCK_ACCESS_FS_MAKE_REG
        | LANDLOCK_ACCESS_FS_MAKE_SOCK
        | LANDLOCK_ACCESS_FS_MAKE_FIFO
        | LANDLOCK_ACCESS_FS_MAKE_BLOCK
        | LANDLOCK_ACCESS_FS_MAKE_SYM;
    assert_eq!(v1 & !V1_RIGHTS, 0, "a post-v1 right survived the v1 gate");
}

/// The file mask may only carry rights that mean something on a file.
#[test]
fn file_write_access_holds_no_directory_only_right() {
    assert_eq!(FILE_WRITE_ACCESS & !RESTRICTED_WRITE_ACCESS, 0);
    const DIRECTORY_ONLY: u64 = LANDLOCK_ACCESS_FS_REMOVE_FILE
        | LANDLOCK_ACCESS_FS_REMOVE_DIR
        | LANDLOCK_ACCESS_FS_MAKE_CHAR
        | LANDLOCK_ACCESS_FS_MAKE_DIR
        | LANDLOCK_ACCESS_FS_MAKE_REG
        | LANDLOCK_ACCESS_FS_MAKE_SOCK
        | LANDLOCK_ACCESS_FS_MAKE_FIFO
        | LANDLOCK_ACCESS_FS_MAKE_BLOCK
        | LANDLOCK_ACCESS_FS_MAKE_SYM
        | LANDLOCK_ACCESS_FS_REFER;
    assert_eq!(
        FILE_WRITE_ACCESS & DIRECTORY_ONLY,
        0,
        "a directory-only right on a file target makes landlock_add_rule return EINVAL"
    );
    assert_ne!(
        FILE_WRITE_ACCESS & LANDLOCK_ACCESS_FS_TRUNCATE,
        0,
        "a file-granular root that cannot truncate cannot be overwritten by `>`"
    );
}
