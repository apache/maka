//! `fetch` on `NSURLSession`: the system's HTTP stack (HTTP/2 and 3, system
//! proxies, cookies, App Transport Security), shared by every surface.
//!
//! Data tasks report to a session delegate: the response head, then the
//! body as it arrives (suspending the task is the back pressure). A
//! streamed request body goes through a bound stream pair: a thread per
//! request writes the chunks JS hands over into the pair's output, which
//! the task reads as its `HTTPBodyStream` (sent chunked).

use std::{
    ptr::NonNull,
    sync::{
        Arc, Mutex, OnceLock,
        mpsc::{Sender, channel},
    },
};

use nsh_engine::{FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead, HttpRequest, Network};
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, ProtocolObject},
};
use objc2_foundation::{
    NSData, NSError, NSHTTPURLResponse, NSInputStream, NSMutableURLRequest, NSObjectProtocol,
    NSOutputStream, NSStream, NSString, NSURL, NSURLRequest, NSURLResponse, NSURLSession,
    NSURLSessionConfiguration, NSURLSessionDataDelegate, NSURLSessionDataTask,
    NSURLSessionDelegate, NSURLSessionResponseDisposition, NSURLSessionTask,
    NSURLSessionTaskDelegate,
};
use rustc_hash::FxHashMap;

/// The process-wide network stack.
pub(crate) fn network() -> Arc<dyn Network> {
    static NETWORK: OnceLock<Arc<UrlSessionNetwork>> = OnceLock::new();
    NETWORK
        .get_or_init(|| Arc::new(UrlSessionNetwork::new()))
        .clone()
}

/// Bytes the bound stream pair buffers between the writer and the task.
const BODY_BUFFER: usize = 64 << 10;

/// What the delegate reports to, by session (`true`: the following one)
/// and task identifier.
type Tasks = Mutex<FxHashMap<(bool, usize), FetchEvents>>;

fn tasks() -> &'static Tasks {
    static TASKS: OnceLock<Tasks> = OnceLock::new();
    TASKS.get_or_init(Tasks::default)
}

/// Reports `event` for the task (dropped when the task is not known: it
/// was cancelled or already completed).
fn report(follow: bool, task: &NSURLSessionTask, event: FetchEvent) {
    let key = (follow, task.taskIdentifier());
    let mut tasks = tasks().lock().expect("tasks");
    let done = matches!(event, FetchEvent::End | FetchEvent::Failed(_));
    if let Some(events) = tasks.get_mut(&key) {
        events(event);
    }
    if done {
        tasks.remove(&key);
    }
}

struct UrlSessionNetwork {
    /// Follows redirects (the default for `fetch`).
    follow: Retained<NSURLSession>,
    /// Stops at redirects (`redirect: "manual"`).
    manual: Retained<NSURLSession>,
}

// SAFETY: NSURLSession is thread-safe (documented); the sessions are never
// mutated after creation.
unsafe impl Send for UrlSessionNetwork {}
// SAFETY: as above.
unsafe impl Sync for UrlSessionNetwork {}

impl UrlSessionNetwork {
    fn new() -> Self {
        let session = |follow| {
            let delegate = Delegate::new(follow);
            // SAFETY: a default configuration (the shared cookie storage
            // and cache, like the shared session) and a delegate; the
            // session keeps the delegate alive and calls it on its own
            // serial queue.
            unsafe {
                NSURLSession::sessionWithConfiguration_delegate_delegateQueue(
                    &NSURLSessionConfiguration::defaultSessionConfiguration(),
                    Some(ProtocolObject::from_ref(&*delegate)),
                    None,
                )
            }
        };
        Self {
            follow: session(true),
            manual: session(false),
        }
    }
}

/// A task handle used from the engine thread.
struct Task {
    task: Retained<NSURLSessionDataTask>,
    key: (bool, usize),
    /// Chunks for the body writer (`None`: the end).
    body: Option<Sender<Option<Vec<u8>>>>,
}

