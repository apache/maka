use std::{
    future::Future,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU32, Ordering},
    },
    task::{Context, Wake, Waker},
};

use nsh_core::{
    JsonValue,
    access::{Access, Capabilities},
    fake::Fake,
};

use super::*;

/// The backend and the session are process-wide: the tests that use them
/// take turns.
static SESSION_TESTS: Mutex<()> = Mutex::new(());

fn turn() -> MutexGuard<'static, ()> {
    SESSION_TESTS.lock().unwrap_or_else(|e| e.into_inner())
}

struct Count(AtomicU32);

impl Wake for Count {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// The events `recognition` reported so far, without waiting.
fn events(recognition: &mut SpeechRecognition) -> Vec<SpeechEvent> {
    let mut cx = Context::from_waker(Waker::noop());
    let mut out = Vec::new();
    while let Poll::Ready(Some(event)) = recognition.poll_next(&mut cx) {
        out.push(event);
    }
    out
}

fn result(text: &str, is_final: bool) -> SpeechEvent {
    SpeechEvent::Result {
        text: text.into(),
        is_final,
    }
}

fn end(error: Option<SpeechError>) -> SpeechEvent {
    SpeechEvent::End { error }
}

#[test]
fn errors_are_named_as_the_web_speech_api_names_them() {
    for &error in SpeechError::ALL {
        assert_eq!(SpeechError::from_name(error.as_str()), Some(error));
    }
    assert_eq!(SpeechError::NotAllowed.as_str(), "not-allowed");
    assert_eq!(SpeechError::from_name("aborted"), None);
}

/// The web's errors keep the browser's names; `aborted` and the end of a
/// stop that heard something are no failure.
#[test]
fn web_errors_are_the_browsers() {
    use super::web::speech_error;
    for &error in SpeechError::ALL {
        assert_eq!(speech_error(error.as_str(), false, false), Some(error));
    }
    assert_eq!(speech_error("aborted", false, true), None);
    assert_eq!(
        speech_error("service-not-allowed", false, false),
        Some(SpeechError::NotAllowed)
    );
    assert_eq!(
        speech_error("no-speech", false, true),
        Some(SpeechError::NoSpeech)
    );
    assert_eq!(
        speech_error("no-speech", true, false),
        Some(SpeechError::NoSpeech)
    );
    assert_eq!(speech_error("no-speech", true, true), None);
    assert_eq!(
        speech_error("network", true, true),
        Some(SpeechError::Network)
    );
    assert_eq!(
        speech_error("bad-grammar", false, false),
        Some(SpeechError::Failed)
    );
    assert_eq!(speech_error("bad-grammar", true, false), None);
}

/// A web session's transcript is its results' in order, final and interim.
#[test]
fn web_transcripts_join_the_results() {
    use super::web::transcript;
    assert_eq!(transcript(Vec::<String>::new()), "");
    assert_eq!(
        transcript(["hello", " world", " how ar"]),
        "hello world how ar"
    );
    assert_eq!(transcript(["你好", "世界"]), "你好世界");
    assert_eq!(transcript([" hello ", ""]), "hello");
}

/// Events come in order, wake the receiver, and stop at the end.
#[test]
fn nothing_comes_after_the_end() {
    let (sink, mut events) = channel();
    let count = Arc::new(Count(AtomicU32::new(0)));
    let waker = Waker::from(count.clone());
    let mut cx = Context::from_waker(&waker);
    assert_eq!(events.poll_next(&mut cx), Poll::Pending);
    // From another thread, as a recognizer reports.
    let from = sink.clone();
    std::thread::spawn(move || from.start()).join().unwrap();
    assert_eq!(count.0.load(Ordering::SeqCst), 1);
    assert!(sink.result("hel", false));
    assert!(sink.clone().end(Some(SpeechError::NoSpeech)));
    assert!(sink.is_ended());
    assert!(!sink.result("hello", true));
    assert!(!sink.end(None));
    assert_eq!(
        events.poll_next(&mut cx),
        Poll::Ready(Some(SpeechEvent::Start))
    );
    assert_eq!(
        events.poll_next(&mut cx),
        Poll::Ready(Some(result("hel", false)))
    );
    assert_eq!(
        events.poll_next(&mut cx),
        Poll::Ready(Some(end(Some(SpeechError::NoSpeech))))
    );
    assert_eq!(events.poll_next(&mut cx), Poll::Ready(None));
}

#[test]
fn options_make_requests() {
    let request = SpeechOptions {
        lang: Some("zh-CN".into()),
        interim: Some(false),
    }
    .request()
    .unwrap();
    assert_eq!(request.lang.as_deref(), Some("zh-CN"));
    assert!(!request.interim);
    assert_eq!(
        SpeechOptions::default().request().unwrap(),
        SpeechRequest::default()
    );
    assert!(SpeechRequest::default().interim);
    for lang in ["", "en US", "en--US", "-en", "e\u{301}n"] {
        let options = SpeechOptions {
            lang: Some(lang.into()),
            interim: None,
        };
        assert!(
            matches!(options.request(), Err(JsError::Range(_))),
            "{lang:?}"
        );
    }
}

/// Recognizes "a b" as the user speaks; stopping it gives "a b c".
#[derive(Default)]
struct TestSpeech {
    stopped: Arc<AtomicU32>,
    aborted: Arc<AtomicU32>,
    asked: Mutex<Vec<SpeechRequest>>,
}

struct TestSession {
    sink: SpeechSink,
    stopped: Arc<AtomicU32>,
    aborted: Arc<AtomicU32>,
}

impl SpeechControl for TestSession {
    fn stop(&mut self) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
        self.sink.result("a b c", true);
        self.sink.end(None);
    }

