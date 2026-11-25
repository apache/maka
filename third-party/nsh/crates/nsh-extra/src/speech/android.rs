//! Speech recognition on Android: `android.speech.SpeechRecognizer`, the
//! recognition service the device has (Google's on most phones), on the
//! UI thread, where Android wants it made and called. Its listener is a
//! Java proxy of Rust (`nsh::proxy`), and calls reach the UI thread as
//! `Runnable` proxies posted to the main looper.
//!
//! A session asks for `RECORD_AUDIO` first (`nsh::permissions`, which
//! answers at once once the user decided, and refuses while the app is in
//! the background, where Android gives no microphone); a refusal ends it
//! with `not-allowed`. Interim transcripts come as partial results when the
//! request asks for them, the language as `EXTRA_LANGUAGE`. Stopping it is
//! `stopListening` (the service finishes what it heard), aborting it
//! `cancel`. Without a recognition service (some devices, most emulator
//! images without Google's app) [`available`] is false and a session ends
//! with `unavailable`. The manifest needs `RECORD_AUDIO` and the query of
//! recognition services, which the crate's metadata declares.

use std::{
    cell::RefCell,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    task::{Context, Poll, Wake, Waker},
};

use nsh::{
    jni::{
        JNIEnv,
        errors::Result as JniResult,
        objects::{GlobalRef, JObject, JObjectArray, JString, JValue},
    },
    permissions::{self, Permission, PermissionError},
    proxy::{self, Proxy},
};

use super::{Begin, SpeechControl, SpeechError, SpeechRequest, SpeechSink};

const RECORD_AUDIO: &str = "android.permission.RECORD_AUDIO";
const RECOGNITION_LISTENER: &str = "android.speech.RecognitionListener";
const ACTION_RECOGNIZE_SPEECH: &str = "android.speech.action.RECOGNIZE_SPEECH";
const EXTRA_LANGUAGE_MODEL: &str = "android.speech.extra.LANGUAGE_MODEL";
const LANGUAGE_MODEL_FREE_FORM: &str = "free_form";
const EXTRA_LANGUAGE: &str = "android.speech.extra.LANGUAGE";
const EXTRA_PARTIAL_RESULTS: &str = "android.speech.extra.PARTIAL_RESULTS";
/// `SpeechRecognizer.RESULTS_RECOGNITION`.
const RESULTS_RECOGNITION: &str = "results_recognition";

/// How long after a stop a service that never answers still ends the
/// session, in milliseconds.
const STOP_LIMIT_MS: i64 = 3000;

thread_local! {
    /// The session running, on the UI thread.
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// The session running.
struct Session {
    id: u64,
    sink: SpeechSink,
    interim: bool,
    recognizer: GlobalRef,
    /// The recognizer's listener, alive as long as the session.
    _listener: Proxy,
    /// `stop()` came: the service finishes what it heard.
    stopping: bool,
    /// The transcript so far.
    text: String,
}

/// The application `Context`.
fn context() -> JObject<'static> {
    // SAFETY: NSH sets the process's application context, a global
    // reference it never deletes, when the first `NshView` is made, before
    // an app's or a module's code runs.
    unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) }
}

pub(super) async fn available() -> bool {
    nsh::with_env(recognition_available).unwrap_or(false)
}

/// `SpeechRecognizer.isRecognitionAvailable(context)`.
fn recognition_available(env: &mut JNIEnv<'_>) -> JniResult<bool> {
    env.call_static_method(
        "android/speech/SpeechRecognizer",
        "isRecognitionAvailable",
        "(Landroid/content/Context;)Z",
        &[JValue::Object(&context())],
    )?
    .z()
}

