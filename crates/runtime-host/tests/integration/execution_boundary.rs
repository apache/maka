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

use super::support::{
    client_probe::ClientFixture,
    message_recovery::{ModelRequest, Provider, configure},
    peer::Peer,
};
use maka_protocol::Operation;
use maka_runtime::{event::Fact, execution::SandboxMode};
use maka_runtime_host::{
    server::{Host, local::LocalListener},
    session::SessionConfiguration,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const SESSION: &str = "live-boundary";
const MARKER: &str = "boundary-granted-source";

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_shell_approvals_enforce_exact_once_grants_and_never_prompt_policy() {
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = ClientFixture::new("maka-permissions-");
        let outside = fixture.workspace.parent().unwrap().canonicalize().unwrap().join("outside.txt");
        std::fs::write(&outside, "original").unwrap();
        let (provider, mut requests) = Provider::controlled().await;
        let model = configure(&fixture, &provider.base_url).await;
        let owner = fixture.owner();
        let database = owner.canonical_path().join(maka_event_log::root::ROOT_DATABASE);
        let host = Host::open(owner).await.unwrap();
        let mut database = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(database).read_only(true),
        ).await.unwrap();
        let cancel = CancellationToken::new();
        let cleanup = cancel.clone().drop_guard();
        let server = tokio::spawn(LocalListener::bind(&fixture.workspace.parent().unwrap().join("permissions.sock"))
            .unwrap().serve(host.clone(), cancel));
        let mut peer = Peer::new(host.clone(), "permissions-client").await;
        peer.wait_for_plugins().await;
        let created = peer.rpc("session.create", json!({
            "sessionId":SESSION,"sandboxMode":"read-only",
            "approvalPolicy":{"kind":"on-request"},
            "workspace":{"kind":"host_path","path":fixture.workspace},
            "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                "connectionSlug":model.connection_slug,"model":model.model}
        })).await;
        assert_eq!(created["ok"], true, "{created}");
        start(&mut peer, "approve").await;
        let command = format!("printf approved > '{}'", outside.display());
        let permissions = json!({"filesystem":[{"path":outside,"scope":"exact","access":"write"}],"network":"denied"});
        request(&mut requests).await.reply.send(call("first", maka_process::SHELL_NAME,
            json!({"command":command,"additional_permissions":permissions,"justification":"Write the requested output file."}))).unwrap();
        let (id, payload): (String, String) = loop {
            let found = sqlx::query_as("SELECT request_id, json_extract(record_json, '$.request') FROM interaction_requests WHERE json_extract(record_json, '$.request.kind') = 'permissions'")
                .fetch_optional(&mut database).await.unwrap();
            if let Some(found) = found { break found; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["request"]["command"]["command"], command);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "original", "No effect before the user decides");
        let answer = json!({"sessionId":SESSION,"interactionId":id,
            "answer":{"kind":"permissions","decision":{"decision":"allow","scope":"once","permissions":permissions}}});
        let accepted = peer.rpc("interaction.answer", answer.clone()).await;
        assert_eq!(accepted["ok"], true, "{accepted}");
        assert_eq!(peer.rpc("interaction.answer", answer).await["ok"], true);
        let second = request(&mut requests).await;
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "approved");
        assert!(tool_messages(&second.body).last().unwrap().contains("completed"));
        second.reply.send(call("second", maka_process::SHELL_NAME,
            json!({"command":format!("printf widened > '{}'", outside.display())}))).unwrap();
        let third = request(&mut requests).await;
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "approved", "Once must not authorize another call");
        assert!(tool_messages(&third.body).last().unwrap().contains("failed"));
        third.reply.send(done()).unwrap();
        finish(&mut peer, "approve").await;
        let revision = revision(&mut peer).await;
        let changed = update(&mut peer, revision, json!({"approvalPolicy":{"kind":"never"}})).await;
        assert_eq!(changed["result"]["kind"], "committed", "{changed}");
        start(&mut peer, "never").await;
        request(&mut requests).await.reply.send(call("forbidden", maka_process::SHELL_NAME,
            json!({"command":command,"additional_permissions":permissions,"justification":"Try again."}))).unwrap();
        let rejected = request(&mut requests).await;
        assert!(tool_messages(&rejected.body).last().unwrap().contains("forbids prompting"));
        rejected.reply.send(done()).unwrap();
        finish(&mut peer, "never").await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM interaction_requests WHERE json_extract(record_json, '$.request.kind') = 'permissions'")
            .fetch_one(&mut database).await.unwrap();
        assert_eq!(count, 1);
        peer.close().await;
        drop(cleanup);
        server.await.unwrap().unwrap();
        database.close().await.unwrap();
        drop(host);
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_grants_preserve_calls_and_narrowing_drains_resources_before_reopen() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let fixture = ClientFixture::new("maka-boundary-");
    let private = fixture.owner().canonical_path().join("test-private");
    std::fs::create_dir(&private).unwrap();
    let outside = private.join("protected-source.txt");
    std::fs::write(&outside, MARKER).unwrap();
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    let mut persisted = Value::Null;
    for reopened in [false, true] {
        let host = Host::open(fixture.owner()).await.unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("boundary.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-boundary-{}", uuid::Uuid::new_v4()));
        let cancel = CancellationToken::new();
        let cleanup = cancel.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), cancel.clone()),
        );
        let mut peer = Peer::new(host.clone(), "boundary-client").await;
        peer.wait_for_plugins().await;
        if !reopened {
            let created = peer
                .rpc(
                    Operation::SessionCreate.as_str(),
                    json!({
                        "sessionId":SESSION, "sandboxMode":"read-only",
                        "workspace":{"kind":"host_path","path":fixture.workspace},
                        "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                            "connectionSlug":model.connection_slug,"model":model.model}
                    }),
                )
                .await;
            assert_eq!(created["ok"], true, "{created}");
            assert_eq!(created["result"]["sandboxMode"], "read-only");
            start(&mut peer, "read").await;
            let first = request(&mut requests).await;
            first
                .reply
                .send(call("denied", "Read", json!({"path":outside})))
                .unwrap();
            let second = request(&mut requests).await;
            let denied = tool_messages(&second.body);
            assert_eq!(denied.len(), 1, "{denied:?}");
            assert!(!denied[0].contains(MARKER));
            assert!(denied[0].contains("filesystem policy denies"), "{denied:?}");
            let old = revision(&mut peer).await;
            let mixed = update(
                &mut peer,
                old,
                json!({"sandboxMode":"danger-full-access","orchestrationMode":"default"}),
            )
            .await;
            assert_eq!(mixed["error"]["code"], "session_busy", "{mixed}");
            // Desktop's explicit full bypass changes both axes atomically.
            let granted = update(
                &mut peer,
                old,
                json!({
                    "sandboxMode":"danger-full-access","approvalPolicy":{"kind":"never"}
                }),
            )
            .await;
            assert_eq!(granted["result"]["kind"], "committed", "{granted}");
            assert_eq!(
                boundary(&mut peer).await,
                json!({"kind":"danger-full-access","revision":1})
            );
            let configuration = peer
                .rpc(
                    "session.catalog.query",
                    json!({
                        "kind":"get","sessionId":SESSION
                    }),
                )
                .await;
            assert_eq!(
                configuration["result"]["session"]["approvalPolicy"],
                json!({"kind":"never"}),
                "{configuration}"
            );
            let stale = update(&mut peer, old, json!({"sandboxMode":"workspace-write"})).await;
            assert_eq!(stale["result"]["kind"], "revision_conflict", "{stale}");
            let current = revision(&mut peer).await;
            let narrowed =
                update(&mut peer, current, json!({"sandboxMode":"workspace-write"})).await;
            assert_eq!(narrowed["error"]["code"], "session_busy", "{narrowed}");
            second
                .reply
                .send(call("granted", "Read", json!({"path":outside})))
                .unwrap();
            let third = request(&mut requests).await;
            let messages = tool_messages(&third.body);
            assert_eq!(messages.len(), 2, "{messages:?}");
            assert!(messages[1].contains(MARKER), "{messages:?}");
            third.reply.send(done()).unwrap();
            finish(&mut peer, "read").await;

            // A fresh activation sees the wider tool set. Its background process
            // outlives the Turn and must be gone before idle narrowing commits.
            start(&mut peer, "shell").await;
            let shell = request(&mut requests).await;
            #[cfg(unix)]
            let command = "exec sleep 60";
            #[cfg(windows)]
            let command = "Start-Sleep -Seconds 60";
            shell
                .reply
                .send(call(
                    "background",
                    maka_process::SHELL_NAME,
                    json!({"command":command,"run_in_background":true}),
                ))
                .unwrap();
            let result = request(&mut requests).await;
            assert!(
                tool_messages(&result.body)
                    .last()
                    .unwrap()
                    .contains("background-tasks"),
                "{}",
                result.body
            );
            result.reply.send(done()).unwrap();
            finish(&mut peer, "shell").await;
            let active = resources(&mut peer).await;
            assert_eq!(active.len(), 1);
            assert!(
                matches!(
                    active[0]["result"]["status"].as_str(),
                    Some("starting" | "running")
                ),
                "{active:?}"
            );
            let revision = revision(&mut peer).await;
            let narrowed = update(
                &mut peer,
                revision,
                json!({"sandboxMode":"workspace-write"}),
            )
            .await;
            assert_eq!(narrowed["result"]["kind"], "committed", "{narrowed}");
            assert_eq!(
                boundary(&mut peer).await,
                json!({"kind":"managed","access":"writable","revision":2})
            );
            let resources = resources(&mut peer).await;
            assert_eq!(
                resources[0]["result"]["status"], "cancelled",
                "{resources:?}"
            );
            persisted = resources[0].clone();
        } else {
            assert_eq!(
                boundary(&mut peer).await,
                json!({"kind":"managed","access":"writable","revision":2})
            );
            assert_eq!(resources(&mut peer).await, vec![persisted.clone()]);
        }
        peer.close().await;
        drop(cleanup);
        server.await.unwrap().unwrap();
        drop(host);
    }
    let log = fixture.log().await;
    let config = log
        .get_session::<SessionConfiguration>(SESSION)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        config.configuration.sandbox_mode,
        SandboxMode::WorkspaceWrite
    );
    assert_eq!(config.configuration.boundary_revision, 2);
    let prefix = log.prefix(200, 1024 * 1024).await.unwrap();
    let openings: Vec<_> = prefix
        .events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::InvocationOpened {
                configuration: Some(config),
                ..
            } => Some((config.sandbox_mode, config.boundary_revision)),
            _ => None,
        })
        .collect();
    assert_eq!(
        openings,
        vec![
            (SandboxMode::ReadOnly, 0),
            (SandboxMode::DangerFullAccess, 1)
        ]
    );
    log.close().await.unwrap();
    assert_eq!(provider.requests.lock().unwrap().len(), 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_approvals_are_exact_call_scoped_and_refuse_partial_or_protected_mutations() {
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = ClientFixture::new("maka-file-permissions-");
        // System temporary directories may be writable by default (notably
        // Windows TEMP). Use an unrelated, privately owned project directory.
        let external = tempfile::Builder::new().prefix("maka-file-approval-")
            .tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let outside = external.path().canonicalize().unwrap().join("outside.txt");
        let next = outside.with_file_name("next.txt");
        let (provider, mut requests) = Provider::controlled().await;
        let model = configure(&fixture, &provider.base_url).await;
        let owner = fixture.owner();
        let database_path = owner.canonical_path().join(maka_event_log::root::ROOT_DATABASE);
        let host = Host::open(owner).await.unwrap();
        let mut database = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(database_path).read_only(true),
        ).await.unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("permissions.sock");
        #[cfg(windows)]
        let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-file-permissions-{}", uuid::Uuid::new_v4()));
        let cancellation = CancellationToken::new();
        let cleanup = cancellation.clone().drop_guard();
        let server = tokio::spawn(LocalListener::bind(&endpoint).unwrap().serve(host.clone(), cancellation));
        let mut peer = Peer::new(host.clone(), "file-permissions-client").await;
        peer.wait_for_plugins().await;
        let created = peer.rpc("session.create", json!({
            "sessionId":SESSION, "sandboxMode":"workspace-write",
            "approvalPolicy":{"kind":"on-request"},
            "workspace":{"kind":"host_path","path":fixture.workspace},
            "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                "connectionSlug":model.connection_slug,"model":model.model}
        })).await;
        assert_eq!(created["ok"], true, "{created}");
        start(&mut peer, "files").await;
        request(&mut requests).await.reply.send(call("write", "Write",
            json!({"path":outside,"content":"approved"}))).unwrap();
        let (id, permissions) = pending_file_permission(&mut database, &mut requests).await;
        let path = maka_fs_tools::workspace::project::host_path(&outside).unwrap();
        assert_eq!(permissions, json!({"filesystem":[{"path":path,"scope":"exact","access":"write"}],"network":"denied"}));
        assert!(!outside.exists(), "no write before consent");
        let answer = json!({"sessionId":SESSION,"interactionId":id,
            "answer":{"kind":"permissions","decision":{"decision":"allow","scope":"once","permissions":permissions}}});
        assert_eq!(peer.rpc("interaction.answer", answer.clone()).await["ok"], true);
        assert_eq!(peer.rpc("interaction.answer", answer).await["ok"], true);
        let followup = request(&mut requests).await;
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "approved");
        followup.reply.send(call("edit", "Edit", json!({
            "path":outside,"old_string":"approved","new_string":"escaped"
        }))).unwrap();
        let (second, _) = pending_file_permission(&mut database, &mut requests).await;
        assert_ne!(second, id, "Once cannot leak into the cached Edit handler");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "approved");
        assert_eq!(peer.rpc("interaction.answer", json!({"sessionId":SESSION,"interactionId":second,
            "answer":{"kind":"permissions","decision":{"decision":"deny"}}})).await["ok"], true);
        let denied = request(&mut requests).await;
        assert!(tool_messages(&denied.body).last().unwrap().contains("permissions were denied"));
        denied.reply.send(done()).unwrap();
        finish(&mut peer, "files").await;

        let patched = peer.rpc("connection.catalog.update",json!({
            "expected":{"connectionId":model.connection_id,"revision":2},
            "changes":{"name":"Recovery fixture","configuration":{"baseUrl":provider.base_url},"enabled":true,
                "enabledModelIds":["fixture-model"],"modelOverrides":{"fixture-model":{"contextWindow":200000,"applyPatch":true}}}
        })).await;
        assert_eq!(patched["result"]["kind"],"committed","{patched}");
        start(&mut peer, "partial").await;
        request(&mut requests).await.reply.send(call("patch", "apply_patch", json!({
            "callId":"patch","operation":{"type":"create_file","path":next,"diff":"+must not appear"}
        }))).unwrap();
        let (partial, mut permissions) = pending_file_permission(&mut database, &mut requests).await;
        permissions["filesystem"][0]["access"] = "read".into();
        assert_eq!(peer.rpc("interaction.answer", json!({"sessionId":SESSION,"interactionId":partial,
            "answer":{"kind":"permissions","decision":{"decision":"allow","scope":"once","permissions":permissions}}})).await["ok"], true);
        let refused = request(&mut requests).await;
        assert!(tool_messages(&refused.body).last().unwrap().contains("Not all target files were approved"));
        assert!(!next.exists());
        refused.reply.send(call("protected", "apply_patch", json!({
            "callId":"protected","operation":{"type":"create_file","path":fixture.workspace.join(".agents/protected"),"diff":"+must not appear"}
        }))).unwrap();
        let protected = request(&mut requests).await;
        assert!(tool_messages(&protected.body).last().unwrap().contains("Host-protected files"));
        protected.reply.send(done()).unwrap();
        finish(&mut peer, "partial").await;

        let revision = revision(&mut peer).await;
        assert_eq!(update(&mut peer, revision, json!({"approvalPolicy":{"kind":"never"}})).await["result"]["kind"], "committed");
        start(&mut peer, "never").await;
        request(&mut requests).await.reply.send(call("never", "apply_patch", json!({"callId":"never","operation":{"type":"create_file","path":next,"diff":"+must not appear"}}))).unwrap();
        let refused = request(&mut requests).await;
        assert!(tool_messages(&refused.body).last().unwrap().contains("forbids prompting"));
        refused.reply.send(done()).unwrap();
        finish(&mut peer, "never").await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM interaction_requests WHERE json_extract(record_json, '$.request.kind') = 'permissions'")
            .fetch_one(&mut database).await.unwrap();
        assert_eq!(count, 3, "protected paths and never policy must not prompt");
        assert!(!next.exists());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "approved");
        peer.close().await;
        drop(cleanup);
        server.await.unwrap().unwrap();
        database.close().await.unwrap();
    }).await.unwrap();
}

