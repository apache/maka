//! What components that run once read of the surface and ask of the
//! platform, as free functions (TS: `nsh`'s accessors and modules).
//!
//! The environment, the design tokens, globals and screens' insets are signals the
//! core writes: reading one in a binding subscribes it, so a change reaches
//! only what read it. Services (dialogs, the clipboard) are actions
//! for the core; tasks and timers belong to the current owner and end with
//! it.

use std::{
    any::{Any, TypeId},
    future::Future,
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::Duration,
};

use rustc_hash::FxHashMap;

use super::{
    AdaptiveColor, Environment, Memo, Owner, Signal, SignalEquals, Tokens, cleanup, computed,
    reactive::with_data,
    signal_with,
    task::{self, Action, Answer, ClipboardImage, DialogAnswer, Executor, FileAnswer, ImageSize},
};
use crate::{
    Command, Dialog, EdgeInsets, LayoutAnimation, NodeId, Points, Size,
    canvas::CanvasFont,
    color::Hsla,
    platform::{Appearance, Idiom, Locale, Os, Renderer},
    time::Instant,
};

/// How text is measured on one line, in a canvas font.
pub(crate) type MeasureFn = Rc<dyn Fn(&CanvasFont, &str) -> crate::canvas::TextMetrics>;

/// What the core gives components that run once.
#[derive(Default)]
pub(crate) struct Ambient {
    executor: Option<Rc<Executor>>,
    env: Option<EnvSignals>,
    tokens: Option<Signal<Arc<Tokens>>>,
    globals: FxHashMap<TypeId, Box<dyn Any>>,
    /// The insets of the screens or modals components are on, by host.
    insets: FxHashMap<NodeId, Signal<EdgeInsets>>,
    measure: Option<MeasureFn>,
    /// The app's key-value storage (`nsh/storage`).
    storage: Option<crate::storage::Store>,
}

impl Ambient {
    /// The hosts whose insets components read.
    pub(crate) fn inset_hosts(&self) -> Vec<NodeId> {
        self.insets.keys().copied().collect()
    }
}

/// The environment as a signal, and a memo per part (a change notifies only
/// the readers of the parts that changed).
struct EnvSignals {
    env: Signal<Environment>,
    window: Memo<Size<Points>>,
    safe_area: Memo<EdgeInsets>,
    title_bar: Memo<crate::geometry::Edges<crate::geometry::Points>>,
    keyboard_height: Memo<Points>,
    keyboard_duration: Memo<f32>,
    dark: Memo<bool>,
    font_scale: Memo<f32>,
    reduce_motion: Memo<bool>,
    screen_reader: Memo<bool>,
    pixel_ratio: Memo<f32>,
    locale: Memo<Locale>,
    screen_color: Memo<bool>,
}

impl EnvSignals {
    fn new(env: Environment) -> Self {
        Owner::detached().run(|| {
            let signal = super::signal(env);
            macro_rules! part {
                ($field:ident) => {
                    computed(move || signal.with(|e| e.$field))
                };
            }
            Self {
                env: signal,
                window: part!(window),
                safe_area: part!(safe_area),
                title_bar: part!(title_bar),
                keyboard_height: part!(keyboard_height),
                keyboard_duration: part!(keyboard_duration),
                dark: part!(dark),
                font_scale: part!(font_scale),
                reduce_motion: part!(reduce_motion),
                screen_reader: part!(screen_reader),
                pixel_ratio: part!(pixel_ratio),
                locale: part!(locale),
                screen_color: part!(screen_color),
            }
        })
    }
}

// --- What the core sets ------------------------------------------------------

impl super::Runtime {
    /// The executor of tasks and actions.
    pub(crate) fn set_services(&self, executor: Rc<Executor>) {
        let _entered = self.enter();
        with_data(|d| d.ambient.executor = Some(executor));
    }

    /// Where the app's storage is kept.
    pub(crate) fn set_storage(&self, storage: crate::storage::Store) {
        let _entered = self.enter();
        with_data(|d| d.ambient.storage = Some(storage));
    }

    /// How text is measured (the core's text engine).
    pub(crate) fn set_measure(&self, measure: MeasureFn) {
        let _entered = self.enter();
        with_data(|d| d.ambient.measure = Some(measure));
    }

    /// The environment now: what read a part that changed runs again.
    pub(crate) fn set_environment(&self, env: Environment) {
        let _entered = self.enter();
        let signal = with_data(|d| d.ambient.env.as_ref().map(|e| e.env));
        match signal {
            Some(signal) => signal.set(env),
            None => {
                let signals = EnvSignals::new(env);
                with_data(|d| d.ambient.env = Some(signals));
            }
        }
    }

    /// The design tokens now: what read them runs again.
    pub(crate) fn set_tokens(&self, tokens: Arc<Tokens>) {
        let _entered = self.enter();
        let signal = with_data(|d| d.ambient.tokens);
        match signal {
            Some(signal) => signal.set(tokens),
            None => {
                let signal = Owner::detached().run(|| signal_with(tokens, SignalEquals::Never));
                with_data(|d| d.ambient.tokens = Some(signal));
            }
        }
    }

