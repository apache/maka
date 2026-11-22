//! The network of a test session's app on a real host: every request goes
//! to the test (`nsh test`'s side, over the dev server), which answers it
//! from its routes, fails it, or lets it through ([`FetchReply::Pass`]):
//! then the host's own network makes it, as it would without a test.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use nsh_dev::protocol::{FetchReply, WireRequest};
use nsh_engine::{FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead, HttpRequest, Network};

/// What a host sends the test about its app: its requests, and the
/// batches of a traced app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    /// Request `.0`: answer it (`ClientMessage::Fetch`).
    Fetch(u64, WireRequest),
    /// The app no longer wants the answer to request `.0`.
    Cancel(u64),
    /// The items of a batch the traced app applied, a line each
    /// (`ClientMessage::Trace`).
    Trace(Vec<String>),
}

impl Outgoing {
    /// The message that sends it to the test.
    pub fn into_message(self) -> nsh_dev::protocol::ClientMessage {
        use nsh_dev::protocol::ClientMessage;
        match self {
            Outgoing::Fetch(id, request) => ClientMessage::Fetch { id, request },
            Outgoing::Cancel(id) => ClientMessage::FetchCancel { id },
            Outgoing::Trace(items) => ClientMessage::Trace { items },
        }
    }
}

/// Sends [`Outgoing`] messages to the test (the dev client's, the web
/// page's socket).
pub type Send = Arc<dyn Fn(Outgoing) + std::marker::Send + Sync>;

/// The requests waiting for the test's answer, and what sends them.
pub(crate) struct Forwarder {
    send: Send,
    pending: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
}

/// A request the test has not finished answering.
struct Pending {
    /// Where its events go (`None` once handed to the host's network).
    events: Option<FetchEvents>,
    /// The request, for the host's network to make if the test lets it
    /// through.
    request: HttpRequest,
    /// The host's network ([`ForwardNetwork::platform`]).
    platform: Option<Arc<dyn Network>>,
    /// The host's network's task, once the test let it through.
    task: Option<Box<dyn FetchTask>>,
}

