//! Speech recognition on Windows: `Windows.Media.SpeechRecognition`'s
//! continuous dictation, from the default microphone. Each session runs on
//! a thread of its own in the multithreaded apartment, which waits on the
//! recognizer's operations without blocking the app; the recognizer's
//! events arrive on WinRT's threads and only reach that thread over a
//! channel.
//!
//! Interim transcripts are the recognizer's hypotheses when the request
//! asks for them; each recognized phrase is added to the transcript.
//! Stopping a session is `StopAsync` (the recognizer finishes the phrase it
//! heard), aborting it `CancelAsync`. The language is one of the
//! recognizer's dictation languages (a bare language takes its first
//! region); another ends the session with `language-not-supported`.
//!
//! Dictation uses Windows' online speech recognition, which the user turns
//! on in Settings (Privacy & security > Speech): while it is off, sessions
//! end with `not-allowed`, as they do while the microphone's privacy
//! setting keeps desktop apps from it. Unpackaged apps, as `nsh package`
//! makes them, declare nothing for it.

use super::SpeechError;

/// `SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED`: the user's online speech
/// recognition setting is off.
const PRIVACY_POLICY_NOT_ACCEPTED: u32 = 0x8004_5509;
/// `E_ACCESSDENIED`: the microphone's privacy setting keeps the app from it.
const ACCESS_DENIED: u32 = 0x8007_0005;
/// `MF_E_NO_CAPTURE_DEVICES_AVAILABLE`.
const NO_CAPTURE_DEVICES: u32 = 0xC00D_ABE0;
/// WinINet's errors (`HRESULT_FROM_WIN32` of 12000 to 12175): the
/// recognition service could not be reached.
const INTERNET_ERRORS: std::ops::RangeInclusive<u32> = 0x8007_2EE0..=0x8007_2F8F;

/// What a failed call's `HRESULT` means to the app.
fn hresult_error(code: i32) -> SpeechError {
    match code as u32 {
        PRIVACY_POLICY_NOT_ACCEPTED => {
            log::warn!(
                "speech recognition: online speech recognition is off; the user turns it on in \
                 Settings > Privacy & security > Speech"
            );
            SpeechError::NotAllowed
        }
        ACCESS_DENIED => {
            log::warn!(
                "speech recognition: the microphone's privacy settings keep the app from it \
                 (Settings > Privacy & security > Microphone)"
            );
            SpeechError::NotAllowed
        }
        NO_CAPTURE_DEVICES => SpeechError::AudioCapture,
        code if INTERNET_ERRORS.contains(&code) => SpeechError::Network,
        _ => SpeechError::Failed,
    }
}

/// `SpeechRecognitionResultStatus`' values.
mod status {
    pub(super) const SUCCESS: i32 = 0;
    pub(super) const TOPIC_LANGUAGE_NOT_SUPPORTED: i32 = 1;
    pub(super) const GRAMMAR_LANGUAGE_MISMATCH: i32 = 2;
    pub(super) const AUDIO_QUALITY_FAILURE: i32 = 4;
    pub(super) const USER_CANCELED: i32 = 5;
    pub(super) const TIMEOUT_EXCEEDED: i32 = 7;
    pub(super) const PAUSE_LIMIT_EXCEEDED: i32 = 8;
    pub(super) const NETWORK_FAILURE: i32 = 9;
    pub(super) const MICROPHONE_UNAVAILABLE: i32 = 10;
}

/// How a continuous session that completed with `status` ends: `None` when
/// it did not fail. A session that ends normally (stopped, or silent long
/// enough) and `heard` nothing heard no speech.
fn ending(status: i32, stopping: bool, heard: bool) -> Option<SpeechError> {
    match status {
        status::SUCCESS
        | status::USER_CANCELED
        | status::TIMEOUT_EXCEEDED
        | status::PAUSE_LIMIT_EXCEEDED
        | status::AUDIO_QUALITY_FAILURE
            if heard =>
        {
            None
        }
        status::SUCCESS
        | status::USER_CANCELED
        | status::TIMEOUT_EXCEEDED
        | status::PAUSE_LIMIT_EXCEEDED
        | status::AUDIO_QUALITY_FAILURE => Some(SpeechError::NoSpeech),
        status::TOPIC_LANGUAGE_NOT_SUPPORTED | status::GRAMMAR_LANGUAGE_MISMATCH => {
            Some(SpeechError::LanguageNotSupported)
        }
        status::NETWORK_FAILURE => Some(SpeechError::Network),
        status::MICROPHONE_UNAVAILABLE => Some(SpeechError::AudioCapture),
        _ if stopping && heard => None,
        _ => Some(SpeechError::Failed),
    }
}

