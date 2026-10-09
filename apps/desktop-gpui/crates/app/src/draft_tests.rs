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

//! UI integration tests of the new task's draft: New task opens it without
//! asking the Host, the composer's project picker chooses where the task
//! goes, and the first message creates the task, then sends; a message the
//! Host does not take deletes the task again. The production window
//! content, against the scripted Host of `tests.rs`.

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use conversation::ComposerAction;
use futures_lite::future::Boxed;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, TestAppContext};
use host_protocol::HostOperationErrorCode;
use serde_json::{Value, json};
use shared::copy;
use shared::domain_element_id;
use workspace::{
    HostRequestError, HostRequester, ProjectCatalogError, ProjectCatalogSource, ProjectEntry,
    UnavailableProjectCatalog, WindowHost,
};

use crate::tests::{DEMO_PATH, Harness, ScriptedHost, session, session_in_project, settle};

/// A project catalog the test can change; the window reads it whenever it
/// reloads.
#[derive(Clone, Default)]
struct Projects(Arc<Mutex<Vec<ProjectEntry>>>);

impl Projects {
    fn new(projects: Vec<ProjectEntry>) -> Self {
        Self(Arc::new(Mutex::new(projects)))
    }

    fn add(&self, project: ProjectEntry) {
        self.0.lock().expect("projects").insert(0, project);
    }
}

impl ProjectCatalogSource for Projects {
    fn list(&self, _: &HostRequester) -> Boxed<Result<Vec<ProjectEntry>, ProjectCatalogError>> {
        let projects = self.0.lock().expect("projects").clone();
        Box::pin(async move { Ok(projects) })
    }
}

/// Demo (where the window's tasks run), Other, Moved (its folder is gone),
/// and Old (archived).
fn four_projects() -> Projects {
    Projects::new(vec![
        ProjectEntry::new("p1", "Demo", DEMO_PATH),
        ProjectEntry::new("p2", "Other", "/work/other"),
        ProjectEntry::new("p3", "Moved", "/work/moved").with_available(false),
        ProjectEntry::new("p4", "Old", "/work/old").with_archived(true),
    ])
}

/// One page of `connection.catalog.query`: the Z.ai coding plan with
/// GLM-4.6 (the catalog default, no thinking levels) and GLM-5.3-Flash
/// (low, high, max), as the person's own catalog lists them.
pub(crate) fn connection_catalog() -> Value {
    json!({"kind": "page", "revision": 1,
           "defaultTarget": {"connectionId": "c-zai", "modelId": "glm-4.6"},
           "connectionCount": 1,
           "items": [
               {"kind": "connection", "connectionIndex": 0, "connectionId": "c-zai",
                "revision": 1, "slug": "zai-coding-plan", "name": "Z.ai Coding Plan",
                "providerType": "zai", "enabled": true, "enabledModelIdCount": 2,
                "modelCount": 0, "catalogEntryCount": 2},
               {"kind": "enabled_model_id", "connectionIndex": 0, "itemIndex": 0,
                "modelId": "glm-4.6"},
               {"kind": "enabled_model_id", "connectionIndex": 0, "itemIndex": 1,
                "modelId": "glm-5.3-flash"},
               {"kind": "catalog_entry", "connectionIndex": 0, "itemIndex": 0,
                "entry": {"id": "glm-4.6", "displayName": "GLM-4.6",
                          "canUseAsChatDefault": true, "isDefault": true,
                          "supportsVision": false, "thinkingLevels": []}},
               {"kind": "catalog_entry", "connectionIndex": 0, "itemIndex": 1,
                "entry": {"id": "glm-5.3-flash", "displayName": "GLM-5.3-Flash",
                          "canUseAsChatDefault": true, "isDefault": false,
                          "supportsVision": false,
                          "thinkingLevels": ["low", "high", "max"]}}
           ],
           "nextCursor": null})
}

/// An item of the open popup menu, by position.
fn item(ix: u64) -> ElementId {
    ElementId::Integer(ix)
}

fn row(id: &str) -> ElementId {
    domain_element_id("session-row", id)
}

fn new_task(harness: &Harness, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| window.press("secondary-n", cx));
}

