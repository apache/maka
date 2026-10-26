//! `<video>`: AVPlayer in an `AVPlayerLayer`, or in an
//! `AVPlayerViewController` for the platform's controls. AVFoundation and
//! AVKit are loaded on first use (`dlopen`), so apps without videos do not
//! pay for them at launch.

use std::{cell::Cell, ffi::CStr, ptr::NonNull, rc::Rc, sync::OnceLock};

use block2::RcBlock;
use nsh_core::{
    AudioSession, EventKind, EventPayload, NodeId, PayloadValue, ResizeMode, VideoProps,
};
use nsh_engine::EngineControl;
use objc2::{
    Encode, Encoding, MainThreadMarker, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ProtocolObject},
};
use objc2_core_foundation::CGSize;
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue, NSString, NSURL,
};
use objc2_ui_kit::{UIView, UIViewAutoresizing};

use crate::{image::AssetBase, native_view::NshView};

/// CoreMedia's `CMTime`.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub(crate) struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

// SAFETY: the layout and encoding of CoreMedia's `CMTime` (`{?=qiIq}`).
unsafe impl Encode for CMTime {
    const ENCODING: Encoding = Encoding::Struct(
        "?",
        &[i64::ENCODING, i32::ENCODING, u32::ENCODING, i64::ENCODING],
    );
}

impl CMTime {
    fn from_seconds(seconds: f64) -> Self {
        Self {
            value: (seconds * 600.0).round() as i64,
            timescale: 600,
            flags: 1,
            epoch: 0,
        }
    }

    /// Seconds, or NaN when invalid or indefinite (live streams).
    fn seconds(&self) -> f64 {
        if self.flags & 1 == 0 || self.flags & 0x10 != 0 || self.timescale == 0 {
            f64::NAN
        } else {
            self.value as f64 / self.timescale as f64
        }
    }
}

fn load(framework: &CStr) -> bool {
    // SAFETY: loads a system framework; the handle is never closed.
    !unsafe { libc::dlopen(framework.as_ptr(), libc::RTLD_LAZY) }.is_null()
}

fn av_foundation() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| load(c"/System/Library/Frameworks/AVFoundation.framework/AVFoundation"))
}

fn av_kit() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| load(c"/System/Library/Frameworks/AVKit.framework/AVKit"))
}

fn class(name: &CStr) -> Option<&'static AnyClass> {
    AnyClass::get(name)
}

/// The audio session's category, mode and options (`AVAudioSession`).
type Category = (Retained<NSString>, Retained<NSString>, usize);

/// What `session` sets: Apple's `playback` category in the `spokenAudio`
/// mode, mixing with other apps' audio for `MixWithOthers`. `Default`
/// sets nothing: the app's (or the embedding app's) session stays.
fn audio_category(session: AudioSession) -> Option<Category> {
    // AVAudioSessionCategoryOptionMixWithOthers is 1.
    let options = match session {
        AudioSession::Default => return None,
        AudioSession::Playback => 0,
        AudioSession::MixWithOthers => 1,
    };
    Some((
        NSString::from_str("AVAudioSessionCategoryPlayback"),
        NSString::from_str("AVAudioSessionModeSpokenAudio"),
        options,
    ))
}

/// The videos of this (main) thread that play with an audio session of
/// their own, and what the session was before the first of them.
#[derive(Default)]
struct AudioSessions {
    /// Playing videos (their [`VideoHost::audio_key`]) and their sessions.
    playing: Vec<(u64, AudioSession)>,
    /// What the session is set to for them, and what it was before.
    applied: Option<(AudioSession, Category)>,
}

thread_local! {
    static AUDIO: std::cell::RefCell<AudioSessions> = std::cell::RefCell::default();
}