impl Forwarder {
    pub(crate) fn new(send: Send) -> Arc<Self> {
        Arc::new(Forwarder {
            send,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Pending>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forwards `request`: the test's answer goes to `events`.
    fn forward(
        &self,
        request: HttpRequest,
        events: FetchEvents,
        platform: Option<Arc<dyn Network>>,
    ) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let wire = WireRequest {
            method: request.method.clone(),
            url: request.url.clone(),
            headers: request.headers.clone(),
            body: match &request.body {
                HttpBody::Bytes(bytes) => bytes.clone(),
                HttpBody::Empty | HttpBody::Stream => Vec::new(),
            },
            follow_redirects: request.follow_redirects,
        };
        self.lock().insert(
            id,
            Pending {
                events: Some(events),
                request,
                platform,
                task: None,
            },
        );
        (self.send)(Outgoing::Fetch(id, wire));
        id
    }

    /// The test's `reply` to request `id`.
    pub(crate) fn reply(&self, id: u64, reply: FetchReply) {
        let mut pending = self.lock();
        let Some(entry) = pending.get_mut(&id) else {
            return;
        };
        match reply {
            FetchReply::Pass => {
                let Some(events) = entry.events.take() else {
                    return;
                };
                match entry.platform.clone() {
                    Some(network) => {
                        entry.task = Some(network.fetch(entry.request.clone(), events));
                    }
                    None => {
                        let mut events = events;
                        events(FetchEvent::Failed("the host has no network".into()));
                        pending.remove(&id);
                    }
                }
            }
            FetchReply::Head {
                status,
                headers,
                url,
            } => {
                if let Some(events) = entry.events.as_mut() {
                    events(FetchEvent::Head(HttpHead {
                        status,
                        status_text: String::new(),
                        url,
                        redirected: false,
                        headers,
                    }));
                }
            }
            FetchReply::Data { bytes } => {
                if let Some(events) = entry.events.as_mut() {
                    events(FetchEvent::Data(bytes));
                }
            }
            FetchReply::End | FetchReply::Failed { .. } => {
                if let Some(mut events) = pending.remove(&id).and_then(|e| e.events) {
                    events(match reply {
                        FetchReply::Failed { message } => FetchEvent::Failed(message),
                        _ => FetchEvent::End,
                    });
                }
            }
        }
    }

    fn cancel(&self, id: u64) {
        let entry = self.lock().remove(&id);
        if let Some(task) = entry.and_then(|e| e.task) {
            task.cancel();
        } else {
            (self.send)(Outgoing::Cancel(id));
        }
    }

    fn with_task(&self, id: u64, f: impl FnOnce(&mut Box<dyn FetchTask>)) {
        if let Some(task) = self.lock().get_mut(&id).and_then(|e| e.task.as_mut()) {
            f(task);
        }
    }
}

/// The network a test session's app runs on: its requests go to the test
/// ([`Forwarder`]); those it lets through, to `platform` (the host's).
pub(crate) struct ForwardNetwork {
    pub(crate) forwarder: Arc<Forwarder>,
    pub(crate) platform: Option<Arc<dyn Network>>,
}

impl Network for ForwardNetwork {
    fn fetch(&self, request: HttpRequest, mut events: FetchEvents) -> Box<dyn FetchTask> {
        if request.body == HttpBody::Stream {
            // The body first, gathered, as the test answers whole requests.
            events(FetchEvent::BodyWanted);
            return Box::new(ForwardTask {
                forwarder: self.forwarder.clone(),
                platform: self.platform.clone(),
                state: State::Gathering {
                    request,
                    events,
                    body: Vec::new(),
                },
            });
        }
        let id = self
            .forwarder
            .forward(request, events, self.platform.clone());
        Box::new(ForwardTask {
            forwarder: self.forwarder.clone(),
            platform: self.platform.clone(),
            state: State::Sent(id),
        })
    }
}

/// A forwarded request in flight.
struct ForwardTask {
    forwarder: Arc<Forwarder>,
    platform: Option<Arc<dyn Network>>,
    state: State,
}

enum State {
    /// JS still streams the body.
    Gathering {
        request: HttpRequest,
        events: FetchEvents,
        body: Vec<u8>,
    },
    /// Sent as request `.0`.
    Sent(u64),
    /// Done with.
    Gone,
}

impl FetchTask for ForwardTask {
    fn send(&mut self, chunk: Vec<u8>) {
        if let State::Gathering { events, body, .. } = &mut self.state {
            body.extend_from_slice(&chunk);
            events(FetchEvent::BodyWanted);
        }
    }

    fn finish(&mut self) {
        if let State::Gathering {
            mut request,
            events,
            body,
        } = std::mem::replace(&mut self.state, State::Gone)
        {
            request.body = HttpBody::Bytes(body);
            let id = self
                .forwarder
                .forward(request, events, self.platform.clone());
            self.state = State::Sent(id);
        }
    }

    fn pause(&mut self, paused: bool) {
        if let State::Sent(id) = self.state {
            self.forwarder.with_task(id, |task| task.pause(paused));
        }
    }

    fn cancel(self: Box<Self>) {
        if let State::Sent(id) = self.state {
            self.forwarder.cancel(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_go_to_the_test_and_answers_come_back() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let log = sent.clone();
        let forwarder = Forwarder::new(Arc::new(move |m| log.lock().unwrap().push(m)));
        let network = ForwardNetwork {
            forwarder: forwarder.clone(),
            platform: None,
        };
        let got = Arc::new(Mutex::new(Vec::new()));
        let events = got.clone();
        let _task = network.fetch(
            HttpRequest::get("https://api.test/a"),
            Box::new(move |e| events.lock().unwrap().push(e)),
        );
        let id = match &sent.lock().unwrap()[0] {
            Outgoing::Fetch(id, request) => {
                assert_eq!(request.url, "https://api.test/a");
                *id
            }
            other => panic!("{other:?}"),
        };
        forwarder.reply(
            id,
            FetchReply::Head {
                status: 200,
                headers: Vec::new(),
                url: "https://api.test/a".into(),
            },
        );
        forwarder.reply(
            id,
            FetchReply::Data {
                bytes: b"hi".to_vec(),
            },
        );
        forwarder.reply(id, FetchReply::End);
        let got = got.lock().unwrap();
        assert!(matches!(got[0], FetchEvent::Head(ref h) if h.status == 200));
        assert_eq!(got[1], FetchEvent::Data(b"hi".to_vec()));
        assert_eq!(got[2], FetchEvent::End);
    }

    #[test]
    fn a_request_let_through_fails_without_a_network() {
        let forwarder = Forwarder::new(Arc::new(|_| {}));
        let network = ForwardNetwork {
            forwarder: forwarder.clone(),
            platform: None,
        };
        let got = Arc::new(Mutex::new(Vec::new()));
        let events = got.clone();
        let _task = network.fetch(
            HttpRequest::get("https://api.test/a"),
            Box::new(move |e| events.lock().unwrap().push(e)),
        );
        forwarder.reply(1, FetchReply::Pass);
        assert!(matches!(got.lock().unwrap()[0], FetchEvent::Failed(_)));
    }
}
