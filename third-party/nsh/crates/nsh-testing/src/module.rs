//! `nsh/test`, the module test files import: `test` declares a test,
//! `open` starts the app on a headless engine of its own and gives an
//! [`App`] to take steps on, `expect` checks values. Written in Rust, its
//! TypeScript face and declarations are generated, as a UI set's are; only
//! the engine `nsh test` runs a test file on serves it.

use std::{
    cell::RefCell,
    collections::BTreeMap,
    future::Future,
    rc::Rc,
    sync::{Arc, Mutex},
    task::Poll,
    time::Duration,
};

use nsh_core::{
    JsonValue,
    ui::{Arg, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, Registry, TsTypes, prelude::*},
};
use nsh_engine::{HostCall, HostChannel, HttpBody, HttpRequest};

use crate::{
    MemoryStorage,
    driver::{Driver, headless_only},
    headless::{self, RecordingNetwork, StubReply, StubResponse, StubRoute, default_answer},
    run::{OpenApp, Session},
};

/// The specifier test files import.
pub const SPECIFIER: &str = "nsh/test";

/// The module of the entry `nsh test` makes for a test file, which runs
/// its tests once it is loaded: no test file imports it.
pub(crate) const RUNNER: &str = "nsh/test/runner";

/// The `nsh/test` set, for the engine of test files, the bundler and the
/// declarations (`.nsh/types/nsh/test`).
pub fn registry() -> Registry {
    let mut registry = Registry::ui_set(SPECIFIER);
    registry
        .module::<Testing>()
        .module::<TestVariants>()
        .module::<DescribeVariants>()
        .class::<App>()
        .class::<Clock>()
        .class::<Expectation>()
        .class::<Rejection>();
    registry
}

/// The set of the entry `nsh test` makes for a test file.
pub(crate) fn runner_registry() -> Registry {
    let mut registry = Registry::ui_set(RUNNER);
    registry.module::<Runner>();
    registry
}

/// How long a test or a hook may take unless it says (Jest's `timeout`).
const TIMEOUT: Duration = Duration::from_secs(30);

/// A `describe` block, or the file: its tests and blocks in order, and the
/// hooks that run around them.
#[derive(Default)]
pub(crate) struct Suite {
    /// Its name (empty for the file).
    pub(crate) name: String,
    pub(crate) mode: Mode,
    pub(crate) before_all: Vec<Hook>,
    pub(crate) after_all: Vec<Hook>,
    pub(crate) before_each: Vec<Hook>,
    pub(crate) after_each: Vec<Hook>,
    pub(crate) items: Vec<Item>,
}

/// What a suite holds.
pub(crate) enum Item {
    Test(Case),
    Suite(Suite),
}

/// A test as the file declared it.
pub(crate) struct Case {
    pub(crate) name: String,
    /// `None` for a `test.todo`.
    pub(crate) body: Option<Callback>,
    pub(crate) mode: Mode,
    pub(crate) timeout: Duration,
}

/// A `beforeAll`, `afterAll`, `beforeEach` or `afterEach` function.
pub(crate) struct Hook {
    pub(crate) body: Callback,
    pub(crate) timeout: Duration,
}

/// How a test or a block was declared.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    #[default]
    Run,
    /// `.skip`: neither it nor what it holds runs.
    Skip,
    /// `.only`: a file with one runs only those.
    Only,
    /// `test.todo`: a test still to write.
    Todo,
}

thread_local! {
    /// The file's suite and the `describe` blocks being declared in it,
    /// innermost last (the engine's thread is the test file's).
    static DECLARING: RefCell<Vec<Suite>> = RefCell::new(vec![Suite::default()]);
}

/// The suite the file declared, taken: from now on it declares nothing.
pub(crate) fn take_suite() -> Suite {
    DECLARING.with(|declaring| {
        let mut declaring = declaring.borrow_mut();
        let suite = std::mem::take(&mut declaring[0]);
        declaring.clear();
        suite
    })
}

/// Runs `f` on the suite being declared: an error once the tests run.
fn declare(what: &str, f: impl FnOnce(&mut Suite)) -> Result<(), String> {
    DECLARING.with(|declaring| match declaring.borrow_mut().last_mut() {
        Some(suite) => {
            f(suite);
            Ok(())
        }
        None => Err(format!(
            "{what} declares as the file loads, at its top level or in a `describe`: not in a test or a hook"
        )),
    })
}

/// A test of the suite being declared.
fn declare_test(
    name: String,
    body: Option<Callback>,
    mode: Mode,
    timeout: Option<f64>,
) -> Result<(), String> {
    let timeout = milliseconds(timeout)?;
    declare("`test`", |suite| {
        suite.items.push(Item::Test(Case {
            name,
            body,
            mode,
            timeout,
        }));
    })
}

/// A `describe` block: `body` declares what it holds, at once.
fn declare_suite(name: String, body: Callback, mode: Mode) -> Result<(), String> {
    declare("`describe`", |_| ())?;
    DECLARING.with(|declaring| {
        declaring.borrow_mut().push(Suite {
            name,
            mode,
            ..Suite::default()
        })
    });
    let declared = body.call(());
    let suite = DECLARING.with(|declaring| declaring.borrow_mut().pop());
    declared.map_err(|e| format!("`describe` threw: {e}"))?;
    let suite = suite.ok_or("`describe` lost its block")?;
    declare("`describe`", |parent| parent.items.push(Item::Suite(suite)))
}

/// A hook of the suite being declared, which `pick` chooses.
fn declare_hook(
    what: &str,
    body: Callback,
    timeout: Option<f64>,
    pick: fn(&mut Suite) -> &mut Vec<Hook>,
) -> Result<(), String> {
    let timeout = milliseconds(timeout)?;
    declare(what, |suite| pick(suite).push(Hook { body, timeout }))
}

/// A timeout in milliseconds as a test gives it, [`TIMEOUT`] without one.
fn milliseconds(ms: Option<f64>) -> Result<Duration, String> {
    match ms {
        None => Ok(TIMEOUT),
        Some(ms) if ms.is_finite() && ms > 0.0 => Ok(Duration::from_secs_f64(ms / 1000.0)),
        Some(ms) => Err(format!(
            "a timeout is a positive number of milliseconds, not {ms}"
        )),
    }
}

/// Tests of an app, run headless by `nsh test`: each test opens the app on
/// an engine of its own and takes the steps a user would.
#[module]
pub struct Testing;

#[module(flat)]
impl Testing {
    /// Declares the test `name`: `nsh test` runs `body` after the file is
    /// loaded, the tests of a file one after the other, in order. A test
    /// fails when `body` throws or the promise it returns rejects, and
    /// after `timeout` milliseconds (30 000). The apps it opened are closed
    /// when it ends.
    pub fn test(name: String, body: Callback, timeout: Option<f64>) -> Result<(), String> {
        declare_test(name, Some(body), Mode::Run, timeout)
    }

    /// Groups the tests and blocks `body` declares (at once) under `name`:
    /// their names start with it, and the hooks it declares run around
    /// them only.
    pub fn describe(name: String, body: Callback) -> Result<(), String> {
        declare_suite(name, body, Mode::Run)
    }

    /// Runs `body` once before the first test of the block it is declared
    /// in (the file, a `describe`); when it fails, so do those tests. Apps
    /// it opens stay open until the block's tests ended.
    pub fn before_all(body: Callback, timeout: Option<f64>) -> Result<(), String> {
        declare_hook("`beforeAll`", body, timeout, |s| &mut s.before_all)
    }

    /// Runs `body` once after the last test of the block it is declared in.
    pub fn after_all(body: Callback, timeout: Option<f64>) -> Result<(), String> {
        declare_hook("`afterAll`", body, timeout, |s| &mut s.after_all)
    }

    /// Runs `body` before each test of the block it is declared in, the
    /// outer blocks' first; when it fails, so does the test.
    pub fn before_each(body: Callback, timeout: Option<f64>) -> Result<(), String> {
        declare_hook("`beforeEach`", body, timeout, |s| &mut s.before_each)
    }

    /// Runs `body` after each test of the block it is declared in, the
    /// inner blocks' first, whether the test passed or not.
    pub fn after_each(body: Callback, timeout: Option<f64>) -> Result<(), String> {
        declare_hook("`afterEach`", body, timeout, |s| &mut s.after_each)
    }

    /// Starts the app whose entry is `entry` (relative to the test file)
    /// on a phone-sized headless engine of its own, with what `options`
    /// set up, and resolves once it rendered and is quiet. Its requests
    /// fail unless `options.network` lists them; its storage starts with
    /// `options.storage`.
    pub async fn open(entry: String, options: Option<OpenOptions>) -> Result<App, String> {
        let session = Session::current()?;
        let options = options.unwrap_or_default();
        let (network, mut server) = network_setup(options.network);
        let host_handlers = options
            .host
            .as_ref()
            .and_then(|h| h.handlers.as_ref())
            .is_some_and(|h| !h.0.is_empty());
        let (host, record) = host_setup(options.host, &mut server);
        let launch = Launch {
            storage: options.storage.unwrap_or_default(),
            network,
            width: options.width,
            height: options.height,
            safe_area: options.safe_area.unwrap_or_default(),
            clipboard: options.clipboard,
            color_scheme: options.color_scheme.unwrap_or_default(),
            locale: options.locale,
            reduced_motion: options.reduced_motion.unwrap_or(false),
            platform: options.platform.unwrap_or_default(),
            clock: options
                .clock
                .map(|c| c.time.map_or_else(std::time::SystemTime::now, |t| t.0)),
            host,
            host_handlers,
        };
        let opening = blocking(move || session.open(&entry, launch));
        let (app, storage, requests) = serve(server.as_ref(), opening)
            .await?
            .map_err(|e| e.to_string())??;
        Ok(App {
            steps: Steps {
                app,
                server: server.map(Rc::new),
                dialog: Rc::default(),
                pick: Rc::default(),
            },
            storage,
            requests,
            host: record,
        })
    }