/// Video `key` plays with `session` (`Some`), or plays no more: the shared
/// audio session follows the playing videos. While one that does not mix
/// plays, it is `Playback`, else `MixWithOthers`; once none plays, the
/// session is set back to what it was and deactivated, telling the apps it
/// interrupted that they may play again.
fn audio_playing(key: u64, session: Option<AudioSession>) {
    AUDIO.with(|audio| {
        let mut audio = audio.borrow_mut();
        audio.playing.retain(|&(k, _)| k != key);
        if let Some(session) = session.filter(|s| *s != AudioSession::Default) {
            audio.playing.push((key, session));
        }
        let wanted = if audio.playing.is_empty() {
            None
        } else if audio.playing.iter().any(|&(_, s)| s == AudioSession::Playback) {
            Some(AudioSession::Playback)
        } else {
            Some(AudioSession::MixWithOthers)
        };
        if wanted == audio.applied.as_ref().map(|(s, _)| *s) {
            return;
        }
        let Some(shared) = shared_audio_session() else {
            return;
        };
        match wanted {
            Some(session) => {
                let before = match audio.applied.take() {
                    Some((_, before)) => before,
                    None => current_category(&shared),
                };
                let set = audio_category(session).is_some_and(|c| set_category(&shared, &c));
                // SAFETY: AVAudioSession's documented API.
                let active = set && unsafe {
                    let mut error: *mut AnyObject = std::ptr::null_mut();
                    let ok: Bool = msg_send![&shared, setActive: Bool::YES, error: &mut error];
                    ok.as_bool()
                };
                if !active {
                    log::error!("cannot set and activate the audio session for a video");
                }
                audio.applied = Some((session, before));
            }
            None => {
                let Some((_, before)) = audio.applied.take() else {
                    return;
                };
                // SAFETY: AVAudioSession's documented API;
                // AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation is 1.
                unsafe {
                    let mut error: *mut AnyObject = std::ptr::null_mut();
                    let _: Bool = msg_send![&shared, setActive: Bool::NO, withOptions: 1usize, error: &mut error];
                }
                if !set_category(&shared, &before) {
                    log::error!("cannot restore the audio session after a video");
                }
            }
        }
    });
}

fn shared_audio_session() -> Option<Retained<AnyObject>> {
    let cls = class(c"AVAudioSession")?;
    // SAFETY: AVAudioSession's documented API.
    Some(unsafe { msg_send![cls, sharedInstance] })
}

/// The session's category, mode and options now.
fn current_category(shared: &AnyObject) -> Category {
    // SAFETY: AVAudioSession's documented getters.
    unsafe {
        (
            msg_send![shared, category],
            msg_send![shared, mode],
            msg_send![shared, categoryOptions],
        )
    }
}

fn set_category(shared: &AnyObject, (category, mode, options): &Category) -> bool {
    let mut error: *mut AnyObject = std::ptr::null_mut();
    // SAFETY: AVAudioSession's documented API.
    let ok: Bool = unsafe {
        msg_send![
            shared,
            setCategory: &**category,
            mode: &**mode,
            options: *options,
            error: &mut error,
        ]
    };
    ok.as_bool()
}

/// The keys of [`audio_playing`], one per video host.
static NEXT_AUDIO_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// What the player has reported so far.
#[derive(Default)]
struct Status {
    loaded: Cell<bool>,
    failed: Cell<bool>,
    buffering: Cell<bool>,
}

/// One video.
pub(crate) struct VideoHost {
    pub(crate) view: Retained<NshView>,
    id: NodeId,
    control: EngineControl,
    asset_base: Option<AssetBase>,
    player: Option<Retained<AnyObject>>,
    layer: Option<Retained<AnyObject>>,
    controller: Option<Retained<AnyObject>>,
    time_observer: Option<Retained<AnyObject>>,
    end_observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    status: Rc<Status>,
    props: VideoProps,
    repeat: Rc<Cell<bool>>,
    /// Its key in [`audio_playing`].
    audio_key: u64,
}

