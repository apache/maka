//! The network of headless runs (`nsh test`, `"live"`): `fetch` on ureq
//! (one thread per request, streaming both ways).
//!
//! `cancel` shuts the request's socket down, so the server sees the
//! connection close at once (during DNS or the TCP connect, as soon as the
//! socket exists), as with `nsh_engine`'s stack (`net.rs`), whose connector
//! this one copies.

use std::{
    cell::RefCell,
    io::Read,
    sync::{
        Arc, Condvar, Mutex, Weak,
        mpsc::{Receiver, Sender, channel},
    },
    time::Duration,
};

use nsh_engine::{FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead, HttpRequest, Network};
use ureq::{
    Agent, ResponseExt, SendBody, http,
    unversioned::{
        resolver::DefaultResolver,
        transport::{
            Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout, ShutdownHandle,
            Transport,
        },
    },
};

/// Bytes read from the response per chunk.
const CHUNK: usize = 64 << 10;

/// `fetch` for headless runs, on ureq: redirects followed (at most 10)
/// or not, as each request asks.
pub struct UreqNetwork {
    follow: Agent,
    manual: Agent,
}

impl UreqNetwork {
    /// A network with a 60 s timeout per request.
    pub fn new() -> Self {
        let agent = |redirects| {
            let config = Agent::config_builder()
                .http_status_as_error(false)
                .tls_config(
                    ureq::tls::TlsConfig::builder()
                        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                        .build(),
                )
                .max_redirects(redirects)
                .max_redirects_will_error(false)
                .timeout_global(Some(Duration::from_secs(60)))
                .build();
            Agent::with_parts(config, Cancellable::default(), DefaultResolver::default())
        };
        Self {
            follow: agent(10),
            manual: agent(0),
        }
    }
}

impl Default for UreqNetwork {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared between the engine's handle and the request's thread.
#[derive(Default)]
struct Control {
    state: Mutex<ControlState>,
    changed: Condvar,
}

#[derive(Default)]
struct ControlState {
    paused: bool,
    cancelled: bool,
    /// The socket the request is using now, shut down by `cancel`.
    socket: Option<Weak<dyn ShutdownHandle>>,
}

impl Control {
    /// Waits while paused; false once cancelled.
    fn proceed(&self) -> bool {
        let mut s = self.state.lock().expect("control");
        while s.paused && !s.cancelled {
            s = self.changed.wait(s).expect("control");
        }
        !s.cancelled
    }

    fn cancelled(&self) -> bool {
        self.state.lock().expect("control").cancelled
    }

    /// The request is using `socket` now: a cancel shuts it down (at once
    /// when it came first).
    fn attach(&self, socket: &Weak<dyn ShutdownHandle>) {
        let mut s = self.state.lock().expect("control");
        if s.cancelled {
            if let Some(socket) = socket.upgrade() {
                socket.shutdown();
            }
        } else {
            s.socket = Some(socket.clone());
        }
    }

    /// The request no longer uses `socket` (`None`: any).
    fn detach(&self, socket: Option<&Weak<dyn ShutdownHandle>>) {
        let mut s = self.state.lock().expect("control");
        if socket.is_none_or(|socket| s.socket.as_ref().is_some_and(|s| Weak::ptr_eq(s, socket))) {
            s.socket = None;
        }
    }
}

impl std::fmt::Debug for Control {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Control")
    }
}

thread_local! {
    /// The request of this thread (one thread per request).
    static REQUEST: RefCell<Option<Arc<Control>>> = const { RefCell::new(None) };
}

/// ureq's default connector, keeping each connection's socket so that the
/// request using it can shut it down when cancelled.
#[derive(Debug, Default)]
struct Cancellable(DefaultConnector);

