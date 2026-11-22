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

use super::{Desktop, Fixture, Options};
use crate::support;
use futures_util::FutureExt;
use maka_app_client::Client;
use nsh_terminal::{Modifiers, NativeSurface};
use serde_json::json;
use std::{future::Future, panic::AssertUnwindSafe, time::Duration};

async fn fixture() -> Fixture {
    Fixture::open_with_configuration(Options::default(), |configuration, _| {
        configuration["agent"]["permissions"]["access"] = json!("workspace_write");
    })
    .await
}

async fn with_terminal_launch_diagnostics<T>(
    client: &Client,
    session: &str,
    wait: impl Future<Output = T>,
) -> T {
    match AssertUnwindSafe(wait).catch_unwind().await {
        Ok(value) => value,
        Err(panic) => {
            let snapshot = tokio::time::timeout(
                Duration::from_secs(3),
                client.query(
                    "terminal",
                    "list",
                    json!({"sessionId": session, "offset": 0}),
                ),
            )
            .await;
            eprintln!("Host terminal catalog after Action wait failed: {snapshot:?}");
            std::panic::resume_unwind(panic);
        }
    }
}

async fn terminal_contains(desktop: &Desktop, text: &str) {
    let button = desktop.control("Copy visible terminal").await;
    let _ = desktop.platform.take_clipboard_write();
    desktop
        .retry(
            "original terminal output did not render",
            || {
                desktop
                    .platform
                    .take_clipboard_write()
                    .is_some_and(|value| value.contains(text))
            },
            || desktop.press_at(button.center()),
        )
        .await;
    let output = desktop.control("Terminal output").await;
    desktop
        .until("terminal text did not reach the native frame", || {
            let pixels = desktop.pixels(output)?;
            (pixels
                .chunks_exact(4)
                .filter(|pixel| pixel[..3].iter().all(|channel| *channel > 200))
                .count()
                > 80)
                .then_some(())
        })
        .await;
}

async fn fill_action(desktop: &Desktop, label: &str, command: &str) {
    desktop.type_text(label).await;
    let name = desktop.platform.text_input_target();
    desktop.key("tab", false);
    desktop.target_after(name).await;
    desktop.type_text(command).await;
}

async fn save_new_action_in_settings(desktop: &Desktop, label: &str, command: &str) {
    desktop.press("Add Action").await;
    fill_action(desktop, label, command).await;
    desktop.press("Save").await;
    desktop.control(label).await;
    desktop.control("Close settings").await;
}