/// What goes between two phrases, which dictation gives without the
/// spaces around them: a space, except in the languages written without
/// spaces between words.
fn phrase_separator(tag: &str) -> &'static str {
    let primary = tag.split('-').next().unwrap_or_default();
    let unspaced = ["zh", "yue", "ja", "th", "lo", "km", "my"];
    if unspaced.iter().any(|l| primary.eq_ignore_ascii_case(l)) {
        ""
    } else {
        " "
    }
}

/// `transcript` followed by `phrase`, `separator` between them.
fn joined(transcript: &str, separator: &str, phrase: &str) -> String {
    if transcript.is_empty() {
        phrase.to_owned()
    } else {
        format!("{transcript}{separator}{phrase}")
    }
}

/// Which of the `supported` language tags dictates `asked`: the same tag,
/// else, for a bare language (`en`), its first region (`en-US`).
fn supported_language<'a>(asked: &str, supported: &'a [String]) -> Option<&'a str> {
    let region = format!("{asked}-");
    supported
        .iter()
        .find(|tag| tag.eq_ignore_ascii_case(asked))
        .or_else(|| {
            supported.iter().find(|tag| {
                tag.len() > region.len()
                    && tag.is_char_boundary(region.len())
                    && tag[..region.len()].eq_ignore_ascii_case(&region)
            })
        })
        .map(String::as_str)
}

#[cfg(target_os = "windows")]
pub(super) use self::platform::{available, start};

#[cfg(target_os = "windows")]
mod platform {
    use std::{
        sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
        time::{Duration, Instant},
    };

    use windows::{
        Foundation::TypedEventHandler,
        Globalization::Language,
        Media::{
            Devices::{AudioDeviceRole, MediaDevice},
            SpeechRecognition::{
                SpeechContinuousRecognitionCompletedEventArgs,
                SpeechContinuousRecognitionResultGeneratedEventArgs,
                SpeechContinuousRecognitionSession, SpeechRecognitionConfidence,
                SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus,
                SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognizer,
            },
        },
        Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        core::{HSTRING, Ref},
    };

    use super::{ending, hresult_error, joined, phrase_separator, status, supported_language};
    use crate::speech::{SpeechControl, SpeechError, SpeechRequest, SpeechSink};

    /// How long after a stop a recognizer that never completes still ends
    /// the session.
    const STOP_LIMIT: Duration = Duration::from_secs(3);

    /// Asks WinRT on a short-lived thread of its own, in the
    /// multithreaded apartment: making a recognizer loads its language
    /// data, which the engine's thread never waits for.
    pub(in crate::speech) async fn available() -> bool {
        let (sender, answer) = tokio::sync::oneshot::channel();
        let spawned = std::thread::Builder::new()
            .name("nsh-speech-available".into())
            .spawn(move || {
                // SAFETY: the thread is new and its own: nothing else set
                // its apartment, and every WinRT object of it (the error's
                // too, made a string) is gone before the matching
                // `RoUninitialize`.
                let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
                let available = recognizer_available().map_err(|error| error.to_string());
                if initialized {
                    // SAFETY: pairs the `RoInitialize` above.
                    unsafe { RoUninitialize() };
                }
                let _ = sender.send(available);
            });
        if let Err(error) = spawned {
            log::error!("speech recognition cannot tell whether it is available: {error}");
            return false;
        }
        match answer.await {
            Ok(Ok(available)) => available,
            Ok(Err(error)) => {
                log::debug!("speech recognition is not available: {error}");
                false
            }
            Err(_) => false,
        }
    }

    /// Whether a dictation language is installed, a recognizer can be
    /// made and a microphone is there; none of it asks the user anything.
    fn recognizer_available() -> windows::core::Result<bool> {
        if SpeechRecognizer::SupportedTopicLanguages()?.Size()? == 0 {
            return Ok(false);
        }
        if MediaDevice::GetDefaultAudioCaptureId(AudioDeviceRole::Default)?.is_empty() {
            return Ok(false);
        }
        SpeechRecognizer::new()?.Close()?;
        Ok(true)
    }

