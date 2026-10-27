//! Dev-server wire protocol (WebSocket at [`WS_PATH`]).
//!
//! Control messages are JSON text frames. A bundle is sent as a
//! [`ServerMessage::Bundle`] text frame immediately followed by one binary
//! frame with the payload and, if announced, one binary frame with the
//! source map (JSON). A [`ServerMessage::Patch`] (a hot update) is framed the
//! same way and precedes the bundle of the same version.
//!
//! `nsh test --target` drives a host's app through the same connection: the
//! server's hello asks for a test session, and each [`ServerMessage::Step`]
//! (a [`TestStep`] with an id) gets one [`ClientMessage::StepDone`] with
//! that id, from the host's test agent (`nsh_testing::agent`).
//!
//! Every float field decodes through `float` (`deserialize_with`): the
//! messages are internally tagged enums, which serde buffers before it
//! decodes their fields, and a serde_json built with `arbitrary_precision`
//! (which feature unification turns on in a binary that also links a crate
//! asking for it, rolldown's) buffers a number with a fraction as a map,
//! which a plain `f32` / `f64` field rejects.

use serde::{Deserialize, Serialize};

/// Protocol version; bump on incompatible changes.
pub const PROTOCOL_VERSION: u32 = 2;

/// WebSocket endpoint path.
pub const WS_PATH: &str = "/ws";

/// Default dev-server port.
pub const DEFAULT_PORT: u16 = 8790;

/// Messages from a dev host to the server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// First message after connecting.
    Hello {
        /// [`PROTOCOL_VERSION`] of the client.
        protocol: u32,
        /// Bytecode format the host's engine can load; the server falls back
        /// to JS source when it differs from its own. Empty: the host runs
        /// JS source only (the web host).
        bytecode_version: String,
        /// Human-readable device name, shown in logs.
        device: String,
        /// What kind of host it is, for the command that installs another
        /// (`None`: a host that does not say).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<HostPlatform>,
        /// The UI sets the host serves, by specifier (an
        /// app's own `gallery/native`): bundles importing others are not
        /// sent to it ([`ServerMessage::CannotRun`]). `None`: a host that
        /// does not say, which gets every bundle.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ui_sets: Option<Vec<String>>,
        /// The host takes test steps ([`ServerMessage::Step`]).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        tests: bool,
    },
    /// The outcome of the [`ServerMessage::Step`] with this id.
    StepDone {
        /// The step's id.
        id: u64,
        /// What it gave, or why it failed.
        outcome: StepOutcome,
    },
    /// A request of a test session's app, which the test answers
    /// ([`ServerMessage::Fetch`] of the same id).
    Fetch {
        /// The request's id, chosen by the host.
        id: u64,
        /// The request.
        request: WireRequest,
    },
    /// The app no longer wants the answer to request `id`.
    FetchCancel {
        /// The request's id.
        id: u64,
    },
    /// A batch a traced test session's app applied
    /// ([`ServerMessage::TestSetup`]): its mount items, a line each, as
    /// `nsh test --trace` prints them.
    Trace {
        /// The items.
        items: Vec<String>,
    },
    /// A log line from the host (JS console or native).
    Log {
        /// Severity.
        level: LogLevel,
        /// Source, e.g. `js` or a Rust module path.
        target: String,
        /// The message.
        message: String,
    },
}

/// What kind of host a dev host is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum HostPlatform {
    /// The Mac Catalyst host.
    MacCatalyst,
    /// A host in an iOS simulator.
    IosSimulator,
    /// A host on an iOS device.
    Ios,
    /// A host on an Android device or emulator.
    Android,
    /// The Linux (GTK) host.
    Linux,
    /// The macOS (AppKit) host.
    MacOs,
    /// The Windows host.
    Windows,
    /// The web host: a browser page the dev server serves.
    Web,
    /// The GPUI host (macOS, Windows, Linux).
    Gpui,
    /// The terminal host (macOS, Windows, Linux).
    Tui,
    /// A platform this version does not know.
    #[serde(other)]
    Other,
}

