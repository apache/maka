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
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::{Value, json};
use std::{collections::BTreeSet, time::Duration};
use tokio_util::sync::CancellationToken;

const SESSION: &str = "plan-session";

async fn open(peer: &mut Peer) -> Value {
    let binding = json!({"packageId":"maka.plan","method":"manage","sessionId":SESSION});
    let bound = peer
        .rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
        .await;
    assert_eq!(bound["ok"], true, "{bound}");
    let document = peer
        .rpc("plugin.remote", json!({"kind":"open_document"}))
        .await;
    assert_eq!(document["ok"], true, "{document}");
    json!({"kind":"call","binding":binding,"target":bound["result"]["target"],"document":document["result"]["document"]})
}
async fn call(peer: &mut Peer, envelope: &Value, input: Value) -> Value {
    let mut request = envelope.clone();
    request["input"] = input;
    peer.rpc("plugin.remote", request).await
}
async fn read(peer: &mut Peer, envelope: &Value) -> Value {
    let response = call(peer, envelope, json!({"kind":"read"})).await;
    assert_eq!(response["ok"], true, "{response}");
    response["result"]["value"].clone()
}
async fn wait_state(
    peer: &mut Peer,
    envelope: &Value,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let current = read(peer, envelope).await;
            if predicate(&current) {
                return current;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Plan did not reach the expected durable state")
}
async fn turn_finished(peer: &mut Peer, turn: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let state = peer
                .rpc("turn.query", json!({"sessionId":SESSION,"turnId":turn}))
                .await;
            assert_eq!(state["ok"], true, "{state}");
            if matches!(
                state["result"]["status"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                return state["result"].clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
async fn start(peer: &mut Peer, turn: &str) {
    let started = peer.rpc("turn.start", json!({
        "sessionId":SESSION,"turnId":turn,"content":{"text":"Inspect and propose the next change"}
    })).await;
    assert_eq!(started["ok"], true, "{started}");
}
async fn close(peer: &mut Peer, envelope: &Value) {
    let result = peer
        .rpc(
            "plugin.remote",
            json!({"kind":"close_document","document":envelope["document"]}),
        )
        .await;
    assert_eq!(result["ok"], true, "{result}");
}
async fn enable(peer: &mut Peer, enabled: bool) {
    let result = peer
        .rpc(
            "plugin.composition.apply",
            json!({
                "operations":[{"type":"update","entryId":"maka.plan","patch":{"disabled":!enabled}}]
            }),
        )
        .await;
    assert_eq!(result["ok"], true, "{result}");
    peer.wait_for_plugins().await;
}
async fn grant(peer: &mut Peer, envelope: &Value) -> Value {
    let result = peer.rpc("plugin.authorization", json!({
        "binding":envelope["binding"],"target":envelope["target"],
        "command":{"kind":"approve","request":{
            "operationId":uuid::Uuid::new_v4(),"title":"Execute this Session's approved Plan",
            "target":{"kind":"session","sessionId":SESSION},"capabilities":["executions"]
        }}
    })).await;
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["grant"]["id"].clone()
}
fn approval(state: &Value, grant: &Value, operation: &str) -> Value {
    json!({"kind":"control","operationId":operation,"expectedRevision":state["revision"],
        "action":{"kind":"approve","proposalId":state["proposal"]["id"],
        "proposalRevision":state["proposal"]["revision"],"grant":grant}})
}
fn artifact() -> Value {
    json!({"title":"Verified Plan","overview":"Inspect, implement and verify",
        "steps":[{"id":"change","title":"Implement","description":"Make the approved change","files":[],"complexity":"low"},
                 {"id":"verify","title":"Verify","description":"Verify the behavior","files":[],"complexity":"low"}],
        "risks":[]})
}
fn tool(name: &str, input: Value) -> Value {
    json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":uuid::Uuid::new_v4(),
        "type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"})
}
fn answer(text: &str) -> Value {
    json!({"index":0,"delta":{"content":text},"finish_reason":"stop"})
}
async fn next(requests: &mut tokio::sync::mpsc::Receiver<ModelRequest>) -> ModelRequest {
    tokio::time::timeout(Duration::from_secs(15), requests.recv())
        .await
        .unwrap()
        .unwrap()
}
fn names(body: &Value) -> BTreeSet<&str> {
    body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn plan_uses_public_controls_and_recovers_settlement_without_replaying_work() {
    tokio::time::timeout(Duration::from_secs(120), lifecycle())
        .await
        .unwrap();
}
async fn lifecycle() {
    let fixture = ClientFixture::new("maka-plan-");
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .arg(&fixture.workspace)
            .status()
            .unwrap()
            .success()
    );
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    let mut original_grant = Value::Null;
    let mut original_approval = Value::Null;
    let mut original_reply = Value::Null;
    for phase in 0..2 {
        let host = Host::open(fixture.owner()).await.unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("plan.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-plan-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop),
        );
        let mut peer = Peer::new(host.clone(), "plan-client").await;
        peer.wait_for_plugins().await;
        if phase == 0 {
            let created = peer.rpc("session.create", json!({
                "sessionId":SESSION,"workspace":{"kind":"host_path","path":fixture.workspace},
                "sandboxMode":"workspace-write","approvalPolicy":{"kind":"never"},"collaborationMode":"plan",
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
            })).await;
            assert_eq!(created["ok"], true, "{created}");
        } else {
            enable(&mut peer, true).await;
        }
        let mut envelope = open(&mut peer).await;
        if phase == 0 {
            original_grant = grant(&mut peer, &envelope).await;
            start(&mut peer, "planning").await;
            let planning = next(&mut requests).await;
            let tools = names(&planning.body);
            assert!(tools.contains("SubmitPlan"), "{tools:?}");
            for forbidden in [
                "Shell",
                "Write",
                "Edit",
                "apply_patch",
                "GoalStatus",
                "update_plan",
                "cancel_plan",
            ] {
                assert!(!tools.contains(forbidden), "{tools:?}");
            }
            // Even a fabricated unadvertised tool call cannot write while planning.
            planning
                .reply
                .send(tool("Shell", json!({"command":"touch should-not-exist"})))
                .unwrap();
            let after_rejection = next(&mut requests).await;
            assert!(!fixture.workspace.join("should-not-exist").exists());
            after_rejection
                .reply
                .send(tool("SubmitPlan", artifact()))
                .unwrap();
            let proposed = wait_state(&mut peer, &envelope, |state| {
                state["proposal"]["status"] == "pending_approval"
            })
            .await;
            assert_eq!(
                turn_finished(&mut peer, "planning").await["status"],
                "completed"
            );
            assert!(
                requests.try_recv().is_err(),
                "SubmitPlan must finish without another model request"
            );
            original_approval = approval(&proposed, &original_grant, "approve-original");
            original_reply = call(&mut peer, &envelope, original_approval.clone()).await;
            assert_eq!(original_reply["ok"], true, "{original_reply}");
            assert_eq!(
                call(&mut peer, &envelope, original_approval.clone()).await,
                original_reply
            );
            let executing = next(&mut requests).await;
            let tools = names(&executing.body);
            assert!(
                tools.contains("update_plan") && tools.contains("cancel_plan"),
                "{tools:?}"
            );
            assert!(!tools.contains("SubmitPlan"), "{tools:?}");
            assert!(
                executing.body["messages"]
                    .to_string()
                    .contains("user-approved plan")
            );
            executing
                .reply
                .send(tool(
                    "update_plan",
                    json!({"steps":[
                        {"id":"change","status":"completed","note":"Behavior verified"},
                        {"id":"verify","status":"completed","note":"Checks passed"}
                    ]}),
                ))
                .unwrap();
            let final_response = next(&mut requests).await;
            let reported = wait_state(&mut peer, &envelope, |state| {
                state["execution"]["steps"][1]["status"] == "completed"
            })
            .await;
            assert_eq!(
                reported["execution"]["phase"]["kind"], "active",
                "A model report must not outrun canonical Host completion"
            );
            let execution_turn = reported["execution"]["phase"]["receipt"]["invocation"]["turn_id"]
                .as_str()
                .unwrap()
                .to_owned();
            let revoked = peer
                .rpc(
                    "plugin.authorization",
                    json!({
                        "binding":envelope["binding"],"target":envelope["target"],
                        "command":{"kind":"revoke","id":original_grant}
                    }),
                )
                .await;
            assert_eq!(revoked["ok"], true, "{revoked}");
            enable(&mut peer, false).await;
            final_response
                .reply
                .send(answer("Verified implementation"))
                .unwrap();
            assert_eq!(
                turn_finished(&mut peer, &execution_turn).await["status"],
                "completed"
            );
        } else {
            let pending = read(&mut peer, &envelope).await;
            assert_eq!(pending["execution"]["phase"]["kind"], "active");
            let renewed = grant(&mut peer, &envelope).await;
            let reconcile = call(&mut peer, &envelope, json!({
                "kind":"control","operationId":"renew-settlement","expectedRevision":pending["revision"],
                "action":{"kind":"reconcile","executionId":pending["execution"]["id"],"grant":renewed}
            })).await;
            assert_eq!(reconcile["ok"], true, "{reconcile}");
            let completed = wait_state(&mut peer, &envelope, |state| {
                state["execution"]["phase"]["kind"] == "completed"
            })
            .await;
            assert!(
                requests.try_recv().is_err(),
                "Recovery must observe the original receipt without rerunning the Plan"
            );
            assert_eq!(
                call(&mut peer, &envelope, original_approval.clone()).await,
                original_reply
            );
            let historic = call(
                &mut peer,
                &envelope,
                json!({"kind":"history","throughRevision":completed["revision"],"after":0}),
            )
            .await;
            assert_eq!(historic["ok"], true, "{historic}");
            assert_eq!(historic["result"]["value"]["snapshots"][0]["revision"], 1);
            let stored_artifact = call(
                &mut peer,
                &envelope,
                json!({"kind":"artifact","source":"execution"}),
            )
            .await;
            assert_eq!(stored_artifact["result"]["value"]["artifact"], artifact());

            start(&mut peer, "planning-cancel").await;
            next(&mut requests)
                .await
                .reply
                .send(tool("SubmitPlan", artifact()))
                .unwrap();
            let proposed = wait_state(&mut peer, &envelope, |state| {
                state["proposal"]["status"] == "pending_approval"
            })
            .await;
            assert_eq!(
                turn_finished(&mut peer, "planning-cancel").await["status"],
                "completed"
            );
            let revoked = peer
                .rpc(
                    "plugin.authorization",
                    json!({
                        "binding":envelope["binding"],"target":envelope["target"],
                        "command":{"kind":"revoke","id":original_grant}
                    }),
                )
                .await;
            assert_eq!(revoked["ok"], true, "{revoked}");
            let rejected = call(
                &mut peer,
                &envelope,
                approval(&proposed, &original_grant, "revoked-approval"),
            )
            .await;
            assert_eq!(rejected["ok"], false, "{rejected}");
            assert_eq!(
                read(&mut peer, &envelope).await["revision"],
                proposed["revision"]
            );
            let renewed = grant(&mut peer, &envelope).await;
            let approved = call(
                &mut peer,
                &envelope,
                approval(&proposed, &renewed, "approve-cancel"),
            )
            .await;
            assert_eq!(approved["ok"], true, "{approved}");
            next(&mut requests)
                .await
                .reply
                .send(answer("Stopped without completing the steps"))
                .unwrap();
            let interrupted = wait_state(&mut peer, &envelope, |state| {
                state["execution"]["phase"]["kind"] == "interrupted"
            })
            .await;
            let resume = json!({
                "kind":"control","operationId":"resume-interrupted","expectedRevision":interrupted["revision"],
                "action":{"kind":"resume","executionId":interrupted["execution"]["id"],"grant":renewed}
            });
            let resumed = call(&mut peer, &envelope, resume.clone()).await;
            assert_eq!(resumed["ok"], true, "{resumed}");
            assert_eq!(call(&mut peer, &envelope, resume).await, resumed);
            let executing = next(&mut requests).await;
            assert!(
                executing.body["messages"]
                    .to_string()
                    .contains("Current Plan state for this model step")
            );
            let active = wait_state(&mut peer, &envelope, |state| {
                state["execution"]["phase"]["kind"] == "active"
            })
            .await;
            let cancellation = json!({"kind":"control","operationId":"cancel-owned","expectedRevision":active["revision"],
                "action":{"kind":"cancel","executionId":active["execution"]["id"],"reason":"User abandoned this Plan"}});
            let cancelled = call(&mut peer, &envelope, cancellation.clone()).await;
            assert_eq!(cancelled["ok"], true, "{cancelled}");
            let _ = executing.reply.send(answer("No further work"));
            wait_state(&mut peer, &envelope, |state| {
                state["execution"]["phase"]["kind"] == "cancelled"
            })
            .await;
            start(&mut peer, "unrelated").await;
            let unrelated = next(&mut requests).await;
            assert_eq!(
                call(&mut peer, &envelope, cancellation).await,
                cancelled,
                "An exact retry must return its original decision"
            );
            unrelated
                .reply
                .send(answer("Independent planning discussion"))
                .unwrap();
            assert_eq!(
                turn_finished(&mut peer, "unrelated").await["status"],
                "completed",
                "Cancelling an old Plan must never stop the Session's newer Turn"
            );
            envelope =
                uncertain_cancellation(&mut peer, &host, &envelope, &renewed, &mut requests).await;
        }
        close(&mut peer, &envelope).await;
        peer.close().await;
        if phase == 1 {
            tokio::time::timeout(
                Duration::from_secs(10),
                host.wait_until_idle(Duration::ZERO, Duration::from_millis(100)),
            )
            .await
            .expect("Unknown cancelled admission must not keep Host awake");
            assert!(
                requests.try_recv().is_err(),
                "Unknown cancelled admission must never be submitted"
            );
        }
        drop(cleanup);
        server.await.unwrap().unwrap();
    }
}

async fn uncertain_cancellation(
    peer: &mut Peer,
    host: &std::sync::Arc<Host>,
    envelope: &Value,
    grant: &Value,
    requests: &mut tokio::sync::mpsc::Receiver<ModelRequest>,
) -> Value {
    use maka_assistant::plan::{Command, Phase, Request, repository::Repository};
    start(peer, "planning-uncertain").await;
    next(requests)
        .await
        .reply
        .send(tool("SubmitPlan", artifact()))
        .unwrap();
    wait_state(peer, envelope, |state| {
        state["proposal"]["status"] == "pending_approval"
    })
    .await;
    assert_eq!(
        turn_finished(peer, "planning-uncertain").await["status"],
        "completed"
    );
    enable(peer, false).await;
    close(peer, envelope).await;
    // Materialize the crash boundary after durable dispatch but before a known
    // Host receipt, followed by a persisted cancellation decision.
    let inspector = maka_plugins::fiber::Fiber::new(
        "maka.plan",
        "plan-fixture",
        maka_plugins::composition::Scope::Profile,
    )
    .unwrap();
    inspector.begin_loading().unwrap();
    inspector.ready().unwrap();
    inspector.publish().unwrap();
    let store = host.plugin_storage(inspector.context()).unwrap();
    let repo = Repository::new(store.clone(), "maka.plan", SESSION).unwrap();
    let mut state = repo.current().await.unwrap();
    let proposal = state.proposal.as_ref().unwrap();
    state = repo
        .apply(
            &Request {
                operation_id: "uncertain-approval".into(),
                expected_revision: state.revision,
                command: Command::Approve {
                    proposal_id: proposal.id.clone(),
                    proposal_revision: proposal.revision,
                    behavior: "maka.plan.execute".to_owned().try_into().unwrap(),
                    grant: serde_json::from_value(grant.clone()).unwrap(),
                },
            },
            1,
        )
        .await
        .unwrap();
    let execution = state.execution.as_ref().unwrap().id.clone();
    state = repo
        .apply(
            &Request {
                operation_id: "uncertain-dispatch".into(),
                expected_revision: state.revision,
                command: Command::Dispatch {
                    execution_id: execution.clone(),
                },
            },
            2,
        )
        .await
        .unwrap();
    state = repo
        .apply(
            &Request {
                operation_id: "uncertain-cancel".into(),
                expected_revision: state.revision,
                command: Command::Cancel {
                    execution_id: execution,
                    reason: "User stopped the pending dispatch".into(),
                    grant: None,
                },
            },
            3,
        )
        .await
        .unwrap();
    assert!(matches!(
        state.execution.unwrap().phase,
        Phase::AwaitingAdmission
    ));
    drop(repo);
    drop(store);
    inspector
        .shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
        .await
        .unwrap();
    enable(peer, true).await;
    let recovered = open(peer).await;
    let current = read(peer, &recovered).await;
    assert_eq!(current["execution"]["phase"]["kind"], "awaiting_admission");
    assert_eq!(
        current["execution"]["cancellation"],
        "User stopped the pending dispatch"
    );
    recovered
}
