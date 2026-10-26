//! `process`: desktop subprocesses owned by one VM, and the VM's process
//! metadata (`platform`, `arch`, `env`, `dataDir`, `exit`). `nsh-js` makes
//! the module's default object the global `process` and adds `nextTick`
//! (a JS job).
//!
//! A child runs under a supervisor thread with a reader per pipe and a
//! writer for stdin; they never touch the VM. Output goes through a channel
//! to a task of the core, which posts it to the app's listeners, or, for
//! `run`, captures it. The VM's children are a [`Local`]: when the VM goes,
//! every child is killed at once and the supervisors are joined together.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};

use crate::element::{
    CallCx, Callback, Instance, JsError, JsObject, JsValue, Later, Local, PropEnum, PropError,
    System, TsTypes, class, module,
};

/// Subprocesses owned by this app's VM, and its process metadata.
#[module]
pub(crate) struct Process;

#[module(flat, default)]
impl Process {
    /// The native operating system's name, as Rust's `std::env::consts::OS`
    /// and gpui-shell's say it: `"macos"`, `"windows"`, `"linux"`, `"ios"`,
    /// `"android"` (not Node's `"darwin"` / `"win32"`).
    #[allow(non_upper_case_globals)]
    pub(crate) const platform: &'static str = std::env::consts::OS;
    /// The native CPU architecture's name, as Rust's
    /// `std::env::consts::ARCH` and gpui-shell's say it: `"aarch64"`,
    /// `"x86_64"` (not Node's `"arm64"` / `"x64"`).
    #[allow(non_upper_case_globals)]
    pub(crate) const arch: &'static str = std::env::consts::ARCH;

    /// Runs `command` (granted by capabilities.process.execute; no shell)
    /// and captures up to 8 MiB per stream, with a default 30-second
    /// deadline. A child's environment is PATH, HOME, USERPROFILE,
    /// SystemRoot, TEMP, TMP, TMPDIR, LANG and LC_* from the host, plus the
    /// names capabilities.process.env grants; never the whole host
    /// environment. A refused command or option throws; a launch failure,
    /// a timeout and output past the limit reject.
    pub(crate) fn run(
        command: String,
        args: Option<Vec<String>>,
        options: Option<RunOptions>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<Later<CommandOutput>, JsError> {
        let options = options.unwrap_or_default();
        let launch = native::Launch::new(
            &sys,
            command,
            args.unwrap_or_default(),
            options.cwd,
            timeout(options.timeout_ms)?.or(Some(RUN_TIMEOUT)),
        )?;
        #[cfg(not(target_arch = "wasm32"))]
        return Ok(native::run(&sys, launch, cx));
        #[cfg(target_arch = "wasm32")]
        {
            let _ = (launch, cx);
            Err(JsError::Type(UNAVAILABLE.into()))
        }
    }

    /// Starts `command` as `run` does and streams its decoded UTF-8 output,
    /// or complete lines with `lines: true`; stdin is closed unless
    /// `stdin: "pipe"`. Listeners get the event's payload only (gpui-shell's
    /// also get a context).
    pub(crate) fn spawn(
        command: String,
        args: Option<Vec<String>>,
        options: Option<SpawnOptions>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<ChildProcess, JsError> {
        let options = options.unwrap_or_default();
        let launch = native::Launch::new(
            &sys,
            command,
            args.unwrap_or_default(),
            options.cwd,
            timeout(options.timeout_ms)?,
        )?;
        #[cfg(not(target_arch = "wasm32"))]
        return native::spawn(
            &sys,
            launch,
            options.stdin == Some(Stdin::Pipe),
            options.lines.unwrap_or(false),
            cx,
        );
        #[cfg(target_arch = "wasm32")]
        {
            let _ = (launch, cx);
            Err(JsError::Type(UNAVAILABLE.into()))
        }
    }

    /// Asks the host to exit (capabilities.process.exit); never exits the
    /// host process directly.
    pub(crate) fn exit(code: Option<i32>, sys: System) -> Result<(), JsError> {
        if !sys.access.allows_exit() {
            return Err(JsError::Type(
                "process.exit() is not granted; set capabilities.process.exit to true in the \
                 manifest"
                    .into(),
            ));
        }
        let handler = sys.exit.ok_or_else(|| {
            JsError::Error(
                "process.exit() is granted but this host installed no exit request handler".into(),
            )
        })?;
        handler(code.unwrap_or(0));
        Ok(())
    }

    /// The environment variables the app may read: the default metadata
    /// names and those capabilities.process.env grants; a new object each
    /// time.
    #[getter]
    pub(crate) fn env(sys: System) -> BTreeMap<String, String> {
        #[cfg(target_arch = "wasm32")]
        {
            let _ = sys;
            BTreeMap::new()
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            std::env::vars_os()
                .filter_map(|(name, value)| {
                    Some((name.into_string().ok()?, value.into_string().ok()?))
                })
                .filter(|(name, _)| sys.access.allows_env(name))
                .collect()
        }
    }

    /// The app's own data directory, `null` when the host has none.
    #[getter]
    pub(crate) fn data_dir(sys: System) -> Option<String> {
        sys.data_dir.map(|dir| dir.to_string_lossy().into_owned())
    }
}

/// Options of `run`.
#[derive(Debug, Clone, Default, JsObject)]
pub(crate) struct RunOptions {
    /// An existing directory within a capabilities.fs.write root (the child
    /// may write there); defaults to the app's data directory, created when
    /// missing.
    cwd: Option<String>,
    /// Kills the process tree after this many milliseconds; `run` defaults
    /// to 30 seconds.
    timeout_ms: Option<f64>,
}

/// Options of `spawn`.
#[derive(Debug, Clone, Default, JsObject)]
pub(crate) struct SpawnOptions {
    /// As `run`'s.
    cwd: Option<String>,
    /// As `run`'s; a spawned child has no deadline by default.
    timeout_ms: Option<f64>,
    /// `"pipe"` lets `write` and `end` feed stdin; it is closed otherwise.
    stdin: Option<Stdin>,
    /// Delivers complete lines (without `\n` or `\r\n`) instead of chunks.
    lines: Option<bool>,
}

/// A child's stdin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum Stdin {
    /// Written by `write`, closed by `end`.
    Pipe,
    /// Closed at once.
    #[default]
    Null,
}

/// What `run` resolves with.
#[derive(Debug, Clone, Default, JsObject)]
pub(crate) struct CommandOutput {
    /// The exit status; -1 when a signal ended the child.
    code: i32,
    stdout: String,
    stderr: String,
}

/// How a spawned child ended.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ExitResult {
    /// The exit status, `null` when a signal ended it.
    code: Option<i32>,
    /// The signal that ended it (`"SIGTERM"`).
    signal: Option<String>,
    /// Why the runtime ended it (a timeout, an over-long line); absent
    /// otherwise.
    #[prop(skip_none)]
    error: Option<String>,
}