/// What a test fixes of its app's environment on a host, whatever the
/// platform reports, and the clipboard its app's calls are served from
/// (`open`'s options; [`ServerMessage::TestSetup`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TestEnvironment {
    /// The text on the test's clipboard at first: the app's clipboard calls
    /// are served from a clipboard of the test's own, never the machine's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clipboard: Option<String>,
    /// The locale, a BCP 47 tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Whether the user asked for less motion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduced_motion: Option<bool>,
    /// The safe area insets in points: top, right, bottom, left.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "float::option_f32x4"
    )]
    pub safe_area: Option<[f32; 4]>,
    /// The app runs on a manual clock standing at this wall time, in
    /// milliseconds since the Unix epoch: its time moves only as the test
    /// moves it ([`TestStep::Clock`]) and by a frame's time with each frame
    /// the platform shows, as a headless app's does.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "float::option_f64"
    )]
    pub clock: Option<f64>,
    /// The launch parameters the app reads as `host.params` (`nsh/host`):
    /// the embedding app's, which the test plays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_params: Option<serde_json::Map<String, serde_json::Value>>,
}

/// How a test moves its app's manual clock ([`TestEnvironment::clock`];
/// `app.clock`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "change", rename_all = "snake_case")]
pub enum ClockChange {
    /// Moves it by `ms`, a time at a time: the timers due on the way run
    /// in order, each at its time (`clock.runFor`).
    RunFor {
        /// Milliseconds.
        ms: u64,
    },
    /// Moves it by `ms` at once, as a device waking from sleep does: the
    /// timers due meanwhile run once each (`clock.fastForward`).
    FastForward {
        /// Milliseconds.
        ms: u64,
    },
    /// Sets its wall time (`Date.now()`) without moving its timers
    /// (`clock.setSystemTime`).
    SetSystemTime {
        /// Milliseconds since the Unix epoch.
        #[serde(deserialize_with = "float::f64")]
        unix_ms: f64,
    },
}

/// Messages from the server to dev hosts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Reply to [`ClientMessage::Hello`].
    Hello {
        /// [`PROTOCOL_VERSION`] of the server.
        protocol: u32,
        /// This run of the server: build numbers start at 1 in each run, so
        /// a host still running a build of an earlier run tells them apart
        /// by it.
        #[serde(default)]
        session: u64,
        /// A test session: the host keeps the model of its app that steps
        /// need from the first bundle on ([`ServerMessage::Step`]).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        test: bool,
    },
    /// What a test session's app starts with (after [`ServerMessage::Hello`],
    /// before the first bundle): the storage it finds, in place of its
    /// own. Its requests go to the test ([`ClientMessage::Fetch`]).
    TestSetup {
        /// The storage's entries.
        #[serde(default)]
        storage: Vec<(String, String)>,
        /// Trace the app (`nsh test --trace`): its engine logs each
        /// commit's timings, and the host sends each batch it applies
        /// ([`ClientMessage::Trace`]).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        trace: bool,
        /// What the test fixes of the app's environment, and its clipboard.
        #[serde(default)]
        environment: TestEnvironment,
    },
    /// What the test answers to the app's request `id`
    /// ([`ClientMessage::Fetch`]), a message per event, in order.
    Fetch {
        /// The request's id.
        id: u64,
        /// The event.
        reply: FetchReply,
    },
    /// A step of a test, which the host answers with a
    /// [`ClientMessage::StepDone`] of the same id.
    Step {
        /// Its id.
        id: u64,
        /// What to do.
        step: TestStep,
    },
    /// A test session's app is the host's own Rust root (`nsh.json`
    /// `"root"`, an app of Rust only), which it runs in place of a bundle.
    Root,
    /// A rebuild started.
    Building,
    /// The host cannot run the app: the latest bundle imports UI sets it
    /// does not serve (it was built for another app). No bundle is sent to
    /// it until one needs only what it has; the host shows `message`.
    CannotRun {
        /// The UI sets the app imports that the host does not serve.
        missing: Vec<String>,
        /// What to tell the developer: what is missing, and how to install
        /// the app's host.
        message: String,
    },
    /// The build failed; the host should show the error.
    BuildFailed {
        /// Compiler output.
        message: String,
    },
    /// A hot update from bundle `base` to bundle `version`: the next binary
    /// frame is a script (UTF-8 JS) that replaces the changed modules in
    /// place. Hosts running `base` apply it; the bundle of `version`
    /// follows either way.
    Patch {
        /// Build number after the update.
        version: u64,
        /// Build number the update applies to.
        base: u64,
        /// A second binary frame with the source map follows.
        #[serde(default)]
        source_map: bool,
    },
    /// A new bundle; the next binary frame is its payload.
    Bundle {
        /// Monotonic build number.
        version: u64,
        /// Payload format.
        format: BundleFormat,
        /// A second binary frame with the source map follows.
        #[serde(default)]
        source_map: bool,
        /// What the app declares it may reach (JSON), so development runs
        /// with the same capabilities as the release.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<String>,
        /// The app's id (`nsh.json` `"id"`), which names where it keeps its
        /// data.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_id: Option<String>,
        /// The VM limits to run the app with, as an embedding app would
        /// set them (`nsh run --limits`, in `nsh_core::js::HostLimits`'
        /// syntax: `memory=128MB,call=500ms`; empty: the embedding
        /// defaults). `None`: none, as an app on its own has.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limits: Option<String>,
    },
}