impl Connector for Cancellable {
    type Out = Tracked;

    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<()>,
    ) -> Result<Option<Tracked>, ureq::Error> {
        let socket: Arc<Mutex<Option<Weak<dyn ShutdownHandle>>>> = Arc::default();
        let register = details.register_shutdown.clone();
        let kept = socket.clone();
        let details = ConnectionDetails {
            uri: details.uri,
            addrs: details.addrs.clone(),
            config: details.config,
            request_level: details.request_level,
            resolver: details.resolver,
            now: details.now,
            timeout: details.timeout,
            current_time: details.current_time.clone(),
            run_connector: details.run_connector.clone(),
            // Called on the request's thread as soon as the socket exists, so
            // a cancel interrupts the TLS handshake or a proxy's CONNECT too.
            register_shutdown: Arc::new(move |handle: Weak<dyn ShutdownHandle>| {
                REQUEST.with(|r| {
                    if let Some(control) = &*r.borrow() {
                        control.attach(&handle);
                    }
                });
                *kept.lock().expect("socket") = Some(handle.clone());
                register(handle)
            }),
        };
        let inner = self.0.connect(&details, chained)?;
        let socket = socket.lock().expect("socket").take();
        Ok(inner.map(|inner| Tracked {
            inner,
            socket,
            owner: None,
        }))
    }
}

/// A connection that tells the request using it which socket it is on.
#[derive(Debug)]
struct Tracked {
    inner: Box<dyn Transport>,
    socket: Option<Weak<dyn ShutdownHandle>>,
    owner: Option<Arc<Control>>,
}

impl Tracked {
    fn attach(&mut self) {
        if let Some(socket) = &self.socket {
            let control = REQUEST.with(|r| r.borrow().clone());
            if let Some(control) = control {
                control.attach(socket);
                self.owner = Some(control);
            }
        }
    }
}

impl Transport for Tracked {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.attach();
        self.inner.transmit_output(amount, timeout)
    }

    fn maybe_await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.attach();
        self.inner.maybe_await_input(timeout)
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.attach();
        self.inner.await_input(timeout)
    }

    fn is_open(&mut self) -> bool {
        // ureq asks before pooling the connection and before reusing it:
        // from here on it is no longer the last request's.
        if let Some(owner) = self.owner.take() {
            owner.detach(self.socket.as_ref());
        }
        self.inner.is_open()
    }

    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}

struct Task {
    control: Arc<Control>,
    /// Chunks of a streamed body (`None`: the end).
    body: Option<Sender<Option<Vec<u8>>>>,
}

impl FetchTask for Task {
    fn send(&mut self, chunk: Vec<u8>) {
        if let Some(body) = &self.body {
            let _ = body.send(Some(chunk));
        }
    }

    fn finish(&mut self) {
        if let Some(body) = self.body.take() {
            let _ = body.send(None);
        }
    }

    fn pause(&mut self, paused: bool) {
        self.control.state.lock().expect("control").paused = paused;
        self.control.changed.notify_all();
    }

    fn cancel(self: Box<Self>) {
        {
            let mut s = self.control.state.lock().expect("control");
            s.cancelled = true;
            // Under the lock, so that the connection cannot go back to the
            // pool in between (`Tracked::is_open` detaches under it). The
            // blocked read or write returns, and the thread reports no `End`
            // or `Failed`.
            if let Some(socket) = s.socket.take().and_then(|s| s.upgrade()) {
                socket.shutdown();
            }
        }
        self.control.changed.notify_all();
        if let Some(body) = &self.body {
            let _ = body.send(None);
        }
    }
}

impl Network for UreqNetwork {
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask> {
        let agent = if request.follow_redirects {
            self.follow.clone()
        } else {
            self.manual.clone()
        };
        let control = Arc::new(Control::default());
        let (body_tx, body_rx) = match request.body {
            HttpBody::Stream => {
                let (tx, rx) = channel();
                (Some(tx), Some(rx))
            }
            _ => (None, None),
        };
        let c = control.clone();
        let events = Events(Arc::new(Mutex::new(events)));
        std::thread::spawn(move || {
            REQUEST.with(|r| *r.borrow_mut() = Some(c.clone()));
            let result = run(&agent, request, body_rx, &c, &events);
            c.detach(None);
            if let Err(e) = result
                && !c.cancelled()
            {
                events.send(FetchEvent::Failed(e.to_string()));
            }
        });
        Box::new(Task {
            control,
            body: body_tx,
        })
    }
}