    fn abort(&mut self) {
        self.aborted.fetch_add(1, Ordering::SeqCst);
    }
}

impl SpeechBackend for TestSpeech {
    fn start(&self, request: SpeechRequest, sink: SpeechSink) -> Box<dyn SpeechControl> {
        self.asked.lock().unwrap().push(request);
        sink.start();
        sink.result("a b", false);
        Box::new(TestSession {
            sink,
            stopped: self.stopped.clone(),
            aborted: self.aborted.clone(),
        })
    }
}

/// Installs a fresh [`TestSpeech`] as the backend.
fn test_backend() -> Arc<TestSpeech> {
    let backend = Arc::new(TestSpeech::default());
    set_backend(Some(backend.clone()));
    backend
}

#[test]
fn a_backend_runs_sessions_in_place_of_the_platform() {
    let _turn = turn();
    let backend = test_backend();
    let mut recognition = recognize(SpeechRequest {
        lang: Some("en-US".into()),
        ..Default::default()
    });
    assert_eq!(
        events(&mut recognition),
        [SpeechEvent::Start, result("a b", false)]
    );
    assert_eq!(
        backend.asked.lock().unwrap()[0].lang.as_deref(),
        Some("en-US")
    );
    recognition.stop();
    assert_eq!(backend.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(events(&mut recognition), [result("a b c", true), end(None)]);
    // Ended: stopping or dropping it reaches the recognizer no more.
    recognition.stop();
    drop(recognition);
    assert_eq!(backend.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(backend.aborted.load(Ordering::SeqCst), 0);
    set_backend(None);
}

#[test]
fn a_new_session_ends_the_one_running() {
    let _turn = turn();
    let backend = test_backend();
    let mut first = recognize(SpeechRequest::default());
    let mut second = recognize(SpeechRequest::default());
    // The first one ended without an error, its recognizer told.
    assert_eq!(
        events(&mut first),
        [SpeechEvent::Start, result("a b", false), end(None)]
    );
    assert_eq!(backend.aborted.load(Ordering::SeqCst), 1);
    // Its stop reaches nothing: the second session runs.
    first.stop();
    assert_eq!(backend.stopped.load(Ordering::SeqCst), 0);
    assert_eq!(
        events(&mut second),
        [SpeechEvent::Start, result("a b", false)]
    );
    second.stop();
    assert_eq!(backend.stopped.load(Ordering::SeqCst), 1);
    set_backend(None);
}

/// Another engine (another app or `AppView`) taking the microphone ends
/// the session running with `audio-capture`; its own engine, without.
#[test]
fn another_engines_session_ends_the_one_running_with_audio_capture() {
    let _turn = turn();
    let backend = test_backend();
    let (app_a, app_b) = (
        nsh_core::element::Runtime::default(),
        nsh_core::element::Runtime::default(),
    );
    let mut first = {
        let _entered = app_a.enter();
        recognize(SpeechRequest::default())
    };
    let mut second = {
        let _entered = app_b.enter();
        recognize(SpeechRequest::default())
    };
    assert_eq!(
        events(&mut first),
        [
            SpeechEvent::Start,
            result("a b", false),
            end(Some(SpeechError::AudioCapture))
        ]
    );
    assert_eq!(backend.aborted.load(Ordering::SeqCst), 1);
    // App B replacing its own session: no error.
    let third = {
        let _entered = app_b.enter();
        recognize(SpeechRequest::default())
    };
    assert_eq!(
        events(&mut second),
        [SpeechEvent::Start, result("a b", false), end(None)]
    );
    drop(third);
    set_backend(None);
}

/// A start that reaches the recognizer's thread after its session ended
/// leaves the session running alone.
#[test]
fn a_stale_start_changes_nothing() {
    let (sink, _events) = channel();
    assert_eq!(begin_as(&sink, false), Begin::Listen);
    assert_eq!(begin_as(&sink, true), Begin::End);
    sink.end(None);
    assert_eq!(begin_as(&sink, false), Begin::Skip);
    assert_eq!(begin_as(&sink, true), Begin::Skip);
}

#[test]
fn aborting_or_dropping_a_session_ends_it_at_once() {
    let _turn = turn();
    let backend = test_backend();
    let mut recognition = recognize(SpeechRequest::default());
    recognition.abort();
    assert_eq!(backend.aborted.load(Ordering::SeqCst), 1);
    assert_eq!(
        events(&mut recognition),
        [SpeechEvent::Start, result("a b", false), end(None)]
    );
    let dropped = recognize(SpeechRequest::default());
    drop(dropped);
    assert_eq!(backend.aborted.load(Ordering::SeqCst), 2);
    // Nothing runs any more: a later abort tells no one.
    recognition.abort();
    assert_eq!(backend.aborted.load(Ordering::SeqCst), 2);
    assert!(running().is_none());
    set_backend(None);
}

#[test]
fn availability_is_the_backends() {
    struct Silent;
    impl SpeechBackend for Silent {
        fn available(&self) -> bool {
            false
        }
        fn start(&self, _: SpeechRequest, events: SpeechSink) -> Box<dyn SpeechControl> {
            events.end(Some(SpeechError::Unavailable));
            Box::new(TestSession {
                sink: events,
                stopped: Arc::default(),
                aborted: Arc::default(),
            })
        }
    }
    let _turn = turn();
    set_backend(Some(Arc::new(Silent)));
    fn ready(future: impl Future<Output = bool>) -> bool {
        let mut future = std::pin::pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(available) => available,
            Poll::Pending => panic!("availability waited"),
        }
    }
    assert!(!ready(available()));
    test_backend();
    assert!(ready(available()));
    set_backend(None);
}

/// Where NSH recognizes no speech, without a backend.
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "android",
    target_os = "windows",
    target_arch = "wasm32"
)))]
#[test]
fn sessions_end_unavailable_where_nothing_recognizes_speech() {
    let _turn = turn();
    set_backend(None);
    let mut recognition = recognize(SpeechRequest::default());
    assert_eq!(
        events(&mut recognition),
        [end(Some(SpeechError::Unavailable))]
    );
}