/// A file a test pastes ([`TestStep::Paste`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TestFile {
    /// Its name.
    pub name: String,
    /// Its MIME type.
    pub mime: String,
    /// Its bytes.
    pub data: Vec<u8>,
}

impl TestFile {
    /// A file named `name` of type `mime` holding `data`.
    pub fn new(name: impl Into<String>, mime: impl Into<String>, data: Vec<u8>) -> TestFile {
        TestFile {
            name: name.into(),
            mime: mime.into(),
            data,
        }
    }
}

/// A step of a test on a host's app, named as `nsh/test` names them: views
/// are found by selectors (`id:save`, `text:Add`, `role:button[Save]`), and
/// actions are native input at the view the selector names.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum TestStep {
    /// Waits for the app's first render, then until it is quiet.
    Ready {
        /// How long to wait for the first render, in milliseconds.
        timeout_ms: u64,
    },
    /// Presses the view (`app.press`).
    Press {
        /// The view.
        selector: String,
    },
    /// Holds a press on the view for its long press delay (`app.longPress`).
    LongPress {
        /// The view.
        selector: String,
    },
    /// Types `text` into the input (`app.type`).
    Type {
        /// The input.
        selector: String,
        /// What to type; `\n` is the return key in a single-line input.
        text: String,
    },
    /// The return key in the input (`app.submit`).
    Submit {
        /// The input.
        selector: String,
    },
    /// Empties the input (`app.clear`).
    Clear {
        /// The input.
        selector: String,
    },
    /// Scrolls the scroll view by `distance` points along its axis
    /// (`app.scroll`).
    Scroll {
        /// The scroll view.
        selector: String,
        /// Points; negative scrolls back.
        #[serde(deserialize_with = "float::f32")]
        distance: f32,
    },
    /// Drags the view: a finger (or the mouse) on its middle moves by
    /// `x`, `y` points and lifts (`app.drag`).
    Drag {
        /// The view.
        selector: String,
        /// Points rightwards.
        #[serde(deserialize_with = "float::f32")]
        x: f32,
        /// Points downwards.
        #[serde(deserialize_with = "float::f32")]
        y: f32,
    },
    /// Moves the mouse over the view (`app.hover`).
    Hover {
        /// The view.
        selector: String,
    },
    /// The mouse's secondary button over the view (`app.rightClick`).
    RightClick {
        /// The view.
        selector: String,
    },
    /// Pastes into the input (`app.paste`), as the user's paste does with
    /// this on the clipboard.
    Paste {
        /// The input.
        selector: String,
        /// The text (empty: none).
        text: String,
        /// Files with their bytes (images).
        files: Vec<TestFile>,
        /// Local files' `file:` URLs.
        uris: Vec<String>,
    },
    /// The open context menu's actions (`app.menu`): `null` when none is.
    Menu,
    /// The text on the test's clipboard (`app.clipboard`): `null` when it
    /// holds none.
    Clipboard,
    /// The embedding app sends event `name` with `data` to the app
    /// (`app.host.send`; `nsh/host`'s `host.on`), then the app settles.
    HostSend {
        /// The event.
        name: String,
        /// Its data.
        #[serde(default)]
        data: serde_json::Value,
    },
    /// The URLs the app opened (`app.openedUrls`; `openUrl` of
    /// `nsh/device`), in order: recorded, never opened.
    OpenedUrls,
    /// Chooses the open context menu's action (`app.chooseMenuItem`).
    ChooseMenuItem {
        /// Its label (a submenu's: `"Share > Mail"`).
        label: String,
    },
    /// Closes the open context menu with nothing chosen (`app.closeMenu`).
    CloseMenu,
    /// Presses a key with its modifiers, as `nsh/keymap` names it
    /// (`app.keyboard.press`).
    PressKey {
        /// The keystroke: `"mod+k"`, `"escape"`.
        keys: String,
    },
    /// Goes back as the user does (`app.back`).
    Back,
    /// Lets the app run (`app.wait`).
    Wait {
        /// Milliseconds.
        ms: u64,
    },
    /// Moves the app's manual clock ([`TestEnvironment::clock`]), then
    /// waits until it is quiet.
    Clock {
        /// How.
        change: ClockChange,
    },
    /// Waits until a view matches, or none does (`app.waitFor`).
    WaitFor {
        /// The view.
        selector: String,
        /// Milliseconds at most.
        timeout_ms: u64,
        /// Until none matches.
        gone: bool,
    },
    /// Waits for the next batch, `timeout_ms` at most: what polling a
    /// condition waits for between looks (`app.waitUntil`).
    NextChange {
        /// Milliseconds at most.
        timeout_ms: u64,
    },
    /// The texts on screen, in order: a list of strings.
    Texts,
    /// How many views match: a number.
    Count {
        /// The selector.
        selector: String,
    },
    /// Whether a view matches: a boolean.
    Shows {
        /// The selector.
        selector: String,
    },
    /// Whether the view takes input: a boolean.
    Enabled {
        /// The selector.
        selector: String,
    },
    /// The text of the input: a string, or null when none matches.
    Value {
        /// The selector.
        selector: String,
    },
    /// The dialogs the app showed, in order (`app.dialogs`): a list of
    /// `nsh_core::Dialog`s.
    Dialogs,
    /// The oldest dialog not answered yet: an `nsh_core::Dialog`, or null.
    PendingDialog,
    /// Answers the oldest dialog not answered yet: presses its button
    /// `button`, or closes it without one.
    AnswerDialog {
        /// The button's text (`None`: close it without one).
        button: Option<String>,
    },
    /// A picture of the app's window: a PNG, base64-encoded (the test's
    /// side saves it: the host may run on another machine).
    Screenshot,
    /// Makes the window `width` × `height` points (`app.setViewport`).
    SetViewport {
        /// Points.
        #[serde(deserialize_with = "float::f32")]
        width: f32,
        /// Points.
        #[serde(deserialize_with = "float::f32")]
        height: f32,
    },
    /// Switches the system's appearance as the app sees it
    /// (`app.setColorScheme`).
    SetColorScheme {
        /// Dark rather than light.
        dark: bool,
    },
    /// Closes the app: the host exits.
    Quit,
    /// A question about the host's model of the app or about its views,
    /// from a test agent that runs elsewhere (the web: `nsh` acts through
    /// the browser, the page knows the app).
    Scene {
        /// The question.
        query: SceneQuery,
    },
}

