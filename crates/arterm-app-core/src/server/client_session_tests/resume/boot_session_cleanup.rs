// Resuming away from a boot session must reclaim the boot session's files.
//
// Every client connection boots with a throwaway session. When the client
// immediately resumes another one, that boot session never held a
// conversation — before the fix it stayed on disk forever, which is how the
// session store (and every picker list) filled with empty rows.

use super::*;

#[tokio::test]
async fn handle_resume_session_deletes_unused_boot_session_files() -> Result<()> {
    let _guard = crate::storage::lock_test_env();
    let (_runtime, prev_runtime) = setup_runtime_dir()?;

    let target_session_id = "session_real_chat_boot_cleanup";
    let boot_session_id = "session_boot_throwaway_boot_cleanup";

    // A real conversation on disk for the target.
    let mut persisted = crate::session::Session::create_with_id(
        target_session_id.to_string(),
        None,
        Some("Real chat".to_string()),
    );
    persisted.save()?;

    // The boot session exists on disk too, with only internal bookkeeping
    // (no visible conversation): that is what makes it discardable.
    let mut boot = crate::session::Session::create_with_id(
        boot_session_id.to_string(),
        None,
        Some("boot".to_string()),
    );
    boot.save()?;
    // A rolling `<id>.bak` next to the snapshot (extension replaced, as
    // `write_bytes_inner` leaves it): the delete has to reclaim that copy
    // too, or every boot session still costs a lingering file. Written by
    // hand because `save()` may append to the journal instead of rewriting
    // the snapshot, which would not produce one.
    let boot_bak = crate::session::session_path(boot_session_id)
        .expect("boot session path")
        .with_extension("bak");
    std::fs::write(&boot_bak, b"stale boot snapshot copy")?;
    assert!(
        crate::session::session_exists(boot_session_id),
        "boot session should start on disk"
    );

    let provider: Arc<dyn Provider> = Arc::new(MockProvider);
    let registry = Registry::new(provider.clone()).await;
    let agent = Arc::new(Mutex::new(build_test_agent_with_id(
        provider.clone(),
        registry.clone(),
        boot_session_id,
        Vec::new(),
    )));

    let sessions = Arc::new(RwLock::new(HashMap::from([(
        boot_session_id.to_string(),
        Arc::clone(&agent),
    )])));
    let shutdown_signals = Arc::new(RwLock::new(HashMap::<String, InterruptSignal>::new()));
    let soft_interrupt_queues: SessionInterruptQueues = Arc::new(RwLock::new(HashMap::new()));
    let now = Instant::now();
    let client_connections = Arc::new(RwLock::new(HashMap::from([(
        "conn_boot".to_string(),
        ClientConnectionInfo {
            client_id: "conn_boot".to_string(),
            session_id: boot_session_id.to_string(),
            client_instance_id: None,
            debug_client_id: None,
            connected_at: now,
            last_seen: now,
            is_processing: false,
            current_tool_name: None,
            terminal_env: Vec::new(),
            disconnect_tx: mpsc::unbounded_channel().0,
        },
    )])));
    let client_debug_state = Arc::new(RwLock::new(ClientDebugState::default()));
    let swarm_members = Arc::new(RwLock::new(HashMap::<String, SwarmMember>::new()));
    let swarms_by_id = Arc::new(RwLock::new(HashMap::<String, HashSet<String>>::new()));
    let file_touch = FileTouchService::new();
    let channel_subscriptions = Arc::new(RwLock::new(HashMap::<
        String,
        HashMap<String, HashSet<String>>,
    >::new()));
    let channel_subscriptions_by_session = Arc::new(RwLock::new(HashMap::<
        String,
        HashMap<String, HashSet<String>>,
    >::new()));
    let swarm_plans = Arc::new(RwLock::new(HashMap::<String, VersionedPlan>::new()));
    let swarm_coordinators = Arc::new(RwLock::new(HashMap::<String, String>::new()));
    let client_count = Arc::new(RwLock::new(1usize));
    let (writer, _peer_stream) = test_writer()?;
    let (client_event_tx, mut client_event_rx) = mpsc::unbounded_channel::<ServerEvent>();
    let event_history = Arc::new(RwLock::new(VecDeque::<SwarmEvent>::new()));
    let event_counter = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let (swarm_event_tx, _swarm_event_rx) = broadcast::channel::<SwarmEvent>(8);
    let mcp_pool = Arc::new(crate::mcp::SharedMcpPool::from_default_config());

    let mut client_selfdev = false;
    let mut client_session_id = boot_session_id.to_string();

    handle_resume_session(
        77,
        target_session_id.to_string(),
        None,
        None,
        false,
        false,
        &mut client_selfdev,
        &mut client_session_id,
        "conn_boot",
        &agent,
        &provider,
        &registry,
        &sessions,
        &shutdown_signals,
        &soft_interrupt_queues,
        &client_connections,
        &client_debug_state,
        &swarm_members,
        &swarms_by_id,
        &file_touch,
        &channel_subscriptions,
        &channel_subscriptions_by_session,
        &swarm_plans,
        &swarm_coordinators,
        &client_count,
        &writer,
        "test-server",
        "🌿",
        &client_event_tx,
        &mcp_pool,
        &event_history,
        &event_counter,
        &swarm_event_tx,
    )
    .await?;

    let events = collect_events_until_done(&mut client_event_rx, 77).await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, ServerEvent::Done { id } if *id == 77)),
        "expected Done event for restore, got {events:?}"
    );
    assert_eq!(client_session_id, target_session_id);

    // The deletion runs on a blocking task; give it a moment to land.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while (crate::session::session_exists(boot_session_id) || boot_bak.exists())
        && std::time::Instant::now() < deadline
    {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        !crate::session::session_exists(boot_session_id),
        "an empty boot session must be deleted after the client resumes away from it"
    );
    assert!(
        !boot_bak.exists(),
        "the boot session's rolling backup must go with it"
    );
    assert!(
        crate::session::session_exists(target_session_id),
        "the resumed target session must stay on disk"
    );

    restore_runtime_dir(prev_runtime);
    Ok(())
}