    /// What to expect of `value`, compared as JSON is (`undefined` is
    /// `null`): `expect(app.texts()).toContain("Saved")`. Given a function,
    /// what it throws: `expect(() => parse("x")).toThrow("not a number")`,
    /// and with `rejects` what the promise it returns rejects with.
    pub fn expect(value: Subject) -> Expectation {
        match value {
            Subject::Value(value) => Expectation {
                value,
                run: None,
                not: false,
            },
            Subject::Function(run) => Expectation {
                value: JsonValue::Null,
                run: Some(run),
                not: false,
            },
        }
    }
}

/// Unused in TS: `test`'s properties document themselves.
#[module]
pub(crate) struct TestVariants;

#[module(name = "test")]
impl TestVariants {
    /// Declares a test that does not run: it is reported as skipped.
    pub(crate) fn skip(name: String, body: Callback, timeout: Option<f64>) -> Result<(), String> {
        declare_test(name, Some(body), Mode::Skip, timeout)
    }

    /// Declares a test that runs while the file's other tests, but those
    /// declared with `only`, are skipped: to focus on it for a while.
    pub(crate) fn only(name: String, body: Callback, timeout: Option<f64>) -> Result<(), String> {
        declare_test(name, Some(body), Mode::Only, timeout)
    }

    /// Declares a test still to write: it is reported as one.
    pub(crate) fn todo(name: String) -> Result<(), String> {
        declare_test(name, None, Mode::Todo, None)
    }
}

/// Unused in TS: `describe`'s properties document themselves.
#[module]
pub(crate) struct DescribeVariants;

#[module(name = "describe")]
impl DescribeVariants {
    /// Declares a block whose tests do not run: they are reported as
    /// skipped.
    pub(crate) fn skip(name: String, body: Callback) -> Result<(), String> {
        declare_suite(name, body, Mode::Skip)
    }

    /// Declares a block whose tests run while the file's other tests, but
    /// those declared with `only`, are skipped.
    pub(crate) fn only(name: String, body: Callback) -> Result<(), String> {
        declare_suite(name, body, Mode::Only)
    }
}

/// What a test runs: the internal module of the entry `nsh test` makes.
#[module]
pub(crate) struct Runner;

#[module(flat)]
impl Runner {
    /// Runs the tests the test file declared.
    pub(crate) async fn run() {
        crate::run::run_tests().await;
    }
}

/// How `open` starts the app.
#[derive(Debug, Default, JsObject)]
#[non_exhaustive]
pub struct OpenOptions {
    /// What the app's storage (`nsh/storage`) holds at the start.
    pub storage: Option<Entries>,
    /// What its requests get, by `"<METHOD> <URL>"` (a bare URL is a `GET`;
    /// `*` matches any text): a response, or a function of the request that
    /// returns one; a request not listed fails. `"live"`: the network.
    pub network: Option<NetworkOption>,
    /// The viewport's width (390 points).
    pub width: Option<Points>,
    /// The viewport's height (844 points).
    pub height: Option<Points>,
    /// The safe area insets in points (none).
    pub safe_area: Option<SafeArea>,
    /// The text on the clipboard at the start (none).
    pub clipboard: Option<String>,
    /// The system's appearance (`"light"`).
    pub color_scheme: Option<ColorScheme>,
    /// The device's locale, a BCP 47 tag (`"en-US"`).
    pub locale: Option<String>,
    /// The user asked for less motion (false).
    pub reduced_motion: Option<bool>,
    /// The platform the app believes it runs on headless (`"ios"`; a
    /// desktop's: `"macos"`, `"windows"`, `"linux"`, `"web"`). On a real
    /// platform it is that one.
    pub platform: Option<Platform>,
    /// A manual clock for the app (none: the system's): its time moves only
    /// as the test moves it (`app.clock`), steps finish native animations
    /// at once, and `app.wait` moves it.
    pub clock: Option<ClockOptions>,
    /// The embedding app the test plays for the app (`nsh/host`): the
    /// launch parameters it reads as `host.params` and the handlers of its
    /// `host.call` and `host.post`.
    pub host: Option<HostOptions>,
}

/// The embedding app a test plays (`open`'s `host`; `nsh/host`).
#[derive(Debug, Default, JsObject)]
#[non_exhaustive]
pub struct HostOptions {
    /// What the app reads as `host.params` (`{}`).
    pub params: Option<HostParams>,
    /// The handlers of the app's `host.call(name, data)` and
    /// `host.post(name, data)`, by name: a value answers every call with
    /// it; a function gets the data and returns the answer (or a promise
    /// of it), and what it throws rejects the call. A call of a name not
    /// listed fails, as with an embedding app that handles none; a post of
    /// one is dropped (`app.host.posts()` lists those of the names listed).
    pub handlers: Option<HostHandlers>,
}

/// The launch parameters of `open`'s `host`: a JSON object.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct HostParams(pub serde_json::Map<String, JsonValue>);

impl JsValue for HostParams {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Record<string, unknown>".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.to_json()? {
            JsonValue::Object(map) => Ok(HostParams(map)),
            _ => Err(value.expected("an object")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Ok(JsOwned::new(
            host,
            host.json(&JsonValue::Object(self.0.clone()))?,
        ))
    }
}

/// A handler of `open`'s `host.handlers`.
#[derive(Debug)]
pub enum HostHandlerOption {
    /// The answer to every call.
    Value(JsonValue),
    /// What this function returns for the call's data (or the promise it
    /// returns resolves to).
    Function(Callback<JsonValue, JsonValue>),
}

/// `open`'s `host.handlers`, by name.
#[derive(Debug, Default)]
pub struct HostHandlers(pub Vec<(String, HostHandlerOption)>);

impl JsValue for HostHandlers {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Record<string, unknown | ((data: unknown) => unknown)>".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() != JsKind::Object {
            return Err(value.expected("an object of handlers"));
        }
        let mut handlers = Vec::new();
        for key in value.keys()? {
            let field = value.field(&key)?;
            let field = field.get();
            let handler = if field.kind() == JsKind::Function {
                <Callback<JsonValue, JsonValue> as Arg>::from_js(field)
                    .map(HostHandlerOption::Function)
            } else {
                field.to_json().map(HostHandlerOption::Value)
            };
            handlers.push((
                key.clone(),
                handler.map_err(|e| PropError(format!("`{key}`: {}", e.0)))?,
            ));
        }
        Ok(HostHandlers(handlers))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        // A handler's function stays JS's: only values go back.
        let json = JsonValue::Object(
            self.0
                .iter()
                .filter_map(|(key, handler)| match handler {
                    HostHandlerOption::Value(v) => Some((key.clone(), v.clone())),
                    HostHandlerOption::Function(_) => None,
                })
                .collect(),
        );
        Ok(JsOwned::new(host, host.json(&json)?))
    }
}

/// A call or a post the app made to the embedding app the test plays
/// (`app.host.calls()`, `app.host.posts()`).
#[derive(Debug, Default, Clone, PartialEq, JsObject)]
#[non_exhaustive]
pub struct HostMessage {
    /// Its name.
    pub name: String,
    /// Its data (`null` without any).
    pub data: JsonValue,
}

/// The calls and posts the handlers of `open`'s `host` got, in order:
/// each with whether it is a post.
type HostRecord = Arc<Mutex<Vec<(HostMessage, bool)>>>;