pub(super) async fn desktop_action_config_selects_the_source_project() {
    let mut fixture = Fixture::open_with_configuration(Options::default(), |config, directory| {
        let other = directory.join("other-project");
        std::fs::create_dir(&other).unwrap();
        config["agent"]["workspaceRoots"]
            .as_array_mut()
            .unwrap()
            .push(json!({"label": "Other project", "path": other}));
    })
    .await;
    let client = fixture.client().await;
    let other = support::mutate(
        &client,
        "create",
        json!({
            "title": "Other project conversation",
            "labels": [],
            "workspace": {"kind": "directory", "path": fixture.directory.path().join("other-project")}
        }),
    )
    .await;
    assert_eq!(other["kind"], "created", "{other}");
    let projects = client
        .query("agent", "projects", json!({"kind": "list", "cursor": null}))
        .await
        .unwrap();
    let [first, source] = projects["projects"].as_array().unwrap().as_slice() else {
        panic!("expected two registered projects: {projects}");
    };
    assert_eq!(first["available"], true, "{first}");
    assert_eq!(source["available"], true, "{source}");
    let source_path = source["path"].as_str().unwrap();
    if other["session"]["workspace"]["path"] == source_path {
        fixture.session = other["session"]["id"].as_str().unwrap().to_owned();
    }
    client.close().await.unwrap();

    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop
        .press_until("Toggle session details", "Add Action")
        .await;
    desktop.press("Add Action").await;
    desktop.type_text("Unsaved action").await;
    desktop
        .retry(
            "Escape did not ask about the unsaved Action",
            || !desktop.controls("Keep editing").is_empty(),
            || desktop.key("escape", false),
        )
        .await;
    desktop.press("Keep editing").await;
    desktop.expect_text("Unsaved action").await;
    desktop.press("Cancel").await;
    desktop.press("Discard changes").await;
    desktop.control("Focus message composer").await;
    desktop.press("Add Action").await;
    fill_action(&desktop, "Source project command", "echo source").await;
    let mut modifiers = Modifiers::default();
    modifiers.platform = cfg!(target_os = "macos");
    modifiers.control = !modifiers.platform;
    desktop.key_with("enter", modifiers);
    desktop.control("Run Action Source project command").await;
    for (project, expected) in [
        (first, None),
        (source, Some(("Source project command", "echo source"))),
    ] {
        let definitions = desktop
            .client
            .query(
                "projectActions",
                "definitions",
                json!({"projectId": project["reference"]["id"]}),
            )
            .await
            .unwrap();
        let rows = definitions["value"].as_array().unwrap();
        assert_eq!(rows.len(), usize::from(expected.is_some()), "{definitions}");
        assert_eq!(
            rows.first()
                .and_then(|row| row["name"].as_str().zip(row["command"].as_str())),
            expected,
            "{definitions}"
        );
    }
    desktop.press("Manage Actions…").await;
    desktop.control("Source project command").await;
    desktop.press("Add Action").await;
    desktop.type_text("Unsaved action in settings").await;
    desktop.control("Back").await;
    desktop
        .retry(
            "Escape did not ask about the unsaved Action in settings",
            || !desktop.controls("Keep editing").is_empty(),
            || desktop.key("escape", false),
        )
        .await;
    desktop.press("Discard changes").await;
    desktop.control("Source project command").await;
    let recovery_action = "Recover source project command";
    save_new_action_in_settings(&desktop, recovery_action, "echo recover").await;
    desktop.press("Close settings").await;

    // Use the settings write: pending operations belong to their originating UI instance.
    let source_id = source["reference"]["id"].as_str().unwrap();
    let id: String = rusqlite::Connection::open(fixture.directory.path().join("client.db"))
        .unwrap()
        .query_row(
            "UPDATE operations SET receipt=NULL WHERE id=(
                SELECT id FROM operations WHERE json_extract(context,'$.endpoint')='projectActions'
                AND json_extract(context,'$.method')='create'
                AND json_extract(context,'$.correlation.projectId')=? ORDER BY rowid DESC LIMIT 1
             ) RETURNING id",
            [source_id],
            |row| row.get(0),
        )
        .unwrap();
    let id = id.parse().unwrap();
    let original = desktop.client.operation(id).await.unwrap();
    assert_eq!(original.correlation["projectId"], source["reference"]["id"]);
    desktop.press("Open settings").await;
    desktop.press("Settings section Project Actions").await;
    save_new_action_in_settings(&desktop, "Other project command", "echo other").await;
    assert!(desktop.controls(recovery_action).is_empty());
    let pending = desktop.client.operation(id).await.unwrap();
    assert!(pending.receipt.is_none());
    desktop.press("Choose a project").await;
    desktop.press(source["name"].as_str().unwrap()).await;
    desktop.control(recovery_action).await;
    let recovered = desktop
        .wait("source Action receipt was not recovered", async {
            let mut poll = tokio::time::interval(std::time::Duration::from_millis(50));
            loop {
                poll.tick().await;
                let result = desktop.client.operation(id).await.unwrap();
                if result.receipt.is_some() {
                    break result;
                }
            }
        })
        .await;
    assert_eq!(recovered.reference, original.reference);
    desktop.press("Close settings").await;

    std::fs::rename(
        source_path,
        fixture.directory.path().join("unavailable-project"),
    )
    .unwrap();
    desktop.press("Manage Actions…").await;
    desktop.press("Choose a project").await;
    let first_name = first["name"].as_str().unwrap();
    desktop.control(first_name).await;
    desktop.key("escape", false);
    desktop
        .until("project choices were not dismissed", || {
            desktop.controls(first_name).is_empty().then_some(())
        })
        .await;
    assert!(desktop.controls("Add Action").is_empty());
    desktop.press("Choose a project").await;
    desktop.press(first_name).await;
    desktop.control("Add Action").await;
    desktop.close().await;
    fixture.finish().await;
}

