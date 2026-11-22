//! A stand-in for a device's network in tests: a network that answers
//! from a list ([`StubNetwork`]), and one that keeps what it is asked
//! ([`RecordingNetwork`]). Storage's is [`crate::MemoryStorage`].

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_engine::{
    Clock, FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead, HttpRequest, Network,
};
use regex::Regex;

/// A response [`StubNetwork`] gives.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct StubResponse {
    /// The status code.
    pub status: u16,
    /// Header names and values.
    pub headers: Vec<(String, String)>,
    /// The body.
    pub body: Vec<u8>,
    /// The request fails with this instead (no response: offline, a reset
    /// connection).
    pub error: Option<String>,
    /// How long the response takes.
    pub delay: Duration,
}

/// Gives the response to a request ([`StubRoute::Handler`]): `reply` takes
/// it, now or later, from any thread.
pub type StubHandler = Arc<dyn Fn(HttpRequest, StubReply) + Send + Sync>;

/// Takes the response a [`StubHandler`] gives.
pub struct StubReply(Box<dyn FnOnce(StubResponse) + Send>);

impl StubReply {
    /// Answers the request with `response`.
    pub fn send(self, response: StubResponse) {
        (self.0)(response);
    }
}

/// What [`StubNetwork`] answers the requests a route matches with.
#[derive(Clone)]
pub enum StubRoute {
    /// This response.
    Response(StubResponse),
    /// What the handler gives.
    Handler(StubHandler),
}

impl From<StubResponse> for StubRoute {
    fn from(response: StubResponse) -> Self {
        StubRoute::Response(response)
    }
}

impl std::fmt::Debug for StubRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StubRoute::Response(response) => f.debug_tuple("Response").field(response).finish(),
            StubRoute::Handler(_) => f.write_str("Handler"),
        }
    }
}

/// The URLs a route matches: one, or (with `*`) a glob.
#[derive(Debug)]
pub(crate) enum Url {
    Exact(String),
    Glob(Regex),
}

impl Url {
    pub(crate) fn of(pattern: &str) -> Url {
        if !pattern.contains('*') {
            return Url::Exact(pattern.to_owned());
        }
        let parts: Vec<String> = pattern.split('*').map(regex::escape).collect();
        let re = Regex::new(&format!("^{}$", parts.join(".*"))).expect("an escaped glob");
        Url::Glob(re)
    }

    pub(crate) fn matches(&self, url: &str) -> bool {
        match self {
            Url::Exact(want) => want == url,
            Url::Glob(re) => re.is_match(url),
        }
    }
}

/// `fetch` that answers from a list of routes, by method and URL (the
/// first that matches); a request none matches fails, so a test never
/// reaches the network unasked.
#[derive(Debug, Default)]
pub struct StubNetwork {
    routes: Vec<(String, Url, StubRoute)>,
    requests: Mutex<Vec<HttpRequest>>,
    /// What responses' `delay`s are on: the app's clock.
    clock: Clock,
}

impl StubNetwork {
    /// A network with `routes`, each keyed `"<METHOD> <URL>"` (`"GET
    /// https://api.example.com/todos"`; a bare URL is a `GET`); the URL is
    /// matched whole, its query included, and `*` in it matches anything
    /// (`"GET https://api.example.com/todos/*"`).
    pub fn new<R: Into<StubRoute>>(routes: impl IntoIterator<Item = (String, R)>) -> Self {
        let routes = routes
            .into_iter()
            .map(|(key, route)| {
                let (method, url) = match key.split_once(' ') {
                    Some((method, url))
                        if !method.is_empty()
                            && method.chars().all(|c| c.is_ascii_alphabetic()) =>
                    {
                        (method.to_ascii_uppercase(), url.trim().to_owned())
                    }
                    _ => ("GET".to_owned(), key.trim().to_owned()),
                };
                (method, Url::of(&url), route.into())
            })
            .collect();
        Self {
            routes,
            requests: Mutex::new(Vec::new()),
            clock: Clock::system(),
        }
    }

    /// Its responses' `delay`s pass on `clock`, the app's: on a manual one
    /// they come when the test moves it past them.
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// The requests made so far, in order (bodies streamed by JS are not
    /// kept).
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().expect("requests").clone()
    }

    fn route(&self, request: &HttpRequest) -> Option<&StubRoute> {
        self.routes
            .iter()
            .find(|(method, url, _)| *method == request.method && url.matches(&request.url))
            .map(|(_, _, route)| route)
    }
}