// SAFETY: NSURLSessionTask is thread-safe (`suspend`, `resume`, `cancel`).
unsafe impl Send for Task {}

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
        if paused {
            self.task.suspend();
        } else {
            self.task.resume();
        }
    }

    fn cancel(self: Box<Self>) {
        tasks().lock().expect("tasks").remove(&self.key);
        if let Some(body) = &self.body {
            let _ = body.send(None);
        }
        self.task.cancel();
    }
}

impl Network for UrlSessionNetwork {
    fn fetch(&self, request: HttpRequest, mut events: FetchEvents) -> Box<dyn FetchTask> {
        let Some(url) = NSURL::URLWithString(&NSString::from_str(&request.url)) else {
            events(FetchEvent::Failed(format!("invalid URL `{}`", request.url)));
            return Box::new(Failed);
        };
        let ns = NSMutableURLRequest::requestWithURL(&url);
        ns.setHTTPMethod(&NSString::from_str(&request.method));
        for (name, value) in &request.headers {
            ns.addValue_forHTTPHeaderField(&NSString::from_str(value), &NSString::from_str(name));
        }
        let mut writer = None;
        match &request.body {
            HttpBody::Empty => {}
            HttpBody::Bytes(bytes) => ns.setHTTPBody(Some(&NSData::with_bytes(bytes))),
            HttpBody::Stream => {
                let (mut input, mut output) = (None, None);
                NSStream::getBoundStreamsWithBufferSize_inputStream_outputStream(
                    BODY_BUFFER,
                    Some(&mut input),
                    Some(&mut output),
                );
                let (Some(input), Some(output)) = (input, output) else {
                    events(FetchEvent::Failed("no stream for the request body".into()));
                    return Box::new(Failed);
                };
                ns.setHTTPBodyStream(Some(&input));
                writer = Some(output);
            }
        }
        let follow = request.follow_redirects;
        let session = if follow { &self.follow } else { &self.manual };
        let task = session.dataTaskWithRequest(&ns);
        let key = (follow, task.taskIdentifier());
        let events = Arc::new(Mutex::new(events));
        let reported = events.clone();
        // Registered before the task starts: the delegate may report at once.
        tasks().lock().expect("tasks").insert(
            key,
            Box::new(move |e| (reported.lock().expect("events"))(e)),
        );
        let body = writer.map(|output| {
            let (tx, rx) = channel::<Option<Vec<u8>>>();
            let output = Output(output);
            let events = events.clone();
            std::thread::Builder::new()
                .name("nsh-net-body".into())
                .spawn(move || write_body(&output, &rx, &events))
                .expect("body thread");
            tx
        });
        task.resume();
        Box::new(Task { task, key, body })
    }
}

/// The output of a bound pair, written on the body's thread only.
struct Output(Retained<NSOutputStream>);

// SAFETY: the stream is used by one thread at a time (made on the engine
// thread, then only touched by the body thread).
unsafe impl Send for Output {}

/// Writes the chunks of a streamed body as JS hands them over, asking for
/// each; closes the stream at the end (or when the request is gone).
fn write_body(
    output: &Output,
    chunks: &std::sync::mpsc::Receiver<Option<Vec<u8>>>,
    events: &Mutex<FetchEvents>,
) {
    let stream = &output.0;
    stream.open();
    'chunks: loop {
        (events.lock().expect("events"))(FetchEvent::BodyWanted);
        let Ok(Some(chunk)) = chunks.recv() else {
            break;
        };
        let mut at = 0;
        while at < chunk.len() {
            let rest = &chunk[at..];
            // SAFETY: a valid buffer of `rest.len()` bytes. An unscheduled
            // stream blocks until the task has read enough of the pair.
            let n = unsafe { stream.write_maxLength(NonNull::from(rest).cast::<u8>(), rest.len()) };
            if n <= 0 {
                break 'chunks;
            }
            at += n as usize;
        }
    }
    stream.close();
}

/// The handle of a request that failed before it started.
struct Failed;

impl FetchTask for Failed {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}