/// Types `text` into the draft and presses Enter.
fn send(harness: &Harness, text: &str, cx: &mut TestAppContext) {
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft, cx);
        window.input(text, cx);
        window.press("enter", cx);
    });
}

fn request_count(harness: &Harness) -> usize {
    harness.transport.requests.lock().expect("requests").len()
}

/// The id `session.create` named, for the `ix`th create.
fn created_id(harness: &Harness, ix: usize) -> String {
    harness.transport.requests("session.create")[ix]["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_owned()
}

#[gpui_kit::test]
fn new_task_opens_a_draft_and_asks_nothing_of_the_host(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(row("s1"), cx);
        assert_eq!(window.find("session-title").label(), Some("Alpha"));
        assert!(window.try_find("composer-project").is_none(), "a task shows no project picker");
    });
    let before = request_count(&harness);
    // ⌘N from the task list, as a person would.
    new_task(&harness, cx);
    let asked: Vec<String> = harness.transport.requests.lock().expect("requests")[before..]
        .iter()
        .map(|(operation, _)| operation.clone())
        .collect();
    assert_eq!(asked, ["subscription.close"], "only the task it leaves is let go");
    assert!(harness.drafting(cx));
    assert_eq!(harness.selected(cx), None);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(row("s1")).selected(), Some(false), "no task is selected");
        assert_eq!(window.find("session-title").label(), Some(copy::NEW_TASK.en()));
        assert!(window.try_find("project-info").is_none(), "no folder button before it");
        assert!(window.find("empty-state").visible());
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "ready to type");
        assert_eq!(
            window.find("composer-project").label(),
            Some("Choose project: Demo"),
            "the chip says where the task runs"
        );
    });
    // The sidebar's button opens the same draft, and still asks nothing.
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness.with_window(cx, |window, cx| window.click("new-session", cx));
    assert!(harness.drafting(cx));
    assert_eq!(*harness.transport.creates.lock().expect("creates"), 0);
    assert!(harness.transport.requests("session.create").is_empty());
}

#[gpui_kit::test]
fn the_first_message_creates_the_task_with_the_drafts_choices_then_sends_it(
    cx: &mut TestAppContext,
) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    transport.reply("connection.catalog.query", Ok(connection_catalog()));
    let create = transport.hold("session.create");
    let harness = Harness::with_transport(transport, cx);
    new_task(&harness, cx);
    // The draft starts on the catalog's default model; a choice is the
    // draft's own and asks the Host nothing.
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("composer-model").label(), Some("Model: GLM-4.6"));
        window.click("composer-model", cx);
        window.within("popup-menu").click(item(2), cx);
    });
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("composer-model").label(), Some("Model: GLM-5.3-Flash"));
        window.click("composer-permission-mode", cx);
        window.within("popup-menu").click(item(2), cx);
    });
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("composer-permission-mode").label(),
            Some("Permission mode: Full access")
        );
    });
    assert!(harness.transport.requests("session.configuration.update").is_empty());

    send(&harness, "hello", cx);
    let action = |cx: &mut TestAppContext| {
        harness.workbench.read_with(cx, |workbench, cx| workbench.composer().read(cx).action(cx))
    };
    assert!(
        matches!(action(cx), ComposerAction::Send { busy: true, .. }),
        "Send shows progress while the task is created"
    );
    // A second Enter sends nothing more.
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    let creates = harness.transport.requests("session.create");
    assert_eq!(creates.len(), 1, "one create");
    assert!(harness.transport.sent().is_empty(), "the message waits for the task");
    assert_eq!(creates[0]["workspace"], json!({"kind": "project", "projectId": "p1"}));
    assert_eq!(
        creates[0]["modelTarget"],
        json!({"kind": "explicit", "connectionId": "c-zai",
               "connectionSlug": "zai-coding-plan", "model": "glm-5.3-flash"})
    );
    assert_eq!(creates[0]["permissionMode"], "bypass");
    assert_eq!(harness.draft(cx), "hello", "kept until the Host takes the message");

    let id = created_id(&harness, 0);
    create.try_send(Ok(session_in_project(&id, "New chat", DEMO_PATH))).expect("create");
    settle(cx);
    assert_eq!(harness.transport.sent(), ["hello"]);
    let submit = &harness.transport.requests("turn.message.submit")[0];
    assert_eq!(submit["sessionId"], id.as_str(), "into the new task");
    // Created, then observed, then sent into (Desktop's order).
    let requests = harness.transport.requests.lock().expect("requests").clone();
    let at = |name: &str| {
        requests
            .iter()
            .position(|(operation, input)| {
                operation == name
                    && (input["sessionId"] == id.as_str()
                        || input["subscriptionId"] == format!("sub-{id}").as_str())
            })
            .expect(name)
    };
    assert!(at("session.create") < at("subscription.open"));
    assert!(at("subscription.ready") < at("turn.message.submit"), "submitted once observed");

    assert_eq!(harness.selected(cx).as_deref(), Some(id.as_str()), "the new task is selected");
    assert!(!harness.drafting(cx));
    assert_eq!(harness.draft(cx), "", "the composer clears as for any send");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(row(&id)).selected(), Some(true));
        assert!(window.try_find("composer-project").is_none(), "the picker goes with the draft");
        assert!(window.find("project-info").visible(), "the header says where it runs");
    });
    // The next draft starts empty.
    new_task(&harness, cx);
    assert_eq!(harness.draft(cx), "");
}

