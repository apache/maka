//! Real chunked HTTP SSE across the production network and async JS runtime.
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    time::Instant,
};

use nsh_js::{FetchOp, Host, NetworkQueue};

use super::*;

struct Bridge {
    host: Host,
    network: UreqNetwork,
    tasks: HashMap<u32, Box<dyn FetchTask>>,
    tx: Sender<(u32, FetchEvent)>,
    rx: Receiver<(u32, FetchEvent)>,
    cancelled: Vec<u32>,
}
impl Bridge {
    fn new() -> Self {
        let (tx, rx) = channel();
        Self {
            host: Host::new().unwrap(),
            network: UreqNetwork::new(),
            tasks: HashMap::new(),
            tx,
            rx,
            cancelled: Vec::new(),
        }
    }
    fn pump(&mut self) {
        self.host.run_jobs();
        let mut queue = NetworkQueue::default();
        self.host.take_network(&mut queue);
        for (id, operation) in queue.ops {
            match operation {
                FetchOp::Start(request) => {
                    let tx = self.tx.clone();
                    self.tasks.insert(
                        id,
                        self.network.fetch(
                            request,
                            Box::new(move |event| {
                                let _ = tx.send((id, event));
                            }),
                        ),
                    );
                }
                FetchOp::Cancel => {
                    if let Some(task) = self.tasks.remove(&id) {
                        task.cancel();
                        self.cancelled.push(id);
                    }
                }
                FetchOp::Pause(paused) => {
                    if let Some(task) = self.tasks.get_mut(&id) {
                        task.pause(paused);
                    }
                }
                FetchOp::Send(bytes) => {
                    if let Some(task) = self.tasks.get_mut(&id) {
                        task.send(bytes);
                    }
                }
                FetchOp::Finish => {
                    if let Some(task) = self.tasks.get_mut(&id) {
                        task.finish();
                    }
                }
            }
        }
        while let Ok((id, event)) = self.rx.try_recv() {
            self.host.fetch_event(id, event);
        }
    }
    fn until(&mut self, expression: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.pump();
            if self
                .host
                .eval_source(&format!("if (!({expression})) throw new Error('pending');"))
                .is_ok()
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "SSE condition timed out: {expression}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

fn send_chunk(stream: &mut impl Write, bytes: &[u8]) -> std::io::Result<()> {
    write!(stream, "{:x}\r\n", bytes.len())?;
    stream.write_all(bytes)?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

#[test]
fn real_http_sse_streams_before_eof_and_abort_survives_llrt_async_host() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (release_tx, release_rx) = channel();
    let server = std::thread::spawn(move || {
        for round in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
            let first = "data: first👋\n\n".as_bytes();
            // Split a UTF-8 scalar across actual HTTP chunks.
            send_chunk(&mut stream, &first[..13]).unwrap();
            send_chunk(&mut stream, &first[13..]).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let rest = send_chunk(&mut stream, b"data: second\n\n")
                .and_then(|()| stream.write_all(b"0\r\n\r\n"));
            // The second request was aborted: the client may have closed
            // the connection already (a broken pipe or a reset).
            if round == 0 {
                rest.unwrap();
            }
        }
    });
    let mut bridge = Bridge::new();
    bridge.host.eval_source(&format!(r#"
        import {{ nextTick }} from 'process';
        globalThis.sse = [];
        globalThis.sseFailure = null;
        (async () => {{
            const response = await fetch('http://{address}/events');
            if (response.headers.get('content-type') !== 'text/event-stream') throw Error('SSE content type');
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            for (;;) {{
                const {{value, done}} = await reader.read();
                if (done) break;
                pending += decoder.decode(value, {{ stream: true }});
                let split;
                while ((split = pending.indexOf('\n\n')) !== -1) {{
                    const event = pending.slice(0, split); pending = pending.slice(split + 2);
                    await new Promise(resolve => nextTick(resolve));
                    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(event));
                    if (digest.byteLength !== 32) throw Error('LLRT digest did not complete during fetch');
                    sse.push(event.slice(6));
                }}
            }}
            globalThis.sseEnded = true;
        }})().catch(error => {{ globalThis.sseFailure = String(error); }});
    "#)).unwrap();
    bridge.until("sse.length === 1 || sseFailure");
    bridge.host.eval_source("if (sseFailure) throw Error(sseFailure); if (globalThis.sseEnded || sse[0] !== 'first👋') throw Error('stream was buffered or UTF-8 corrupted');").unwrap();
    release_tx.send(()).unwrap();
    bridge.until("globalThis.sseEnded || sseFailure");
    bridge.host.eval_source("if (sseFailure || JSON.stringify(sse) !== '[\"first👋\",\"second\"]') throw Error(sseFailure || JSON.stringify(sse));").unwrap();

    bridge
        .host
        .eval_source(&format!(
            r#"
        globalThis.abortFailure = null;
        (async () => {{
            const controller = new AbortController();
            const response = await fetch('http://{address}/abort', {{signal: controller.signal}});
            const reader = response.body.getReader();
            let prefix = '';
            const decoder = new TextDecoder();
            while (!prefix.includes('\n\n')) {{ const chunk = await reader.read(); prefix += decoder.decode(chunk.value, {{stream: true}}); }}
            const pending = reader.read();
            controller.abort();
            try {{ await pending; throw Error('aborted read resolved'); }}
            catch (error) {{ if (error.name !== 'AbortError') throw error; }}
            globalThis.sseAborted = true;
        }})().catch(error => {{ globalThis.abortFailure = String(error); }});
    "#
        ))
        .unwrap();
    bridge.until("globalThis.sseAborted || abortFailure");
    bridge
        .host
        .eval_source("if (abortFailure) throw Error(abortFailure);")
        .unwrap();
    bridge.pump();
    assert_eq!(
        bridge.cancelled.len(),
        1,
        "abort must reach production network task"
    );
    release_tx.send(()).unwrap();
    server.join().unwrap();
}
