//! Runs a test file: its tests on an engine of their own (the test file's
//! VM, serving `nsh/test`), one after the other, each app they open on a
//! headless engine of its own ([`Headless`]), closed when the test ends.
//!
//! The test file is bundled under an entry made for it, which imports it
//! (its `test` calls declare the tests) and then runs them
//! ([`run_tests`], through the internal module `nsh/test/runner`). What the
//! VM's calls need, the app's sets and how to build an entry, is the
//! [`Session`] of the file being run: one at a time in a process.

use std::{
    collections::HashMap,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    task::Poll,
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{
    ApproxTextEngine, MountBatch,
    geometry::{Points, Size},
    platform::{Idiom, Locale, Os},
    ui::{Callback, Registry, Root, prelude::timer},
};
use nsh_engine::{
    AppError, AppErrorKind, Bundle, Edges, Engine, EngineConfig, Environment, MountSink,
};

use crate::{
    MemoryStorage,
    driver::{Driver, Host, Remote},
    headless::{
        DirectoryAssets, Headless, RecordingNetwork, StubNetwork, UreqNetwork, WAIT, print_batch,
    },
    module::{Case, Hook, Item, Launch, Mode, NetworkSetup, Platform, SafeArea, Suite},
    page_host::PageHost,
};

/// Builds an entry ([`Entry`]; an app's may be its directory).
pub type Compile = Arc<dyn Fn(&Path, Entry) -> Result<Built, String> + Send + Sync>;

/// What [`Compile`] built.
#[derive(Clone)]
pub enum Built {
    /// A bundle: its bytecode (without its source map), and its source map.
    Js(Box<Bundle>, Option<String>),
    /// The root of an app of Rust only (`nsh.json` `"root"`): what `open`
    /// of the app starts.
    Rust(Root),
}

/// What an entry [`Compile`] builds is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Entry {
    /// An app's entry, which a test opens: built as `nsh run` builds it.
    App,
    /// The entry `nsh test` makes for a test file: built against the app's
    /// sets and [`test_sets`](crate::test_sets).
    TestFile,
}

/// Where batches are printed (`nsh test --trace`).
pub type Output = Arc<Mutex<Box<dyn Write + Send>>>;

/// How test files run: the app they test and what is shown of the run.
#[derive(Clone)]
pub struct TestRun {
    /// The UI sets the app's hosts serve (the mobile UI, the app's crates'):
    /// the apps tests open are built against them.
    pub ui_sets: Vec<Registry>,
    /// Builds the apps tests open and the entries made for test files
    /// ([`compiler`](crate::compiler) in this process).
    pub compile: Compile,
    /// Where the entries made for test files go (`<app>/.nsh/test`).
    pub work_dir: PathBuf,
    /// Runs only the tests whose name contains this.
    pub filter: Option<String>,
    /// Prints each batch of the apps the tests open, under the step it came
    /// in, and logs their commits' timings.
    pub trace: Option<Output>,
    /// Opens the apps on a real platform's host instead of a headless
    /// engine (`nsh test --target`).
    pub host: Option<StartHost>,
    /// The web page's host module (`nsh.json` `web.host`, exporting
    /// `createHost(player)`): each app opened headless gets one of its own,
    /// which answers its `nsh/host` calls and sends its events, and
    /// `host.available()` is true. `None`: the apps have no host.
    pub page_host: Option<PathBuf>,
}

/// Starts the app whose entry is the path on a real platform's host, as
/// [`HostOptions`] say, once it connected (`nsh test --target`): what takes
/// the test's steps.
pub type StartHost =
    Arc<dyn Fn(&Path, &HostOptions) -> Result<Box<dyn Host>, String> + Send + Sync>;

/// How [`StartHost`] starts an app.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct HostOptions {
    /// The window's (viewport's) size in points: the headless phone's,
    /// 390 × 844, unless `open` says.
    pub size: Option<Size<Points>>,
    /// The storage the app starts with, in place of its own
    /// (`nsh_dev::DevServer::set_test_storage`).
    pub storage: Vec<(String, String)>,
    /// What answers the app's requests (`nsh_dev::DevServer::set_test_network`):
    /// the test's routes, the network itself, or none.
    pub network: Option<Arc<dyn nsh_dev::protocol::TestNetwork>>,
    /// What the test fixes of the app's environment, and its clipboard
    /// (`nsh_dev::DevServer::set_test_environment`).
    pub environment: nsh_dev::protocol::TestEnvironment,
    /// Traces the app (`nsh test --trace`, `nsh_dev::DevServer::set_test_trace`):
    /// what prints the items of each batch it applied, a line each
    /// (`nsh_dev::ClientEvent::Trace`), under the step it came in.
    pub trace: Option<Arc<dyn Fn(Vec<String>) + Send + Sync>>,
}