    /// The hosts whose insets components read.
    pub(crate) fn inset_hosts(&self) -> Vec<NodeId> {
        let _entered = self.enter();
        with_data(|d| d.ambient.inset_hosts())
    }

    /// The insets of the screen or modal `host` is on.
    pub(crate) fn set_insets(&self, host: NodeId, insets: EdgeInsets) {
        let _entered = self.enter();
        if let Some(signal) = with_data(|d| d.ambient.insets.get(&host).copied()) {
            signal.set(insets);
        }
    }

    /// `host` goes: its insets are no longer read.
    pub(crate) fn forget_host(&self, host: NodeId) {
        let _entered = self.enter();
        with_data(|d| d.ambient.insets.remove(&host));
    }
}

fn env<T: Clone + 'static>(part: impl FnOnce(&EnvSignals) -> Memo<T>) -> T {
    let memo = with_data(|d| d.ambient.env.as_ref().map(part));
    memo.expect("the core sets the environment before components run")
        .get()
}

fn executor() -> Rc<Executor> {
    with_data(|d| d.ambient.executor.clone()).expect("the core sets the executor")
}

fn act(action: Action) {
    executor().act(action);
}

// --- The environment ---------------------------------------------------------

/// The surface's size in points (TS: `windowSize()`).
pub fn window() -> Size<Points> {
    env(|e| e.window)
}

/// The edges system UI covers: notch, home indicator (TS: `safeArea()`).
pub fn safe_area() -> EdgeInsets {
    env(|e| e.safe_area)
}

/// The software keyboard's height over the surface, 0 when hidden (TS:
/// `keyboardFrame().height`).
pub fn keyboard_height() -> Points {
    env(|e| e.keyboard_height)
}

/// How long the keyboard's show / hide animation takes, in milliseconds.
pub fn keyboard_duration() -> f32 {
    env(|e| e.keyboard_duration)
}

/// Dark appearance (TS: `colorScheme() === "dark"`). Theme colors follow
/// it without this; read it for anything else.
pub fn dark() -> bool {
    env(|e| e.dark)
}

/// `color` for the appearance now (props that take one color, such as an
/// input's placeholder color; styles take theme colors as they are).
pub fn color(color: impl Into<AdaptiveColor>) -> Hsla {
    let color = color.into();
    if dark() { color.dark } else { color.light }
}

/// The user's text size relative to the default (TS: `fontScale()`).
pub fn font_scale() -> f32 {
    env(|e| e.font_scale)
}

/// The user asked for less motion (TS: `reduceMotion()`).
pub fn reduce_motion() -> bool {
    env(|e| e.reduce_motion)
}

/// A screen reader runs (TS: `screenReaderEnabled()`).
pub fn screen_reader() -> bool {
    env(|e| e.screen_reader)
}

/// Device pixels per point (TS: `pixelRatio()`).
pub fn pixel_ratio() -> f32 {
    env(|e| e.pixel_ratio)
}

/// `points` rounded to whole device pixels (TS:
/// `Math.round(x * pixelRatio()) / pixelRatio()`).
pub fn round_to_nearest_pixel(points: Points) -> Points {
    let ratio = pixel_ratio().max(f32::MIN_POSITIVE);
    Points((points.0 * ratio).round() / ratio)
}

/// The user's locale (TS: what `Intl` formats for by default).
pub fn locale() -> Locale {
    env(|e| e.locale)
}

/// The operating system (TS: `platform.os`); it does not change.
pub fn os() -> Os {
    with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .expect("the core sets the environment")
        .with_untracked(|e| e.os)
}

/// [`os`] where an engine runs (its thread, while it runs Rust code),
/// else `None`: for code that also runs outside an engine (a unit test of
/// a component's model).
pub fn try_os() -> Option<Os> {
    super::reactive::try_with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .flatten()
        .map(|env| env.with_untracked(|e| e.os))
}

/// The OS version: major and minor on iOS, the API level and 0 on Android
/// (TS: `platform.version`).
pub fn os_version() -> (u16, u16) {
    with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .expect("the core sets the environment")
        .with_untracked(|e| e.os_version)
}

/// The kind of device (TS: `platform.idiom`, [`Idiom::reported_on`]). A
/// terminal retains its host device idiom while [`is_desktop`] is false.
pub fn idiom() -> Idiom {
    with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .expect("the core sets the environment")
        .with_untracked(|e| e.idiom.reported_on(e.os))
}

/// How the surface presents its UI (TS: `platform.renderer`); it does not change.
pub fn renderer() -> Renderer {
    with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .expect("the core sets the environment")
        .with_untracked(|e| e.renderer)
}

/// Whether this surface renders in terminal cells (TS: `platform.isTerminal`).
pub fn is_terminal() -> bool {
    renderer() == Renderer::Terminal
}

/// Whether the app runs under Mac Catalyst, in every idiom (TS:
/// `platform.catalyst`, [`Os::is_catalyst`]); Catalyst is mobile, not
/// desktop.
pub fn is_catalyst() -> bool {
    os().is_catalyst()
}