#[gpui_kit::test]
fn a_refused_first_message_deletes_the_new_task_and_keeps_the_text(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    transport.reply(
        "turn.message.submit",
        Err(HostRequestError::Operation {
            operation: "turn.message.submit",
            code: HostOperationErrorCode::ModelUnavailable,
            message: "no model is configured".into(),
        }),
    );
    let harness = Harness::with_transport(transport, cx);
    new_task(&harness, cx);
    send(&harness, "hello", cx);
    assert_eq!(harness.transport.sent(), ["hello"]);
    let id = created_id(&harness, 0);
    assert_eq!(
        harness.transport.requests("session.remove"),
        [json!({"sessionId": id, "expectedRevision": 1})],
        "the task made for the message goes with it"
    );
    assert!(harness.drafting(cx), "the draft shows again");
    assert_eq!(harness.draft(cx), "hello", "with the text to send again");
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(row(&id)).is_none(), "the list no longer shows it");
        assert_eq!(
            window.find("composer-error").label(),
            Some("Couldn’t send the message. No model is configured.")
        );
        assert!(window.find("composer-project").visible());
    });
}

#[gpui_kit::test]
fn a_failed_create_keeps_the_text_and_says_why(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    transport.reply(
        "session.create",
        Err(HostRequestError::Operation {
            operation: "session.create",
            code: HostOperationErrorCode::InvalidRequest,
            message: "the project folder is gone".into(),
        }),
    );
    let harness = Harness::with_transport(transport, cx);
    new_task(&harness, cx);
    send(&harness, "hello", cx);
    assert_eq!(harness.transport.requests("session.create").len(), 1);
    assert!(harness.transport.sent().is_empty(), "nothing to send into");
    assert!(harness.transport.requests("session.remove").is_empty());
    assert!(harness.drafting(cx));
    assert_eq!(harness.draft(cx), "hello");
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("composer-error").label(),
            Some("Couldn’t create a task. The project folder is gone.")
        );
    });
}

#[gpui_kit::test]
fn the_project_picker_sets_where_the_new_task_goes(cx: &mut TestAppContext) {
    let harness = Harness::with_projects(
        ScriptedHost::new(vec![session_in_project("s1", "Alpha", DEMO_PATH)]),
        WindowHost::Local,
        Rc::new(four_projects()),
        cx,
    );
    new_task(&harness, cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("composer-project").label(), Some("Choose project: Demo"));
        window.click("composer-project", cx);
    });
    harness.with_window(cx, |window, cx| {
        let choice = |id: &str| domain_element_id("project-choice", id);
        let mut menu = window.within("popup-menu");
        assert_eq!(menu.find(choice("p1")).label(), Some("Demo"));
        assert!(menu.find(choice("p3")).visible(), "a missing folder is listed");
        assert!(menu.try_find(choice("p4")).is_none(), "archived projects are not");
        let labels: Vec<_> =
            (4..6).map(|ix| menu.find(item(ix)).label().map(str::to_owned)).collect();
        assert_eq!(
            labels,
            [Some(copy::NEW_PROJECT.en().to_owned()), Some(copy::MANAGE_PROJECTS.en().to_owned())]
        );
        // The missing one cannot be chosen.
        menu.click(item(2), cx);
    });
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("composer-project").label(), Some("Choose project: Demo"));
        if window.try_find("popup-menu").is_none() {
            window.click("composer-project", cx);
        }
    });
    harness.with_window(cx, |window, cx| window.within("popup-menu").click(item(1), cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("popup-menu").is_none());
        assert_eq!(
            window.find("composer-project").label(),
            Some("Choose project: Other"),
            "the chip follows the choice at once"
        );
    });
    send(&harness, "hello", cx);
    let creates = harness.transport.requests("session.create");
    assert_eq!(creates[0]["workspace"], json!({"kind": "project", "projectId": "p2"}));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("composer-project").is_none(), "gone once the task exists");
    });
    // The next draft starts from the same project.
    new_task(&harness, cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("composer-project").label(), Some("Choose project: Other"));
    });
}