impl std::fmt::Debug for HostOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostOptions")
            .field("size", &self.size)
            .field("storage", &self.storage)
            .field("network", &self.network.is_some())
            .field("environment", &self.environment)
            .field("trace", &self.trace.is_some())
            .finish()
    }
}

/// The test's side of a host's app's requests: they are kept (`requests()`),
/// then answered from the routes, failed, or let through to the host's own
/// network (`network: "live"`).
struct HostRoutes {
    requests: Arc<RecordingNetwork>,
    /// Let through: the host's network makes them.
    live: bool,
}

impl nsh_dev::protocol::TestNetwork for HostRoutes {
    fn fetch(
        &self,
        request: nsh_dev::protocol::WireRequest,
        mut reply: Box<dyn FnMut(nsh_dev::protocol::FetchReply) + Send>,
    ) -> Box<dyn FnOnce() + Send> {
        use nsh_dev::protocol::FetchReply;
        use nsh_engine::{FetchEvent, HttpBody, HttpRequest, Network as _};
        let request = HttpRequest {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: if request.body.is_empty() {
                HttpBody::Empty
            } else {
                HttpBody::Bytes(request.body)
            },
            follow_redirects: request.follow_redirects,
        };
        if self.live {
            self.requests.record(request);
            reply(FetchReply::Pass);
            return Box::new(|| {});
        }
        let task = self.requests.fetch(
            request,
            Box::new(move |event| match event {
                FetchEvent::Head(head) => reply(FetchReply::Head {
                    status: head.status,
                    headers: head.headers,
                    url: head.url,
                }),
                FetchEvent::Data(bytes) => reply(FetchReply::Data { bytes }),
                FetchEvent::End => reply(FetchReply::End),
                FetchEvent::Failed(message) => reply(FetchReply::Failed { message }),
                FetchEvent::BodyWanted => {}
            }),
        );
        Box::new(move || task.cancel())
    }
}

/// How a test ended.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[non_exhaustive]
pub struct TestResult {
    /// Its name, after the `describe` blocks it is in (`Cart › adds`).
    pub name: String,
    /// How long it took.
    pub elapsed: Duration,
    /// Whether it ran and passed.
    pub status: TestStatus,
    /// Why it failed (`None` unless its status is
    /// [`TestStatus::Failed`]).
    pub failure: Option<Failure>,
}

impl TestResult {
    /// The result of a test that ran elsewhere (`cargo test`'s, which
    /// `nsh test` reports with the app's TypeScript tests).
    pub fn new(
        name: impl Into<String>,
        elapsed: Duration,
        status: TestStatus,
        failure: Option<Failure>,
    ) -> TestResult {
        TestResult {
            name: name.into(),
            elapsed,
            status,
            failure,
        }
    }
}

/// Whether a test ran and passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TestStatus {
    /// It ran and passed.
    Passed,
    /// It ran and failed, or a hook it needed did.
    Failed,
    /// It did not run: `.skip`, or another test of the file is `.only`.
    Skipped,
    /// A test still to write (`test.todo`).
    Todo,
}

/// Why a test failed.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Failure {
    /// What was thrown.
    pub message: String,
    /// Where (the test file's positions), when an `Error` was thrown.
    pub stack: Option<String>,
    /// The texts on screen of the app it opened last, when it opened one.
    pub screen: Option<Vec<String>>,
}