async fn pending_file_permission(
    database: &mut sqlx::SqliteConnection,
    requests: &mut mpsc::Receiver<ModelRequest>,
) -> (String, Value) {
    loop {
        let pending: Option<(String, String)> = sqlx::query_as(
            "SELECT r.request_id, json_extract(r.record_json, '$.request.request.permissions')
             FROM interaction_requests r LEFT JOIN interaction_outcomes o USING(request_id)
             WHERE o.request_id IS NULL AND json_extract(r.record_json, '$.request.kind') = 'permissions'"
        ).fetch_optional(&mut *database).await.unwrap();
        if let Some((id, permissions)) = pending {
            return (id, serde_json::from_str(&permissions).unwrap());
        }
        if let Ok(unexpected) = requests.try_recv() {
            panic!(
                "model continued before approval: {:?}",
                tool_messages(&unexpected.body)
            );
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn request(requests: &mut mpsc::Receiver<ModelRequest>) -> ModelRequest {
    tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap()
}

fn call(id: &str, name: &str, input: Value) -> Value {
    json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":id,"type":"function",
        "function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"})
}

fn done() -> Value {
    json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"})
}

fn tool_messages(request: &Value) -> Vec<String> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["content"].as_str().unwrap().to_owned())
        .collect()
}

async fn start(peer: &mut Peer, turn: &str) {
    let result = peer
        .rpc(
            Operation::TurnStart.as_str(),
            json!({"sessionId":SESSION,"turnId":turn,
        "content":{"text":"Read the fixture and complete the task."},"maxSteps":4}),
        )
        .await;
    assert_eq!(result["ok"], true, "{result}");
}