async fn action_recovery_desktop(
    fixture: &Fixture,
    method: &str,
) -> (Desktop, std::sync::Arc<std::sync::Mutex<Option<String>>>) {
    let nsh_engine::BundleCode::Source(mut source) = maka_workbench::bootstrap_bundle().code else {
        unreachable!();
    };
    source.insert_str(0, &format!("const recoveryMethod = {method:?};\n"));
    source.insert_str(
        source.find('\n').unwrap() + 1,
        r#"
import { host as recoveryNative } from 'maka/host';
import { host as recoveryEvents } from 'nsh';
const recoveryPrototype = Object.getPrototypeOf(recoveryNative);
let releaseRecovered;
let recoveredReleased = false;
recoveryEvents.on('fixture.releaseRecovered', () => {
  recoveredReleased = true;
  releaseRecovered?.();
});
const originalRecoveryBind = recoveryPrototype.bindUi;
let recoveryPatched = false;
recoveryPrototype.bindUi = async function(...args) {
  const bindings = await originalRecoveryBind.apply(this, args);
  if (!recoveryPatched) {
    recoveryPatched = true;
    const prototype = Object.getPrototypeOf(bindings);
    const recover = prototype.recover;
    prototype.recover = async function(id) {
      const reply = await recover.call(this, id);
      if (!recoveredReleased) await new Promise(resolve => { releaseRecovered = resolve; });
      return reply;
    };
  }
  return bindings;
};
const originalActionMutation = recoveryPrototype.mutation;
recoveryPrototype.mutation = async function(endpoint, method, input) {
  const result = await originalActionMutation.call(this, endpoint, method, input);
  if (endpoint === 'projectActions' && method === recoveryMethod) {
    await recoveryEvents.call('fixture.actionReplyLost', { id: result.operationId });
    throw new Error('Action reply lost after commit');
  }
  return result;
};
const originalActionBegin = recoveryPrototype.beginMutation;
recoveryPrototype.beginMutation = async function(endpoint, method, input) {
  const operation = await originalActionBegin.call(this, endpoint, method, input);
  if (endpoint !== 'projectActions' || method !== recoveryMethod) return operation;
  return {
    operationId: operation.operationId,
    cancel: () => operation.cancel(),
    next: async () => {
      const event = await operation.next();
      if (event?.kind === 'finished') {
        await recoveryEvents.call('fixture.actionReplyLost', { id: operation.operationId });
        throw new Error('Action reply lost after commit');
      }
      return event;
    },
  };
};
"#,
    );
    let desktop = Desktop::open_config(
        fixture,
        &fixture.address,
        nsh_terminal::size(
            nsh_terminal::DevicePixels(960),
            nsh_terminal::DevicePixels(640),
        ),
        nsh_core::platform::Appearance::Dark,
        Some((source, "en", "Focus message composer")),
    )
    .await;
    let database = fixture.directory.path().join("client.db");
    let lost = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let observed = lost.clone();
    desktop
        .host
        .handle("fixture.actionReplyLost", move |mut call| {
            let data = call.take_data();
            let id = data["id"].as_str().unwrap().to_owned();
            let changed = rusqlite::Connection::open(&database)
                .unwrap()
                .execute("UPDATE operations SET receipt=NULL WHERE id=?", [&id])
                .unwrap();
            assert_eq!(changed, 1);
            *observed.lock().unwrap() = Some(id);
            call.resolve(serde_json::Value::Null);
        });
    (desktop, lost)
}