impl Network for StubNetwork {
    fn fetch(&self, request: HttpRequest, mut events: FetchEvents) -> Box<dyn FetchTask> {
        self.requests
            .lock()
            .expect("requests")
            .push(request.clone());
        let route = self.route(&request).cloned();
        let streamed = request.body == HttpBody::Stream;
        if streamed {
            // The body is taken first, as a server would.
            events(FetchEvent::BodyWanted);
        }
        let task = StubTask {
            events: Arc::new(Mutex::new(Some(events))),
            pending: None,
        };
        let start = Pending {
            route,
            request,
            events: task.events.clone(),
            clock: self.clock.clone(),
        };
        let mut task = task;
        if streamed {
            task.pending = Some(start);
        } else {
            start.answer();
        }
        Box::new(task)
    }
}

/// A request to answer.
struct Pending {
    route: Option<StubRoute>,
    request: HttpRequest,
    /// Taken by the answer (or a cancel).
    events: Arc<Mutex<Option<FetchEvents>>>,
    clock: Clock,
}

impl Pending {
    fn answer(self) {
        let url = self.request.url.clone();
        let events = self.events;
        let clock = self.clock;
        let send = move |response: StubResponse| deliver(&events, url, response, &clock);
        match self.route {
            Some(StubRoute::Response(response)) => send(response),
            Some(StubRoute::Handler(handler)) => handler(self.request, StubReply(Box::new(send))),
            None => {
                let message = format!(
                    "{} {}: no response is listed for it",
                    self.request.method, self.request.url
                );
                send(StubResponse {
                    error: Some(message),
                    ..StubResponse::default()
                });
            }
        }
    }
}

/// Reports `response` (after its delay on `clock`) to the request whose
/// events are `events`, unless it was cancelled.
fn deliver(
    events: &Arc<Mutex<Option<FetchEvents>>>,
    url: String,
    response: StubResponse,
    clock: &Clock,
) {
    if !response.delay.is_zero() {
        let events = events.clone();
        let later = clock.clone();
        clock.at(clock.now() + response.delay, move || {
            let response = StubResponse {
                delay: Duration::ZERO,
                ..response
            };
            deliver(&events, url, response, &later);
        });
        return;
    }
    let Some(mut events) = events.lock().expect("events").take() else {
        return;
    };
    if let Some(message) = response.error {
        events(FetchEvent::Failed(message));
        return;
    }
    events(FetchEvent::Head(HttpHead {
        status: response.status,
        status_text: String::new(),
        url,
        redirected: false,
        headers: response.headers,
    }));
    if !response.body.is_empty() {
        events(FetchEvent::Data(response.body));
    }
    events(FetchEvent::End);
}

/// A request of [`StubNetwork`]: whose body JS still streams until
/// `pending` answers it once the body is complete.
struct StubTask {
    events: Arc<Mutex<Option<FetchEvents>>>,
    pending: Option<Pending>,
}

impl FetchTask for StubTask {
    fn send(&mut self, _chunk: Vec<u8>) {
        if self.pending.is_some()
            && let Some(events) = self.events.lock().expect("events").as_mut()
        {
            events(FetchEvent::BodyWanted);
        }
    }

    fn finish(&mut self) {
        if let Some(pending) = self.pending.take() {
            pending.answer();
        }
    }

    fn pause(&mut self, _paused: bool) {}

    fn cancel(self: Box<Self>) {
        self.events.lock().expect("events").take();
    }
}

/// A network that keeps the requests it is asked, then hands them to
/// another (a [`StubNetwork`], the real one): what a test reads back.
pub struct RecordingNetwork {
    inner: Arc<dyn Network>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl RecordingNetwork {
    /// `inner`, its requests kept.
    pub fn new(inner: Arc<dyn Network>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            requests: Mutex::new(Vec::new()),
        })
    }

    /// Keeps `request` as made, though it is not made through this
    /// network (a host made it on its own).
    #[cfg(feature = "js")]
    pub(crate) fn record(&self, request: HttpRequest) {
        self.requests.lock().expect("requests").push(request);
    }

    /// The requests made so far, in order (bodies streamed by JS are not
    /// kept).
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().expect("requests").clone()
    }
}