impl VideoHost {
    pub(crate) fn new(
        mtm: MainThreadMarker,
        id: NodeId,
        control: EngineControl,
        asset_base: Option<AssetBase>,
    ) -> Self {
        let view = NshView::new(mtm);
        view.setClipsToBounds(true);
        Self {
            view,
            id,
            control,
            asset_base,
            player: None,
            layer: None,
            controller: None,
            time_observer: None,
            end_observer: None,
            status: Rc::default(),
            props: VideoProps::default(),
            repeat: Rc::default(),
            audio_key: NEXT_AUDIO_KEY.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// The URL of `source`: `asset:/` URIs resolve against the app's assets.
    fn url(&self, source: &str) -> Option<Retained<NSURL>> {
        let resolved = match (source.strip_prefix("asset:/"), &self.asset_base) {
            (Some(path), Some(AssetBase::Http(base))) => format!("{base}{path}"),
            (Some(path), Some(AssetBase::Directory(dir))) => {
                return Some(NSURL::fileURLWithPath(&NSString::from_str(
                    &dir.join(path).to_string_lossy(),
                )));
            }
            _ => source.to_owned(),
        };
        NSURL::URLWithString(&NSString::from_str(&resolved))
    }

    pub(crate) fn configure(&mut self, p: VideoProps) {
        if !av_foundation() {
            return log::error!("cannot load AVFoundation");
        }
        if p.source != self.props.source || self.player.is_none() {
            self.open(p.source.as_deref());
        }
        if p.controls != self.props.controls || self.layer.is_none() && self.controller.is_none() {
            self.attach(p.controls);
        }
        if p.progress_interval_ms != self.props.progress_interval_ms || self.time_observer.is_none()
        {
            self.observe(p.progress_interval_ms);
        }
        self.repeat.set(p.repeat);
        if let Some(player) = &self.player {
            // SAFETY: AVPlayer's documented API.
            unsafe {
                let _: () = msg_send![player, setMuted: Bool::new(p.muted)];
                let _: () = msg_send![player, setVolume: p.volume];
                if p.paused {
                    let _: () = msg_send![player, pause];
                } else {
                    let _: () = msg_send![player, setRate: p.rate];
                }
            }
        }
        let gravity = NSString::from_str(match p.resize_mode {
            ResizeMode::Cover => "AVLayerVideoGravityResizeAspectFill",
            ResizeMode::Stretch => "AVLayerVideoGravityResize",
            _ => "AVLayerVideoGravityResizeAspect",
        });
        // SAFETY: AVPlayerLayer / AVPlayerViewController setters.
        unsafe {
            if let Some(layer) = &self.layer {
                let _: () = msg_send![layer, setVideoGravity: &*gravity];
            }
            if let Some(controller) = &self.controller {
                let _: () = msg_send![controller, setVideoGravity: &*gravity];
            }
        }
        // The audio session follows what plays, not what is mounted.
        let playing = self.player.is_some() && !p.paused;
        audio_playing(self.audio_key, playing.then_some(p.audio_session));
        self.props = p;
    }

    /// Starts playing `source` (or nothing).
    fn open(&mut self, source: Option<&str>) {
        self.close();
        let Some(url) = source.and_then(|s| self.url(s)) else {
            return;
        };
        let Some(cls) = class(c"AVPlayer") else {
            return;
        };
        // SAFETY: AVPlayer's documented API.
        let player: Retained<AnyObject> = unsafe { msg_send![cls, playerWithURL: &*url] };
        self.control
            .dispatch_event(self.id, EventKind::LoadStart, EventPayload::None);
        // The end of the item: report it, and loop if asked.
        // SAFETY: AVPlayer's documented API.
        let item: Option<Retained<AnyObject>> = unsafe { msg_send![&player, currentItem] };
        let (control, id, repeat) = (self.control.clone(), self.id, self.repeat.clone());
        let audio_key = self.audio_key;
        let weak_player = objc2::rc::Weak::from_retained(&player);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            control.dispatch_event(id, EventKind::End, EventPayload::None);
            if !repeat.get() {
                // It stopped: the other apps' audio may play again.
                audio_playing(audio_key, None);
            }
            if repeat.get()
                && let Some(player) = weak_player.load()
            {
                // SAFETY: AVPlayer's documented API.
                unsafe {
                    let _: () = msg_send![&player, seekToTime: CMTime::from_seconds(0.0)];
                    let _: () = msg_send![&player, play];
                }
            }
        });
        // SAFETY: a documented notification; the observer is removed in
        // `close`.
        self.end_observer = Some(unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str(
                    "AVPlayerItemDidPlayToEndTimeNotification",
                )),
                item.as_deref(),
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        });
        self.player = Some(player);
        self.status = Rc::default();
        self.attach(self.props.controls);
        self.time_observer = None;
        self.observe(self.props.progress_interval_ms);
        // Report the load even while paused (no time passes then).
        self.poll_load(0);
    }

    fn close(&mut self) {
        audio_playing(self.audio_key, None);
        if let (Some(player), Some(token)) = (&self.player, self.time_observer.take()) {
            // SAFETY: removes the observer this host added.
            let _: () = unsafe { msg_send![player, removeTimeObserver: &*token] };
        }
        if let Some(observer) = self.end_observer.take() {
            // SAFETY: an observer token of the default center.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
        }
        if let Some(player) = self.player.take() {
            // SAFETY: AVPlayer's documented API.
            let _: () = unsafe { msg_send![&player, pause] };
        }
        self.detach();
    }

    /// Shows the player in a layer, or with the platform's controls.
    fn attach(&mut self, controls: bool) {
        self.detach();
        let Some(player) = &self.player else { return };
        let bounds = self.view.bounds();
        // SAFETY: AVFoundation / AVKit's documented API, sent dynamically.
        unsafe {
            if controls
                && av_kit()
                && let Some(cls) = class(c"AVPlayerViewController")
            {
                let controller: Retained<AnyObject> = msg_send![cls, new];
                let _: () = msg_send![&controller, setPlayer: &**player];
                let _: () = msg_send![&controller, setShowsPlaybackControls: Bool::YES];
                let view: Option<Retained<UIView>> = msg_send![&controller, view];
                if let Some(view) = view {
                    view.setFrame(bounds);
                    view.setAutoresizingMask(
                        UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
                    );
                    self.view.addSubview(&view);
                }
                if let Some(parent) = crate::navigation::controller_of(&self.view) {
                    let child: &objc2_ui_kit::UIViewController =
                        &*(Retained::as_ptr(&controller) as *const _);
                    parent.addChildViewController(child);
                    child.didMoveToParentViewController(Some(&parent));
                }
                self.controller = Some(controller);
            } else if let Some(cls) = class(c"AVPlayerLayer") {
                let layer: Retained<AnyObject> = msg_send![cls, playerLayerWithPlayer: &**player];
                let ca: &objc2_quartz_core::CALayer = &*(Retained::as_ptr(&layer) as *const _);
                ca.setFrame(bounds);
                self.view.layer().addSublayer(ca);
                self.layer = Some(layer);
            }
        }
    }

    fn detach(&mut self) {
        // SAFETY: undoes `attach`.
        unsafe {
            if let Some(layer) = self.layer.take() {
                let ca: &objc2_quartz_core::CALayer = &*(Retained::as_ptr(&layer) as *const _);
                ca.removeFromSuperlayer();
            }
            if let Some(controller) = self.controller.take() {
                let child: &objc2_ui_kit::UIViewController =
                    &*(Retained::as_ptr(&controller) as *const _);
                child.willMoveToParentViewController(None);
                if let Some(view) = child.view() {
                    view.removeFromSuperview();
                }
                child.removeFromParentViewController();
            }
        }
    }

    /// Progress, load, buffering and failure reports while time passes.
    fn observe(&mut self, interval_ms: f32) {
        let Some(player) = &self.player else { return };
        if let Some(token) = self.time_observer.take() {
            // SAFETY: removes the observer this host added.
            let _: () = unsafe { msg_send![player, removeTimeObserver: &*token] };
        }
        let (control, id, status) = (self.control.clone(), self.id, self.status.clone());
        let weak = objc2::rc::Weak::from_retained(player);
        let block = RcBlock::new(move |time: CMTime| {
            let Some(player) = weak.load() else { return };
            report(&player, &control, id, &status);
            let duration = item_duration(&player);
            control.dispatch_event(
                id,
                EventKind::Progress,
                EventPayload::Map(vec![
                    ("currentTime", PayloadValue::Number(time.seconds().max(0.0))),
                    ("duration", PayloadValue::Number(duration)),
                ]),
            );
        });
        let interval = CMTime::from_seconds(interval_ms as f64 / 1000.0);
        // SAFETY: AVPlayer's documented API; a nil queue is the main queue.
        self.time_observer = Some(unsafe {
            msg_send![
                player,
                addPeriodicTimeObserverForInterval: interval,
                queue: std::ptr::null::<AnyObject>(),
                usingBlock: &*block
            ]
        });
    }

    /// Polls for the end of loading (a paused player reports no time).
    fn poll_load(&self, attempt: u32) {
        if let Some(player) = &self.player {
            poll(
                player,
                self.control.clone(),
                self.id,
                self.status.clone(),
                attempt,
            );
        }
    }

    /// Lays the player out at the view's size.
    pub(crate) fn layout(&self) {
        if let Some(layer) = &self.layer {
            // SAFETY: an AVPlayerLayer is a CALayer.
            let ca: &objc2_quartz_core::CALayer =
                unsafe { &*(Retained::as_ptr(layer) as *const _) };
            crate::decor::quiet_frame(ca, self.view.bounds());
        }
    }

    pub(crate) fn seek(&self, seconds: f64) {
        if let Some(player) = &self.player {
            let zero = CMTime::from_seconds(0.0);
            // SAFETY: AVPlayer's documented API.
            let _: () = unsafe {
                msg_send![player, seekToTime: CMTime::from_seconds(seconds), toleranceBefore: zero, toleranceAfter: zero]
            };
        }
    }
}