/// Runs the tests of the test file `file` as `run` says, calling `report`
/// with each one's result as it ends: their results, or why the file could
/// not run (it does not build, it throws as it loads).
pub fn run_file(
    run: &TestRun,
    file: &Path,
    report: &mut dyn FnMut(&TestResult),
) -> Result<Vec<TestResult>, String> {
    // One test file at a time in a process: the VM's calls find its session.
    static RUNNING: Mutex<()> = Mutex::new(());
    let _running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let file = dunce::canonicalize(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let (bundle, source_map) = compile_test_file(run, &file)?;
    let (events, results) = crossbeam_channel::unbounded();
    let session = Arc::new(Session {
        dir: file.parent().unwrap_or(Path::new(".")).to_path_buf(),
        run: run.clone(),
        built: Mutex::new(HashMap::new()),
        apps: Mutex::new(Vec::new()),
        events: events.clone(),
    });
    *current() = Some(session.clone());
    let ended = drive(
        run,
        bundle,
        &events,
        &results,
        source_map.as_deref(),
        report,
    );
    *current() = None;
    session.close_apps(0);
    ended
}

/// Starts the test file's VM and collects what it reports until its tests
/// ended.
fn drive(
    run: &TestRun,
    bundle: Bundle,
    events: &Sender<Event>,
    results: &Receiver<Event>,
    source_map: Option<&str>,
    report: &mut dyn FnMut(&TestResult),
) -> Result<Vec<TestResult>, String> {
    let mut ui_sets = run.ui_sets.clone();
    ui_sets.extend(crate::test_sets());
    let config = EngineConfig {
        // The sets' fonts load as the engine starts.
        assets: Some(Arc::new(DirectoryAssets::new(
            run.work_dir.clone(),
            set_files(&ui_sets),
        ))),
        ui_sets,
        ..EngineConfig::new(bundle)
    };
    let sink = VmSink {
        events: events.clone(),
    };
    let _vm = Engine::start(config, || ApproxTextEngine, sink)
        .map_err(|e| format!("the test file's engine did not start: {e}"))?;
    let mut out = Vec::new();
    loop {
        match results.recv() {
            Ok(Event::Result(mut result)) => {
                if let (Some(failure), Some(map)) = (&mut result.failure, source_map) {
                    failure.stack = failure
                        .stack
                        .take()
                        .map(|stack| nsh_engine::symbolicate(map, &stack));
                }
                report(&result);
                out.push(result);
            }
            Ok(Event::Done) => return Ok(out),
            Ok(Event::Error(error)) => match error.kind {
                AppErrorKind::Load | AppErrorKind::Stopped => return Err(error.to_string()),
                _ => log::error!(target: "js", "{error}"),
            },
            Err(_) => return Err("the test file's engine stopped".into()),
        }
    }
}

/// The test file bundled under the entry made for it, and compiled: the
/// VM's app and its source map.
fn compile_test_file(run: &TestRun, file: &Path) -> Result<(Bundle, Option<String>), String> {
    let name = file
        .file_name()
        .map_or("test".into(), |n| n.to_string_lossy().into_owned());
    std::fs::create_dir_all(&run.work_dir)
        .map_err(|e| format!("{}: {e}", run.work_dir.display()))?;
    let entry = run.work_dir.join(format!("{name}.run.js"));
    let path = serde_json::to_string(&file.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())?;
    let code = format!(
        "// Made by `nsh test`: runs the tests of {name}.\nimport {path};\nimport {{ run }} from \"{}\";\nrun();\n",
        crate::module::RUNNER
    );
    std::fs::write(&entry, code).map_err(|e| format!("{}: {e}", entry.display()))?;
    let Built::Js(bundle, map) = (run.compile)(&entry, Entry::TestFile)? else {
        return Err(format!("{}: built as a Rust root", entry.display()));
    };
    let map = map.map(|map| readable_sources(&map, &run.work_dir));
    let bundle = match &map {
        Some(map) => bundle.with_source_map(map.clone()),
        None => *bundle,
    };
    Ok((bundle, map))
}

/// The source map `map` (of a bundle made in `dir`) with its sources
/// relative to the current directory, as a terminal shows paths (else
/// absolute): stacks name the test file as its author knows it.
fn readable_sources(map: &str, dir: &Path) -> String {
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(map) else {
        return map.to_owned();
    };
    let cwd = std::env::current_dir().ok();
    if let Some(sources) = json.get_mut("sources").and_then(|s| s.as_array_mut()) {
        for source in sources {
            let Some(path) = source.as_str() else {
                continue;
            };
            let joined = dir.join(path);
            let path = dunce::canonicalize(&joined).unwrap_or(joined);
            let shown = cwd
                .as_deref()
                .and_then(|cwd| path.strip_prefix(cwd).ok())
                .unwrap_or(&path);
            *source = shown.to_string_lossy().replace('\\', "/").into();
        }
    }
    json.to_string()
}

/// The files `sets` ship, by their path among an app's assets.
fn set_files(sets: &[Registry]) -> Vec<(String, PathBuf)> {
    sets.iter()
        .flat_map(Registry::asset_files)
        .map(|file| (file.path().to_owned(), PathBuf::from(file.source)))
        .collect()
}

/// What the test file's VM reports.
enum Event {
    /// A test ended.
    Result(TestResult),
    /// Every test ended.
    Done,
    /// The VM's error: the test file failed to load, a callback threw.
    Error(AppError),
}

/// The test file's VM renders nothing; its errors are the run's.
struct VmSink {
    events: Sender<Event>,
}

impl MountSink for VmSink {
    fn submit(&self, _batch: MountBatch) {}

    fn report(&self, error: &AppError) {
        let _ = self.events.send(Event::Error(error.clone()));
    }
}

/// An app a test opened: closed (`None`) when the test ends.
pub(crate) type OpenApp = Arc<Mutex<Option<Box<dyn Driver>>>>;

/// What `open` gives the test's `App`: the app, and on a headless engine
/// its storage and the requests it made.
pub(crate) type Opened = (
    OpenApp,
    Option<Arc<MemoryStorage>>,
    Option<Arc<RecordingNetwork>>,
);

/// The test file being run, for its VM's calls.
pub(crate) struct Session {
    /// The test file's directory: `open`'s entries are relative to it.
    dir: PathBuf,
    run: TestRun,
    /// The apps built so far, by entry.
    built: Mutex<HashMap<PathBuf, Built>>,
    /// The apps the running test opened, in order.
    apps: Mutex<Vec<OpenApp>>,
    events: Sender<Event>,
}

fn current() -> MutexGuard<'static, Option<Arc<Session>>> {
    static CURRENT: Mutex<Option<Arc<Session>>> = Mutex::new(None);
    CURRENT.lock().unwrap_or_else(|e| e.into_inner())
}

