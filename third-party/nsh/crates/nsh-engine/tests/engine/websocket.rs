//! The `websocket` module through an engine: its `WebSocket.connect` is the
//! runtime's Rust registry (its JS face and declarations come from its
//! spec); its checks throw in the call, the handshake is a core task and a
//! task of each connection drives its socket.

use std::{
    net::TcpListener,
    time::{Duration, Instant},
};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, Size};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment};
use tokio_tungstenite::tungstenite;

use crate::{ChannelSink, rust_classes::shown};

/// The app `body` (after `report`, which shows `done <text>`), with the
/// grants of `capabilities`.
fn start(body: &str, capabilities: &str) -> (Engine, Receiver<MountBatch>) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nsh-websocket-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        format!(
            r#"import {{ mount, signal, Text }} from "nsh";
import * as websocket from "websocket";
const {{ WebSocket: Client }} = websocket;
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

const LOOPBACK: &str = r#"{"network":{"hosts":["127.0.0.1"]}}"#;

#[test]
// Tungstenite fixes the callback error type to an HTTP response.
#[allow(clippy::result_large_err)]
fn a_connection_round_trips_text_and_bytes_with_its_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut socket = tungstenite::accept_hdr(
            tcp,
            |request: &tungstenite::handshake::server::Request,
             response: tungstenite::handshake::server::Response| {
                assert_eq!(request.headers().get("x-shell-test").unwrap(), "yes");
                Ok(response)
            },
        )
        .unwrap();
        for _ in 0..2 {
            let message = socket.read().unwrap();
            socket.send(message).unwrap();
        }
        assert!(socket.read().unwrap().is_close());
        let _ = socket.flush();
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  if (Object.keys(websocket).join(",") !== "WebSocket,WebSocketConnection" || typeof Client.connect !== "function") throw Error("module exports " + Object.keys(websocket));
  const socket = await Client.connect("ws://{address}/", {{ headers: {{ "X-Shell-Test": "yes" }} }});
  const pending = socket.read();
  let duplicate = false;
  try {{ socket.read(); }} catch (e) {{ duplicate = e instanceof TypeError && e.message === "WebSocket.read() already has an outstanding read"; }}
  if (!duplicate) throw Error("a second read throws in the call");
  await socket.write("shell");
  if (await pending !== "shell") throw Error("text round trip");
  await socket.write(new Uint8Array([3, 7]));
  const bytes = await socket.read();
  if (!(bytes instanceof Uint8Array) || bytes.join(",") !== "3,7") throw Error("binary round trip");
  let invalid = false;
  try {{ socket.write(42); }} catch (e) {{ invalid = e instanceof TypeError; }}
  if (!invalid) throw Error("a number throws in the call");
  let range = false;
  try {{ socket.write("x".repeat(8 * 1024 * 1024 + 1)); }} catch (e) {{ range = e instanceof RangeError; }}
  if (!range) throw Error("the size limit throws in the call");
  await socket.close();
  report("ok");
}})().catch((e) => report(String(e)));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    server.join().unwrap();
}

#[test]
fn bad_urls_options_and_grants_throw_in_the_call() {
    let (_engine, rx) = start(
        r#"const threw = [];
for (const options of [42, { protocols: ["chat"] }, { headers: 42 }, { headers: { Authorization: "secret" } },
    { headers: { Cookie: "secret" } }, { headers: { "Sec-WebSocket-Key": "evil" } }, { headers: { "x-test": 1 } }]) {
  try { Client.connect("ws://127.0.0.1:9/", options); threw.push("connected"); } catch (e) { threw.push(e instanceof TypeError); }
}
try { Client.connect("https://127.0.0.1/"); threw.push("connected"); } catch (e) { threw.push(e instanceof TypeError); }
for (const url of ["ws://user:secret@127.0.0.1:9/", "ws://127.0.0.1:9/#part"]) {
  try { Client.connect(url); threw.push("connected"); } catch (e) { threw.push(e instanceof TypeError && /credentials/.test(e.message)); }
}
try { Client.connect("ws://example.com/"); threw.push("connected"); } catch (e) {
  threw.push(e instanceof TypeError && /capabilities.network.http/.test(e.message));
}
report(threw.join(" "));"#,
        LOOPBACK,
    );
    assert_eq!(
        shown(&rx, "done"),
        "done true true true true true true true true true true true"
    );
}

#[test]
fn a_socket_grant_allows_no_websocket() {
    let (_engine, rx) = start(
        r#"try { Client.connect("ws://127.0.0.1:9/"); report("connected"); } catch (e) {
  report(`${e instanceof TypeError} ${/capabilities.network.http/.test(e.message)}`);
}"#,
        r#"{"network":{"sockets":["127.0.0.1:9"]}}"#,
    );
    assert_eq!(shown(&rx, "done"), "done true true");
}

