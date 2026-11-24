//! Speech recognition on Apple platforms (`Command::Speech`, `nsh`'s
//! `Speech`): the Speech framework's `SFSpeechRecognizer` fed by the
//! microphone through an `AVAudioEngine` tap. Shared by macOS and iOS (the
//! iOS crate includes this file): the frameworks are loaded and messaged
//! dynamically, as the rest of these crates do with optional frameworks.
//!
//! A session asks for speech recognition, then for the microphone (the
//! system's prompts, the first time; the app's `Info.plist` must explain
//! both: `NSSpeechRecognitionUsageDescription` and
//! `NSMicrophoneUsageDescription`, which `nsh package` writes for apps
//! granted `speech`), listens, and reports to the root as
//! [`EventKind::Speech`] events. One session runs at a time, on the main
//! thread: the microphone is one.
//!
//! Several surfaces, each with its own engine, can run in one process, and
//! session ids are each engine's. A session belongs to its engine's
//! [`Listener`]: commands act only on their own engine's session, a start
//! ends another engine's session and reports its end to that engine, and a
//! surface that stops ends its session (the microphone goes off).

use std::{
    cell::RefCell,
    ffi::CStr,
    ptr,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    speech::{SpeechCommand, SpeechError, SpeechEvent, SpeechRequest},
};
use nsh_engine::EngineControl;
use objc2::{
    msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_foundation::NSString;

/// The usage descriptions the system requires before it asks the user.
const USAGE_KEYS: [&str; 2] = [
    "NSSpeechRecognitionUsageDescription",
    "NSMicrophoneUsageDescription",
];

/// `SFSpeechRecognizerAuthorizationStatusAuthorized`.
const AUTHORIZED: isize = 3;

thread_local! {
    /// The session running, on the main thread.
    static SESSION: RefCell<Sessions<Session>> = const { RefCell::new(Sessions::new()) };
}

/// Which [`Listener`], so which engine, a session belongs to.
type Owner = u64;

/// One engine's speech recognition, kept by its surface: its session ends
/// when [`Self::end`] is called or it is dropped, as the surface stops (the
/// core's abort cannot reach the platform once the engine is gone).
pub struct Listener {
    owner: Owner,
}

impl Default for Listener {
    fn default() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Listener {
            owner: NEXT.fetch_add(1, Ordering::Relaxed),
        }
    }
}

impl Listener {
    /// Ends this engine's session, if one runs, without reporting it: the
    /// engine is stopping. On the main thread.
    pub fn end(&self) {
        // The thread's storage may be gone when a surface is dropped late.
        let running = SESSION
            .try_with(|s| s.borrow_mut().take_owner(self.owner))
            .ok()
            .flatten();
        if let Some(running) = running {
            close(running.session);
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.end();
    }
}

/// The session running in the process and whose it is. Only bookkeeping:
/// closing and reporting what it returns is the caller's.
struct Sessions<S> {
    running: Option<Running<S>>,
    /// The next session's token.
    next: u64,
}

/// A session and what identifies it.
struct Running<S> {
    owner: Owner,
    /// The id its engine gave it, which its commands and events carry.
    id: u32,
    /// Unique in the process: the recognizer's callbacks and timers find
    /// their session by it, never one started after.
    token: u64,
    session: S,
}

/// A session a start ended to make room for another.
struct Displaced<S> {
    running: Running<S>,
    /// It is another engine's, which nothing told: its end is reported to
    /// it. The starting engine's own session was already ended by its core.
    report: bool,
}

impl<S> Sessions<S> {
    const fn new() -> Self {
        Sessions {
            running: None,
            next: 1,
        }
    }

    /// Ends the session running, if any, for one of `owner`'s to start.
    fn displace(&mut self, owner: Owner) -> Option<Displaced<S>> {
        self.running.take().map(|running| Displaced {
            report: running.owner != owner,
            running,
        })
    }

    /// Runs `owner`'s session `id`, returning its token. The one running
    /// was displaced first.
    fn insert(&mut self, owner: Owner, id: u32, session: S) -> u64 {
        debug_assert!(self.running.is_none());
        let token = self.next;
        self.next += 1;
        self.running = Some(Running {
            owner,
            id,
            token,
            session,
        });
        token
    }

    /// `owner`'s session `id`, if it runs.
    fn find(&mut self, owner: Owner, id: u32) -> Option<&mut Running<S>> {
        self.running
            .as_mut()
            .filter(|r| r.owner == owner && r.id == id)
    }