impl Session {
    /// The test file being run.
    pub(crate) fn current() -> Result<Arc<Session>, String> {
        current()
            .clone()
            .ok_or_else(|| "nsh/test runs in `nsh test` only".to_owned())
    }

    /// Starts the app at `entry` as `options` say, once it rendered.
    pub(crate) fn open(&self, entry: &str, launch: Launch) -> Result<Opened, String> {
        let path = self.dir.join(entry);
        let path = dunce::canonicalize(&path).map_err(|e| format!("open({entry:?}): {e}"))?;
        if let Some(start) = &self.run.host {
            return self.open_on_host(entry, &path, launch, start);
        }
        let app = match self.build(&path)? {
            Built::Js(bundle, Some(map)) => nsh_engine::App::Js(bundle.with_source_map(map)),
            Built::Js(bundle, None) => nsh_engine::App::Js(*bundle),
            Built::Rust(root) => nsh_engine::App::Rust(root),
        };
        let clock = launch
            .clock
            .map_or_else(nsh_engine::Clock::system, nsh_engine::Clock::manual);
        let inner: Arc<dyn nsh_engine::Network> = match launch.network {
            NetworkSetup::Live => Arc::new(UreqNetwork::new()),
            NetworkSetup::Stub(routes) => {
                Arc::new(StubNetwork::new(routes).with_clock(clock.clone()))
            }
            NetworkSetup::None => Arc::new(StubNetwork::default()),
        };
        let requests = RecordingNetwork::new(inner);
        let locale = match &launch.locale {
            Some(tag) => Some(
                Locale::parse(tag)
                    .ok_or_else(|| format!("open({entry:?}): {tag:?} is not a locale"))?,
            ),
            None => None,
        };
        let storage = MemoryStorage::new(launch.storage.0);
        let files = set_files(&self.run.ui_sets);
        let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let safe_area = launch.safe_area;
        // Loaded before the app starts, as the page's host is: what it
        // sends meanwhile waits for the app.
        let page_host = match &self.run.page_host {
            Some(module) => Some(
                PageHost::start(module, clock.clone())
                    .map_err(|e| format!("open({entry:?}): {e}"))?,
            ),
            None => None,
        };
        let default = EngineConfig::new(app);
        let config = EngineConfig {
            viewport: nsh_core::Size::new(
                launch.width.unwrap_or(default.viewport.width),
                launch.height.unwrap_or(default.viewport.height),
            ),
            trace: self.run.trace.is_some(),
            network: Some(requests.clone()),
            assets: Some(Arc::new(DirectoryAssets::new(dir, files))),
            storage: Some(storage.clone()),
            environment: Environment {
                safe_area: Edges {
                    top: safe_area.top,
                    right: safe_area.right,
                    bottom: safe_area.bottom,
                    left: safe_area.left,
                },
                color_scheme: launch.color_scheme.into(),
                locale: locale.unwrap_or(Locale::EN_US),
                reduce_motion: launch.reduced_motion,
                os: match launch.platform {
                    Platform::Ios => Os::Ios,
                    Platform::Android => Os::Android,
                    Platform::Macos => Os::MacOs,
                    Platform::Windows => Os::Windows,
                    Platform::Linux => Os::Linux,
                    Platform::Web => Os::Web,
                },
                idiom: match launch.platform {
                    Platform::Ios | Platform::Android => Idiom::default(),
                    _ => Idiom::Desktop,
                },
                host: page_host.is_some(),
                ..Default::default()
            },
            ui_sets: self.run.ui_sets.clone(),
            clock,
            host: launch.host,
            ..default
        };
        let mut app = Headless::start(config)
            .map_err(|e| format!("open({entry:?}): the engine did not start: {e}"))?;
        if let Some(host) = page_host {
            host.attach(app.engine().control());
            app.on_host_call(move |id, name, args| host.call(id, name, args));
        }
        if let Some(out) = &self.run.trace {
            let out = out.clone();
            app.observe(move |step, batch| {
                let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
                print_batch(&mut **out, step, batch);
            });
        }
        // The entry as a terminal shows paths.
        let shown = std::env::current_dir()
            .ok()
            .and_then(|cwd| path.strip_prefix(cwd).ok().map(Path::to_path_buf))
            .unwrap_or_else(|| path.clone());
        // `App` answers dialogs after each step, with the test's handler.
        app.answer_dialogs_myself();
        app.answer_picks_myself();
        app.set_clipboard(launch.clipboard);
        app.step(format!("open({})", shown.display()));
        app.first_render()?;
        let app: OpenApp = Arc::new(Mutex::new(Some(Box::new(app))));
        self.apps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(app.clone());
        Ok((app, Some(storage), Some(requests)))
    }

