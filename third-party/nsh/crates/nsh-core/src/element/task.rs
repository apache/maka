//! Async tasks ([`super::spawn`]): futures run on the engine thread (they
//! may hold signals and other `!Send` handles) by a small executor of the
//! core, polled inside a tokio runtime's context, so the tokio ecosystem
//! works in them: network and file IO, channels; `Send` work goes to the
//! runtime's threads ([`super::background`]). Their timers
//! ([`super::timer`]) are the executor's own: the core fires them as they
//! come due and the engine's loop wakes for the soonest, as for JS's.
//! Wakers may fire on any thread: they wake the engine. A task changes
//! what it wants by writing signals; it ends with the owner it was made
//! under.

use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    rc::{Rc, Weak},
    sync::{Arc, Mutex},
    task::{Context as TaskContext, Poll, Wake, Waker},
    time::Duration,
};

use rustc_hash::FxHashMap;
use tokio::runtime::Handle;

use crate::{
    Command, Dialog, NodeId, ROOT_ID, StatusBarSetting,
    geometry::{DevicePixels, Size},
    time::Instant,
};

type LocalFuture = Pin<Box<dyn Future<Output = ()>>>;

/// Called when a task is woken (from any thread): the engine wakes up.
pub(crate) type Notify = Arc<dyn Fn() + Send + Sync>;

/// Tasks woken since the last run.
#[derive(Default)]
struct Ready {
    ids: Mutex<Vec<u64>>,
    notify: Mutex<Option<Notify>>,
}

struct TaskWaker {
    id: u64,
    ready: Arc<Ready>,
}

impl Wake for TaskWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.ready.ids.lock().expect("ready lock").push(self.id);
        let notify = self.ready.notify.lock().expect("notify lock").clone();
        if let Some(notify) = notify {
            notify();
        }
    }
}

