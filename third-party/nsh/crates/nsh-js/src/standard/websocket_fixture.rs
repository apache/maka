//! Real loopback protocol regressions; no external network service or temp files.
use std::{
    net::TcpListener,
    time::{Duration, Instant},
};

use nsh_core::access::{Access, Capabilities};

use crate::Host;

fn host(allowed: bool) -> Host {
    let host = Host::new().unwrap();
    let capabilities = if allowed {
        serde_json::json!({"network": {"hosts": ["127.0.0.1"]}})
    } else {
        serde_json::json!({})
    };
    host.set_system_access(
        Access {
            declared: Capabilities::from_json(&capabilities).unwrap(),
            granted: None,
        },
        None,
    );
    host
}
fn finish(host: &Host) {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        host.run_jobs();
        if host
            .eval_source("if (!globalThis.wsDone) throw new Error('pending');")
            .is_ok()
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("WebSocket event loop failed to complete");
}
#[test]
fn websocket_denies_network_before_connecting() {
    // As a browser's refused connection: no throw, then `error` and `close`.
    let host = host(false);
    host.eval_source("globalThis.events = []; const ws = new WebSocket('ws://127.0.0.1:9/'); ws.onerror = (e) => events.push(e.type, /capabilities.network/.test(e.message)); ws.onclose = (e) => { events.push(e.code, e.wasClean, ws.readyState); globalThis.wsDone = true; };").unwrap();
    finish(&host);
    host.eval_source("if (JSON.stringify(events) !== '[\"error\",true,1006,false,3]') throw Error(JSON.stringify(events));").unwrap();
}
#[test]
// Tungstenite fixes the callback error type to an HTTP response.
#[allow(clippy::result_large_err)]
fn websocket_echo_binary_protocol_and_close() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut ws = tokio_tungstenite::tungstenite::accept_hdr(tcp, |request: &tokio_tungstenite::tungstenite::handshake::server::Request, mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            assert_eq!(request.headers().get("Sec-WebSocket-Protocol").unwrap(), "chat");
            response.headers_mut().insert("Sec-WebSocket-Protocol", "chat".parse().unwrap());
            Ok(response)
        }).unwrap();
        for _ in 0..3 {
            let message = ws.read().unwrap();
            ws.send(message).unwrap();
        }
        let close = ws.read().unwrap();
        assert!(close.is_close());
        let _ = ws.flush();
    });
    let host = host(true);
    host.eval_source(&format!(r#"
        globalThis.wsEvents = [];
        const ws = new WebSocket('ws://{address}/', ['chat']);
        if (!(ws instanceof EventTarget) || ws.readyState !== WebSocket.CONNECTING) throw Error('identity');
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {{ if (ws.protocol !== 'chat') throw Error('protocol'); wsEvents.push('open'); ws.send('hello'); ws.send(new Uint8Array([1,2,3])); ws.send(new Blob([new Uint8Array([4,5])])); }};
        ws.addEventListener('message', event => {{
            if (!(event instanceof Event)) throw Error('event identity');
            wsEvents.push(typeof event.data === 'string' ? event.data : Array.from(new Uint8Array(event.data)).join(','));
            if (wsEvents.length === 4) ws.close(1000, 'done');
        }});
        ws.onerror = event => {{ globalThis.wsFailure = event.message; }};
        ws.onclose = event => {{ globalThis.wsClosed = [event.code, event.reason, event.wasClean, ws.readyState]; globalThis.wsDone = true; }};
    "#)).unwrap();
    finish(&host);
    host.eval_source("if (globalThis.wsFailure) throw Error(wsFailure); if (JSON.stringify(wsEvents) !== '[\"open\",\"hello\",\"1,2,3\",\"4,5\"]') throw Error(JSON.stringify(wsEvents)); if (JSON.stringify(wsClosed) !== '[1000,\"done\",true,3]') throw Error(JSON.stringify(wsClosed));").unwrap();
    server.join().unwrap();
}
#[test]
fn websocket_rejects_invalid_protocols_and_close_codes() {
    let host = host(true);
    host.eval_source(r#"
        for (const protocols of [['chat','chat'], ['bad protocol'], ['']]) {
            let threw = false;
            try { new WebSocket('ws://127.0.0.1:9/', protocols); } catch (e) { threw = e instanceof SyntaxError; }
            if (!threw) throw Error('invalid protocol accepted');
        }
        for (const url of ['http://127.0.0.1/', 'ws://user:pass@127.0.0.1/', 'ws://127.0.0.1/#fragment']) {
            let threw = false;
            try { new WebSocket(url); } catch (_) { threw = true; }
            if (!threw) throw Error('invalid URL accepted');
        }
        const socket = new WebSocket('ws://127.0.0.1:9/');
        for (const code of [0, 1001, 2999, 5000, 3000.5]) {
            let threw = false;
            try { socket.close(code); } catch (error) { threw = error.name === 'InvalidAccessError'; }
            if (!threw) throw Error('invalid close code accepted');
        }
        let sendThrew = false;
        try { socket.send('premature'); } catch (error) { sendThrew = error.name === 'InvalidStateError'; }
        if (!sendThrew) throw Error('send while connecting accepted');
        let reasonThrew = false;
        try { socket.close(3000, 'x'.repeat(124)); } catch (error) { reasonThrew = error instanceof SyntaxError; }
        if (!reasonThrew) throw Error('long close reason accepted');
        socket.onclose = () => { globalThis.wsDone = true; };
        socket.close();
    "#).unwrap();
    finish(&host);
}

#[test]
fn websocket_owner_disposal_aborts_transport() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (ended_tx, ended_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut ws = tokio_tungstenite::tungstenite::accept(tcp).unwrap();
        // Disposal aborts transport promptly rather than waiting for peer data.
        let _ = ws.read();
        ended_tx.send(()).unwrap();
    });
    let host = host(true);
    host.with_raw(|raw| {
        // SAFETY: Host owns the live context for this closure.
        let cx = unsafe { rquickjs::Ctx::from_raw(std::ptr::NonNull::new_unchecked(raw)) };
        crate::reactive::install_globals(&cx);
    });
    host.eval_source(&format!(
        r#"
        __nsh_reactive.createRoot(dispose => {{
            globalThis.disposeSocketOwner = dispose;
            const socket = new WebSocket('ws://{address}/');
            socket.onopen = () => {{ globalThis.wsDone = true; }};
        }});
    "#
    ))
    .unwrap();
    finish(&host);
    host.eval_source("disposeSocketOwner();").unwrap();
    for _ in 0..10 {
        host.run_jobs();
    }
    ended_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    drop(host);
    server.join().unwrap();
}

