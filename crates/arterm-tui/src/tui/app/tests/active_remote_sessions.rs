#[test]
fn selecting_a_paired_device_row_does_not_resume_it_locally() {
    let mut app = create_test_app();
    app.session_picker_mode = SessionPickerMode::ActiveSessions;
    let remote = crate::tui::session_picker::SessionInfo {
        id: "session_windows".to_string(),
        parent_id: None,
        short_name: "sauropod".to_string(),
        icon: "s".to_string(),
        title: "Windows chat".to_string(),
        message_count: 1,
        user_message_count: 1,
        assistant_message_count: 0,
        created_at: chrono::Utc::now(),
        last_message_time: chrono::Utc::now(),
        last_active_at: Some(chrono::Utc::now()),
        working_dir: None,
        model: None,
        provider_key: None,
        is_canary: false,
        is_debug: false,
        saved: false,
        save_label: None,
        status: crate::session::SessionStatus::Active,
        needs_catchup: false,
        estimated_tokens: 0,
        first_user_prompt: None,
        messages_preview: Vec::new(),
        search_index: "sauropod".to_string(),
        server_name: Some("island".to_string()),
        server_icon: None,
        source: crate::tui::session_picker::SessionSource::Arterm,
        resume_target: crate::tui::session_picker::ResumeTarget::ArtermSession {
            session_id: "session_windows".to_string(),
        },
        external_path: None,
    };
    app.session_picker_overlay = Some(RefCell::new(
        crate::tui::session_picker::SessionPicker::new(vec![remote]),
    ));

    app.handle_session_picker_key(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::empty(),
    )
    .expect("session picker enter should succeed");

    assert!(
        app.workspace_client.take_pending_resume_session().is_none(),
        "a Windows row must not resume on this machine"
    );
    assert!(
        app.workspace_client.take_pending_peer_switch().is_none(),
        "an unpaired name cannot stand up a relay"
    );
    assert!(
        app.session_picker_overlay.is_some(),
        "the picker stays open so the user can pick something else"
    );
}

#[test]
fn selecting_a_paired_device_row_queues_a_peer_switch() {
    let _guard = crate::storage::lock_test_env();
    let temp = tempfile::tempdir().expect("tempdir");
    let prev_home = std::env::var_os("ARTERM_HOME");
    crate::env::set_var("ARTERM_HOME", temp.path());

    let fingerprint = "ab".repeat(32);
    let mut trust = arterm_device::TrustStore::load().expect("trust store");
    trust
        .trust(arterm_device::TrustedDevice {
            fingerprint,
            name: "island".to_string(),
            address: Some("127.0.0.1:1".to_string()),
            paired_at: "now".to_string(),
        })
        .expect("pair island");

    let runtime = tokio::runtime::Runtime::new().expect("test runtime");
    let _rt = runtime.enter();
    let mut app = create_test_app();
    app.session_picker_mode = SessionPickerMode::ActiveSessions;
    let remote = crate::tui::session_picker::SessionInfo {
        id: "session_windows".to_string(),
        parent_id: None,
        short_name: "sauropod".to_string(),
        icon: "s".to_string(),
        title: "Windows chat".to_string(),
        message_count: 1,
        user_message_count: 1,
        assistant_message_count: 0,
        created_at: chrono::Utc::now(),
        last_message_time: chrono::Utc::now(),
        last_active_at: Some(chrono::Utc::now()),
        working_dir: None,
        model: None,
        provider_key: None,
        is_canary: false,
        is_debug: false,
        saved: false,
        save_label: None,
        status: crate::session::SessionStatus::Active,
        needs_catchup: false,
        estimated_tokens: 0,
        first_user_prompt: None,
        messages_preview: Vec::new(),
        search_index: "sauropod island".to_string(),
        server_name: Some("island".to_string()),
        server_icon: None,
        source: crate::tui::session_picker::SessionSource::Arterm,
        resume_target: crate::tui::session_picker::ResumeTarget::ArtermSession {
            session_id: "session_windows".to_string(),
        },
        external_path: None,
    };
    app.session_picker_overlay = Some(RefCell::new(
        crate::tui::session_picker::SessionPicker::new(vec![remote]),
    ));

    app.handle_session_picker_key(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::empty(),
    )
    .expect("session picker enter should succeed");

    assert!(
        app.workspace_client.take_pending_resume_session().is_none(),
        "a Windows row must not resume on this machine"
    );
    let switch = app
        .workspace_client
        .take_pending_peer_switch()
        .expect("selecting island must queue the same relay as device connect");
    assert_eq!(switch.device, "island");
    assert_eq!(switch.session_id.as_deref(), Some("session_windows"));
    assert!(
        app.session_picker_overlay.is_none(),
        "a switch that will happen closes the picker"
    );

    if let Some(prev_home) = prev_home {
        crate::env::set_var("ARTERM_HOME", prev_home);
    } else {
        crate::env::remove_var("ARTERM_HOME");
    }
}

