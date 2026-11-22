//! The network of headless runs (`nsh test`, `"live"`): `fetch` on ureq
//! (one thread per request, streaming both ways).

use std::{
    io::Read,
    sync::{
        Arc, Condvar, Mutex,
        mpsc::{Receiver, Sender, channel},
    },
    time::Duration,
};

use nsh_engine::{FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead, HttpRequest, Network};
use ureq::{Agent, ResponseExt, SendBody, http};

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
            Agent::config_builder()
                .http_status_as_error(false)
                .tls_config(
                    ureq::tls::TlsConfig::builder()
                        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                        .build(),
                )
                .max_redirects(redirects)
                .max_redirects_will_error(false)
                .timeout_global(Some(Duration::from_secs(60)))
                .build()
                .into()
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
        // A blocked read or write is not interrupted: the thread stops at
        // its next chunk, and the engine ignores what it still reports.
        self.control.state.lock().expect("control").cancelled = true;
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
            if let Err(e) = run(&agent, request, body_rx, &c, &events)
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