/// The head of an HTTP response.
fn head(response: &NSURLResponse, requested: Option<String>) -> Result<HttpHead, String> {
    let Some(http) = response.downcast_ref::<NSHTTPURLResponse>() else {
        return Err("not an HTTP response".to_owned());
    };
    let url = response
        .URL()
        .and_then(|u| u.absoluteString())
        .map(|s| s.to_string())
        .or(requested.clone())
        .unwrap_or_default();
    let (keys, values) = http.allHeaderFields().to_vecs();
    let headers = keys
        .iter()
        .zip(values.iter())
        .filter_map(|(k, v)| {
            let k = k.downcast_ref::<NSString>()?;
            let v = v.downcast_ref::<NSString>()?;
            Some((k.to_string(), v.to_string()))
        })
        .collect();
    Ok(HttpHead {
        status: http.statusCode() as u16,
        // HTTP/2 and 3 have no reason phrases; browsers report "" too.
        status_text: String::new(),
        redirected: requested.is_some_and(|r| r != url),
        url,
        headers,
    })
}

/// The URL the task was made with.
fn requested(task: &NSURLSessionTask) -> Option<String> {
    task.originalRequest()
        .and_then(|r| r.URL())
        .and_then(|u| u.absoluteString())
        .map(|s| s.to_string())
}

/// The delegate's state: which session it serves.
struct DelegateIvars {
    follow: bool,
}

define_class!(
    /// Session delegate: reports heads, body data and completion; refuses
    /// redirects for the manual session (the 3xx response itself is
    /// delivered, `redirect: "manual"`).
    #[unsafe(super(NSObject))]
    #[name = "NshUrlSessionDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl NSURLSessionDelegate for Delegate {}

    unsafe impl NSURLSessionTaskDelegate for Delegate {
        #[unsafe(method(URLSession:task:willPerformHTTPRedirection:newRequest:completionHandler:))]
        fn will_redirect(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            _response: &NSHTTPURLResponse,
            request: &NSURLRequest,
            completion: &block2::DynBlock<dyn Fn(*mut NSURLRequest)>,
        ) {
            let next = if self.ivars().follow {
                request as *const NSURLRequest as *mut NSURLRequest
            } else {
                std::ptr::null_mut()
            };
            completion.call((next,));
        }

        #[unsafe(method(URLSession:task:needNewBodyStream:))]
        fn need_new_body_stream(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            completion: &block2::DynBlock<dyn Fn(*mut NSInputStream)>,
        ) {
            // A streamed body cannot be sent again (after an authentication
            // challenge or a 307 / 308): the task fails.
            completion.call((std::ptr::null_mut(),));
        }

        #[unsafe(method(URLSession:task:didCompleteWithError:))]
        fn did_complete(
            &self,
            _session: &NSURLSession,
            task: &NSURLSessionTask,
            error: Option<&NSError>,
        ) {
            let event = match error {
                Some(e) => FetchEvent::Failed(e.localizedDescription().to_string()),
                None => FetchEvent::End,
            };
            report(self.ivars().follow, task, event);
        }
    }

    unsafe impl NSURLSessionDataDelegate for Delegate {
        #[unsafe(method(URLSession:dataTask:didReceiveResponse:completionHandler:))]
        fn did_receive_response(
            &self,
            _session: &NSURLSession,
            task: &NSURLSessionDataTask,
            response: &NSURLResponse,
            completion: &block2::DynBlock<dyn Fn(NSURLSessionResponseDisposition)>,
        ) {
            match head(response, requested(task)) {
                Ok(head) => {
                    report(self.ivars().follow, task, FetchEvent::Head(head));
                    completion.call((NSURLSessionResponseDisposition::Allow,));
                }
                Err(e) => {
                    report(self.ivars().follow, task, FetchEvent::Failed(e));
                    completion.call((NSURLSessionResponseDisposition::Cancel,));
                }
            }
        }

        #[unsafe(method(URLSession:dataTask:didReceiveData:))]
        fn did_receive_data(
            &self,
            _session: &NSURLSession,
            task: &NSURLSessionDataTask,
            data: &NSData,
        ) {
            report(self.ivars().follow, task, FetchEvent::Data(data.to_vec()));
        }
    }
);

impl Delegate {
    fn new(follow: bool) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { follow });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}