#[test]
fn slash_active_loads_a_paired_live_row_into_the_picker() {
    let _guard = crate::storage::lock_test_env();
    let temp = tempfile::tempdir().expect("tempdir");
    let prev_home = std::env::var_os("ARTERM_HOME");
    crate::env::set_var("ARTERM_HOME", temp.path());
    crate::config::invalidate_config_cache();
    crate::tui::session_picker::invalidate_session_list_cache();

    let host_dir = temp.path().join("host-device");
    std::fs::create_dir_all(&host_dir).expect("host dir");
    let host = arterm_device::DeviceIdentity::load_or_create_in(&host_dir).expect("host");
    let guest = arterm_device::DeviceIdentity::load_or_create().expect("guest");
    let host_gate = arterm_peer::gate::TrustGate::in_dir(&host_dir);
    host_gate
        .record_pairing(&guest.fingerprint(), "guest", None)
        .expect("host trusts this machine");

    let advertised = vec![arterm_peer::RemoteServerSummary {
        name: "camp".to_string(),
        icon: "⛺".to_string(),
        version: "v0.10.16-dev".to_string(),
        sessions: vec!["session_open".to_string(), "session_old".to_string()],
        details: vec![
            arterm_peer::RemoteSessionSummary {
                id: "session_open".to_string(),
                short_name: "sauropod".to_string(),
                title: "Open Windows chat".to_string(),
                last_message_at_ms: 1_000,
                is_active: true,
                ..Default::default()
            },
            arterm_peer::RemoteSessionSummary {
                id: "session_old".to_string(),
                short_name: "owl".to_string(),
                title: "Saved Windows chat".to_string(),
                last_message_at_ms: 1_000,
                is_active: false,
                ..Default::default()
            },
        ],
    }];
    let host_fp = host.fingerprint();
    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    let listener_thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("listener runtime");
        runtime.block_on(async move {
            let host_creds =
                arterm_peer::tls::PeerCredentials::from_identity(&host).expect("host creds");
            let bind: std::net::SocketAddr = "127.0.0.1:0".parse().expect("bind");
            let listener = arterm_peer::listen::PeerListener::bind_with_policy(
                bind,
                &host_creds,
                host_gate,
                arterm_peer::subnet::SubnetPolicy::ThisMachine,
            )
            .await
            .expect("bind")
            .with_local_sessions(std::sync::Arc::new(move || advertised.clone()));
            addr_tx
                .send(listener.local_addr())
                .expect("send listener addr");
            match listener.accept().await.expect("accept") {
                arterm_peer::listen::Arrival::Pending(pending) => {
                    let _ = listener.admitter().establish(pending).await;
                }
                other => panic!("expected a pending peer, got {other:?}"),
            }
        });
    });
    let addr = addr_rx.recv().expect("listener bound");

    let mut trust = arterm_device::TrustStore::load().expect("trust store");
    trust
        .trust(arterm_device::TrustedDevice {
            fingerprint: host_fp.to_hex(),
            name: "island".to_string(),
            address: Some(addr.to_string()),
            paired_at: "now".to_string(),
        })
        .expect("pair island");

    let runtime = tokio::runtime::Runtime::new().expect("test runtime");
    let _enter = runtime.enter();
    let mut app = create_test_app();
    app.input = "/active".to_string();
    app.submit_input();
    assert_eq!(app.session_picker_mode, SessionPickerMode::ActiveSessions);

    runtime.block_on(async {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            app.poll_session_picker_load();
            let has_remote = app.session_picker_overlay.as_ref().is_some_and(|cell| {
                cell.borrow()
                    .remote_device_for_session("session_open")
                    .is_some()
            });
            if has_remote {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "/active never loaded the paired live row"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    });

    let picker = app.session_picker_overlay.as_ref().expect("overlay");
    let picker = picker.borrow();
    let visible: Vec<String> = picker
        .visible_session_iter()
        .map(|session| session.id.clone())
        .collect();
    assert_eq!(visible, vec!["session_open".to_string()]);
    assert_eq!(
        picker.remote_device_for_session("session_open").as_deref(),
        Some("island")
    );
    drop(picker);

    if let Some(prev_home) = prev_home {
        crate::env::set_var("ARTERM_HOME", prev_home);
    } else {
        crate::env::remove_var("ARTERM_HOME");
    }
    crate::config::invalidate_config_cache();
    crate::tui::session_picker::invalidate_session_list_cache();
    let _ = listener_thread.join();
}

