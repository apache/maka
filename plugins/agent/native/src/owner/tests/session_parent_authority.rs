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

use super::*;
use maka_agent_facts::event::{Fact, ToolOutcome};
use maka_agent_facts::interaction::{
    InteractionAnswer, InteractionOutcome, InteractionRecord, InteractionRequest, PermissionRequest,
};
use maka_agent_facts::tool_output::DurableToolProjection;
use maka_host_runtime::application::ServiceTarget;
use maka_sandbox::{
    Network,
    filesystem::{Access, Rule},
    grant,
};

pub(super) async fn fixture(listener: &TcpListener) -> Fixture {
    Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |settings| {
            settings.tools = [
                ("create", "SessionCreate"),
                ("fork", "SessionFork"),
                ("editQueue", "SessionEditQueue"),
                ("send", "SessionSend"),
                ("metadata", "SessionUpdate"),
                ("respond", "SessionRespond"),
            ]
            .into_iter()
            .map(|(method, name)| contract::ServiceTool {
                nestable: false,
                input: contract::ToolInput::Json,
                presentation: None,
                title: None,
                result: contract::ToolResult::Json,
                confirmation: contract::ToolConfirmation::Preapproved,
                name: name.into(),
                description: "Manage child conversations.".into(),
                target: ServiceTarget::Export {
                    name: EXPORT.into(),
                },
                method: method.into(),
            })
            .collect();
        },
    )
    .await
}

pub(super) async fn start(f: &Fixture, listener: &TcpListener, session: &str) -> TcpStream {
    f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    socket
}

async fn tool(listener: &TcpListener, socket: &mut TcpStream, name: &str, input: Value) -> String {
    service_tools::named_tool_response(socket, name, input).await;
    let (mut next, _) = listener.accept().await.unwrap();
    let sent = request(&mut next).await;
    *socket = next;
    sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .to_owned()
}

pub(super) async fn create_child(
    listener: &TcpListener,
    socket: &mut TcpStream,
    workspace_session: &str,
    title: &str,
) -> Value {
    let result = tool(
        listener,
        socket,
        "SessionCreate",
        json!({
            "title":title, "labels":[],
            "workspace":{"kind":"session","sessionId":workspace_session},
        }),
    )
    .await;
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["kind"], "created", "{result}");
    result["session"].clone()
}

async fn observe(f: &Fixture, session: &str) -> Value {
    f.query("observe", json!({"sessionId":session}))
        .await
        .unwrap()["session"]
        .clone()
}

pub(super) async fn set_policy(f: &Fixture, session: &str, access: &str, requests: bool) {
    let session = observe(f, session).await;
    let result = f.mutation(2, "metadata", json!({
        "sessionId":session["id"], "expectedRevision":session["revision"],
        "title":session["title"], "labels":[],
        "permissions":{"settings":{"access":access,"requestPermissions":requests},"revokeGrants":false},
    }), Uuid::new_v4()).await.unwrap();
    assert_eq!(result["kind"], "committed", "{result}");
}

pub(super) async fn establish_permissions(
    f: &Fixture,
    session: &str,
    id: &str,
    permissions: grant::Permissions,
) -> InteractionRecord {
    let store = f.session(session).await;
    let projection = store
        .session_projection::<maka_agent_api::session::StoredSessionConfiguration>(session)
        .await
        .unwrap()
        .unwrap();
    let binding = projection
        .session
        .workspace_binding
        .as_ref()
        .unwrap()
        .stamp();
    let configuration = &projection.session.configuration;
    let basis = maka_agent_facts::workspace::PermissionBasis {
        boundary_revision: configuration
            .workspace
            .boundary_revision(configuration.boundary_revision, binding)
            .unwrap(),
        binding,
    };
    let invocation = projection.root_turn.unwrap().invocation;
    let record = InteractionRecord {
        session_id: session.into(),
        turn_id: invocation.turn_id.clone(),
        run_id: invocation.run_id.clone(),
        request_id: id.into(),
        created_at: 1,
        request: InteractionRequest::Permissions {
            tool_use_id: Some("permission_tool".into()),
            basis,
            request: PermissionRequest {
                reason: "Write the requested result.".into(),
                command: None,
                permissions,
            },
        },
        outcome: None,
    };
    assert!(
        store
            .establish_run_interaction(&invocation, &record)
            .await
            .unwrap()
            .matches
    );
    record
}

