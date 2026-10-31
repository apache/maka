//! The `websocket` module through an engine: its `connect` is the
//! runtime's Rust registry (its JS face and declarations come from its
//! spec); its checks run in the call, which rejects at once, the
//! handshake is a core task and a task of each connection drives its
//! socket, reading from it only while the app's unread queue has room.

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
import websocket, {{ connect }} from "websocket";
import * as namespace from "websocket";
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
        refuse_connections: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
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
        match socket.read().unwrap() {
            tungstenite::Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 4001);
                assert_eq!(frame.reason.as_str(), "bye");
            }
            other => panic!("expected the app's close frame, got {other:?}"),
        }
        // Sends the reply tungstenite queued: the close handshake's end.
        let _ = socket.flush();
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  if (Object.keys(namespace).sort().join(",") !== "WebSocketConnection,connect,default" || websocket.connect !== connect) throw Error("module exports " + Object.keys(namespace));
  const socket = await connect("ws://{address}/", {{ headers: {{ "X-Shell-Test": "yes" }} }});
  const pending = socket.read();
  const refused = (p) => p.then(() => "done", (e) => `${{e.constructor.name}}:${{e.code}}`);
  if (await refused(socket.read()) !== "TypeError:undefined") throw Error("a second read rejects");
  await socket.write("shell");
  if (await pending !== "shell") throw Error("text round trip");
  await socket.write(new Uint8Array([3, 7]));
  const bytes = await socket.read();
  if (!(bytes instanceof Uint8Array) || bytes.join(",") !== "3,7") throw Error("binary round trip");
  if (await refused(socket.write(42)) !== "TypeError:undefined") throw Error("a number rejects");
  if (await refused(socket.write("x".repeat(8 * 1024 * 1024 + 1))) !== "RangeError:ERR_OUT_OF_RANGE") throw Error("the size limit rejects");
  // Close codes and reasons the app may not send reject, and close nothing.
  for (const [code, reason] of [[1001], [2999], [5000], [3000.5], [1000, "x".repeat(124)]]) {{
    if (await refused(socket.close(code, reason)) !== "RangeError:ERR_OUT_OF_RANGE") throw Error(`close(${{code}}) rejects`);
  }}
  if (socket.closeCode !== null || socket.closeReason !== null) throw Error("open: no close code");
  await socket.close(4001, "bye");
  if (socket.closeCode !== 4001 || socket.closeReason !== "bye") throw Error(`closed with ${{socket.closeCode}} ${{socket.closeReason}}`);
  if (await socket.read() !== null) throw Error("a read after close resolves null");
  if (await refused(socket.write("late")) !== "Error:ERR_SOCKET_CLOSED") throw Error("a write after close rejects");
  report("ok");
}})().catch((e) => report(String(e)));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    server.join().unwrap();
}

#[test]
fn bad_urls_options_and_grants_reject() {
    let (_engine, rx) = start(
        r#"(async () => {
  // A function returning a promise never throws: each call rejects.
  const refused = (url, options) => {
    let promise;
    try { promise = connect(url, options); } catch { return "threw"; }
    return promise.then(() => "connected", (e) => e instanceof TypeError ? "TypeError" : `${e.code} ${e.permission} ${e.resource}`);
  };
  const results = [];
  for (const options of [42, { protocols: ["chat"] }, { headers: 42 }, { headers: { Authorization: "secret" } },
      { headers: { Cookie: "secret" } }, { headers: { "Sec-WebSocket-Key": "evil" } }, { headers: { "x-test": 1 } }]) {
    results.push(await refused("ws://127.0.0.1:9/", options));
  }
  results.push(await refused("https://127.0.0.1/"));
  for (const url of ["ws://user:secret@127.0.0.1:9/", "ws://127.0.0.1:9/#part"]) results.push(await refused(url));
  results.push(await refused("ws://example.com/"));
  report(results.join("|"));
})().catch((e) => report(String(e)));"#,
        LOOPBACK,
    );
    assert_eq!(
        shown(&rx, "done"),
        "done TypeError|TypeError|TypeError|TypeError|TypeError|TypeError|TypeError|TypeError|\
         TypeError|TypeError|ERR_ACCESS_DENIED network ws://example.com/"
    );
}