pub(super) fn start(request: SpeechRequest, events: SpeechSink) -> Box<dyn SpeechControl> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let control = Control {
        id: NEXT.fetch_add(1, Ordering::Relaxed),
        stop_asked: Arc::default(),
    };
    let (id, stop_asked) = (control.id, control.stop_asked.clone());
    match permissions::state(RECORD_AUDIO) {
        Ok(Permission::Granted) => on_ui(move |env| begin(env, id, request, events, &stop_asked)),
        Ok(Permission::Default) => {
            // The prompt answers later: waited for off the caller's thread.
            let asking = permissions::request(&[RECORD_AUDIO]);
            std::thread::spawn(move || match block_on(asking) {
                Ok(states) if states.first() == Some(&Permission::Granted) => {
                    on_ui(move |env| begin(env, id, request, events, &stop_asked));
                }
                Ok(_) => refused(&events),
                Err(error) => {
                    events.end(Some(permission_error(&error)));
                }
            });
        }
        Ok(Permission::Undeclared) => {
            log::error!(
                "speech recognition needs {RECORD_AUDIO} in the app's manifest: \
                 turn nsh-extra's `speech` feature on through `nsh`, which declares it"
            );
            events.end(Some(SpeechError::NotAllowed));
        }
        Ok(_) => refused(&events),
        Err(error) => {
            events.end(Some(permission_error(&error)));
        }
    }
    Box::new(control)
}

fn refused(events: &SpeechSink) {
    log::info!("speech recognition: the user does not let the app use the microphone");
    events.end(Some(SpeechError::NotAllowed));
}

/// What a permission request that failed means to the session: the app in
/// the background has no microphone.
fn permission_error(error: &PermissionError) -> SpeechError {
    log::warn!("speech recognition: the microphone was not asked for: {error}");
    match error {
        PermissionError::NoActivity(_) => SpeechError::NotAllowed,
        _ => SpeechError::Failed,
    }
}

/// A session as the module controls it, from any thread: each call is
/// taken to the UI thread, after the session's start.
struct Control {
    id: u64,
    /// `stop()` came, maybe before the session started listening.
    stop_asked: Arc<AtomicBool>,
}

impl SpeechControl for Control {
    fn stop(&mut self) {
        self.stop_asked.store(true, Ordering::Release);
        let id = self.id;
        on_ui(move |env| stop(env, id));
    }

    fn abort(&mut self) {
        let id = self.id;
        on_ui(move |env| abort(env, id));
    }
}

/// Starts listening for session `id`. On the UI thread.
fn begin(
    env: &mut JNIEnv<'_>,
    id: u64,
    request: SpeechRequest,
    sink: SpeechSink,
    stop_asked: &AtomicBool,
) {
    // Aborted, replaced or stopped while the user was asked: decided before
    // the session running is touched, which a stale start must not end.
    match super::begin_as(&sink, stop_asked.load(Ordering::Acquire)) {
        Begin::Skip => return,
        Begin::End => {
            sink.end(None);
            return;
        }
        Begin::Listen => {}
    }
    // The module ended the one running before it started this one; one
    // left here ends now all the same: the microphone is one.
    if let Some(running) = SESSION.with(|s| s.borrow().as_ref().map(|s| s.id)) {
        finish(env, running, None);
    }
    match open(env, id, &request) {
        Ok(Some((recognizer, listener))) => SESSION.with(|s| {
            *s.borrow_mut() = Some(Session {
                id,
                sink,
                interim: request.interim,
                recognizer,
                _listener: listener,
                stopping: false,
                text: String::new(),
            })
        }),
        Ok(None) => {
            sink.end(Some(SpeechError::Unavailable));
        }
        Err(error) => {
            log::warn!("speech recognition cannot start: {error}");
            sink.end(Some(SpeechError::Failed));
        }
    }
}