/// What a test agent that runs outside the host asks of it
/// ([`TestStep::Scene`]); the answers' shapes are `nsh_testing::agent`'s.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum SceneQuery {
    /// How many batches the app applied and how long ago the last was.
    Activity,
    /// The app's errors since the last time, taken.
    TakeErrors,
    /// The one view `selector` names for a step on `target`.
    Pick {
        /// The selector.
        selector: String,
        /// What the step acts on.
        target: PickTarget,
    },
    /// The scroll views around view `id`, innermost first.
    ScrollAncestors {
        /// The view.
        id: u32,
    },
    /// View `id`'s long press delay in milliseconds, if it says.
    LongPressDelay {
        /// The view.
        id: u32,
    },
    /// Whether scroll view `id` scrolls horizontally.
    Horizontal {
        /// The view.
        id: u32,
    },
    /// The input `selector` names.
    InputId {
        /// The selector.
        selector: String,
    },
    /// The oldest dialog was answered.
    Answered,
    /// The context menu the app shows (`Menu.popup`): its items, or `null`.
    Menu,
    /// The text on the test's clipboard, or `null`.
    Clipboard,
    /// The embedding app sends event `name` with `data` to the app
    /// ([`TestStep::HostSend`]).
    HostSend {
        /// The event.
        name: String,
        /// Its data.
        #[serde(default)]
        data: serde_json::Value,
    },
    /// The URLs the app opened, in order ([`TestStep::OpenedUrls`]).
    OpenedUrls,
    /// The open context menu was chosen from or closed.
    MenuClosed,
    /// The app's storage: its entries.
    Storage,
    /// Moves the app's manual clock ([`TestStep::Clock`]).
    Clock {
        /// How.
        change: ClockChange,
    },
    /// The window's content is this size: what lies outside it, and no
    /// scroll view brings in, is not on screen.
    SetViewport {
        /// Width in points.
        #[serde(deserialize_with = "float::f32")]
        width: f32,
        /// Height in points.
        #[serde(deserialize_with = "float::f32")]
        height: f32,
    },
    /// View `id`'s bounds on screen, in points from the viewport's top left.
    Bounds {
        /// The view.
        id: u32,
    },
    /// The viewport's size in points.
    Viewport,
    /// The text view showing span `id` (a nested text that takes presses)
    /// and where in its text it is: `[view, start, end]` (UTF-16 units),
    /// or `null` for a view.
    Span {
        /// The span.
        id: u32,
    },
    /// The canvas containing the node `selector` names, and its center
    /// in the canvas's coordinates: `[view, {x, y}]`, or `null` for a view.
    CanvasNode {
        /// The canvas node's selector.
        selector: String,
    },
    /// The view `selector` matches inside view `id` (a text in the button a
    /// press goes to), whose middle the press lands on, or `null` when the
    /// match is `id` itself.
    MatchInside {
        /// The step's selector.
        selector: String,
        /// The view the step acts on.
        id: u32,
    },

    /// The text input `id` holds.
    InputText {
        /// The view.
        id: u32,
    },
    /// Whether a native animation runs.
    Animating,
    /// Where to press to answer the dialog shown: its button `button`, or
    /// outside it (`None`).
    DialogPoint {
        /// The button's text.
        button: Option<String>,
    },
}

