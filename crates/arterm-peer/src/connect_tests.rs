//! Empirical proof that peer dial is first-local-candidate-wins.
//!
//! Default dual-stack multihome topology on this class of host:
//! - wlan0 IPv4 LAN (`192.168.1.0/24`)
//! - wlan0 IPv6 GUA `/64`
//! - CloudflareWARP (ignored for these cases once both LAN candidates are local)
//!
//! A peer that listens only on IPv4 still often has both an A and an AAAA in
//! DNS/mDNS. Production [`super::resolve_local_address`] + [`super::connect_tcp`]
//! pick the first `is_local_peer` match and dial that single address under
//! [`super::CONNECT_TIMEOUT`] with no fallback.

use super::{CONNECT_TIMEOUT, connect_tcp, first_local_candidate};
use crate::subnet::{self, LocalNetwork, is_local_peer};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

fn sock(ip: IpAddr, port: u16) -> SocketAddr {
    SocketAddr::new(ip, port)
}

/// Scenario-A/B style networks: LAN v4 /24 + GUA /64 (plus loopback for harness).
fn dualstack_lan_networks(v4: Ipv4Addr, v6_gua: Ipv6Addr) -> Vec<LocalNetwork> {
    vec![
        LocalNetwork::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8),
        LocalNetwork::new(IpAddr::V4(v4), 24),
        LocalNetwork::new(IpAddr::V6(v6_gua), 64),
    ]
}

/// Build a GUA in the same /64 as `local` with host bits set to `host_suffix`.
fn gua_in_same_prefix(local: Ipv6Addr, host_suffix: u64) -> Ipv6Addr {
    let octets = local.octets();
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&octets[..8]);
    out[8..].copy_from_slice(&host_suffix.to_be_bytes());
    Ipv6Addr::from(out)
}

/// Prefer live host interfaces so the connect half of A/B is real traffic.
/// Fall back to synthetic addresses only when the unit half must still compile
/// on a machine without dual-stack LAN (connect cases then skip).
fn live_topology() -> Option<(Ipv4Addr, Ipv6Addr, Vec<LocalNetwork>)> {
    let networks = subnet::local_networks().ok()?;
    let interfaces = if_addrs::get_if_addrs().ok()?;

    let mut lan_v4: Option<Ipv4Addr> = None;
    let mut gua_v6: Option<Ipv6Addr> = None;
    for iface in &interfaces {
        if iface.name != "wlan0" && !iface.name.starts_with("wl") && iface.name != "eth0" {
            // Still accept any non-loopback private /24 + global /64 pair below.
        }
        match &iface.addr {
            if_addrs::IfAddr::V4(v4)
                if v4.ip.is_private() && v4.prefixlen == 24 && !v4.ip.is_loopback() =>
            {
                if lan_v4.is_none() || iface.name.starts_with('w') {
                    lan_v4 = Some(v4.ip);
                }
            }
            if_addrs::IfAddr::V6(v6)
                if v6.prefixlen == 64
                    && !v6.ip.is_loopback()
                    && !v6.ip.is_unicast_link_local()
                    && (v6.ip.segments()[0] & 0xe000) == 0x2000 =>
            {
                // Global unicast 2000::/3, skip WARP /128-style by requiring /64.
                if gua_v6.is_none() || iface.name.starts_with('w') {
                    gua_v6 = Some(v6.ip);
                }
            }
            _ => {}
        }
    }

    let v4 = lan_v4?;
    let v6 = gua_v6?;
    // Sanity: both are local under the real interface table.
    assert!(is_local_peer(&networks, IpAddr::V4(v4)));
    assert!(is_local_peer(&networks, IpAddr::V6(v6)));
    Some((v4, v6, networks))
}

#[test]
fn first_local_candidate_wins_order_a_aaaa_then_a() {
    // Scenario A: resolver order [AAAA in wlan0 GUA /64, A in 192.168.1.0/24].
    let v4 = Ipv4Addr::new(192, 168, 1, 101);
    let v6_local = "2a00:1d34:51a7:a701:8b54:31bd:bb5b:79a8"
        .parse::<Ipv6Addr>()
        .unwrap();
    let v6_peer = gua_in_same_prefix(v6_local, 0xdead);
    let networks = dualstack_lan_networks(v4, v6_local);
    let port = 7644;
    let aaaa = sock(IpAddr::V6(v6_peer), port);
    let a = sock(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 44)), port);
    assert!(is_local_peer(&networks, aaaa.ip()));
    assert!(is_local_peer(&networks, a.ip()));

    let chosen = first_local_candidate(&[aaaa, a], &networks).expect("both local");
    assert_eq!(chosen, aaaa, "scenario A must dial AAAA first and only");
}