pub(super) fn allow(permissions: grant::Permissions) -> InteractionAnswer {
    InteractionAnswer::Permissions {
        decision: grant::Decision::Allow {
            permissions,
            scope: grant::Scope::Once,
        },
    }
}

pub(super) fn respond_input(record: &InteractionRecord, answer: &InteractionAnswer) -> Value {
    json!({"sessionId":record.session_id, "requestId":record.request_id, "answer":answer})
}

async fn assert_pending(f: &Fixture, record: &InteractionRecord) {
    let current: InteractionRecord = serde_json::from_value(
        f.query(
            "interaction",
            json!({
                "sessionId":record.session_id,"requestId":record.request_id,
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(&current, record);
}

async fn settled_self_response(f: &Fixture, record: &InteractionRecord) -> Value {
    let store = f.session(&record.session_id).await;
    let mut commits = store.subscribe_commits().unwrap();
    loop {
        let facts = service_tools::facts(f, &record.session_id).await;
        let operation = facts.iter().find_map(|fact| match fact {
            Fact::ToolDispatched {
                operation_id,
                name,
                input,
                ..
            } if name == "SessionRespond" && input["requestId"] == record.request_id => {
                Some(operation_id)
            }
            _ => None,
        });
        if let Some(operation) = operation {
            if let Some(outcome) = facts.iter().find_map(|fact| match fact {
                Fact::ToolSettled {
                    operation_id,
                    outcome,
                } if operation_id == operation => Some(outcome),
                _ => None,
            }) {
                let ToolOutcome::Succeeded {
                    model_projection: DurableToolProjection::Json { value },
                    ..
                } = outcome
                else {
                    panic!("self response must return a typed decision: {outcome:?}");
                };
                return value.clone();
            }
        }
        commits.changed().await.unwrap();
    }
}

pub(super) async fn pending_escalation(f: &Fixture, parent: &str) -> InteractionRecord {
    let store = f.session(parent).await;
    let mut commits = store.subscribe_commits().unwrap();
    loop {
        if let Some(record) = store
            .pending_interactions(parent)
            .await
            .unwrap()
            .into_iter()
            .find(|record| matches!(record.request, InteractionRequest::SessionApproval { .. }))
        {
            return record;
        }
        commits.changed().await.unwrap();
    }
}

#[tokio::test]
async fn model_child_inherits_caller_policy_not_workspace_session_or_installation() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let caller = f.create("True parent").await;
        let other = f.create("Workspace reference, not parent").await;
        set_policy(&f, &caller, "danger_full_access", false).await;
        set_policy(&f, &other, "read_only", true).await;
        let mut socket = start(&f, &listener, &caller).await;
        let child = create_child(&listener, &mut socket, &other, "Inherited child").await;
        let child = observe(&f, child["id"].as_str().unwrap()).await;
        assert_eq!(child["parentSessionId"], caller);
        assert_eq!(
            child["permissions"],
            json!({
                "access":"danger_full_access","requestPermissions":false,
            })
        );
        let roots = f
            .query(
                "list",
                json!({
                    "filter":"all", "rootsOnly":true, "position":{"kind":"start"},
                }),
            )
            .await
            .unwrap();
        let roots = roots["sessions"].as_array().unwrap();
        assert!(roots.iter().any(|session| session["id"] == caller));
        assert!(
            roots
                .iter()
                .all(|session| session["parentSessionId"].is_null())
        );
        let children = f
            .query(
                "list",
                json!({
                    "filter":"all", "scope":{"kind":"children","sessionId":caller},
                    "position":{"kind":"start"},
                }),
            )
            .await
            .unwrap();
        assert!(
            children["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|session| session["id"] == child["id"])
        );
        let root = f
            .mutation(
                2,
                "create",
                json!({
                    "title":"User root", "labels":[],
                    "workspace":{"kind":"session","sessionId":caller},
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(root["kind"], "created");
        let root = observe(&f, root["session"]["id"].as_str().unwrap()).await;
        assert_eq!(root["parentSessionId"], Value::Null);
        assert_eq!(
            root["permissions"],
            json!({
                "access":"workspace_write","requestPermissions":true,
            })
        );
        response(&mut socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .expect("caller policy inheritance timed out");
}

#[tokio::test]
async fn model_parent_can_answer_only_direct_children_and_cannot_edit_permissions() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let grandparent = f.create("Grandparent").await;
        let mut grandparent_socket = start(&f, &listener, &grandparent).await;
        let parent = create_child(&listener, &mut grandparent_socket, &grandparent, "Parent").await;
        let parent = parent["id"].as_str().unwrap().to_owned();
        let sibling = create_child(&listener, &mut grandparent_socket, &grandparent, "Sibling").await;
        let sibling = sibling["id"].as_str().unwrap().to_owned();
        let unrelated = f.create("Unrelated").await;
        let mut parent_socket = start(&f, &listener, &parent).await;
        let child = create_child(&listener, &mut parent_socket, &parent, "Child").await;
        let child = child["id"].as_str().unwrap().to_owned();
        let mut child_socket = start(&f, &listener, &child).await;
        let mut sibling_socket = start(&f, &listener, &sibling).await;
        let mut unrelated_socket = start(&f, &listener, &unrelated).await;
        let permissions = grant::Permissions {
            filesystem: vec![Rule::exact(&f.workspace.join("result"), Access::Write)],
            network: Network::Denied,
        };
        let answer = InteractionAnswer::Permissions {
            decision: grant::Decision::Allow { permissions: permissions.clone(), scope: grant::Scope::Turn },
        };
        let own = establish_permissions(&f, &parent, "self_request", permissions.clone()).await;
        service_tools::named_tool_response(&mut parent_socket, "SessionRespond", respond_input(&own, &answer)).await;
        let result = settled_self_response(&f, &own).await;
        assert_eq!(result, json!({"kind":"rejected","reason":"not_your_child"}));
        assert_pending(&f, &own).await;
        // The synthetic caller request is independent of the denied tool. A
        // human closes it before this run can publish its next model request.
        let closed = f.mutation(2, "respond", respond_input(&own, &InteractionAnswer::Permissions {
            decision: grant::Decision::Deny,
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(closed["kind"], "recorded");
        let (mut next, _) = listener.accept().await.unwrap();
        request(&mut next).await;
        parent_socket = next;
        for (target, id) in [(&sibling, "sibling_request"), (&unrelated, "unrelated_request")] {
            let record = establish_permissions(&f, target, id, permissions.clone()).await;
            let result = tool(&listener, &mut parent_socket, "SessionRespond",
                respond_input(&record, &answer)).await;
            assert_eq!(serde_json::from_str::<Value>(&result).unwrap(),
                json!({"kind":"rejected","reason":"not_your_child"}));
            assert_pending(&f, &record).await;
        }
        let record = establish_permissions(&f, &child, "child_request", permissions).await;
        let result = tool(&listener, &mut parent_socket, "SessionRespond",
            respond_input(&record, &answer)).await;
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["kind"], "recorded");
        assert_eq!(result["record"]["outcome"]["decision"],
            serde_json::to_value(&answer).unwrap()["decision"]);
        for target in [&parent, &child] {
            let before = observe(&f, target).await;
            let result = tool(&listener, &mut parent_socket, "SessionUpdate", json!({
                "sessionId":target, "expectedRevision":before["revision"],
                "title":before["title"], "labels":[],
                "permissions":{"settings":{"access":"danger_full_access","requestPermissions":false},
                    "revokeGrants":true},
            })).await;
            assert_eq!(serde_json::from_str::<Value>(&result).unwrap(),
                json!({"kind":"rejected","reason":"permission_change_requires_user"}));
            assert_eq!(observe(&f, target).await["permissions"],
                json!({"access":"workspace_write","requestPermissions":true}));
        }
        for socket in [&mut grandparent_socket, &mut parent_socket, &mut child_socket,
            &mut sibling_socket, &mut unrelated_socket] {
            response(socket).await;
        }
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.expect("direct-child authority timed out");
}

#[tokio::test]
async fn model_child_out_of_scope_answer_waits_for_human_not_grandparent() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let grandparent = f.create("Grandparent").await;
        let mut grandparent_socket = start(&f, &listener, &grandparent).await;
        let parent = create_child(&listener, &mut grandparent_socket, &grandparent, "Parent").await;
        let parent = parent["id"].as_str().unwrap().to_owned();
        // Workspace-write also permits temporary directories; read-only makes
        // the proposed temporary-file write genuinely outside the parent's policy.
        set_policy(&f, &parent, "read_only", true).await;
        let mut parent_socket = start(&f, &listener, &parent).await;
        let child = create_child(&listener, &mut parent_socket, &parent, "Child").await;
        let child = child["id"].as_str().unwrap().to_owned();
        let mut child_socket = start(&f, &listener, &child).await;
        let outside_directory = tempfile::tempdir().unwrap();
        let outside = outside_directory.path().canonicalize().unwrap();
        let requested = grant::Permissions {
            filesystem: vec![Rule::subtree(&outside, Access::Write)],
            network: Network::Allowed,
        };
        let proposed = allow(grant::Permissions {
            filesystem: vec![Rule::exact(outside.join("result"), Access::Write)],
            network: Network::Denied,
        });
        let record = establish_permissions(&f, &child, "outside_request", requested).await;
        service_tools::named_tool_response(
            &mut parent_socket,
            "SessionRespond",
            respond_input(&record, &proposed),
        )
        .await;
        let escalation = pending_escalation(&f, &parent).await;
        let InteractionRequest::SessionApproval {
            session_id,
            request_id,
            answer,
            ..
        } = &escalation.request
        else {
            unreachable!()
        };
        assert_eq!(session_id, &child);
        assert_eq!(request_id, &record.request_id);
        assert_eq!(InteractionAnswer::from(answer.clone()), proposed);
        let pending = f
            .query("pendingInteractions", json!({"sessionId":parent}))
            .await
            .unwrap();
        assert_eq!(pending["entries"][0]["kind"], "session_approval");
        assert_pending(&f, &record).await;
        for decision in ["allow", "deny"] {
            let result = tool(
                &listener,
                &mut grandparent_socket,
                "SessionRespond",
                json!({"sessionId":parent,"requestId":escalation.request_id,
                    "answer":{"kind":"session_approval","decision":decision}}),
            )
            .await;
            assert_eq!(
                serde_json::from_str::<Value>(&result).unwrap(),
                json!({"kind":"rejected","reason":"human_action_required"})
            );
            assert_pending(&f, &escalation).await;
            assert_pending(&f, &record).await;
        }
        let accepted = f
            .mutation(
                2,
                "respond",
                json!({
                    "sessionId":parent,"requestId":escalation.request_id,
                    "answer":{"kind":"session_approval","decision":"allow"},
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "recorded");
        let (mut resumed, _) = listener.accept().await.unwrap();
        let sent = request(&mut resumed).await;
        let returned = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        let returned: Value = serde_json::from_str(returned).unwrap();
        assert_eq!(returned["kind"], "recorded");
        let completed = f
            .session(&child)
            .await
            .interaction(&record.request_id)
            .await
            .unwrap()
            .unwrap();
        let Some(InteractionOutcome::PermissionsDecision { decision, .. }) = completed.outcome
        else {
            panic!("child permission answer was not committed: {completed:?}")
        };
        let InteractionAnswer::Permissions { decision: expected } = proposed else {
            unreachable!()
        };
        assert_eq!(decision, expected);
        for socket in [&mut grandparent_socket, &mut resumed, &mut child_socket] {
            response(socket).await;
        }
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .expect("human-only child escalation timed out");
}

#[tokio::test]
async fn model_child_tools_follow_caller_not_workspace_donor_or_fork_source() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let donor = f.create("Unrestricted workspace donor").await;
        let tools = json!(["SessionCreate", "SessionFork"]);
        let mut input = f.create_input("Restricted caller").await;
        input["tools"] = tools.clone();
        let caller = f
            .mutation(2, "create", input, Uuid::new_v4())
            .await
            .unwrap();
        let caller = caller["session"]["id"].as_str().unwrap();
        let mut socket = start(&f, &listener, caller).await;
        for workspace in [
            json!({"kind":"session","sessionId":donor}),
            f.create_input("Directory reference").await["workspace"].clone(),
        ] {
            let result = tool(
                &listener,
                &mut socket,
                "SessionCreate",
                json!({
                    "title":"Bounded child","labels":[],"workspace":workspace,
                }),
            )
            .await;
            let created: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(created["kind"], "created", "{created}");
            assert_eq!(created["session"]["tools"], tools);
        }
        let result = tool(
            &listener,
            &mut socket,
            "SessionFork",
            json!({
                "sessionId":donor,"expectedRevision":observe(&f, &donor).await["revision"],
                "position":{"kind":"start"},"title":"Bounded fork","labels":[],
            }),
        )
        .await;
        let forked: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(forked["kind"], "forked", "{forked}");
        assert_eq!(forked["session"]["tools"], tools);
        response(&mut socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .expect("tool ceiling inheritance timed out");
}

#[tokio::test]
async fn model_queue_edits_can_only_change_messages_authored_by_the_calling_session() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let parent = f.create("Parent").await;
        let mut parent_socket = start(&f, &listener, &parent).await;
        let child = create_child(&listener, &mut parent_socket, &parent, "Child actor").await;
        let child = child["id"].as_str().unwrap();
        let mut child_socket = start(&f, &listener, child).await;
        let queued = f.mutation(2, "send", json!({
            "sessionId":parent,"message":"Human instruction","delivery":"queue","model":f.selection().await,
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(queued["kind"], "queued");
        let queue = f.query("queue", json!({"sessionId":parent})).await.unwrap();
        for edit in [
            json!({"kind":"update","messageId":queued["messageId"],"message":"Impersonated human"}),
            json!({"kind":"retract","messageId":queued["messageId"]}),
            json!({"kind":"reorder","messageIds":[queued["messageId"]]}),
        ] {
            let result = tool(&listener, &mut child_socket, "SessionEditQueue", json!({
                "sessionId":parent,"expectedRevision":queue["revision"],"edit":edit,
            })).await;
            assert_eq!(serde_json::from_str::<Value>(&result).unwrap(),
                json!({"kind":"rejected","reason":"not_your_message"}));
        }
        assert_eq!(f.query("queue", json!({"sessionId":parent})).await.unwrap(), queue);
        let sent = tool(&listener, &mut child_socket, "SessionSend", json!({
            "sessionId":parent,"message":"My queued message","delivery":"queue","model":f.selection().await,
        })).await;
        let sent: Value = serde_json::from_str(&sent).unwrap();
        assert_eq!(sent["kind"], "queued", "{sent}");
        let queue = f.query("queue", json!({"sessionId":parent})).await.unwrap();
        let result = tool(&listener, &mut child_socket, "SessionEditQueue", json!({
            "sessionId":parent,"expectedRevision":queue["revision"],
            "edit":{"kind":"update","messageId":sent["messageId"],"message":"My revised message"},
        })).await;
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap()["kind"], "committed");
        let revised = f.query("queue", json!({"sessionId":parent})).await.unwrap();
        let owned = revised["entries"].as_array().unwrap().iter()
            .find(|entry| entry["messageId"] == sent["messageId"]).unwrap();
        assert_eq!(owned["preview"], "My revised message");
        assert_eq!(owned["origin"]["invocation"]["session_id"], child);
        let parent_invocation = f.query("observe", json!({"sessionId":parent})).await.unwrap()["run"]["invocationId"].clone();
        let from_parent = tool(&listener, &mut parent_socket, "SessionSend", json!({
            "sessionId":child,"message":"Parent-authored instruction","delivery":"queue","model":f.selection().await,
        })).await;
        let from_parent: Value = serde_json::from_str(&from_parent).unwrap();
        assert_eq!(from_parent["kind"], "queued");
        let child_queue = f.query("queue", json!({"sessionId":child})).await.unwrap();
        let result = tool(&listener, &mut child_socket, "SessionEditQueue", json!({
            "sessionId":child,"expectedRevision":child_queue["revision"],
            "edit":{"kind":"update","messageId":from_parent["messageId"],"message":"Forged parent instruction"},
        })).await;
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap(),
            json!({"kind":"rejected","reason":"not_your_message"}));
        let result = tool(&listener, &mut parent_socket, "SessionEditQueue", json!({
            "sessionId":child,"expectedRevision":child_queue["revision"],
            "edit":{"kind":"retract","messageId":from_parent["messageId"]},
        })).await;
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap()["kind"], "committed");
        let stopped = f.mutation(2, "stop", json!({"sessionId":parent,"invocationId":parent_invocation}), Uuid::new_v4()).await.unwrap();
        assert_eq!(stopped["requested"], true);
        drop(parent_socket);
        response(&mut child_socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.expect("queue authorship boundary timed out");
}