    pub(in crate::speech) fn start(
        request: SpeechRequest,
        events: SpeechSink,
    ) -> Box<dyn SpeechControl> {
        let (sender, messages) = mpsc::channel();
        let control = Control {
            messages: sender.clone(),
        };
        let sink = events.clone();
        let spawned = std::thread::Builder::new()
            .name("nsh-speech".into())
            .spawn(move || run(request, sink, sender, messages));
        if let Err(error) = spawned {
            log::error!("speech recognition cannot start: {error}");
            events.end(Some(SpeechError::Failed));
        }
        Box::new(control)
    }

    /// What the module, and WinRT's threads, tell a session's thread.
    enum Message {
        /// The phrase being heard, not recognized yet.
        Hypothesis(String),
        /// A phrase recognized.
        Phrase(String),
        /// The continuous session completed with this status.
        Completed(SpeechRecognitionResultStatus),
        Stop,
        Abort,
    }

    /// A session as the module controls it, from any thread.
    struct Control {
        messages: Sender<Message>,
    }

    impl SpeechControl for Control {
        fn stop(&mut self) {
            let _ = self.messages.send(Message::Stop);
        }

        fn abort(&mut self) {
            let _ = self.messages.send(Message::Abort);
        }
    }

    /// A session's thread, from its start to its end.
    fn run(
        request: SpeechRequest,
        sink: SpeechSink,
        sender: Sender<Message>,
        messages: Receiver<Message>,
    ) {
        // SAFETY: the thread is new and its own: nothing else set its
        // apartment, and every WinRT object of it is gone before the
        // matching `RoUninitialize`.
        let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
        match Session::open(&request, &sender) {
            Ok(session) => session.listen(request.interim, &sink, &messages),
            Err(error) => {
                sink.end(Some(error));
            }
        }
        if initialized {
            // SAFETY: pairs the `RoInitialize` above.
            unsafe { RoUninitialize() };
        }
    }

    /// A recognizer with its dictation compiled, its events forwarded to
    /// the session's thread.
    struct Session {
        recognizer: SpeechRecognizer,
        continuous: SpeechContinuousRecognitionSession,
        separator: &'static str,
        hypothesis_token: Option<i64>,
        result_token: Option<i64>,
        completed_token: Option<i64>,
    }

    impl Session {
        fn open(request: &SpeechRequest, sender: &Sender<Message>) -> Result<Self, SpeechError> {
            let recognizer = match &request.lang {
                Some(lang) => SpeechRecognizer::Create(&language(lang)?),
                None => SpeechRecognizer::new(),
            }
            .map_err(failed)?;
            let continuous = recognizer.ContinuousRecognitionSession().map_err(failed)?;
            let separator = recognizer
                .CurrentLanguage()
                .and_then(|language| language.LanguageTag())
                .map_or(" ", |tag| phrase_separator(&tag.to_string_lossy()));
            let mut session = Session {
                recognizer,
                continuous,
                separator,
                hypothesis_token: None,
                result_token: None,
                completed_token: None,
            };
            // Dropped on an error below: its recognizer closes.
            session.subscribe(sender).map_err(failed)?;
            let constraint = SpeechRecognitionTopicConstraint::Create(
                SpeechRecognitionScenario::Dictation,
                &HSTRING::from("dictation"),
            )
            .map_err(failed)?;
            session
                .recognizer
                .Constraints()
                .and_then(|constraints| constraints.Append(&constraint))
                .map_err(failed)?;
            let compiled = session
                .recognizer
                .CompileConstraintsAsync()
                .and_then(|compiling| compiling.join())
                .and_then(|compiled| compiled.Status())
                .map_err(failed)?;
            if compiled != SpeechRecognitionResultStatus::Success {
                log::warn!(
                    "speech recognition: dictation did not compile: {}",
                    compiled.0
                );
                return Err(ending(compiled.0, false, false).unwrap_or(SpeechError::Failed));
            }
            Ok(session)
        }