/// A recognizer listening for session `id`, and its listener; `None`
/// without a recognition service.
fn open(
    env: &mut JNIEnv<'_>,
    id: u64,
    request: &SpeechRequest,
) -> JniResult<Option<(GlobalRef, Proxy)>> {
    if !recognition_available(env)? {
        return Ok(None);
    }
    let recognizer = env
        .call_static_method(
            "android/speech/SpeechRecognizer",
            "createSpeechRecognizer",
            "(Landroid/content/Context;)Landroid/speech/SpeechRecognizer;",
            &[JValue::Object(&context())],
        )?
        .l()?;
    if recognizer.is_null() {
        return Ok(None);
    }
    let recognizer = env.new_global_ref(recognizer)?;
    let listener = proxy::implement(env, &[RECOGNITION_LISTENER], move |env, method, args| {
        heard(env, id, method, args)?;
        Ok(None)
    })?;
    env.call_method(
        &recognizer,
        "setRecognitionListener",
        "(Landroid/speech/RecognitionListener;)V",
        &[JValue::Object(listener.as_obj())],
    )?;
    let intent = intent(env, request)?;
    env.call_method(
        &recognizer,
        "startListening",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )?;
    Ok(Some((recognizer, listener)))
}

/// The recognition intent of `request`: free-form dictation, in its
/// language, with partial results when it asks for them.
fn intent<'local>(env: &mut JNIEnv<'local>, request: &SpeechRequest) -> JniResult<JObject<'local>> {
    let action = env.new_string(ACTION_RECOGNIZE_SPEECH)?;
    let intent = env.new_object(
        "android/content/Intent",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&action)],
    )?;
    let put_string = |env: &mut JNIEnv<'local>, key: &str, value: &str| -> JniResult<()> {
        let key = env.new_string(key)?;
        let value = env.new_string(value)?;
        env.call_method(
            &intent,
            "putExtra",
            "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&key), JValue::Object(&value)],
        )?;
        Ok(())
    };
    put_string(env, EXTRA_LANGUAGE_MODEL, LANGUAGE_MODEL_FREE_FORM)?;
    if let Some(lang) = &request.lang {
        put_string(env, EXTRA_LANGUAGE, lang)?;
    }
    let partial = env.new_string(EXTRA_PARTIAL_RESULTS)?;
    env.call_method(
        &intent,
        "putExtra",
        "(Ljava/lang/String;Z)Landroid/content/Intent;",
        &[
            JValue::Object(&partial),
            JValue::Bool(request.interim.into()),
        ],
    )?;
    Ok(intent)
}

/// The listener's `method` with `args` for session `id`. On the UI thread.
fn heard(env: &mut JNIEnv<'_>, id: u64, method: &str, args: &JObjectArray<'_>) -> JniResult<()> {
    let Some(sink) = SESSION.with(|s| {
        s.borrow()
            .as_ref()
            .filter(|s| s.id == id)
            .map(|s| s.sink.clone())
    }) else {
        return Ok(());
    };
    match method {
        "onReadyForSpeech" => {
            sink.start();
        }
        "onPartialResults" => {
            let interim = SESSION.with(|s| s.borrow().as_ref().is_some_and(|s| s.interim));
            if let Some(text) = transcript(env, args)?.filter(|t| !t.is_empty())
                && interim
            {
                remember(id, &text);
                sink.result(text, false);
            }
        }
        "onResults" => {
            let text = match transcript(env, args)? {
                Some(text) => text,
                None => SESSION
                    .with(|s| s.borrow().as_ref().map(|s| s.text.clone()))
                    .unwrap_or_default(),
            };
            if text.is_empty() {
                finish(env, id, Some(SpeechError::NoSpeech));
            } else {
                sink.result(text, true);
                finish(env, id, None);
            }
        }
        "onError" => {
            let code = match env.get_object_array_element(args, 0) {
                Ok(code) if !code.is_null() => {
                    env.call_method(&code, "intValue", "()I", &[])?.i()?
                }
                _ => 0,
            };
            let (stopping, text) = SESSION
                .with(|s| s.borrow().as_ref().map(|s| (s.stopping, s.text.clone())))
                .unwrap_or_default();
            log::debug!("speech recognition ended: error {code}");
            let error = speech_error(code, stopping, !text.is_empty());
            // A stop that heard something ends with it, final.
            if error.is_none() && !text.is_empty() {
                sink.result(text, true);
            }
            finish(env, id, error);
        }
        // `onBeginningOfSpeech`, `onRmsChanged`, `onBufferReceived`,
        // `onEndOfSpeech`, `onEvent`, the language detection callbacks:
        // nothing the app is told.
        _ => {}
    }
    Ok(())
}

