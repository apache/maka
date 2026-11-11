//! `nsh/desktop`'s app functions (macOS, Windows, Linux; nothing happens
//! elsewhere). Windows and menus, which call the app's functions and live
//! in its reactive graph, are `nsh-js`'s.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use crate::{
    Command, ROOT_ID,
    desktop::DesktopCommand,
    element::{
        CallCx, Callback, JsHost, JsIn, JsObject, JsOwned, JsValue, Local, ModuleCx, PropEnum,
        PropError, Ret, Stop, System, TsTypes, module, task::Action,
    },
    single_instance::SecondInstance,
};

fn desktop(cx: &mut ModuleCx, command: DesktopCommand) {
    cx.act(Action::Command(
        ROOT_ID,
        Command::Desktop(Box::new(command)),
    ));
}

/// The application as a whole (desktops; its functions do nothing elsewhere,
/// and of its events only `openFiles` comes on iOS too).
#[module]
pub(crate) struct Application;

#[module]
impl Application {
    /// Quits the app, as the application menu's `quit` role and the
    /// platform's quit key do: its windows close and the app stops as when
    /// its last window closes, then its run ends, also while closing the
    /// window alone would leave it running (a window kept hidden, a tray
    /// icon). A view embedded in another app leaves the app's lifecycle to
    /// that app.
    pub(crate) fn quit(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::Quit);
    }

    /// Restarts the app: it quits as `quit` does, and once the app has
    /// exited it starts again with the arguments it was started with. For a
    /// setting that takes effect at the next start (the app's language, say):
    /// ask the user first, then call it. Standalone apps on macOS, Windows
    /// and Linux; a view embedded in another app leaves the app's lifecycle
    /// to that app.
    pub(crate) fn restart(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::Restart);
    }

    /// Listens to `event`. `secondInstance`: with nsh.json
    /// `"singleInstance": true`, the app was launched again on Windows or
    /// Linux; that launch exited without opening a window and handed this
    /// one its `args` (the program's path not included) and `cwd`, the
    /// directory relative paths among them are relative to. The main window
    /// is already brought forward (shown when hidden); what else the launch
    /// means is the app's. Anyone can start the app with any arguments:
    /// treat them as untrusted input. Launches while nothing listened go to
    /// the next listener (at most 16, the oldest dropped). macOS runs one
    /// instance of an app on its own and reports nothing; files and links
    /// come as `openFiles`, links through `UrlScheme`. `openFiles`: the
    /// system opened the app with files of the types it declares (nsh.json
    /// `fileTypes`: Open With, a double click, a drop on its icon) on macOS,
    /// iOS, Windows or Linux, at launch or while it runs; `paths` are
    /// absolute. Files that came while nothing listened, those that launched
    /// the app included, go to the next listener at once (at most 64, the
    /// oldest dropped). The app reads them with `fs`, which their opening
    /// does not grant. `quit`: the app is quitting (its Quit
    /// item, `quit()`, its last window closing, the system ending it, a host
    /// app removing its view), for its cleanup, as GPUI's `on_app_quit`: it
    /// cannot keep the app running (an app that asks first quits from a Quit
    /// item of its own). A promise the listener returns is awaited, 200 ms
    /// at most for all of them, while the platform waits too. Returns a
    /// function that stops listening.
    #[overload(fn(event: ApplicationSecondInstanceEvent, #[args(launch)] listener: Callback<ApplicationSecondInstance>) -> Stop)]
    #[overload(fn(event: ApplicationOpenFilesEvent, #[args(files)] listener: Callback<ApplicationOpenFiles>) -> Stop)]
    #[overload(fn(event: ApplicationQuitEvent, listener: Callback<()>) -> Stop)]
    pub(crate) fn on(
        event: ApplicationEvent,
        #[args(payload)] listener: Callback<Payload>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Stop {
        match event {
            ApplicationEvent::SecondInstance => second_instance(listener, &sys, cx),
            ApplicationEvent::OpenFiles => open_files(listener, &sys, cx),
            ApplicationEvent::Quit => quit(listener, &sys, cx),
        }
    }
}