/// An app's HTTP request, as a test session's host forwards it
/// ([`ClientMessage::Fetch`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct WireRequest {
    /// Upper-case method.
    pub method: String,
    /// Absolute URL.
    pub url: String,
    /// Header names and values, in order.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// The body (a streamed one, gathered).
    #[serde(default, with = "base64_bytes")]
    pub body: Vec<u8>,
    /// Follow redirects.
    #[serde(default)]
    pub follow_redirects: bool,
}

/// What a test answers to an app's request ([`ServerMessage::Fetch`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "reply", rename_all = "snake_case")]
pub enum FetchReply {
    /// The host makes the request itself, on its own network (the test
    /// lets requests through).
    Pass,
    /// The response's status and headers.
    Head {
        /// The status code.
        status: u16,
        /// Header names and values.
        headers: Vec<(String, String)>,
        /// The response's URL.
        url: String,
    },
    /// Bytes of the body, in order.
    Data {
        /// The bytes.
        #[serde(with = "base64_bytes")]
        bytes: Vec<u8>,
    },
    /// The body is complete.
    End,
    /// The request failed.
    Failed {
        /// Why.
        message: String,
    },
}

/// What answers the requests of a test session's app (the test's routes):
/// `DevServer::set_test_network`.
pub trait TestNetwork: Send + Sync {
    /// Answers `request` through `reply`, an event at a time in order, from
    /// any thread ([`FetchReply::Pass`]: the host makes it itself). The
    /// function returned cancels it.
    fn fetch(
        &self,
        request: WireRequest,
        reply: Box<dyn FnMut(FetchReply) + Send>,
    ) -> Box<dyn FnOnce() + Send>;
}