/// The best transcript of the `Bundle` that is `args`' first, if any.
fn transcript(env: &mut JNIEnv<'_>, args: &JObjectArray<'_>) -> JniResult<Option<String>> {
    if args.is_null() {
        return Ok(None);
    }
    let bundle = env.get_object_array_element(args, 0)?;
    if bundle.is_null() {
        return Ok(None);
    }
    let key = env.new_string(RESULTS_RECOGNITION)?;
    let list = env
        .call_method(
            &bundle,
            "getStringArrayList",
            "(Ljava/lang/String;)Ljava/util/ArrayList;",
            &[JValue::Object(&key)],
        )?
        .l()?;
    if list.is_null() || env.call_method(&list, "size", "()I", &[])?.i()? == 0 {
        return Ok(None);
    }
    let best = env
        .call_method(&list, "get", "(I)Ljava/lang/Object;", &[JValue::Int(0)])?
        .l()?;
    if best.is_null() {
        return Ok(None);
    }
    Ok(Some(env.get_string(&JString::from(best))?.into()))
}

/// Keeps `text` as session `id`'s transcript so far.
fn remember(id: u64, text: &str) {
    SESSION.with(|s| {
        if let Some(session) = s.borrow_mut().as_mut().filter(|s| s.id == id) {
            session.text = text.to_owned();
        }
    });
}

/// What `SpeechRecognizer`'s error `code` means to the app; `None` for the
/// end of a stop (`stopping`) that `heard` something.
fn speech_error(code: i32, stopping: bool, heard: bool) -> Option<SpeechError> {
    match code {
        // ERROR_SPEECH_TIMEOUT, ERROR_NO_MATCH, and ERROR_CLIENT, which some
        // services answer a stop with.
        5..=7 if stopping && heard => None,
        6 | 7 => Some(SpeechError::NoSpeech),
        // ERROR_NETWORK_TIMEOUT, ERROR_NETWORK, ERROR_SERVER,
        // ERROR_SERVER_DISCONNECTED.
        1 | 2 | 4 | 11 => Some(SpeechError::Network),
        // ERROR_AUDIO.
        3 => Some(SpeechError::AudioCapture),
        // ERROR_INSUFFICIENT_PERMISSIONS.
        9 => Some(SpeechError::NotAllowed),
        // ERROR_RECOGNIZER_BUSY, ERROR_TOO_MANY_REQUESTS.
        8 | 10 => Some(SpeechError::Unavailable),
        // ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE.
        12 | 13 => Some(SpeechError::LanguageNotSupported),
        _ if stopping => None,
        _ => Some(SpeechError::Failed),
    }
}

/// Stops listening to session `id`: the service finishes what it heard.
/// On the UI thread.
fn stop(env: &mut JNIEnv<'_>, id: u64) {
    let recognizer = SESSION.with(|s| {
        let mut s = s.borrow_mut();
        let session = s.as_mut().filter(|s| s.id == id)?;
        session.stopping = true;
        Some(session.recognizer.clone())
    });
    let Some(recognizer) = recognizer else {
        return;
    };
    if let Err(error) = env.call_method(&recognizer, "stopListening", "()V", &[]) {
        log::warn!("speech recognition cannot stop: {error}");
        let _ = env.exception_clear();
    }
    // A service that never answers still ends the session.
    on_ui_after(STOP_LIMIT_MS, move |env| {
        let text = SESSION.with(|s| {
            s.borrow()
                .as_ref()
                .filter(|s| s.id == id)
                .map(|s| (s.text.clone(), s.sink.clone()))
        });
        if let Some((text, sink)) = text {
            if !text.is_empty() {
                sink.result(text, true);
            }
            finish(env, id, None);
        }
    });
}

/// Ends session `id` at once; the module already ended its sink. On the
/// UI thread.
fn abort(env: &mut JNIEnv<'_>, id: u64) {
    if let Some(session) = take(id) {
        close(env, &session, "cancel");
    }
}

