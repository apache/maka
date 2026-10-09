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

//! Runs one real turn through the conversation feature against a running
//! development Host, the way the window would, and logs what happens.
//!
//! ```sh
//! cargo run -p conversation --example live_turn -- \
//!   --root ~/code/maka-gpui/.dev-root \
//!   --workspace /private/tmp/maka-gpui-fixture-workspace \
//!   --prompt "Say hello in one sentence" [--allow] [--dark] [--hold <seconds>] \
//!   [--switch <connection-slug>/<model>]… [--press "<key> <key>…"]
//! cargo run -p conversation --example live_turn -- \
//!   --root ~/code/maka-gpui/.dev-root --workspace <dir> --open <session-id> --hold <seconds>
//! ```
//!
//! It opens a window with the production `ConversationView` above the
//! production `Composer`, stacked as the shell stacks them, creates a
//! session in the workspace, selects it, sends the prompt through the same
//! `ConversationState::send_message` the composer calls, answers any prompt the turn
//! raises with Allow when `--allow` is given (the Allow button's call), and
//! quits once the turn has ended or after three minutes. Each `--switch`,
//! in order and before the turn, switches the session's model through
//! `Composer::select_model` (what choosing the model in the picker's menu
//! calls) and logs the session as `session.catalog.query` `get` reads it
//! before the first switch and after each one. `--dark` opens the
//! window in the dark theme and `--hold` keeps it open that many seconds
//! after the turn, both for screenshots (`scripts/screenshot.sh <pid>`);
//! `--press` then moves focus to the transcript and presses the given keys
//! (for example `"tab enter"`, which opens the first Tool row), the way a
//! person would, so a screenshot can show an expanded row; the
//! window is brought to the front when it opens and again before the hold,
//! because GPUI stops drawing a window that other windows cover. The
//! conversation state logs every commit at `info`; this driver adds only its
//! own steps. `--open` selects an existing session (or an id the Host does
//! not know, to show how the pane fails) instead of creating one, and sends
//! nothing; with `--hold` the window then shows whatever the pane settles
//! on, for a screenshot of its loading, empty, or failure state.
//! Never point `--root` at live Maka data (see `docs/dev-host.md`).

use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

use conversation::{
    Composer, ConversationPhase, ConversationState, ConversationView, TurnActivity,
};
use gpui_kit::component::{ActiveTheme as _, Root, Theme, ThemeMode, v_flex};
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, AsyncApp, Bounds, Context, Entity, Focusable as _,
    IntoElement, KeyUpEvent, Keystroke, ParentElement as _, PlatformInput, Render, Styled as _,
    Window, WindowBounds, WindowKind, WindowOptions, px, size,
};
use host_protocol::{
    InteractionAnswer, InteractionRequest, MessageContent, MessagePlacement, PermissionDecision,
    SessionCatalogItem, SessionCatalogQuery, SessionCatalogQueryInput, SessionCatalogQueryResult,
    SessionCreate, SessionCreateInput, SessionModelTarget, WorkspaceTarget,
};
use transcript_model::{ToolStatus, TurnItem};
use workspace::{
    ConnectionCatalog, HostProjectCatalog, HostRequester, HostSession, ProjectSelection,
};

const TICK: Duration = Duration::from_millis(200);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

struct Args {
    root: PathBuf,
    workspace: String,
    prompt: String,
    /// An existing session to select instead of creating one and sending.
    open: Option<String>,
    allow: bool,
    dark: bool,
    hold: Duration,
    /// `(connection slug, model)` pairs to switch to before the turn.
    switches: Vec<(String, String)>,
    /// Keys pressed in the transcript after the turn, before the hold.
    press: Vec<String>,
}

/// The transcript above the composer, as the shell stacks them.
struct Pane {
    view: Entity<ConversationView>,
    composer: Entity<Composer>,
}

impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.view.clone())
            .child(self.composer.clone())
    }
}

