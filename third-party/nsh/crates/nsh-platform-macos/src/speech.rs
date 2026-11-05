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

use std::{cell::RefCell, ffi::CStr, ptr, sync::OnceLock};

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
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// The session running.
struct Session {
    id: u32,
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

/// Applies `command`, reporting through `control`. On the main thread.
pub(crate) fn command(control: &EngineControl, command: &SpeechCommand) {
    match command {
        SpeechCommand::Start { id, request } => start(control, *id, request.clone()),
        SpeechCommand::Stop { id } => stop(*id),
        SpeechCommand::Abort { id } => abort(*id),
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

fn start(control: &EngineControl, id: u32, request: SpeechRequest) {
    // The one running is aborted first: the core already ended it.
    if let Some(running) = SESSION.with(|s| s.borrow().as_ref().map(|s| s.id)) {
        abort(running);
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
    SESSION.with(|s| {
        *s.borrow_mut() = Some(Session {
            id,
            request,
            control: control.clone(),
            audio: None,
            stopping: false,
            text: String::new(),
        })
    });
    let Some(recognizer) = AnyClass::get(c"SFSpeechRecognizer") else {
        finish(id, Some(SpeechError::Unavailable));
        return;
    };
    // The handler runs on a queue of the framework's.
    let handler = RcBlock::new(move |status: isize| {
        main(move || {
            if status != AUTHORIZED {
                finish(id, Some(SpeechError::NotAllowed));
                return;
            }
            ask_microphone(id);
        });
    });
    // SAFETY: Speech's documented class method (iOS 10, macOS 10.15),
    // taking a block of the authorization status (an NSInteger).
    unsafe {
        let _: () = msg_send![recognizer, requestAuthorization: &*handler];
    }
}

/// Asks for the microphone, then listens.
fn ask_microphone(id: u32) {
    if !running(id) {
        return;
    }
    let Some(device) = AnyClass::get(c"AVCaptureDevice") else {
        finish(id, Some(SpeechError::AudioCapture));
        return;
    };
    let handler = RcBlock::new(move |granted: Bool| {
        let granted = granted.as_bool();
        main(move || {
            if granted {
                listen(id);
            } else {
                finish(id, Some(SpeechError::NotAllowed));
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

/// Starts the microphone and the recognizer for session `id`.
fn listen(id: u32) {
    let Some((request, control, stopping)) = SESSION.with(|s| {
        s.borrow()
            .as_ref()
            .filter(|s| s.id == id)
            .map(|s| (s.request.clone(), s.control.clone(), s.stopping))
    }) else {
        return;
    };
    if stopping {
        finish(id, None);
        return;
    }
    match open(id, &request) {
        Ok(audio) => {
            SESSION.with(|s| {
                if let Some(session) = s.borrow_mut().as_mut().filter(|s| s.id == id) {
                    session.audio = Some(audio);
                }
            });
            report(&control, id, SpeechEvent::Start);
        }
        Err(error) => finish(id, Some(error)),
    }
}

/// The recognizer and the microphone listening for session `id`.
fn open(id: u32, request: &SpeechRequest) -> Result<Audio, SpeechError> {
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
            recognized(id, result.as_ref(), error.as_ref());
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

/// The recognizer's `result` or `error` for session `id`.
///
/// # Safety
///
/// `result` is an `SFSpeechRecognitionResult` and `error` an `NSError`; on
/// the main thread.
unsafe fn recognized(id: u32, result: Option<&AnyObject>, error: Option<&AnyObject>) {
    let Some(control) = SESSION.with(|s| {
        s.borrow()
            .as_ref()
            .filter(|s| s.id == id)
            .map(|s| s.control.clone())
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
            if let Some(session) = s.borrow_mut().as_mut() {
                session.text = text.clone();
            }
        });
        report(&control, id, SpeechEvent::Result { text, is_final });
        if is_final {
            finish(id, None);
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
        let stopping = SESSION.with(|s| s.borrow().as_ref().is_some_and(|s| s.stopping));
        let error = speech_error(&domain, code, stopping);
        // A stop that heard something ends with it, final.
        if error.is_none() {
            let text = SESSION.with(|s| s.borrow().as_ref().map(|s| s.text.clone()));
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
        finish(id, error);
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

/// Stops listening to session `id`: the recognizer finishes what it heard.
fn stop(id: u32) {
    let listening = SESSION.with(|s| {
        let mut s = s.borrow_mut();
        let Some(session) = s.as_mut().filter(|s| s.id == id) else {
            return false;
        };
        session.stopping = true;
        if let Some(audio) = &session.audio {
            // SAFETY: AVAudioEngine's and the request's documented API.
            unsafe { silence(audio) };
            true
        } else {
            false
        }
    });
    if listening {
        // A recognizer that never answers still ends the session.
        later(3000, move || {
            let text = SESSION.with(|s| {
                s.borrow()
                    .as_ref()
                    .filter(|s| s.id == id)
                    .map(|s| (s.text.clone(), s.control.clone()))
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
                finish(id, None);
            }
        });
    }
}

/// Ends session `id` at once; the core already reported its end.
fn abort(id: u32) {
    let session = SESSION.with(|s| {
        let mut s = s.borrow_mut();
        if s.as_ref().is_some_and(|s| s.id == id) {
            s.take()
        } else {
            None
        }
    });
    if let Some(session) = session {
        close(session);
    }
}

/// Ends session `id`, reporting its end (with `error`).
fn finish(id: u32, error: Option<SpeechError>) {
    let session = SESSION.with(|s| {
        let mut s = s.borrow_mut();
        if s.as_ref().is_some_and(|s| s.id == id) {
            s.take()
        } else {
            None
        }
    });
    if let Some(session) = session {
        let control = session.control.clone();
        close(session);
        report(&control, id, SpeechEvent::End { error });
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

fn running(id: u32) -> bool {
    SESSION.with(|s| s.borrow().as_ref().is_some_and(|s| s.id == id))
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
}