/// A child's events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum ChildEvent {
    Stdout,
    Stderr,
    Exit,
}

/// The output events (`on`'s first overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum OutputEvent {
    Stdout,
    Stderr,
}

/// The exit event (`on`'s second overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum ExitEvent {
    Exit,
}

/// What a listener gets: output text, or the exit.
#[derive(Debug, Clone)]
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(crate) enum Payload {
    Text(String),
    Exit(ExitResult),
}

impl JsValue for Payload {
    fn ts_type(types: &mut TsTypes) -> String {
        format!("string | {}", ExitResult::ts_type(types))
    }

    fn from_js(value: crate::element::JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value (a payload goes to JS only)"))
    }

    fn to_js<'a>(
        &self,
        host: &'a dyn crate::element::JsHost,
    ) -> Result<crate::element::JsOwned<'a>, PropError> {
        match self {
            Payload::Text(text) => text.to_js(host),
            Payload::Exit(exit) => exit.to_js(host),
        }
    }
}

/// A child process started by `spawn`.
#[class]
pub(crate) struct ChildProcess {
    pid: u32,
    child: Rc<Child>,
}

#[class]
impl ChildProcess {
    /// The child's process id.
    #[getter]
    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    /// Calls `handler` with each piece (or line) of output, or once with
    /// the exit after the final output (at once when the child has exited).
    #[overload(fn(event: OutputEvent, #[args(text)] handler: Callback<String>) -> Instance<ChildProcess>)]
    #[overload(fn(event: ExitEvent, #[args(result)] handler: Callback<ExitResult>) -> Instance<ChildProcess>)]
    pub(crate) fn on(
        this: Instance<Self>,
        event: ChildEvent,
        #[args(payload)] handler: Callback<Payload>,
    ) -> Result<Instance<Self>, JsError> {
        let child = this.with(|c| c.child.clone());
        let exited = child.exited.borrow().clone();
        if let Some(exit) = exited {
            if event == ChildEvent::Exit {
                handler.call(Payload::Exit(exit)).map_err(JsError::Error)?;
            }
            return Ok(this);
        }
        let mut listeners = child.listeners.borrow_mut();
        let list = &mut listeners[event as usize];
        if list.len() >= MAX_LISTENERS {
            return Err(JsError::Type(format!(
                "a child takes at most {MAX_LISTENERS} listeners per event"
            )));
        }
        list.push(handler);
        drop(listeners);
        Ok(this)
    }

    /// Queues UTF-8 for stdin (`stdin: "pipe"`); at most 1 MiB may wait.
    pub(crate) fn write(&self, text: String) -> Result<(), JsError> {
        if !self.child.stdin_open.get() {
            return Err(JsError::Type(
                "ChildProcess.write needs stdin:\"pipe\" and an open stdin".into(),
            ));
        }
        #[cfg(not(target_arch = "wasm32"))]
        return native::write(&self.child, text);
        #[cfg(target_arch = "wasm32")]
        {
            let _ = text;
            Err(JsError::Type(UNAVAILABLE.into()))
        }
    }

    /// Closes stdin.
    pub(crate) fn end(&self) {
        if self.child.stdin_open.replace(false) {
            #[cfg(not(target_arch = "wasm32"))]
            native::close_stdin(&self.child);
        }
    }

    /// Ends the whole process tree: SIGTERM to its process group, SIGKILL
    /// after 250 ms; on Windows its job ends at once.
    pub(crate) fn kill(&self) {
        #[cfg(not(target_arch = "wasm32"))]
        native::kill(&self.child);
    }
}

/// `run`'s deadline when none is given.
const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_LISTENERS: usize = 64;
#[cfg(target_arch = "wasm32")]
const UNAVAILABLE: &str = "process is available on desktop hosts";

fn timeout(ms: Option<f64>) -> Result<Option<std::time::Duration>, JsError> {
    match ms {
        None => Ok(None),
        Some(ms) if ms.is_finite() && ms > 0.0 && ms <= u32::MAX as f64 => {
            Ok(Some(std::time::Duration::from_secs_f64(ms / 1000.0)))
        }
        Some(_) => Err(JsError::Type(
            "process timeoutMs must be a positive number of milliseconds".into(),
        )),
    }
}

/// One spawned child as its object and its task see it.
pub(crate) struct Child {
    /// stdout, stderr and exit listeners, released at the exit.
    listeners: RefCell<[Vec<Callback<Payload>>; 3]>,
    /// How it ended, once it has.
    exited: RefCell<Option<ExitResult>>,
    stdin_open: Cell<bool>,
    #[cfg(not(target_arch = "wasm32"))]
    control: native::Control,
}

/// The VM's children: killed and joined when the VM goes.
#[derive(Default)]
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(crate) struct Children {
    #[cfg(not(target_arch = "wasm32"))]
    inner: native::Children,
    /// Children started, for their ids.
    next: Cell<u64>,
}