/// What a component or a task asks of the platform, applied by the core.
pub(crate) enum Action {
    Command(NodeId, Command),
    /// The keyboard focus back to node `to` as `from` closes, unless the
    /// commit it goes out with moves it anywhere out of `from`
    /// ([`super::ElementRef::focus_back`]).
    FocusBack {
        to: NodeId,
        from: Option<NodeId>,
    },
    /// A popup that gives the keyboard focus back to node `to` opens: the
    /// core notes the focus and the input it opens with
    /// ([`super::ElementRef::focus_back_origin`]).
    FocusOrigin {
        to: NodeId,
    },
    /// A dialog; its answer resolves the slot.
    Dialog(Dialog, Rc<RefCell<Output<DialogReply>>>),
    /// Close the dialog whose answer resolves the slot, answering it as
    /// dismissed ([`DialogCloser::close`]).
    CloseDialog(Rc<RefCell<Output<DialogReply>>>),
    /// The result of a module function JS waits for.
    Return(u32, super::JsResult),
    /// The pixel size of the image at the URI (its bytes stay loaded); the
    /// answer resolves the slot.
    ImageInfo(String, AnswerSlot<Result<ImageSize, String>>),
    /// An HTTP request for the engine's network stack; the response (or
    /// its failure) resolves the slot.
    Fetch(
        Box<crate::platform::HttpRequest>,
        AnswerSlot<Result<super::services::HttpResponse, super::services::FetchFailure>>,
    ),
    /// Reads the system clipboard; the answer resolves the slot.
    ReadClipboard(ClipboardRead),
    /// Runs a function on the platform's main thread, after the commit.
    MainThread(crate::main_thread::MainThreadTask),
    /// Registers a font (TrueType, OpenType, WOFF or WOFF2 data); its family
    /// name, or why it is no font, resolves the slot.
    RegisterFont(Vec<u8>, AnswerSlot<Result<String, String>>),
    /// Shows the system's picker for images; the files picked (none when
    /// cancelled) resolve the slot.
    PickImages(
        crate::picker::PickRequest,
        AnswerSlot<Vec<crate::picker::PickedFile>>,
    ),
    /// Shows the system's picker for files of any type; the files picked
    /// (none when cancelled) resolve the slot.
    PickFiles(
        crate::picker::FilePickRequest,
        AnswerSlot<Vec<crate::picker::PickedFile>>,
    ),
    /// Calls function `name` of the embedding app (`nsh/host`); its
    /// value, or why it failed, resolves the slot.
    HostCall {
        name: String,
        args: crate::JsonValue,
        answer: AnswerSlot<Result<crate::JsonValue, crate::host_channel::HostError>>,
    },
    /// Hands data to function `name` of the embedding app, with no answer
    /// (`nsh/host`'s `post`).
    HostPost {
        name: String,
        args: crate::JsonValue,
    },
    /// Drops the slots of the host calls whose answers are gone (they
    /// timed out).
    ForgetHostCalls,
    /// Opens a URL outside the app (checked by
    /// [`crate::open_url::check_url`]); whether it opened resolves the
    /// slot.
    OpenUrl(String, AnswerSlot<bool>),
    /// Opens the app's own page in the system's settings
    /// ([`crate::mobile::open_app_settings`]); whether it opened, or why it
    /// could not, resolves the slot.
    OpenAppSettings(AnswerSlot<Result<bool, crate::mobile::AppSettingsError>>),
    /// Whether the platform opens the app's page in the system's settings
    /// resolves the slot.
    AppSettingsAvailable(AnswerSlot<bool>),
    /// Puts something on the system clipboard
    /// ([`crate::Command::SetClipboard`] or
    /// [`crate::Command::SetClipboardItem`]); the platform's result
    /// resolves the slot.
    WriteClipboard(crate::Command, AnswerSlot<ClipboardWrite>),
    /// Lets the user pick a color on the screen; the color (none when
    /// cancelled or not supported) resolves the slot.
    PickScreenColor(AnswerSlot<Option<crate::Hsla>>),
    /// Shows the system's share sheet ([`crate::share`]); how it ended, or
    /// why it could not share, resolves the slot.
    Share(
        crate::share::ShareRequest,
        AnswerSlot<Result<crate::share::ShareOutcome, crate::share::ShareError>>,
    ),
    /// Whether the platform shows a share sheet and the app's capabilities
    /// grant `share`.
    ShareAvailable(AnswerSlot<bool>),
    /// Opens a web sign-in session ([`crate::auth_session`]); how it ended,
    /// or why it could not run, resolves the slot.
    AuthSession(
        crate::auth_session::AuthSessionRequest,
        AnswerSlot<
            Result<crate::auth_session::AuthSessionOutcome, crate::auth_session::AuthSessionError>,
        >,
    ),
    /// Closes the app's waiting web sign-in session, answering it as
    /// cancelled ([`crate::element::close_auth_session`]).
    CloseAuthSession,
    /// Renders a drawing offscreen into an image
    /// ([`crate::canvas::render`]); the image's bytes, or why not, resolve
    /// the slot.
    RenderCanvas(
        Box<crate::canvas::render::RenderRequest>,
        AnswerSlot<Result<Vec<u8>, super::JsError>>,
    ),
    /// A notification's request ([`crate::notifications`]).
    Notification(NotificationAction),
    /// Reads whether the app launches at login (`None`) or turns it on
    /// (`Some(true)`) or off; whether it is on after it, or why it could
    /// not be read or changed, resolves the slot.
    LoginItem(
        Option<bool>,
        AnswerSlot<Result<bool, crate::desktop::LaunchAtLoginError>>,
    ),
    /// The next link the system hands the app ([`crate::url_scheme`])
    /// resolves the slot, those that came before first.
    NextUrlSchemeOpen(AnswerSlot<String>),
    /// The next files the system opens the app with
    /// ([`crate::file_type`]) resolve the slot, all that came before at
    /// once.
    NextOpenFiles(AnswerSlot<Vec<std::path::PathBuf>>),
    /// The next later launch of the app
    /// ([`crate::single_instance::SecondInstance`]) resolves the slot, those
    /// that came before first.
    NextSecondInstance(AnswerSlot<crate::single_instance::SecondInstance>),
    /// The next address move the app did not make
    /// ([`crate::url_scheme::AppUrlChange`]) resolves the slot.
    NextAppUrlChange(AnswerSlot<crate::url_scheme::AppUrlChange>),
    /// The app's address resolves the slot ([`crate::url_scheme`]).
    AppUrl(AnswerSlot<Option<String>>),
    /// The app sets its address ([`crate::url_scheme`]), replacing the
    /// history entry's or pushing one.
    SetAppUrl(String, crate::url_scheme::HistoryBehavior),
    /// A sound's or a player's request ([`crate::audio`]).
    Audio(AudioAction),
    /// Whether a web view's ref gives its page trusted input here
    /// (`sendInput`): the platform delivers it and the app holds
    /// `webview.input`; the answer resolves the slot.
    WebInputAvailable(AnswerSlot<bool>),
    /// Whether a web view's ref evaluates scripts here.
    WebEvaluateAvailable(AnswerSlot<bool>),
    /// Whether a web view shows a page here: the platform shows web views
    /// and the app holds `webview`; the answer resolves the slot.
    WebViewAvailable(AnswerSlot<bool>),
    /// A decision on a download ([`crate::webview::downloads`]): the
    /// destination to accept, a cancel, or a hand-over; its answer resolves
    /// the slot.
    DownloadDecision {
        /// The web view's node.
        node: NodeId,
        /// The download's id.
        id: String,
        /// What the app decided.
        decision: crate::webview::downloads::Decision,
        /// Where the decision's answer goes.
        answer: AnswerSlot<Result<(), String>>,
    },
    /// A request on local paths for the platform
    /// ([`crate::file_dialog`]); its answer resolves the slot.
    FileRequest(crate::file_dialog::FileRequest, FileAnswer),
    /// An operation on the native animation graph.
    Animation(crate::animation::AnimationOp),
    /// Starts an animation; its end resolves the slot.
    Animate {
        op: crate::animation::AnimationOp,
        animation: crate::animation::AnimationId,
        end: AnswerSlot<bool>,
    },
    /// Reads a node's value where it moves; the value resolves the slot.
    ReadValue {
        node: crate::animation::NodeId,
        value: AnswerSlot<f32>,
    },
    /// A component's own list reports the rows viewable now (they stayed
    /// so for its minimum view time).
    ReportViewable(NodeId),
    /// A hint overlay's delay is over with the pointer on its anchor: it
    /// shows.
    Hint(NodeId),
    /// The start of the next display frame resolves the slot.
    Frame(AnswerSlot<Instant>),
    /// Sets the app's appearance.
    Appearance(crate::platform::Appearance),
    /// Sets the app's design tokens.
    Tokens(super::Tokens),
    /// Sets the app's translations ([`crate::i18n`]).
    Translations(crate::i18n::Translations),
    /// Merges translations into the app's dictionary ([`crate::i18n`]).
    AddTranslations(std::collections::HashMap<String, std::collections::HashMap<String, String>>),
    /// The surface's translations changed in place from the given previous
    /// dictionary: re-localize menus if the selected language changed.
    TranslationsChanged(crate::i18n::Translations),
    /// Shows the app in a language whatever the user's (`None`: the
    /// user's again).
    Locale(Option<crate::platform::Locale>),
    /// Draws the scroll views' bars with the built-in bar the source makes
    /// of the theme, or (no theme) with the platform's indicator.
    BuiltInScrollbars(super::ScrollbarSource, Option<super::AnyValue>),
    /// Measures the node with the layout of the commit the action goes out
    /// with; the measurement resolves the slot.
    Measure(NodeId, AnswerSlot<Option<crate::Measurement>>),
    /// Measures where the list's viewport starts among its rows with the
    /// layout of the commit the action goes out with; the position
    /// resolves the slot.
    MeasureScrollPosition(NodeId, AnswerSlot<Option<crate::ListScrollPosition>>),
    /// Evaluates a web view's script within a timeout, with its answer
    /// kept by the core.
    Evaluate(
        NodeId,
        String,
        std::time::Duration,
        crate::platform::web_evaluation::Slot,
    ),
    /// Rejects a request that exceeded its deadline.
    WebEvaluationTimeout(u32),
    /// An offscreen canvas render's deadline passed.
    CanvasRenderTimeout(u32),
    /// How long the node's transitions run with the styles of the commit
    /// the action goes out with; the time resolves the slot.
    TransitionTime(NodeId, AnswerSlot<std::time::Duration>),
    /// The text the node shows with the commit the action goes out with;
    /// the text resolves the slot.
    TextContent(NodeId, AnswerSlot<String>),
    /// Presses what a pointer at the press's page position would inside
    /// the node, with the layout of the commit the action goes out with;
    /// whether a view took it resolves the slot.
    PressAt(NodeId, crate::PressEvent, AnswerSlot<bool>),
    /// Hovers what a pointer at the event's page position would inside
    /// the node, with the layout of the last commit; `None`: the pointer
    /// left.
    HoverAt(NodeId, Option<crate::MouseEvent>),
}