/// The embedding app's channel `options` describe, for the app the test
/// opens, and the record of what its handlers get. The handlers' JS
/// functions join `server`, which answers their calls on the test file's
/// VM.
fn host_setup(
    options: Option<HostOptions>,
    server: &mut Option<RouteServer>,
) -> (HostChannel, HostRecord) {
    let channel = HostChannel::new();
    let record = HostRecord::default();
    let options = options.unwrap_or_default();
    if let Some(params) = options.params {
        channel.set_params(params.0);
    }
    let handlers = options.handlers.unwrap_or_default().0;
    if handlers.is_empty() {
        return (channel, record);
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut functions = Vec::new();
    for (name, handler) in handlers {
        let record = record.clone();
        let remember = move |call: &HostCall| {
            record.lock().unwrap_or_else(|e| e.into_inner()).push((
                HostMessage {
                    name: call.name().to_owned(),
                    data: call.data().clone(),
                },
                call.is_post(),
            ));
        };
        match handler {
            HostHandlerOption::Value(value) => channel.handle(name, move |call| {
                remember(&call);
                call.resolve(value.clone());
            }),
            HostHandlerOption::Function(function) => {
                let index = functions.len();
                functions.push((name.clone(), function));
                let tx = tx.clone();
                channel.handle(name, move |call| {
                    remember(&call);
                    // Dropped when the test is gone: the call fails.
                    let _ = tx.send((index, call));
                });
            }
        }
    }
    if !functions.is_empty() {
        let server = server.get_or_insert_with(RouteServer::empty);
        server.host_handlers = functions;
        server.host_calls = RefCell::new(rx);
    }
    (channel, record)
}

/// The manual clock `open` gives the app (`clock: {}`).
#[derive(Debug, Default, Clone, PartialEq, JsObject)]
#[non_exhaustive]
pub struct ClockOptions {
    /// Its wall time at the start (`Date.now()`): a `Date` or milliseconds
    /// since the Unix epoch (now).
    pub time: Option<Time>,
}

/// A point in time as a test gives it: a `Date`, or milliseconds since the
/// Unix epoch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Time(pub std::time::SystemTime);

impl JsValue for Time {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Date | number".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let ms = value.as_date().or_else(|| value.as_number());
        let since = |ms: f64| Duration::from_secs_f64(ms.abs() / 1000.0);
        let time = match ms {
            Some(ms) if ms.is_finite() && ms >= 0.0 => std::time::UNIX_EPOCH.checked_add(since(ms)),
            Some(ms) if ms.is_finite() => std::time::UNIX_EPOCH.checked_sub(since(ms)),
            _ => None,
        };
        time.map(Time)
            .ok_or_else(|| value.expected("a Date or milliseconds since the Unix epoch"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

/// The system's appearance.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ColorScheme {
    /// Light mode.
    #[default]
    Light,
    /// Dark mode.
    Dark,
}

impl From<ColorScheme> for nsh_core::platform::ColorScheme {
    fn from(scheme: ColorScheme) -> Self {
        match scheme {
            ColorScheme::Light => nsh_core::platform::ColorScheme::Light,
            ColorScheme::Dark => nsh_core::platform::ColorScheme::Dark,
        }
    }
}

/// The platform a headless app is opened as.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum Platform {
    /// iOS.
    #[default]
    Ios,
    /// Android.
    Android,
    /// macOS: a desktop (keyboard shortcuts, the mouse's hover and context
    /// menus).
    Macos,
    /// Windows: a desktop.
    Windows,
    /// Linux: a desktop.
    Linux,
    /// A browser, in the desktop idiom.
    Web,
}

/// The platform a headless app is opened as.
#[deprecated(note = "use `Platform`, which has the desktops too")]
pub type MobilePlatform = Platform;

/// A dialog the app showed (`AlertDialog.show`, an action sheet).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct Dialog {
    /// Its title.
    pub title: Option<String>,
    /// Its message.
    pub message: Option<String>,
    /// Its buttons' texts (an action sheet's options), in order.
    pub buttons: Vec<String>,
    /// Whether it can be closed without a button (tapping outside).
    pub cancelable: bool,
    /// An action sheet rather than an alert.
    pub sheet: bool,
}

/// A pick the app asked for (`Picker.pickImages`), as a test reads it.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct Pick {
    /// The user may pick several.
    pub multiple: bool,
    /// At most this many.
    pub limit: u32,
    /// The longest side, in pixels, images are scaled down to; `null`:
    /// kept.
    pub max_dimension: Option<u32>,
    /// The quality of the JPEGs encoded (0 to 1); `null`: the default.
    pub quality: Option<f64>,
    /// The formats asked for: `"compatible"` or `"current"`.
    pub format: String,
}

impl From<&nsh_core::picker::PickRequest> for Pick {
    fn from(request: &nsh_core::picker::PickRequest) -> Self {
        Pick {
            multiple: request.multiple(),
            limit: request.limit,
            max_dimension: request.max_dimension.map(|d| d.0.max(0) as u32),
            quality: request.quality.map(|q| f64::from(q.0)),
            format: match request.format {
                nsh_core::picker::PickFormat::Current => "current",
                _ => "compatible",
            }
            .into(),
        }
    }
}

/// A file a test's pick handler gives the app (`app.onPick`).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct PickFile {
    /// Its name (`"cat.png"`).
    pub name: String,
    /// Its media type (`"image/png"`); none: read from its bytes or name.
    #[prop(rename = "type")]
    pub mime: Option<String>,
    /// Its bytes.
    pub data: Vec<u8>,
}

impl PickFile {
    fn into_picked(self) -> nsh_core::picker::PickedFile {
        nsh_core::picker::PickedFile::new(
            self.name,
            self.mime.unwrap_or_default(),
            nsh_core::ImageData::new(self.data),
        )
    }
}

/// How a wait waits.
#[derive(Debug, Default, Clone, Copy, JsObject)]
pub struct WaitOptions {
    /// How long it waits at most, in milliseconds (5000).
    pub timeout: Option<f64>,
    /// What it waits for: a view matching to show (`"shown"`, the default)
    /// or no view to match any more (`"gone"`).
    pub state: Option<WaitState>,
}

/// What a test pastes ([`App::paste`]): what the clipboard holds as the
/// user pastes.
#[derive(Debug, Default, Clone, JsObject)]
pub struct PasteContent {
    /// The text.
    pub text: Option<String>,
    /// Paths of files whose bytes are pasted (a screenshot: an image file),
    /// each a `File` of `onPaste`, its type from its extension.
    pub files: Option<Vec<String>>,
    /// `file:` URLs of local files, as a file manager copies them.
    pub uris: Option<Vec<String>>,
}

impl PasteContent {
    /// What `onPaste` reports of it, the files read.
    fn read(self) -> Result<nsh_core::PasteEvent, String> {
        let mut paste = nsh_core::PasteEvent::new(self.text.unwrap_or_default());
        for path in self.files.unwrap_or_default() {
            let data = std::fs::read(&path).map_err(|e| format!("paste: {path}: {e}"))?;
            let name = std::path::Path::new(&path)
                .file_name()
                .map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned());
            paste.files.push(nsh_core::PastedFile::new(
                name.clone(),
                mime_of(&name),
                data,
            ));
        }
        paste.uris = self.uris.unwrap_or_default();
        Ok(paste)
    }
}

/// The MIME type of a file named `name`, by its extension.
fn mime_of(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match extension.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("svg") => "image/svg+xml",
        Some("txt") => "text/plain",
        Some("json") => "application/json",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// How far a drag moves the finger ([`App::drag`]), in points.
#[derive(Debug, Default, Clone, Copy, PartialEq, JsObject)]
pub struct DragBy {
    /// Rightwards (negative: leftwards).
    #[prop(default)]
    pub x: Points,
    /// Downwards (negative: upwards).
    #[prop(default)]
    pub y: Points,
}

/// An action of the context menu the app shows (`app.menu()`).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct MenuEntry {
    /// Its label; a submenu's actions after the submenu's (`"Share > Mail"`).
    pub label: String,
    /// It cannot be chosen (it, or a submenu around it, is disabled).
    pub disabled: bool,
    /// Its check mark, when it is a checkable item.
    #[prop(skip_none)]
    pub checked: Option<bool>,
}

/// The style of a span as the app resolved it (`app.spanStyle`). Colors
/// are `#rrggbbaa`.
#[derive(Debug, Clone, PartialEq, JsObject)]
#[non_exhaustive]
pub struct SpanStyle {
    /// Its text color.
    pub color: String,
    /// The background a nested text's `backgroundColor` gives it.
    #[prop(skip_none)]
    pub background_color: Option<String>,
    /// Its font size, in points.
    pub font_size: f64,
    /// Its font weight (400 regular, 700 bold).
    pub font_weight: f64,
    /// Whether it is italic.
    pub italic: bool,
    /// Whether it is underlined.
    pub underline: bool,
    /// Whether it is struck through.
    pub line_through: bool,
}

impl Default for SpanStyle {
    fn default() -> Self {
        nsh_core::ResolvedTextStyle::default().into()
    }
}

impl From<nsh_core::ResolvedTextStyle> for SpanStyle {
    fn from(style: nsh_core::ResolvedTextStyle) -> Self {
        let css = |color: nsh_core::Color| format!("#{:08x}", color.0);
        SpanStyle {
            color: css(style.color),
            background_color: style.background.map(|b| css(b.color)),
            font_size: f64::from(style.font_size.0),
            font_weight: f64::from(style.font_weight),
            italic: style.italic,
            underline: style.decoration.underline,
            line_through: style.decoration.line_through,
        }
    }
}

/// What [`WaitOptions`] waits for.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum WaitState {
    /// A view matching shows.
    #[default]
    Shown,
    /// No view matches any more.
    Gone,
}

impl WaitOptions {
    fn timeout(&self) -> Duration {
        self.timeout.map_or(crate::headless::WAIT, |ms| {
            Duration::from_secs_f64(ms.max(0.0) / 1000.0)
        })
    }
}

impl From<&nsh_core::Dialog> for Dialog {
    fn from(dialog: &nsh_core::Dialog) -> Self {
        Dialog {
            title: dialog.title.clone(),
            message: dialog.message.clone(),
            buttons: dialog.buttons.iter().map(|b| b.text.clone()).collect(),
            cancelable: dialog.cancelable,
            sheet: dialog.sheet,
        }
    }
}

/// Safe area insets in points.
#[derive(Debug, Default, Clone, Copy, PartialEq, JsObject)]
pub struct SafeArea {
    /// The top inset.
    #[prop(default)]
    pub top: Points,
    /// The right inset.
    #[prop(default)]
    pub right: Points,
    /// The bottom inset.
    #[prop(default)]
    pub bottom: Points,
    /// The left inset.
    #[prop(default)]
    pub left: Points,
}