/// Whether graphical desktop behavior applies (TS: `platform.desktop`): a
/// desktop OS with a graphical renderer, or a browser in the desktop idiom.
pub fn is_desktop() -> bool {
    with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .expect("the core sets the environment")
        .with_untracked(|e| e.renderer != Renderer::Terminal && e.idiom.desktop_on(e.os))
}

/// The design tokens the app is drawn with (reading them subscribes: new
/// tokens reach what read them).
pub fn tokens() -> Arc<Tokens> {
    with_data(|d| d.ambient.tokens)
        .expect("the core sets the tokens")
        .get()
}

/// Draws the app with the design tokens `tokens` (the app's own, which an
/// embedding app's still win over), in place of the UI set's defaults or
/// the theme file's: Tailwind's token classes, [`tokens`] and the
/// platform's own controls (Linux's menus) follow. An app that picks its
/// theme while it runs sets it here (`set_tokens(theme.into())` of an
/// `nsh_base::Theme`).
pub fn set_tokens(tokens: impl Into<Tokens>) {
    act(Action::Tokens(tokens.into()));
}

/// The width of `text` on one line in `font` (the CSS `font` shorthand; an
/// invalid one measures in `10px sans-serif`), by the platform's text engine
/// (TS: a canvas's `measureText(text).width`).
pub fn measure_text(font: &str, text: &str) -> Points {
    text_metrics(font, text).width
}

/// Captures the platform text measurer while a component's runtime is entered.
/// The returned function can also be called by synchronous JS session queries,
/// where the Rust reactive runtime is not entered.
pub fn text_measurer() -> impl Fn(&str, &str) -> Points + Clone {
    let measure = with_data(|d| d.ambient.measure.clone()).expect("the core sets the text engine");
    move |font, text| {
        let font = CanvasFont::parse(font).unwrap_or_default();
        measure(&font, text).width
    }
}

/// How `text` sits on one line in `font` (the CSS `font` shorthand; an
/// invalid one measures in `10px sans-serif`), by the platform's text
/// engine: its width and the font's ascent, descent and line height, to
/// place text a canvas draws (a cell's baseline, a caret over it).
pub fn text_metrics(font: &str, text: &str) -> crate::canvas::TextMetrics {
    let font = CanvasFont::parse(font).unwrap_or_default();
    let measure = with_data(|d| d.ambient.measure.clone()).expect("the core sets the text engine");
    measure(&font, text)
}

/// The surface's `G`: one signal per type, made with `Default` the first
/// time (TS: a signal at module level). Every write notifies.
pub fn global<G: Default + 'static>() -> Signal<G> {
    let id = TypeId::of::<G>();
    if let Some(signal) = with_data(|d| {
        d.ambient
            .globals
            .get(&id)
            .and_then(|g| g.downcast_ref::<Signal<G>>().copied())
    }) {
        return signal;
    }
    let signal = Owner::detached().run(|| signal_with(G::default(), SignalEquals::Never));
    with_data(|d| d.ambient.globals.insert(id, Box::new(signal)));
    signal
}

/// [`global`] where a reactive runtime is entered (the engine's thread,
/// while it runs Rust code), else `None`: for code that also runs outside
/// an engine (a unit test of a component's model).
pub fn try_global<G: Default + 'static>() -> Option<Signal<G>> {
    super::reactive::try_with_data(|_| ())?;
    Some(global::<G>())
}

/// The insets of the screen or modal the component on `host` is on, below
/// its header, else the safe area (TS: `safeAreaInsets()`).
pub(crate) fn insets_of(host: NodeId) -> EdgeInsets {
    let existing = with_data(|d| d.ambient.insets.get(&host).copied());
    let signal = existing.unwrap_or_else(|| {
        // The core fills it in before the commit ends.
        let signal = Owner::detached().run(|| super::signal(safe_area()));
        with_data(|d| d.ambient.insets.insert(host, signal));
        signal
    });
    signal.get()
}

// --- Services ----------------------------------------------------------------

/// Shows `dialog` (an alert, or with `sheet` an action sheet); await the
/// answer in a task.
///
/// The core's part of `nsh_base::alert_dialog`, which apps use.
#[doc(hidden)]
pub fn dialog(dialog: Dialog) -> DialogAnswer {
    let (answer, slot) = DialogAnswer::new();
    act(Action::Dialog(dialog, slot));
    answer
}

/// Unfocuses the focused input, hiding the software keyboard.
pub fn dismiss_keyboard() {
    act(Action::Command(crate::ROOT_ID, Command::Blur));
}

/// Animates the layout changes of the next commit (React Native's
/// `LayoutAnimation.configureNext`).
pub fn animate_layout(animation: LayoutAnimation) {
    act(Action::Command(
        crate::ROOT_ID,
        Command::LayoutAnimation(animation),
    ));
}

/// The screen reader reads `message` (TS:
/// `announce`).
pub fn announce_for_accessibility(message: impl Into<String>) {
    act(super::services::announce(message.into()));
}

/// Runs `f` with the app's storage (`nsh/storage`, [`crate::storage::Storage`]):
/// the one the engine was given, or one in memory when it was given none.
pub(crate) fn with_storage<R>(f: impl FnOnce(&crate::storage::Store) -> R) -> R {
    let storage = with_data(|d| {
        d.ambient
            .storage
            .get_or_insert_with(|| crate::storage::Store::new(None))
            .clone()
    });
    f(&storage)
}