#[test]
fn first_local_candidate_wins_order_b_a_then_aaaa() {
    // Scenario B (inverted): [A in LAN /24, AAAA in GUA /64] → V4 wins.
    let v4 = Ipv4Addr::new(192, 168, 1, 101);
    let v6_local = "2a00:1d34:51a7:a701:8b54:31bd:bb5b:79a8"
        .parse::<Ipv6Addr>()
        .unwrap();
    let v6_peer = gua_in_same_prefix(v6_local, 0xdead);
    let networks = dualstack_lan_networks(v4, v6_local);
    let port = 7644;
    let aaaa = sock(IpAddr::V6(v6_peer), port);
    let a = sock(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 44)), port);

    let chosen = first_local_candidate(&[a, aaaa], &networks).expect("both local");
    assert_eq!(chosen, a, "scenario B must dial A first and only");
}

#[test]
fn off_subnet_candidate_is_skipped_for_later_local() {
    let networks = dualstack_lan_networks(
        Ipv4Addr::new(192, 168, 1, 101),
        "2a00:1d34:51a7:a701::1".parse().unwrap(),
    );
    let remote = sock(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9)), 7644);
    let local = sock(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 44)), 7644);
    assert!(!is_local_peer(&networks, remote.ip()));
    assert_eq!(
        first_local_candidate(&[remote, local], &networks),
        Some(local)
    );
}

#[tokio::test]
async fn scenario_a_dead_aaaa_times_out_or_refuses_without_falling_back_to_v4() {
    // Live path: peer listens ONLY on V4. Candidates ordered AAAA then A.
    // Production logic dials AAAA alone → refuse/timeout; V4 listener never sees a connection.
    let Some((lan_v4, gua_v6, networks)) = live_topology() else {
        eprintln!("skip scenario_a live dial: no wlan dual-stack topology");
        return;
    };

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(lan_v4), 0))
        .await
        .expect("bind V4-only peer");
    let v4_addr = listener.local_addr().unwrap();
    let port = v4_addr.port();

    // Dead AAAA in the same GUA /64 (unused host id). ND failure → timeout up to CONNECT_TIMEOUT.
    // Own GUA closed port would refuse immediately; either way there is no V4 fallback.
    let dead_aaaa = sock(IpAddr::V6(gua_in_same_prefix(gua_v6, 0x00c0_ffee_dead)), port);
    let live_a = sock(IpAddr::V4(lan_v4), port);
    assert!(is_local_peer(&networks, dead_aaaa.ip()));
    assert!(is_local_peer(&networks, live_a.ip()));

    let chosen = first_local_candidate(&[dead_aaaa, live_a], &networks).unwrap();
    assert_eq!(chosen, dead_aaaa);

    // One accept loop for the whole test: must stay quiet during the failed AAAA
    // dial, then succeed on the explicit V4 control dial (proves no silent fallback
    // and that the V4 candidate was viable the whole time).
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<SocketAddr>();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut stream, peer)) => {
                    let mut buf = [0u8; 1];
                    let _ = stream.read(&mut buf).await;
                    let _ = seen_tx.send(peer);
                }
                Err(_) => break,
            }
        }
    });

    let started = Instant::now();
    let dial_result = connect_tcp(chosen).await;
    let elapsed = started.elapsed();
    assert!(
        dial_result.is_err(),
        "dead AAAA must not connect; got {dial_result:?}"
    );
    let err = format!("{:#}", dial_result.unwrap_err());
    let timed_out = err.contains("timed out");
    let refused = err.contains("Connection refused")
        || err.contains("connection refused")
        || err.contains("os error 111");
    assert!(
        timed_out || refused,
        "expected refuse or CONNECT_TIMEOUT failure, got: {err}"
    );
    if timed_out {
        // CONNECT_TIMEOUT is the production budget; allow a little scheduling slack.
        assert!(
            elapsed >= CONNECT_TIMEOUT - Duration::from_millis(500),
            "timeout path should wait ~{:?}, waited {elapsed:?}",
            CONNECT_TIMEOUT
        );
        assert!(
            elapsed < CONNECT_TIMEOUT + Duration::from_secs(3),
            "timeout path should not hang past CONNECT_TIMEOUT+slack, waited {elapsed:?}"
        );
    }

    // No fallback: V4-only listener must not have seen anyone while AAAA was dialled.
    assert!(
        seen_rx.try_recv().is_err(),
        "V4 listener must stay quiet when first candidate is dead AAAA (no fallback)"
    );

    // Positive control: same production connect_tcp against the V4 candidate works.
    let mut ok = connect_tcp(live_a)
        .await
        .expect("V4 candidate must connect alone");
    ok.write_all(b"x").await.unwrap();
    let peer = tokio::time::timeout(Duration::from_secs(2), seen_rx.recv())
        .await
        .expect("V4 listener should see the control dial")
        .expect("accept channel open");
    assert!(peer.is_ipv4(), "control dial peer {peer}");
}