        /// Forwards the recognizer's events to `sender`.
        fn subscribe(&mut self, sender: &Sender<Message>) -> windows::core::Result<()> {
            let messages = sender.clone();
            self.hypothesis_token = Some(self.recognizer.HypothesisGenerated(
                &TypedEventHandler::new(
                    move |_, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
                        if let Some(args) = args.as_ref() {
                            let text = args.Hypothesis()?.Text()?.to_string_lossy();
                            let _ = messages.send(Message::Hypothesis(text));
                        }
                        Ok(())
                    },
                ),
            )?);
            let messages = sender.clone();
            self.result_token = Some(self.continuous.ResultGenerated(&TypedEventHandler::new(
                move |_, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        let result = args.Result()?;
                        // Rejected phrases are noise the recognizer heard.
                        if result.Status()? == SpeechRecognitionResultStatus::Success
                            && result.Confidence()? != SpeechRecognitionConfidence::Rejected
                        {
                            let text = result.Text()?.to_string_lossy();
                            let _ = messages.send(Message::Phrase(text));
                        }
                    }
                    Ok(())
                },
            ))?);
            let messages = sender.clone();
            self.completed_token = Some(self.continuous.Completed(&TypedEventHandler::new(
                move |_, args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        let _ = messages.send(Message::Completed(args.Status()?));
                    }
                    Ok(())
                },
            ))?);
            Ok(())
        }

        /// Listens and reports to `sink` until the session ends.
        fn listen(self, interim: bool, sink: &SpeechSink, messages: &Receiver<Message>) {
            // Stopped or aborted while the dictation compiled: nothing
            // was heard.
            while let Ok(message) = messages.try_recv() {
                match message {
                    Message::Abort => return,
                    Message::Stop => {
                        sink.end(None);
                        return;
                    }
                    _ => {}
                }
            }
            if let Err(error) = self.continuous.StartAsync().and_then(|start| start.join()) {
                sink.end(Some(failed(error)));
                return;
            }
            sink.start();
            let mut transcript = String::new();
            let mut stop_limit: Option<Instant> = None;
            loop {
                let message = match stop_limit {
                    None => messages.recv().map_err(|_| RecvTimeoutError::Disconnected),
                    Some(limit) => {
                        messages.recv_timeout(limit.saturating_duration_since(Instant::now()))
                    }
                };
                let message = match message {
                    Ok(message) => message,
                    // A recognizer that never completes still ends the
                    // session.
                    Err(RecvTimeoutError::Timeout) => {
                        let error = ending(status::SUCCESS, true, !transcript.is_empty());
                        end(sink, transcript, error);
                        return;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                };
                match message {
                    Message::Hypothesis(text) if interim && !text.is_empty() => {
                        sink.result(joined(&transcript, self.separator, &text), false);
                    }
                    Message::Hypothesis(_) => {}
                    Message::Phrase(text) if !text.is_empty() => {
                        transcript = joined(&transcript, self.separator, &text);
                        if interim {
                            sink.result(transcript.clone(), false);
                        }
                    }
                    Message::Phrase(_) => {}
                    Message::Completed(status) => {
                        log::debug!("speech recognition completed: {}", status.0);
                        let heard = !transcript.is_empty();
                        let error = ending(status.0, stop_limit.is_some(), heard);
                        end(sink, transcript, error);
                        return;
                    }
                    Message::Stop if stop_limit.is_none() => {
                        stop_limit = Some(Instant::now() + STOP_LIMIT);
                        // Completes the session, its last phrase first. One
                        // that completed on its own meanwhile fails to
                        // stop: its `Completed` is on its way.
                        if let Err(error) = self.continuous.StopAsync() {
                            log::debug!("speech recognition did not stop: {error}");
                        }
                    }
                    Message::Stop => {}
                    // The module ended the sink.
                    Message::Abort => {
                        // Waited for: the recognizer closes after it.
                        let cancelled = self.continuous.CancelAsync().and_then(|c| c.join());
                        if let Err(error) = cancelled {
                            log::debug!("speech recognition did not cancel: {error}");
                        }
                        return;
                    }
                }
            }
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            if let Some(token) = self.hypothesis_token.take() {
                let _ = self.recognizer.RemoveHypothesisGenerated(token);
            }
            if let Some(token) = self.result_token.take() {
                let _ = self.continuous.RemoveResultGenerated(token);
            }
            if let Some(token) = self.completed_token.take() {
                let _ = self.continuous.RemoveCompleted(token);
            }
            let _ = self.recognizer.Close();
        }
    }

    /// Reports the end of a session that heard `transcript`: it, final,
    /// unless the session failed.
    fn end(sink: &SpeechSink, transcript: String, error: Option<SpeechError>) {
        if error.is_none() && !transcript.is_empty() {
            sink.result(transcript, true);
        }
        sink.end(error);
    }

    /// The dictation language for the BCP 47 tag `lang`.
    fn language(lang: &str) -> Result<Language, SpeechError> {
        let supported = || -> windows::core::Result<Option<Language>> {
            let tag = HSTRING::from(lang);
            if !Language::IsWellFormed(&tag)? {
                return Ok(None);
            }
            let languages = SpeechRecognizer::SupportedTopicLanguages()?;
            let mut tags = Vec::with_capacity(languages.Size()? as usize);
            for language in &languages {
                tags.push(language.LanguageTag()?.to_string_lossy());
            }
            let Some(found) = supported_language(lang, &tags) else {
                return Ok(None);
            };
            Language::CreateLanguage(&HSTRING::from(found)).map(Some)
        };
        match supported() {
            Ok(Some(language)) => Ok(language),
            Ok(None) => {
                log::info!("speech recognition: no dictation language for {lang:?} is installed");
                Err(SpeechError::LanguageNotSupported)
            }
            Err(error) => Err(failed(error)),
        }
    }

    fn failed(error: windows::core::Error) -> SpeechError {
        log::debug!("speech recognition failed: {error}");
        hresult_error(error.code().0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors() {
        assert_eq!(
            hresult_error(PRIVACY_POLICY_NOT_ACCEPTED as i32),
            SpeechError::NotAllowed
        );
        assert_eq!(hresult_error(ACCESS_DENIED as i32), SpeechError::NotAllowed);
        assert_eq!(
            hresult_error(NO_CAPTURE_DEVICES as i32),
            SpeechError::AudioCapture
        );
        // ERROR_INTERNET_CANNOT_CONNECT.
        assert_eq!(hresult_error(0x8007_2EFD_u32 as i32), SpeechError::Network);
        assert_eq!(hresult_error(0x8000_4005_u32 as i32), SpeechError::Failed);
    }

    #[test]
    fn endings() {
        assert_eq!(ending(status::SUCCESS, true, true), None);
        assert_eq!(ending(status::TIMEOUT_EXCEEDED, false, true), None);
        assert_eq!(
            ending(status::TIMEOUT_EXCEEDED, false, false),
            Some(SpeechError::NoSpeech)
        );
        assert_eq!(
            ending(status::USER_CANCELED, true, false),
            Some(SpeechError::NoSpeech)
        );
        assert_eq!(
            ending(status::TOPIC_LANGUAGE_NOT_SUPPORTED, false, false),
            Some(SpeechError::LanguageNotSupported)
        );
        assert_eq!(
            ending(status::NETWORK_FAILURE, true, true),
            Some(SpeechError::Network)
        );
        assert_eq!(
            ending(status::MICROPHONE_UNAVAILABLE, false, false),
            Some(SpeechError::AudioCapture)
        );
        // Unknown.
        assert_eq!(ending(6, false, true), Some(SpeechError::Failed));
        assert_eq!(ending(6, true, true), None);
    }

    #[test]
    fn phrases_join_as_the_language_writes() {
        assert_eq!(phrase_separator("en-US"), " ");
        assert_eq!(phrase_separator("zh-Hans-CN"), "");
        assert_eq!(phrase_separator("JA-jp"), "");
        assert_eq!(joined("", " ", "hello"), "hello");
        assert_eq!(joined("hello", " ", "world"), "hello world");
        assert_eq!(joined("你好", "", "世界"), "你好世界");
    }

    #[test]
    fn languages_match_their_tag_or_first_region() {
        let supported = ["en-US", "en-GB", "zh-CN"].map(String::from);
        assert_eq!(supported_language("en-gb", &supported), Some("en-GB"));
        assert_eq!(supported_language("en", &supported), Some("en-US"));
        assert_eq!(supported_language("zh", &supported), Some("zh-CN"));
        assert_eq!(supported_language("fr", &supported), None);
        assert_eq!(supported_language("e", &supported), None);
    }
}