/// Opens `url` outside the app (TS: `openUrl` of `nsh/device`): a web page
/// in the browser, a `mailto:` or `tel:` link in its app, any scheme
/// another app registered. The embedding app may take it first (its host
/// channel's URL handler, which routes it through the host's router).
/// Resolves to whether it opened: `false` for a URL
/// [`crate::open_url::check_url`] refuses, when the app's `openUrl`
/// capability is not granted, or when no app handles it. Await it in a
/// task, or drop it when the answer does not matter.
pub fn open_url(url: impl Into<String>) -> Answer<bool> {
    let (answer, action) = super::services::open_url(url.into());
    act(action);
    answer
}

/// Puts `text` on the system clipboard (TS: `Clipboard.writeText`).
pub fn set_clipboard(text: impl Into<String>) {
    act(super::services::set_clipboard(text.into()));
}

/// The text on the system clipboard, `""` when it holds none (TS:
/// `Clipboard.readText`), to await in a task.
pub fn clipboard_string() -> Answer<String> {
    let (answer, action) = super::services::clipboard_string();
    act(action);
    answer
}

/// Whether the system clipboard holds text (TS: `Clipboard.hasText`).
pub fn clipboard_has_string() -> Answer<bool> {
    let (answer, action) = super::services::clipboard_has_string();
    act(action);
    answer
}

/// Puts the image of a base64 `data:` URI, or of the URL
/// [`clipboard_image`] gave, on the system clipboard (TS:
/// `Clipboard.writeImage`). Where the platform puts no images on the
/// clipboard (Android) nothing happens.
pub fn set_clipboard_image(uri: impl Into<String>) {
    act(super::services::set_clipboard_image(uri.into()));
}

/// The image on the system clipboard, `None` when it holds none, when it
/// is over [`crate::platform::clipboard::MAX_IMAGE_BYTES`] encoded or the
/// platform reads no images (Android) (TS: `Clipboard.readImage`), to
/// await in a task.
pub fn clipboard_image() -> Answer<Option<ClipboardImage>> {
    let (answer, action) = super::services::clipboard_image();
    act(action);
    answer
}

/// [`clipboard_image`] for `Clipboard.readImage`: `Err` with the size in
/// encoded bytes of an image over the limit.
pub(crate) fn clipboard_checked_image() -> Answer<Result<Option<ClipboardImage>, usize>> {
    let (answer, action) = super::services::clipboard_checked_image();
    act(action);
    answer
}

/// Whether the system clipboard holds an image, without reading it (TS:
/// `Clipboard.hasImage`).
pub fn clipboard_has_image() -> Answer<bool> {
    let (answer, action) = super::services::clipboard_has_image();
    act(action);
    answer
}

/// Whether the platform lets the user pick a color on the screen
/// ([`pick_screen_color`]): macOS and browsers with an `EyeDropper`.
pub fn can_pick_screen_color() -> bool {
    env(|e| e.screen_color)
}

/// The color the user picks anywhere on the screen (the system's color
/// sampler, a browser's `EyeDropper`), to await in a task: `None` when the
/// user cancelled or the platform has no sampler
/// ([`can_pick_screen_color`]).
pub fn pick_screen_color() -> Answer<Option<crate::Hsla>> {
    let (answer, action) = super::services::pick_screen_color();
    act(action);
    answer
}

/// The `file:` URLs of the local files on the system clipboard (files
/// copied in a file manager; TS: `Clipboard.readFiles`), to await in a task.
pub fn clipboard_files() -> Answer<Vec<String>> {
    let (answer, action) = super::services::clipboard_files();
    act(action);
    answer
}

/// Shows the system's open dialog and gives the files (or folders,
/// [`OpenDialog::folders`](crate::file_dialog::OpenDialog::folders)) the
/// user picked, to await in a task: `None` when cancelled, the error when
/// the dialog could not show (on Linux without a file chooser portal, or
/// on a platform without file dialogs: iOS, Android, the web;
/// [`crate::platform::Environment::file_requests`]). GPUI's
/// `prompt_for_paths`.
pub fn pick_paths(
    dialog: crate::file_dialog::OpenDialog,
) -> Answer<Result<Option<Vec<PathBuf>>, String>> {
    file_request(
        crate::file_dialog::FileRequest::OpenDialog(dialog),
        FileAnswer::OpenDialog,
    )
}

/// Shows the system's save dialog and gives the path the user chose to
/// save to, to await in a task: `None` when cancelled, the error when the
/// dialog could not show ([`pick_paths`]). The file is not created. GPUI's
/// `prompt_for_new_path`.
pub fn pick_save_path(
    dialog: crate::file_dialog::SaveDialog,
) -> Answer<Result<Option<PathBuf>, String>> {
    file_request(
        crate::file_dialog::FileRequest::SaveDialog(dialog),
        FileAnswer::SaveDialog,
    )
}

