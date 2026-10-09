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

//! Adds a connection through the production "Add connection" form against a
//! running development Host, checks that the model menu lists it, and then
//! removes it again so the dev State Root stays as it was.
//!
//! ```sh
//! cargo run -p app --example live_add_connection -- \
//!   --root ~/code/maka-gpui/.dev-root [--session <id>] \
//!   [--base-url http://127.0.0.1:11434/v1] [--api-key ollama] [--slug ollama-test-<random>] \
//!   [--default-model <model id>] [--hold <seconds>]
//! ```
//!
//! It opens the production window, dispatches the `AddConnection` command
//! (Settings at Models, with the provider catalog), picks the `custom`
//! provider (its default request protocol, OpenAI Chat, left as it is),
//! fills the fields, and presses "Verify and choose models" and then Add
//! connection through the form's own methods (what the buttons call), with
//! every verified model selected and, with `--default-model`, that model
//! the default (what the Default model dropdown calls). It logs the catalog
//! before and after, opens the model menu when `--session` names a task (the
//! keyboard path: the settings dialog closed, Tab from the draft until the
//! model picker has focus, Enter), then restores the previous
//! default target (`connection.catalog.set-default-target`) and removes the
//! test connection (`connection.catalog.remove`). `--hold` keeps the window
//! that many seconds with the verified models shown (the settings body
//! scrolled to them), with the saved connection's detail, and with the model
//! menu open, for screenshots (`scripts/screenshot.sh <pid>`).
//! Never point `--root` at live Maka data (see `docs/dev-host.md`).

use std::io::Write as _;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use app::Workbench;
use gpui_kit::component::{Root, TitleBar, WindowExt as _};
// The example is built with the dev-dependency's `test-support`, which lets
// it read which control has focus.
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    Action as _, AnyWindowHandle, AppContext as _, AsyncApp, Bounds, Entity, Keystroke, Modifiers,
    PlatformInput, ScrollDelta, ScrollWheelEvent, TitlebarOptions, TouchPhase, WindowBounds,
    WindowOptions, point, px, size,
};
use host_protocol::{
    ConnectionCatalogRemove, ConnectionCatalogRemoveInput, ConnectionCatalogSetDefaultTarget,
    ConnectionCatalogSetDefaultTargetInput, ConnectionVersionBasis, RemoveCatalogConnectionResult,
    SetDefaultConnectionTargetResult,
};
use settings::{AddConnectionForm, AddConnectionPhase, FormFields};
use workspace::actions::AddConnection;
use workspace::{ConnectionList, HostProjectCatalog, HostRequester, HostSession, read_connections};

const TICK: Duration = Duration::from_millis(200);

struct Args {
    root: PathBuf,
    session: Option<String>,
    base_url: String,
    api_key: String,
    slug: String,
    default_model: Option<String>,
    hold: Duration,
}