fn second_instance(listener: Callback<Payload>, sys: &System, cx: CallCx<'_>) -> Stop {
    let launches = sys.locals.get::<Launches>();
    let id = launches.next.get();
    launches.next.set(id.wrapping_add(1));
    for launch in launches.unheard.take() {
        listener.post(Payload::SecondInstance(launch.into()));
    }
    launches.listeners.borrow_mut().push((id, listener));
    if !launches.started.replace(true) {
        cx.start(deliver(Rc::downgrade(&launches)));
    }
    let launches = Rc::downgrade(&launches);
    Stop::new(move || {
        if let Some(launches) = launches.upgrade() {
            launches.listeners.borrow_mut().retain(|(i, _)| *i != id);
        }
    })
}

fn open_files(listener: Callback<Payload>, sys: &System, cx: CallCx<'_>) -> Stop {
    let files = sys.locals.get::<Files>();
    let id = files.next.get();
    files.next.set(id.wrapping_add(1));
    let unheard = files.unheard.take();
    if !unheard.is_empty() {
        listener.post(Payload::OpenFiles(ApplicationOpenFiles::new(unheard)));
    }
    files.listeners.borrow_mut().push((id, listener));
    if !files.started.replace(true) {
        cx.start(deliver_files(Rc::downgrade(&files)));
    }
    let files = Rc::downgrade(&files);
    Stop::new(move || {
        if let Some(files) = files.upgrade() {
            files.listeners.borrow_mut().retain(|(i, _)| *i != id);
        }
    })
}

fn quit(listener: Callback<Payload>, sys: &System, cx: CallCx<'_>) -> Stop {
    let quits = sys.locals.get::<Quits>();
    let id = quits.next.get();
    quits.next.set(id.wrapping_add(1));
    quits.listeners.borrow_mut().push((id, listener));
    if !quits.started.replace(true) {
        cx.start(hold(Rc::downgrade(&quits)));
    }
    let quits = Rc::downgrade(&quits);
    Stop::new(move || {
        if let Some(quits) = quits.upgrade() {
            quits.listeners.borrow_mut().retain(|(i, _)| *i != id);
        }
    })
}

/// `Application.on`'s events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum ApplicationEvent {
    /// The app was launched again (nsh.json `singleInstance`).
    #[default]
    SecondInstance,
    /// The system opened the app with files (nsh.json `fileTypes`).
    OpenFiles,
    /// The app is quitting.
    Quit,
}

/// The event of a later launch (`on`'s first overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum ApplicationSecondInstanceEvent {
    SecondInstance,
}

/// The event of quitting (`on`'s second overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum ApplicationQuitEvent {
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum ApplicationOpenFilesEvent {
    #[default]
    OpenFiles,
}

/// What a listener gets.
#[derive(Debug, Clone)]
pub(crate) enum Payload {
    SecondInstance(ApplicationSecondInstance),
    OpenFiles(ApplicationOpenFiles),
    Quit,
}

impl JsValue for Payload {
    fn ts_type(types: &mut TsTypes) -> String {
        <ApplicationSecondInstance as JsValue>::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value (a payload goes to JS only)"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Payload::SecondInstance(launch) => launch.to_js(host),
            Payload::OpenFiles(files) => files.to_js(host),
            Payload::Quit => Ret::into_js((), host),
        }
    }
}

/// A later launch of the app (the `secondInstance` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ApplicationSecondInstance {
    /// Its command line's arguments, the program's path not included.
    args: Vec<String>,
    /// The directory it was started in; empty when unknown.
    cwd: String,
}

impl From<SecondInstance> for ApplicationSecondInstance {
    fn from(launch: SecondInstance) -> Self {
        Self {
            args: launch.args,
            cwd: launch.cwd,
        }
    }
}