/// Bytes as base64 text in JSON.
mod base64_bytes {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub(super) fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)
    }
}

/// Float fields, decoded whatever serde_json's features: as a number, or
/// as the map a serde_json with `arbitrary_precision` buffers a number with
/// a fraction as inside an internally tagged enum
/// (`{"$serde_json::private::Number": "390.5"}`). Encoding is serde's own:
/// a plain JSON number.
mod float {
    use std::fmt;

    use serde::{
        Deserialize, Deserializer,
        de::{self, MapAccess, Visitor},
    };

    /// The key of serde_json's buffered arbitrary-precision number.
    const NUMBER_TOKEN: &str = "$serde_json::private::Number";

    /// A number in either form.
    struct Float(f64);

    impl<'de> Deserialize<'de> for Float {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Float, D::Error> {
            // `deserialize_any`: a buffered map reaches the visitor only
            // this way (serde's `deserialize_f64` of buffered content
            // rejects anything but a number).
            d.deserialize_any(FloatVisitor)
        }
    }

    struct FloatVisitor;

    impl<'de> Visitor<'de> for FloatVisitor {
        type Value = Float;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a number")
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Float, E> {
            Ok(Float(v))
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Float, E> {
            Ok(Float(v as f64))
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Float, E> {
            Ok(Float(v as f64))
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Float, A::Error> {
            let key: Option<String> = map.next_key()?;
            if key.as_deref() != Some(NUMBER_TOKEN) {
                return Err(de::Error::invalid_type(de::Unexpected::Map, &self));
            }
            let text: String = map.next_value()?;
            let number = text
                .parse()
                .map_err(|_| de::Error::invalid_value(de::Unexpected::Str(&text), &self))?;
            if map.next_key::<de::IgnoredAny>()?.is_some() {
                return Err(de::Error::invalid_type(de::Unexpected::Map, &self));
            }
            Ok(Float(number))
        }
    }

    pub(super) fn f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        Float::deserialize(d).map(|f| f.0)
    }

    pub(super) fn f32<'de, D: Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
        Float::deserialize(d).map(|f| f.0 as f32)
    }

    pub(super) fn option_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        Option::<Float>::deserialize(d).map(|f| f.map(|f| f.0))
    }

    pub(super) fn option_f32x4<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<[f32; 4]>, D::Error> {
        Option::<[Float; 4]>::deserialize(d).map(|f| f.map(|f| f.map(|f| f.0 as f32)))
    }
}

/// What a step acts on, which decides the view a selector names
/// ([`SceneQuery::Pick`]).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PickTarget {
    /// A press: the view, or the nearest around it that hears presses.
    Pressable,
    /// A long press.
    LongPressable,
    /// An input.
    Input,
    /// A scroll view.
    ScrollView,
    /// The view itself (a drag lands on it).
    View,
}

/// How a [`TestStep`] ended.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StepOutcome {
    /// It was taken; `value` is what a query gives (`null` for actions).
    Done {
        /// The value.
        #[serde(default)]
        value: serde_json::Value,
    },
    /// It could not be taken, or the app threw meanwhile.
    Failed {
        /// Why, with what is on screen.
        message: String,
    },
}

/// Format of a bundle payload.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BundleFormat {
    /// QuickJS bytecode.
    Bytecode,
    /// UTF-8 JS source.
    Source,
}

/// Log severity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    /// Errors.
    Error,
    /// Warnings.
    Warn,
    /// Informational.
    Info,
    /// Debugging.
    Debug,
    /// Very verbose.
    Trace,
}