#[gpui_kit::test]
fn manage_projects_opens_settings_at_projects_from_the_project_picker(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    new_task(&harness, cx);
    harness.with_window(cx, |window, cx| window.click("composer-project", cx));
    harness.with_window(cx, |window, cx| {
        // Demo, a separator, New project…, Manage projects….
        let mut menu = window.within("popup-menu");
        assert_eq!(menu.find(item(3)).label(), Some(copy::MANAGE_PROJECTS.en()));
        menu.click(item(3), cx);
    });
    harness.with_window(cx, |window, _| {
        assert!(window.find("settings-page").visible(), "settings opened");
        assert_eq!(
            window.find("settings-title").label(),
            Some(copy::settings::SECTION_WORKSPACE.en())
        );
        let row = domain_element_id("project-row", "p1");
        assert_eq!(window.find(row).label(), Some("Demo, /work/demo"));
    });
}

/// With no project to start the task in, Send asks for a folder, as New
/// task did before the draft; a Host without a project catalog uses the
/// folder as it is, and the message goes once it is chosen.
#[gpui_kit::test]
fn sending_with_no_project_asks_for_a_folder_and_sends_there(cx: &mut TestAppContext) {
    let harness = Harness::with_projects(
        ScriptedHost::new(vec![session("s1", "Alpha", "/work/alpha", "active")]),
        WindowHost::Local,
        Rc::new(UnavailableProjectCatalog),
        cx,
    );
    new_task(&harness, cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("composer-project").label(),
            Some(copy::CHOOSE_PROJECT.en()),
            "no project to name"
        );
    });
    send(&harness, "hello", cx);
    assert!(cx.did_prompt_for_paths(), "no project: Send asks for a folder");
    cx.simulate_path_prompt_response(|_| None);
    settle(cx);
    assert!(
        harness.transport.requests("session.create").is_empty(),
        "cancelled: nothing is created, not even in the last task's folder"
    );
    assert_eq!(harness.draft(cx), "hello");
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    cx.simulate_path_prompt_response(|options| {
        assert!(options.directories && !options.files && !options.multiple);
        Some(vec![PathBuf::from("/work/picked")])
    });
    settle(cx);
    let creates = harness.transport.requests("session.create");
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0]["workspace"], json!({"kind": "host_path", "path": "/work/picked"}));
    assert_eq!(harness.transport.sent(), ["hello"], "then the message goes");
    assert_eq!(harness.selected(cx), Some(created_id(&harness, 0)));
}

