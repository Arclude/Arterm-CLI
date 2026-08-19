use super::*;
use anyhow::{Result, anyhow};

#[test]
fn mark_active_writes_last_active_at_to_disk() -> Result<()> {
    let _env_lock = lock_env();
    let temp_home = tempfile::Builder::new()
        .prefix("arterm-mark-active-persist-")
        .tempdir()
        .map_err(|e| anyhow!(e))?;
    let _home = EnvVarGuard::set("ARTERM_HOME", temp_home.path().as_os_str());
    let _test_flag = EnvVarGuard::set("ARTERM_TEST_SESSION", "0");

    let id = "session_fox_persist".to_string();
    let mut session = Session::create_with_id(id.clone(), None, Some("Open chat".to_string()));
    session.last_active_at = None;
    session.save()?;
    session.mark_active();

    let loaded = Session::load(&id)?;
    assert!(
        loaded.last_active_at.is_some(),
        "a peer lists this file; the stamp cannot stay in memory only"
    );
    Ok(())
}