/// The discard decision reads real messages, not just metadata: a boot session
/// the user actually typed into has a visible conversation and must survive a
/// resume away from it. This pins the stub-vs-full-load distinction — a
/// metadata-only stub has no message vector and cannot tell the two apart.
#[tokio::test]
async fn handle_resume_session_keeps_a_boot_session_with_conversation() -> Result<()> {
    let _guard = crate::storage::lock_test_env();
    let (_runtime, prev_runtime) = setup_runtime_dir()?;

    let target_session_id = "session_real_chat_boot_keep";
    let boot_session_id = "session_boot_typed_boot_keep";

    let mut persisted = crate::session::Session::create_with_id(
        target_session_id.to_string(),
        None,
        Some("Real chat".to_string()),
    );
    persisted.save()?;

    // The boot session holds a real user turn: resuming away must not delete it.
    // The turn lives in the agent's in-memory session too — in the real flow the
    // messages reached disk *through* that session, and constructing the agent
    // with an empty one would have it overwrite the transcript on its first
    // persist.
    let user_turn = crate::session::StoredMessage {
        id: "msg_user_1".to_string(),
        role: crate::message::Role::User,
        content: vec![ContentBlock::Text {
            text: "hello from the boot session".to_string(),
            cache_control: None,
        }],
        display_role: None,
        timestamp: None,
        tool_duration_ms: None,
        token_usage: None,
    };
    let mut boot = crate::session::Session::create_with_id(
        boot_session_id.to_string(),
        None,
        Some("typed boot".to_string()),
    );
    boot.messages.push(user_turn.clone());
    boot.save()?;

    let provider: Arc<dyn Provider> = Arc::new(MockProvider);
    let registry = Registry::new(provider.clone()).await;
    let agent = Arc::new(Mutex::new(build_test_agent_with_id(
        provider.clone(),
        registry.clone(),
        boot_session_id,
        vec![user_turn],
    )));

    let sessions = Arc::new(RwLock::new(HashMap::from([(
        boot_session_id.to_string(),
        Arc::clone(&agent),
    )])));
    let shutdown_signals = Arc::new(RwLock::new(HashMap::<String, InterruptSignal>::new()));
    let soft_interrupt_queues: SessionInterruptQueues = Arc::new(RwLock::new(HashMap::new()));
    let now = Instant::now();
    let client_connections = Arc::new(RwLock::new(HashMap::from([(
        "conn_keep".to_string(),
        ClientConnectionInfo {
            client_id: "conn_keep".to_string(),
            session_id: boot_session_id.to_string(),
            client_instance_id: None,
            debug_client_id: None,
            connected_at: now,
            last_seen: now,
            is_processing: false,
            current_tool_name: None,
            terminal_env: Vec::new(),
            disconnect_tx: mpsc::unbounded_channel().0,
        },
    )])));
    let client_debug_state = Arc::new(RwLock::new(ClientDebugState::default()));
    let swarm_members = Arc::new(RwLock::new(HashMap::<String, SwarmMember>::new()));
    let swarms_by_id = Arc::new(RwLock::new(HashMap::<String, HashSet<String>>::new()));
    let file_touch = FileTouchService::new();
    let channel_subscriptions = Arc::new(RwLock::new(HashMap::<
        String,
        HashMap<String, HashSet<String>>,
    >::new()));
    let channel_subscriptions_by_session = Arc::new(RwLock::new(HashMap::<
        String,
        HashMap<String, HashSet<String>>,
    >::new()));
    let swarm_plans = Arc::new(RwLock::new(HashMap::<String, VersionedPlan>::new()));
    let swarm_coordinators = Arc::new(RwLock::new(HashMap::<String, String>::new()));
    let client_count = Arc::new(RwLock::new(1usize));
    let (writer, _peer_stream) = test_writer()?;
    let (client_event_tx, mut client_event_rx) = mpsc::unbounded_channel::<ServerEvent>();
    let event_history = Arc::new(RwLock::new(VecDeque::<SwarmEvent>::new()));
    let event_counter = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let (swarm_event_tx, _swarm_event_rx) = broadcast::channel::<SwarmEvent>(8);
    let mcp_pool = Arc::new(crate::mcp::SharedMcpPool::from_default_config());

    let mut client_selfdev = false;
    let mut client_session_id = boot_session_id.to_string();

    handle_resume_session(
        78,
        target_session_id.to_string(),
        None,
        None,
        false,
        false,
        &mut client_selfdev,
        &mut client_session_id,
        "conn_keep",
        &agent,
        &provider,
        &registry,
        &sessions,
        &shutdown_signals,
        &soft_interrupt_queues,
        &client_connections,
        &client_debug_state,
        &swarm_members,
        &swarms_by_id,
        &file_touch,
        &channel_subscriptions,
        &channel_subscriptions_by_session,
        &swarm_plans,
        &swarm_coordinators,
        &client_count,
        &writer,
        "test-server",
        "🌿",
        &client_event_tx,
        &mcp_pool,
        &event_history,
        &event_counter,
        &swarm_event_tx,
    )
    .await?;

    let events = collect_events_until_done(&mut client_event_rx, 78).await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, ServerEvent::Done { id } if *id == 78)),
        "expected Done event for restore, got {events:?}"
    );

    // Give the (not-run) deletion path a moment in case it was wrongly queued.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        crate::session::session_exists(boot_session_id),
        "a boot session with a visible conversation must stay on disk"
    );
    assert!(
        crate::session::session_exists(target_session_id),
        "the resumed target session must stay on disk"
    );

    restore_runtime_dir(prev_runtime);
    Ok(())
}
