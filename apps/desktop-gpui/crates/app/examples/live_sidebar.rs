/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Drives the production sidebar against a running development Host:
//! registers a folder as a project, renames a task, and archives a task,
//! each through the path a person takes, then logs what the Host lists.
//!
//! ```sh
//! cargo run -p app --example live_sidebar -- \
//!   --root ~/code/maka-gpui/.dev-root \
//!   [--register /private/tmp/maka-gpui-fixture-workspace] \
//!   [--rename <session-id> "<new name>"] [--archive <session-id>] \
//!   [--rename-project "<new name>"] [--new-task] [--hold <seconds>]
//! ```
//!
//! `--register` hands the folder to the project selection the way the
//! folder dialog's answer does (`ProjectSelection::use_folder`, what New
//! project… in the composer's project picker ends in), which registers it
//! with `project.catalog.mutate` (`register`, `prefer: true`) and chooses
//! it.
//! `--rename` selects the task, focuses the list, presses F2, types the
//! name (ASCII letters, digits, and spaces), and presses Enter
//! (`session.metadata.update`). `--archive` selects the task and opens its
//! menu with Shift-F10, moves down to Archive, and presses Enter
//! (`session.lifecycle.set`). `--rename-project` renames the chosen project
//! through the method Settings › Projects' rename field commits with
//! (`project.catalog.mutate` `rename`). `--new-task` presses ⌘N and waits
//! for the new task's draft to open (no task selected) with the composer
//! focused; nothing is created until a message is sent. It starts once
//! the task list and the project list are read, so a fresh State Root with no
//! tasks and no projects works too. Nothing is restored afterwards. `--hold` keeps
//! the window open that many seconds at the end, for screenshots
//! (`scripts/screenshot.sh <pid>`). Never point `--root` at live Maka data
//! (see `docs/dev-host.md`).

use std::io::Write as _;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use app::Workbench;
use gpui_kit::component::{Root, TitleBar};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, AsyncApp, Bounds, Entity, Focusable as _, Keystroke,
    TitlebarOptions, WindowBounds, WindowOptions, point, px, size,
};
use session::LoadState;
use workspace::{HostProjectCatalog, HostSession};

const TICK: Duration = Duration::from_millis(200);

#[derive(Default)]
struct Args {
    root: PathBuf,
    register: Option<String>,
    rename: Option<(String, String)>,
    archive: Option<String>,
    rename_project: Option<String>,
    new_task: bool,
    hold: Duration,
}

