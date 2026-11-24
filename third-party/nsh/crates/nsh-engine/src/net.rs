//! The HTTP stack behind `fetch`, on ureq (rustls with the platform's verifier):
//! one thread per request, streaming both ways.
//!
//! Feature `net`; the Windows, Linux and GPUI backends hand it to their
//! engines. Adapted from the stack of headless runs (`nsh-testing`'s
//! `headless/live.rs`), which platforms do not build. The
//! differences: no events at all after `cancel` (the engine would ignore
//! them anyway), `redirected` compares normalized URLs, and only connecting
//! and the response head have deadlines, so long-lived bodies (event
//! streams, large downloads) are not cut off.
//!
//! HTTP error statuses are responses, not failures. `cancel` shuts the
//! request's socket down, so a read or write blocked on it (the response
//! head, a body chunk, the TLS handshake, a proxy's `CONNECT`) returns at
//! once and the server sees the connection close. A cancel during DNS or
//! the TCP connect takes effect when the socket exists. A connection that
//! went back to the pool is no longer the request's, so a late cancel
//! leaves it to the next request. `pause` interrupts nothing: a paused
//! request stops before its next chunk.

use std::{
    cell::RefCell,
    io::Read,
    sync::{
        Arc, Condvar, Mutex, OnceLock, Weak,
        mpsc::{Receiver, Sender, channel},
    },
    time::Duration,
};

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

use crate::{
    FetchEvent, FetchEvents, FetchTask, HttpBody, HttpCache, HttpHead, HttpRequest, Network,
};

/// Bytes read from the response per chunk.
const CHUNK: usize = 64 << 10;

/// Redirects followed before the last response is handed on as it is.
const MAX_REDIRECTS: u32 = 20;

/// The network of every engine: one connection pool for the process, as a
/// system HTTP stack would share it.
pub fn network() -> Arc<dyn Network> {
    static NETWORK: OnceLock<Arc<UreqNetwork>> = OnceLock::new();
    NETWORK.get_or_init(|| Arc::new(UreqNetwork::new())).clone()
}

/// `fetch` on two ureq agents: one follows redirects, one hands on the 3xx
/// response (`redirect: "manual"`).
struct UreqNetwork {
    follow: Agent,
    manual: Agent,
}

impl UreqNetwork {
    fn new() -> Self {
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
                .timeout_connect(Some(Duration::from_secs(30)))
                .timeout_recv_response(Some(Duration::from_secs(60)))
                .build();
            Agent::with_parts(config, Cancellable::default(), DefaultResolver::default())
        };
        Self {
            follow: agent(MAX_REDIRECTS),
            manual: agent(0),
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
        let events = Events {
            sink: Arc::new(Mutex::new(events)),
            control: control.clone(),
        };
        let spawned = std::thread::Builder::new().name("nsh-fetch".into()).spawn({
            let events = events.clone();
            move || {
                REQUEST.with(|r| *r.borrow_mut() = Some(events.control.clone()));
                let result = run(&agent, request, body_rx, &events);
                events.control.detach(None);
                if let Err(e) = result {
                    events.send(FetchEvent::Failed(e.to_string()));
                }
            }
        });
        if let Err(e) = spawned {
            events.send(FetchEvent::Failed(format!("cannot start the request: {e}")));
        }
        Box::new(Task {
            control,
            body: body_tx,
        })
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

/// The engine's handle on a request.
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
            // pool in between (`Tracked::is_open` detaches under it).
            if let Some(socket) = s.socket.take().and_then(|s| s.upgrade()) {
                socket.shutdown();
            }
        }
        self.control.changed.notify_all();
        // Wakes a body reader waiting for its next chunk.
        if let Some(body) = &self.body {
            let _ = body.send(None);
        }
    }
}

/// The request's events, also reported from within ureq (the body reader);
/// silent once the request is cancelled.
#[derive(Clone)]
struct Events {
    sink: Arc<Mutex<FetchEvents>>,
    control: Arc<Control>,
}