fn parse() -> Result<Args, String> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let mut args = Args {
        root: PathBuf::new(),
        session: None,
        base_url: "http://127.0.0.1:11434/v1".to_owned(),
        api_key: "ollama".to_owned(),
        slug: format!("ollama-test-{nanos:08x}"),
        default_model: None,
        hold: Duration::ZERO,
    };
    let mut root = None;
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        let mut value = || iter.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--root" => root = Some(PathBuf::from(value()?)),
            "--session" => args.session = Some(value()?),
            "--base-url" => args.base_url = value()?,
            "--api-key" => args.api_key = value()?,
            "--slug" => args.slug = value()?,
            "--default-model" => args.default_model = Some(value()?),
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
        let own = ["live_add_connection", "settings", "workspace", "conversation"]
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
        // The shell's chrome, as `main.rs` opens it.
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
            if let Some(session) = args.session.clone() {
                let catalog = workbench.read(cx).sidebar().read(cx).catalog().clone();
                catalog.update(cx, |catalog, cx| catalog.select_when_listed(session, cx));
            }
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
                log::error!("live_add_connection: {message}");
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
    let (host, connections) = workbench
        .read_with(cx, |workbench, _| (workbench.host().clone(), workbench.connections().clone()));
    wait(cx, Duration::from_secs(20), |cx| {
        connections.read_with(cx, |catalog, _| catalog.list().is_some())
    })
    .await
    .ok_or("the connection catalog was not read")?;
    let requester = host.read_with(cx, |host, _| host.requester());
    let before = read(&requester).await?;
    log_catalog("before", &before);
    let original_default = before.default_target.clone();

    cx.update_window(window, |_, window, cx| {
        window.dispatch_action(AddConnection.boxed_clone(), cx);
    })
    .map_err(|error| error.to_string())?;
    let pane_of = |cx: &mut AsyncApp| {
        workbench.read_with(cx, |workbench, cx| {
            workbench.settings_view().map(|view| view.read(cx).connections().clone())
        })
    };
    let form_of = |cx: &mut AsyncApp| {
        pane_of(cx).and_then(|pane| pane.read_with(cx, |pane, _| pane.form().cloned()))
    };
    wait(cx, Duration::from_secs(5), |cx| {
        pane_of(cx).is_some_and(|pane| pane.read_with(cx, |pane, _| pane.catalog_open()))
    })
    .await
    .ok_or("settings did not show the provider catalog")?;
    let pane = pane_of(cx).ok_or("settings did not show the provider catalog")?;
    cx.update_window(window, |_, window, cx| {
        pane.update(cx, |pane, cx| pane.show_setup("custom", true, window, cx));
    })
    .map_err(|error| error.to_string())?;
    let form = form_of(cx).ok_or("the catalog did not open the custom provider's form")?;
    update_form(&form, window, cx, |form, window, cx| {
        let fields = FormFields {
            api_key: Some(&args.api_key),
            slug: Some(&args.slug),
            name: Some("Ollama (test)"),
            base_url: Some(&args.base_url),
            ..FormFields::default()
        };
        form.fill(fields, window, cx);
    })?;
    log::info!("live_add_connection: pressing Verify for {} at {}", args.slug, args.base_url);
    update_form(&form, window, cx, |form, window, cx| form.submit(window, cx))?;
    let phase = settle_phase(&form, cx).await;
    if phase != AddConnectionPhase::Models {
        return Err(format!("verification ended {phase:?}: {:?}", error_of(&form, cx)));
    }
    update_form(&form, window, cx, |form, window, cx| form.select_all(true, window, cx))?;
    let models = form.read_with(cx, |form, _| form.models());
    log::info!("live_add_connection: verified models {models:?}");
    if let Some(model) = &args.default_model {
        let model = model.clone().into();
        update_form(&form, window, cx, |form, _, cx| form.set_default_model(&model, cx))?;
    }
    let default_model = form.read_with(cx, |form, _| form.default_model().cloned());
    log::info!("live_add_connection: marked Default: {default_model:?}");
    if !args.hold.is_zero() {
        scroll_settings_body(window, cx);
    }
    hold(args.hold, "with the verified models", cx).await;

    log::info!("live_add_connection: pressing Add connection");
    update_form(&form, window, cx, |form, window, cx| form.submit(window, cx))?;
    let closed = wait(cx, Duration::from_secs(60), |cx| {
        let failed = form.read_with(cx, |form, _| {
            matches!(form.phase(), AddConnectionPhase::Input | AddConnectionPhase::OutcomeUnknown)
                || (form.phase() == AddConnectionPhase::Models && form.error().is_some())
        });
        failed || form_of(cx).is_none()
    })
    .await;
    if closed.is_none() || error_of(&form, cx).is_some() {
        return Err(format!(
            "saving ended {:?}: {:?}",
            form.read_with(cx, |f, _| f.phase()),
            error_of(&form, cx)
        ));
    }
    log::info!("live_add_connection: the form left for the new connection's detail");

    let after = read(&requester).await?;
    log_catalog("after saving", &after);
    let added = after
        .connections
        .iter()
        .find(|connection| connection.slug == args.slug.as_str())
        .cloned()
        .ok_or("the new connection is not in the catalog")?;
    // The model menu reads the same catalog; wait for its reload.
    wait(cx, Duration::from_secs(10), |cx| {
        connections.read_with(cx, |catalog, _| {
            catalog.list().is_some_and(|list| list.connection(&added.id).is_some())
        })
    })
    .await
    .ok_or("the model menu's catalog did not pick up the new connection")?;
    log::info!("live_add_connection: the model menu's catalog lists {}", added.slug);
    if !args.hold.is_zero() {
        let pane = workbench.read_with(cx, |workbench, cx| {
            workbench.settings_view().map(|view| view.read(cx).connections().clone())
        });
        if let Some(pane) = pane {
            let shown = pane.read_with(cx, |pane, cx| {
                pane.detail().map(|detail| detail.read(cx).connection_id().clone())
            });
            log::info!("live_add_connection: the detail shows {shown:?}");
            hold(args.hold, "with the connection's detail", cx).await;
        }
    }
    if args.session.is_some() {
        open_model_menu(workbench, window, cx).await?;
        hold(args.hold, "with the model menu open", cx).await;
    }

    // Leave the dev State Root as it was.
    let current = read(&requester).await?;
    let restore =
        ConnectionCatalogSetDefaultTargetInput::new(current.revision, original_default.clone());
    match requester.request::<ConnectionCatalogSetDefaultTarget>(&restore).await {
        Ok(SetDefaultConnectionTargetResult::Committed { catalog_revision }) => log::info!(
            "live_add_connection: restored the default target {:?} (catalog revision {catalog_revision})",
            original_default.as_ref().map(|t| (&t.connection_id, &t.model_id))
        ),
        other => return Err(format!("restoring the default answered {other:?}")),
    }
    let remove = ConnectionCatalogRemoveInput::new(ConnectionVersionBasis::new(
        added.id.to_string(),
        added.revision,
    ));
    match requester.request::<ConnectionCatalogRemove>(&remove).await {
        Ok(RemoveCatalogConnectionResult::Committed { catalog_revision }) => log::info!(
            "live_add_connection: removed {} (catalog revision {catalog_revision})",
            added.slug
        ),
        other => return Err(format!("connection.catalog.remove answered {other:?}")),
    }
    let last = read(&requester).await?;
    log_catalog("after removing", &last);
    Ok(())
}