/// String entries by key: TS `Record<string, string>`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Entries(pub BTreeMap<String, String>);

impl JsValue for Entries {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Record<string, string>".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let JsonValue::Object(map) = value.to_json()? else {
            return Err(value.expected("an object of strings"));
        };
        map.into_iter()
            .map(|(key, v)| match v {
                JsonValue::String(s) => Ok((key, s)),
                other => Err(PropError::expected("a string", &other)),
            })
            .collect::<Result<_, _>>()
            .map(Entries)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let map = self
            .0
            .iter()
            .map(|(k, v)| (k.clone(), JsonValue::String(v.clone())))
            .collect();
        Ok(JsOwned::new(host, host.json(&JsonValue::Object(map))?))
    }
}

/// The network of an app a test opens.
#[derive(Debug)]
pub enum NetworkOption {
    /// The network itself (`"live"`).
    Live,
    /// The routes listed, by `"<METHOD> <URL>"`.
    Routes(Vec<(String, RouteOption)>),
}

/// What a route of `open`'s `network` answers with.
#[derive(Debug)]
pub enum RouteOption {
    /// This response.
    Response(StubResponse),
    /// What this function returns for the request (or the promise it
    /// returns resolves to).
    Handler(Callback<StubRequest, JsonValue>),
}

impl JsValue for NetworkOption {
    fn ts_type(types: &mut TsTypes) -> String {
        let response = types.declare("StubResponse", |_| {
            "/** A response `open`'s `network` gives a request. */\n\
             export interface StubResponse {\n  \
             /** The status code (200). */\n  status?: number;\n  \
             /** Header names and values. */\n  headers?: Record<string, string>;\n  \
             /** The body: a string, or a value sent as JSON (with `content-type: \
             application/json` unless `headers` name one). */\n  body?: unknown;\n  \
             /** The request fails with this message instead: no response (offline, a \
             reset connection). */\n  error?: string;\n  \
             /** How long the response takes, in milliseconds. */\n  delay?: number;\n}"
                .to_owned()
        });
        let request = <StubRequest as JsValue>::ts_type(types);
        format!(
            "\"live\" | Record<string, {response} | ((request: {request}) => {response} | Promise<{response}>)>"
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.as_string().as_deref() == Some("live") {
            return Ok(NetworkOption::Live);
        }
        if value.kind() != JsKind::Object {
            return Err(value.expected("\"live\" or an object of routes"));
        }
        let mut routes = Vec::new();
        for key in value.keys()? {
            let field = value.field(&key)?;
            let field = field.get();
            let route = if field.kind() == JsKind::Function {
                <Callback<StubRequest, JsonValue> as Arg>::from_js(field).map(RouteOption::Handler)
            } else {
                stub_response(&field.to_json()?).map(RouteOption::Response)
            };
            routes.push((
                key.clone(),
                route.map_err(|e| PropError(format!("`{key}`: {}", e.0)))?,
            ));
        }
        Ok(NetworkOption::Routes(routes))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let json = match self {
            NetworkOption::Live => JsonValue::String("live".into()),
            // A route's function stays JS's: only responses go back.
            NetworkOption::Routes(routes) => JsonValue::Object(
                routes
                    .iter()
                    .filter_map(|(key, route)| match route {
                        RouteOption::Response(r) => Some((key.clone(), response_json(r))),
                        RouteOption::Handler(_) => None,
                    })
                    .collect(),
            ),
        };
        Ok(JsOwned::new(host, host.json(&json)?))
    }
}

/// `response` as a test writes one.
fn response_json(response: &StubResponse) -> JsonValue {
    let headers = response
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), JsonValue::String(v.clone())))
        .collect();
    let mut json = serde_json::json!({
        "status": response.status,
        "headers": JsonValue::Object(headers),
        "body": String::from_utf8_lossy(&response.body),
        "delay": response.delay.as_millis() as f64,
    });
    if let Some(error) = &response.error {
        json["error"] = JsonValue::String(error.clone());
    }
    json
}

/// A request the app made, as a test reads it (`app.requests()`, a route's
/// function).
#[derive(Debug, Default, Clone, PartialEq, JsObject)]
#[non_exhaustive]
pub struct StubRequest {
    /// Its method (`GET`, `POST`, ...).
    pub method: String,
    /// Its URL.
    pub url: String,
    /// Its headers, by name.
    pub headers: Entries,
    /// Its body as text, `null` without one (or streamed).
    pub body: Option<String>,
}

impl From<&HttpRequest> for StubRequest {
    fn from(request: &HttpRequest) -> Self {
        StubRequest {
            method: request.method.clone(),
            url: request.url.clone(),
            headers: Entries(request.headers.iter().cloned().collect()),
            body: match &request.body {
                HttpBody::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
                _ => None,
            },
        }
    }
}

/// How an app starts, handed to the thread that starts it: `open`'s options
/// with the routes' JS functions left on the test file's VM.
pub(crate) struct Launch {
    pub(crate) storage: Entries,
    pub(crate) network: NetworkSetup,
    pub(crate) width: Option<Points>,
    pub(crate) height: Option<Points>,
    pub(crate) safe_area: SafeArea,
    pub(crate) clipboard: Option<String>,
    pub(crate) color_scheme: ColorScheme,
    pub(crate) locale: Option<String>,
    pub(crate) reduced_motion: bool,
    pub(crate) platform: Platform,
    /// A manual clock's start.
    pub(crate) clock: Option<std::time::SystemTime>,
    /// The embedding app's channel with the app: the test's launch
    /// parameters and handlers.
    pub(crate) host: HostChannel,
    /// Whether `open`'s `host` has handlers (a headless run's only).
    pub(crate) host_handlers: bool,
}

/// The network an app opens with, made where it starts (it is `Send`).
pub(crate) enum NetworkSetup {
    /// None: every request fails.
    None,
    /// The network itself.
    Live,
    /// The routes.
    Stub(Vec<(String, StubRoute)>),
}

/// A request a route's JS function answers, waiting for the test file's
/// VM.
struct RouteCall {
    route: usize,
    request: HttpRequest,
    reply: StubReply,
}

/// The JS functions of an app's routes, and the requests waiting for them:
/// answered while the app's steps run ([`serve`]).
pub(crate) struct RouteServer {
    keys: Vec<String>,
    handlers: Vec<Callback<StubRequest, JsonValue>>,
    calls: RefCell<tokio::sync::mpsc::UnboundedReceiver<RouteCall>>,
    /// The JS functions of `open`'s `host.handlers`, by name, and the
    /// app's calls and posts waiting for them.
    host_handlers: Vec<(String, Callback<JsonValue, JsonValue>)>,
    host_calls: RefCell<tokio::sync::mpsc::UnboundedReceiver<(usize, HostCall)>>,
}

impl RouteServer {
    /// A server with no functions yet.
    fn empty() -> Self {
        RouteServer {
            keys: Vec::new(),
            handlers: Vec::new(),
            calls: RefCell::new(tokio::sync::mpsc::unbounded_channel().1),
            host_handlers: Vec::new(),
            host_calls: RefCell::new(tokio::sync::mpsc::unbounded_channel().1),
        }
    }

    /// Answers the app's call (or post) with its handler's function: what
    /// it returns resolves the call, what it throws rejects it (the app's
    /// to handle, not the test's failure).
    async fn answer_host(&self, index: usize, mut call: HostCall) {
        let data = call.take_data();
        let answer = self.host_handlers[index].1.call_async(data).await;
        match answer {
            Ok(value) => call.resolve(value),
            Err(error) => call.reject(error.to_string()),
        }
    }

    /// Answers `call` with its function's response: an error the step
    /// reports when the function threw or gave no response.
    async fn answer(&self, call: RouteCall) -> Result<(), String> {
        let key = &self.keys[call.route];
        let given = self.handlers[call.route]
            .call_async((&call.request).into())
            .await
            .map_err(|e| format!("the route `{key}` threw: {e}"))
            .and_then(|json| {
                stub_response(&json)
                    .map_err(|e| format!("the route `{key}` gave no response: {}", e.0))
            });
        match given {
            Ok(response) => {
                call.reply.send(response);
                Ok(())
            }
            Err(message) => {
                call.reply.send(StubResponse {
                    error: Some(message.clone()),
                    ..StubResponse::default()
                });
                Err(message)
            }
        }
    }
}

/// The network `option` sets up, and the server of its JS functions.
fn network_setup(option: Option<NetworkOption>) -> (NetworkSetup, Option<RouteServer>) {
    let routes = match option {
        None => return (NetworkSetup::None, None),
        Some(NetworkOption::Live) => return (NetworkSetup::Live, None),
        Some(NetworkOption::Routes(routes)) => routes,
    };
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut keys = Vec::new();
    let mut handlers = Vec::new();
    let mut stub = Vec::new();
    for (key, route) in routes {
        let route = match route {
            RouteOption::Response(response) => StubRoute::Response(response),
            RouteOption::Handler(handler) => {
                let index = handlers.len();
                handlers.push(handler);
                keys.push(key.clone());
                let tx = tx.clone();
                StubRoute::Handler(Arc::new(move |request: HttpRequest, reply: StubReply| {
                    let _ = tx.send(RouteCall {
                        route: index,
                        request,
                        reply,
                    });
                }))
            }
        };
        stub.push((key, route));
    }
    let server = (!handlers.is_empty()).then(|| RouteServer {
        keys,
        handlers,
        calls: RefCell::new(rx),
        ..RouteServer::empty()
    });
    (NetworkSetup::Stub(stub), server)
}

