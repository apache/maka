//! `net`'s sockets through an engine: the module is the runtime's Rust
//! registry (its JS face and declarations come from its spec); its limits
//! throw in the call, its connections and reads and writes are core tasks.

use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, Size};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment};

use crate::{ChannelSink, rust_classes::shown};

/// The app `body` (after `report`, which shows `done <text>`), allowed the
/// sockets of `capabilities`.
fn start(body: &str, capabilities: &str) -> (Engine, Receiver<MountBatch>) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nsh-net-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        format!(
            r#"import {{ mount, signal, Text }} from "nsh";
import net, {{ connect }} from "net";
const shown = signal("waiting");
const report = (text) => shown.set(`done ${{text}}`);
{body}
mount(() => <Text>{{shown()}}</Text>);
"#
        ),
    )
    .unwrap();
    let bundled = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let bundle = Bundle::source(bundled.code)
        .with_capabilities_json(Some(capabilities))
        .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(nsh_core::geometry::px(400.0), nsh_core::geometry::px(300.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

fn sockets(port: u16) -> String {
    format!(r#"{{"network":{{"sockets":["127.0.0.1:{port}"]}}}}"#)
}

#[test]
fn a_socket_round_trips_bytes_and_checks_its_limits_in_the_call() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = [0; 4];
        stream.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ping");
        stream.write_all(b"pong").unwrap();
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  const socket = await net.connect("127.0.0.1", {port});
  if (net.connect !== connect) throw Error("default and named exports differ");
  if (await socket.read(0) !== null) throw Error("a zero read is null");
  let range = false;
  try {{ socket.read(1048577); }} catch (e) {{ range = e instanceof RangeError && e.message === "socket read exceeded the 1048576 byte limit"; }}
  if (!range) throw Error("the read limit throws in the call");
  range = false;
  try {{ socket.write("x".repeat(1048577)); }} catch (e) {{ range = e instanceof RangeError && e.message === "socket write exceeded the 1048576 byte limit"; }}
  if (!range) throw Error("the write limit throws in the call");
  await socket.write("ping");
  const data = await socket.read();
  if (!(data instanceof Uint8Array) || String.fromCharCode(...data) !== "pong") throw Error("bad reply");
  if (await socket.read() !== null) throw Error("expected the end");
  socket.close();
  report("ok");
}})().catch((e) => report(String(e)));"#
        ),
        &sockets(port),
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    peer.join().unwrap();
}

#[test]
fn a_socket_not_granted_throws_in_the_call() {
    for capabilities in [
        "{}".to_owned(),
        r#"{"network":{"hosts":["*"]}}"#.to_owned(),
        sockets(10),
    ] {
        let (_engine, rx) = start(
            r#"try { connect("127.0.0.1", 9); report("connected"); } catch (e) {
  report(`${e instanceof TypeError} ${e.message}`);
}"#,
            &capabilities,
        );
        assert_eq!(
            shown(&rx, "done"),
            "done true a socket to `127.0.0.1:9` is not granted; add \"127.0.0.1:9\" to \
             capabilities.network.sockets",
            "{capabilities}"
        );
    }
}

#[test]
fn closing_a_socket_ends_a_pending_read_and_write() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // The peer never reads, so the kernel's buffers fill and writes wait.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let peer = std::thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        let _ = done_rx.recv_timeout(Duration::from_secs(10));
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  const s = await connect("127.0.0.1", {port});
  const chunk = "x".repeat(1048576);
  let limited = false;
  const writes = [];
  for (let i = 0; i < 5; i++) {{
    try {{ writes.push(s.write(chunk).then(() => "sent", (e) => String(e))); }}
    catch (e) {{ limited = e instanceof RangeError && e.message.includes("4194304 byte limit"); }}
  }}
  const read = s.read();
  await new Promise((r) => setTimeout(r, 50));
  s.close();
  const results = await Promise.all(writes);
  report(`${{limited}} ${{await read}} ${{results.some((r) => r.includes("socket is closed"))}}`);
}})().catch((e) => report(String(e)));"#
        ),
        &sockets(port),
    );
    let start = Instant::now();
    assert_eq!(shown(&rx, "done"), "done true null true");
    assert!(start.elapsed() < Duration::from_secs(3));
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}

#[test]
fn sockets_are_capped_per_vm_and_a_closed_one_frees_its_place() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  const pending = [];
  for (let i = 0; i < 32; i++) pending.push(connect("127.0.0.1", {port}));
  let capped = false;
  try {{ connect("127.0.0.1", {port}); }} catch (e) {{ capped = e instanceof RangeError; }}
  const all = await Promise.all(pending);
  all[0].close();
  const again = await connect("127.0.0.1", {port});
  again.close();
  report(`${{capped}} reused`);
}})().catch((e) => report(String(e)));"#
        ),
        &sockets(port),
    );
    assert_eq!(shown(&rx, "done"), "done true reused");
    drop(listener);
}

#[test]
fn dropping_the_engine_closes_its_sockets() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, peer_rx) = std::sync::mpsc::channel();
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut byte = [0];
        tx.send(stream.read(&mut byte)).unwrap();
    });
    let (engine, rx) = start(
        &format!(
            r#"connect("127.0.0.1", {port}).then((s) => {{
  globalThis.socket = s;
  s.read().catch(() => {{}});
  report("connected");
}}, (e) => report(String(e)));"#
        ),
        &sockets(port),
    );
    assert_eq!(shown(&rx, "done"), "done connected");
    drop(engine);
    assert_eq!(
        peer_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap(),
        0
    );
    peer.join().unwrap();
}

#[test]
fn connection_failures_carry_nodes_error_codes() {
    // A port nothing listens on: bound, then closed again.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (_engine, rx) = start(
        &format!(
            r#"connect("127.0.0.1", {port}).then(() => report("connected"), (e) =>
  report(`${{e.constructor.name}} ${{e.code}} ${{e.syscall}} ${{e.address}} ${{e.port === {port}}} ${{e.message.startsWith("connecting to 127.0.0.1:{port} failed")}}`));"#
        ),
        &sockets(port),
    );
    assert_eq!(
        shown(&rx, "done"),
        "done Error ECONNREFUSED connect 127.0.0.1 true true"
    );
}