#[tokio::test]
async fn scenario_b_v4_first_connects_while_dead_aaaa_is_never_tried() {
    let Some((lan_v4, gua_v6, networks)) = live_topology() else {
        eprintln!("skip scenario_b live dial: no wlan dual-stack topology");
        return;
    };

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(lan_v4), 0))
        .await
        .expect("bind V4-only peer");
    let v4_addr = listener.local_addr().unwrap();
    let port = v4_addr.port();
    let dead_aaaa = sock(IpAddr::V6(gua_in_same_prefix(gua_v6, 0x00c0_ffee_dead)), port);
    let live_a = sock(IpAddr::V4(lan_v4), port);

    let chosen = first_local_candidate(&[live_a, dead_aaaa], &networks).unwrap();
    assert_eq!(chosen, live_a, "inverted order must prefer A");

    let (accept_tx, accept_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut stream, peer) = listener.accept().await.expect("accept");
        assert!(
            peer.is_ipv4(),
            "only V4 should reach a V4-only listener, got {peer}"
        );
        let mut buf = [0u8; 1];
        let _ = stream.read(&mut buf).await;
        let _ = accept_tx.send(peer);
    });

    let started = Instant::now();
    let mut stream = connect_tcp(chosen)
        .await
        .expect("scenario B must succeed on first (V4) candidate");
    stream.write_all(b"x").await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "V4 hit must not wait out CONNECT_TIMEOUT; took {elapsed:?}"
    );

    let peer = tokio::time::timeout(Duration::from_secs(2), accept_rx)
        .await
        .expect("listener saw connection")
        .expect("accept channel");
    assert!(peer.is_ipv4());

    // Document that the discarded AAAA would have failed if selected (same dead host).
    let aaaa_fail = connect_tcp(dead_aaaa).await;
    assert!(
        aaaa_fail.is_err(),
        "dead AAAA still fails when dialled alone; order alone saved scenario B"
    );
}

/// Live case 3: peer listens on the host's own scoped fe80 (correct ifindex),
/// candidates ordered [correct scoped LL, working V4]. Production
/// [`first_local_candidate`] must pick LL, and [`connect_tcp`] must reach the
/// LL listener (V4 must stay quiet).
fn live_ll_and_v4() -> Option<(Ipv6Addr, u32, Ipv4Addr, Vec<LocalNetwork>)> {
    let networks = subnet::local_networks().ok()?;
    let interfaces = if_addrs::get_if_addrs().ok()?;

    let preferred = ["wlan0", "enp2s0", "eth0"];
    let mut ll_rows: Vec<(Ipv6Addr, u32, String, Option<Ipv4Addr>)> = Vec::new();

    for iface in &interfaces {
        let name = iface.name.as_str();
        if name == "lo"
            || name.starts_with("docker")
            || name.starts_with("br-")
            || name.starts_with("veth")
            || name == "CloudflareWARP"
        {
            continue;
        }
        match &iface.addr {
            if_addrs::IfAddr::V6(v6) if v6.ip.is_unicast_link_local() => {
                let idx = iface.index.unwrap_or(0);
                if idx == 0 {
                    continue;
                }
                // Pair any V4 on the same interface name if we already saw it,
                // else fill later.
                let v4_on_iface = interfaces.iter().find_map(|other| {
                    if other.name != iface.name {
                        return None;
                    }
                    match &other.addr {
                        if_addrs::IfAddr::V4(v4)
                            if v4.ip.is_private() && !v4.ip.is_loopback() =>
                        {
                            Some(v4.ip)
                        }
                        _ => None,
                    }
                });
                ll_rows.push((v6.ip, idx, name.to_string(), v4_on_iface));
            }
            _ => {}
        }
    }

    // Prefer wlan0/enp2s0 with a private V4 on the same iface.
    for want in preferred {
        if let Some((ip, idx, _name, Some(v4))) =
            ll_rows.iter().find(|( _, _, n, v4)| n == want && v4.is_some())
        {
            assert!(
                is_local_peer(&networks, IpAddr::V6(*ip)),
                "fe80 on {want} must be local once if-addrs link-local is on"
            );
            assert!(is_local_peer(&networks, IpAddr::V4(*v4)));
            return Some((*ip, *idx, *v4, networks));
        }
    }
    // Any non-virtual LL + any private V4 on the host.
    let (ip, idx, _name, maybe_v4) = ll_rows.into_iter().next()?;
    let v4 = maybe_v4.or_else(|| {
        interfaces.iter().find_map(|iface| match &iface.addr {
            if_addrs::IfAddr::V4(v4) if v4.ip.is_private() && !v4.ip.is_loopback() => Some(v4.ip),
            _ => None,
        })
    })?;
    assert!(is_local_peer(&networks, IpAddr::V6(ip)));
    assert!(is_local_peer(&networks, IpAddr::V4(v4)));
    Some((ip, idx, v4, networks))
}