/// `future`, while `server` answers the requests of the app's routes that
/// come meanwhile; an error when one of their functions failed.
async fn serve<T>(
    server: Option<&RouteServer>,
    future: impl Future<Output = T>,
) -> Result<T, String> {
    let Some(server) = server else {
        return Ok(future.await);
    };
    /// What comes first: the future's end, or a call for a JS function.
    enum Next<T> {
        Done(T),
        Route(RouteCall),
        Host(usize, HostCall),
    }
    let mut future = std::pin::pin!(future);
    let mut failed = None;
    loop {
        let next = std::future::poll_fn(|cx| {
            if let Poll::Ready(value) = future.as_mut().poll(cx) {
                return Poll::Ready(Next::Done(value));
            }
            if let Poll::Ready(Some(call)) = server.calls.borrow_mut().poll_recv(cx) {
                return Poll::Ready(Next::Route(call));
            }
            match server.host_calls.borrow_mut().poll_recv(cx) {
                Poll::Ready(Some((index, call))) => Poll::Ready(Next::Host(index, call)),
                _ => Poll::Pending,
            }
        })
        .await;
        match next {
            Next::Done(value) => return failed.map_or(Ok(value), Err),
            Next::Route(call) => {
                if let Err(e) = server.answer(call).await {
                    failed.get_or_insert(e);
                }
            }
            Next::Host(index, call) => server.answer_host(index, call).await,
        }
    }
}

/// A response as a test writes it.
fn stub_response(value: &JsonValue) -> Result<StubResponse, PropError> {
    let JsonValue::Object(map) = value else {
        return Err(PropError::expected("a response object", value));
    };
    let status = match map.get("status") {
        None | Some(JsonValue::Null) => 200,
        Some(JsonValue::Number(n)) => n
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .ok_or_else(|| PropError(format!("`status`: not a status code: {n}")))?,
        Some(other) => return Err(PropError::expected("a number", other)),
    };
    let mut headers = Vec::new();
    match map.get("headers") {
        None | Some(JsonValue::Null) => {}
        Some(JsonValue::Object(h)) => {
            for (name, v) in h {
                let JsonValue::String(v) = v else {
                    return Err(PropError(format!(
                        "`headers.{name}`: {}",
                        PropError::expected("a string", v).0
                    )));
                };
                headers.push((name.clone(), v.clone()));
            }
        }
        Some(other) => return Err(PropError::expected("an object of strings", other)),
    }
    let body = match map.get("body") {
        None | Some(JsonValue::Null) => Vec::new(),
        Some(JsonValue::String(s)) => s.clone().into_bytes(),
        Some(json) => {
            if !headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
            {
                headers.push(("content-type".into(), "application/json".into()));
            }
            json.to_string().into_bytes()
        }
    };
    let error = match map.get("error") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(message)) => Some(message.clone()),
        Some(other) => return Err(PropError::expected("a string", other)),
    };
    let delay = match map.get("delay") {
        None | Some(JsonValue::Null) => Duration::ZERO,
        Some(JsonValue::Number(ms)) => {
            Duration::from_secs_f64(ms.as_f64().unwrap_or(0.0).max(0.0) / 1000.0)
        }
        Some(other) => return Err(PropError::expected("a number of milliseconds", other)),
    };
    Ok(StubResponse {
        status,
        headers,
        body,
        error,
        delay,
    })
}

/// The app a test opened (`open`), on a headless engine of its
/// own: its steps (`press`, `type`, `scroll`, ...) take the views a
/// selector names, `id:<testID>`, `label:<accessibilityLabel>`,
/// `text:<text>`, `view:<id>` or a bare string (a test id, a label, then a
/// text), where a user would look first (the top modal, the top screen of
/// a stack). A step resolves once the app is quiet and rejects, with what
/// is on screen, when it cannot be taken or the app threw.
#[class]
pub struct App {
    steps: Steps,
    /// Its storage, on a headless engine.
    storage: Option<Arc<MemoryStorage>>,
    /// The requests the app made, on a headless engine.
    requests: Option<Arc<RecordingNetwork>>,
    /// The calls and posts the handlers of `open`'s `host` got.
    host: HostRecord,
}

/// The embedding app the test plays for an app (`app.host`, after
/// `open(entry, { host })`; `nsh/host`): its events to the app and what
/// the app sent it.
#[class]
pub struct AppHost {
    steps: Steps,
    record: HostRecord,
}

#[class]
impl AppHost {
    /// Sends event `name` with `data` to the app (its `host.on(name,
    /// listener)` hears it, or keeps it until it listens), and resolves once
    /// the app is quiet.
    pub async fn send(
        this: Instance<Self>,
        name: String,
        data: Option<JsonValue>,
    ) -> Result<(), String> {
        let steps = this.with(|h| h.steps.clone());
        let data = data.unwrap_or(JsonValue::Null);
        steps.run(move |app| app.send_host_event(&name, data)).await
    }

    /// The app's calls (`host.call`) of the names `open`'s `host.handlers`
    /// lists, in order.
    pub fn calls(&self) -> Vec<HostMessage> {
        self.messages(false)
    }

    /// The app's posts (`host.post`) of the names `open`'s `host.handlers`
    /// lists, in order.
    pub fn posts(&self) -> Vec<HostMessage> {
        self.messages(true)
    }
}

impl AppHost {
    fn messages(&self, posts: bool) -> Vec<HostMessage> {
        self.record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, post)| *post == posts)
            .map(|(message, _)| message.clone())
            .collect()
    }
}

/// What steps on an app take: `App`'s and its clock's.
#[derive(Clone)]
struct Steps {
    app: OpenApp,
    /// The JS functions of its routes.
    server: Option<Rc<RouteServer>>,
    /// Answers the dialogs the app shows ([`App::on_dialog`]).
    dialog: Rc<RefCell<Option<DialogCallback>>>,
    /// Answers the picks the app asks for ([`App::on_pick`]).
    pick: Rc<RefCell<Option<PickCallback>>>,
}

/// A test's answer to the picks (`app.onPick`).
type PickCallback = Callback<Pick, Option<Vec<PickFile>>>;

/// A test's answer to the dialogs (`app.onDialog`).
type DialogCallback = Callback<Dialog, Option<String>>;

/// The manual clock of an app (`app.clock`, after `open(entry, { clock:
/// {} })`), as Playwright's `page.clock`: its time moves only as these
/// say.
#[class]
pub struct Clock {
    steps: Steps,
}

#[class]
impl Clock {
    /// Moves the clock by `ms` milliseconds, a display frame at a time:
    /// timers, frames and native animations run as they come due, in order;
    /// resolves once the app is quiet.
    pub async fn run_for(this: Instance<Self>, ms: f64) -> Result<(), String> {
        let time = duration(ms)?;
        let steps = this.with(|c| c.steps.clone());
        steps.run(move |app| app.run_for(time)).await
    }

    /// Moves the clock by `ms` milliseconds at once, as a device waking from
    /// sleep: the timers due meanwhile run once each; resolves once the app
    /// is quiet.
    pub async fn fast_forward(this: Instance<Self>, ms: f64) -> Result<(), String> {
        let time = duration(ms)?;
        let steps = this.with(|c| c.steps.clone());
        steps.run(move |app| app.fast_forward(time)).await
    }

    /// Sets the wall time (`Date.now()`, `new Date()`) to `time`, moving no
    /// timer.
    pub fn set_system_time(&self, time: Time) -> Result<(), String> {
        let mut app = self.steps.app.lock().unwrap_or_else(|e| e.into_inner());
        app.as_mut().ok_or(CLOSED)?.set_system_time(time.0)
    }
}

/// The keyboard of an app (`app.keyboard`), as Playwright's
/// `page.keyboard`: a hardware keyboard's keys.
#[class]
pub struct Keyboard {
    steps: Steps,
}

#[class]
impl Keyboard {
    /// Presses `keys`, a keystroke as `nsh/keymap` names it (`"mod+k"`,
    /// `"shift+/"`, `"escape"`; `mod` is the platform's command key): the
    /// app's shortcut of it hears it (`onKeyCommand`), else the focused
    /// input takes it, else Escape goes back.
    pub async fn press(this: Instance<Self>, keys: String) -> Result<(), String> {
        let steps = this.with(|k| k.steps.clone());
        steps.run(move |app| app.press_key(&keys)).await
    }
}

/// `ms` milliseconds, which a test gives as a number.
fn duration(ms: f64) -> Result<Duration, String> {
    if ms.is_finite() && ms >= 0.0 {
        Ok(Duration::from_secs_f64(ms / 1000.0))
    } else {
        Err(format!("a time is milliseconds, zero or more, not {ms}"))
    }
}

/// What a step on an app that was closed says.
const CLOSED: &str = "the app is closed: the test that opened it ended";

#[class]
impl App {
    /// Presses what `selector` names (or the nearest view around it that
    /// hears presses, as a tap on a button's text does).
    pub async fn press(this: Instance<Self>, selector: String) -> Result<(), String> {
        step(&this, move |app| app.press(&selector)).await
    }