    /// Ends `owner`'s session `id`, if it runs.
    fn take(&mut self, owner: Owner, id: u32) -> Option<Running<S>> {
        self.find(owner, id)?;
        self.running.take()
    }

    /// The session of `token`, if it still runs.
    fn by_token(&mut self, token: u64) -> Option<&mut Running<S>> {
        self.running.as_mut().filter(|r| r.token == token)
    }

    /// Ends the session of `token`, if it still runs.
    fn take_token(&mut self, token: u64) -> Option<Running<S>> {
        self.by_token(token)?;
        self.running.take()
    }

    /// Ends `owner`'s session, whichever runs.
    fn take_owner(&mut self, owner: Owner) -> Option<Running<S>> {
        self.running.as_ref().filter(|r| r.owner == owner)?;
        self.running.take()
    }
}

/// The session running.
struct Session {
    request: SpeechRequest,
    control: EngineControl,
    /// Set once it listens; `None` while the user is asked.
    audio: Option<Audio>,
    /// `stop()` came: the recognizer finishes what it heard.
    stopping: bool,
    /// The transcript so far.
    text: String,
}

/// What a listening session holds.
struct Audio {
    engine: Retained<AnyObject>,
    input: Retained<AnyObject>,
    request: Retained<AnyObject>,
    task: Option<Retained<AnyObject>>,
    /// Keeps the recognizer while its task runs.
    _recognizer: Retained<AnyObject>,
}

/// Applies `command` of the engine `listener` belongs to, reporting
/// through `control`. On the main thread.
pub fn command(listener: &Listener, control: &EngineControl, command: &SpeechCommand) {
    let owner = listener.owner;
    match command {
        SpeechCommand::Start { id, request } => start(owner, control, *id, request.clone()),
        SpeechCommand::Stop { id } => stop(owner, *id),
        SpeechCommand::Abort { id } => abort(owner, *id),
        _ => {}
    }
}

fn report(control: &EngineControl, id: u32, event: SpeechEvent) {
    control.dispatch_event(
        ROOT_ID,
        EventKind::Speech,
        EventPayload::Speech { id, event },
    );
}

fn start(owner: Owner, control: &EngineControl, id: u32, request: SpeechRequest) {
    // The microphone is one: the session running ends first.
    if let Some(displaced) = SESSION.with(|s| s.borrow_mut().displace(owner)) {
        let Running {
            id: displaced_id,
            session,
            ..
        } = displaced.running;
        let displaced_control = session.control.clone();
        close(session);
        // Another engine's session lost the microphone.
        if displaced.report {
            report(
                &displaced_control,
                displaced_id,
                SpeechEvent::End {
                    error: Some(SpeechError::AudioCapture),
                },
            );
        }
    }
    if !frameworks() {
        report(
            control,
            id,
            SpeechEvent::End {
                error: Some(SpeechError::Unavailable),
            },
        );
        return;
    }
    if !usage_described() {
        log::error!(
            "speech recognition needs NSSpeechRecognitionUsageDescription and \
             NSMicrophoneUsageDescription in the app's Info.plist"
        );
        report(
            control,
            id,
            SpeechEvent::End {
                error: Some(SpeechError::NotAllowed),
            },
        );
        return;
    }
    let token = SESSION.with(|s| {
        s.borrow_mut().insert(
            owner,
            id,
            Session {
                request,
                control: control.clone(),
                audio: None,
                stopping: false,
                text: String::new(),
            },
        )
    });
    let Some(recognizer) = AnyClass::get(c"SFSpeechRecognizer") else {
        finish(token, Some(SpeechError::Unavailable));
        return;
    };
    // The handler runs on a queue of the framework's.
    let handler = RcBlock::new(move |status: isize| {
        main(move || {
            if status != AUTHORIZED {
                finish(token, Some(SpeechError::NotAllowed));
                return;
            }
            ask_microphone(token);
        });
    });
    // SAFETY: Speech's documented class method (iOS 10, macOS 10.15),
    // taking a block of the authorization status (an NSInteger).
    unsafe {
        let _: () = msg_send![recognizer, requestAuthorization: &*handler];
    }
}

/// Asks for the microphone, then listens.
fn ask_microphone(token: u64) {
    if !running(token) {
        return;
    }
    let Some(device) = AnyClass::get(c"AVCaptureDevice") else {
        finish(token, Some(SpeechError::AudioCapture));
        return;
    };
    let handler = RcBlock::new(move |granted: Bool| {
        let granted = granted.as_bool();
        main(move || {
            if granted {
                listen(token);
            } else {
                finish(token, Some(SpeechError::NotAllowed));
            }
        });
    });
    // `AVMediaTypeAudio`'s value.
    let audio = NSString::from_str("soun");
    // SAFETY: AVFoundation's documented class method, taking a media type
    // and a block of whether the user granted it.
    unsafe {
        let _: () = msg_send![
            device,
            requestAccessForMediaType: &*audio,
            completionHandler: &*handler
        ];
    }
}

/// Starts the microphone and the recognizer for the session of `token`.
fn listen(token: u64) {
    let Some((id, request, control, stopping)) = SESSION.with(|s| {
        s.borrow_mut().by_token(token).map(|r| {
            let s = &r.session;
            (r.id, s.request.clone(), s.control.clone(), s.stopping)
        })
    }) else {
        return;
    };
    if stopping {
        finish(token, None);
        return;
    }
    match open(token, &request) {
        Ok(audio) => {
            SESSION.with(|s| {
                if let Some(running) = s.borrow_mut().by_token(token) {
                    running.session.audio = Some(audio);
                }
            });
            report(&control, id, SpeechEvent::Start);
        }
        Err(error) => finish(token, Some(error)),
    }
}

/// The recognizer and the microphone listening for the session of `token`.
fn open(token: u64, request: &SpeechRequest) -> Result<Audio, SpeechError> {
    let (Some(recognizer_class), Some(request_class), Some(engine_class), Some(queue_class)) = (
        AnyClass::get(c"SFSpeechRecognizer"),
        AnyClass::get(c"SFSpeechAudioBufferRecognitionRequest"),
        AnyClass::get(c"AVAudioEngine"),
        AnyClass::get(c"NSOperationQueue"),
    ) else {
        return Err(SpeechError::Unavailable);
    };
    // SAFETY: the Speech and AVFoundation documented API, sent dynamically
    // on the main thread; every object is checked before it is used.
    unsafe {
        let alloc: Allocated<AnyObject> = msg_send![recognizer_class, alloc];
        let recognizer: Option<Retained<AnyObject>> = match &request.lang {
            Some(lang) => {
                let locale_class = AnyClass::get(c"NSLocale").ok_or(SpeechError::Failed)?;
                let tag = NSString::from_str(lang);
                let locale: Retained<AnyObject> =
                    msg_send![locale_class, localeWithLocaleIdentifier: &*tag];
                msg_send![alloc, initWithLocale: &*locale]
            }
            None => msg_send![alloc, init],
        };
        let recognizer = recognizer.ok_or(SpeechError::LanguageNotSupported)?;
        let available: bool = msg_send![&recognizer, isAvailable];
        if !available {
            return Err(SpeechError::Unavailable);
        }
        // Results come on the main thread, where the session is.
        let main_queue: Retained<AnyObject> = msg_send![queue_class, mainQueue];
        let _: () = msg_send![&recognizer, setQueue: &*main_queue];

        let buffers: Retained<AnyObject> = msg_send![request_class, new];
        let _: () = msg_send![&buffers, setShouldReportPartialResults: request.interim];
        let punctuation: bool =
            msg_send![&buffers, respondsToSelector: objc2::sel!(setAddsPunctuation:)];
        if punctuation {
            let _: () = msg_send![&buffers, setAddsPunctuation: true];
        }

        audio_session(true);
        let engine: Retained<AnyObject> = msg_send![engine_class, new];
        let input: Retained<AnyObject> = msg_send![&engine, inputNode];
        let format: Option<Retained<AnyObject>> = msg_send![&input, outputFormatForBus: 0usize];
        let format = format.ok_or(SpeechError::AudioCapture)?;
        let rate: f64 = msg_send![&format, sampleRate];
        let channels: u32 = msg_send![&format, channelCount];
        if rate <= 0.0 || channels == 0 {
            // No microphone.
            audio_session(false);
            return Err(SpeechError::AudioCapture);
        }
        // The tap runs on an audio thread: it holds its own reference.
        let tap_request = buffers.clone();
        let tap = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
            if let Some(buffer) = buffer.as_ref() {
                let _: () = msg_send![&tap_request, appendAudioPCMBuffer: buffer];
            }
        });
        let _: () = msg_send![
            &input,
            installTapOnBus: 0usize,
            bufferSize: 1024u32,
            format: &*format,
            block: &*tap
        ];
        let _: () = msg_send![&engine, prepare];
        let mut error: *mut AnyObject = ptr::null_mut();
        let started: bool = msg_send![&engine, startAndReturnError: &mut error];
        if !started {
            let _: () = msg_send![&input, removeTapOnBus: 0usize];
            audio_session(false);
            return Err(SpeechError::AudioCapture);
        }