    /// Starts the app at `path` (`entry` as the test names it) on a real
    /// platform's host ([`TestRun::host`]), once it rendered.
    fn open_on_host(
        &self,
        entry: &str,
        path: &Path,
        launch: Launch,
        start: &StartHost,
    ) -> Result<Opened, String> {
        // What the test fixes of the environment, whatever the platform
        // reports, and its clipboard (the app's calls never reach the
        // machine's).
        if let Some(tag) = &launch.locale
            && Locale::parse(tag).is_none()
        {
            return Err(format!("open({entry:?}): {tag:?} is not a locale"));
        }
        // The host's dev host plays no handlers of the test's: they run
        // headless only. The launch parameters reach its engine.
        if launch.host_handlers {
            return Err(format!(
                "open({entry:?}): {}",
                crate::driver::headless_only("`host.handlers`")
            ));
        }
        let safe_area = launch.safe_area;
        let mut environment = nsh_dev::protocol::TestEnvironment::default();
        let params = launch.host.params();
        environment.host_params = (!params.is_empty()).then_some(params);
        environment.clipboard = launch.clipboard.clone();
        environment.locale = launch.locale.clone();
        environment.reduced_motion = launch.reduced_motion.then_some(true);
        environment.safe_area = (safe_area != SafeArea::default()).then_some([
            safe_area.top.0,
            safe_area.right.0,
            safe_area.bottom.0,
            safe_area.left.0,
        ]);
        // A manual clock: the host's engine runs on one, which the test
        // moves (and the display's frames, as headless).
        environment.clock =
            launch
                .clock
                .map(|start| match start.duration_since(std::time::UNIX_EPOCH) {
                    Ok(since) => since.as_secs_f64() * 1000.0,
                    Err(before) => -before.duration().as_secs_f64() * 1000.0,
                });
        let manual_clock = environment.clock.is_some();
        // The app's requests come to the test, as on a headless engine:
        // answered from the routes, failed without any, or let through.
        let (inner, live): (Arc<dyn nsh_engine::Network>, bool) = match launch.network {
            NetworkSetup::Live => (Arc::new(StubNetwork::default()), true),
            NetworkSetup::Stub(routes) => (Arc::new(StubNetwork::new(routes)), false),
            NetworkSetup::None => (Arc::new(StubNetwork::default()), false),
        };
        let requests = RecordingNetwork::new(inner);
        let storage: Vec<(String, String)> = launch.storage.0.into_iter().collect();
        let size = match (launch.width, launch.height) {
            (None, None) => None,
            (w, h) => Some(Size::new(
                w.unwrap_or(Points(390.0)),
                h.unwrap_or(Points(844.0)),
            )),
        };
        // The step a traced app's batches print under, as headless runs
        // name them.
        let shown = std::env::current_dir()
            .ok()
            .and_then(|cwd| path.strip_prefix(cwd).ok().map(Path::to_path_buf))
            .unwrap_or_else(|| path.to_path_buf());
        let step = Arc::new(Mutex::new(format!("open({})", shown.display())));
        let trace = self.run.trace.clone().map(|out| {
            let step = step.clone();
            Arc::new(move |items: Vec<String>| {
                let step = step.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
                crate::trace::print_items(&mut **out, &step, &items);
            }) as Arc<dyn Fn(Vec<String>) + Send + Sync>
        });
        let options = HostOptions {
            size: size.or(Some(Size::new(Points(390.0), Points(844.0)))),
            storage,
            network: Some(Arc::new(HostRoutes {
                requests: requests.clone(),
                live,
            })),
            environment,
            trace,
        };
        let host = start(path, &options).map_err(|e| format!("open({entry:?}): {e}"))?;
        let remote = Remote::new(host, step, manual_clock);
        remote.take(nsh_dev::protocol::TestStep::Ready {
            timeout_ms: WAIT.as_millis() as u64 * 2,
        })?;
        if launch.color_scheme == crate::module::ColorScheme::Dark {
            remote.take(nsh_dev::protocol::TestStep::SetColorScheme { dark: true })?;
        }
        let app: OpenApp = Arc::new(Mutex::new(Some(Box::new(remote))));
        self.apps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(app.clone());
        Ok((app, None, Some(requests)))
    }