impl Local for Children {
    fn close(&self) {
        #[cfg(not(target_arch = "wasm32"))]
        self.inner.close();
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use std::{
        cell::{Cell, RefCell},
        ffi::OsString,
        io::{Read, Write},
        path::{Path, PathBuf},
        process::{Child as StdChild, Command, ExitStatus, Stdio},
        rc::Rc,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    use tokio::sync::mpsc as channel;

    use super::{Child, ChildEvent, ChildProcess, CommandOutput, ExitResult, Payload};
    use crate::{
        access::{Access, env_names_match},
        element::{CallCx, Held, JsError, Later, System},
    };

    /// Output one VM holds in flight, and what `run` captures per stream
    /// (and the longest line `lines: true` delivers).
    const QUEUE_BYTES: usize = 8 * 1024 * 1024;
    const MAX_CHILDREN: usize = 32;
    /// The [`crate::element::Quotas`] kind children count under.
    const CHILDREN: &str = "process.children";
    /// How long a child has to exit after it is asked to before it is killed.
    const GRACE: Duration = Duration::from_millis(250);
    /// How long a killed child may take to exit before its supervisor gives
    /// it up: a child of another user (setuid) cannot be signalled.
    const ABANDON: Duration = Duration::from_secs(2);
    /// stdin queued for one child.
    const MAX_STDIN: usize = 1024 * 1024;
    /// Host variables every child gets; others only when
    /// `capabilities.process.env` grants them. Names match regardless of
    /// case; `LC_*` are included too.
    const CHILD_ENV: &[&str] = &[
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
    ];

    pub(super) enum Input {
        Write(Vec<u8>),
        Close,
        Kill,
    }
    pub(super) enum Event {
        Output(bool, String),
        Exit(Option<i32>, Option<i32>, Option<String>),
    }

    /// The VM's side of its children.
    #[derive(Default)]
    pub(super) struct Children {
        /// Set when the VM goes: supervisors kill at once, readers stop.
        stopped: Arc<AtomicBool>,
        /// Output queued for the VM, across its children.
        queued: Arc<AtomicUsize>,
        /// Each running child's id, input and supervisor.
        running: RefCell<Vec<Running>>,
    }

    impl Children {
        /// Every supervisor is told before any is joined, and kills at once
        /// (no grace) when the VM stops, so teardown takes about as long as
        /// one child does.
        pub(super) fn close(&self) {
            self.stopped.store(true, Ordering::Release);
            let running = std::mem::take(&mut *self.running.borrow_mut());
            for (_, input, ..) in &running {
                let _ = input.send(Input::Kill);
            }
            for (_, _, worker, _) in running {
                if let Some(worker) = worker {
                    let _ = worker.join();
                }
            }
        }

        /// Forgets a child that exited, joining its supervisor (which sent
        /// the exit as its last act).
        fn finished(&self, id: u64) {
            let worker = {
                let mut running = self.running.borrow_mut();
                running
                    .iter()
                    .position(|(i, ..)| *i == id)
                    .and_then(|at| running.remove(at).2)
            };
            if let Some(worker) = worker {
                let _ = worker.join();
            }
        }
    }

    /// A running child: its id, input, supervisor and place in the VM's
    /// quota of children.
    type Running = (u64, mpsc::Sender<Input>, Option<JoinHandle<()>>, Held);

    /// A started child: its id and pid, its control, its events and the
    /// VM's children it is one of.
    type Started = (
        u64,
        u32,
        Control,
        channel::UnboundedReceiver<Event>,
        Rc<super::Children>,
    );

    /// What the object and its task use to reach the child.
    pub(super) struct Control {
        input: mpsc::Sender<Input>,
        queued_input: Arc<AtomicUsize>,
    }

    /// A checked launch: the command, its arguments, where and how long.
    pub(super) struct Launch {
        command: String,
        args: Vec<String>,
        cwd: PathBuf,
        timeout: Option<Duration>,
        env: Vec<(OsString, OsString)>,
    }

    impl Launch {
        pub(super) fn new(
            sys: &System,
            command: String,
            args: Vec<String>,
            cwd: Option<String>,
            timeout: Option<Duration>,
        ) -> Result<Self, JsError> {
            if !cfg!(any(
                target_os = "linux",
                target_os = "macos",
                target_os = "windows"
            )) || !sys.os.is_desktop()
            {
                return Err(JsError::Type(
                    "process is available on desktop hosts".into(),
                ));
            }
            if command.is_empty() || command.contains('\0') {
                return Err(JsError::Type("invalid executable".into()));
            }
            if !sys.access.allows_process(&command) {
                return Err(spawn_error(
                    JsError::Type(format!("process capability denied for `{command}`"))
                        .with_code("EACCES"),
                    &command,
                ));
            }
            if args.len() > 4096 {
                return Err(JsError::Type("too many arguments".into()));
            }
            let cwd = match cwd {
                // A child may write where it runs: its directory needs a write grant.
                Some(cwd) => sys
                    .access
                    .authorize_file_with_paths(
                        Path::new(&cwd),
                        &sys.data_dir.clone().unwrap_or_default(),
                        &sys.paths,
                        true,
                    )
                    .map_err(|e| {
                        JsError::Type(e)
                            .with_code("EACCES")
                            .with("path", cwd.as_str())
                    })?,
                // The app's own data directory, which needs no grant.
                None => {
                    let dir = sys.data_dir.clone().ok_or_else(|| {
                        JsError::Type(
                            "this host configured no app data directory for a default cwd; \
                             pass options.cwd"
                                .into(),
                        )
                    })?;
                    std::fs::create_dir_all(&dir).map_err(|e| {
                        JsError::Type(format!("could not create the app data directory: {e}"))
                    })?;
                    dir
                }
            };
            if !cwd.is_dir() {
                return Err(JsError::Type("cwd must be an existing directory".into()));
            }
            Ok(Self {
                command,
                args,
                cwd,
                timeout,
                env: child_env(&sys.access),
            })
        }
    }

    /// The host variables a child gets: [`CHILD_ENV`], `LC_*`, and the names
    /// both the app's `capabilities.process.env` and its host grant list.
    fn child_env(access: &Access) -> Vec<(OsString, OsString)> {
        let listed = |names: &[String], name: &str| names.iter().any(|n| env_names_match(n, name));
        std::env::vars_os()
            .filter(|(name, _)| {
                let Some(name) = name.to_str() else {
                    return false;
                };
                CHILD_ENV.iter().any(|n| env_names_match(n, name))
                    || name.get(..3).is_some_and(|p| env_names_match(p, "LC_"))
                    || (listed(&access.declared.process.env, name)
                        && access
                            .granted
                            .as_ref()
                            .is_none_or(|g| listed(&g.process.env, name)))
            })
            .collect()
    }

    /// Node's properties of a launch failure of `command`: `syscall`
    /// (`spawn <command>`) and `path`.
    pub(super) fn spawn_error(error: JsError, command: &str) -> JsError {
        error
            .with("syscall", format!("spawn {command}"))
            .with("path", command)
    }

    fn resolve_executable(command: &str) -> Result<PathBuf, JsError> {
        let path = Path::new(command);
        if path.is_absolute() {
            return executable(path);
        }
        if command.contains('/') || command.contains('\\') {
            return Err(JsError::Type(
                "use a bare executable name or an absolute path".into(),
            ));
        }
        let host_path = std::env::var_os("PATH")
            .ok_or_else(|| JsError::Error("host PATH is unset".into()).with_code("ENOENT"))?;
        for directory in std::env::split_paths(&host_path).filter(|p| p.is_absolute()) {
            let candidate = directory.join(command);
            if let Ok(path) = executable(&candidate) {
                return Ok(path);
            }
            // Programs only, in PATHEXT's default order: a batch file runs
            // through a granted cmd.exe, whose quoting the app then controls.
            #[cfg(target_os = "windows")]
            if candidate.extension().is_none() {
                for extension in ["com", "exe"] {
                    if let Ok(path) = executable(&candidate.with_extension(extension)) {
                        return Ok(path);
                    }
                }
            }
        }
        Err(JsError::Error(format!(
            "executable `{command}` was not found in the host PATH"
        ))
        .with_code("ENOENT"))
    }

    fn executable(path: &Path) -> Result<PathBuf, JsError> {
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_file() {
            return Err(JsError::Error("executable is not a file".into()).with_code("EACCES"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(JsError::Error("file is not executable".into()).with_code("EACCES"));
            }
        }
        Ok(crate::access::canonicalize(path)?)
    }

    /// Launches `launch` under a supervisor: its id, pid, control and
    /// events, or a launch failure with Node's properties (`code`,
    /// `syscall`, `path`). The VM's quota of children is checked here.
    fn start(sys: &System, launch: Launch, stdin: bool) -> Result<Started, JsError> {
        let command = launch.command.clone();
        launch_child(sys, launch, stdin).map_err(|e| spawn_error(e, &command))
    }

    fn launch_child(sys: &System, launch: Launch, stdin: bool) -> Result<Started, JsError> {
        let children = sys.locals.get::<super::Children>();
        let place = sys.quotas.take(CHILDREN, MAX_CHILDREN).ok_or_else(|| {
            JsError::Range(format!("a VM may run at most {MAX_CHILDREN} children"))
        })?;
        let mut cmd = Command::new(resolve_executable(&launch.command)?);
        cmd.env_clear()
            .envs(launch.env)
            .args(launch.args)
            .current_dir(launch.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
            // The resolved file runs, under the name the app gave: a link's
            // name picks its behavior (`clang++`, busybox applets, a venv's
            // `python`).
            cmd.arg0(&launch.command);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // A console child gets no console window of its own, and starts
            // suspended: it runs once it is in its job, so all it starts is.
            cmd.creation_flags(
                windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                    | windows_sys::Win32::System::Threading::CREATE_SUSPENDED,
            );
        }
        let child = cmd.spawn().map_err(|e| {
            let message = format!("could not launch process: {e}");
            match crate::element::io_code(&e) {
                Some(code) => JsError::Error(message).with_code(code),
                None => JsError::Error(message),
            }
        })?;
        let pid = child.id();
        let leader = Leader::start(child)
            .map_err(|e| JsError::Error(format!("could not start the process in its job: {e}")))?;
        let id = children.next.get() + 1;
        children.next.set(id);
        let (input, inputs) = mpsc::channel();
        let (events_tx, events) = channel::unbounded_channel();
        let mailbox = Mailbox {
            tx: events_tx,
            queued: children.inner.queued.clone(),
            stopped: children.inner.stopped.clone(),
            unreadable: Arc::new(AtomicBool::new(false)),
        };
        let queued_input = Arc::new(AtomicUsize::new(0));
        let worker_input = queued_input.clone();
        let timeout = launch.timeout;
        // The leader goes to the supervisor once it runs: a child whose
        // supervisor cannot start is killed here, not left running.
        let (hand, handed) = mpsc::channel::<Leader>();
        let worker = thread::Builder::new()
            .name("nsh-process".into())
            .spawn(move || {
                if let Ok(leader) = handed.recv() {
                    supervise(leader, inputs, mailbox, timeout, worker_input);
                }
            });
        let worker = match worker {
            Ok(worker) => {
                let _ = hand.send(leader);
                worker
            }
            Err(e) => {
                let mut leader = leader;
                leader.terminate(true);
                let _ = leader.reap();
                return Err(JsError::Error(format!(
                    "could not supervise the process: {e}"
                )));
            }
        };
        if !stdin {
            let _ = input.send(Input::Close);
        }
        children
            .inner
            .running
            .borrow_mut()
            .push((id, input.clone(), Some(worker), place));
        Ok((
            id,
            pid,
            Control {
                input,
                queued_input,
            },
            events,
            children,
        ))
    }

    /// `run`: the captured output once the child exits.
    pub(super) fn run(sys: &System, launch: Launch, cx: CallCx<'_>) -> Later<CommandOutput> {
        let (id, _, control, mut events, children) = match start(sys, launch, false) {
            Ok(started) => started,
            Err(e) => return Later::new(async move { Err::<CommandOutput, _>(e) }),
        };
        let kill = control.input.clone();
        let cleanup = cx.on_cleanup(move || {
            let _ = kill.send(Input::Kill);
        });
        let queued = children.inner.queued.clone();
        Later::new(async move {
            let mut stdout = String::new();
            let mut stderr = String::new();
            let mut overflowed = false;
            loop {
                let Some(event) = events.recv().await else {
                    return Err("the process ended without an exit status".to_owned());
                };
                match event {
                    Event::Output(err, chunk) => {
                        queued.fetch_sub(chunk.len(), Ordering::AcqRel);
                        let captured = if err { &mut stderr } else { &mut stdout };
                        if overflowed {
                        } else if captured.len() + chunk.len() > QUEUE_BYTES {
                            overflowed = true;
                            let _ = control.input.send(Input::Kill);
                        } else {
                            captured.push_str(&chunk);
                        }
                    }
                    Event::Exit(code, _, error) => {
                        children.inner.finished(id);
                        cleanup.release();
                        if overflowed {
                            return Err(format!(
                                "process output exceeded {QUEUE_BYTES} bytes on one stream"
                            ));
                        }
                        if let Some(error) = error {
                            return Err(error);
                        }
                        return Ok(CommandOutput {
                            code: code.unwrap_or(-1),
                            stdout,
                            stderr,
                        });
                    }
                }
            }
        })
    }

    /// `spawn`: the child's object; a task of the core delivers its events.
    pub(super) fn spawn(
        sys: &System,
        launch: Launch,
        stdin: bool,
        lines: bool,
        cx: CallCx<'_>,
    ) -> Result<ChildProcess, JsError> {
        let (id, pid, control, events, children) = start(sys, launch, stdin)?;
        let kill = control.input.clone();
        let child = Rc::new(Child {
            listeners: RefCell::default(),
            exited: RefCell::default(),
            stdin_open: Cell::new(stdin),
            control,
        });
        let cleanup = cx.on_cleanup(move || {
            let _ = kill.send(Input::Kill);
        });
        cx.start(deliver(child.clone(), events, children, id, lines, cleanup));
        Ok(ChildProcess { pid, child })
    }

    /// Posts a child's events to its listeners until it exits.
    async fn deliver(
        child: Rc<Child>,
        mut events: channel::UnboundedReceiver<Event>,
        children: Rc<super::Children>,
        id: u64,
        lines: bool,
        cleanup: crate::element::Cleanup,
    ) {
        let queued = children.inner.queued.clone();
        let mut pending = [String::new(), String::new()];
        let mut line_error = None;
        let post = |stream: usize, text: String| {
            for listener in &child.listeners.borrow()[stream] {
                listener.post(Payload::Text(text.clone()));
            }
        };
        loop {
            let Some(event) = events.recv().await else {
                return;
            };
            match event {
                Event::Output(err, chunk) => {
                    queued.fetch_sub(chunk.len(), Ordering::AcqRel);
                    let stream = usize::from(err);
                    if !lines {
                        post(stream, chunk);
                        continue;
                    }
                    let mut parts = chunk.split('\n').peekable();
                    while let Some(part) = parts.next() {
                        pending[stream].push_str(part);
                        if pending[stream].len() > QUEUE_BYTES {
                            line_error = Some(
                                "a line of output exceeded 8 MiB without a newline".to_owned(),
                            );
                            pending[stream].clear();
                            kill(&child);
                            break;
                        }
                        if parts.peek().is_some() {
                            let mut line = std::mem::take(&mut pending[stream]);
                            if line.ends_with('\r') {
                                line.pop();
                            }
                            post(stream, line);
                        }
                    }
                }
                Event::Exit(code, signal, error) => {
                    for (stream, rest) in pending.iter_mut().enumerate() {
                        if !rest.is_empty() {
                            post(stream, std::mem::take(rest));
                        }
                    }
                    children.inner.finished(id);
                    // An owner that lives long must not collect one cleanup
                    // per child it ever ran.
                    cleanup.release();
                    let exit = ExitResult {
                        code,
                        signal: signal.map(signal_name),
                        error: line_error.or(error),
                    };
                    *child.exited.borrow_mut() = Some(exit.clone());
                    child.stdin_open.set(false);
                    // The listeners go with the exit: nothing calls them again.
                    let listeners = std::mem::take(&mut *child.listeners.borrow_mut());
                    for listener in &listeners[ChildEvent::Exit as usize] {
                        listener.post(Payload::Exit(exit.clone()));
                    }
                    return;
                }
            }
        }
    }

    pub(super) fn write(child: &Child, text: String) -> Result<(), JsError> {
        let control = &child.control;
        let len = text.len();
        if control.queued_input.fetch_add(len, Ordering::AcqRel) + len > MAX_STDIN {
            control.queued_input.fetch_sub(len, Ordering::AcqRel);
            return Err(JsError::Type("stdin queue exceeded 1 MB".into()));
        }
        control
            .input
            .send(Input::Write(text.into_bytes()))
            .map_err(|_| JsError::Type("process input is closed".into()))
    }

    pub(super) fn close_stdin(child: &Child) {
        let _ = child.control.input.send(Input::Close);
    }

    pub(super) fn kill(child: &Child) {
        let _ = child.control.input.send(Input::Kill);
    }

    /// A signal's name (`"SIGTERM"`).
    fn signal_name(signal: i32) -> String {
        #[cfg(unix)]
        {
            match signal {
                libc::SIGKILL => "SIGKILL",
                libc::SIGTERM => "SIGTERM",
                libc::SIGINT => "SIGINT",
                libc::SIGHUP => "SIGHUP",
                libc::SIGQUIT => "SIGQUIT",
                libc::SIGABRT => "SIGABRT",
                libc::SIGSEGV => "SIGSEGV",
                libc::SIGPIPE => "SIGPIPE",
                _ => return format!("signal {signal}"),
            }
            .to_owned()
        }
        #[cfg(not(unix))]
        {
            format!("signal {signal}")
        }
    }

    struct Mailbox {
        tx: channel::UnboundedSender<Event>,
        queued: Arc<AtomicUsize>,
        stopped: Arc<AtomicBool>,
        unreadable: Arc<AtomicBool>,
    }

    impl Mailbox {
        /// Queues output, waiting while the VM already holds [`QUEUE_BYTES`].
        fn output(&self, stderr: bool, chunk: String) -> bool {
            let len = chunk.len();
            loop {
                if self.stopped.load(Ordering::Acquire) {
                    return false;
                }
                if self.queued.fetch_add(len, Ordering::AcqRel) + len <= QUEUE_BYTES {
                    break;
                }
                self.queued.fetch_sub(len, Ordering::AcqRel);
                thread::sleep(Duration::from_millis(5));
            }
            if self.tx.send(Event::Output(stderr, chunk)).is_err() {
                self.queued.fetch_sub(len, Ordering::AcqRel);
                return false;
            }
            true
        }

        fn exit(&self, code: Option<i32>, signal: Option<i32>, error: Option<String>) {
            let _ = self.tx.send(Event::Exit(code, signal, error));
        }
    }

    #[cfg(unix)]
    trait Pipe: std::os::fd::AsRawFd {}
    #[cfg(unix)]
    impl<T: std::os::fd::AsRawFd> Pipe for T {}
    #[cfg(not(unix))]
    trait Pipe {}
    #[cfg(not(unix))]
    impl<T> Pipe for T {}

    fn prepare_pipe(pipe: &impl Pipe) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            // SAFETY: the borrowed pipe owns a live fd; preserve its other flags.
            let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
            if flags < 0
            // SAFETY: as above, with the flags just read.
                || unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                    < 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        #[cfg(not(unix))]
        let _ = pipe;
        Ok(())
    }

    fn read_pipe(
        mut pipe: impl Read + Pipe,
        mailbox: Arc<Mailbox>,
        stderr: bool,
        stop: Arc<AtomicBool>,
    ) {
        if prepare_pipe(&pipe).is_err() {
            mailbox.unreadable.store(true, Ordering::Release);
            return;
        }
        let mut buffer = [0; 4096];
        let mut pending = Vec::new();
        loop {
            if stop.load(Ordering::Acquire) {
                break;
            }
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                if !s.is_empty() && !mailbox.output(stderr, s.to_owned()) {
                                    return;
                                }
                                pending.clear();
                                break;
                            }
                            Err(e) => {
                                let valid = e.valid_up_to();
                                if valid != 0 {
                                    let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
                                    if !mailbox.output(stderr, s) {
                                        return;
                                    }
                                    pending.drain(..valid);
                                }
                                if let Some(n) = e.error_len() {
                                    pending.drain(..n);
                                    if !mailbox.output(stderr, "\u{fffd}".into()) {
                                        return;
                                    }
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            mailbox.output(stderr, String::from_utf8_lossy(&pending).into_owned());
        }
    }

    fn write_pipe(
        mut pipe: impl Write + Pipe,
        input: mpsc::Receiver<Input>,
        queued: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
    ) {
        if prepare_pipe(&pipe).is_err() {
            return;
        }
        while !stop.load(Ordering::Acquire) {
            let command = match input.recv_timeout(Duration::from_millis(5)) {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let Input::Write(bytes) = command else { break };
            queued.fetch_sub(bytes.len(), Ordering::AcqRel);
            let mut remaining = bytes.as_slice();
            while !remaining.is_empty() && !stop.load(Ordering::Acquire) {
                match pipe.write(remaining) {
                    Ok(0) => return,
                    Ok(n) => remaining = &remaining[n..],
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        }
    }

    /// The child a supervisor owns: the leader of a process group (Unix) or
    /// of a job (Windows). On Linux and Apple platforms its exit is
    /// noticed without reaping it, so its pid, which is also the group's id,
    /// stays taken (by the zombie) for as long as the group is signalled by
    /// it.
    struct Leader {
        child: StdChild,
        /// The status once the leader is reaped. On Unix its pid may then be
        /// reused, and the group is no longer signalled.
        reaped: Option<ExitStatus>,
        /// Reaped by the system instead (a host that ignores SIGCHLD): its
        /// pid, and the group it named, may be another's now, so nothing is
        /// signalled or waited for any more.
        #[cfg(unix)]
        gone: bool,
        #[cfg(target_vendor = "apple")]
        exits: Option<std::os::fd::OwnedFd>,
        /// The job the child and everything it starts run in: it ends them
        /// all, and they end with its last handle, whatever ends the host.
        #[cfg(target_os = "windows")]
        job: std::os::windows::io::OwnedHandle,
    }

    impl Leader {
        /// The leader of `child`, just spawned. On Windows the child starts
        /// suspended and runs once it is in its job; a child that cannot be
        /// put in one is killed.
        fn start(child: StdChild) -> std::io::Result<Self> {
            #[cfg(target_os = "windows")]
            let job = match job::contain(&child) {
                Ok(job) => job,
                Err(e) => {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e);
                }
            };
            Ok(Self {
                #[cfg(target_vendor = "apple")]
                exits: exit_queue(child.id()),
                child,
                reaped: None,
                #[cfg(unix)]
                gone: false,
                #[cfg(target_os = "windows")]
                job,
            })
        }

        /// Whether the leader has exited; it stays unreaped where that can be
        /// told.
        fn exited(&mut self) -> std::io::Result<bool> {
            if self.reaped.is_some() {
                return Ok(true);
            }
            #[cfg(unix)]
            if self.gone {
                return Ok(true);
            }
            #[cfg(any(target_os = "linux", target_os = "android"))]
            {
                // SAFETY: an all-zero siginfo_t is valid; waitid fills it for this child.
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                // SAFETY: WNOWAIT leaves the child waitable; info outlives the call.
                let result = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        self.child.id() as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                };
                if result < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() == Some(libc::ECHILD) {
                        self.gone = true;
                        return Ok(true);
                    }
                    return Err(error);
                }
                // SAFETY: waitid succeeded, so si_pid is set (0 while the child runs).
                Ok(unsafe { info.si_pid() } != 0)
            }
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            {
                #[cfg(target_vendor = "apple")]
                if let Some(queue) = &self.exits {
                    use std::os::fd::AsRawFd;
                    // SAFETY: an all-zero kevent is a valid output buffer.
                    let mut event: libc::kevent = unsafe { std::mem::zeroed() };
                    let now = libc::timespec {
                        tv_sec: 0,
                        tv_nsec: 0,
                    };
                    // SAFETY: polls the live queue for one event without blocking.
                    let n = unsafe {
                        libc::kevent(queue.as_raw_fd(), std::ptr::null(), 0, &mut event, 1, &now)
                    };
                    return if n < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(n > 0)
                    };
                }
                match self.child.try_wait() {
                    Ok(status) => self.reaped = status,
                    #[cfg(unix)]
                    Err(e) if e.raw_os_error() == Some(libc::ECHILD) => self.gone = true,
                    Err(e) => return Err(e),
                }
                #[cfg(unix)]
                if self.gone {
                    return Ok(true);
                }
                Ok(self.reaped.is_some())
            }
        }

        /// Asks the tree to stop (SIGTERM to the group), or forces it
        /// (SIGKILL).
        fn terminate(&mut self, force: bool) {
            #[cfg(unix)]
            if self.reaped.is_none() && !self.gone && !waitable(self.child.id()) {
                self.gone = true;
            }
            #[cfg(unix)]
            if self.reaped.is_none() && !self.gone {
                // SAFETY: the child leads its own process group and is still
                // this process's to wait for, so its pid still names that
                // group.
                unsafe {
                    libc::kill(
                        -(self.child.id() as i32),
                        if force { libc::SIGKILL } else { libc::SIGTERM },
                    );
                }
            }
            // Windows has no signal to ask with: the job ends the whole tree,
            // the leader and every process it started, at once.
            #[cfg(target_os = "windows")]
            {
                let _ = force;
                job::terminate(&self.job);
            }
            #[cfg(not(any(unix, target_os = "windows")))]
            {
                let _ = force;
                let _ = self.child.kill();
            }
        }

        fn reap(mut self) -> Option<ExitStatus> {
            #[cfg(unix)]
            if self.gone {
                return None;
            }
            self.reaped.take().or_else(|| self.child.wait().ok())
        }
    }

    /// The Windows job of a child: what ends its whole tree.
    #[cfg(target_os = "windows")]
    mod job {
        use std::{
            ffi::c_void,
            io,
            os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
            thread::JoinHandle,
        };

        use windows_sys::Win32::{
            Foundation::INVALID_HANDLE_VALUE,
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                    Thread32Next,
                },
                IO::CancelSynchronousIo,
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, TerminateJobObject,
                },
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        };

        /// Puts suspended `child` in a new job, which ends everything in it
        /// when its last handle closes, then lets the child run.
        pub(super) fn contain(child: &std::process::Child) -> io::Result<OwnedHandle> {
            // SAFETY: no name and default security; the handle is owned below.
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: a new handle nothing else owns.
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            // SAFETY: an all-zero limit information is valid; one flag is set.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: the live job; the structure and its size match the class.
            let set = unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if set == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: the live job and the child's live process handle.
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            resume(child.id())?;
            Ok(job)
        }

        /// Resumes the threads of suspended process `pid`: its one, main
        /// thread (`std` keeps no handle to it).
        fn resume(pid: u32) -> io::Result<()> {
            // SAFETY: a snapshot of the system's threads; owned below.
            let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            if raw == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: a new handle nothing else owns.
            let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
            // SAFETY: an all-zero entry is valid once its size is set.
            let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut resumed = false;
            // SAFETY: the live snapshot fills the entry it is given.
            let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
            while more {
                if entry.th32OwnerProcessID == pid {
                    // SAFETY: opens the thread by id; owned below when opened.
                    let thread =
                        unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                    if !thread.is_null() {
                        // SAFETY: a new handle nothing else owns.
                        let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                        // SAFETY: the live thread handle, opened to resume it.
                        resumed |= unsafe { ResumeThread(thread.as_raw_handle()) } != u32::MAX;
                    }
                }
                // SAFETY: as above.
                more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
            }
            if resumed {
                Ok(())
            } else {
                Err(io::Error::other("its main thread could not be resumed"))
            }
        }

        /// Ends every process in `job`.
        pub(super) fn terminate(job: &OwnedHandle) {
            // SAFETY: the live job handle.
            unsafe { TerminateJobObject(job.as_raw_handle(), 1) };
        }

        /// Cancels the blocking read or write `thread` is in, if any.
        pub(super) fn cancel_io(thread: &JoinHandle<()>) {
            // SAFETY: the live thread's handle, which the JoinHandle holds.
            unsafe { CancelSynchronousIo(thread.as_raw_handle()) };
        }
    }