/// What a sound or a player asks of the core ([`Action::Audio`]).
pub(crate) enum AudioAction {
    /// Opens sound or player `id` (its first command, a
    /// [`crate::audio::AudioCommand::Load`] or
    /// [`crate::audio::AudioCommand::Open`]), reporting to `sink`.
    Open {
        command: crate::audio::AudioCommand,
        sink: crate::audio::AudioSink,
    },
    /// A command of an open sound or player; an unload or close ends it.
    Command(crate::audio::AudioCommand),
    /// Whether sound plays here; the answer resolves the slot.
    Available(AnswerSlot<bool>),
}

/// What the app asks about notifications ([`Action::Notification`]).
pub(crate) enum NotificationAction {
    /// The permission; with `ask`, the user is asked first when they were
    /// not yet. The answer resolves the slot.
    Permission {
        ask: bool,
        answer: AnswerSlot<crate::notifications::NotificationPermission>,
    },
    /// Shows a notification; whether the system took it resolves the slot.
    Show {
        notification: crate::notifications::Notification,
        answer: AnswerSlot<bool>,
    },
    /// Removes the notification called this.
    Close(String),
    /// Removes every notification of the app's.
    CloseAll,
    /// Sets the app's badge.
    SetBadge(u32),
    /// The id of the next notification pressed resolves the slot.
    NextPress(AnswerSlot<String>),
}

/// A request on local paths waiting for the platform's answer
/// ([`Action::FileRequest`]).
pub(crate) enum FileAnswer {
    /// The paths picked in the open dialog, none when cancelled.
    OpenDialog(AnswerSlot<Result<Option<Vec<std::path::PathBuf>>, String>>),
    /// The path chosen in the save dialog, none when cancelled.
    SaveDialog(AnswerSlot<Result<Option<std::path::PathBuf>, String>>),
    /// The path opened or showed in the file manager, or why not.
    Done(AnswerSlot<Result<(), String>>),
    /// Where the trashed item went, or why it was not.
    Trash(AnswerSlot<Result<Option<std::path::PathBuf>, String>>),
}