impl Drop for VideoHost {
    fn drop(&mut self) {
        self.close();
    }
}

/// Reports the player's state every 100ms until it loaded or failed (for
/// at most 30 seconds).
fn poll(player: &AnyObject, control: EngineControl, id: NodeId, status: Rc<Status>, attempt: u32) {
    report(player, &control, id, &status);
    if status.loaded.get() || status.failed.get() || attempt >= 300 {
        return;
    }
    let mtm = MainThreadMarker::new().expect("main thread");
    // SAFETY: AVPlayer is an NSObject.
    let weak = objc2::rc::Weak::from_retained(
        &unsafe { Retained::retain(player as *const _ as *mut AnyObject) }.expect("player"),
    );
    let state = dispatch2::MainThreadBound::new((weak, status), mtm);
    let when = dispatch2::DispatchTime::NOW.time(100_000_000);
    dispatch2::DispatchQueue::main()
        .after(when, move || {
            let mtm = MainThreadMarker::new().expect("main queue");
            let (weak, status) = state.into_inner(mtm);
            if let Some(player) = weak.load() {
                poll(&player, control, id, status, attempt + 1);
            }
        })
        .ok();
}

fn item_duration(player: &AnyObject) -> f64 {
    // SAFETY: AVPlayer / AVPlayerItem getters.
    unsafe {
        let item: Option<Retained<AnyObject>> = msg_send![player, currentItem];
        item.map_or(f64::NAN, |item| {
            let duration: CMTime = msg_send![&item, duration];
            duration.seconds()
        })
    }
}