    /// Joins the threads that end by `deadline`. One still blocked then (on a
    /// pipe a process outside the tree keeps open) ends by itself later;
    /// waiting for it could hold the VM's teardown forever.
    pub(super) fn join_by(threads: Vec<JoinHandle<()>>, deadline: Instant) {
        for thread in threads {
            while !thread.is_finished() && Instant::now() < deadline {
                // A blocking read or write of an anonymous pipe has no
                // timeout on Windows: it is cancelled.
                #[cfg(target_os = "windows")]
                job::cancel_io(&thread);
                thread::sleep(Duration::from_millis(1));
            }
            if thread.is_finished() {
                let _ = thread.join();
            } else {
                log::warn!("a process pipe thread is still blocked; it is left to end by itself");
            }
        }
    }

    /// Whether `pid` is still this process's child to wait for: running, or
    /// exited and not reaped. False once the system reaped it (a host that
    /// ignores SIGCHLD; `ECHILD`), when its pid may be another's.
    #[cfg(unix)]
    pub(super) fn waitable(pid: u32) -> bool {
        // SAFETY: an all-zero siginfo_t is valid; waitid fills it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: WNOWAIT | WNOHANG neither reaps nor blocks; info outlives the call.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ECHILD)
    }

    /// A kqueue that reports the child's exit without reaping it; `None` when
    /// it cannot be made, and then the exit is noticed by reaping.
    #[cfg(target_vendor = "apple")]
    fn exit_queue(pid: u32) -> Option<std::os::fd::OwnedFd> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // SAFETY: kqueue takes no arguments and returns a new descriptor or -1.
        let fd = unsafe { libc::kqueue() };
        if fd < 0 {
            return None;
        }
        // SAFETY: kqueue returned a descriptor nothing else owns.
        let queue = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
        // SAFETY: an all-zero kevent is valid; the fields below make the request.
        let mut change: libc::kevent = unsafe { std::mem::zeroed() };
        change.ident = pid as usize;
        change.filter = libc::EVFILT_PROC;
        change.flags = libc::EV_ADD;
        change.fflags = libc::NOTE_EXIT;
        // SAFETY: registers one change on the live queue and receives nothing.
        let result = unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        // The child may already have exited (ESRCH): its exit is then found by reaping.
        (result == 0).then_some(queue)
    }

    fn supervise(
        mut leader: Leader,
        input: mpsc::Receiver<Input>,
        mailbox: Mailbox,
        timeout: Option<Duration>,
        queued_input: Arc<AtomicUsize>,
    ) {
        let stdout = leader.child.stdout.take().expect("piped stdout");
        let stderr = leader.child.stderr.take().expect("piped stderr");
        let stdin = leader.child.stdin.take().expect("piped stdin");
        let mailbox = Arc::new(mailbox);
        let io_stop = Arc::new(AtomicBool::new(false));
        let (writer_tx, writer_rx) = mpsc::channel();
        let writer_stop = io_stop.clone();
        let writer = thread::spawn(move || write_pipe(stdin, writer_rx, queued_input, writer_stop));
        let (out_mail, err_mail) = (mailbox.clone(), mailbox.clone());
        let (out_stop, err_stop) = (io_stop.clone(), io_stop.clone());
        let out = thread::spawn(move || read_pipe(stdout, out_mail, false, out_stop));
        let err = thread::spawn(move || read_pipe(stderr, err_mail, true, err_stop));
        let started = Instant::now();
        let mut terminating: Option<Instant> = None;
        let mut forced: Option<Instant> = None;
        let mut abandoned = false;
        let mut error = None;
        loop {
            let mut kill = mailbox.stopped.load(Ordering::Acquire);
            if mailbox.unreadable.load(Ordering::Acquire) {
                kill = true;
                error.get_or_insert_with(|| "process output could not be read".to_owned());
            }
            if timeout.is_some_and(|limit| started.elapsed() >= limit) {
                kill = true;
                error.get_or_insert_with(|| "process timed out".to_owned());
            }
            // A pipe write may block: stdin is written on its own thread, never
            // this supervisor.
            match input.recv_timeout(Duration::from_millis(10)) {
                Ok(Input::Write(bytes)) => {
                    let _ = writer_tx.send(Input::Write(bytes));
                }
                Ok(Input::Close) => {
                    let _ = writer_tx.send(Input::Close);
                }
                Ok(Input::Kill) | Err(mpsc::RecvTimeoutError::Disconnected) => kill = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if kill && terminating.is_none() {
                leader.terminate(false);
                terminating = Some(Instant::now());
                let _ = writer_tx.send(Input::Close);
            }
            // A VM being torn down gives no grace period.
            let stopped = mailbox.stopped.load(Ordering::Acquire);
            if forced.is_none() && terminating.is_some_and(|at| stopped || at.elapsed() >= GRACE) {
                leader.terminate(true);
                forced = Some(Instant::now());
            }
            match leader.exited() {
                Ok(true) => break,
                Ok(false) => {}
                Err(e) => {
                    error = Some(e.to_string());
                    break;
                }
            }
            if forced.is_some_and(|at| at.elapsed() >= ABANDON) {
                error = Some("the process could not be ended (it may run as another user)".into());
                abandoned = true;
                break;
            }
        }
        // The leader may exit with descendants still holding its pipe handles.
        // It is not reaped yet, so its pid still names the group signalled here.
        // One that could not be ended is not waited for.
        let status = if abandoned {
            None
        } else {
            leader.terminate(true);
            leader.reap()
        };
        let _ = writer_tx.send(Input::Close);
        drop(writer_tx);
        // Drain final buffered output, but an escaped/detached descendant must
        // not keep inherited pipe handles (and therefore VM teardown) alive
        // forever. The output of a VM being torn down goes nowhere and is not
        // waited for.
        let drain_until = Instant::now() + Duration::from_millis(100);
        while !(writer.is_finished() && out.is_finished() && err.is_finished())
            && Instant::now() < drain_until
            && !mailbox.stopped.load(Ordering::Acquire)
        {
            thread::sleep(Duration::from_millis(5));
        }
        io_stop.store(true, Ordering::Release);
        join_by(
            vec![writer, out, err],
            Instant::now() + Duration::from_millis(100),
        );
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.as_ref().and_then(|s| s.signal())
        };
        #[cfg(not(unix))]
        let signal = None;
        mailbox.exit(status.and_then(|s| s.code()), signal, error);
    }
}