/// Opens the local file or folder at `path` (absolute) in its default app
/// (GPUI's `open_with_system`), to await in a task or drop: `Ok` once it
/// opened, the error when it did not (no app for it, a relative path, a
/// platform that opens no local paths). [`open_url`] opens no `file:`
/// URLs; this is their way.
pub fn open_path(path: impl Into<PathBuf>) -> Answer<Result<(), String>> {
    file_request(
        crate::file_dialog::FileRequest::OpenPath(path.into()),
        FileAnswer::Done,
    )
}

/// Shows the item at `path` (absolute) selected in the file manager
/// (Finder, File Explorer, the desktop's file manager; GPUI's
/// `reveal_path`), to await in a task or drop: `Ok` once it showed, the
/// error when it did not (it does not exist, a relative path, a platform
/// without a file manager).
pub fn reveal_path(path: impl Into<PathBuf>) -> Answer<Result<(), String>> {
    file_request(
        crate::file_dialog::FileRequest::RevealPath(path.into()),
        FileAnswer::Done,
    )
}

/// Moves the item at `path` (absolute) to the trash (the Recycle Bin on
/// Windows), to await in a task: where it went when the platform says
/// (macOS), else `None`, which is no failure; the error when it could not
/// (it does not exist, the volume has no trash, the platform has none).
pub fn move_to_trash(path: impl Into<PathBuf>) -> Answer<Result<Option<PathBuf>, String>> {
    file_request(
        crate::file_dialog::FileRequest::MoveToTrash(path.into()),
        FileAnswer::Trash,
    )
}

/// Sends file request `request`, answered through `answer`.
fn file_request<T>(
    request: crate::file_dialog::FileRequest,
    answer: impl FnOnce(super::AnswerSlot<T>) -> FileAnswer,
) -> Answer<T> {
    let (answer, action) = super::services::file_request(request, answer);
    act(action);
    answer
}

/// Shows the system's picker for images and gives the ones the user picked,
/// prepared as `request` says, none when cancelled (TS:
/// `Picker.pickImages`), to await in a task.
pub fn pick_images(request: crate::picker::PickRequest) -> Answer<Vec<crate::picker::PickedFile>> {
    let (answer, action) = super::services::pick_images(request);
    act(action);
    answer
}

/// The value function `name` of the embedding app returns for `args`
/// (TS: `host.call`), to await in a task.
pub(crate) fn host_call(
    name: String,
    args: crate::JsonValue,
) -> Answer<Result<crate::JsonValue, super::JsError>> {
    let (answer, action) = super::services::host_call(name, args);
    act(action);
    answer
}

/// Forgets the host calls whose answers were dropped (they timed out).
pub(crate) fn forget_host_calls() {
    act(Action::ForgetHostCalls);
}

/// The size in pixels of the image at `src` (TS: `Image.getSize`).
pub fn image_size(src: impl Into<String>) -> Answer<Result<ImageSize, String>> {
    let (answer, action) = super::services::image_size(src.into());
    act(action);
    answer
}

/// Loads the image at `src` ahead of showing it (TS: `Image.prefetch`).
pub fn prefetch_image(src: impl Into<String>) -> super::Prefetch {
    let (answer, action) = super::services::prefetch(src.into());
    act(action);
    answer
}

/// Makes an HTTP request (in a task: await its response; TS: `fetch`) with
/// the engine's network stack, the one JS's `fetch` uses: the platform's
/// on native targets and the browser's on the web, under the app's
/// `capabilities.network`. `request` is a URL (`GET`) or an
/// [`HttpRequest`](crate::platform::HttpRequest); the URL is absolute.
/// The whole body arrives with the response.
pub fn fetch(request: impl Into<crate::platform::HttpRequest>) -> super::Fetch {
    let (answer, action) = super::services::fetch(request.into());
    act(action);
    answer
}

/// Shows the surface in `appearance` whatever the system's (TS:
/// `setColorScheme`).
pub fn set_color_scheme(appearance: Appearance) {
    act(Action::Appearance(appearance));
}

/// Draws the bar of every scroll view and list whose `scrollbar` is `true`
/// with the built-in bar `source` makes of `theme` (the UI set's, which
/// `source` gets back: [`BuiltInScrollbar::app_theme`](super::BuiltInScrollbar::app_theme)),
/// or (`None`, the default) with the platform's indicator. A view whose `scrollbar` is a theme shows the bar
/// of the UI set that makes one
/// ([`Registry::scrollbars_from`](super::Registry::scrollbars_from)).
/// `nsh-base`'s `set_scrollbar_theme` calls it.
pub fn set_builtin_scrollbars(source: super::ScrollbarSource, theme: Option<super::AnyValue>) {
    act(Action::BuiltInScrollbars(source, theme));
}

// --- Tasks and timers --------------------------------------------------------

/// A running task ([`spawn`]): it ends with the owner it was made under, or
/// when [`Spawned::cancel`] is called. Awaiting it gives its output.
pub struct Spawned<T>(task::Task<T>);

impl<T> Spawned<T> {
    /// Ends the task now.
    pub fn cancel(self) {
        self.0.handle().cancel();
    }
}

impl<T> Future for Spawned<T> {
    type Output = T;

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<T> {
        std::pin::Pin::new(&mut self.0).poll(cx)
    }
}