#[test]
fn a_socket_grant_allows_no_websocket() {
    let (_engine, rx) = start(
        r#"connect("ws://127.0.0.1:9/").then(() => report("connected"), (e) =>
  report(`${e.code} ${e.permission} ${e.resource}`));"#,
        r#"{"network":{"sockets":["127.0.0.1:9"]}}"#,
    );
    assert_eq!(
        shown(&rx, "done"),
        "done ERR_ACCESS_DENIED network ws://127.0.0.1:9/"
    );
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
for (let i = 0; i < 16; i++) open.push(connect("ws://{address}/").catch(() => {{}}));
globalThis.keep = open;
// The constructor throws, as it does for a used-up quota; the module's
// function rejects.
let thrown = false;
try {{ new WebSocket("ws://{address}/"); }} catch (e) {{ thrown = e.code === "ERR_NSH_QUOTA_EXCEEDED"; }}
connect("ws://{address}/").then(() => false, (e) => e.code === "ERR_NSH_QUOTA_EXCEEDED")
  .then((rejected) => report(`${{thrown}} ${{rejected}}`));"#
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
            r#"connect("ws://{address}/").then((socket) => {{
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
            r#"connect("ws://{address}/redirect").then(() => report("opened"), (e) => report(`${{e.code}} ${{e.status}}`));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done EPROTO 302");
    server.join().unwrap();
    assert_eq!(
        forbidden.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "the redirect's target is never contacted"
    );
}

#[test]
fn messages_that_came_before_the_peer_closed_are_read_then_null() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        let mut socket = tungstenite::accept(tcp).unwrap();
        socket.send("one".into()).unwrap();
        socket.send("two".into()).unwrap();
        socket
            .close(Some(tungstenite::protocol::CloseFrame {
                code: 4000u16.into(),
                reason: "done".into(),
            }))
            .unwrap();
        let _ = socket.flush();
        // The close handshake's reply, then the end.
        while socket.read().is_ok() {}
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  const socket = await connect("ws://{address}/");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const first = await socket.read();
  const second = await socket.read();
  const last = await socket.read();
  const again = await socket.read();
  report(`${{first}}|${{second}}|${{last}}|${{again}}|${{socket.closeCode}} ${{socket.closeReason}}`);
}})().catch((e) => report(String(e)));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done one|two|null|null|4000 done");
    server.join().unwrap();
}

#[test]
fn pending_writes_are_capped() {
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
  const socket = await connect("ws://{address}/");
  const chunk = "x".repeat(5 * 1024 * 1024);
  const first = socket.write(chunk);
  const capped = await socket.write(chunk).then(() => false, (e) => e.code === "ERR_NSH_QUOTA_EXCEEDED");
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
fn a_full_unread_queue_holds_the_peer_back_until_the_app_reads() {
    // Far more than the queue holds (8 messages, 8 MiB): reading pauses and
    // resumes, and nothing is lost.
    for (count, size) in [(64usize, 1usize), (24, 1024 * 1024)] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut socket = tungstenite::accept(tcp).unwrap();
            for i in 0..count {
                socket
                    .send(tungstenite::Message::binary(vec![i as u8; size]))
                    .unwrap();
            }
            socket.close(None).unwrap();
            while socket.read().is_ok() {}
        });
        let (_engine, rx) = start(
            &format!(
                r#"(async () => {{
  const socket = await connect("ws://{address}/");
  await new Promise((r) => setTimeout(r, 300));
  let read = 0;
  for (let message; (message = await socket.read()) !== null; read++) {{
    if (message.length !== {size} || message[0] !== (read & 255)) throw Error(`message ${{read}} out of order`);
  }}
  report(`${{read}} ${{socket.closeCode}}`);
}})().catch((e) => report(`${{e.code}} ${{e}}`));"#
            ),
            LOOPBACK,
        );
        // A close frame without a code reads as 1005.
        assert_eq!(shown(&rx, "done"), format!("done {count} 1005"));
        server.join().unwrap();
    }
}

#[test]
fn a_connection_that_ends_without_a_close_handshake_rejects_reads() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        let mut socket = tungstenite::accept(tcp).unwrap();
        socket.send("last".into()).unwrap();
        let _ = socket.flush();
        // Gone without a close frame.
        drop(socket);
    });
    let (_engine, rx) = start(
        &format!(
            r#"(async () => {{
  const socket = await connect("ws://{address}/");
  await new Promise((r) => setTimeout(r, 300));
  const last = await socket.read();
  const ended = await socket.read().then((m) => `read ${{m}}`, (e) => typeof e.code === "string" ? "rejected" : `no code: ${{e}}`);
  report(`${{last}} ${{ended}} ${{socket.closeCode}}`);
}})().catch((e) => report(String(e)));"#
        ),
        LOOPBACK,
    );
    assert_eq!(shown(&rx, "done"), "done last rejected 1006");
    server.join().unwrap();
}