#[test]
fn websocket_live_transport_is_released_with_vm() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (ended_tx, ended_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut ws = tokio_tungstenite::tungstenite::accept(tcp).unwrap();
        let _ = ws.read();
        ended_tx.send(()).unwrap();
    });
    let host = host(true);
    host.eval_source(&format!("globalThis.liveSocket = new WebSocket('ws://{address}/'); liveSocket.onopen = () => {{ globalThis.wsDone = true; }};")).unwrap();
    finish(&host);
    drop(host);
    ended_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    server.join().unwrap();
}

#[test]
fn a_flooding_peer_cannot_hold_one_turn() {
    const SENT: usize = 600;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sent_tx, sent_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut ws = tokio_tungstenite::tungstenite::accept(tcp).unwrap();
        // The flood starts once the client is open and idle.
        let _ = ws.read();
        for i in 0..SENT {
            ws.send(tokio_tungstenite::tungstenite::Message::Text(
                i.to_string().into(),
            ))
            .unwrap();
        }
        sent_tx.send(()).unwrap();
        // Until the client closes.
        let _ = ws.read();
    });
    let host = host(true);
    host.eval_source(&format!(
        "globalThis.count = 0; globalThis.steps = []; const ws = new WebSocket('ws://{address}/'); ws.onopen = () => {{ ws.send('go'); globalThis.wsDone = true; }}; ws.onmessage = () => {{ count++; }}; globalThis.socket = ws;"
    ))
    .unwrap();
    // The handshake runs in the VM's turns.
    finish(&host);
    sent_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    host.eval_source("steps.push(count);").unwrap();
    // Let every frame reach the socket's buffer before the turns run.
    std::thread::sleep(Duration::from_millis(100));
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        host.run_jobs();
        host.eval_source("steps.push(count);").unwrap();
        if host
            .eval_source(&format!("if (count < {SENT}) throw Error('pending');"))
            .is_ok()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    host.eval_source(&format!(
        r#"if (count !== {SENT}) throw Error('received ' + count);
        let most = 0;
        for (let i = 1; i < steps.length; i++) most = Math.max(most, steps[i] - steps[i - 1]);
        // A turn delivers a few of the socket's shares (QuickJS' scheduler
        // polls a self-waking task more than once), never the whole flood.
        if (most > {SENT} / 2) throw Error('one turn delivered ' + most);
        socket.close();"#
    ))
    .unwrap();
    for _ in 0..20 {
        host.run_jobs();
    }
    drop(host);
    server.join().unwrap();
}