/// Runs `future` on the engine thread (TS: an `async` function): it changes
/// what it wants by writing signals, and ends with the current owner. It
/// runs under that owner: what it makes is the owner's.
pub fn spawn<T: 'static>(future: impl Future<Output = T> + 'static) -> Spawned<T> {
    let executor = executor();
    let owner = Owner::current();
    let task = task::spawn_future(
        &executor,
        Owned {
            owner,
            future: Box::pin(future),
        },
    );
    let handle = task.handle();
    cleanup(move || handle.cancel());
    Spawned(task)
}

/// A future polled under `owner` ([`Owner::scope`]).
struct Owned<F> {
    owner: Owner,
    future: std::pin::Pin<Box<F>>,
}

impl<F: Future> Future for Owned<F> {
    type Output = F::Output;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<F::Output> {
        let this = self.get_mut();
        this.owner.scope(|| this.future.as_mut().poll(cx))
    }
}

/// Runs `f` once after `delay` (TS: `setTimeout`; cancelling the task is
/// `clearTimeout`), while the current owner lives.
pub fn set_timeout(delay: Duration, f: impl FnOnce() + 'static) -> Spawned<()> {
    let owner = Owner::current();
    spawn(async move {
        timer(delay).await;
        owner.run(f);
    })
}

/// Runs `f` every `period` (TS: `setInterval`), while the current owner
/// lives. Late wakes do not pile up runs.
pub fn set_interval(period: Duration, f: impl Fn() + 'static) -> Spawned<()> {
    let owner = Owner::current();
    spawn(async move {
        let mut next = crate::time::now() + period;
        loop {
            timer_until(next).await;
            next = (next + period).max(crate::time::now());
            owner.run(&f);
        }
    })
}

/// Runs `f` when the next display frame starts, with its time (TS:
/// `requestAnimationFrame`).
pub fn request_animation_frame(f: impl FnOnce(Instant) + 'static) -> Spawned<()> {
    let owner = Owner::current();
    spawn(async move {
        let at = next_frame().await;
        owner.run(move || f(at));
    })
}

/// Waits `delay` (in a task; TS: what `setTimeout` waits for).
pub fn timer(delay: Duration) -> Delay {
    timer_until(crate::time::now() + delay)
}

/// Waits until `at` (in a task).
pub fn timer_until(at: Instant) -> Delay {
    Delay {
        at,
        registered: false,
        #[cfg(not(target_arch = "wasm32"))]
        elsewhere: None,
    }
}

/// What [`timer`] and [`timer_until`] wait for. In the engine's tasks the
/// core keeps it and the engine's loop wakes for it, as for JS's timers
/// (on time, with no other thread involved); awaited off the engine's
/// thread (in [`background`]), it is tokio's.
#[derive(Debug)]
pub struct Delay {
    at: Instant,
    /// The core keeps it.
    registered: bool,
    #[cfg(not(target_arch = "wasm32"))]
    elsewhere: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl Future for Delay {
    type Output = ();

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<()> {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(sleep) = &mut self.elsewhere {
            return sleep.as_mut().poll(cx);
        }
        if crate::time::now() >= self.at {
            return std::task::Poll::Ready(());
        }
        if self.registered {
            return std::task::Poll::Pending;
        }
        match super::reactive::try_with_data(|d| d.ambient.executor.clone()).flatten() {
            Some(executor) => {
                executor.add_timer(self.at, cx.waker().clone());
                self.registered = true;
                std::task::Poll::Pending
            }
            #[cfg(not(target_arch = "wasm32"))]
            None => {
                let at = self.at;
                let sleep = self
                    .elsewhere
                    .insert(Box::pin(tokio::time::sleep_until(at.into())));
                sleep.as_mut().poll(cx)
            }
            // WebAssembly runs everything on the engine's thread.
            #[cfg(target_arch = "wasm32")]
            None => std::task::Poll::Pending,
        }
    }
}

/// The next display frame's start (in a task; TS: what
/// `requestAnimationFrame` waits for). Awaited in a loop, it runs once per
/// frame.
pub fn next_frame() -> Answer<Instant> {
    let (answer, action) = super::services::frame();
    act(action);
    answer
}

/// Runs blocking `f` on the runtime's blocking threads (in a task: await
/// its result; `tokio::task::spawn_blocking`). Not in WebAssembly: code
/// that should also run on the web uses the engine's services instead
/// ([`fetch`], [`timer`]).
#[cfg(not(target_arch = "wasm32"))]
pub fn blocking<R: Send + 'static>(
    f: impl FnOnce() -> R + Send + 'static,
) -> tokio::task::JoinHandle<R> {
    tokio::task::spawn_blocking(f)
}

/// Runs `future` on the runtime's threads (in a task: await its result;
/// `tokio::spawn`): `Send` work that should not hold the engine thread.
/// Not in WebAssembly, which has no threads.
#[cfg(not(target_arch = "wasm32"))]
pub fn background<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(future)
}

// --- Handles -----------------------------------------------------------------

/// An animated value starting at `value` (TS: `createAnimatedValue`): bind
/// it to styles, drags, scroll offsets or drawings, animate it from handlers
/// and tasks. A `Copy` handle the current owner keeps, as a signal is (with
/// no owner, it lives as long as the surface).
pub fn animated_value(value: f32) -> super::AnimatedValue {
    super::AnimatedValue::new(&executor(), value)
}