/// On a Host that keeps a project catalog, the chosen folder is registered
/// as a project first, and the task goes into it; New project… in the
/// picker does the same without sending.
#[gpui_kit::test]
fn a_chosen_folder_becomes_the_new_tasks_project(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/alpha", "active")]);
    transport.reply(
        "project.catalog.mutate",
        Ok(json!({"kind": "project", "project": {"id": "proj-1", "aliases": [],
                  "name": "picked", "locationCount": 1, "archivedAt": null,
                  "available": true}})),
    );
    let projects = Projects::default();
    let harness =
        Harness::with_projects(transport, WindowHost::Local, Rc::new(projects.clone()), cx);
    new_task(&harness, cx);
    // No project is listed: the picker asks for a folder at once.
    harness.with_window(cx, |window, cx| window.click("composer-project", cx));
    assert!(cx.did_prompt_for_paths());
    // The Host lists the project from now on.
    projects.add(ProjectEntry::new("proj-1", "picked", "/work/picked"));
    cx.simulate_path_prompt_response(|_| Some(vec![PathBuf::from("/work/picked")]));
    settle(cx);
    assert_eq!(
        harness.transport.requests("project.catalog.mutate"),
        [json!({"kind": "register", "path": "/work/picked", "prefer": true})]
    );
    assert!(harness.transport.requests("session.create").is_empty(), "New project sends nothing");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("composer-project").label(), Some("Choose project: picked"));
    });
    send(&harness, "hello", cx);
    let creates = harness.transport.requests("session.create");
    assert_eq!(creates[0]["workspace"], json!({"kind": "project", "projectId": "proj-1"}));
    assert_eq!(harness.transport.sent(), ["hello"]);
}

/// Each task keeps its own draft and so does the new task, as in Desktop:
/// text written for the new task waits while another task shows, and comes
/// back with New task.
#[gpui_kit::test]
fn the_new_tasks_text_waits_while_another_task_shows(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    let draft = harness.draft_id(cx);
    let write = |text: &str, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| {
            window.click(draft.clone(), cx);
            window.input(text, cx);
        });
    };
    new_task(&harness, cx);
    write("a plan", cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    assert_eq!(harness.draft(cx), "", "the task's own draft");
    write("for Alpha", cx);
    new_task(&harness, cx);
    assert_eq!(harness.draft(cx), "a plan", "the new task's text is back");
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    assert_eq!(harness.draft(cx), "for Alpha");
    assert!(harness.transport.requests("session.create").is_empty());
}

/// Another task chosen while the new one is opened for its first message:
/// the message stays in the new task's draft and the task made for it is
/// deleted again (Desktop's `discardUnsentSession` when the selection moved
/// on).
#[gpui_kit::test]
fn choosing_another_task_before_the_message_goes_deletes_the_new_task(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/a", "active")], cx);
    new_task(&harness, cx);
    let open = harness.transport.hold("subscription.open");
    send(&harness, "hello", cx);
    let id = created_id(&harness, 0);
    assert_eq!(harness.selected(cx).as_deref(), Some(id.as_str()));
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    drop(open);
    settle(cx);
    assert!(harness.transport.sent().is_empty(), "the message never went");
    assert_eq!(
        harness.transport.requests("session.remove"),
        [json!({"sessionId": id, "expectedRevision": 1})]
    );
    assert_eq!(harness.selected(cx).as_deref(), Some("s1"));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(row(&id)).is_none());
        assert!(window.try_find("composer-error").is_none(), "nothing failed on this task");
    });
    assert_eq!(harness.draft(cx), "");
    new_task(&harness, cx);
    assert_eq!(harness.draft(cx), "hello", "the new task's draft keeps it");
}

/// `runtime.policy.query` with the chat default permission mode `mode`.
fn policy(mode: &str) -> Value {
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../host-protocol/fixtures/runtime_policy_query.response.json"
    ))
    .expect("fixture");
    let mut policy = fixture["result"]["policy"].take();
    policy["chatDefaults"] = json!({"permissionMode": mode});
    json!({"revision": 1, "policy": policy})
}

/// The draft's permission mode starts at the Host's default for new tasks
/// and is sent with the task; a mode picked for one new task is not kept
/// for the next (Desktop's `clearNewChatPermissionChoice`).
#[gpui_kit::test]
fn a_new_task_starts_in_the_hosts_default_permission_mode(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    transport.reply("runtime.policy.query", Ok(policy("bypass")));
    let harness = Harness::with_transport(transport, cx);
    let mode = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            window.find("composer-permission-mode").label().map(str::to_owned)
        })
    };
    new_task(&harness, cx);
    assert_eq!(mode(cx).as_deref(), Some("Permission mode: Full access"));
    send(&harness, "one", cx);
    assert_eq!(harness.transport.requests("session.create")[0]["permissionMode"], "bypass");

    new_task(&harness, cx);
    harness.with_window(cx, |window, cx| {
        window.click("composer-permission-mode", cx);
        window.within("popup-menu").click(item(0), cx);
    });
    assert_eq!(mode(cx).as_deref(), Some("Permission mode: Read only"));
    send(&harness, "two", cx);
    assert_eq!(harness.transport.requests("session.create")[1]["permissionMode"], "explore");
    new_task(&harness, cx);
    assert_eq!(mode(cx).as_deref(), Some("Permission mode: Full access"), "the default again");
}