#[test]
fn both_websocket_apis_share_the_vm_cap() {
    // Connections wait in the listener's backlog: their handshakes never end.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (_engine, rx) = start(
        &format!(
            r#"const open = [];
for (let i = 0; i < 16; i++) open.push(new WebSocket("ws://{address}/"));
for (let i = 0; i < 16; i++) open.push(Client.connect("ws://{address}/").catch(() => {{}}));
globalThis.keep = open;
const capped = [() => new WebSocket("ws://{address}/"), () => Client.connect("ws://{address}/")].map((connect) => {{
  try {{ connect(); return false; }} catch (e) {{ return e instanceof RangeError && /At most 32/.test(e.message); }}
}});
report(capped.join(" "));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done true true");
    drop(listener);
}

#[test]
fn dropping_the_engine_closes_its_connections() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (ended_tx, ended_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut socket = tungstenite::accept(tcp).unwrap();
        let _ = socket.read();
        ended_tx.send(()).unwrap();
    });
    let (engine, rx) = start(
        &format!(
            r#"Client.connect("ws://{address}/").then((socket) => {{
  globalThis.socket = socket;
  socket.read().catch(() => {{}});
  report("connected");
}}, (e) => report(String(e)));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done connected");
    let start = Instant::now();
    drop(engine);
    ended_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
    server.join().unwrap();
}

#[test]
fn a_handshake_redirect_fails_without_contacting_its_target() {
    use std::io::{Read, Write};
    let redirect = TcpListener::bind("127.0.0.1:0").unwrap();
    let forbidden = TcpListener::bind("127.0.0.1:0").unwrap();
    forbidden.set_nonblocking(true).unwrap();
    let address = redirect.local_addr().unwrap();
    let target = forbidden.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = redirect.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = [0u8; 4096];
        assert!(stream.read(&mut request).unwrap() > 0);
        write!(
            stream,
            "HTTP/1.1 302 Found\r\nLocation: ws://{target}/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
    });
    let (_engine, rx) = start(
        &format!(
            r#"Client.connect("ws://{address}/redirect").then(() => report("opened"), () => report("refused"));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done refused");
    server.join().unwrap();
    assert_eq!(
        forbidden.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "the redirect's target is never contacted"
    );
}

#[test]
fn messages_that_came_before_the_peer_closed_are_still_read() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        let mut socket = tungstenite::accept(tcp).unwrap();
        socket.send("one".into()).unwrap();
        socket.send("two".into()).unwrap();
        socket.close(None).unwrap();
        let _ = socket.flush();
        // The close handshake's reply, then the end.
        while socket.read().is_ok() {}
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  const socket = await Client.connect("ws://{address}/");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const first = await socket.read();
  const second = await socket.read();
  const last = await socket.read().then((m) => `read ${{m}}`, (e) => e.message);
  report(`${{first}}|${{second}}|${{last}}`);
}})().catch((e) => report(String(e)));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done one|two|WebSocket closed by peer");
    server.join().unwrap();
}

#[test]
fn pending_writes_are_capped_in_the_call() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut socket = tungstenite::accept(tcp).unwrap();
        while socket.read().is_ok() {}
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  const socket = await Client.connect("ws://{address}/");
  const chunk = "x".repeat(5 * 1024 * 1024);
  const first = socket.write(chunk);
  let capped = false;
  try {{ socket.write(chunk); }} catch (e) {{ capped = e instanceof RangeError && e.message.includes("8388608 byte limit"); }}
  await first;
  // Sent: its bytes no longer count.
  await socket.write(chunk);
  await socket.close();
  report(`${{capped}}`);
}})().catch((e) => report(String(e)));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done true");
    server.join().unwrap();
}

#[test]
fn too_much_unread_data_closes_the_connection_and_keeps_what_fit() {
    for (count, size) in [(9usize, 1usize), (2, 5 * 1024 * 1024)] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut socket = tungstenite::accept(tcp).unwrap();
            for _ in 0..count {
                socket
                    .send(tungstenite::Message::binary(vec![7u8; size]))
                    .unwrap();
            }
            while socket.read().is_ok() {}
        });
        let (_engine, rx) = start(
            &format!(
                r#"(async () => {{
  const socket = await Client.connect("ws://{address}/");
  await new Promise((r) => setTimeout(r, 300));
  let read = 0;
  let ended = "";
  try {{ for (;;) {{ await socket.read(); read++; }} }} catch (e) {{ ended = e.message; }}
  report(`${{read}} ${{ended}}`);
}})().catch((e) => report(String(e)));"#
            ),
            LOOPBACK,
        );
        assert_eq!(
            shown(&rx, "done"),
            format!(
                "done {} WebSocket closed: more than 8 messages or 8388608 bytes arrived unread",
                count - 1
            )
        );
        server.join().unwrap();
    }
}