        let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
            recognized(token, result.as_ref(), error.as_ref());
        });
        let task: Option<Retained<AnyObject>> = msg_send![
            &recognizer,
            recognitionTaskWithRequest: &*buffers,
            resultHandler: &*handler
        ];
        Ok(Audio {
            engine,
            input,
            request: buffers,
            task,
            _recognizer: recognizer,
        })
    }
}

/// The recognizer's `result` or `error` for the session of `token`.
///
/// # Safety
///
/// `result` is an `SFSpeechRecognitionResult` and `error` an `NSError`; on
/// the main thread.
unsafe fn recognized(token: u64, result: Option<&AnyObject>, error: Option<&AnyObject>) {
    let Some((id, control)) = SESSION.with(|s| {
        s.borrow_mut()
            .by_token(token)
            .map(|r| (r.id, r.session.control.clone()))
    }) else {
        return;
    };
    if let Some(result) = result {
        // SAFETY: SFSpeechRecognitionResult's documented API.
        let (text, is_final) = unsafe {
            let transcription: Retained<AnyObject> = msg_send![result, bestTranscription];
            let text: Retained<NSString> = msg_send![&transcription, formattedString];
            let is_final: bool = msg_send![result, isFinal];
            (text.to_string(), is_final)
        };
        SESSION.with(|s| {
            if let Some(running) = s.borrow_mut().by_token(token) {
                running.session.text = text.clone();
            }
        });
        report(&control, id, SpeechEvent::Result { text, is_final });
        if is_final {
            finish(token, None);
            return;
        }
    }
    if let Some(error) = error {
        // SAFETY: NSError's documented API.
        let (domain, code) = unsafe {
            let domain: Retained<NSString> = msg_send![error, domain];
            let code: isize = msg_send![error, code];
            (domain.to_string(), code)
        };
        log::debug!("speech recognition ended: {domain} {code}");
        let stopping = SESSION.with(|s| {
            s.borrow_mut()
                .by_token(token)
                .is_some_and(|r| r.session.stopping)
        });
        let error = speech_error(&domain, code, stopping);
        // A stop that heard something ends with it, final.
        if error.is_none() {
            let text = SESSION.with(|s| {
                s.borrow_mut()
                    .by_token(token)
                    .map(|r| r.session.text.clone())
            });
            if let Some(text) = text.filter(|t| !t.is_empty()) {
                report(
                    &control,
                    id,
                    SpeechEvent::Result {
                        text,
                        is_final: true,
                    },
                );
            }
        }
        finish(token, error);
    }
}