/// The draft's thinking level follows its model: Model default and the
/// levels GLM-5.3-Flash offers, none for GLM-4.6; a model switch starts
/// from the model's own default; the choice goes with `session.create`,
/// and untouched the level is left out.
#[gpui_kit::test]
fn the_drafts_thinking_level_follows_its_model_and_goes_with_the_task(cx: &mut TestAppContext) {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/a", "active")]);
    transport.reply("connection.catalog.query", Ok(connection_catalog()));
    let harness = Harness::with_transport(transport, cx);
    let thinking = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            window
                .try_find("composer-thinking-level")
                .map(|chip| chip.label().map(str::to_owned).unwrap_or_default())
        })
    };
    let choose = |chip: &'static str, ix: u64, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| {
            window.click(chip, cx);
            window.within("popup-menu").click(item(ix), cx);
        });
    };
    new_task(&harness, cx);
    assert_eq!(thinking(cx), None, "GLM-4.6 offers no level");
    choose("composer-model", 2, cx);
    assert_eq!(thinking(cx).as_deref(), Some("Thinking level: Model default"));
    harness.with_window(cx, |window, cx| {
        window.click("composer-thinking-level", cx);
        let menu = window.within("popup-menu");
        let labels: Vec<Option<String>> =
            (0..4).map(|ix| menu.find(item(ix)).label().map(str::to_owned)).collect();
        assert_eq!(
            labels,
            ["Model default", "Low", "High", "Maximum"].map(|label| Some(label.to_owned()))
        );
        window.within("popup-menu").click(item(2), cx);
    });
    assert_eq!(thinking(cx).as_deref(), Some("Thinking level: High"));
    // Another model drops it; coming back starts from the default.
    choose("composer-model", 1, cx);
    assert_eq!(thinking(cx), None);
    choose("composer-model", 2, cx);
    assert_eq!(thinking(cx).as_deref(), Some("Thinking level: Model default"));
    send(&harness, "one", cx);
    let create = &harness.transport.requests("session.create")[0];
    assert!(create.get("thinkingLevel").is_none(), "untouched: the model's preference");

    new_task(&harness, cx);
    choose("composer-thinking-level", 3, cx);
    assert_eq!(thinking(cx).as_deref(), Some("Thinking level: Maximum"));
    assert!(harness.transport.requests("session.configuration.update").is_empty());
    send(&harness, "two", cx);
    let create = &harness.transport.requests("session.create")[1];
    assert_eq!(create["thinkingLevel"], "max");
    assert_eq!(create["modelTarget"]["model"], "glm-5.3-flash");
}

/// A project heading's "+" (the list grouped by project) opens the new
/// task's draft in that project: the picker names it, and the composer
/// takes focus.
#[gpui_kit::test]
fn a_project_headings_plus_opens_the_draft_there(cx: &mut TestAppContext) {
    let harness = Harness::with_projects(
        ScriptedHost::new(vec![session_in_project("s1", "Alpha", DEMO_PATH)]),
        WindowHost::Local,
        Rc::new(four_projects()),
        cx,
    );
    let draft = harness.draft_id(cx);
    harness.workbench.update(cx, |workbench, cx| {
        workbench
            .sidebar()
            .update(cx, |sidebar, cx| sidebar.set_grouping(session::TaskGrouping::ByProject, cx))
    });
    let before = request_count(&harness);
    harness.with_window(cx, |window, cx| {
        window.click(domain_element_id("session-group-new-task", "p2"), cx);
    });
    assert!(harness.drafting(cx));
    assert!(
        harness.transport.requests.lock().expect("requests")[before..]
            .iter()
            .all(|(operation, _)| operation == "subscription.close"),
        "nothing but letting the shown task go"
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("composer-project").label(), Some("Choose project: Other"));
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
    });
}