    /// The app at `path`, built once.
    fn build(&self, path: &Path) -> Result<Built, String> {
        if let Some(built) = self
            .built
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(path)
        {
            return Ok(built.clone());
        }
        let built = (self.run.compile)(path, Entry::App)?;
        self.built
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf(), built.clone());
        Ok(built)
    }

    /// Closes the apps the test opened: the texts on screen of the last.
    /// How many apps are open: a mark for [`Self::close_apps_since`].
    fn open_apps(&self) -> usize {
        self.apps.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Closes the apps opened since `mark`, and returns the texts on
    /// screen of the newest app open before (a failure's screen, which
    /// may be an app a `beforeAll` opened).
    async fn close_apps_since(self: &Arc<Self>, mark: usize) -> Option<Vec<String>> {
        let session = self.clone();
        nsh_core::ui::prelude::blocking(move || session.close_apps(mark))
            .await
            .ok()
            .flatten()
    }

    /// [`Self::close_apps_since`], on this thread.
    fn close_apps(&self, mark: usize) -> Option<Vec<String>> {
        let mut apps = self.apps.lock().unwrap_or_else(|e| e.into_inner());
        let screen = apps.iter().rev().find_map(|app| {
            let mut app = app.lock().unwrap_or_else(|e| e.into_inner());
            app.as_mut()?.texts().ok()
        });
        let mark = mark.min(apps.len());
        for app in apps.drain(mark..) {
            drop(app.lock().unwrap_or_else(|e| e.into_inner()).take());
        }
        screen
    }

    fn wants(&self, name: &str) -> bool {
        self.run.filter.as_deref().is_none_or(|f| name.contains(f))
    }
}

/// Runs the tests the test file declared, in order, reporting each (the
/// internal module's `run`, on the VM's thread).
pub(crate) async fn run_tests() {
    let Ok(session) = Session::current() else {
        return;
    };
    let suite = crate::module::take_suite();
    let run = Run {
        only: suite.has_only(),
        session,
    };
    run.suite(&suite, &Context::default()).await;
    let _ = run.session.events.send(Event::Done);
}