/// The request's events, also reported from within ureq (the body reader).
#[derive(Clone)]
struct Events(Arc<Mutex<FetchEvents>>);

impl Events {
    fn send(&self, event: FetchEvent) {
        (self.0.lock().expect("events"))(event);
    }
}

/// A streamed body: asks for each chunk, then hands it to ureq.
struct BodyReader {
    chunks: Receiver<Option<Vec<u8>>>,
    current: Vec<u8>,
    at: usize,
    events: Events,
    done: bool,
}

impl Read for BodyReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.at == self.current.len() {
            if self.done {
                return Ok(0);
            }
            self.events.send(FetchEvent::BodyWanted);
            match self.chunks.recv() {
                Ok(Some(chunk)) => {
                    self.current = chunk;
                    self.at = 0;
                }
                Ok(None) | Err(_) => {
                    self.done = true;
                    return Ok(0);
                }
            }
        }
        let n = buf.len().min(self.current.len() - self.at);
        buf[..n].copy_from_slice(&self.current[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

fn run(
    agent: &Agent,
    request: HttpRequest,
    body: Option<Receiver<Option<Vec<u8>>>>,
    control: &Control,
    events: &Events,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut builder = http::Request::builder()
        .method(request.method.as_str())
        .uri(request.url.as_str());
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    let mut response = match (request.body, body) {
        (HttpBody::Bytes(bytes), _) => agent.run(builder.body(bytes)?)?,
        (HttpBody::Stream, Some(chunks)) => {
            let reader = BodyReader {
                chunks,
                current: Vec::new(),
                at: 0,
                events: events.clone(),
                done: false,
            };
            agent.run(builder.body(SendBody::from_owned_reader(reader))?)?
        }
        _ => agent.run(builder.body(())?)?,
    };
    let url = response.get_uri().to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();
    let status = response.status();
    events.send(FetchEvent::Head(HttpHead {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        redirected: url != request.url,
        url,
        headers,
    }));
    let mut reader = response.body_mut().with_config().limit(u64::MAX).reader();
    let mut buf = vec![0; CHUNK];
    loop {
        if !control.proceed() {
            return Ok(());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        events.send(FetchEvent::Data(buf[..n].to_vec()));
    }
    if !control.cancelled() {
        events.send(FetchEvent::End);
    }
    Ok(())
}

#[cfg(all(test, feature = "js"))]
#[path = "net_fetch_tests.rs"]
mod fetch_tests;

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
    };

    use nsh_engine::HttpCache;

    use super::*;

    #[test]
    fn a_cancel_closes_the_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (asked_tx, asked_rx) = channel();
        let (closed_tx, closed_rx) = channel();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream);
            // The request's head, then no answer.
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim_end().is_empty() {
                    break;
                }
            }
            let _ = asked_tx.send(());
            let stream = reader.get_mut();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("timeout");
            let closed = match stream.read(&mut [0u8; 1]) {
                Ok(n) => n == 0,
                Err(e) => !matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ),
            };
            let _ = closed_tx.send(closed);
            // Keeps its end open: the request ends because the cancel woke it.
            std::thread::sleep(Duration::from_secs(10));
        });
        let (events_tx, events_rx) = channel();
        let task = UreqNetwork::new().fetch(
            HttpRequest {
                method: "GET".into(),
                url: format!("http://127.0.0.1:{port}/slow"),
                headers: Vec::new(),
                body: HttpBody::Empty,
                follow_redirects: true,
                cache: HttpCache::Default,
            },
            Box::new(move |e| {
                let _ = events_tx.send(e);
            }),
        );
        asked_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("no request");
        task.cancel();
        assert!(
            closed_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("no request"),
            "the connection stayed open"
        );
        // The request's thread ends, reporting nothing more: it drops the
        // events' sink.
        assert!(matches!(
            events_rx.recv_timeout(Duration::from_secs(10)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        ));
    }
}