/// What the recognizer's error `domain` / `code` means to the app.
fn speech_error(domain: &str, code: isize, stopping: bool) -> Option<SpeechError> {
    match (domain, code) {
        // Nothing was said (1110), or not enough to recognize (203).
        ("kAFAssistantErrorDomain", 1110 | 203) => Some(SpeechError::NoSpeech),
        // The request was cancelled: by a stop or an abort.
        ("kAFAssistantErrorDomain", 216 | 209 | 301) | ("kLSRErrorDomain", 301) => None,
        // Siri and Dictation are off, or the user turned them off.
        ("kAFAssistantErrorDomain", 1700) | ("kLSRErrorDomain", 201) => {
            Some(SpeechError::NotAllowed)
        }
        // The language's model is not on the device.
        ("kLSRErrorDomain", 102) => Some(SpeechError::LanguageNotSupported),
        ("NSURLErrorDomain", _) | ("kAFAssistantErrorDomain", 1107) => Some(SpeechError::Network),
        _ if stopping => None,
        _ => Some(SpeechError::Failed),
    }
}

/// Stops listening to `owner`'s session `id`: the recognizer finishes what
/// it heard.
fn stop(owner: Owner, id: u32) {
    let listening = SESSION.with(|s| {
        let mut s = s.borrow_mut();
        let running = s.find(owner, id)?;
        running.session.stopping = true;
        let audio = running.session.audio.as_ref()?;
        // Under the borrow: the recognizer's handlers run on the main
        // queue (`open`), never inside `silence`, so none comes back here.
        // SAFETY: AVAudioEngine's and the request's documented API.
        unsafe { silence(audio) };
        Some(running.token)
    });
    if let Some(token) = listening {
        // A recognizer that never answers still ends the session.
        later(3000, move || {
            let text = SESSION.with(|s| {
                s.borrow_mut()
                    .by_token(token)
                    .map(|r| (r.session.text.clone(), r.session.control.clone()))
            });
            if let Some((text, control)) = text {
                if !text.is_empty() {
                    report(
                        &control,
                        id,
                        SpeechEvent::Result {
                            text,
                            is_final: true,
                        },
                    );
                }
                finish(token, None);
            }
        });
    }
}