impl FileAnswer {
    /// Answers with the platform's `paths` (none: cancelled), or its
    /// `error`.
    pub(crate) fn deliver(self, mut paths: Vec<std::path::PathBuf>, error: Option<String>) {
        match self {
            FileAnswer::OpenDialog(slot) => slot.borrow_mut().deliver(match error {
                Some(error) => Err(error),
                None => Ok((!paths.is_empty()).then_some(paths)),
            }),
            FileAnswer::SaveDialog(slot) => slot.borrow_mut().deliver(match error {
                Some(error) => Err(error),
                None => Ok((!paths.is_empty()).then(|| paths.swap_remove(0))),
            }),
            FileAnswer::Done(slot) => slot.borrow_mut().deliver(match error {
                Some(error) => Err(error),
                None => Ok(()),
            }),
            FileAnswer::Trash(slot) => slot.borrow_mut().deliver(match error {
                Some(error) => Err(error),
                None => Ok((!paths.is_empty()).then(|| paths.swap_remove(0))),
            }),
        }
    }
}

/// A clipboard read waiting for the platform's answer.
pub(crate) enum ClipboardRead {
    /// The text (`""` when it holds none).
    Text(AnswerSlot<String>),
    /// The text for `Clipboard.readText`: `None` when the person refused
    /// the read (iOS's paste prompt answered with Don't Allow Paste).
    CheckedText(AnswerSlot<Option<String>>),
    /// Whether it holds text.
    Has(AnswerSlot<bool>),
    /// The image (`None` when it holds none, or one over
    /// [`crate::platform::clipboard::MAX_IMAGE_BYTES`]).
    Image(AnswerSlot<Option<ClipboardImage>>),
    /// The image for `Clipboard.readImage`: `Err` with the size in encoded
    /// bytes of one over [`crate::platform::clipboard::MAX_IMAGE_BYTES`].
    CheckedImage(AnswerSlot<Result<Option<ClipboardImage>, usize>>),
    /// Whether it holds an image.
    HasImage(AnswerSlot<bool>),
    /// The `file:` URLs of the local files on it.
    Files(AnswerSlot<Vec<String>>),
}

/// One item to put on the system clipboard (`Clipboard.write`): the same
/// content in several formats, as plain text and, for apps that paste
/// formatting, as HTML. Named as GPUI's `ClipboardItem` and the DOM's,
/// which also hold one item's representations; this one is a plain
/// object of its formats (`{ text, html? }`).
#[derive(Debug, Clone, Default, PartialEq, super::JsObject)]
#[prop(exact)]
#[non_exhaustive]
pub struct ClipboardItem {
    /// The content as plain text.
    pub text: String,
    /// The content as HTML (a fragment, as `text/html` on the web holds).
    #[prop(skip_none)]
    pub html: Option<String>,
}

/// What became of a clipboard write (`set_clipboard`,
/// `set_clipboard_item`; TS: what `Clipboard.writeText` and
/// `Clipboard.write` resolve to). The clipboard is never read back to
/// find out: a platform that cannot tell answers [`Self::Requested`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, crate::element::PropEnum)]
pub enum ClipboardWrite {
    /// The system clipboard took it (Windows, macOS, the web).
    Written,
    /// The system clipboard refused it (held by another app, no clipboard,
    /// the browser declined, the clipboard capability not granted).
    Failed,
    /// Handed to the system, which does not say whether it took it (iOS,
    /// Android, Linux, a GPUI host, a terminal).
    #[default]
    Requested,
}

/// An image read from the system clipboard (`Clipboard.readImage`).
#[derive(Debug, Clone, Default, PartialEq, super::JsObject)]
pub struct ClipboardImage {
    /// A URL of the image that an `Image` shows (its `src`) and `fetch`
    /// reads the bytes of; `Clipboard.writeImage` takes it back.
    pub url: String,
    /// Its size in pixels, as decoded.
    pub size: Size<DevicePixels>,
}

/// An image's size in pixels (`Image.getSize`); TS: `PixelSize`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ImageSize {
    /// Width.
    pub width: DevicePixels,
    /// Height.
    pub height: DevicePixels,
}

impl ImageSize {
    /// As a [`Size`].
    pub fn size(&self) -> Size<DevicePixels> {
        Size::new(self.width, self.height)
    }
}

impl From<ImageSize> for Size<DevicePixels> {
    fn from(s: ImageSize) -> Self {
        s.size()
    }
}

/// TS: `PixelSize` (`{ width, height }`).
impl super::JsValue for ImageSize {
    fn ts_type(types: &mut super::TsTypes) -> String {
        <Size<DevicePixels> as super::JsValue>::ts_type(types)
    }