pub(super) async fn desktop_create_recovery_closes_original_form(settings: bool, reopen: bool) {
    let fixture = fixture().await;
    let (desktop, lost) = action_recovery_desktop(&fixture, "create").await;
    desktop
        .press_until("Toggle session details", "Add Action")
        .await;
    if settings {
        desktop.press("Open settings").await;
        desktop.press("Settings section Project Actions").await;
    }
    desktop.press("Add Action").await;
    fill_action(&desktop, "Recovered create", "echo recovered").await;
    desktop.press("Save").await;
    let id = desktop
        .until("create response was not lost", || {
            lost.lock().unwrap().clone()
        })
        .await;
    let id = id.parse().unwrap();
    let recovered = desktop
        .wait("original create was not recovered", async {
            let mut poll = tokio::time::interval(std::time::Duration::from_millis(50));
            loop {
                poll.tick().await;
                let operation = desktop.client.operation(id).await.unwrap();
                if operation.receipt.is_some() {
                    break operation;
                }
            }
        })
        .await;
    let project = recovered.correlation["projectId"].as_str().unwrap();
    let definitions = desktop
        .client
        .query(
            "projectActions",
            "definitions",
            json!({"projectId":project}),
        )
        .await
        .unwrap();
    assert_eq!(
        definitions["value"].as_array().unwrap().len(),
        1,
        "{definitions}"
    );
    if reopen {
        desktop.press("Cancel").await;
        desktop.press("Discard changes").await;
        if settings {
            desktop.press("Close settings").await;
            desktop.press("Open settings").await;
            desktop.press("Settings section Project Actions").await;
            desktop.press("Add Action").await;
        }
    }
    desktop.event("fixture.releaseRecovered", serde_json::Value::Null);
    if reopen && settings {
        fill_action(&desktop, "New unsaved Action", "echo new").await;
        desktop.control("Save").await;
        desktop.artifact(if settings {
            "action-reopened-settings"
        } else {
            "action-reopened-dialog"
        });
        desktop.press("Cancel").await;
        desktop.press("Discard changes").await;
    }
    desktop
        .control(if settings {
            "Recovered create"
        } else {
            "Run Action Recovered create"
        })
        .await;
    assert!(
        desktop.controls("Save").is_empty(),
        "the recovered create must finish its original form"
    );
    if settings {
        desktop.control("Close settings").await;
    }
    desktop.artifact(if settings {
        "action-recovered-settings"
    } else {
        "action-recovered-dialog"
    });
    let definitions = desktop
        .client
        .query(
            "projectActions",
            "definitions",
            json!({"projectId":project}),
        )
        .await
        .unwrap();
    assert_eq!(
        definitions["value"].as_array().unwrap().len(),
        1,
        "{definitions}"
    );
    desktop.close().await;
    fixture.finish().await;
}