/// Ends `owner`'s session `id` at once; the core already reported its end.
fn abort(owner: Owner, id: u32) {
    if let Some(running) = SESSION.with(|s| s.borrow_mut().take(owner, id)) {
        close(running.session);
    }
}

/// Ends the session of `token`, reporting its end (with `error`).
fn finish(token: u64, error: Option<SpeechError>) {
    if let Some(running) = SESSION.with(|s| s.borrow_mut().take_token(token)) {
        let control = running.session.control.clone();
        close(running.session);
        report(&control, running.id, SpeechEvent::End { error });
    }
}

/// Turns the microphone off and drops the recognition.
fn close(session: Session) {
    if let Some(audio) = session.audio {
        // SAFETY: the documented API of the objects the session made.
        unsafe {
            silence(&audio);
            if let Some(task) = &audio.task {
                let _: () = msg_send![task, cancel];
            }
        }
        audio_session(false);
    }
}

/// Stops the microphone and ends the request's audio.
///
/// # Safety
///
/// On the main thread.
unsafe fn silence(audio: &Audio) {
    // SAFETY: guaranteed by the caller; documented API, harmless when
    // repeated.
    unsafe {
        let running: bool = msg_send![&audio.engine, isRunning];
        if running {
            let _: () = msg_send![&audio.engine, stop];
            let _: () = msg_send![&audio.input, removeTapOnBus: 0usize];
        }
        let _: () = msg_send![&audio.request, endAudio];
    }
}

fn running(token: u64) -> bool {
    SESSION.with(|s| s.borrow_mut().by_token(token).is_some())
}

/// Runs `f` on the main thread.
fn main(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

/// Runs `f` on the main thread after `ms` milliseconds.
fn later(ms: u64, f: impl FnOnce() + Send + 'static) {
    let when = dispatch2::DispatchTime::NOW.time(ms as i64 * 1_000_000);
    if let Err(err) = DispatchQueue::main().after(when, f) {
        log::warn!("speech: cannot schedule a timer: {err:?}");
    }
}

/// Whether Speech and AVFoundation are loaded (they are not linked).
fn frameworks() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| {
        load(c"/System/Library/Frameworks/Speech.framework/Speech")
            && load(c"/System/Library/Frameworks/AVFoundation.framework/AVFoundation")
    })
}

fn load(framework: &CStr) -> bool {
    // SAFETY: loads a system framework; the handle is never closed.
    let loaded = !unsafe { libc::dlopen(framework.as_ptr(), libc::RTLD_LAZY) }.is_null();
    if !loaded {
        log::error!("cannot load {}", framework.to_string_lossy());
    }
    loaded
}

/// Whether the app's `Info.plist` explains why it records and recognizes
/// speech, which the system requires before it asks the user (it ends an
/// app that asks without). An executable without a bundle (the macOS
/// development host) gets generic explanations: the terminal that runs it
/// is who the system asks for.
fn usage_described() -> bool {
    use objc2_foundation::NSBundle;
    let bundle = NSBundle::mainBundle();
    let missing: Vec<&str> = USAGE_KEYS
        .into_iter()
        .filter(|key| {
            bundle
                .objectForInfoDictionaryKey(&NSString::from_str(key))
                .is_none()
        })
        .collect();
    if missing.is_empty() {
        return true;
    }
    let bare = cfg!(target_os = "macos") && {
        let path = bundle.bundlePath().to_string();
        !path.ends_with(".app")
    };
    if !bare {
        return false;
    }
    let Some(info) = bundle.infoDictionary() else {
        return false;
    };
    // SAFETY: `isKindOfClass:` takes any class; `setObject:forKey:` is sent
    // only to a mutable dictionary, with string keys and values.
    unsafe {
        let Some(mutable) = AnyClass::get(c"NSMutableDictionary") else {
            return false;
        };
        let is_mutable: bool = msg_send![&*info, isKindOfClass: mutable];
        if !is_mutable {
            return false;
        }
        let why = NSString::from_str("The app you are developing recognizes what you say.");
        for key in missing {
            let _: () = msg_send![&*info, setObject: &*why, forKey: &*NSString::from_str(key)];
        }
    }
    true
}