impl Network for RecordingNetwork {
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask> {
        self.requests
            .lock()
            .expect("requests")
            .push(request.clone());
        self.inner.fetch(request, events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fetch(network: &StubNetwork, request: HttpRequest) -> Vec<FetchEvent> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let mut task = network.fetch(request, Box::new(move |e| sink.lock().unwrap().push(e)));
        task.finish();
        events.lock().unwrap().clone()
    }

    #[test]
    fn listed_requests_are_answered_and_others_fail() {
        let network = StubNetwork::new([
            (
                "https://api.test/todos".to_owned(),
                StubResponse {
                    status: 200,
                    headers: vec![("content-type".into(), "application/json".into())],
                    body: b"[]".to_vec(),
                    ..Default::default()
                },
            ),
            (
                "post https://api.test/todos".to_owned(),
                StubResponse {
                    status: 201,
                    ..Default::default()
                },
            ),
        ]);
        let events = fetch(&network, HttpRequest::get("https://api.test/todos"));
        assert!(matches!(&events[0], FetchEvent::Head(h) if h.status == 200));
        assert_eq!(events[1], FetchEvent::Data(b"[]".to_vec()));
        assert_eq!(events[2], FetchEvent::End);
        let events = fetch(&network, HttpRequest::post("https://api.test/todos", "x"));
        assert!(matches!(&events[0], FetchEvent::Head(h) if h.status == 201));
        assert_eq!(events[1], FetchEvent::End);
        let events = fetch(&network, HttpRequest::get("https://api.test/todos?all"));
        assert_eq!(
            events,
            [FetchEvent::Failed(
                "GET https://api.test/todos?all: no response is listed for it".into()
            )]
        );
        let mut streamed = HttpRequest::new("POST", "https://api.test/todos");
        streamed.body = HttpBody::Stream;
        let events = fetch(&network, streamed);
        assert_eq!(events[0], FetchEvent::BodyWanted);
        assert!(matches!(&events[1], FetchEvent::Head(h) if h.status == 201));
        assert_eq!(network.requests().len(), 4);
    }

    /// The events a request gets within `wait`.
    fn fetch_within(
        network: &StubNetwork,
        request: HttpRequest,
        wait: Duration,
    ) -> Vec<FetchEvent> {
        let (tx, rx) = std::sync::mpsc::channel();
        let _task = network.fetch(
            request,
            Box::new(move |e| {
                let _ = tx.send(e);
            }),
        );
        let mut events = Vec::new();
        while let Ok(event) = rx.recv_timeout(wait) {
            let end = matches!(event, FetchEvent::End | FetchEvent::Failed(_));
            events.push(event);
            if end {
                break;
            }
        }
        events
    }

    #[test]
    fn routes_answer_by_handler_glob_error_and_delay() {
        let handler: StubHandler = Arc::new(|request: HttpRequest, reply: StubReply| {
            // Answered later, from another thread, as a test's JS handler does.
            std::thread::spawn(move || {
                reply.send(StubResponse {
                    status: 200,
                    body: request.url.into_bytes(),
                    ..Default::default()
                })
            });
        });
        let network = StubNetwork::new([
            (
                "GET https://api.test/todos/*".to_owned(),
                StubRoute::Handler(handler),
            ),
            (
                "GET https://api.test/offline".to_owned(),
                StubRoute::Response(StubResponse {
                    error: Some("the network is down".into()),
                    ..Default::default()
                }),
            ),
            (
                "GET https://api.test/slow".to_owned(),
                StubRoute::Response(StubResponse {
                    status: 204,
                    delay: Duration::from_millis(100),
                    ..Default::default()
                }),
            ),
        ]);
        let wait = Duration::from_secs(2);
        let events = fetch_within(&network, HttpRequest::get("https://api.test/todos/7"), wait);
        assert_eq!(
            events[1],
            FetchEvent::Data(b"https://api.test/todos/7".to_vec())
        );
        assert_eq!(
            fetch_within(&network, HttpRequest::get("https://api.test/offline"), wait),
            [FetchEvent::Failed("the network is down".into())]
        );
        let started = std::time::Instant::now();
        let events = fetch_within(&network, HttpRequest::get("https://api.test/slow"), wait);
        assert!(matches!(&events[0], FetchEvent::Head(h) if h.status == 204));
        assert!(started.elapsed() >= Duration::from_millis(100));
        // The glob does not reach past what it names.
        assert!(matches!(
            &fetch_within(&network, HttpRequest::get("https://api.test/todo"), wait)[0],
            FetchEvent::Failed(_)
        ));
    }
}