    fn from_js(value: super::JsIn<'_>) -> Result<Self, super::PropError> {
        if value.kind() != super::JsKind::Object {
            return Err(value.expected("an object"));
        }
        let side = |key: &str| -> Result<DevicePixels, super::PropError> {
            let v = value.field(key)?;
            DevicePixels::from_js(v.get()).map_err(|e| super::PropError(format!("`{key}`: {e}")))
        };
        Ok(ImageSize {
            width: side("width")?,
            height: side("height")?,
        })
    }

    fn to_js<'a>(
        &self,
        host: &'a dyn super::JsHost,
    ) -> Result<super::JsOwned<'a>, super::PropError> {
        let owned = super::JsOwned::new(host, host.new_object()?);
        let object = owned.get().raw();
        host.set_field(object, "width", self.width.to_js(host)?.into_raw())?;
        host.set_field(object, "height", self.height.to_js(host)?.into_raw())?;
        Ok(owned)
    }
}

/// The status bar's base setting, as a command for the surface's root.
pub(crate) fn status_bar(patch: StatusBarSetting) -> Action {
    Action::Command(ROOT_ID, Command::SetStatusBar(patch))
}

struct Entry {
    host: NodeId,
    /// Out while it is polled.
    future: Option<LocalFuture>,
}

#[derive(Default)]
struct Inner {
    tasks: FxHashMap<u64, Entry>,
    next_task: u64,
    actions: VecDeque<Action>,
    failures: Vec<(NodeId, String)>,
}

/// The executor of one core's component tasks.
#[derive(Default)]
pub(crate) struct Executor {
    inner: RefCell<Inner>,
    ready: Arc<Ready>,
    /// The runtime tasks are polled in the context of.
    runtime: RefCell<Option<Handle>>,
    /// Native animation nodes and animations made so far (their ids are
    /// odd: JS's are even).
    animation_ids: std::cell::Cell<u32>,
    /// Live derived nodes, for what derives them again (a region or a row
    /// made again).
    derived: RefCell<super::animated::Derived>,
    /// The components' listeners of the back button.
    pub(crate) back: Rc<RefCell<super::back::BackListeners>>,
    /// The components' listeners of the back gesture's steps.
    pub(crate) back_progress: Rc<RefCell<super::back::BackProgressListeners>>,
    /// The components' listeners of the host's events
    /// ([`super::on_host_event`]).
    pub(crate) host_events: Rc<RefCell<super::host_events::HostListeners>>,
    /// What runs as the app quits ([`super::desktop::on_app_quit`]).
    pub(crate) quit: Rc<RefCell<super::quit::QuitListeners>>,
    /// The quit listeners' work still running ([`crate::Core::start_quit`]).
    pub(crate) quitting: Rc<std::cell::Cell<usize>>,
    /// The JS calls of an `async fn` into Rust still running (a native
    /// module's or a class's): what they wait on answers from elsewhere.
    pub(crate) calls: Rc<std::cell::Cell<usize>>,
    /// What hears the user ask to quit ([`super::desktop::on_quit_request`]).
    pub(crate) quit_requests: Rc<RefCell<super::quit::QuitRequestListeners>>,
    /// What hears the OS ask the app to show itself
    /// ([`super::desktop::on_reopen`]).
    pub(crate) reopens: Rc<RefCell<super::quit::ReopenListeners>>,
    /// What hears the app's last window close
    /// ([`super::desktop::on_last_window_closed`]).
    pub(crate) last_window_closed: Rc<RefCell<super::quit::LastWindowClosedListeners>>,
    /// The views' keyboard shortcuts.
    pub(crate) keys: Rc<RefCell<super::keys::ViewKeys>>,
    /// The views' menus' handlers.
    pub(crate) menus: Rc<RefCell<super::menus::ViewMenus>>,
    /// The views' watches of nodes they did not make.
    pub(crate) watches: Rc<RefCell<super::watch::Watches>>,
    /// The timers tasks wait for ([`super::timer`]): the core fires them as
    /// they come due, and the engine's loop wakes for the soonest, as it does
    /// for JS's timers.
    timers: Arc<Timers>,
    /// What waits for the app to answer the events emitted before it
    /// ([`super::after_answer`]).
    answers: RefCell<Answers>,
    /// What waits for the views of the commit being made
    /// ([`super::after_render`]).
    rendered: RefCell<Vec<AfterAnswer>>,
    /// The engine's sounds ([`super::audio`]).
    pub(crate) sounds: RefCell<super::audio::Sounds>,
}

/// The closures of [`super::after_answer`], by how far their events went.
#[derive(Default)]
struct Answers {
    /// Their events have not been handed to JS yet.
    waiting: Vec<AfterAnswer>,
    /// Their events went to JS: they run in the next commit, by when JS has
    /// handled them and its ops are applied.
    due: Vec<AfterAnswer>,
}

/// A closure of [`super::after_answer`] or [`super::after_render`] and the
/// owner it runs under.
pub(crate) struct AfterAnswer {
    pub(crate) owner: super::Owner,
    pub(crate) f: Box<dyn FnOnce()>,
}