/// A run of a test file's suite.
struct Run {
    session: Arc<Session>,
    /// A test or a block of the file is `.only`.
    only: bool,
}

/// Where a suite is: the blocks around it.
#[derive(Clone, Default)]
struct Context<'a> {
    /// Their names, outermost first.
    names: Vec<&'a str>,
    /// Their `beforeEach` and `afterEach` hooks, outermost first.
    hooks: Vec<(&'a [Hook], &'a [Hook])>,
    /// One of them is `.skip`.
    skipped: bool,
    /// One of them is `.only`.
    focused: bool,
}

impl Context<'_> {
    /// The full name of `name` in it (`Cart › adds`).
    fn name(&self, name: &str) -> String {
        let mut names = self.names.clone();
        names.push(name);
        names.retain(|n| !n.is_empty());
        names.join(" › ")
    }
}

impl Suite {
    /// It or what it holds is `.only`.
    fn has_only(&self) -> bool {
        self.items.iter().any(|item| match item {
            Item::Test(case) => case.mode == Mode::Only,
            Item::Suite(suite) => suite.mode == Mode::Only || suite.has_only(),
        })
    }
}

impl Run {
    /// Whether `case` runs where `cx` is.
    fn runs(&self, case: &Case, cx: &Context<'_>) -> bool {
        !cx.skipped
            && matches!(case.mode, Mode::Run | Mode::Only)
            && (!self.only || cx.focused || case.mode == Mode::Only)
            && self.session.wants(&cx.name(&case.name))
    }

    /// Whether a test of `suite` runs where `cx` is.
    fn any_runs(&self, suite: &Suite, cx: &Context<'_>) -> bool {
        let cx = cx.inside(suite);
        suite.items.iter().any(|item| match item {
            Item::Test(case) => self.runs(case, &cx),
            Item::Suite(inner) => self.any_runs(inner, &cx),
        })
    }

    /// Runs `suite` where `cx` is: its `beforeAll` hooks, its tests and
    /// blocks in order, then its `afterAll` hooks, when any of its tests
    /// runs.
    fn suite<'a>(
        &'a self,
        suite: &'a Suite,
        cx: &'a Context<'a>,
    ) -> std::pin::Pin<Box<dyn Future<Output = ()> + 'a>> {
        Box::pin(async move {
            let inner = cx.inside(suite);
            let runs = self.any_runs(suite, cx);
            let mark = self.session.open_apps();
            // A `beforeAll` that failed fails the tests that needed it.
            let mut setup = None;
            if runs {
                for hook in &suite.before_all {
                    if let Err(failure) = self.hook("beforeAll", hook).await {
                        setup = Some(failure);
                        break;
                    }
                }
            }
            for item in &suite.items {
                match item {
                    Item::Suite(child) => match &setup {
                        // Its tests fail as this block's do.
                        Some(failure) => self.fail_all(child, &inner, failure),
                        None => self.suite(child, &inner).await,
                    },
                    Item::Test(case) => {
                        let name = inner.name(&case.name);
                        if self.runs(case, &inner) {
                            match &setup {
                                Some(failure) => {
                                    self.report(name, Duration::ZERO, Err(failure.clone()))
                                }
                                None => self.case(case, name, &inner).await,
                            }
                        } else if case.mode == Mode::Todo && self.session.wants(&name) {
                            self.skip(name, TestStatus::Todo);
                        } else if self.session.wants(&name) {
                            self.skip(name, TestStatus::Skipped);
                        }
                    }
                }
            }
            if runs {
                let start = Instant::now();
                let mut failed = None;
                for hook in &suite.after_all {
                    if let Err(failure) = self.hook("afterAll", hook).await {
                        failed.get_or_insert(failure);
                    }
                }
                let screen = self.session.close_apps_since(mark).await;
                if let Some(mut failure) = failed {
                    failure.screen = failure.screen.or(screen);
                    self.report(
                        cx.name(&suite.name_or("afterAll")),
                        start.elapsed(),
                        Err(failure),
                    );
                }
            } else {
                self.session.close_apps_since(mark).await;
            }
        })
    }

    /// Reports every test of `suite` that would run as failed with
    /// `failure` (a `beforeAll` around it failed).
    fn fail_all(&self, suite: &Suite, cx: &Context<'_>, failure: &Failure) {
        let cx = cx.inside(suite);
        for item in &suite.items {
            match item {
                Item::Test(case) if self.runs(case, &cx) => {
                    self.report(cx.name(&case.name), Duration::ZERO, Err(failure.clone()));
                }
                Item::Test(_) => {}
                Item::Suite(inner) => self.fail_all(inner, &cx, failure),
            }
        }
    }

    /// Runs `case` (named `name`) with the `beforeEach` and `afterEach`
    /// hooks around it, then closes the apps they opened.
    async fn case(&self, case: &Case, name: String, cx: &Context<'_>) {
        let start = Instant::now();
        let mark = self.session.open_apps();
        let mut failed = None;
        'before: for (before, _) in &cx.hooks {
            for hook in *before {
                if let Err(failure) = self.hook("beforeEach", hook).await {
                    failed = Some(failure);
                    break 'before;
                }
            }
        }
        if failed.is_none()
            && let Some(body) = &case.body
        {
            failed = run(body, case.timeout, "the test").await.err();
        }
        for (_, after) in cx.hooks.iter().rev() {
            for hook in *after {
                if let Err(failure) = self.hook("afterEach", hook).await {
                    failed.get_or_insert(failure);
                }
            }
        }
        // The apps go before the next test starts, whatever this one left
        // running.
        let screen = self.session.close_apps_since(mark).await;
        let outcome = match failed {
            None => Ok(()),
            Some(mut failure) => {
                failure.screen = failure.screen.or(screen);
                Err(failure)
            }
        };
        self.report(name, start.elapsed(), outcome);
    }

    /// Runs `hook`, a `what` hook.
    async fn hook(&self, what: &str, hook: &Hook) -> Result<(), Failure> {
        run(&hook.body, hook.timeout, what)
            .await
            .map_err(|mut failure| {
                failure.message = format!("{what}: {}", failure.message);
                failure
            })
    }

    fn report(&self, name: String, elapsed: Duration, outcome: Result<(), Failure>) {
        let (status, failure) = match outcome {
            Ok(()) => (TestStatus::Passed, None),
            Err(failure) => (TestStatus::Failed, Some(failure)),
        };
        let _ = self.session.events.send(Event::Result(TestResult {
            name,
            elapsed,
            status,
            failure,
        }));
    }

    fn skip(&self, name: String, status: TestStatus) {
        let _ = self.session.events.send(Event::Result(TestResult {
            name,
            elapsed: Duration::ZERO,
            status,
            failure: None,
        }));
    }
}