impl Events {
    fn send(&self, event: FetchEvent) {
        let mut sink = self.sink.lock().expect("events");
        if !self.control.cancelled() {
            sink(event);
        }
    }
}

/// A streamed body: asks for each chunk, then hands it to ureq (which sends
/// it with chunked transfer encoding, the length being unknown).
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
                    // A cancelled upload must not end as a complete body.
                    if self.events.control.cancelled() {
                        return Err(std::io::Error::other("cancelled"));
                    }
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

/// Makes the request and reports its response, on the request's thread.
fn run(
    agent: &Agent,
    request: HttpRequest,
    body: Option<Receiver<Option<Vec<u8>>>>,
    events: &Events,
) -> Result<(), Box<dyn std::error::Error>> {
    // No HTTP cache here: nothing can answer from it.
    if request.cache == HttpCache::OnlyIfCached {
        return Err("no cached response (`cache: \"only-if-cached\"`)".into());
    }
    let requested: http::Uri = request.url.parse()?;
    let mut builder = http::Request::builder()
        .method(request.method.as_str())
        .uri(requested.clone());
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
    let url = response.get_uri();
    let redirected = *url != requested;
    let url = url.to_string();
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
        url,
        redirected,
        headers,
    }));
    let mut reader = response.body_mut().with_config().limit(u64::MAX).reader();
    let mut buf = vec![0; CHUNK];
    loop {
        if !events.control.proceed() {
            return Ok(());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        events.send(FetchEvent::Data(buf[..n].to_vec()));
    }
    events.send(FetchEvent::End);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc::RecvTimeoutError,
    };

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);

    /// A local HTTP server: `handle` gets each connection with its request
    /// line and headers already read (lower-case names). Returns the base URL.
    fn serve(
        handle: impl Fn(&mut BufReader<TcpStream>, &str, &[(String, String)]) + Send + 'static,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let mut headers = Vec::new();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).expect("header");
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    let (k, v) = h.split_once(':').expect("header line");
                    headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
                }
                handle(&mut reader, line.trim_end(), &headers);
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    fn respond(stream: &mut BufReader<TcpStream>, head: &str, body: &[u8]) {
        let s = stream.get_mut();
        let _ = write!(
            s,
            "HTTP/1.1 {head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = s.write_all(body);
    }

    fn request(method: &str, url: &str) -> HttpRequest {
        HttpRequest {
            method: method.to_owned(),
            url: url.to_owned(),
            headers: Vec::new(),
            body: HttpBody::Empty,
            follow_redirects: true,
            cache: HttpCache::Default,
        }
    }

    fn start(request: HttpRequest) -> (Box<dyn FetchTask>, Receiver<FetchEvent>) {
        let (tx, rx) = channel();
        let task = network().fetch(
            request,
            Box::new(move |e| {
                let _ = tx.send(e);
            }),
        );
        (task, rx)
    }

    fn next(rx: &Receiver<FetchEvent>) -> FetchEvent {
        rx.recv_timeout(WAIT).expect("event")
    }

    /// The rest of the body up to `End`.
    fn body(rx: &Receiver<FetchEvent>) -> Vec<u8> {
        let mut body = Vec::new();
        loop {
            match next(rx) {
                FetchEvent::Data(d) => body.extend(d),
                FetchEvent::End => return body,
                e => panic!("unexpected {e:?}"),
            }
        }
    }

    /// The head, then the whole body.
    fn response(rx: &Receiver<FetchEvent>) -> (HttpHead, Vec<u8>) {
        let FetchEvent::Head(head) = next(rx) else {
            panic!("no head")
        };
        (head, body(rx))
    }

    fn values<'a>(headers: &'a [(String, String)], name: &str) -> Vec<&'a str> {
        headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
            .collect()
    }

    #[test]
    fn get_with_headers_in_order() {
        let base = serve(|s, line, headers| {
            assert_eq!(line, "GET /path?q=1 HTTP/1.1");
            assert_eq!(values(headers, "x-a"), ["1", "2"]);
            let _ = s.get_mut().write_all(
                b"HTTP/1.1 404 Not Found\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\
                  Content-Length: 4\r\nConnection: close\r\n\r\nnope",
            );
        });
        let mut r = request("GET", &format!("{base}/path?q=1"));
        r.headers = vec![("X-A".into(), "1".into()), ("X-A".into(), "2".into())];
        let (_task, rx) = start(r);
        let (head, body) = response(&rx);
        assert_eq!(head.status, 404);
        assert_eq!(head.status_text, "Not Found");
        assert!(!head.redirected);
        assert_eq!(head.url, format!("{base}/path?q=1"));
        assert_eq!(values(&head.headers, "set-cookie"), ["a=1", "b=2"]);
        assert_eq!(body, b"nope");
    }

    #[test]
    fn post_streamed_body_is_chunked() {
        let base = serve(|s, line, headers| {
            assert_eq!(line, "POST /up HTTP/1.1");
            assert_eq!(values(headers, "transfer-encoding"), ["chunked"]);
            let mut body = Vec::new();
            loop {
                let mut size = String::new();
                s.read_line(&mut size).expect("size");
                let size = usize::from_str_radix(size.trim(), 16).expect("hex");
                let mut chunk = vec![0; size + 2];
                s.read_exact(&mut chunk).expect("chunk");
                if size == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..size]);
            }
            respond(s, "200 OK", &body);
        });
        let mut r = request("POST", &format!("{base}/up"));
        r.body = HttpBody::Stream;
        let (mut task, rx) = start(r);
        let parts: [&[u8]; 3] = [b"hello ", b"streamed ", b"world"];
        let mut wanted = 0;
        let head = loop {
            match next(&rx) {
                FetchEvent::BodyWanted => {
                    match parts.get(wanted) {
                        Some(p) => task.send(p.to_vec()),
                        None => task.finish(),
                    }
                    wanted += 1;
                }
                FetchEvent::Head(h) => break h,
                e => panic!("unexpected {e:?}"),
            }
        };
        assert_eq!(wanted, 4);
        assert_eq!(head.status, 200);
        assert_eq!(body(&rx), b"hello streamed world");
    }

    fn redirecting() -> String {
        serve(|s, line, _| {
            if line.starts_with("GET /a ") {
                let _ = s.get_mut().write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /b\r\nContent-Length: 0\r\n\
                      Connection: close\r\n\r\n",
                );
            } else {
                respond(s, "200 OK", b"at b");
            }
        })
    }

    #[test]
    fn follows_redirects() {
        let base = redirecting();
        let (_task, rx) = start(request("GET", &format!("{base}/a")));
        let (head, body) = response(&rx);
        assert_eq!(head.status, 200);
        assert!(head.redirected);
        assert_eq!(head.url, format!("{base}/b"));
        assert_eq!(body, b"at b");
    }

    #[test]
    fn manual_redirects_hand_on_the_3xx() {
        let base = redirecting();
        let mut r = request("GET", &format!("{base}/a"));
        r.follow_redirects = false;
        let (_task, rx) = start(r);
        let (head, _) = response(&rx);
        assert_eq!(head.status, 302);
        assert!(!head.redirected);
        assert_eq!(head.url, format!("{base}/a"));
        assert_eq!(values(&head.headers, "location"), ["/b"]);
    }

    #[test]
    fn pause_stops_reading_until_resumed() {
        const LEN: usize = 8 << 20;
        let base = serve(|s, _, _| respond(s, "200 OK", &vec![7; LEN]));
        let (mut task, rx) = start(request("GET", &base));
        let FetchEvent::Head(_) = next(&rx) else {
            panic!("no head")
        };
        let FetchEvent::Data(first) = next(&rx) else {
            panic!("no data")
        };
        task.pause(true);
        std::thread::sleep(Duration::from_millis(300));
        // Chunks read before the pause took effect are already queued: drain
        // them, then nothing more may arrive while paused.
        let mut total = first.len();
        let drain = |total: &mut usize| {
            while let Ok(e) = rx.try_recv() {
                let FetchEvent::Data(d) = e else {
                    panic!("unexpected {e:?}")
                };
                *total += d.len();
            }
        };
        drain(&mut total);
        std::thread::sleep(Duration::from_millis(300));
        let settled = total;
        drain(&mut total);
        assert!(
            total - settled <= 1 << 16,
            "{} bytes while paused",
            total - settled
        );
        assert!(total < LEN);
        task.pause(false);
        total += body(&rx).len();
        assert_eq!(total, LEN);
    }

    #[test]
    fn cancel_mid_body_stops_events() {
        let base = serve(|s, _, _| {
            let s = s.get_mut();
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n");
            let _ = s.write_all(&[1; 1000]);
            let _ = s.flush();
            std::thread::sleep(Duration::from_millis(200));
            let _ = s.write_all(&[2; 99000]);
        });
        let (task, rx) = start(request("GET", &base));
        let FetchEvent::Head(_) = next(&rx) else {
            panic!("no head")
        };
        let FetchEvent::Data(_) = next(&rx) else {
            panic!("no data")
        };
        task.cancel();
        match rx.recv_timeout(Duration::from_millis(600)) {
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {}
            Ok(e) => panic!("event after cancel: {e:?}"),
        }
    }

    #[test]
    fn connection_refused_fails() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").expect("bind");
            l.local_addr().expect("addr").port()
        };
        let (_task, rx) = start(request("GET", &format!("http://127.0.0.1:{port}/")));
        assert!(matches!(next(&rx), FetchEvent::Failed(_)));
    }

    #[test]
    fn invalid_url_fails() {
        let (_task, rx) = start(request("GET", "not a url"));
        assert!(matches!(next(&rx), FetchEvent::Failed(_)));
    }

    /// Whether the peer closes `stream` within 5 s (it sends nothing).
    fn closes(stream: &mut TcpStream) -> bool {
        use std::io::Read as _;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        match stream.read(&mut [0u8; 1]) {
            Ok(n) => n == 0,
            Err(e) => !matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ),
        }
    }

    /// Reads the rest of a request's head on a kept-alive connection;
    /// false when the client closed it instead.
    fn next_request(s: &mut BufReader<TcpStream>) -> bool {
        let mut line = String::new();
        if s.read_line(&mut line).unwrap_or(0) == 0 {
            return false;
        }
        loop {
            let mut h = String::new();
            if s.read_line(&mut h).unwrap_or(0) == 0 || h.trim_end().is_empty() {
                return true;
            }
        }
    }

    /// Waits for the request's thread to end: it drops the events' sink,
    /// which ends `rx` (events that came before the cancel are skipped).
    fn ends(rx: &Receiver<FetchEvent>) {
        loop {
            match rx.recv_timeout(WAIT) {
                Ok(_) => {}
                Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => panic!("the request's thread still runs"),
            }
        }
    }

    // The servers of the three close tests below keep their end open after
    // the client closes, so the request's thread ends only because the
    // cancel woke it.

    #[test]
    fn a_cancel_while_waiting_for_the_head_closes_the_connection() {
        let (asked_tx, asked_rx) = channel();
        let (closed_tx, closed_rx) = channel();
        let base = serve(move |s, _, _| {
            let _ = asked_tx.send(());
            let _ = closed_tx.send(closes(s.get_mut()));
            std::thread::sleep(WAIT);
        });
        let (task, rx) = start(request("GET", &format!("{base}/slow")));
        asked_rx.recv_timeout(WAIT).expect("no request");
        task.cancel();
        assert!(
            closed_rx.recv_timeout(WAIT).expect("no request"),
            "the connection stayed open"
        );
        ends(&rx);
    }

    #[test]
    fn a_cancel_while_the_body_comes_closes_the_connection() {
        let (closed_tx, closed_rx) = channel();
        let base = serve(move |s, _, _| {
            let stream = s.get_mut();
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\nfirst");
            let _ = closed_tx.send(closes(stream));
            std::thread::sleep(WAIT);
        });
        let (task, rx) = start(request("GET", &format!("{base}/stream")));
        assert!(matches!(next(&rx), FetchEvent::Head(_)));
        assert!(matches!(next(&rx), FetchEvent::Data(d) if d == b"first"));
        // The thread then blocks reading the rest. Cancelling sooner would
        // stop it before that read, and dropping the unread response would
        // close the connection even without the shutdown.
        std::thread::sleep(Duration::from_millis(200));
        task.cancel();
        assert!(
            closed_rx.recv_timeout(WAIT).expect("no request"),
            "the connection stayed open"
        );
        ends(&rx);
    }

    #[test]
    fn a_cancel_during_the_tls_handshake_closes_the_connection() {
        use std::io::Read as _;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (hello_tx, hello_rx) = channel();
        let (closed_tx, closed_rx) = channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            // Takes the ClientHello and never answers it.
            let mut hello = [0u8; 4096];
            let n = stream.read(&mut hello).unwrap_or(0);
            let _ = hello_tx.send(n > 0 && hello[0] == 0x16);
            let _ = closed_tx.send(closes(&mut stream));
            std::thread::sleep(WAIT);
        });
        let (task, rx) = start(request("GET", &format!("https://127.0.0.1:{port}/")));
        assert!(
            hello_rx.recv_timeout(WAIT).expect("no connection"),
            "no TLS handshake came"
        );
        task.cancel();
        assert!(
            closed_rx.recv_timeout(WAIT).expect("no connection"),
            "the connection stayed open"
        );
        ends(&rx);
    }

    /// The updater cancels a request after its `End`, when its connection
    /// is back in the pool: the next request still gets that connection.
    #[test]
    fn a_cancel_after_the_end_leaves_the_connection_to_the_next_request() {
        let (connected_tx, connected_rx) = channel();
        let base = serve(move |s, _, _| {
            let _ = connected_tx.send(());
            let _ = s
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            if next_request(s) {
                let _ = s
                    .get_mut()
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo");
            }
        });
        let (first, rx) = start(request("GET", &format!("{base}/a")));
        assert_eq!(response(&rx).1, b"ok");
        std::thread::sleep(Duration::from_millis(100));
        let (_second, rx) = start(request("GET", &format!("{base}/b")));
        first.cancel();
        assert_eq!(response(&rx).1, b"two");
        connected_rx.recv_timeout(WAIT).expect("no connection");
        assert!(
            connected_rx.try_recv().is_err(),
            "the second request made a new connection"
        );
    }

    /// A response without a body goes back to the pool before its request's
    /// thread ends: a cancel then must not shut down the connection another
    /// request has taken.
    #[test]
    fn a_late_cancel_spares_the_request_now_on_its_connection() {
        let (go_tx, go_rx) = channel::<()>();
        let go_rx = Mutex::new(go_rx);
        let (reused_tx, reused_rx) = channel::<()>();
        let base = serve(move |s, line, _| {
            if !line.starts_with("GET /a ") {
                let _ = s
                    .get_mut()
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nnew");
                return;
            }
            let _ = go_rx.lock().expect("go").recv_timeout(WAIT);
            let _ = s.get_mut().write_all(b"HTTP/1.1 204 No Content\r\n\r\n");
            if next_request(s) {
                let _ = reused_tx.send(());
                std::thread::sleep(Duration::from_millis(500));
                let _ = s
                    .get_mut()
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo");
            }
        });
        let (mut a, rx_a) = start(request("GET", &format!("{base}/a")));
        // Paused, /a's thread waits after its head; its connection is pooled.
        a.pause(true);
        go_tx.send(()).expect("go");
        assert!(matches!(next(&rx_a), FetchEvent::Head(_)));
        let (_b, rx_b) = start(request("GET", &format!("{base}/b")));
        reused_rx
            .recv_timeout(WAIT)
            .expect("/b did not reuse /a's connection");
        a.cancel();
        assert_eq!(response(&rx_b).1, b"two");
    }
}