/// The timers tasks wait for, soonest first (in the order they were made
/// among timers due at once). Shared with the [`TimerKey`]s of the delays
/// waiting (which are `Send`, as delays are), so a delay dropped before its
/// time takes its timer and waker back at once, wherever it is dropped.
#[derive(Default)]
struct Timers(Mutex<TimerQueue>);

#[derive(Default)]
struct TimerQueue {
    next_seq: u64,
    wakers: BTreeMap<(Instant, u64), Waker>,
}

impl Timers {
    fn queue(&self) -> std::sync::MutexGuard<'_, TimerQueue> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A timer waiting in the executor ([`Executor::add_timer`]); dropping it
/// takes the timer back.
#[derive(Debug)]
pub(crate) struct TimerKey {
    timers: std::sync::Weak<Timers>,
    key: (Instant, u64),
}

impl TimerKey {
    /// Wakes `waker` instead when the timer fires (the delay was polled
    /// again by another task's waker).
    pub(crate) fn set_waker(&self, waker: &Waker) {
        let Some(timers) = self.timers.upgrade() else {
            return;
        };
        let old = {
            let mut queue = timers.queue();
            match queue.wakers.get_mut(&self.key) {
                Some(kept) if !kept.will_wake(waker) => {
                    Some(std::mem::replace(kept, waker.clone()))
                }
                _ => None,
            }
        };
        // Dropped outside the lock.
        drop(old);
    }
}

impl Drop for TimerKey {
    fn drop(&mut self) {
        let Some(timers) = self.timers.upgrade() else {
            return;
        };
        let waker = timers.queue().wakers.remove(&self.key);
        drop(waker);
    }
}

impl Executor {
    /// The derived nodes and their handles.
    pub(crate) fn derived(&self) -> std::cell::RefMut<'_, super::animated::Derived> {
        self.derived.borrow_mut()
    }

    /// Wakes `waker` at `at`, unless the key is dropped first.
    pub(crate) fn add_timer(&self, at: Instant, waker: Waker) -> TimerKey {
        let mut queue = self.timers.queue();
        let key = (at, queue.next_seq);
        queue.next_seq += 1;
        queue.wakers.insert(key, waker);
        TimerKey {
            timers: Arc::downgrade(&self.timers),
            key,
        }
    }

    /// When the soonest timer is due.
    pub(crate) fn next_timer(&self) -> Option<Instant> {
        self.timers
            .queue()
            .wakers
            .first_key_value()
            .map(|(&(at, _), _)| at)
    }

    /// Wakes the timers due at `now`.
    pub(crate) fn fire_timers(&self, now: Instant) {
        let mut due = Vec::new();
        {
            let mut queue = self.timers.queue();
            while let Some(timer) = queue.wakers.first_entry()
                && timer.key().0 <= now
            {
                due.push(timer.remove());
            }
        }
        // Woken outside the lock: a waker may drop delays.
        for waker in due {
            waker.wake();
        }
    }

    /// A new id for a native animation node or animation.
    pub(crate) fn next_animation_id(&self) -> u32 {
        let n = self.animation_ids.get();
        self.animation_ids.set(n + 1);
        2 * n + 1
    }

    pub(crate) fn set_runtime(&self, runtime: Handle) {
        *self.runtime.borrow_mut() = Some(runtime);
    }