impl<'a> Context<'a> {
    /// The context of what `suite` holds.
    fn inside(&self, suite: &'a Suite) -> Context<'a> {
        let mut cx = self.clone();
        cx.names.push(&suite.name);
        cx.hooks.push((&suite.before_each, &suite.after_each));
        cx.skipped |= suite.mode == Mode::Skip;
        cx.focused |= suite.mode == Mode::Only;
        cx
    }
}

impl Suite {
    /// `"<name> › <what>"`, or `what` for the file's.
    fn name_or(&self, what: &str) -> String {
        if self.name.is_empty() {
            what.to_owned()
        } else {
            format!("{} › {what}", self.name)
        }
    }
}

/// Calls `body`, `what` (the test, a hook), bounded by `timeout`; the
/// screen of the failure is the caller's.
async fn run(body: &Callback, timeout: Duration, what: &str) -> Result<(), Failure> {
    match within(timeout, body.call_async_traced(())).await {
        Some(Ok(())) => Ok(()),
        Some(Err(thrown)) => Err(Failure {
            message: thrown.message,
            stack: thrown.stack,
            screen: None,
        }),
        None => Err(Failure {
            message: format!("{what} did not end in {}", shown_duration(timeout)),
            stack: None,
            screen: None,
        }),
    }
}

/// `time` as a timeout is given: `30 s`, `250 ms`.
fn shown_duration(time: Duration) -> String {
    let ms = time.as_millis();
    if ms.is_multiple_of(1000) {
        format!("{} s", ms / 1000)
    } else {
        format!("{ms} ms")
    }
}

/// `future`'s output, or `None` once `time` passed.
async fn within<T>(time: Duration, future: impl Future<Output = T>) -> Option<T> {
    let mut future = std::pin::pin!(future);
    let mut delay = std::pin::pin!(timer(time));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(value) = future.as_mut().poll(cx) {
            return Poll::Ready(Some(value));
        }
        if delay.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}