/// Activates the app's audio session for recording (iOS), or deactivates
/// it, letting other apps' audio go on.
#[cfg(target_os = "ios")]
fn audio_session(active: bool) {
    let Some(class) = AnyClass::get(c"AVAudioSession") else {
        return;
    };
    // SAFETY: AVAudioSession's documented API; the category and mode are
    // the values of AVFoundation's string constants.
    unsafe {
        let session: Retained<AnyObject> = msg_send![class, sharedInstance];
        let mut error: *mut AnyObject = ptr::null_mut();
        if active {
            let category = NSString::from_str("AVAudioSessionCategoryRecord");
            let mode = NSString::from_str("AVAudioSessionModeMeasurement");
            // AVAudioSessionCategoryOptionDuckOthers.
            let _: bool = msg_send![
                &session,
                setCategory: &*category,
                mode: &*mode,
                options: 2usize,
                error: &mut error
            ];
        }
        // AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation.
        let _: bool = msg_send![
            &session,
            setActive: active,
            withOptions: 1usize,
            error: &mut error
        ];
    }
}

/// macOS has no audio session: the microphone is the app's to open.
#[cfg(not(target_os = "ios"))]
fn audio_session(_active: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors() {
        let error = |domain, code| speech_error(domain, code, false);
        assert_eq!(
            error("kAFAssistantErrorDomain", 1110),
            Some(SpeechError::NoSpeech)
        );
        assert_eq!(error("kAFAssistantErrorDomain", 216), None);
        assert_eq!(error("kLSRErrorDomain", 201), Some(SpeechError::NotAllowed));
        assert_eq!(error("NSURLErrorDomain", -1009), Some(SpeechError::Network));
        assert_eq!(error("SomeDomain", 1), Some(SpeechError::Failed));
        assert_eq!(speech_error("SomeDomain", 1, true), None);
    }

    /// Two engines' listeners; their session ids are their own and collide.
    const A: Owner = 1;
    const B: Owner = 2;

    #[test]
    fn another_engines_stop_and_abort_leave_a_session_alone() {
        let mut sessions = Sessions::new();
        sessions.insert(A, 1, "a");
        assert!(sessions.find(B, 1).is_none());
        assert!(sessions.take(B, 1).is_none());
        assert!(sessions.find(A, 2).is_none());
        let running = sessions.take(A, 1).expect("A's own abort ends it");
        assert_eq!((running.owner, running.id, running.session), (A, 1, "a"));
        assert!(sessions.running.is_none());
    }

    #[test]
    fn another_engines_start_ends_a_session_and_reports_it() {
        let mut sessions = Sessions::new();
        sessions.insert(A, 1, "a");
        let displaced = sessions.displace(B).expect("the microphone is one");
        assert!(displaced.report, "A's core still waits for its end");
        assert_eq!((displaced.running.owner, displaced.running.id), (A, 1));
        sessions.insert(B, 1, "b");
        // A session of the starting engine's own was ended by its core.
        let replaced = sessions.displace(B).expect("B's session runs");
        assert!(!replaced.report);
        assert!(sessions.displace(B).is_none());
    }

    #[test]
    fn a_stopping_surface_ends_its_own_session_only() {
        let mut sessions = Sessions::new();
        sessions.insert(A, 1, "a");
        assert!(sessions.take_owner(B).is_none());
        assert_eq!(sessions.take_owner(A).map(|r| r.session), Some("a"));
        assert!(sessions.running.is_none());
    }

    #[test]
    fn callbacks_of_an_ended_session_miss_the_next() {
        let mut sessions = Sessions::new();
        // An engine that restarts counts its ids from the start again.
        let first = sessions.insert(A, 1, "first");
        sessions.take_owner(A);
        let second = sessions.insert(A, 1, "second");
        assert_ne!(first, second);
        assert!(sessions.by_token(first).is_none());
        assert!(sessions.take_token(first).is_none());
        assert_eq!(
            sessions.take_token(second).map(|r| r.session),
            Some("second")
        );
    }
}