    /// The runtime tasks are polled in the context of, if one is set.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn runtime(&self) -> Option<Handle> {
        self.runtime.borrow().clone()
    }

    pub(crate) fn set_notify(&self, notify: Notify) {
        *self.ready.notify.lock().expect("notify lock") = Some(notify);
    }

    fn spawn(&self, host: NodeId, future: LocalFuture) -> u64 {
        let id = {
            let mut inner = self.inner.borrow_mut();
            inner.next_task += 1;
            let id = inner.next_task;
            inner.tasks.insert(
                id,
                Entry {
                    host,
                    future: Some(future),
                },
            );
            id
        };
        // Polled at the next run, not inside the code that spawned it.
        self.ready.ids.lock().expect("ready lock").push(id);
        let notify = self.ready.notify.lock().expect("notify lock").clone();
        if let Some(notify) = notify {
            notify();
        }
        id
    }

    fn cancel(&self, id: u64) {
        let removed = self.inner.borrow_mut().tasks.remove(&id);
        // Dropped outside the borrow: the future may own other tasks.
        drop(removed);
    }

    /// Polls the woken tasks; returns whether there were any.
    pub(crate) fn poll_ready(&self) -> bool {
        let mut ids = std::mem::take(&mut *self.ready.ids.lock().expect("ready lock"));
        if ids.is_empty() {
            return false;
        }
        ids.sort_unstable();
        ids.dedup();
        // tokio's timers, IO and `spawn` find their runtime here.
        let runtime = self.runtime.borrow().clone();
        let _context = runtime.as_ref().map(Handle::enter);
        for id in ids {
            let future = match self.inner.borrow_mut().tasks.get_mut(&id) {
                Some(entry) => entry.future.take(),
                None => None,
            };
            let Some(mut future) = future else { continue };
            let waker = Waker::from(Arc::new(TaskWaker {
                id,
                ready: self.ready.clone(),
            }));
            let done = match super::component::caught(|| {
                future
                    .as_mut()
                    .poll(&mut TaskContext::from_waker(&waker))
                    .is_ready()
            }) {
                Ok(done) => done,
                // A task that panicked ends; its component failed.
                Err(message) => {
                    let mut inner = self.inner.borrow_mut();
                    if let Some(entry) = inner.tasks.get(&id) {
                        let host = entry.host;
                        inner.failures.push((host, message));
                    }
                    true
                }
            };
            if done {
                self.inner.borrow_mut().tasks.remove(&id);
                drop(future);
            } else if let Some(entry) = self.inner.borrow_mut().tasks.get_mut(&id) {
                entry.future = Some(future);
            }
        }
        true
    }

    #[cfg(test)]
    pub(crate) fn task_count(&self) -> usize {
        self.inner.borrow().tasks.len()
    }

    /// The tasks that panicked since, by component.
    pub(crate) fn take_failures(&self) -> Vec<(NodeId, String)> {
        std::mem::take(&mut self.inner.borrow_mut().failures)
    }

    /// What tasks asked of the platform.
    pub(crate) fn take_actions(&self) -> VecDeque<Action> {
        std::mem::take(&mut self.inner.borrow_mut().actions)
    }

    pub(crate) fn act(&self, action: Action) {
        self.inner.borrow_mut().actions.push_back(action);
        let notify = self.ready.notify.lock().expect("notify lock").clone();
        if let Some(notify) = notify {
            notify();
        }
    }

    /// Keeps `answer` until the events emitted so far have been handed to
    /// JS and handled ([`super::after_answer`]).
    pub(crate) fn after_answer(&self, answer: AfterAnswer) {
        self.answers.borrow_mut().waiting.push(answer);
    }

    /// The events emitted so far go to JS: what waited for them is due.
    pub(crate) fn hand_answers(&self) {
        let mut answers = self.answers.borrow_mut();
        let Answers { waiting, due } = &mut *answers;
        if !waiting.is_empty() {
            due.append(waiting);
        }
    }

    /// Whether closures wait for the next commit to run.
    pub(crate) fn has_due_answers(&self) -> bool {
        !self.answers.borrow().due.is_empty()
    }

    /// Whether the queues ever held a closure (they allocate on the first).
    #[cfg(test)]
    pub(crate) fn answers_allocated(&self) -> bool {
        let answers = self.answers.borrow();
        answers.waiting.capacity() > 0 || answers.due.capacity() > 0
    }

    /// The closures whose events JS has handled, in order.
    pub(crate) fn take_due_answers(&self) -> Vec<AfterAnswer> {
        std::mem::take(&mut self.answers.borrow_mut().due)
    }

    /// Keeps `f` until the components of the commit being made have
    /// rendered ([`super::after_render`]).
    pub(crate) fn after_render(&self, f: AfterAnswer) {
        self.rendered.borrow_mut().push(f);
    }

    /// The closures waiting for the commit's views, in order.
    pub(crate) fn take_rendered(&self) -> Vec<AfterAnswer> {
        std::mem::take(&mut self.rendered.borrow_mut())
    }
}

/// A running task of the core. Dropping it cancels the
/// task (TS's `clearTimeout`, for timers); [`Task::detach`] lets it run
/// on its own. Awaited in another task, it gives the task's output.
#[must_use = "a dropped task is cancelled: keep it, or detach it"]
pub struct Task<T> {
    executor: Weak<Executor>,
    id: u64,
    output: Rc<RefCell<Output<T>>>,
    detached: bool,
}

/// A value a future waits for, and the waker to call when it comes.
pub(crate) struct Output<T> {
    pub(crate) value: Option<T>,
    pub(crate) waker: Option<Waker>,
}

/// Where an [`Answer`] comes from.
pub(crate) type AnswerSlot<T> = Rc<RefCell<Output<T>>>;

impl<T> Default for Output<T> {
    fn default() -> Self {
        Self {
            value: None,
            waker: None,
        }
    }
}

impl<T> Output<T> {
    /// Delivers `value`, waking the future waiting for it.
    pub(crate) fn deliver(&mut self, value: T) {
        self.value = Some(value);
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }
}

/// The answer the platform gives to a request (a dialog, an image's size),
/// awaited in a task.
#[must_use = "an answer does nothing unless awaited"]
pub struct Answer<T> {
    slot: Rc<RefCell<Output<T>>>,
}

/// The answer to a dialog (`nsh_base::alert_dialog`): the button pressed
/// and the text of its text field.
pub type DialogAnswer = Answer<DialogReply>;