#[cfg(target_arch = "wasm32")]
mod native {
    use crate::element::{JsError, System};

    pub(super) struct Launch;

    impl Launch {
        pub(super) fn new(
            _: &System,
            _: String,
            _: Vec<String>,
            _: Option<String>,
            _: Option<std::time::Duration>,
        ) -> Result<Self, JsError> {
            Err(JsError::Type(super::UNAVAILABLE.into()))
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn declarations_come_from_the_spec() {
        let registry = crate::runtime::registries()
            .iter()
            .find(|registry| registry.specifier() == Some("process"))
            .unwrap();
        let d = crate::element::declarations(registry, &[]);
        for expected in [
            "export declare function run(command: string, args?: (string)[] | null, options?: RunOptions | null): Promise<CommandOutput>;",
            "export declare function spawn(command: string, args?: (string)[] | null, options?: SpawnOptions | null): ChildProcess;",
            "export declare const platform: string;",
            "  readonly env: Record<string, string>;",
            "  readonly dataDir: string | null;",
            "} & { nextTick: typeof nextTick };",
            "  on(event: ExitEvent, handler: (result: ExitResult) => void): ChildProcess;",
            "  on(event: OutputEvent, handler: (text: string) => void): ChildProcess;",
            "  get pid(): number;",
        ] {
            assert!(d.contains(expected), "{expected}\n{d}");
        }
        // Getters are the object's, never named exports.
        assert!(!d.contains("export declare function env"), "{d}");
    }

    #[test]
    fn a_blocked_pipe_thread_does_not_hold_the_supervisor() {
        use std::time::{Duration, Instant};
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let blocked = std::thread::spawn(move || {
            let _ = rx.recv();
        });
        let done = std::thread::spawn(|| {});
        let start = Instant::now();
        super::native::join_by(vec![done, blocked], start + Duration::from_millis(50));
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(tx);
    }

    /// A child the system reaped (its host ignores SIGCHLD) is not
    /// signalled: its pid may be another process's.
    #[cfg(unix)]
    #[test]
    fn only_children_still_waited_for_are_signalled() {
        // The init process is no child of this one.
        assert!(!super::native::waitable(1));
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        // Running or exited, it is waitable until it is reaped.
        assert!(super::native::waitable(child.id()));
        let pid = child.id();
        child.wait().unwrap();
        assert!(!super::native::waitable(pid));
    }
}