async fn read(requester: &HostRequester) -> Result<ConnectionList, String> {
    read_connections(requester).await.map_err(|error| format!("connection.catalog.query: {error}"))
}

fn log_catalog(when: &str, list: &ConnectionList) {
    let connections: Vec<String> = list
        .connections
        .iter()
        .map(|connection| {
            let models: Vec<&str> = connection.models.iter().map(|m| m.id.as_ref()).collect();
            format!("{} [{}]", connection.slug, models.join(", "))
        })
        .collect();
    log::info!(
        "live_add_connection: catalog {when}: revision {}, default {:?}, connections {}",
        list.revision,
        list.default_target.as_ref().map(|t| format!("{} {}", t.connection_id, t.model_id)),
        connections.join("; ")
    );
}

fn update_form(
    form: &Entity<AddConnectionForm>,
    window: AnyWindowHandle,
    cx: &mut AsyncApp,
    f: impl FnOnce(
        &mut AddConnectionForm,
        &mut gpui_kit::Window,
        &mut gpui_kit::Context<AddConnectionForm>,
    ),
) -> Result<(), String> {
    cx.update_window(window, |_, window, cx| form.update(cx, |form, cx| f(form, window, cx)))
        .map_err(|error| error.to_string())
}

fn error_of(form: &Entity<AddConnectionForm>, cx: &mut AsyncApp) -> Option<String> {
    form.read_with(cx, |form, _| form.error().map(ToString::to_string))
}

/// Waits until the form is no longer verifying.
async fn settle_phase(form: &Entity<AddConnectionForm>, cx: &mut AsyncApp) -> AddConnectionPhase {
    wait(cx, Duration::from_secs(60), |cx| {
        form.read_with(cx, |form, _| form.phase() != AddConnectionPhase::Verifying)
    })
    .await;
    form.read_with(cx, |form, _| form.phase())
}

/// The composer's model picker (`render_model_picker` in
/// crates/conversation/src/composer.rs).
const MODEL_PICKER: &str = "composer-model";

/// Opens the composer's model menu the way the keyboard does, once the
/// task's settings are read: closes the settings dialog, focuses the draft,
/// and presses Tab until the model picker itself reports focus (so a control
/// added between the draft and the picker does not make it press the wrong
/// one), then Enter.
async fn open_model_menu(
    workbench: &Entity<Workbench>,
    window: AnyWindowHandle,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    let composer = workbench.read_with(cx, |workbench, _| workbench.composer().clone());
    wait(cx, Duration::from_secs(20), |cx| composer.read_with(cx, |c, cx| c.shows_settings(cx)))
        .await
        .ok_or("the task's settings were not read")?;
    cx.update_window(window, |_, window, cx| {
        window.close_dialog(cx);
        composer.update(cx, |composer, cx| composer.focus(window, cx));
    })
    .map_err(|error| error.to_string())?;
    let picker_focused = |cx: &mut AsyncApp| {
        cx.update_window(window, |_, window, _| {
            window.try_find(MODEL_PICKER).and_then(|picker| picker.focused())
        })
        .ok()
        .flatten()
            == Some(true)
    };
    // The picker is a few Tab stops after the draft; never more than these.
    for _ in 0..8 {
        cx.background_executor().timer(TICK).await;
        if picker_focused(cx) {
            break;
        }
        press(window, "tab", cx);
    }
    cx.background_executor().timer(TICK).await;
    if !picker_focused(cx) {
        return Err("Tab from the draft never reached the model picker".to_owned());
    }
    press(window, "enter", cx);
    log::info!("live_add_connection: pressed Enter on the focused model picker");
    Ok(())
}

fn press(window: AnyWindowHandle, key: &str, cx: &mut AsyncApp) {
    cx.update_window(window, |_, window, cx| {
        if let Ok(keystroke) = Keystroke::parse(key) {
            window.dispatch_keystroke(keystroke, cx);
        }
    })
    .ok();
}

/// Scrolls the settings dialog's body to its end with a wheel event over it,
/// so the verified models show below the fields.
fn scroll_settings_body(window: AnyWindowHandle, cx: &mut AsyncApp) {
    cx.update_window(window, |_, window, cx| {
        let viewport = window.viewport_size();
        // The dialog is centered; its content pane lies right of the middle.
        let over_body = point(viewport.width * 0.55, viewport.height * 0.5);
        window.dispatch_event(
            PlatformInput::ScrollWheel(ScrollWheelEvent {
                position: over_body,
                delta: ScrollDelta::Pixels(point(px(0.), px(-4000.))),
                modifiers: Modifiers::default(),
                touch_phase: TouchPhase::Moved,
            }),
            cx,
        );
    })
    .ok();
}

async fn hold(duration: Duration, what: &str, cx: &mut AsyncApp) {
    if !duration.is_zero() {
        log::info!("live_add_connection: holding {} s {what}", duration.as_secs());
        cx.background_executor().timer(duration).await;
    }
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