/// What the platform answered a dialog with ([`DialogAnswer`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct DialogReply {
    /// The index of the button pressed, -1 when it closed without one.
    pub index: i32,
    /// The text of its text field ([`crate::Dialog::input`]); `None`
    /// without one, where the platform's alert has none, or when the app
    /// closed it ([`DialogCloser`]).
    pub value: Option<String>,
}

impl DialogReply {
    /// Closed without a button or text.
    pub fn dismissed() -> Self {
        Self {
            index: -1,
            value: None,
        }
    }
}

impl<T> Answer<T> {
    pub(crate) fn new() -> (Self, Rc<RefCell<Output<T>>>) {
        let slot = Rc::new(RefCell::new(Output::default()));
        (Self { slot: slot.clone() }, slot)
    }
}

impl Answer<DialogReply> {
    /// What closes the dialog this answer waits for, kept apart from the
    /// answer (which a task usually takes): see [`DialogCloser`].
    pub fn closer(&self) -> DialogCloser {
        DialogCloser {
            slot: self.slot.clone(),
        }
    }
}

/// Closes a dialog the app showed (`nsh_base::alert_dialog`) without the
/// user, as when what it asks about went away (the user went elsewhere):
/// made by [`Answer::closer`].
#[derive(Clone)]
pub struct DialogCloser {
    slot: Rc<RefCell<Output<DialogReply>>>,
}

impl std::fmt::Debug for DialogCloser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialogCloser").finish_non_exhaustive()
    }
}

impl DialogCloser {
    /// Closes the dialog, as if the user dismissed it: its answer resolves
    /// with -1 (and no text) now, and the platform takes it off the screen. Nothing
    /// happens once it was answered, or outside the engine.
    pub fn close(&self) {
        super::ambient::act_if_running(Action::CloseDialog(self.slot.clone()));
    }
}

impl<T> std::fmt::Debug for Answer<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Answer").finish_non_exhaustive()
    }
}

impl<T> Future for Answer<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<T> {
        let mut slot = self.slot.borrow_mut();
        match slot.value.take() {
            Some(value) => Poll::Ready(value),
            None => {
                slot.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl<T> std::fmt::Debug for Task<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Task")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl<T> Task<T> {
    /// Lets the task run to its end without this handle (it still ends
    /// with its component).
    pub fn detach(mut self) {
        self.detached = true;
    }
}

impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        if !self.detached
            && let Some(executor) = self.executor.upgrade()
        {
            executor.cancel(self.id);
        }
    }
}

impl<T> Future for Task<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<T> {
        let mut output = self.output.borrow_mut();
        match output.value.take() {
            Some(value) => Poll::Ready(value),
            None => {
                output.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

/// Starts `future` as a task of `host`, to run to its end.
pub(crate) fn spawn_raw(executor: &Rc<Executor>, host: NodeId, future: LocalFuture) -> u64 {
    executor.spawn(host, future)
}

/// Applies `action` after `delay`, as a task of `host` (dropping the task
/// cancels it).
pub(crate) fn act_after(
    executor: &Rc<Executor>,
    host: NodeId,
    delay: Duration,
    action: Action,
) -> Task<()> {
    let weak = Rc::downgrade(executor);
    let acting = weak.clone();
    // From now, not from when the task is first polled.
    let at = crate::time::now() + delay;
    let id = executor.spawn(
        host,
        Box::pin(async move {
            super::timer_until(at).await;
            if let Some(executor) = acting.upgrade() {
                executor.act(action);
            }
        }),
    );
    Task {
        executor: weak,
        id,
        output: Rc::new(RefCell::new(Output::default())),
        detached: false,
    }
}

/// Starts `future` on the engine thread, with no component (a task of a
/// component that runs once: its owner ends it, [`TaskHandle::cancel`]).
/// The task is detached: dropping it does not cancel it.
pub(crate) fn spawn_future<R: 'static>(
    executor: &Rc<Executor>,
    future: impl Future<Output = R> + 'static,
) -> Task<R> {
    let weak = Rc::downgrade(executor);
    let output = Rc::new(RefCell::new(Output {
        value: None,
        waker: None,
    }));
    let done = output.clone();
    let id = executor.spawn(
        0,
        Box::pin(async move {
            let value = future.await;
            let mut output = done.borrow_mut();
            output.value = Some(value);
            if let Some(waker) = output.waker.take() {
                waker.wake();
            }
        }),
    );
    Task {
        executor: weak,
        id,
        output,
        detached: true,
    }
}

/// What cancels a task, apart from its handle.
pub(crate) struct TaskHandle {
    executor: Weak<Executor>,
    id: u64,
}

impl TaskHandle {
    /// Ends the task (nothing when it ended already).
    pub(crate) fn cancel(&self) {
        if let Some(executor) = self.executor.upgrade() {
            executor.cancel(self.id);
        }
    }
}

impl<T> Task<T> {
    /// What cancels it.
    pub(crate) fn handle(&self) -> TaskHandle {
        TaskHandle {
            executor: self.executor.clone(),
            id: self.id,
        }
    }
}