pub(super) async fn desktop_remove_recovery_finishes_original_form(leave: bool) {
    let fixture = fixture().await;
    let (desktop, lost) = action_recovery_desktop(&fixture, "remove").await;
    desktop
        .press_until("Toggle session details", "Add Action")
        .await;
    desktop.press("Open settings").await;
    desktop.press("Settings section Project Actions").await;
    save_new_action_in_settings(&desktop, "Deleted Action", "echo deleted").await;
    save_new_action_in_settings(&desktop, "Other Action", "echo other").await;
    desktop.press("Deleted Action").await;
    desktop.press("Delete").await;
    desktop
        .until(
            "delete confirmation did not replace the editor controls",
            || {
                (desktop.controls("Save").is_empty()
                    && desktop.controls("Cancel").len() == 1
                    && desktop.controls("Delete").len() == 1)
                    .then_some(())
            },
        )
        .await;
    desktop.press("Delete").await;
    let id = desktop
        .until("remove response was not lost", || {
            lost.lock().unwrap().clone()
        })
        .await
        .parse()
        .unwrap();
    let recovered = desktop
        .wait("original remove was not recovered", async {
            let mut poll = tokio::time::interval(std::time::Duration::from_millis(50));
            loop {
                poll.tick().await;
                let operation = desktop.client.operation(id).await.unwrap();
                if operation.receipt.is_some() {
                    break operation;
                }
            }
        })
        .await;
    let definitions = desktop
        .client
        .query(
            "projectActions",
            "definitions",
            json!({"projectId": recovered.correlation["projectId"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        definitions["value"].as_array().unwrap().len(),
        1,
        "{definitions}"
    );
    assert_eq!(definitions["value"][0]["name"], "Other Action");

    if leave {
        desktop.press("Cancel").await;
        desktop.press("Close settings").await;
        desktop.press("Open settings").await;
        desktop.press("Settings section Project Actions").await;
        desktop.press("Other Action").await;
    }
    desktop.event("fixture.releaseRecovered", serde_json::Value::Null);
    if leave {
        desktop.expect_text("Other Action").await;
        desktop.control("Save").await;
        desktop.press("Back").await;
    }
    desktop.control("Other Action").await;
    assert!(desktop.controls("Deleted Action").is_empty());
    assert!(desktop.controls("Delete").is_empty());
    desktop.close().await;
    fixture.finish().await;
}

pub(super) async fn desktop_actions_open_session_terminals_by_width() {
    for (width, docked) in [(960, true), (700, false)] {
        desktop_actions_at_width(width, docked).await;
    }
}

pub(super) async fn desktop_action_receipts_follow_the_latest_presentation() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    let fixture = fixture().await;
    let nsh_engine::BundleCode::Source(mut source) = maka_workbench::bootstrap_bundle().code else {
        unreachable!();
    };
    source.insert_str(
        0,
        r#"
import { host as terminalFixtureNative } from 'maka/host';
import { host as terminalFixtureEvents } from 'nsh';
const hostPrototype = Object.getPrototypeOf(terminalFixtureNative);
const openSession = hostPrototype.session;
const heldReceipts = new Map();
let nextReceipt = 0;
let terminalPatched = false;
terminalFixtureEvents.on('fixture.releaseTerminal', ({ id }) => heldReceipts.get(id)?.());
hostPrototype.session = function(...args) {
  const scoped = openSession.apply(this, args);
  if (!terminalPatched) {
    terminalPatched = true;
    const scopePrototype = Object.getPrototypeOf(scoped);
    const terminal = scopePrototype.terminal;
    scopePrototype.terminal = async function(method, input) {
      const reply = await terminal.call(this, method, input);
      if (method === 'startWithCommand' && input.initialCommand.includes('held-action')) {
        const id = ++nextReceipt;
        const released = new Promise(resolve => heldReceipts.set(id, resolve));
        await terminalFixtureEvents.call('fixture.terminalHeld', { id });
        await released;
        heldReceipts.delete(id);
        setTimeout(() => terminalFixtureEvents.call('fixture.terminalDelivered', { id }), 0);
      }
      return reply;
    };
  }
  return scoped;
};
"#,
    );
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        nsh_terminal::size(
            nsh_terminal::DevicePixels(960),
            nsh_terminal::DevicePixels(640),
        ),
        nsh_core::platform::Appearance::Dark,
        Some((source, "en", "Focus message composer")),
    )
    .await;
    let held = Arc::new(AtomicU64::new(0));
    let delivered = Arc::new(AtomicU64::new(0));
    for (event, observed) in [
        ("fixture.terminalHeld", held.clone()),
        ("fixture.terminalDelivered", delivered.clone()),
    ] {
        desktop.host.handle(event, move |mut call| {
            let id = call.take_data()["id"].as_u64().unwrap();
            observed.store(id, Ordering::Relaxed);
            call.resolve(serde_json::Value::Null);
        });
    }
    desktop
        .press_until("Toggle session details", "Add Action")
        .await;
    desktop.press("Add Action").await;
    fill_action(&desktop, "Slow fixture", "echo held-action").await;
    desktop.press("Save").await;
    desktop.control("Run Action Slow fixture").await;
    desktop.press("Manage Actions…").await;
    save_new_action_in_settings(&desktop, "Fast fixture", "echo newer-action").await;
    desktop.press("Close settings").await;

    desktop.press("Run Action Slow fixture").await;
    desktop
        .until("first terminal receipt was not withheld", || {
            (held.load(Ordering::Relaxed) == 1).then_some(())
        })
        .await;
    desktop.press("Run Action Fast fixture").await;
    with_terminal_launch_diagnostics(
        &desktop.client,
        &fixture.session,
        terminal_contains(&desktop, "newer-action"),
    )
    .await;
    desktop.event("fixture.releaseTerminal", json!({ "id": 1 }));
    desktop
        .until("first terminal receipt was not released", || {
            (delivered.load(Ordering::Relaxed) == 1).then_some(())
        })
        .await;
    terminal_contains(&desktop, "newer-action").await;

    desktop.press("Run Action Slow fixture").await;
    desktop
        .until("third terminal receipt was not withheld", || {
            (held.load(Ordering::Relaxed) == 2).then_some(())
        })
        .await;
    desktop.press("Close workspace preview").await;
    desktop.event("fixture.releaseTerminal", json!({ "id": 2 }));
    desktop
        .until("third terminal receipt was not released", || {
            (delivered.load(Ordering::Relaxed) == 2).then_some(())
        })
        .await;
    assert!(desktop.controls("Close workspace preview").is_empty());
    let page = desktop
        .client
        .query(
            "terminal",
            "list",
            json!({ "sessionId": fixture.session, "offset": 0 }),
        )
        .await
        .unwrap();
    assert_eq!(
        page["value"]["resources"].as_array().unwrap().len(),
        3,
        "{page}"
    );
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_actions_at_width(width: i32, docked: bool) {
    let fixture = fixture().await;
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        nsh_terminal::size(
            nsh_terminal::DevicePixels(width),
            nsh_terminal::DevicePixels(640),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    desktop.new_draft().await;
    assert!(
        desktop.controls("Actions").is_empty() && desktop.controls("Add Action").is_empty(),
        "new chats must not offer Actions"
    );
    if !desktop.controls("Expand session browser").is_empty() {
        desktop.press("Expand session browser").await;
    }
    desktop.press("Open conversation NSH real Agent").await;
    let workspace = fixture.directory.path().join("workspace");
    let count = workspace.join("native-action-count");
    std::fs::create_dir(workspace.join("nested")).unwrap();
    #[cfg(unix)]
    let command = "echo start >> native-action-count; cd nested; printf 'Answer: '; read -r answer; printf 'result %s\\n' \"$answer\"";
    #[cfg(windows)]
    let command = "Add-Content -Encoding ascii native-action-count start; Set-Location nested; $answer = Read-Host 'Answer'; Write-Output \"result $answer\"";
    desktop.control("Toggle session details").await;
    assert!(desktop.controls("Add Action").is_empty());
    desktop
        .press_until("Toggle session details", "Add Action")
        .await;
    desktop.press("Add Action").await;
    fill_action(&desktop, "Native command A", command).await;
    desktop.press("Save").await;
    let first_action = "Run Action Native command A";
    let second_action = "Run Action Native command B";
    desktop.control(first_action).await;
    desktop.press("Manage Actions…").await;
    save_new_action_in_settings(&desktop, "Native command B", command).await;
    desktop.press("Close settings").await;
    desktop.control(first_action).await;
    desktop.control(second_action).await;
    assert!(desktop.controls("Actions").is_empty());
    desktop.artifact(&format!("actions-session-details-{width}"));
    desktop.press("Toggle session details").await;
    desktop
        .until("Actions should close with Session Details", || {
            (desktop.controls(first_action).is_empty()
                && desktop.controls(second_action).is_empty())
            .then_some(())
        })
        .await;
    desktop.press("Focus message composer").await;
    desktop.type_text("Draft before running the Action").await;
    desktop.press("Toggle session details").await;
    assert!(desktop.controls("Action terminals").is_empty());
    assert!(desktop.controls("Choose Action directory…").is_empty());
    desktop.press(second_action).await;
    desktop.control("Close workspace preview").await;
    with_terminal_launch_diagnostics(
        &desktop.client,
        &fixture.session,
        desktop.control("Release input"),
    )
    .await;
    terminal_contains(&desktop, "Answer:").await;
    let terminal = desktop.control("Focus terminal input").await;
    let composers = desktop.controls("Focus message composer");
    if docked {
        let [composer] = composers.as_slice() else {
            panic!("at {width}px the composer must be accessible beside the terminal");
        };
        assert!(terminal.center().x > composer.center().x);
    } else {
        assert!(
            composers.is_empty(),
            "at {width}px the terminal dialog must block the conversation"
        );
    }
    desktop.paste("first answer").await;
    desktop.key("enter", false);
    terminal_contains(&desktop, "result first answer").await;
    #[cfg(unix)]
    let ordinary = "echo ordinary > native-ordinary-terminal";
    #[cfg(windows)]
    let ordinary = "Set-Content -Encoding ascii native-ordinary-terminal ordinary";
    desktop.paste(ordinary).await;
    desktop.key("enter", false);
    let marker = workspace.join("nested/native-ordinary-terminal");
    desktop
        .until(
            "follow-up did not stay in the directory selected by the Action",
            || marker.is_file().then_some(()),
        )
        .await;
    assert!(!workspace.join("native-ordinary-terminal").exists());
    desktop.artifact(&format!("actions-session-output-{width}"));

    desktop.press("Close workspace preview").await;
    desktop.press(first_action).await;
    with_terminal_launch_diagnostics(
        &desktop.client,
        &fixture.session,
        desktop.control("Release input"),
    )
    .await;
    terminal_contains(&desktop, "Answer:").await;
    desktop.paste("second answer").await;
    desktop.key("enter", false);
    terminal_contains(&desktop, "result second answer").await;
    assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 2);
    desktop.press("Shell 1").await;
    terminal_contains(&desktop, "result first answer").await;
    let page = desktop
        .client
        .query(
            "terminal",
            "list",
            json!({"sessionId":fixture.session,"offset":0}),
        )
        .await
        .unwrap();
    let entries = page["value"]["resources"].as_array().unwrap();
    assert_eq!(entries.len(), 2, "{page}");
    assert_ne!(
        entries[0]["result"]["ref"], entries[1]["result"]["ref"],
        "{page}"
    );
    assert!(
        entries.iter().all(|entry| {
            entry["result"]["status"] == "running" && entry["result"]["exitCode"].is_null()
        }),
        "{page}"
    );
    desktop.press("Close workspace preview").await;
    desktop.artifact(&format!("actions-session-tab-closed-{width}"));
    desktop.press("Focus message composer").await;
    desktop.expect_text("Draft before running the Action").await;
    desktop.close().await;
    if docked {
        let reopened = Desktop::open(&fixture, &fixture.address).await;
        reopened
            .press_until("Toggle session details", second_action)
            .await;
        reopened.close().await;
    }
    fixture.finish().await;
}

pub(super) async fn terminal_actions_preserve_keyboard_input_and_original_output() {
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use maka_terminal_shell::terminal::handle_event;
    let fixture = fixture().await;
    let workspace = fixture.directory.path().join("workspace");
    let client = fixture.client().await;
    #[cfg(unix)]
    let command = "echo start >> tui-action-count; printf 'Answer: '; read -r answer; printf 'result %s\\n' \"$answer\"";
    #[cfg(windows)]
    let command = "Add-Content -Encoding ascii tui-action-count start; $answer = Read-Host 'Answer'; Write-Output \"result $answer\"";
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    support::wait_enabled_button(&mut view, "Focus message composer").await;
    support::click_button(&mut view, "Add Action").await;
    for (label, text) in [
        ("Action name", "Terminal command"),
        ("Action command", command),
    ] {
        support::wait_view_state(&mut view, |view, _| {
            view.input_context().is_some_and(|input| {
                input.editable && input.multiline == (label == "Action command")
            })
        })
        .await;
        handle_event(&mut view, Event::Paste(text.into()));
        support::wait_view_state(&mut view, |view, _| {
            view.input_context()
                .is_some_and(|input| input.text.as_deref() == Some(text))
        })
        .await;
        if label == "Action name" {
            handle_event(
                &mut view,
                Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
            );
        }
    }
    support::click_button(&mut view, "Save").await;
    support::wait_enabled_button(&mut view, "Run current Action Terminal command").await;
    let launcher = view.snapshot();
    let header = launcher.lines().next().unwrap();
    assert!(
        header
            .split_once("Terminal command")
            .is_some_and(|(_, after_name)| after_name.trim_start().starts_with('│')),
        "{header}"
    );
    support::evidence("actions-session-launcher", &launcher);
    support::click_button(&mut view, "Run current Action Terminal command").await;
    with_terminal_launch_diagnostics(
        &client,
        &fixture.session,
        support::wait_enabled_button(&mut view, "Release input"),
    )
    .await;
    support::wait_view_state(&mut view, |view, snapshot| {
        snapshot.contains("Answer:")
            && view.input_context().is_some_and(|input| {
                input.editable
                    && view.accessibility_snapshot().iter().any(|node| {
                        node.id == input.node && node.label == "Terminal keyboard input"
                    })
            })
    })
    .await;
    handle_event(&mut view, Event::Paste("first answer".into()));
    handle_event(
        &mut view,
        Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
    );
    let snapshot = support::wait_view(&mut view, |snapshot| {
        snapshot.contains("result first answer")
    })
    .await;
    support::evidence("actions-session-terminal-output", &snapshot);
    support::evidence_cells("actions-session-terminal-output", &view);

    #[cfg(unix)]
    let ordinary = "echo ordinary > tui-ordinary-terminal";
    #[cfg(windows)]
    let ordinary = "Set-Content -Encoding ascii tui-ordinary-terminal ordinary";
    handle_event(&mut view, Event::Paste(ordinary.into()));
    handle_event(
        &mut view,
        Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
    );
    support::wait_view_state(&mut view, |_, _| {
        workspace.join("tui-ordinary-terminal").is_file()
    })
    .await;
    support::click_button(&mut view, "Close workspace preview").await;
    support::wait_view_state(&mut view, |view, _| {
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Close workspace preview")
    })
    .await;
    support::click_button(&mut view, "Run current Action Terminal command").await;
    with_terminal_launch_diagnostics(
        &client,
        &fixture.session,
        support::wait_enabled_button(&mut view, "Release input"),
    )
    .await;
    support::wait_view_state(&mut view, |view, snapshot| {
        snapshot.contains("Answer:")
            && !snapshot.contains("result first answer")
            && view.input_context().is_some_and(|input| {
                input.editable
                    && view.accessibility_snapshot().iter().any(|node| {
                        node.id == input.node && node.label == "Terminal keyboard input"
                    })
            })
    })
    .await;
    handle_event(&mut view, Event::Paste("second answer".into()));
    handle_event(
        &mut view,
        Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
    );
    support::wait_view(&mut view, |snapshot| {
        snapshot.contains("result second answer")
    })
    .await;
    support::click_button(&mut view, "Shell 1").await;
    support::wait_view(&mut view, |snapshot| {
        snapshot.contains("result first answer")
    })
    .await;
    assert_eq!(
        std::fs::read_to_string(workspace.join("tui-action-count"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["start", "start"]
    );
    let page = client
        .query(
            "terminal",
            "list",
            json!({"sessionId":fixture.session,"offset":0}),
        )
        .await
        .unwrap();
    let entries = page["value"]["resources"].as_array().unwrap();
    assert_eq!(entries.len(), 2, "{page}");
    assert_ne!(
        entries[0]["result"]["ref"], entries[1]["result"]["ref"],
        "{page}"
    );
    assert!(
        entries.iter().all(|entry| {
            entry["result"]["status"] == "running" && entry["result"]["exitCode"].is_null()
        }),
        "{page}"
    );
    drop(view);
    bindings.close().await.unwrap();
    client.close().await.unwrap();
    fixture.finish().await;
}