    /// Types `text` at the end of the input `selector` names (or the first
    /// input in it; `text:` matches an input's text or placeholder too),
    /// key by key; a line break in a single line is the return key.
    pub async fn r#type(
        this: Instance<Self>,
        selector: String,
        text: String,
    ) -> Result<(), String> {
        step(&this, move |app| app.type_text(&selector, &text)).await
    }

    /// The return key in the input `selector` names, as its
    /// `submitBehavior` says.
    pub async fn submit(this: Instance<Self>, selector: String) -> Result<(), String> {
        step(&this, move |app| app.submit(&selector)).await
    }

    /// Drags the scroll view `selector` names (or the one around it, or the
    /// first in it) by `distance` points along its axis (negative: back),
    /// within its content.
    pub async fn scroll(
        this: Instance<Self>,
        selector: String,
        distance: f64,
    ) -> Result<(), String> {
        step(&this, move |app| {
            app.scroll(&selector, nsh_core::geometry::px(distance as f32))
        })
        .await
    }

    /// Drags what `selector` names: a finger lands on its middle, rests for
    /// 100 ms, moves by `by` points, 10 per display frame, and lifts. A pan moves with it
    /// (`onPanStart`, `onPanEnd`), the views listening to touches hear them,
    /// a scroll view scrolls (pulled past its top, it refreshes), and the
    /// press under the finger is cancelled.
    pub async fn drag(this: Instance<Self>, selector: String, by: DragBy) -> Result<(), String> {
        let by = nsh_core::geometry::point(by.x, by.y);
        step(&this, move |app| app.drag(&selector, by)).await
    }

    /// The mouse's secondary button over the middle of what `selector`
    /// names: it, or the nearest view around it listening, hears
    /// `onContextMenu`, whose handler shows a menu (`Menu.popup`: read it
    /// with `menu()`). Desktops and the web only: a phone has no mouse.
    pub async fn right_click(this: Instance<Self>, selector: String) -> Result<(), String> {
        step(&this, move |app| app.right_click(&selector)).await
    }

    /// Pastes `content` into the input `selector` names (or the first input
    /// in it), as the user's paste does with it on the clipboard: the input
    /// takes the focus and hears `onPaste` (`files` are paths whose bytes
    /// it gets as `File`s), then its text goes in as `pasteBehavior` says.
    /// The machine's clipboard stays as it was.
    pub async fn paste(
        this: Instance<Self>,
        selector: String,
        content: PasteContent,
    ) -> Result<(), String> {
        let content = content.read()?;
        step(&this, move |app| app.paste(&selector, &content)).await
    }

    /// Chooses the open context menu's action labelled `label` (a
    /// submenu's: `"Share > Mail"`), as a click on it: the app hears
    /// `onMenu`, then the menu closes.
    pub async fn choose_menu_item(this: Instance<Self>, label: String) -> Result<(), String> {
        step(&this, move |app| app.choose_menu_item(&label)).await
    }

    /// Closes the open context menu with nothing chosen, as Escape does.
    pub async fn close_menu(this: Instance<Self>) -> Result<(), String> {
        step(&this, move |app| app.close_menu()).await
    }

    /// Moves the mouse over the middle of what `selector` names: the views
    /// under it hear `onHoverIn` (and the ones it left `onHoverOut`), take
    /// their `hover:` styles and hear `onHoverMove`. Desktops and the web
    /// (at any width: a browser has a mouse) only: an iOS or Android phone
    /// has none.
    pub async fn hover(this: Instance<Self>, selector: String) -> Result<(), String> {
        step(&this, move |app| app.hover(&selector)).await
    }

    /// Lets the app run for `ms` milliseconds (timers and animations): on a
    /// manual clock, moves it by `ms` (`clock.runFor`).
    pub async fn wait(this: Instance<Self>, ms: f64) -> Result<(), String> {
        let time = Duration::from_secs_f64(ms.max(0.0) / 1000.0);
        step(&this, move |app| app.wait(time)).await
    }

    /// Resolves once a view on screen matches `selector`; rejects after
    /// `timeout` milliseconds (5000).
    pub async fn wait_for(
        this: Instance<Self>,
        selector: String,
        options: Option<WaitOptions>,
    ) -> Result<(), String> {
        let options = options.unwrap_or_default();
        let timeout = options.timeout();
        match options.state.unwrap_or_default() {
            WaitState::Shown => {
                step(&this, move |app| app.wait_for_within(&selector, timeout)).await
            }
            WaitState::Gone => step(&this, move |app| app.wait_for_gone(&selector, timeout)).await,
        }
    }

    /// Resolves once `condition` returns true, looking again after each
    /// change of the app (a render, an animation frame); rejects after
    /// `options.timeout` milliseconds (5000): for what no selector says
    /// (`app.storage().note === "Milk"`).
    pub async fn wait_until(
        this: Instance<Self>,
        condition: Callback<(), bool>,
        options: Option<WaitOptions>,
    ) -> Result<(), String> {
        let timeout = options.unwrap_or_default().timeout();
        let deadline = std::time::Instant::now() + timeout;
        let app = this.with(|a| a.steps.app.clone());
        let server = this.with(|a| a.steps.server.clone());
        on_app(&app, |a| {
            a.step("waitUntil");
            Ok(())
        })
        .await?;
        loop {
            if condition.call_async(()).await? {
                return Ok(());
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                let screen = on_app(&app, |a| Ok(format!("{:?}", a.texts()?))).await?;
                return Err(format!(
                    "the condition never held in {} ms; on screen: {screen}",
                    timeout.as_millis()
                ));
            }
            let wait = left.min(Duration::from_millis(50));
            serve(
                server.as_deref(),
                on_app(&app, move |a| a.next_change(wait)),
            )
            .await??;
        }
    }

    /// Holds a finger on what `selector` names (or the nearest view around
    /// it that hears long presses or presses) for its `delayLongPress`
    /// (500 ms): `onPressDown`, `onLongPress`, `onPressUp`.
    pub async fn long_press(this: Instance<Self>, selector: String) -> Result<(), String> {
        step(&this, move |app| app.long_press(&selector)).await
    }

    /// Empties the input `selector` names, as selecting all and deleting
    /// does.
    pub async fn clear(this: Instance<Self>, selector: String) -> Result<(), String> {
        step(&this, move |app| app.clear(&selector)).await
    }

    /// How many views on screen match `selector` now.
    pub fn count(&self, selector: String) -> Result<u32, String> {
        self.with(|app| Ok(app.count(&selector)? as u32))
    }

    /// Whether the view `selector` names takes input now: neither it nor a
    /// view around it is disabled, and an input is not `readonly`.
    pub fn enabled(&self, selector: String) -> Result<bool, String> {
        self.with(|app| app.enabled(&selector))
    }

    /// Whether a view on screen matches `selector` now.
    pub fn shows(&self, selector: String) -> Result<bool, String> {
        self.with(|app| app.shows(&selector))
    }

    /// The texts on screen now, in order.
    pub fn texts(&self) -> Result<Vec<String>, String> {
        self.with(|app| app.texts())
    }

    /// The text of the input `selector` names, `null` when none matches.
    pub fn value(&self, selector: String) -> Result<Option<String>, String> {
        self.with(|app| app.value(&selector))
    }

    /// The style of the characters `selector` names, from the first
    /// character. `id:<testID>` names a nested text. `text:<text>` names
    /// where the text reads it. The parts before the last name the views
    /// to look in (`id:note >> text:here`). Headless tests read this style;
    /// an empty span reports an error because it has no first character.
    pub fn span_style(&self, selector: String) -> Result<SpanStyle, String> {
        self.with(|app| app.span_style(&selector).map(SpanStyle::from))
    }

    /// What the app's storage holds now.
    pub fn storage(&self) -> Result<Entries, String> {
        if let Some(storage) = &self.storage {
            return Ok(Entries(storage.entries()));
        }
        // On a real host: as the host's app keeps it.
        let mut app = self.steps.app.lock().unwrap_or_else(|e| e.into_inner());
        let driver = app.as_mut().ok_or("the app is closed")?;
        Ok(Entries(driver.storage()?))
    }

    /// Goes back as the user does (a header's back button, swiping a sheet
    /// down): the innermost stack of the newest modal (else of the screen)
    /// pops its top screen, or asks it when it prevents going back; without
    /// one, the newest modal asks to close. Rejects when there is nothing
    /// to go back from.
    pub async fn back(this: Instance<Self>) -> Result<(), String> {
        step(&this, |app| app.back()).await
    }

    /// Answers the dialogs the app shows from now on (`AlertDialog.show`, action
    /// sheets): `handler` returns the text of the button to press, or
    /// `null` to close it without one. Without a handler, a dialog's cancel
    /// button is pressed, else it is closed when it can be, else the step
    /// that showed it rejects.
    pub fn on_dialog(&mut self, #[args(dialog)] handler: Callback<Dialog, Option<String>>) {
        *self.steps.dialog.borrow_mut() = Some(handler);
    }

    /// Answers the picks the app asks for from now on (`Picker.pickImages`):
    /// `handler` gets what the pick asks and returns the files the user
    /// picks, given as they are (no scaling or conversion), or `null` to
    /// cancel. Without a handler, every pick is cancelled. Headless runs
    /// only: a real platform shows its picker.
    pub fn on_pick(&mut self, #[args(pick)] handler: Callback<Pick, Option<Vec<PickFile>>>) {
        *self.steps.pick.borrow_mut() = Some(handler);
    }

    /// The picks the app asked for, in order.
    pub fn picks(&self) -> Result<Vec<Pick>, String> {
        self.with(|app| Ok(app.picks()?.iter().map(Pick::from).collect()))
    }

    /// The dialogs the app showed, in order.
    pub fn dialogs(&self) -> Result<Vec<Dialog>, String> {
        self.with(|app| Ok(app.dialogs()?.iter().map(Dialog::from).collect()))
    }

    /// The actions of the context menu the app shows (`Menu.popup`), a
    /// submenu's after its label (`"Share > Mail"`); `null` when none is
    /// open.
    pub fn menu(&self) -> Result<Option<Vec<MenuEntry>>, String> {
        self.with(|app| {
            Ok(app.menu()?.map(|entries| {
                entries
                    .into_iter()
                    .map(|e| MenuEntry {
                        label: e.label,
                        disabled: e.disabled,
                        checked: e.checked,
                    })
                    .collect()
            }))
        })
    }

    /// The app's keyboard, whose keys the test presses.
    #[getter]
    pub fn keyboard(&self) -> Keyboard {
        Keyboard {
            steps: self.steps.clone(),
        }
    }

    /// The app's manual clock (`open`'s `clock`), which the test moves.
    #[getter]
    pub fn clock(&self) -> Clock {
        Clock {
            steps: self.steps.clone(),
        }
    }

    /// The embedding app the test plays (`open`'s `host`): its events to
    /// the app, and the calls and posts the app sent it.
    #[getter]
    pub fn host(&self) -> AppHost {
        AppHost {
            steps: self.steps.clone(),
            record: self.host.clone(),
        }
    }

    /// The URLs the app opened (`openUrl` of `nsh/device`, a `TextView`'s
    /// links), in order: recorded, never opened, and reported opened to
    /// the app.
    pub fn opened_urls(&self) -> Result<Vec<String>, String> {
        self.with(|app| app.opened_urls())
    }

    /// The requests the app made, in order.
    pub fn requests(&self) -> Result<Vec<StubRequest>, String> {
        let requests = self
            .requests
            .as_ref()
            .ok_or_else(|| headless_only("`requests()`"))?;
        Ok(requests.requests().iter().map(StubRequest::from).collect())
    }

    /// A picture of the app's window as a PNG, also saved at `path`
    /// (relative to the current directory, on this machine) when given: a
    /// real platform's (`nsh test --target`), which draws the app; a
    /// headless run draws nothing.
    pub async fn screenshot(this: Instance<Self>, path: Option<String>) -> Result<Vec<u8>, String> {
        let app = this.with(|a| a.steps.app.clone());
        let png = on_app(&app, |a| a.screenshot()).await?;
        if let Some(path) = path {
            let saved = png.clone();
            blocking(move || {
                std::fs::write(&path, saved).map_err(|e| format!("screenshot({path:?}): {e}"))
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        Ok(png)
    }

    /// Makes the viewport `width` × `height` points (a rotation, a resized
    /// window) and resolves once the app laid itself out again.
    pub async fn set_viewport(this: Instance<Self>, width: f64, height: f64) -> Result<(), String> {
        let size = nsh_core::Size::new(Points(width as f32), Points(height as f32));
        step(&this, move |app| app.set_viewport(size)).await
    }

    /// Switches the system's appearance to `scheme`, as the user does.
    pub async fn set_color_scheme(this: Instance<Self>, scheme: ColorScheme) -> Result<(), String> {
        step(&this, move |app| app.set_color_scheme(scheme.into())).await
    }

    /// The text on the clipboard now, `null` when it holds none.
    pub fn clipboard(&self) -> Result<Option<String>, String> {
        self.with(|app| app.clipboard())
    }

    /// `f` with the app as it is now (the batches that came applied).
    fn with<R>(&self, f: impl FnOnce(&mut dyn Driver) -> Result<R, String>) -> Result<R, String> {
        let mut app = self.steps.app.lock().unwrap_or_else(|e| e.into_inner());
        f(app.as_deref_mut().ok_or(CLOSED)?)
    }
}

/// Runs the step `f` of the app `this` on a blocking thread, then answers
/// the dialogs it showed: with the test's handler (JS, on this thread),
/// else as [`default_answer`] says.
async fn step(
    this: &Instance<App>,
    f: impl FnOnce(&mut dyn Driver) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    this.with(|a| a.steps.clone()).run(f).await
}

impl Steps {
    /// Runs the step `f` on a blocking thread, then answers the dialogs it
    /// showed ([`step`]).
    async fn run(
        &self,
        f: impl FnOnce(&mut dyn Driver) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let Steps {
            app,
            server,
            dialog,
            pick,
        } = self;
        serve(server.as_deref(), on_app(app, f)).await??;
        loop {
            let pending = on_app(app, |a| Ok(a.pending_dialog())).await?;
            let Some(shown) = pending else {
                let asked = on_app(app, |a| Ok(a.pending_pick())).await?;
                let Some(asked) = asked else {
                    return Ok(());
                };
                let handler = pick.borrow().clone();
                let files = match handler {
                    Some(handler) => handler
                        .call_async(Pick::from(&asked))
                        .await?
                        .unwrap_or_default()
                        .into_iter()
                        .map(PickFile::into_picked)
                        .collect(),
                    None => Vec::new(),
                };
                serve(
                    server.as_deref(),
                    on_app(app, move |a| a.answer_pick(files)),
                )
                .await??;
                continue;
            };
            let handler = dialog.borrow().clone();
            let answer = match handler {
                Some(handler) => match handler.call_async((&shown).into()).await? {
                    Some(text) => headless::DialogAnswer::Press(text),
                    None => headless::DialogAnswer::Dismiss,
                },
                None => default_answer(&shown)?,
            };
            serve(
                server.as_deref(),
                on_app(app, move |a| a.answer_dialog(answer)),
            )
            .await??;
        }
    }
}

/// `f` with the app `app`, on a blocking thread.
async fn on_app<R: Send + 'static>(
    app: &OpenApp,
    f: impl FnOnce(&mut dyn Driver) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    let app = app.clone();
    blocking(move || {
        let mut app = app.lock().unwrap_or_else(|e| e.into_inner());
        f(app.as_deref_mut().ok_or(CLOSED)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What a test expects of a value (`expect`); each check throws
/// when it does not hold.
#[class]
pub struct Expectation {
    value: JsonValue,
    /// The function `expect` was given, for `toThrow` and `rejects`.
    run: Option<Callback<(), JsonValue>>,
    not: bool,
}

#[class]
impl Expectation {
    /// The opposite checks: `expect(texts).not.toContain("Error")`.
    #[getter]
    pub fn not(&self) -> Expectation {
        Expectation {
            value: self.value.clone(),
            run: self.run.clone(),
            not: !self.not,
        }
    }

    /// The checks of what the promise the function returns rejects with:
    /// `await expect(() => app.press("Pay")).rejects.toThrow("declined")`.
    #[getter]
    pub fn rejects(&self) -> Result<Rejection, String> {
        let run = self
            .run
            .clone()
            .ok_or("`rejects` checks a function: `expect(() => promise).rejects`")?;
        Ok(Rejection { run, not: self.not })
    }

    /// The value matches `pattern`: contains it (a string), or matches it (a
    /// `RegExp`).
    pub fn to_match(&self, pattern: Pattern) -> Result<(), String> {
        let holds = match &self.value {
            JsonValue::String(s) => pattern.matches(s),
            _ => false,
        };
        self.check(holds, "to match", Some(&pattern.describe()))
    }

    /// The value (an array or a string) has `length` items (UTF-16 units
    /// for a string, as JS counts them).
    pub fn to_have_length(&self, length: f64) -> Result<(), String> {
        let len = match &self.value {
            JsonValue::Array(items) => Some(items.len()),
            JsonValue::String(s) => Some(s.encode_utf16().count()),
            _ => None,
        };
        self.check(
            len.is_some_and(|n| n as f64 == length),
            "to have length",
            Some(&JsonValue::from(length)),
        )
    }

    /// The value is `null` (or `undefined`).
    pub fn to_be_null(&self) -> Result<(), String> {
        self.check(self.value.is_null(), "to be null", None)
    }

    /// The value (a number) is more than `n`.
    pub fn to_be_greater_than(&self, n: f64) -> Result<(), String> {
        self.compare(n, "to be greater than", |a| a > n)
    }

    /// The value (a number) is `n` or more.
    pub fn to_be_greater_than_or_equal(&self, n: f64) -> Result<(), String> {
        self.compare(n, "to be greater than or equal to", |a| a >= n)
    }

    /// The value (a number) is less than `n`.
    pub fn to_be_less_than(&self, n: f64) -> Result<(), String> {
        self.compare(n, "to be less than", |a| a < n)
    }

    /// The value (a number) is `n` or less.
    pub fn to_be_less_than_or_equal(&self, n: f64) -> Result<(), String> {
        self.compare(n, "to be less than or equal to", |a| a <= n)
    }

    /// The function throws, with a message matching `message` when given
    /// (contains a string, matches a `RegExp`).
    pub fn to_throw(&self, message: Option<Pattern>) -> Result<(), String> {
        let run = self
            .run
            .as_ref()
            .ok_or("`toThrow` checks a function: `expect(() => parse(text)).toThrow()`")?;
        thrown(run.call(()).err(), message.as_ref(), self.not, "to throw")
    }

    fn compare(&self, n: f64, what: &str, holds: impl Fn(f64) -> bool) -> Result<(), String> {
        let holds = self.value.as_f64().is_some_and(holds);
        self.check(holds, what, Some(&JsonValue::from(n)))
    }

    /// The value is `expected`.
    pub fn to_be(&self, expected: JsonValue) -> Result<(), String> {
        self.check(same(&self.value, &expected), "to be", Some(&expected))
    }

    /// The value equals `expected`, member by member.
    pub fn to_equal(&self, expected: JsonValue) -> Result<(), String> {
        self.check(same(&self.value, &expected), "to equal", Some(&expected))
    }

    /// The value (an array) holds `item`, or (a string) contains it.
    pub fn to_contain(&self, item: JsonValue) -> Result<(), String> {
        let holds = match (&self.value, &item) {
            (JsonValue::Array(items), _) => items.iter().any(|i| same(i, &item)),
            (JsonValue::String(s), JsonValue::String(part)) => s.contains(part.as_str()),
            _ => false,
        };
        self.check(holds, "to contain", Some(&item))
    }

    /// The value is truthy, as JS sees it.
    pub fn to_be_truthy(&self) -> Result<(), String> {
        self.check(truthy(&self.value), "to be truthy", None)
    }

    /// The value is falsy, as JS sees it.
    pub fn to_be_falsy(&self) -> Result<(), String> {
        self.check(!truthy(&self.value), "to be falsy", None)
    }

    fn check(&self, holds: bool, what: &str, expected: Option<&JsonValue>) -> Result<(), String> {
        if self.run.is_some() {
            return Err(format!(
                "`{what}` checks a value, and `expect` was given a function: call it, or check what it throws (`toThrow`)"
            ));
        }
        if holds != self.not {
            return Ok(());
        }
        let not = if self.not { "not " } else { "" };
        Err(match expected {
            Some(expected) => format!("expected {} {not}{what} {expected}", self.value),
            None => format!("expected {} {not}{what}", self.value),
        })
    }
}

/// What a promise rejects with ([`Expectation::rejects`]).
#[class]
pub struct Rejection {
    run: Callback<(), JsonValue>,
    not: bool,
}

#[class]
impl Rejection {
    /// The promise rejects, with a message matching `message` when given
    /// (contains a string, matches a `RegExp`).
    pub async fn to_throw(this: Instance<Self>, message: Option<Pattern>) -> Result<(), String> {
        let (run, not) = this.with(|r| (r.run.clone(), r.not));
        let error = run.call_async_traced(()).await.err().map(|e| e.message);
        thrown(error, message.as_ref(), not, "to reject")
    }
}

/// Checks what a function threw (`error`, its message; `None`: nothing)
/// against `message`.
fn thrown(
    error: Option<String>,
    message: Option<&Pattern>,
    not: bool,
    what: &str,
) -> Result<(), String> {
    let holds = match (&error, message) {
        (Some(error), Some(pattern)) => pattern.matches(error),
        (Some(_), None) => true,
        (None, _) => false,
    };
    if holds != not {
        return Ok(());
    }
    let not_ = if not { "not " } else { "" };
    let wanted = message.map_or(String::new(), |p| format!(" {}", p.describe()));
    Err(match error {
        Some(error) => format!("expected the function {not_}{what}{wanted}; it threw {error:?}"),
        None => format!("expected the function {not_}{what}{wanted}; it did not"),
    })
}

/// What `expect` checks: a value, or a function (for `toThrow`, `rejects`).
pub enum Subject {
    /// A value, as JSON.
    Value(JsonValue),
    /// A function.
    Function(Callback<(), JsonValue>),
}

impl Arg for Subject {
    fn ts_type(_types: &mut TsTypes) -> String {
        "unknown".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() == JsKind::Function {
            return <Callback<(), JsonValue> as Arg>::from_js(value).map(Subject::Function);
        }
        <JsonValue as JsValue>::from_js(value).map(Subject::Value)
    }
}

/// A text a check wants: contained (a string), or matched (a `RegExp`).
pub enum Pattern {
    /// Contains this.
    Contains(String),
    /// Matches this (the `RegExp`'s source and flags).
    Regex(regex::Regex, String),
}

impl Pattern {
    fn matches(&self, text: &str) -> bool {
        match self {
            Pattern::Contains(part) => text.contains(part.as_str()),
            Pattern::Regex(re, _) => re.is_match(text),
        }
    }

    fn describe(&self) -> JsonValue {
        match self {
            Pattern::Contains(part) => JsonValue::String(part.clone()),
            Pattern::Regex(_, source) => JsonValue::String(source.clone()),
        }
    }
}

impl JsValue for Pattern {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | RegExp".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(text) = value.as_string() {
            return Ok(Pattern::Contains(text));
        }
        let field = |name: &str| value.field(name).ok().and_then(|v| v.get().as_string());
        let (Some(source), Some(flags)) = (field("source"), field("flags")) else {
            return Err(value.expected("a string or a RegExp"));
        };
        let inline: String = flags
            .chars()
            .filter(|f| matches!(f, 'i' | 'm' | 's'))
            .collect();
        let pattern = if inline.is_empty() {
            source.clone()
        } else {
            format!("(?{inline}){source}")
        };
        let re = regex::Regex::new(&pattern).map_err(|e| PropError(format!("/{source}/: {e}")))?;
        Ok(Pattern::Regex(re, format!("/{source}/{flags}")))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let text = match self {
            Pattern::Contains(part) => part.clone(),
            Pattern::Regex(_, source) => source.clone(),
        };
        Ok(JsOwned::new(host, host.new_string(&text)?))
    }
}

/// Whether `a` and `b` are the same JSON value (numbers by value).
fn same(a: &JsonValue, b: &JsonValue) -> bool {
    match (a, b) {
        (JsonValue::Number(a), JsonValue::Number(b)) => a.as_f64() == b.as_f64(),
        (JsonValue::Array(a), JsonValue::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (JsonValue::Object(a), JsonValue::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, v)| b.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// JS's truthiness of `value`.
fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(b) => *b,
        JsonValue::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        JsonValue::String(s) => !s.is_empty(),
        JsonValue::Array(_) | JsonValue::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn every_export_is_documented() {
        assert_eq!(registry().undocumented(), Vec::<String>::new());
    }

    #[test]
    fn values_compare_as_json_and_checks_say_what_failed() {
        assert!(same(&json!(1), &json!(1.0)));
        assert!(same(&json!({"a": [1, "b"]}), &json!({"a": [1.0, "b"]})));
        assert!(!same(&json!([1]), &json!([1, 2])));
        let value = |v: JsonValue| Testing::expect(Subject::Value(v));
        let texts = value(json!(["Buy milk", "1 item left"]));
        assert_eq!(texts.to_contain(json!("1 item left")), Ok(()));
        assert_eq!(
            texts.to_contain(json!("2 items left")),
            Err(r#"expected ["Buy milk","1 item left"] to contain "2 items left""#.into())
        );
        assert_eq!(texts.not().to_contain(json!("Error")), Ok(()));
        assert_eq!(
            texts.not().to_contain(json!("Buy milk")),
            Err(r#"expected ["Buy milk","1 item left"] not to contain "Buy milk""#.into())
        );
        assert_eq!(value(json!("Saved!")).to_contain(json!("Saved")), Ok(()));
        assert_eq!(value(json!(0)).to_be_falsy(), Ok(()));
        assert_eq!(
            value(json!("")).to_be_truthy(),
            Err(r#"expected "" to be truthy"#.into())
        );
        assert_eq!(value(json!("héllo")).to_have_length(5.0), Ok(()));
        assert_eq!(value(json!([1, 2])).to_have_length(2.0), Ok(()));
        assert_eq!(value(json!(null)).to_be_null(), Ok(()));
        assert_eq!(value(json!(3)).to_be_greater_than(2.0), Ok(()));
        assert_eq!(
            value(json!(3)).to_be_less_than(2.0),
            Err("expected 3 to be less than 2.0".into())
        );
        assert_eq!(
            value(json!("Saved at 9:41")).to_match(Pattern::Contains("Saved".into())),
            Ok(())
        );
        assert_eq!(thrown(Some("boom".into()), None, false, "to throw"), Ok(()));
        assert_eq!(
            thrown(
                None,
                Some(&Pattern::Contains("x".into())),
                false,
                "to throw"
            ),
            Err(r#"expected the function to throw "x"; it did not"#.into())
        );
    }

    #[test]
    fn responses_read_as_tests_write_them() {
        let r = stub_response(&json!({ "body": { "items": [] } })).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(
            r.headers,
            [("content-type".to_owned(), "application/json".to_owned())]
        );
        assert_eq!(r.body, br#"{"items":[]}"#);
        let r = stub_response(&json!({ "status": 404, "body": "missing" })).unwrap();
        assert_eq!((r.status, r.body.as_slice()), (404, b"missing".as_slice()));
        assert_eq!(
            stub_response(&json!({ "status": 99999 })).unwrap_err().0,
            "`status`: not a status code: 99999"
        );
    }
}