#[test]
fn the_js_face_needs_the_capability() {
    let mut sys = System::default();
    assert!(granted(&sys).is_ok(), "an app without capabilities has all");
    sys.access = Arc::new(Access {
        declared: Capabilities::from_json(&serde_json::json!({})).unwrap(),
        granted: None,
    });
    let error = granted(&sys).unwrap_err();
    assert_eq!(error.code(), Some("ERR_ACCESS_DENIED"));
    sys.access = Arc::new(Access {
        declared: Capabilities::from_json(&serde_json::json!({ "speech": true })).unwrap(),
        granted: None,
    });
    assert!(granted(&sys).is_ok());
    // The embedder's grant limits the declaration.
    sys.access = Arc::new(Access {
        declared: Capabilities::from_json(&serde_json::json!({ "speech": true })).unwrap(),
        granted: Some(Capabilities::from_json(&serde_json::json!({})).unwrap()),
    });
    assert!(granted(&sys).is_err());
}

#[test]
fn the_fake_listens_at_once_and_the_test_speaks() {
    let _turn = turn();
    let fake = FakeSpeech::default();
    fake.install();
    let call = |method: &str, args: &[JsonValue]| fake.call(method, args);
    assert_eq!(
        call("hear", &["hi".into()]).unwrap_err(),
        "no speech session listens"
    );
    let mut recognition = recognize(SpeechRequest {
        lang: Some("zh-CN".into()),
        interim: true,
    });
    assert_eq!(events(&mut recognition), [SpeechEvent::Start]);
    call("hear", &["你好".into()]).unwrap();
    call("hear", &["你好世界".into()]).unwrap();
    assert_eq!(
        events(&mut recognition),
        [result("你好", false), result("你好世界", false)]
    );
    // The app stops: the transcript is final.
    recognition.stop();
    assert_eq!(
        events(&mut recognition),
        [result("你好世界", true), end(None)]
    );
    assert_eq!(
        call("requests", &[]).unwrap(),
        serde_json::json!([{ "lang": "zh-CN", "interim": true }])
    );

    // Nothing heard: no-speech; the test's error: that error.
    let mut silent = recognize(SpeechRequest::default());
    call("end", &[]).unwrap();
    assert_eq!(
        events(&mut silent),
        [SpeechEvent::Start, end(Some(SpeechError::NoSpeech))]
    );
    let mut failing = recognize(SpeechRequest::default());
    call("hear", &["hel".into()]).unwrap();
    call("end", &["network".into()]).unwrap();
    assert_eq!(
        events(&mut failing),
        [
            SpeechEvent::Start,
            result("hel", false),
            end(Some(SpeechError::Network))
        ]
    );
    // Aborted: the fake listens no more.
    let aborted = recognize(SpeechRequest::default());
    aborted.abort();
    assert_eq!(
        call("hear", &["late".into()]).unwrap_err(),
        "no speech session listens"
    );
    assert!(call("end", &["aborted".into()]).is_err());
    assert!(call("shout", &[]).is_err());

    // A new app starts with no requests.
    fake.install();
    assert_eq!(call("requests", &[]).unwrap(), serde_json::json!([]));
    set_backend(None);
}

#[test]
fn the_module_gives_its_fake_to_headless_runs() {
    let fakes = crate::registry().fakes();
    assert!(fakes.iter().any(|(name, _)| *name == fake::NAME));
}