#[test]
fn left_arrow_on_empty_input_is_a_noop_unless_opted_in() {
    let runtime = tokio::runtime::Runtime::new().expect("test runtime");
    let _guard = runtime.enter();
    let mut app = create_test_app();

    // Default config: the active sessions manager gesture is opt-in, so Left
    // on an empty input must not open any overlay.
    assert!(!app.maybe_open_active_sessions_on_left());
    assert!(app.session_picker_overlay.is_none());

    // With text in the input the gesture never fires regardless of config.
    app.input = "hello".to_string();
    app.cursor_pos = 0;
    assert!(!app.maybe_open_active_sessions_on_left());
    assert!(app.session_picker_overlay.is_none());
}

#[test]
fn left_arrow_on_empty_input_opens_active_picker_when_opted_in() {
    let _guard = crate::storage::lock_test_env();
    let temp = tempfile::tempdir().expect("tempdir");
    let prev_home = std::env::var_os("ARTERM_HOME");
    crate::env::set_var("ARTERM_HOME", temp.path());
    std::fs::write(
        temp.path().join("config.toml"),
        "[display]\nactive_sessions_manager = true\n",
    )
    .expect("write config");
    crate::config::invalidate_config_cache();

    let runtime = tokio::runtime::Runtime::new().expect("test runtime");
    let _rt = runtime.enter();
    let mut app = create_test_app();
    assert!(app.input.is_empty());
    assert_eq!(app.cursor_pos, 0);
    assert!(app.maybe_open_active_sessions_on_left());
    assert!(app.session_picker_overlay.is_some());
    assert_eq!(app.session_picker_mode, SessionPickerMode::ActiveSessions);

    if let Some(prev_home) = prev_home {
        crate::env::set_var("ARTERM_HOME", prev_home);
    } else {
        crate::env::remove_var("ARTERM_HOME");
    }
    crate::config::invalidate_config_cache();
}

#[test]
fn active_picker_reseed_keeps_only_live_remote_rows() {
    let runtime = tokio::runtime::Runtime::new().expect("test runtime");
    let _guard = runtime.enter();
    let mut app = create_test_app();
    app.input = "/active".to_string();
    app.submit_input();

    let now = chrono::Utc::now();
    let mut live = crate::tui::session_picker::SessionInfo {
        id: "session_windows_live".to_string(),
        parent_id: None,
        short_name: "sauropod".to_string(),
        icon: "s".to_string(),
        title: "Open Windows chat".to_string(),
        message_count: 1,
        user_message_count: 1,
        assistant_message_count: 0,
        created_at: now,
        last_message_time: now - chrono::Duration::hours(6),
        last_active_at: Some(now),
        working_dir: None,
        model: None,
        provider_key: None,
        is_canary: false,
        is_debug: false,
        saved: false,
        save_label: None,
        status: crate::session::SessionStatus::Closed,
        needs_catchup: false,
        estimated_tokens: 0,
        first_user_prompt: None,
        messages_preview: Vec::new(),
        search_index: "sauropod island".to_string(),
        server_name: Some("island".to_string()),
        server_icon: None,
        source: crate::tui::session_picker::SessionSource::Arterm,
        resume_target: crate::tui::session_picker::ResumeTarget::ArtermSession {
            session_id: "session_windows_live".to_string(),
        },
        external_path: None,
    };
    let mut stale = live.clone();
    stale.id = "session_windows_old".to_string();
    stale.short_name = "owl".to_string();
    stale.title = "Old Windows chat".to_string();
    stale.last_active_at = None;
    stale.search_index = "owl island".to_string();
    stale.resume_target = crate::tui::session_picker::ResumeTarget::ArtermSession {
        session_id: "session_windows_old".to_string(),
    };
    live.last_active_at = Some(now);

    {
        let picker = app.session_picker_overlay.as_ref().expect("overlay");
        picker.borrow_mut().reseed_grouped(
            vec![crate::tui::session_picker::ServerGroup {
                name: "Remote devices".to_string(),
                icon: "🖧".to_string(),
                version: String::new(),
                git_hash: String::new(),
                is_running: true,
                sessions: vec![live, stale],
            }],
            Vec::new(),
        );
    }

    let picker = app.session_picker_overlay.as_ref().expect("overlay");
    let picker = picker.borrow();
    let visible: Vec<String> = picker
        .visible_session_iter()
        .map(|session| session.id.clone())
        .collect();
    assert_eq!(visible, vec!["session_windows_live".to_string()]);
    assert_eq!(
        picker
            .remote_device_for_session("session_windows_live")
            .as_deref(),
        Some("island")
    );
}