/// The VM's `secondInstance` listeners.
#[derive(Default)]
struct Launches {
    listeners: RefCell<Vec<(u32, Callback<Payload>)>>,
    next: Cell<u32>,
    /// The task waiting for the core's launches started; it lasts as the
    /// VM does.
    started: Cell<bool>,
    /// Launches that came with no listener, for the next one.
    unheard: RefCell<Vec<SecondInstance>>,
}

impl Local for Launches {
    fn close(&self) {
        self.listeners.borrow_mut().clear();
    }
}

/// Posts the core's launches to the listeners, while the VM lasts.
async fn deliver(launches: Weak<Launches>) {
    loop {
        let launch = crate::prelude::next_second_instance().await;
        let Some(launches) = launches.upgrade() else {
            return;
        };
        let listeners = launches.listeners.borrow();
        if listeners.is_empty() {
            let mut unheard = launches.unheard.borrow_mut();
            if unheard.len() == crate::single_instance::MAX_PENDING {
                unheard.remove(0);
            }
            unheard.push(launch);
            continue;
        }
        for (_, listener) in &*listeners {
            listener.post(Payload::SecondInstance(launch.clone().into()));
        }
    }
}

/// Files the system opened the app with (the `openFiles` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ApplicationOpenFiles {
    /// Their absolute paths.
    paths: Vec<String>,
}

impl ApplicationOpenFiles {
    fn new(paths: Vec<std::path::PathBuf>) -> Self {
        Self {
            paths: paths
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
        }
    }
}

/// The VM's `openFiles` listeners.
#[derive(Default)]
struct Files {
    listeners: RefCell<Vec<(u32, Callback<Payload>)>>,
    next: Cell<u32>,
    /// The task waiting for the core's files started; it lasts as the VM
    /// does.
    started: Cell<bool>,
    /// Files that came with no listener, for the next one.
    unheard: RefCell<Vec<std::path::PathBuf>>,
}

impl Local for Files {
    fn close(&self) {
        self.listeners.borrow_mut().clear();
    }
}

/// Posts the core's files to the listeners, while the VM lasts.
async fn deliver_files(files: Weak<Files>) {
    loop {
        let paths = crate::prelude::next_open_files().await;
        let Some(files) = files.upgrade() else {
            return;
        };
        let listeners = files.listeners.borrow();
        if listeners.is_empty() {
            let mut unheard = files.unheard.borrow_mut();
            unheard.extend(paths);
            let excess = unheard.len().saturating_sub(crate::file_type::MAX_PENDING);
            unheard.drain(..excess);
            continue;
        }
        let payload = ApplicationOpenFiles::new(paths);
        for (_, listener) in &*listeners {
            listener.post(Payload::OpenFiles(payload.clone()));
        }
    }
}

/// The VM's `quit` listeners.
#[derive(Default)]
struct Quits {
    listeners: RefCell<Vec<(u32, Callback<Payload>)>>,
    next: Cell<u32>,
    /// The task holding the core's quit listener started; it lasts as the
    /// VM does.
    started: Cell<bool>,
}

impl Local for Quits {
    fn close(&self) {
        self.listeners.borrow_mut().clear();
    }
}

/// Holds the core's quit listener for the VM's: as the app quits, it calls
/// each of them and waits for what they return.
async fn hold(quits: Weak<Quits>) {
    let _subscription = crate::element::desktop::add_quit_listener(Rc::new(move || {
        let calls: Vec<_> = quits
            .upgrade()
            .map(|quits| {
                let listeners = quits.listeners.borrow();
                listeners
                    .iter()
                    .map(|(_, listener)| listener.call_async(Payload::Quit))
                    .collect()
            })
            .unwrap_or_default();
        Box::pin(async move {
            for call in calls {
                if let Err(message) = call.await {
                    log::error!(target: "js", "a quit listener failed: {message}");
                }
            }
        })
    }));
    std::future::pending::<()>().await;
}