/// Animated values for a view's opacity and transform, and motions to
/// play on them (TS: `createMotion`): bind it with
/// [`super::Element::bind_motion`]. A `Copy` handle the current owner keeps.
pub fn motion() -> super::Motion {
    super::Motion::new(&executor())
}

/// A handle for an element (TS: `ref`): put it on the element with
/// [`super::Element::element_ref`], call its commands from handlers and
/// tasks. A `Copy` handle the current owner keeps, as a signal is.
pub fn element_ref() -> super::ElementRef {
    super::ElementRef::new(&executor())
}

/// A handle for a component this view renders (TS: a `ref` to a
/// component): put it on the component's element with
/// [`super::ComponentElement::component_ref`]; [`super::ComponentRef::api`]
/// is the API its view registered. A `Copy` handle the current owner keeps.
pub fn component_ref<C: super::Component>() -> super::ComponentRef<C> {
    super::ComponentRef::new(&executor())
}

/// How a keyboard shortcut fires ([`on_key_with`]; TS: `keymap.bind`'s
/// options).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyOptions {
    /// While a text input (or a web view) has the keyboard focus: by
    /// default unless the input uses the keystroke itself.
    pub when: crate::keymap::When,
    /// Fires again on the auto-repeats of a held key (default: once until
    /// the key is released).
    pub repeat: bool,
}

/// Whether shortcuts follow Apple's conventions here (`mod` is Command):
/// the OS, or for a browser the platform it runs on. Terminals use Control.
pub fn apple_keys() -> bool {
    let (os, apple, terminal) = with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .expect("the core sets the environment")
        .with_untracked(|e| (e.os, e.apple_keyboard, e.uses_terminal_keyboard()));
    !terminal && crate::keymap::apple_keys(os, apple)
}

/// The platform's reserved-key convention, for [`crate::keymap::Keystroke::reserved`].
/// Terminal keyboards use the Linux (Control-based) reservations even on
/// an Apple OS or when a graphical backend renders their pixels.
pub fn reserved_key_os() -> Os {
    with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .expect("the core sets the environment")
        .with_untracked(|e| {
            if e.uses_terminal_keyboard() {
                Os::Linux
            } else {
                e.os
            }
        })
}

/// [`apple_keys`] where an engine runs, else `None` (as [`try_os`]).
pub fn try_apple_keys() -> Option<bool> {
    super::reactive::try_with_data(|d| d.ambient.env.as_ref().map(|e| e.env))
        .flatten()
        .map(|env| {
            env.with_untracked(|e| {
                !e.uses_terminal_keyboard() && crate::keymap::apple_keys(e.os, e.apple_keyboard)
            })
        })
}

/// Runs `handler` when `keystroke` is pressed while the current owner
/// lives (TS: `keymap.bind`): `"mod+k"` (`mod` is Command on Apple
/// graphical platforms, Control in terminals and elsewhere),
/// `"shift+mod+l"`, `"escape"`, ... (the keystrokes of `nsh/keymap`). The
/// handler gets the keystroke as written.
/// Desktop and terminal backends fire them.
///
/// # Panics
///
/// On a keystroke that is not one, or one the platform keeps (Command+Q
/// on Apple platforms, Alt+F4 elsewhere, ...), as TS's `bind` throws.
#[track_caller]
pub fn on_key(keystroke: &str, handler: impl Fn(&str) + 'static) {
    on_key_with(keystroke, KeyOptions::default(), handler);
}

/// [`on_key`] that fires as `options` say.
///
/// # Panics
///
/// As [`on_key`].
#[track_caller]
pub fn on_key_with(keystroke: &str, options: KeyOptions, handler: impl Fn(&str) + 'static) {
    let parsed = crate::keymap::Keystroke::parse_with(keystroke, apple_keys())
        .unwrap_or_else(|e| panic!("on_key: {e}"));
    if let Some(why) = parsed.reserved(reserved_key_os()) {
        panic!("on_key: {keystroke:?} cannot be bound: {why}");
    }
    let owner = Owner::current();
    let handler: super::keys::KeyHandler = Rc::new(move |k: &str| owner.run(|| handler(k)));
    let keys = executor().keys.clone();
    let id = keys.borrow_mut().add(
        |id| crate::keymap::KeyBinding::new(id, parsed, options.when, options.repeat),
        keystroke.into(),
        handler,
    );
    let weak = Rc::downgrade(&keys);
    cleanup(move || {
        if let Some(keys) = weak.upgrade() {
            let removed = keys.borrow_mut().remove(id);
            drop(removed);
        }
    });
}

