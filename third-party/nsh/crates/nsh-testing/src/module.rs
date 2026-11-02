//! `nsh/test`, the module test files import: `test` declares a test,
//! `open` starts the app on a headless engine of its own and gives an
//! [`App`] to take steps on, `expect` checks values as Jest does, as JS
//! made them ([`crate::values`]). Written in Rust, its
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
    element::{
        Arg, Exception, JsClass, JsError, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError,
        Registry, TsTypes,
    },
    prelude::*,
};
use nsh_engine::{HostCall, HostChannel, HttpBody, HttpRequest};

use crate::{
    MemoryStorage,
    driver::{Driver, headless_only},
    failure,
    headless::{self, RecordingNetwork, StubReply, StubResponse, StubRoute, default_answer},
    run::{OpenApp, Session},
    values::{self, Check, Kept},
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
        .class::<Rejection>()
        .class::<Resolution>();
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
    /// `options.storage`. With `nsh test --target`, an option the target's
    /// platform cannot honor rejects (`ERR_NSH_TEST_UNSUPPORTED`, naming
    /// it): `width` and `height` on iOS and Android, a `platform` the
    /// target is not (a phone's on a desktop, a desktop's on a phone, the
    /// other phone), `host.handlers`.
    pub async fn open(entry: String, options: Option<OpenOptions>) -> Result<App, JsError> {
        let session = Session::current().map_err(JsError::Error)?;
        let options = options.unwrap_or_default();
        let (network, mut server) = network_setup(options.network);
        let host_handlers = options
            .host
            .as_ref()
            .and_then(|h| h.handlers.as_ref())
            .is_some_and(|h| !h.0.is_empty());
        let (host, record) = host_setup(options.host, &mut server);
        let manual_clock = options.clock.is_some();
        let launch = Launch {
            storage: options.storage.unwrap_or_default(),
            network,
            width: options.width,
            height: options.height,
            safe_area: options.safe_area,
            clipboard: options.clipboard,
            color_scheme: options.color_scheme,
            locale: options.locale,
            reduced_motion: options.reduced_motion,
            platform: options.platform,
            clock: options
                .clock
                .map(|c| c.time.map_or_else(std::time::SystemTime::now, |t| t.0)),
            host,
            host_handlers,
        };
        let opening = blocking(move || session.open(&entry, launch));
        let (app, storage, requests) = serve(server.as_ref(), opening)
            .await
            .map_err(step_error)?
            .map_err(|e| step_error(e.to_string()))?
            .map_err(step_error)?;
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
            manual_clock,
        })
    }

    /// What to expect of `value`, compared as Jest compares values (as JS
    /// made them: `toBe` by `Object.is`, `toEqual` member by member):
    /// `expect(app.texts()).toContain("Saved")`. Given a function, what it
    /// throws: `expect(() => parse("x")).toThrow("not a number")`; given a
    /// promise (or a function returning one), with `rejects` and
    /// `resolves` what it settles to:
    /// `await expect(app.press("Pay")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" })`.
    pub fn expect(value: Subject) -> Expectation {
        let Subject {
            value,
            run,
            promise,
        } = value;
        Expectation {
            value,
            run,
            promise,
            not: false,
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
    /// The viewport's width (390 points). With `--target ios` or
    /// `android` the app fills the device's screen: giving it rejects with
    /// `ERR_NSH_TEST_UNSUPPORTED`.
    pub width: Option<Points>,
    /// The viewport's height (844 points), as `width`.
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
    /// desktop's: `"macos"`, `"windows"`, `"linux"`, `"web"`). With
    /// `--target`, the app runs on the target's platform: a desktop's runs
    /// on any desktop and the web, `"ios"` and `"android"` on their own,
    /// and another rejects with `ERR_NSH_TEST_UNSUPPORTED`.
    pub platform: Option<Platform>,
    /// A manual clock for the app (none: the system's): its time moves only
    /// as the test moves it (`app.clock`), steps finish native animations
    /// at once (one looping forever moves with the clock instead), and
    /// `app.wait`, `app.waitFor` and `app.waitUntil` move it.
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
pub struct PickRequest {
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

impl From<&nsh_core::picker::PickRequest> for PickRequest {
    fn from(request: &nsh_core::picker::PickRequest) -> Self {
        PickRequest {
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
    /// The same content as HTML, as a browser or an office suite copies it.
    pub html: Option<String>,
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
        paste.html = self.html.unwrap_or_default();
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
    /// What the test gives of the environment: a real platform's host pins
    /// it, defaults included, and keeps its own for what it leaves out.
    pub(crate) safe_area: Option<SafeArea>,
    pub(crate) clipboard: Option<String>,
    pub(crate) color_scheme: Option<ColorScheme>,
    pub(crate) locale: Option<String>,
    pub(crate) reduced_motion: Option<bool>,
    /// The platform `open` named (headless: iOS when it named none).
    pub(crate) platform: Option<Platform>,
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
/// is on screen, when it cannot be taken or the app threw. The failures a
/// test may expect carry a `code` to match (messages may change):
/// `ERR_NSH_TEST_NOT_FOUND` (nothing matches the selector),
/// `ERR_NSH_TEST_DISABLED` (what it names is disabled), `ETIMEDOUT` (a wait
/// ran out of time), `ERR_NSH_TEST_NO_BACK` (nothing to go back from).
/// The app closes when the test that opened it ends.
#[class]
pub struct App {
    steps: Steps,
    /// Its storage, on a headless engine.
    storage: Option<Arc<MemoryStorage>>,
    /// The requests the app made, on a headless engine.
    requests: Option<Arc<RecordingNetwork>>,
    /// The calls and posts the handlers of `open`'s `host` got.
    host: HostRecord,
    /// It runs on a manual clock (`open`'s `clock`).
    manual_clock: bool,
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
    ) -> Result<(), JsError> {
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
type PickCallback = Callback<PickRequest, Option<Vec<PickFile>>>;

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
    pub async fn run_for(this: Instance<Self>, ms: f64) -> Result<(), JsError> {
        let time = duration(ms).map_err(JsError::Range)?;
        let steps = this.with(|c| c.steps.clone());
        steps.run(move |app| app.run_for(time)).await
    }

    /// Moves the clock by `ms` milliseconds at once, as a device waking from
    /// sleep: the timers due meanwhile run once each; resolves once the app
    /// is quiet.
    pub async fn fast_forward(this: Instance<Self>, ms: f64) -> Result<(), JsError> {
        let time = duration(ms).map_err(JsError::Range)?;
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
    pub async fn press(this: Instance<Self>, keys: String) -> Result<(), JsError> {
        let steps = this.with(|k| k.steps.clone());
        steps.run(move |app| app.press_key(&keys)).await
    }

    /// Holds modifier keys down (`"mod"`, `"shift"`, `"alt"`, `"ctrl"`,
    /// `"meta"`, joined by `+`) until `up`: the presses, drags and hovers
    /// meanwhile carry them (a Mod-click, a Shift-drag). Headless and on Linux.
    pub async fn down(this: Instance<Self>, keys: String) -> Result<(), JsError> {
        let steps = this.with(|k| k.steps.clone());
        steps.run(move |app| app.hold_keys(&keys, true)).await
    }

    /// Lets go of modifier keys `down` held.
    pub async fn up(this: Instance<Self>, keys: String) -> Result<(), JsError> {
        let steps = this.with(|k| k.steps.clone());
        steps.run(move |app| app.hold_keys(&keys, false)).await
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
    pub async fn press(this: Instance<Self>, selector: String) -> Result<(), JsError> {
        step(&this, move |app| app.press(&selector)).await
    }

    /// Types `text` at the end of the input `selector` names (or the first
    /// input in it; `text:` matches an input's text or placeholder too),
    /// key by key; a line break in a single line is the return key.
    pub async fn r#type(
        this: Instance<Self>,
        selector: String,
        text: String,
    ) -> Result<(), JsError> {
        step(&this, move |app| app.type_text(&selector, &text)).await
    }

    /// The return key in the input `selector` names, as its
    /// `submitBehavior` says.
    pub async fn submit(this: Instance<Self>, selector: String) -> Result<(), JsError> {
        step(&this, move |app| app.submit(&selector)).await
    }

    /// Drags the scroll view `selector` names (or the one around it, or the
    /// first in it) by `distance` points along its axis (negative: back),
    /// within its content.
    pub async fn scroll(
        this: Instance<Self>,
        selector: String,
        distance: f64,
    ) -> Result<(), JsError> {
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
    pub async fn drag(this: Instance<Self>, selector: String, by: DragBy) -> Result<(), JsError> {
        let by = nsh_core::geometry::point(by.x, by.y);
        step(&this, move |app| app.drag(&selector, by)).await
    }

    /// Drags as `drag` does but keeps the finger down, so the test can look
    /// at the screen mid-drag (a drag preview, a drop line); `drop()` lifts
    /// it. Headless only for now.
    pub async fn drag_and_hold(
        this: Instance<Self>,
        selector: String,
        by: DragBy,
    ) -> Result<(), JsError> {
        let by = nsh_core::geometry::point(by.x, by.y);
        step(&this, move |app| app.drag_and_hold(&selector, by)).await
    }

    /// Drops local files (`file:` URLs, as a file manager drags them) on
    /// the middle of what `selector` names: it, or the nearest view around
    /// it listening, hears `onFileDrop`. Desktops, headless and on Linux for now.
    pub async fn drop_files(
        this: Instance<Self>,
        selector: String,
        uris: Vec<String>,
    ) -> Result<(), JsError> {
        step(&this, move |app| app.drop_files(&selector, uris)).await
    }

    /// Lifts the finger `dragAndHold` left down, where it is.
    pub async fn drop(this: Instance<Self>) -> Result<(), JsError> {
        step(&this, move |app| app.drop_held()).await
    }

    /// The mouse's secondary button over the middle of what `selector`
    /// names: it, or the nearest view around it listening, hears
    /// `onContextMenu`, whose handler shows a menu (`Menu.popup`: read it
    /// with `menu()`). Desktops and the web only: a phone has no mouse.
    pub async fn right_click(this: Instance<Self>, selector: String) -> Result<(), JsError> {
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
    ) -> Result<(), JsError> {
        let content = content.read().map_err(JsError::Error)?;
        step(&this, move |app| app.paste(&selector, &content)).await
    }

    /// Chooses the open context menu's action labelled `label` (a
    /// submenu's: `"Share > Mail"`), as a click on it: the app hears
    /// `onMenu`, then the menu closes.
    pub async fn choose_menu_item(this: Instance<Self>, label: String) -> Result<(), JsError> {
        step(&this, move |app| app.choose_menu_item(&label)).await
    }

    /// Closes the open context menu with nothing chosen, as Escape does.
    pub async fn close_menu(this: Instance<Self>) -> Result<(), JsError> {
        step(&this, move |app| app.close_menu()).await
    }

    /// Moves the mouse over the middle of what `selector` names: the views
    /// under it hear `onMouseEnter` (and the ones it left `onMouseLeave`),
    /// take their `hover:` styles and hear `onMouseMove`, with no button
    /// down. Desktops and the web (at any width: a browser has a mouse)
    /// only: an iOS or Android phone has none.
    pub async fn hover(this: Instance<Self>, selector: String) -> Result<(), JsError> {
        step(&this, move |app| app.hover(&selector)).await
    }

    /// Lets the app run for `ms` milliseconds (timers and animations): on a
    /// manual clock, moves it by `ms` (`clock.runFor`).
    pub async fn wait(this: Instance<Self>, ms: f64) -> Result<(), JsError> {
        let time = Duration::from_secs_f64(ms.max(0.0) / 1000.0);
        step(&this, move |app| app.wait(time)).await
    }

    /// Resolves once a view on screen matches `selector`; rejects
    /// (`ETIMEDOUT`) after `timeout` milliseconds (5000). On a manual clock
    /// the wait moves it, a display frame at a time, looking after each
    /// frame (the timers due run on the way, as with `clock.runFor`), by
    /// `timeout` at most: it rejects once the clock moved that far and as
    /// much real time passed, which what comes from outside the app (a
    /// route's function, the network) has.
    pub async fn wait_for(
        this: Instance<Self>,
        selector: String,
        options: Option<WaitOptions>,
    ) -> Result<(), JsError> {
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
    /// change of the app (a render, an animation frame); rejects
    /// (`ETIMEDOUT`) after `options.timeout` milliseconds (5000): for what
    /// no selector says
    /// (`app.storage().note === "Milk"`). On a manual clock it moves the
    /// clock as `waitFor` does, a display frame between two looks, by the
    /// timeout at most, and rejects as `waitFor` does.
    pub async fn wait_until(
        this: Instance<Self>,
        condition: Callback<(), bool>,
        options: Option<WaitOptions>,
    ) -> Result<(), JsError> {
        let timeout = options.unwrap_or_default().timeout();
        let deadline = std::time::Instant::now() + timeout;
        let app = this.with(|a| a.steps.app.clone());
        let server = this.with(|a| a.steps.server.clone());
        // On a manual clock: how far the wait moved it, which the timeout
        // measures.
        let mut moved = this.with(|a| a.manual_clock).then_some(Duration::ZERO);
        on_app(&app, |a| {
            a.step("waitUntil");
            Ok(())
        })
        .await
        .map_err(step_error)?;
        loop {
            if condition.call_async(()).await.map_err(JsError::Error)? {
                return Ok(());
            }
            // The clock moves by the timeout at most; then the wait goes on
            // for what comes from outside the app, until as much real time
            // passed.
            let clock_left = moved.map(|moved| timeout.saturating_sub(moved));
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() && clock_left.is_none_or(|l| l.is_zero()) {
                let screen = on_app(&app, |a| Ok(format!("{:?}", a.texts()?)))
                    .await
                    .map_err(step_error)?;
                return Err(JsError::Error(format!(
                    "the condition never held in {} ms; on screen: {screen}",
                    timeout.as_millis()
                ))
                .with_code(failure::TIMED_OUT));
            }
            if let (Some(moved), Some(clock_left)) = (&mut moved, clock_left)
                && !clock_left.is_zero()
            {
                let by = serve(
                    server.as_deref(),
                    on_app(&app, move |a| a.next_frame(clock_left)),
                )
                .await
                .and_then(|framed| framed)
                .map_err(step_error)?;
                *moved += by;
                continue;
            }
            let wait = left.min(Duration::from_millis(50));
            serve(
                server.as_deref(),
                on_app(&app, move |a| a.next_change(wait)),
            )
            .await
            .and_then(|changed| changed)
            .map_err(step_error)?;
        }
    }

    /// Holds a finger on what `selector` names (or the nearest view around
    /// it that hears long presses or presses) for its `delayLongPress`
    /// (500 ms): `onPressDown`, `onLongPress`, `onPressUp`.
    pub async fn long_press(this: Instance<Self>, selector: String) -> Result<(), JsError> {
        step(&this, move |app| app.long_press(&selector)).await
    }

    /// Empties the input `selector` names, as selecting all and deleting
    /// does.
    pub async fn clear(this: Instance<Self>, selector: String) -> Result<(), JsError> {
        step(&this, move |app| app.clear(&selector)).await
    }

    /// How many views on screen match `selector` now.
    pub fn count(&self, selector: String) -> Result<u32, JsError> {
        self.with(|app| Ok(app.count(&selector)? as u32))
    }

    /// Whether the view `selector` names takes input now: neither it nor a
    /// view around it is disabled, and an input is not `readonly`.
    pub fn enabled(&self, selector: String) -> Result<bool, JsError> {
        self.with(|app| app.enabled(&selector))
    }

    /// Whether a view on screen matches `selector` now.
    pub fn shows(&self, selector: String) -> Result<bool, JsError> {
        self.with(|app| app.shows(&selector))
    }

    /// The texts on screen now, in order.
    pub fn texts(&self) -> Result<Vec<String>, JsError> {
        self.with(|app| app.texts())
    }

    /// The text of the input `selector` names, `null` when none matches.
    pub fn value(&self, selector: String) -> Result<Option<String>, JsError> {
        self.with(|app| app.value(&selector))
    }

    /// The style of the characters `selector` names, from the first
    /// character. `id:<testID>` names a nested text. `text:<text>` names
    /// where the text reads it. The parts before the last name the views
    /// to look in (`id:note >> text:here`). Headless tests read this style;
    /// an empty span reports an error because it has no first character.
    pub fn span_style(&self, selector: String) -> Result<SpanStyle, JsError> {
        self.with(|app| app.span_style(&selector).map(SpanStyle::from))
    }

    /// What the app's storage holds now.
    pub fn storage(&self) -> Result<Entries, String> {
        if let Some(storage) = &self.storage {
            return Ok(Entries(storage.entries()));
        }
        // On a real host: as the host's app keeps it.
        let mut app = self.steps.app.lock().unwrap_or_else(|e| e.into_inner());
        let driver = app.as_mut().ok_or(CLOSED)?;
        Ok(Entries(driver.storage()?))
    }

    /// Goes back as the user does (a header's back button, swiping a sheet
    /// down): the innermost stack of the newest modal (else of the screen)
    /// pops its top screen, or asks it when it prevents going back; without
    /// one, the newest modal asks to close. Rejects (`ERR_NSH_TEST_NO_BACK`)
    /// when there is nothing to go back from.
    pub async fn back(this: Instance<Self>) -> Result<(), JsError> {
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
    pub fn on_pick(&mut self, #[args(pick)] handler: Callback<PickRequest, Option<Vec<PickFile>>>) {
        *self.steps.pick.borrow_mut() = Some(handler);
    }

    /// The picks the app asked for, in order.
    pub fn picks(&self) -> Result<Vec<PickRequest>, JsError> {
        self.with(|app| Ok(app.picks()?.iter().map(PickRequest::from).collect()))
    }

    /// The dialogs the app showed, in order.
    pub fn dialogs(&self) -> Result<Vec<Dialog>, JsError> {
        self.with(|app| Ok(app.dialogs()?.iter().map(Dialog::from).collect()))
    }

    /// The actions of the context menu the app shows (`Menu.popup`), a
    /// submenu's after its label (`"Share > Mail"`); `null` when none is
    /// open.
    pub fn menu(&self) -> Result<Option<Vec<MenuEntry>>, JsError> {
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

    /// The app's manual clock (`open`'s `clock`), which the test moves;
    /// `null` when the app runs on the system's clock.
    #[getter]
    pub fn clock(&self) -> Option<Instance<Clock>> {
        self.manual_clock.then(|| {
            Instance::new(Clock {
                steps: self.steps.clone(),
            })
        })
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
    pub fn opened_urls(&self) -> Result<Vec<String>, JsError> {
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
    pub async fn set_viewport(
        this: Instance<Self>,
        width: f64,
        height: f64,
    ) -> Result<(), JsError> {
        let size = nsh_core::Size::new(Points(width as f32), Points(height as f32));
        step(&this, move |app| app.set_viewport(size)).await
    }

    /// Switches the system's appearance to `scheme`, as the user does.
    pub async fn set_color_scheme(
        this: Instance<Self>,
        scheme: ColorScheme,
    ) -> Result<(), JsError> {
        step(&this, move |app| app.set_color_scheme(scheme.into())).await
    }

    /// The text on the clipboard now, `null` when it holds none.
    pub fn clipboard(&self) -> Result<Option<String>, JsError> {
        self.with(|app| app.clipboard())
    }

    /// `f` with the app as it is now (the batches that came applied); a
    /// failure has the `code` it says ([`step_error`]).
    fn with<R>(&self, f: impl FnOnce(&mut dyn Driver) -> Result<R, String>) -> Result<R, JsError> {
        let mut app = self.steps.app.lock().unwrap_or_else(|e| e.into_inner());
        let Some(app) = app.as_deref_mut() else {
            return Err(JsError::Error(CLOSED.to_owned()));
        };
        f(app).map_err(step_error)
    }
}

/// Runs the step `f` of the app `this` on a blocking thread, then answers
/// the dialogs it showed: with the test's handler (JS, on this thread),
/// else as [`default_answer`] says.
async fn step(
    this: &Instance<App>,
    f: impl FnOnce(&mut dyn Driver) -> Result<(), String> + Send + 'static,
) -> Result<(), JsError> {
    this.with(|a| a.steps.clone()).run(f).await
}

/// A step's failure as JS gets it: an `Error` with the `code` its message
/// says ([`failure::code_of`]), which tests match instead of the message.
fn step_error(message: String) -> JsError {
    match failure::code_of(&message) {
        Some(code) => JsError::Error(message).with_code(code),
        None => JsError::Error(message),
    }
}

impl Steps {
    /// Runs the step `f` on a blocking thread, then answers the dialogs it
    /// showed ([`step`]); a failure has the `code` it says ([`step_error`]).
    async fn run(
        &self,
        f: impl FnOnce(&mut dyn Driver) -> Result<(), String> + Send + 'static,
    ) -> Result<(), JsError> {
        self.run_step(f).await.map_err(step_error)
    }

    async fn run_step(
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
                        .call_async(PickRequest::from(&asked))
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

/// What a test expects of a value (`expect`); each check throws when it
/// does not hold. Values are compared as Jest compares them, as JS made
/// them ([`crate::values`]).
#[class]
pub struct Expectation {
    /// The value `expect` was given (a function or a promise too).
    value: Kept,
    /// The function `expect` was given, for `toThrow`, `rejects` and
    /// `resolves`; with `promise`, the stand-in of the promise it was given.
    run: Option<Callback<(), Kept>>,
    /// `expect` was given a promise.
    promise: bool,
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
            promise: self.promise,
            not: !self.not,
        }
    }

    /// The checks of what the promise rejects with (given a function, the
    /// promise it returns):
    /// `await expect(app.press("Pay")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" })`.
    #[getter]
    pub fn rejects(&self) -> Result<Rejection, String> {
        let run = self.run.clone().ok_or(
            "`rejects` checks a promise, or a function returning one: `expect(promise).rejects`",
        )?;
        Ok(Rejection {
            run,
            promise: self.promise,
            not: self.not,
        })
    }

    /// The checks of what the promise resolves to (given a function, the
    /// promise it returns): `await expect(load()).resolves.toEqual({ ok: true })`.
    #[getter]
    pub fn resolves(&self) -> Result<Resolution, String> {
        let run = self.run.clone().ok_or(
            "`resolves` checks a promise, or a function returning one: `expect(promise).resolves`",
        )?;
        Ok(Resolution {
            run,
            promise: self.promise,
            not: self.not,
        })
    }

    /// The value (a string) matches `pattern`, as Jest's `toMatch`: contains
    /// it (a string), or matches it (a `RegExp`, run by the JS engine as
    /// `text.search(pattern)` runs it).
    pub fn to_match(&self, pattern: Pattern) -> Check {
        self.verdict("to match", move |host, value| {
            let holds = match value.as_string() {
                Some(text) => pattern.matches(host, &text)?,
                None => false,
            };
            Ok((holds, Some(pattern.describe())))
        })
    }

    /// The value has a `length` of `length`: a string (UTF-16 units, as JS
    /// counts them), an array, a typed array, or any object with a numeric
    /// `length`.
    pub fn to_have_length(&self, length: f64) -> Check {
        self.verdict("to have length", move |_, value| {
            let len = match value.kind() {
                JsKind::String => value.as_string().map(|s| s.encode_utf16().count() as f64),
                JsKind::Array | JsKind::Function | JsKind::Object => {
                    value.field("length").map_err(|e| e.0)?.get().as_number()
                }
                _ => None,
            };
            Ok((len == Some(length), Some(values::number(length))))
        })
    }

    /// The value is `null` (`toBeUndefined` checks for `undefined`).
    pub fn to_be_null(&self) -> Check {
        self.verdict("to be null", |_, value| {
            Ok((value.kind() == JsKind::Null, None))
        })
    }

    /// The value is `undefined`.
    pub fn to_be_undefined(&self) -> Check {
        self.verdict("to be undefined", |_, value| {
            Ok((value.kind() == JsKind::Undefined, None))
        })
    }

    /// The value is defined: anything but `undefined`, `null` included.
    pub fn to_be_defined(&self) -> Check {
        self.verdict("to be defined", |_, value| {
            Ok((value.kind() != JsKind::Undefined, None))
        })
    }

    /// The value is `NaN`.
    #[allow(non_snake_case)]
    pub fn to_be_NaN(&self) -> Check {
        self.verdict("to be NaN", |_, value| {
            Ok((value.as_number().is_some_and(f64::is_nan), None))
        })
    }

    /// The value (a number) is more than `n`.
    pub fn to_be_greater_than(&self, n: f64) -> Check {
        self.compare(n, "to be greater than", move |a| a > n)
    }

    /// The value (a number) is `n` or more.
    pub fn to_be_greater_than_or_equal(&self, n: f64) -> Check {
        self.compare(n, "to be greater than or equal to", move |a| a >= n)
    }

    /// The value (a number) is less than `n`.
    pub fn to_be_less_than(&self, n: f64) -> Check {
        self.compare(n, "to be less than", move |a| a < n)
    }

    /// The value (a number) is `n` or less.
    pub fn to_be_less_than_or_equal(&self, n: f64) -> Check {
        self.compare(n, "to be less than or equal to", move |a| a <= n)
    }

    /// The function throws; given `expected`, an error that matches it: a
    /// message containing a string or matching a `RegExp` (run by the JS
    /// engine), an error class (the error's `name` is the class's,
    /// `TypeError`; `Error` matches every error), or an error with the same
    /// message.
    pub fn to_throw(&self, expected: Option<ErrorMatch>) -> Result<Check, String> {
        let run = match &self.run {
            Some(run) if !self.promise => run,
            Some(_) => {
                return Err("`toThrow` checks a function; what a promise rejects with: \
                     `await expect(promise).rejects.toThrow()`"
                    .into());
            }
            None => {
                return Err(
                    "`toThrow` checks a function: `expect(() => parse(text)).toThrow()`".into(),
                );
            }
        };
        let error = run.call_traced(()).err();
        let not = self.not;
        Ok(Check::new(move |host| {
            thrown(
                host,
                error.as_ref(),
                expected.as_ref(),
                not,
                "the function",
                "to throw",
            )
        }))
    }

    fn compare(&self, n: f64, what: &'static str, holds: impl Fn(f64) -> bool + 'static) -> Check {
        self.verdict(what, move |_, value| {
            let holds = value.kind() == JsKind::Number && value.as_number().is_some_and(holds);
            Ok((holds, Some(values::number(n))))
        })
    }

    /// The value is `expected`, as `Object.is` says (Jest's `toBe`): the
    /// same primitive (`NaN` is `NaN`, `0` is not `-0`), or the same object.
    pub fn to_be(&self, expected: Kept) -> Check {
        self.verdict("to be", move |host, value| {
            let expected = expected.get(host)?;
            let expected = expected.get();
            if value.same_value(expected) {
                return Ok((true, None));
            }
            let mut shown = values::show(expected);
            if values::equals(value, expected).map_err(|e| e.0)? {
                shown.push_str(" (an equal value, not the same one: `toEqual` compares members)");
            }
            Ok((false, Some(shown)))
        })
    }

    /// The value equals `expected` as Jest's `toEqual` says, member by
    /// member: own enumerable properties (an `undefined` one is as one
    /// missing), arrays item by item, dates by their time, regular
    /// expressions by source and flags, maps and sets by their entries,
    /// `ArrayBuffer`s and typed arrays by their bytes, errors by name and
    /// message; `NaN` equals `NaN`; classes are not compared.
    pub fn to_equal(&self, expected: Kept) -> Check {
        self.verdict("to equal", move |host, value| {
            let expected = expected.get(host)?;
            let holds = values::equals(value, expected.get()).map_err(|e| e.0)?;
            Ok((holds, Some(values::show(expected.get()))))
        })
    }

    /// The value has every property of `subset`, each equal to it (as
    /// `toEqual` says) and an object matching it in turn, as Jest's
    /// `toMatchObject`; other properties are not looked at (arrays match
    /// item by item, all of them):
    /// `expect(app.dialogs()[0]).toMatchObject({ title: "Delete?" })`.
    pub fn to_match_object(&self, subset: Kept) -> Check {
        self.verdict("to match object", move |host, value| {
            let subset = subset.get(host)?;
            subset_of(subset.get())?;
            let holds = values::matches_object(value, subset.get()).map_err(|e| e.0)?;
            Ok((holds, Some(values::show(subset.get()))))
        })
    }

    /// The value (an array, a `Set`, a typed array or any other iterable)
    /// holds `item`, as `===` says (Jest's `toContain`); or (a string)
    /// contains it.
    pub fn to_contain(&self, item: Kept) -> Check {
        self.verdict("to contain", move |host, value| {
            let item = item.get(host)?;
            let holds = match (value.as_string(), item.get().as_string()) {
                (Some(text), Some(part)) => text.contains(&part),
                (Some(_), None) => false,
                (None, _) => items(value)?
                    .iter()
                    .any(|i| values::strict_equal(i.get(), item.get())),
            };
            Ok((holds, Some(values::show(item.get()))))
        })
    }

    /// The value (an array, a `Set`, a typed array or any other iterable)
    /// holds an item equal to `item`, as `toEqual` says (Jest's
    /// `toContainEqual`).
    pub fn to_contain_equal(&self, item: Kept) -> Check {
        self.verdict("to contain equal", move |host, value| {
            let item = item.get(host)?;
            let mut holds = false;
            for i in items(value)? {
                if values::equals(i.get(), item.get()).map_err(|e| e.0)? {
                    holds = true;
                    break;
                }
            }
            Ok((holds, Some(values::show(item.get()))))
        })
    }

    /// The value is truthy, as JS sees it.
    pub fn to_be_truthy(&self) -> Check {
        self.verdict("to be truthy", |_, value| Ok((values::truthy(value), None)))
    }

    /// The value is falsy, as JS sees it.
    pub fn to_be_falsy(&self) -> Check {
        self.verdict("to be falsy", |_, value| Ok((!values::truthy(value), None)))
    }

    /// The check `holds` makes of the value, made as it goes back to JS:
    /// whether it holds, and what it expected, shown (`None`: nothing).
    fn verdict(
        &self,
        what: &'static str,
        holds: impl FnOnce(&dyn JsHost, JsIn<'_>) -> Result<(bool, Option<String>), String> + 'static,
    ) -> Check {
        let (value, not) = (self.value.clone(), self.not);
        let hint = match (&self.run, self.promise) {
            (_, true) => {
                "; `expect` was given a promise: check what it settles to with `resolves` or `rejects`"
            }
            (Some(_), false) => {
                "; `expect` was given a function: call it, or check what it throws with `toThrow`"
            }
            (None, false) => "",
        };
        Check::new(move |host| {
            let value = value.get(host)?;
            let (holds, expected) = holds(host, value.get())?;
            if holds != not {
                return Ok(());
            }
            let not = if not { "not " } else { "" };
            let shown = values::show(value.get());
            Err(match expected {
                Some(expected) => format!("expected {shown} {not}{what} {expected}{hint}"),
                None => format!("expected {shown} {not}{what}{hint}"),
            })
        })
    }
}

/// The items of `value` to look in (`toContain`): what it yields as an
/// iterable (an array's items, a `Set`'s values); none when it is not one.
fn items<'a>(value: JsIn<'a>) -> Result<Vec<JsOwned<'a>>, String> {
    Ok(value.iterate().map_err(|e| e.0)?.unwrap_or_default())
}

/// What a promise rejects with ([`Expectation::rejects`]).
#[class]
pub struct Rejection {
    /// The promise's stand-in, or the function returning it.
    run: Callback<(), Kept>,
    promise: bool,
    not: bool,
}

#[class]
impl Rejection {
    /// The opposite checks: `await expect(save()).rejects.not.toThrow(TypeError)`.
    #[getter]
    pub fn not(&self) -> Rejection {
        Rejection {
            run: self.run.clone(),
            promise: self.promise,
            not: !self.not,
        }
    }

    /// The promise rejects; given `expected`, with an error that matches it,
    /// as `toThrow` says.
    pub async fn to_throw(
        this: Instance<Self>,
        expected: Option<ErrorMatch>,
    ) -> Result<Check, String> {
        let (run, promise, not) = this.with(|r| (r.run.clone(), r.promise, r.not));
        let error = run.call_async_traced(()).await.err();
        Ok(Check::new(move |host| {
            thrown(
                host,
                error.as_ref(),
                expected.as_ref(),
                not,
                subject(promise),
                "to reject",
            )
        }))
    }

    /// The promise rejects with a value that matches `subset` as
    /// `toMatchObject` says: an error's own properties (its `code`, ...)
    /// with its `name` and `message`. Codes, unlike messages, stay as they
    /// are: `await expect(app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" })`.
    pub async fn to_match_object(this: Instance<Self>, subset: Kept) -> Result<Check, String> {
        let (run, promise, not) = this.with(|r| (r.run.clone(), r.promise, r.not));
        let error = run
            .call_async_traced(())
            .await
            .err()
            .map(|e| error_json(&e));
        Ok(Check::new(move |host| {
            let subset = subset.get(host)?;
            subset_of(subset.get())?;
            let error = match &error {
                Some(json) => Some(JsOwned::new(host, host.json(json).map_err(|e| e.0)?)),
                None => None,
            };
            let holds = match &error {
                Some(error) => {
                    values::matches_object(error.get(), subset.get()).map_err(|e| e.0)?
                }
                None => false,
            };
            if holds != not {
                return Ok(());
            }
            let not_ = if not { "not " } else { "" };
            let subject = subject(promise);
            let subset = values::show(subset.get());
            Err(match error {
                Some(error) => format!(
                    "expected {subject} {not_}to reject with a value matching {subset}; it rejected with {}",
                    values::show(error.get())
                ),
                None => format!(
                    "expected {subject} {not_}to reject with a value matching {subset}; it resolved"
                ),
            })
        }))
    }
}

/// What a promise resolves to ([`Expectation::resolves`]).
#[class]
pub struct Resolution {
    /// The promise's stand-in, or the function returning it.
    run: Callback<(), Kept>,
    promise: bool,
    not: bool,
}

#[class]
impl Resolution {
    /// The opposite checks: `await expect(load()).resolves.not.toBe(null)`.
    #[getter]
    pub fn not(&self) -> Resolution {
        Resolution {
            run: self.run.clone(),
            promise: self.promise,
            not: !self.not,
        }
    }

    /// The promise resolves to `expected`, as `toBe` says.
    pub async fn to_be(this: Instance<Self>, expected: Kept) -> Result<Check, String> {
        Ok(resolved(this).await?.to_be(expected))
    }

    /// The promise resolves to a value equal to `expected`, as `toEqual`
    /// says.
    pub async fn to_equal(this: Instance<Self>, expected: Kept) -> Result<Check, String> {
        Ok(resolved(this).await?.to_equal(expected))
    }

    /// The promise resolves to a value that matches `subset`, as
    /// `toMatchObject` says.
    pub async fn to_match_object(this: Instance<Self>, subset: Kept) -> Result<Check, String> {
        Ok(resolved(this).await?.to_match_object(subset))
    }
}

/// The value the promise of `this` resolves to, to check; an error when it
/// rejects.
async fn resolved(this: Instance<Resolution>) -> Result<Expectation, String> {
    let (run, promise, not) = this.with(|r| (r.run.clone(), r.promise, r.not));
    match run.call_async_traced(()).await {
        Ok(value) => Ok(Expectation {
            value,
            run: None,
            promise: false,
            not,
        }),
        Err(error) => Err(format!(
            "expected {} to resolve; it rejected with {:?}",
            subject(promise),
            error.message
        )),
    }
}

/// What failure messages call what `expect` was given.
fn subject(promise: bool) -> &'static str {
    if promise {
        "the promise"
    } else {
        "the function"
    }
}

/// `subset` as `toMatchObject` takes it: an object (or an array).
fn subset_of(subset: JsIn<'_>) -> Result<(), String> {
    match subset.class() {
        Some(class) if class != JsClass::Function => Ok(()),
        _ => Err(format!(
            "`toMatchObject` takes an object of the properties to match, not {}",
            values::show(subset)
        )),
    }
}

/// What JS threw, as checks see it: the value thrown as JSON
/// ([`Exception::thrown`]), else (an error Rust made) its message.
fn error_json(error: &Exception) -> JsonValue {
    error
        .thrown
        .clone()
        .unwrap_or_else(|| serde_json::json!({ "name": "Error", "message": error.message }))
}

/// Checks what a function threw or a promise rejected with (`error`;
/// `None`: nothing) against `expected`; `subject` names what was checked.
fn thrown(
    host: &dyn JsHost,
    error: Option<&Exception>,
    expected: Option<&ErrorMatch>,
    not: bool,
    subject: &str,
    what: &str,
) -> Result<(), String> {
    let holds = match (error, expected) {
        (Some(error), Some(expected)) => expected.matches(host, error)?,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if holds != not {
        return Ok(());
    }
    let not_ = if not { "not " } else { "" };
    let wanted = expected.map_or(String::new(), |e| format!(" {}", e.describe()));
    Err(match error {
        Some(error) => format!(
            "expected {subject} {not_}{what}{wanted}; it threw {}",
            describe_error(error)
        ),
        None => format!("expected {subject} {not_}{what}{wanted}; it did not"),
    })
}

/// `error` as failure messages say it: its class, message and `code`
/// (`TypeError "not a number"`, `Error "denied" (code "ERR_ACCESS_DENIED")`).
fn describe_error(error: &Exception) -> String {
    let json = error_json(error);
    let field = |key: &str| json.get(key).and_then(JsonValue::as_str);
    let mut text = match field("name") {
        Some(name) => format!("{name} {:?}", error.message),
        None => format!("{:?}", error.message),
    };
    if let Some(code) = field("code") {
        text.push_str(&format!(" (code {code:?})"));
    }
    text
}

/// What `expect` checks: a value, kept as JS made it; a function (for
/// `toThrow`, `rejects`, `resolves`) or a promise (`rejects`, `resolves`)
/// is one too.
pub struct Subject {
    value: Kept,
    /// A function's, or a promise's stand-in that answers what it settles
    /// to ([`Callback::settling`]).
    run: Option<Callback<(), Kept>>,
    /// The value is a promise.
    promise: bool,
}

impl Arg for Subject {
    fn ts_type(_types: &mut TsTypes) -> String {
        "unknown".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let (run, promise) = match value.kind() {
            JsKind::Function => (Some(<Callback<(), Kept> as Arg>::from_js(value)?), false),
            JsKind::Object if is_thenable(value) => {
                let run = Callback::settling(value)
                    .ok_or_else(|| value.expected("a value, a function or a promise"))?;
                (Some(run), true)
            }
            _ => (None, false),
        };
        Ok(Subject {
            value: <Kept as JsValue>::from_js(value)?,
            run,
            promise,
        })
    }
}

/// Whether `value` is a promise (has a `then` method).
fn is_thenable(value: JsIn<'_>) -> bool {
    value
        .field("then")
        .is_ok_and(|then| then.get().kind() == JsKind::Function)
}

/// What error a check wants (`toThrow`): its message containing a string
/// or matching a `RegExp`, an error class, or an error with the same
/// message.
pub enum ErrorMatch {
    /// The message matches this.
    Message(Pattern),
    /// The error's `name` is this class's (`TypeError`); `Error` matches
    /// every error.
    Class(String),
    /// The message is this one (an error given).
    Error(String),
}

impl ErrorMatch {
    fn matches(&self, host: &dyn JsHost, error: &Exception) -> Result<bool, String> {
        Ok(match self {
            ErrorMatch::Message(pattern) => pattern.matches(host, &error.message)?,
            ErrorMatch::Error(message) => error.message == *message,
            ErrorMatch::Class(class) => is_of_class(error, class),
        })
    }

    fn describe(&self) -> String {
        match self {
            ErrorMatch::Message(pattern) => pattern.describe(),
            ErrorMatch::Class(class) => class.clone(),
            ErrorMatch::Error(message) => format!("an error {}", JsonValue::from(message.as_str())),
        }
    }
}

impl JsValue for ErrorMatch {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | RegExp | (abstract new (...args: any[]) => Error) | Error".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let text = |key: &str| value.field(key).ok().and_then(|v| v.get().as_string());
        if value.kind() == JsKind::Function {
            return text("name")
                .filter(|name| !name.is_empty())
                .map(ErrorMatch::Class)
                .ok_or_else(|| value.expected("a named error class"));
        }
        if value.kind() == JsKind::Object
            && value.class() != Some(JsClass::RegExp)
            && let Some(message) = text("message")
        {
            return Ok(ErrorMatch::Error(message));
        }
        <Pattern as JsValue>::from_js(value)
            .map(ErrorMatch::Message)
            .map_err(|_| value.expected("a string, a RegExp, an error class or an error"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Ok(JsOwned::new(host, host.new_string(&self.describe())?))
    }
}

/// Whether `error` is of error class `class` (`TypeError`): its `name` is
/// the class's, and every error (a value with a `name` and a `message`) is
/// an `Error`.
fn is_of_class(error: &Exception, class: &str) -> bool {
    let json = error_json(error);
    let field = |key: &str| json.get(key).and_then(JsonValue::as_str);
    match (field("name"), field("message")) {
        (Some(name), Some(_)) => name == class || class == "Error",
        (Some(name), None) => name == class,
        _ => false,
    }
}

/// A text a check wants: contained (a string), or matched (a `RegExp`,
/// which the JS engine runs).
pub enum Pattern {
    /// Contains this.
    Contains(String),
    /// Matches this `RegExp`, written as it reads (`/a+/i`).
    RegExp(Kept, String),
}

impl Pattern {
    /// Whether `text` contains or matches it (`text.search(re)` finds it:
    /// `lastIndex` and the `g` flag do not matter).
    fn matches(&self, host: &dyn JsHost, text: &str) -> Result<bool, String> {
        match self {
            Pattern::Contains(part) => Ok(text.contains(part.as_str())),
            Pattern::RegExp(re, _) => {
                let re = re.get(host)?;
                let text = JsOwned::new(host, host.new_string(text).map_err(|e| e.0)?);
                let at = text.get().invoke("search", &[re.get()]).map_err(|e| e.0)?;
                Ok(at.get().as_number().is_some_and(|at| at >= 0.0))
            }
        }
    }

    /// As failure messages show it: a string quoted, a `RegExp` as it reads.
    fn describe(&self) -> String {
        match self {
            Pattern::Contains(part) => JsonValue::String(part.clone()).to_string(),
            Pattern::RegExp(_, source) => source.clone(),
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
        if value.class() != Some(JsClass::RegExp) {
            return Err(value.expected("a string or a RegExp"));
        }
        let field = |name: &str| value.field(name).ok().and_then(|v| v.get().as_string());
        let written = format!(
            "/{}/{}",
            field("source").unwrap_or_default(),
            field("flags").unwrap_or_default()
        );
        Ok(Pattern::RegExp(<Kept as JsValue>::from_js(value)?, written))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Pattern::Contains(part) => Ok(JsOwned::new(host, host.new_string(part)?)),
            Pattern::RegExp(re, _) => re.to_js(host),
        }
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

    /// Runs `checks`, a module importing `expect` from `nsh/test`, on a VM
    /// of its own, and panics with what it threw. In it, `fails(f,
    /// message)` checks that `f` throws `message`.
    fn run(checks: &str) {
        let host = nsh_js::Host::with_options(nsh_js::HostOptions {
            ui_sets: vec![registry()],
            ..Default::default()
        })
        .unwrap();
        let source = format!(
            r#"import {{ expect }} from "nsh/test";
const fails = (f, message) => {{
  let got;
  try {{ f(); }} catch (e) {{ got = e.message; }}
  if (got !== message) throw new Error(`${{f}}: threw ${{JSON.stringify(got)}}, not ${{JSON.stringify(message)}}`);
}};
{checks}"#
        );
        if let Err(e) = host.eval_source(&source) {
            panic!("{}", e.message);
        }
    }

    #[test]
    fn to_be_is_object_is() {
        run(r#"
            expect(1).toBe(1);
            expect("a").toBe("a");
            expect(NaN).toBe(NaN);
            expect(0).not.toBe(-0);
            const o = {};
            expect(o).toBe(o);
            const f = () => 1;
            expect(f).toBe(f);
            fails(() => expect({}).toBe({}), "expected {} to be {} (an equal value, not the same one: `toEqual` compares members)");
            fails(() => expect([1]).toBe([2]), "expected [1] to be [2]");
            fails(() => expect(1).toBe("1"), 'expected 1 to be "1"');
            fails(() => expect(undefined).toBe(null), "expected undefined to be null");
            fails(() => expect({ a: undefined, b: -0 }).toBe(1), 'expected {"a":undefined,"b":-0} to be 1');
            fails(
                () => expect(Promise.resolve(1)).toBe(1),
                "expected Promise {} to be 1; `expect` was given a promise: check what it settles to with `resolves` or `rejects`",
            );
        "#);
    }

    #[test]
    fn to_equal_compares_as_jest_does() {
        run(r#"
            expect({ a: 1, b: [1, "x"] }).toEqual({ b: [1, "x"], a: 1 });
            expect([1]).not.toEqual([1, 2]);
            // Properties that are `undefined` are as ones missing, holes as
            // `undefined`.
            expect({ a: 1, b: undefined }).toEqual({ a: 1 });
            expect({ a: 1 }).toEqual({ a: 1, b: undefined });
            expect([, 1]).toEqual([undefined, 1]);
            expect([undefined]).not.toEqual([]);
            expect(NaN).toEqual(NaN);
            expect(0).not.toEqual(-0);
            expect(null).not.toEqual(undefined);
            // Dates by their time.
            expect(new Date(1000)).toEqual(new Date(1000));
            expect(new Date(NaN)).toEqual(new Date(NaN));
            expect(new Date(0)).not.toEqual("1970-01-01T00:00:00.000Z");
            expect(new Date(0)).not.toEqual({});
            fails(
                () => expect(new Date(1000)).toEqual(new Date(2000)),
                "expected Date(1970-01-01T00:00:01.000Z) to equal Date(1970-01-01T00:00:02.000Z)",
            );
            // Regular expressions by source and flags.
            expect(/a+/gi).toEqual(/a+/gi);
            expect(/a+/g).not.toEqual(/a+/i);
            expect(/a/).not.toEqual(/b/);
            // Maps and sets by their entries, in any order.
            expect(new Map([["a", { x: 1 }], ["b", 2]])).toEqual(new Map([["b", 2], ["a", { x: 1 }]]));
            expect(new Map([["a", 1]])).not.toEqual(new Map([["a", 2]]));
            expect(new Map([["a", 1]])).not.toEqual(new Map());
            expect(new Map()).not.toEqual(new Set());
            expect(new Set([1, { y: 2 }])).toEqual(new Set([{ y: 2 }, 1]));
            expect(new Set([1, 2])).not.toEqual(new Set([1, 3]));
            expect(new Set()).not.toEqual({});
            fails(() => expect(new Map([["a", 1]])).toEqual(new Map([["a", 2]])), 'expected Map {"a" => 1} to equal Map {"a" => 2}');
            fails(() => expect(new Set([1])).toEqual(new Set()), "expected Set {1} to equal Set {}");
            // Typed arrays, `ArrayBuffer`s and `DataView`s by their bytes.
            expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 2]));
            expect(new Uint8Array([1, 2])).not.toEqual(new Uint8Array([1, 3]));
            expect(new Uint8Array([1, 2])).not.toEqual(new Int8Array([1, 2]));
            expect(new Uint8Array([1, 2])).not.toEqual({ 0: 1, 1: 2 });
            expect(new Uint8Array([1, 2])).not.toEqual([1, 2]);
            expect(new Uint8Array([1, 2, 3]).subarray(1)).toEqual(new Uint8Array([2, 3]));
            expect(new Float64Array([NaN, 1.5])).toEqual(new Float64Array([NaN, 1.5]));
            expect(new Uint8Array([1, 2]).buffer).toEqual(new Uint8Array([1, 2]).buffer);
            expect(new ArrayBuffer(2)).not.toEqual(new ArrayBuffer(3));
            expect(new DataView(new ArrayBuffer(2))).toEqual(new DataView(new ArrayBuffer(2)));
            fails(() => expect(new Uint8Array([1])).toEqual(new Uint8Array([2])), "expected Uint8Array [1] to equal Uint8Array [2]");
            // Instances by their properties, not their class.
            class Point { constructor(x) { this.x = x; } }
            expect(new Point(1)).toEqual({ x: 1 });
            expect(new Point(1)).not.toEqual(new Point(2));
            fails(() => expect(new Point(1)).toEqual(new Point(2)), 'expected Point {"x":1} to equal Point {"x":2}');
            // Functions only by identity; errors by name and message.
            const f = () => 1;
            expect(f).toEqual(f);
            expect(() => 1).not.toEqual(() => 1);
            expect(new TypeError("x")).toEqual(new TypeError("x"));
            expect(new TypeError("x")).not.toEqual(new RangeError("x"));
            expect(new Error("x")).not.toEqual(new Error("y"));
            // A value inside itself.
            const a = { name: "a" };
            a.self = a;
            const b = { name: "a" };
            b.self = b;
            expect(a).toEqual(b);
            fails(() => expect(a).toEqual({ name: "b" }), 'expected {"name":"a","self":[Circular]} to equal {"name":"b"}');
        "#);
    }

    #[test]
    fn null_undefined_and_nan_are_told_apart() {
        run(r#"
            expect(null).toBeNull();
            fails(() => expect(undefined).toBeNull(), "expected undefined to be null");
            fails(() => expect(NaN).toBeNull(), "expected NaN to be null");
            expect(undefined).toBeUndefined();
            expect(null).not.toBeUndefined();
            fails(() => expect(0).toBeUndefined(), "expected 0 to be undefined");
            expect(null).toBeDefined();
            expect(0).toBeDefined();
            fails(() => expect(undefined).toBeDefined(), "expected undefined to be defined");
            expect(NaN).toBeNaN();
            expect(1).not.toBeNaN();
            expect("NaN").not.toBeNaN();
            fails(() => expect(1).toBeNaN(), "expected 1 to be NaN");
        "#);
    }

    #[test]
    fn regular_expressions_run_on_the_js_engine() {
        run(r#"
            expect("Saved at 9:41").toMatch("Saved");
            expect("Saved at 9:41").toMatch(/\d+:\d+$/);
            // What only JavaScript's regular expressions have: look-behind
            // and backreferences.
            expect("price: $5").toMatch(/(?<=\$)\d/);
            expect("abab").toMatch(/(ab)\1/);
            expect("HELLO").toMatch(/hello/i);
            // `lastIndex` does not matter, a sticky one matches at the start.
            const g = /a/g;
            g.lastIndex = 5;
            expect("a").toMatch(g);
            expect("ba").not.toMatch(/a/y);
            fails(() => expect("abc").toMatch(/^b/), 'expected "abc" to match /^b/');
            fails(() => expect("abc").toMatch("x"), 'expected "abc" to match "x"');
            fails(() => expect(1).toMatch(/1/), "expected 1 to match /1/");
            expect(() => { throw new Error("price: $5"); }).toThrow(/(?<=\$)\d/);
            fails(
                () => expect(() => { throw new TypeError("boom"); }).toThrow(/^x/),
                'expected the function to throw /^x/; it threw TypeError "boom"',
            );
        "#);
    }

    #[test]
    fn errors_match_by_message_class_and_error() {
        run(r#"
            const boom = () => { throw new TypeError("not a number"); };
            expect(boom).toThrow();
            expect(boom).toThrow("a number");
            expect(boom).toThrow(TypeError);
            expect(boom).toThrow(Error);
            expect(boom).not.toThrow(RangeError);
            expect(boom).toThrow(new Error("not a number"));
            expect(boom).not.toThrow(new Error("not a"));
            // A string thrown is no error of any class.
            expect(() => { throw "x"; }).not.toThrow(Error);
            fails(() => expect(() => {}).toThrow("x"), 'expected the function to throw "x"; it did not');
            fails(
                () => expect(() => {
                    const e = new Error("fs is not granted");
                    e.code = "ERR_ACCESS_DENIED";
                    throw e;
                }).toThrow(TypeError),
                'expected the function to throw TypeError; it threw Error "fs is not granted" (code "ERR_ACCESS_DENIED")',
            );
            fails(
                () => expect(1).toThrow(),
                "`toThrow` checks a function: `expect(() => parse(text)).toThrow()`",
            );
        "#);
    }

    #[test]
    fn lengths_of_strings_arrays_and_typed_arrays() {
        run(r#"
            expect("héllo").toHaveLength(5);
            expect("😀").toHaveLength(2);
            expect([1, 2]).toHaveLength(2);
            expect(new Uint8Array(3)).toHaveLength(3);
            expect(new Float64Array(4)).toHaveLength(4);
            expect({ length: 1 }).toHaveLength(1);
            expect(5).not.toHaveLength(1);
            fails(() => expect([1, 2]).toHaveLength(3), "expected [1,2] to have length 3");
            fails(() => expect(new Uint8Array(2)).toHaveLength(3), "expected Uint8Array [0,0] to have length 3");
        "#);
    }

    #[test]
    fn objects_match_a_subset_of_their_properties() {
        run(r#"
            const value = {
                a: 1,
                b: { c: [1, { d: 2, e: 3 }], f: null },
                when: new Date(5),
                tags: new Set(["x"]),
            };
            expect(value).toMatchObject({});
            expect(value).toMatchObject({ a: 1 });
            expect(value).toMatchObject({ b: { c: [1, { d: 2 }] } });
            // Arrays match item by item, all of them.
            expect(value).not.toMatchObject({ b: { c: [1] } });
            expect(value).not.toMatchObject({ a: 2 });
            expect(value).not.toMatchObject({ g: undefined });
            expect(value).toMatchObject({ b: { f: null } });
            // Leaves equal as `toEqual` says.
            expect(value).toMatchObject({ when: new Date(5), tags: new Set(["x"]) });
            expect(value).not.toMatchObject({ when: new Date(6) });
            expect(value).not.toMatchObject({ when: "1970-01-01T00:00:00.005Z" });
            expect({ n: NaN }).toMatchObject({ n: NaN });
            // As in Jest: a plain object is a subset of the bytes it names.
            expect({ bytes: new Uint8Array([1]) }).toMatchObject({ bytes: { 0: 1 } });
            // What an error inherits counts (its `name`).
            expect(new TypeError("x")).toMatchObject({ name: "TypeError", message: "x" });
            expect(1).not.toMatchObject({ a: 1 });
            fails(() => expect({ a: 1 }).toMatchObject({ a: 2 }), 'expected {"a":1} to match object {"a":2}');
            fails(() => expect({ a: 1 }).toMatchObject("a"), '`toMatchObject` takes an object of the properties to match, not "a"');
        "#);
    }

    #[test]
    fn to_contain_is_strict_and_to_contain_equal_deep() {
        run(r#"
            const texts = ["Buy milk", "1 item left"];
            expect(texts).toContain("1 item left");
            expect(texts).not.toContain("Error");
            fails(() => expect(texts).toContain("2 items left"), 'expected ["Buy milk","1 item left"] to contain "2 items left"');
            fails(() => expect(texts).not.toContain("Buy milk"), 'expected ["Buy milk","1 item left"] not to contain "Buy milk"');
            expect("Saved!").toContain("Saved");
            expect("Saved!").not.toContain(1);
            const item = { id: 1 };
            expect([item]).toContain(item);
            expect([{ id: 1 }]).not.toContain({ id: 1 });
            expect([{ id: 1 }]).toContainEqual({ id: 1 });
            expect([{ id: 1 }]).not.toContainEqual({ id: 2 });
            expect([NaN]).not.toContain(NaN);
            expect([NaN]).toContainEqual(NaN);
            expect([-0]).toContain(0);
            expect(new Set(["a"])).toContain("a");
            expect(new Uint8Array([7])).toContain(7);
            expect(1).not.toContain(1);
        "#);
    }

    #[test]
    fn truthiness_and_numbers_as_js_sees_them() {
        run(r#"
            expect(0).toBeFalsy();
            expect("").toBeFalsy();
            expect(NaN).toBeFalsy();
            expect(null).toBeFalsy();
            expect(undefined).toBeFalsy();
            expect(0n).toBeFalsy();
            expect(1n).toBeTruthy();
            expect([]).toBeTruthy();
            expect({}).toBeTruthy();
            fails(() => expect("").toBeTruthy(), 'expected "" to be truthy');
            expect(3).toBeGreaterThan(2);
            expect(3).toBeGreaterThanOrEqual(3);
            expect(2).toBeLessThanOrEqual(2);
            expect("3").not.toBeGreaterThan(2);
            fails(() => expect(3).toBeLessThan(2.5), "expected 3 to be less than 2.5");
            fails(() => expect(3).toBeLessThan(2), "expected 3 to be less than 2");
        "#);
    }

    /// An error as `nsh-js` reports one thrown: `thrown` holds its own
    /// properties with its `name` and `message`.
    fn error(name: &str, message: &str) -> Exception {
        let mut exception = Exception::from(message.to_owned());
        exception.thrown = Some(json!({ "name": name, "message": message }));
        exception
    }

    #[test]
    fn errors_are_of_their_class_and_errors_rust_made_are_errors() {
        let type_error = error("TypeError", "not a number");
        assert!(is_of_class(&type_error, "TypeError"));
        assert!(is_of_class(&type_error, "Error"));
        assert!(!is_of_class(&type_error, "RangeError"));
        let mut text = Exception::from("x".to_owned());
        text.thrown = Some(json!("x"));
        assert!(!is_of_class(&text, "Error"));
        assert!(is_of_class(&Exception::from("lost".to_owned()), "Error"));
        assert_eq!(
            error_json(&Exception::from("lost".to_owned())),
            json!({ "name": "Error", "message": "lost" })
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