impl From<log::Level> for LogLevel {
    fn from(level: log::Level) -> Self {
        match level {
            log::Level::Error => LogLevel::Error,
            log::Level::Warn => LogLevel::Warn,
            log::Level::Info => LogLevel::Info,
            log::Level::Debug => LogLevel::Debug,
            log::Level::Trace => LogLevel::Trace,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_format_is_stable() {
        let msg = ServerMessage::Bundle {
            version: 3,
            format: BundleFormat::Bytecode,
            source_map: true,
            capabilities: None,
            app_id: None,
            limits: None,
        };
        // No declaration: the field is left out (older hosts read the same).
        assert_eq!(
            serde_json::to_string(&msg).unwrap(),
            r#"{"type":"bundle","version":3,"format":"bytecode","source_map":true}"#
        );
        let hello: ClientMessage = serde_json::from_str(
            r#"{"type":"hello","protocol":1,"bytecode_version":"x","device":"Mac"}"#,
        )
        .unwrap();
        // An older host says nothing of its platform or UI sets.
        assert!(matches!(
            hello,
            ClientMessage::Hello {
                protocol: 1,
                platform: None,
                ui_sets: None,
                ..
            }
        ));
        let hello: ClientMessage = serde_json::from_str(
            r#"{"type":"hello","protocol":2,"bytecode_version":"x","device":"Mac","platform":"vision","ui_sets":["app/native","app/charts"]}"#,
        )
        .unwrap();
        assert!(matches!(
            hello,
            ClientMessage::Hello {
                platform: Some(HostPlatform::Other),
                ui_sets: Some(sets),
                ..
            } if sets == ["app/native", "app/charts"]
        ));
    }

    /// The messages with float fields, each with fractions.
    fn messages_with_floats() -> Vec<ServerMessage> {
        let step = |step| ServerMessage::Step { id: 7, step };
        vec![
            ServerMessage::TestSetup {
                storage: vec![],
                trace: false,
                environment: TestEnvironment {
                    safe_area: Some([47.5, 0.0, 34.25, 0.1]),
                    clock: Some(1_761_475_200_000.5),
                    ..TestEnvironment::default()
                },
            },
            step(TestStep::Scroll {
                selector: "id:list".into(),
                distance: -120.5,
            }),
            step(TestStep::Drag {
                selector: "id:knob".into(),
                x: 12.25,
                y: -0.1,
            }),
            step(TestStep::SetViewport {
                width: 390.5,
                height: 844.0,
            }),
            step(TestStep::Clock {
                change: ClockChange::SetSystemTime {
                    unix_ms: 1_761_475_200_000.75,
                },
            }),
            step(TestStep::Scene {
                query: SceneQuery::SetViewport {
                    width: 1200.5,
                    height: 800.25,
                },
            }),
        ]
    }

    #[test]
    fn floats_round_trip() {
        for msg in messages_with_floats() {
            let text = serde_json::to_string(&msg).unwrap();
            let back: ServerMessage = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{text} does not decode: {e}"));
            assert_eq!(back, msg, "{text}");
        }
        // Encoded as plain numbers.
        let msg = ServerMessage::Step {
            id: 1,
            step: TestStep::SetViewport {
                width: 390.5,
                height: 844.0,
            },
        };
        assert_eq!(
            serde_json::to_string(&msg).unwrap(),
            r#"{"type":"step","id":1,"step":{"step":"set_viewport","width":390.5,"height":844.0}}"#
        );
    }

    /// A serde_json with `arbitrary_precision` (a host's, when feature
    /// unification turns it on) buffers a number with a fraction inside an
    /// internally tagged enum as this map: the fields take it too, whatever
    /// this build's serde_json.
    #[test]
    fn floats_decode_as_arbitrary_precision_buffers_them() {
        fn buffered(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Number(n) if !n.is_u64() && !n.is_i64() => {
                    *value = serde_json::json!({ "$serde_json::private::Number": n.to_string() });
                }
                serde_json::Value::Array(items) => items.iter_mut().for_each(buffered),
                serde_json::Value::Object(map) => map.values_mut().for_each(buffered),
                _ => {}
            }
        }
        for msg in messages_with_floats() {
            let mut value = serde_json::to_value(&msg).unwrap();
            buffered(&mut value);
            let text = value.to_string();
            assert!(text.contains("$serde_json::private::Number"), "{text}");
            let back: ServerMessage = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{text} does not decode: {e}"));
            assert_eq!(back, msg, "{text}");
        }
        // Another map is still no number.
        let odd =
            r#"{"type":"step","id":1,"step":{"step":"set_viewport","width":{"w":1},"height":2}}"#;
        assert!(serde_json::from_str::<ServerMessage>(odd).is_err());
    }
}