/// Watches the scroll view or list `target` names while the current owner
/// lives: `handler` hears its offset, content size and viewport (zoomed, as
/// `on_scroll` reports them) when it is first found and whenever one of
/// them changes, whether or not anything listens to its `on_scroll`. A
/// view of the app's own that follows a scroll view it did not make (a
/// scroll bar) watches it this way.
///
/// `target` is asked again in every commit (untracked), so a ref set later
/// in the same render is found when its element is mounted; while it names
/// no scroll view, nothing is heard. The handler runs at the end of the
/// commit round that saw the change, and what it changes goes out in the
/// same batch.
pub fn watch_scroll(
    target: impl Fn() -> Option<NodeId> + 'static,
    handler: impl Fn(&crate::element::ScrollEvent) + 'static,
) {
    let owner = Owner::current();
    let handler = Rc::new(move |e: &crate::element::ScrollEvent| owner.run(|| handler(e)));
    add_watch(Rc::new(target), handler);
}

impl super::NodeRef {
    /// Scrolls the scroll view (or list, along its axis) to a content
    /// offset, as [`super::ElementRef::scroll_to`] does: for a view holding
    /// a node, not a ref (a prop a JS `ref` fills, a watch's target).
    pub fn scroll_to(&self, offset: crate::geometry::Point<Points>, animated: bool) {
        act(Action::Command(
            self.0,
            Command::ScrollTo {
                x: offset.x,
                y: offset.y,
                animated,
            },
        ));
    }
}

/// Watches the order the tree has the elements `elements` gives in, while
/// the current owner lives: `handler` hears it as indices into that list
/// (`[2, 0, 1]`: the third element comes first; elements carried by no
/// node in the tree last, in the order given) whenever it differs from the
/// list's own. `nsh-base`'s roving focus keeps a group's items (a
/// toolbar's) in order this way: components render in the order the core
/// makes them, which is not the tree's (an item inside a group renders
/// after the toolbar's later children).
///
/// The core looks at the end of a commit round: in the round the watch is
/// made in, after [`super::OrderWatch::invalidate`] (an element came), and
/// after a round that moved a node (an app's keyed reorder), asking
/// `elements` untracked; what the handler changes goes out in the same
/// batch. A round that moved nothing and invalidated nothing costs nothing.
#[doc(hidden)]
pub fn watch_order(
    elements: impl Fn() -> Vec<super::ElementRef> + 'static,
    handler: impl Fn(&[usize]) + 'static,
) -> super::OrderWatch {
    let owner = Owner::current();
    let handler = Rc::new(move |order: &[usize]| owner.run(|| handler(order)));
    let watches = executor().watches.clone();
    let (id, dirty) = watches.borrow_mut().add_order(Rc::new(elements), handler);
    let weak = Rc::downgrade(&watches);
    cleanup(move || {
        if let Some(watches) = weak.upgrade() {
            let removed = watches.borrow_mut().remove_order(id);
            drop(removed);
        }
    });
    super::OrderWatch::new(dirty)
}

fn add_watch(target: Rc<dyn Fn() -> Option<NodeId>>, handler: super::watch::ScrollHandler) {
    let watches = executor().watches.clone();
    let id = watches.borrow_mut().add(target, handler);
    let weak = Rc::downgrade(&watches);
    cleanup(move || {
        if let Some(watches) = weak.upgrade() {
            let removed = watches.borrow_mut().remove(id);
            drop(removed);
        }
    });
}

/// `keystroke` as menus and hints show it here (TS: `keymap.label`):
/// `"⇧⌘L"` on Apple platforms (and in a browser on one), `"Ctrl+Shift+L"`
/// elsewhere, for `"mod+shift+l"`.
///
/// # Panics
///
/// On a keystroke that is not one.
#[track_caller]
pub fn key_label(keystroke: &str) -> String {
    let apple = apple_keys();
    crate::keymap::Keystroke::parse_with(keystroke, apple)
        .unwrap_or_else(|e| panic!("key_label: {e}"))
        .label(os(), apple)
}

/// Listens to the Android back button while the current owner lives (TS:
/// `BackHandler.on("press", f)`): when no modal is
/// shown, `f` runs before the stack pops, newest listener first, and returns
/// true when it handled the press. While one listens, a back gesture does
/// not preview the pop.
pub fn on_back_press(f: impl Fn() -> bool + 'static) {
    let owner = Owner::current();
    let listener: super::back::BackListener = Rc::new(move || owner.run(&f));
    let back = &executor().back;
    let id = back.borrow_mut().add(listener);
    let subscription = super::back::BackSubscription::new(back, id);
    cleanup(move || drop(subscription));
}

pub(crate) fn title_bar() -> crate::geometry::Edges<crate::geometry::Points> {
    env(|e| e.title_bar)
}

/// The views' menu handlers.
pub(crate) fn view_menus() -> Rc<std::cell::RefCell<super::menus::ViewMenus>> {
    executor().menus.clone()
}

pub(crate) fn desktop_command(command: crate::desktop::DesktopCommand) {
    act(Action::Command(
        crate::ROOT_ID,
        Command::Desktop(Box::new(command)),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{element::Runtime, geometry::px};

    #[test]
    fn captured_text_measurer_works_without_runtime_entry() {
        let runtime = Runtime::default();
        runtime.set_measure(Rc::new(|_, text| crate::canvas::TextMetrics {
            width: px(text.chars().count() as f32),
            ..Default::default()
        }));
        let measure = {
            let _entered = runtime.enter();
            text_measurer()
        };
        assert_eq!(measure("16px sans-serif", "选择 text"), px(7.0));
    }
}