fn parse() -> Result<Args, String> {
    let mut args = std::env::args().skip(1);
    let (mut root, mut workspace, mut prompt, mut allow) = (None, None, None, false);
    let mut open = None;
    let (mut dark, mut hold, mut switches) = (false, Duration::ZERO, Vec::new());
    let mut press = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => root = args.next().map(PathBuf::from),
            "--workspace" => workspace = args.next(),
            "--prompt" => prompt = args.next(),
            "--open" => open = args.next(),
            "--allow" => allow = true,
            "--dark" => dark = true,
            "--switch" => {
                let value = args.next().unwrap_or_default();
                let (slug, model) =
                    value.split_once('/').ok_or("--switch needs <connection-slug>/<model>")?;
                switches.push((slug.to_owned(), model.to_owned()));
            }
            "--press" => {
                let keys = args.next().ok_or("--press needs keys, for example \"tab enter\"")?;
                press.extend(keys.split_whitespace().map(str::to_owned));
            }
            "--hold" => {
                let seconds = args.next().and_then(|value| value.parse().ok());
                hold = Duration::from_secs(seconds.ok_or("--hold needs a number of seconds")?);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(Args {
        root: root.ok_or("--root is required")?,
        workspace: workspace.ok_or("--workspace is required")?,
        prompt: match (prompt, &open) {
            (Some(prompt), _) => prompt,
            (None, Some(_)) => String::new(),
            (None, None) => return Err("--prompt or --open is required".into()),
        },
        open,
        allow,
        dark,
        hold,
        switches,
        press,
    })
}

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        let own = ["conversation", "live_turn", "workspace", "host_client"]
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
        conversation::init(cx);
        if args.dark {
            Theme::change(ThemeMode::Dark, None, cx);
        }
        // Maka's palette on the kit's colours, as the app sets it.
        shared::theme::apply_kit_theme(cx);
        let host = cx.new(|cx| HostSession::connect(args.root.clone(), cx));
        let state = cx.new(|cx| ConversationState::new(host.clone(), cx));
        let view_state = state.clone();
        // A fixed size, so screenshots are comparable.
        let bounds = Bounds::centered(None, size(px(1000.), px(800.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // Held for a screenshot, the window floats above other apps'
            // windows: GPUI stops drawing a covered window, and a process
            // started from a terminal may not bring itself to the front.
            kind: if args.hold.is_zero() { WindowKind::Normal } else { WindowKind::PopUp },
            ..WindowOptions::default()
        };
        let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
        let projects = cx.new(|cx| {
            ProjectSelection::new(host.clone(), std::rc::Rc::new(HostProjectCatalog), cx)
        });
        let mut parts = None;
        let opened = cx.open_window(options, |window, cx| {
            let view = cx.new(|cx| ConversationView::new(view_state.clone(), cx));
            let composer = cx.new(|cx| {
                Composer::new(view_state, connections.clone(), projects.clone(), window, cx)
            });
            parts = Some((view.clone(), composer.clone()));
            let pane = cx.new(|_| Pane { view, composer });
            cx.new(|cx| Root::new(pane, window, cx))
        });
        let (Ok(window), Some((view, composer))) = (opened, parts) else {
            log::error!("failed to open the window");
            cx.quit();
            return;
        };
        let window: AnyWindowHandle = window.into();
        bring_to_front(window, cx);
        let ui = Ui { host, state, connections, composer };
        cx.spawn(async move |cx| {
            if let Err(message) = drive(&ui, &args, cx).await {
                log::error!("{message}");
            }
            if !args.press.is_empty() {
                press_keys(window, &view, &args.press, cx).await;
            }
            if !args.hold.is_zero() {
                // Another window may have covered this one during the turn.
                cx.update(|cx| bring_to_front(window, cx));
                cx.background_executor().timer(Duration::from_millis(500)).await;
                log::info!("live_turn: holding the window for {} s", args.hold.as_secs());
                cx.background_executor().timer(args.hold).await;
            }
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}

/// Moves focus to the transcript and presses `keys` there, one at a time,
/// with a frame between them so each key lands where the last one left
/// focus.
async fn press_keys(
    window: AnyWindowHandle,
    view: &Entity<ConversationView>,
    keys: &[String],
    cx: &mut AsyncApp,
) {
    let focus = view.read_with(cx, |view, cx| view.focus_handle(cx));
    window.update(cx, |_, window, cx| window.focus(&focus, cx)).ok();
    for key in keys {
        cx.background_executor().timer(Duration::from_millis(200)).await;
        match Keystroke::parse(key) {
            // A button acts on the key's release, so press and release it.
            Ok(keystroke) => {
                window
                    .update(cx, |_, window, cx| {
                        window.dispatch_keystroke(keystroke.clone(), cx);
                        window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke }), cx);
                    })
                    .ok();
            }
            Err(error) => log::warn!("live_turn: --press {key:?}: {error}"),
        }
    }
    cx.background_executor().timer(Duration::from_millis(200)).await;
}

/// Activates the application and `window`, so the window is drawn and a
/// screenshot shows its current frame.
fn bring_to_front(window: AnyWindowHandle, cx: &mut App) {
    cx.activate(true);
    window.update(cx, |_, window, _| window.activate_window()).ok();
}

/// The production entities the driver acts through.
struct Ui {
    host: Entity<HostSession>,
    state: Entity<ConversationState>,
    connections: Entity<ConnectionCatalog>,
    composer: Entity<Composer>,
}

async fn drive(ui: &Ui, args: &Args, cx: &mut AsyncApp) -> Result<(), String> {
    let Ui { host, state, .. } = ui;
    wait(cx, Duration::from_secs(20), |cx| host.read_with(cx, |host, _| host.is_connected()))
        .await
        .ok_or("the Host did not connect")?;
    let requester = host.read_with(cx, |host, _| host.requester());
    if let Some(session_id) = &args.open {
        log::info!("live_turn: opening session {session_id}");
        state.update(cx, |state, cx| state.select_session(Some(session_id.clone().into()), cx));
        let settled = wait(cx, Duration::from_secs(20), |cx| {
            state.read_with(cx, |state, _| {
                matches!(
                    state.phase(),
                    ConversationPhase::Live
                        | ConversationPhase::Failed(_)
                        | ConversationPhase::Ended(_)
                )
            })
        })
        .await;
        let phase = state.read_with(cx, |state, _| state.phase().clone());
        log::info!("live_turn: the pane settled on {phase:?} ({settled:?})");
        return Ok(());
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    let input = SessionCreateInput::new(
        session_id.clone(),
        WorkspaceTarget::HostPath { path: args.workspace.clone() },
        SessionModelTarget::Default,
    );
    let created = requester
        .request::<SessionCreate>(&input)
        .await
        .map_err(|error| format!("session.create failed: {error}"))?;
    log::info!("live_turn: created session {} in {}", created.id(), args.workspace);

    state.update(cx, |state, cx| state.select_session(Some(session_id.clone().into()), cx));
    wait(cx, Duration::from_secs(20), |cx| {
        state.read_with(cx, |state, _| *state.phase() == ConversationPhase::Live)
    })
    .await
    .ok_or("the subscription did not open")?;
    if !args.switches.is_empty() {
        switch_models(ui, &session_id, &args.switches, cx).await?;
    }

    let content = MessageContent::text(args.prompt.clone());
    let accepted = state.update(cx, |state, cx| {
        state.send_message(&session_id, content, MessagePlacement::NextTurn, cx)
    });
    let outcome =
        accepted.await.map_err(|message| format!("the message was refused: {message}"))?;
    log::info!("live_turn: turn.message.submit answered {outcome:?}");

    let mut answered = Vec::new();
    let finished = wait(cx, TURN_TIMEOUT, |cx| {
        state.update(cx, |state, cx| {
            if args.allow {
                let pending: Vec<(String, InteractionAnswer)> = state
                    .transcript()
                    .map(|transcript| {
                        transcript
                            .pending_interactions()
                            .iter()
                            .filter(|pending| !answered.contains(&pending.interaction_id))
                            .filter_map(|pending| {
                                let answer = match &pending.request {
                                    InteractionRequest::Permission(_) => {
                                        InteractionAnswer::allow_once()
                                    }
                                    InteractionRequest::SandboxBoundary(_) => {
                                        InteractionAnswer::SandboxBoundary {
                                            decision: PermissionDecision::Allow,
                                        }
                                    }
                                    _ => return None,
                                };
                                Some((pending.interaction_id.clone(), answer))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                for (interaction_id, answer) in pending {
                    log::info!("live_turn: answering {interaction_id} with Allow");
                    state.answer_interaction(&interaction_id, answer, cx);
                    answered.push(interaction_id);
                }
            }
            state.turn_activity() == TurnActivity::Idle
        })
    })
    .await;
    if finished.is_none() {
        return Err("the turn did not end within three minutes".into());
    }
    state.read_with(cx, |state, _| report(state));
    Ok(())
}

/// Switches the session to each `(slug, model)` in turn the way the model
/// menu does, and logs the catalog's view of the session before and after.
async fn switch_models(
    ui: &Ui,
    session_id: &str,
    switches: &[(String, String)],
    cx: &mut AsyncApp,
) -> Result<(), String> {
    let requester = ui.host.read_with(cx, |host, _| host.requester());
    wait(cx, Duration::from_secs(20), |cx| {
        let settings = ui.state.read_with(cx, |state, _| state.settings().is_some());
        let catalog = ui.connections.read_with(cx, |catalog, _| catalog.list().is_some());
        settings && catalog
    })
    .await
    .ok_or("the session's settings or the connection catalog were not read")?;
    log_catalog_session(&requester, session_id, "before switching").await?;
    for (slug, model) in switches {
        let connection_id = ui
            .connections
            .read_with(cx, |catalog, _| {
                catalog.list().and_then(|list| {
                    list.connections.iter().find(|c| c.slug == slug.as_str()).map(|c| c.id.clone())
                })
            })
            .ok_or_else(|| format!("no enabled connection {slug}"))?;
        log::info!("live_turn: choosing {model} on {slug} in the model menu");
        ui.composer.update(cx, |composer, cx| composer.select_model(&connection_id, model, cx));
        wait(cx, Duration::from_secs(20), |cx| {
            ui.state.read_with(cx, |state, _| !state.is_configuring())
        })
        .await
        .ok_or("session.configuration.update did not finish")?;
        if let Some(error) = ui.composer.read_with(cx, |composer, _| composer.error().cloned()) {
            return Err(format!("the switch to {model} failed: {error}"));
        }
        log_catalog_session(&requester, session_id, &format!("after choosing {model}")).await?;
    }
    Ok(())
}

/// Logs the session's model target as `session.catalog.query` `get` reads it.
async fn log_catalog_session(
    requester: &HostRequester,
    session_id: &str,
    when: &str,
) -> Result<(), String> {
    let get = SessionCatalogQueryInput::Get { session_id: session_id.to_owned() };
    let result = requester
        .request::<SessionCatalogQuery>(&get)
        .await
        .map_err(|error| format!("session.catalog.query failed: {error}"))?;
    let SessionCatalogQueryResult::Session { session: Some(SessionCatalogItem::Session(session)) } =
        result
    else {
        return Err(format!("session.catalog.query answered {result:?}"));
    };
    log::info!(
        "live_turn: session.catalog.query {{get}} {when}: revision {}, llmConnectionId {}, \
         llmConnectionSlug {}, model {}, permissionMode {}",
        session.revision,
        session.llm_connection_id.as_deref().unwrap_or("null"),
        session.llm_connection_slug,
        session.model,
        session.permission_mode
    );
    Ok(())
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

/// Logs the last turn as the view shows it.
fn report(state: &ConversationState) {
    let Some(turn) = state.transcript().and_then(|transcript| transcript.turns().last()) else {
        log::info!("live_turn: no turn in the transcript");
        return;
    };
    log::info!(
        "live_turn: turn {} ended {:?}{}",
        turn.turn_id,
        turn.status,
        turn.failure
            .as_ref()
            .map(|f| format!(" ({}: {:?})", f.class, f.message))
            .unwrap_or_default()
    );
    for item in &turn.items {
        match item {
            TurnItem::User(user) => log::info!("live_turn:   user: {}", user.text()),
            TurnItem::Text(text) => log::info!("live_turn:   assistant: {}", text.text),
            TurnItem::Tool(tool) => log::info!(
                "live_turn:   tool {} {}: {}",
                tool.tool_name,
                match tool.status {
                    ToolStatus::Running => "running",
                    ToolStatus::Completed => "completed",
                    ToolStatus::Errored => "errored",
                    _ => "stopped",
                },
                tool.display_args().map(ToString::to_string).unwrap_or_default()
            ),
            TurnItem::Interaction(prompt) => {
                log::info!("live_turn:   prompt {}: {:?}", prompt.interaction_id, prompt.state)
            }
            other => log::info!("live_turn:   {other:?}"),
        }
    }
}