fn parse() -> Result<Args, String> {
    let mut args = Args::default();
    let mut root = None;
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        let mut value = || iter.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--root" => root = Some(PathBuf::from(value()?)),
            "--register" => args.register = Some(value()?),
            "--rename" => {
                let id = value()?;
                let name = value()?;
                if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ') {
                    return Err("--rename types ASCII letters, digits, and spaces only".into());
                }
                args.rename = Some((id, name));
            }
            "--archive" => args.archive = Some(value()?),
            "--rename-project" => args.rename_project = Some(value()?),
            "--new-task" => args.new_task = true,
            "--hold" => {
                let seconds = value()?.parse().map_err(|_| "--hold needs seconds")?;
                args.hold = Duration::from_secs(seconds);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    args.root = root.ok_or("--root is required")?;
    Ok(args)
}

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        let own = ["live_sidebar", "session", "workspace"]
            .iter()
            .any(|name| metadata.target().starts_with(name));
        metadata.level() <= if own { log::Level::Info } else { log::Level::Warn }
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            let _ = writeln!(
                std::io::stderr().lock(),
                "[{} {}] {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

fn main() {
    if log::set_logger(&Logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let args = match parse() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    gpui_kit::application().with_assets(shared::assets::AppAssets).run(move |cx| {
        gpui_kit::init(cx);
        app::init(cx);
        let bounds = Bounds::centered(None, size(px(1512.), px(885.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                traffic_light_position: Some(point(px(16.), px(17.))),
                ..TitleBar::title_bar_options()
            }),
            ..TitleBar::window_options()
        };
        let mut built = None;
        let opened = cx.open_window(options, |window, cx| {
            let host = cx.new(|cx| HostSession::connect(args.root.clone(), cx));
            let workbench =
                cx.new(|cx| Workbench::new(host, Rc::new(HostProjectCatalog), window, cx));
            built = Some(workbench.clone());
            cx.new(|cx| Root::new(workbench, window, cx))
        });
        let (Ok(window), Some(workbench)) = (opened, built) else {
            log::error!("failed to open the window");
            cx.quit();
            return;
        };
        let window: AnyWindowHandle = window.into();
        // A window behind others is occluded and GPUI stops drawing it.
        cx.activate(true);
        cx.spawn(async move |cx| {
            if let Err(message) = drive(&workbench, window, &args, cx).await {
                log::error!("live_sidebar: {message}");
            }
            if !args.hold.is_zero() {
                log::info!("live_sidebar: holding {} s", args.hold.as_secs());
                cx.background_executor().timer(args.hold).await;
            }
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}

async fn drive(
    workbench: &Entity<Workbench>,
    window: AnyWindowHandle,
    args: &Args,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    let (sidebar, projects) = workbench
        .read_with(cx, |workbench, _| (workbench.sidebar().clone(), workbench.projects().clone()));
    let catalog = sidebar.read_with(cx, |sidebar, _| sidebar.catalog().clone());
    // Read, not necessarily listing anything: a fresh State Root has no
    // tasks and no projects yet.
    wait(cx, Duration::from_secs(30), |cx| {
        let tasks = catalog.read_with(cx, |catalog, _| {
            matches!(catalog.load_state(), LoadState::Loaded | LoadState::Failed(_))
        });
        let listed = projects.read_with(cx, |projects, _| projects.projects().is_some());
        tasks && listed
    })
    .await
    .ok_or("the task list or the project list was not read")?;
    if let LoadState::Failed(error) =
        catalog.read_with(cx, |catalog, _| catalog.load_state().clone())
    {
        return Err(format!("reading the task list failed: {error}"));
    }
    let tasks = catalog.read_with(cx, |catalog, _| catalog.rows().len());
    log::info!("live_sidebar: {tasks} tasks listed");
    log_projects("before", &projects, cx);

    if let Some(path) = &args.register {
        log::info!("live_sidebar: choosing the folder {path}");
        let path = path.clone();
        let used = projects.update(cx, |projects, cx| projects.use_folder(path, cx));
        if let Err(error) = used.await {
            return Err(format!("registering failed: {error}"));
        }
        log_projects("after registering", &projects, cx);
    }

    if let Some((id, name)) = &args.rename {
        select_and_focus(workbench, window, id, cx).await?;
        press(window, &["f2"], cx)?;
        wait(cx, Duration::from_secs(5), |cx| {
            sidebar.read_with(cx, |sidebar, _| sidebar.renaming_task().is_some())
        })
        .await
        .ok_or("F2 did not open the rename field")?;
        settle(cx).await;
        let keys: Vec<String> = name
            .chars()
            .map(|c| if c == ' ' { "space".to_owned() } else { c.to_string() })
            .collect();
        let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
        press(window, &keys, cx)?;
        press(window, &["enter"], cx)?;
        wait_for_command(&catalog, id, cx).await?;
        let renamed = catalog.read_with(cx, |c, _| c.row(id).map(|row| row.name.to_string()));
        log::info!("live_sidebar: {id} is now named {renamed:?}");
    }

    if let Some(id) = &args.archive {
        select_and_focus(workbench, window, id, cx).await?;
        press(window, &["shift-f10"], cx)?;
        wait(cx, Duration::from_secs(5), |cx| {
            sidebar.read_with(cx, |sidebar, _| sidebar.menu_task().is_some())
        })
        .await
        .ok_or("Shift-F10 did not open the task's menu")?;
        settle(cx).await;
        // Rename, Flag, Copy task ID, (separator), Archive.
        press(window, &["down", "down", "down", "down", "enter"], cx)?;
        wait_for_command(&catalog, id, cx).await?;
        let archived = catalog.read_with(cx, |c, _| c.row(id).map(|row| row.is_archived));
        log::info!("live_sidebar: {id} archived: {archived:?}");
    }

    if let Some(name) = &args.rename_project {
        let id = projects
            .read_with(cx, |projects, _| projects.selected_project().map(|p| p.id.clone()))
            .ok_or("no project is chosen")?;
        projects.update(cx, |projects, cx| projects.rename_project(&id, name, cx));
        wait(cx, Duration::from_secs(20), |cx| {
            projects.read_with(cx, |projects, _| {
                projects.pending_command().is_none()
                    && projects.project(&id).is_some_and(|p| p.name == name.as_str())
            })
        })
        .await
        .ok_or("the project rename was not answered")?;
        log_projects("after renaming", &projects, cx);
    }

    if args.new_task {
        let composer = workbench.read_with(cx, |workbench, _| workbench.composer().clone());
        let tasks = catalog.read_with(cx, |catalog, _| catalog.rows().len());
        press(window, &["cmd-n"], cx)?;
        wait(cx, Duration::from_secs(20), |cx| {
            catalog.read_with(cx, |catalog, _| catalog.is_draft())
        })
        .await
        .ok_or("⌘N did not open the new task's draft")?;
        settle(cx).await;
        let (listed, focused, target) = cx
            .update_window(window, |_, window, cx| {
                let listed = catalog.read(cx).rows().len();
                let focused =
                    composer.read(cx).draft().read(cx).focus_handle(cx).is_focused(window);
                let target = projects.read(cx).target().map(|target| target.label());
                (listed, focused, target)
            })
            .map_err(|error| error.to_string())?;
        log::info!(
            "live_sidebar: ⌘N opened the draft for {target:?}; tasks {tasks} → {listed}; \
             composer focused: {focused}"
        );
    }
    Ok(())
}

/// Selects task `id` and gives the task list keyboard focus.
async fn select_and_focus(
    workbench: &Entity<Workbench>,
    window: AnyWindowHandle,
    id: &str,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    let sidebar = workbench.read_with(cx, |workbench, _| workbench.sidebar().clone());
    let catalog = sidebar.read_with(cx, |sidebar, _| sidebar.catalog().clone());
    if catalog.read_with(cx, |catalog, _| catalog.row(id).is_none()) {
        return Err(format!("the catalog does not list {id}"));
    }
    catalog.update(cx, |catalog, cx| catalog.select(Some(id), cx));
    cx.update_window(window, |_, window, cx| {
        let list = sidebar.read(cx).focus_handle(cx);
        window.focus(&list, cx);
    })
    .map_err(|error| error.to_string())?;
    settle(cx).await;
    Ok(())
}

/// Dispatches `keys` to the window in order, as typed.
fn press(window: AnyWindowHandle, keys: &[&str], cx: &mut AsyncApp) -> Result<(), String> {
    cx.update_window(window, |_, window, cx| {
        for key in keys {
            match Keystroke::parse(key) {
                Ok(keystroke) => {
                    window.dispatch_keystroke(keystroke, cx);
                }
                Err(error) => log::warn!("live_sidebar: cannot type {key:?}: {error}"),
            }
        }
    })
    .map_err(|error| error.to_string())
}

/// Waits for the command on task `id` to be answered and fails with the
/// sidebar's error line if it was refused.
async fn wait_for_command(
    catalog: &Entity<session::SessionCatalog>,
    id: &str,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    // The command starts on the key press; give it a moment to be sent.
    settle(cx).await;
    wait(cx, Duration::from_secs(20), |cx| {
        catalog.read_with(cx, |catalog, _| catalog.pending_command(id).is_none())
    })
    .await
    .ok_or(format!("the command on {id} was not answered"))?;
    match catalog.read_with(cx, |catalog, _| catalog.command_error().cloned()) {
        Some(error) => Err(error.to_string()),
        None => Ok(()),
    }
}

fn log_projects(when: &str, projects: &Entity<workspace::ProjectSelection>, cx: &mut AsyncApp) {
    projects.read_with(cx, |projects, _| {
        let listed: Vec<String> = projects
            .projects()
            .unwrap_or_default()
            .iter()
            .map(|p| format!("{} {:?} {}", p.id, p.name, p.path))
            .collect();
        log::info!(
            "live_sidebar: projects {when}: [{}], chosen {:?}",
            listed.join("; "),
            projects.selected_project().map(|p| p.id.clone())
        );
    });
}

/// Lets the window draw a few frames.
async fn settle(cx: &mut AsyncApp) {
    cx.background_executor().timer(TICK * 3).await;
}

/// Polls `done` every tick until it holds or `timeout` passes.
async fn wait(
    cx: &mut AsyncApp,
    timeout: Duration,
    mut done: impl FnMut(&mut AsyncApp) -> bool,
) -> Option<()> {
    let mut waited = Duration::ZERO;
    while waited < timeout {
        if done(cx) {
            return Some(());
        }
        cx.background_executor().timer(TICK).await;
        waited += TICK;
    }
    None
}
