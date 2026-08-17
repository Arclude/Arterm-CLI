// Standalone single-threaded Rust probe mirroring the C probe: ruleset with
// only CONNECT_TCP handled, one allow rule for 443, restrict, then connect.
use std::net::TcpStream;

fn main() {
    let config = arterm_sandbox::SandboxConfig::new(arterm_sandbox::SandboxMode::Readonly, None);
    let result = arterm_sandbox::apply(&config).expect("apply failed");
    eprintln!("sandbox: applied={} msg={}", result.applied, result.message);

    for port in [6667u16, 443] {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(_) => eprintln!("connect {port}: SUCCESS"),
            Err(e) => eprintln!("connect {port}: {e}"),
        }
    }
}