#[tokio::test]
async fn case3_correct_scoped_fe80_wins_over_working_v4_and_connects() {
    let Some((ll_ip, ifindex, lan_v4, networks)) = live_ll_and_v4() else {
        eprintln!("skip case3 live dial: no scoped fe80 + private V4 topology");
        return;
    };

    // Listener ONLY on the correct scoped fe80 (same ifindex the dial will use).
    let bind = SocketAddr::V6(std::net::SocketAddrV6::new(ll_ip, 0, 0, ifindex));
    let listener = TcpListener::bind(bind)
        .await
        .expect("bind scoped correct fe80");
    let ll_addr = listener.local_addr().expect("ll local_addr");
    let port = ll_addr.port();
    match ll_addr {
        SocketAddr::V6(v6) => {
            assert_eq!(v6.ip(), &ll_ip);
            assert_eq!(v6.scope_id(), ifindex, "listener must keep correct ifindex");
        }
        other => panic!("expected V6 listener, got {other}"),
    }

    // Also bind a quiet V4 control socket on the same port so we can prove the
    // dial never falls through to V4 (and that V4 itself is reachable alone).
    let v4_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(lan_v4), port))
        .await
        .expect("bind working V4 on same port");
    assert_eq!(v4_listener.local_addr().unwrap().port(), port);

    let correct_ll = ll_addr;
    let working_v4 = sock(IpAddr::V4(lan_v4), port);
    assert!(is_local_peer(&networks, correct_ll.ip()));
    assert!(is_local_peer(&networks, working_v4.ip()));

    // Candidates: [correct scoped fe80, working V4] → LL must win first-local.
    let chosen = first_local_candidate(&[correct_ll, working_v4], &networks)
        .expect("both candidates local");
    assert_eq!(
        chosen, correct_ll,
        "case3: correct scoped fe80 must beat later working V4"
    );
    assert!(
        matches!(chosen, SocketAddr::V6(v6) if v6.scope_id() == ifindex),
        "chosen must retain scope_id={ifindex}, got {chosen}"
    );

    let (ll_seen_tx, mut ll_seen_rx) = tokio::sync::mpsc::unbounded_channel::<SocketAddr>();
    let (v4_seen_tx, mut v4_seen_rx) = tokio::sync::mpsc::unbounded_channel::<SocketAddr>();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut stream, peer)) => {
                    let mut buf = [0u8; 1];
                    let _ = stream.read(&mut buf).await;
                    let _ = ll_seen_tx.send(peer);
                }
                Err(_) => break,
            }
        }
    });
    tokio::spawn(async move {
        loop {
            match v4_listener.accept().await {
                Ok((mut stream, peer)) => {
                    let mut buf = [0u8; 1];
                    let _ = stream.read(&mut buf).await;
                    let _ = v4_seen_tx.send(peer);
                }
                Err(_) => break,
            }
        }
    });

    let started = Instant::now();
    let mut stream = connect_tcp(chosen)
        .await
        .expect("case3 connect_tcp must succeed on correct scoped fe80");
    stream.write_all(b"L").await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "LL hit must not wait out CONNECT_TIMEOUT; took {elapsed:?}"
    );

    let peer = tokio::time::timeout(Duration::from_secs(2), ll_seen_rx.recv())
        .await
        .expect("LL listener should accept the dial")
        .expect("LL accept channel open");
    assert!(
        peer.is_ipv6(),
        "accept must be on LL listener, got peer={peer}"
    );
    match peer {
        SocketAddr::V6(v6) => {
            assert_eq!(v6.scope_id(), ifindex, "accepted peer scope must match");
            assert!(
                v6.ip().is_unicast_link_local(),
                "accepted peer must be link-local, got {}",
                v6.ip()
            );
        }
        _ => unreachable!(),
    }

    // No V4 fallback: working V4 listener must stay quiet while LL was dialled.
    assert!(
        v4_seen_rx.try_recv().is_err(),
        "V4 listener must stay quiet when first candidate is live LL (no fallback to V4)"
    );

    // Positive control: the discarded V4 candidate is itself viable.
    let mut ok = connect_tcp(working_v4)
        .await
        .expect("working V4 candidate must connect alone");
    ok.write_all(b"V").await.unwrap();
    let v4_peer = tokio::time::timeout(Duration::from_secs(2), v4_seen_rx.recv())
        .await
        .expect("V4 listener should see the control dial")
        .expect("V4 accept channel open");
    assert!(v4_peer.is_ipv4(), "control dial peer {v4_peer}");
}

#[test]
fn connect_timeout_is_fifteen_seconds() {
    // Documented production budget for TCP/TLS/first-line. Changing it changes
    // how long a dead first AAAA stalls the user before the dial errors out.
    assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(15));
}