async fn finish(peer: &mut Peer, turn: &str) {
    loop {
        let result = peer
            .rpc(
                Operation::TurnQuery.as_str(),
                json!({"sessionId":SESSION,"turnId":turn}),
            )
            .await;
        match result["result"]["status"].as_str() {
            Some("completed") => return,
            Some("failed" | "cancelled") => panic!("{result}"),
            _ => tokio::time::sleep(Duration::from_millis(10)).await,
        }
    }
}

async fn revision(peer: &mut Peer) -> u64 {
    let result = peer
        .rpc(
            Operation::SessionCatalogQuery.as_str(),
            json!({"kind":"get","sessionId":SESSION}),
        )
        .await;
    result["result"]["session"]["revision"].as_u64().unwrap()
}

async fn update(peer: &mut Peer, revision: u64, patch: Value) -> Value {
    peer.rpc(
        Operation::SessionConfigurationUpdate.as_str(),
        json!({"sessionId":SESSION,"expectedRevision":revision,"patch":patch}),
    )
    .await
}

async fn boundary(peer: &mut Peer) -> Value {
    let result = peer
        .rpc(
            Operation::SessionExecutionBoundaryQuery.as_str(),
            json!({"sessionId":SESSION}),
        )
        .await;
    assert_eq!(result["ok"], true, "{result}");
    result["result"].clone()
}

async fn resources(peer: &mut Peer) -> Vec<Value> {
    let result = peer
        .rpc(
            Operation::RuntimeResourceQuery.as_str(),
            json!({"kind":"list_start","sessionId":SESSION}),
        )
        .await;
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["resources"].as_array().unwrap().clone()
}