/// Ends session `id`, reporting its end (with `error`). On the UI thread.
fn finish(env: &mut JNIEnv<'_>, id: u64, error: Option<SpeechError>) {
    if let Some(session) = take(id) {
        close(env, &session, "stopListening");
        session.sink.end(error);
    }
}

fn take(id: u64) -> Option<Session> {
    SESSION.with(|s| {
        let mut s = s.borrow_mut();
        if s.as_ref().is_some_and(|s| s.id == id) {
            s.take()
        } else {
            None
        }
    })
}

/// Ends `session`'s recognition with `how` (`cancel`, `stopListening`) and
/// releases its recognizer.
fn close(env: &mut JNIEnv<'_>, session: &Session, how: &str) {
    let closed = env
        .call_method(&session.recognizer, how, "()V", &[])
        .and_then(|_| env.call_method(&session.recognizer, "destroy", "()V", &[]));
    if let Err(error) = closed {
        log::warn!("speech recognition: the recognizer did not close: {error}");
        let _ = env.exception_clear();
    }
}

/// Runs `f` on the UI thread, after what was posted there before.
fn on_ui(f: impl FnOnce(&mut JNIEnv<'_>) + Send + 'static) {
    on_ui_after(0, f);
}

/// Runs `f` on the UI thread `ms` milliseconds from now: a `Runnable`
/// proxy posted to the main looper, which keeps itself until it runs.
fn on_ui_after(ms: i64, f: impl FnOnce(&mut JNIEnv<'_>) + Send + 'static) {
    let posted = nsh::with_env(|env| {
        let task = Arc::new(Mutex::new(Some(f)));
        let keep: Arc<Mutex<Option<Proxy>>> = Arc::default();
        let kept = keep.clone();
        let runnable = proxy::implement(env, &["java.lang.Runnable"], move |env, _, _| {
            let f = task.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(f) = f {
                f(env);
            }
            // Ran: the proxy goes.
            kept.lock().unwrap_or_else(|e| e.into_inner()).take();
            Ok(None)
        })?;
        let looper = env
            .call_static_method(
                "android/os/Looper",
                "getMainLooper",
                "()Landroid/os/Looper;",
                &[],
            )?
            .l()?;
        let handler = env.new_object(
            "android/os/Handler",
            "(Landroid/os/Looper;)V",
            &[JValue::Object(&looper)],
        )?;
        // Kept before it is posted: it may run at once on the UI thread.
        let object = env.new_local_ref(runnable.as_obj())?;
        *keep.lock().unwrap_or_else(|e| e.into_inner()) = Some(runnable);
        let posted = env
            .call_method(
                &handler,
                "postDelayed",
                "(Ljava/lang/Runnable;J)Z",
                &[JValue::Object(&object), JValue::Long(ms)],
            )
            .and_then(|posted| posted.z());
        if !matches!(posted, Ok(true)) {
            // Never runs: nothing keeps it.
            keep.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
        posted
    });
    if !matches!(posted, Ok(true)) {
        log::error!("speech recognition: nothing could be posted to the UI thread");
    }
}

/// Runs `future` to its end on this thread: the permission prompt's
/// answer, on a thread of its own.
fn block_on<T>(future: impl Future<Output = T>) -> T {
    struct Unpark(std::thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors() {
        assert_eq!(speech_error(7, false, false), Some(SpeechError::NoSpeech));
        assert_eq!(speech_error(7, true, true), None);
        assert_eq!(speech_error(7, true, false), Some(SpeechError::NoSpeech));
        assert_eq!(speech_error(2, false, true), Some(SpeechError::Network));
        assert_eq!(speech_error(9, false, false), Some(SpeechError::NotAllowed));
        assert_eq!(
            speech_error(12, false, false),
            Some(SpeechError::LanguageNotSupported)
        );
        assert_eq!(speech_error(99, false, false), Some(SpeechError::Failed));
        assert_eq!(speech_error(99, true, false), None);
    }
}