/// Reports a finished load (once), a failure (once) and buffering changes.
fn report(player: &AnyObject, control: &EngineControl, id: NodeId, status: &Status) {
    // SAFETY: AVPlayer / AVPlayerItem getters.
    unsafe {
        let item: Option<Retained<AnyObject>> = msg_send![player, currentItem];
        let Some(item) = item else { return };
        let state: isize = msg_send![&item, status];
        if state == 1 && !status.loaded.replace(true) {
            let size: CGSize = msg_send![&item, presentationSize];
            control.dispatch_event(
                id,
                EventKind::Load,
                EventPayload::Map(vec![
                    ("duration", PayloadValue::Number(item_duration(player))),
                    ("width", PayloadValue::Number(size.width)),
                    ("height", PayloadValue::Number(size.height)),
                ]),
            );
        }
        if state == 2 && !status.failed.replace(true) {
            let error: Option<Retained<AnyObject>> = msg_send![&item, error];
            let message = error
                .map(|e| {
                    let d: Retained<NSString> = msg_send![&e, localizedDescription];
                    d.to_string()
                })
                .unwrap_or_else(|| "the video failed to load".to_owned());
            control.dispatch_event(
                id,
                EventKind::Error,
                EventPayload::Map(vec![("message", PayloadValue::Str(message))]),
            );
        }
        // 1: waiting to play at the requested rate.
        let control_status: isize = msg_send![player, timeControlStatus];
        let waiting = control_status == 1;
        if status.buffering.replace(waiting) != waiting {
            control.dispatch_event(
                id,
                EventKind::Buffer,
                EventPayload::Map(vec![("isBuffering", PayloadValue::Bool(waiting))]),
            );
        }
    }
}
