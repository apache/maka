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

// Windows' default installation uses account_home rather than an isolated HOME.
#![cfg(unix)]

#[path = "support/host.rs"]
mod host;
#[path = "support/portable.rs"]
mod portable;
#[path = "support/restore_crash.rs"]
mod restore_crash;
use futures_util::FutureExt;
use host::{Host, Sandbox};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::{host::Client, transport::Reply};
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, MockAiBuilder, MockAiServer, ModelEntry, NormalizedRequest,
    Protocol, TurnContext, TurnPlan, Usage,
};
use maka_plugin_core::{
    contract::ResourceType,
    operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt},
};
use serde_json::{Value, json};
use std::{
    ops::Range,
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinSet};
use tokio_util::sync::CancellationToken;

struct FixtureKey;
impl ReadResource for FixtureKey {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "maka.text.utf8".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        b"mainline-fixture".len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        b"mainline-fixture"
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid fixture key range".into())
    }
}

async fn call(
    client: &Client,
    endpoint: &str,
    method: &str,
    input: Value,
    resources: Attachments,
) -> Value {
    if !matches!(method, "work" | "workReadiness") {
        eprintln!("mainline call: {endpoint}.{method}");
    }
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut call = client
            .call(endpoint, method.into(), input, resources)
            .await
            .unwrap();
        call.start().await.unwrap();
        let mut reply = call.receive().await.unwrap();
        if let Reply::Prepared { .. } = reply {
            reply = call
                .confirm(json!({"purpose":"cooperative-stop-clean-reopen"}))
                .await
                .unwrap();
        }
        reply
            .cleanup()
            .expect("terminal physical reply")
            .as_ref()
            .expect("independent original call cleanup");
        match reply {
            Reply::Finished { result, .. } => result.unwrap(),
            Reply::Mutation { reply, .. } => match reply.receipt {
                Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        },
                    cleanup,
                    ..
                } => {
                    assert_eq!(
                        cleanup,
                        OperationCleanup::Confirmed,
                        "original provider receipt cleanup is independent of caller I/O cleanup"
                    );
                    value
                }
                other => panic!("{endpoint}.{method} did not return a recorded success: {other:?}"),
            },
            other => panic!("unexpected terminal {endpoint}.{method}: {other:?}"),
        }
    })
    .await
    .unwrap_or_else(|_| panic!("bounded original control call {endpoint}.{method}"))
}

async fn work(client: &Client, session: &str, target: Value, terminal: Option<&str>) -> Value {
    loop {
        let work = call(
            client,
            "agent",
            "work",
            json!({"sessionId":session,"target":target}),
            Attachments::new(),
        )
        .await;
        match work["kind"].as_str().unwrap() {
            "pending" => {}
            "delivered" => {
                let state = work["execution"]["state"]["kind"].as_str().unwrap();
                if terminal.is_none_or(|terminal| state == terminal) {
                    return work;
                }
                assert!(
                    matches!(state, "admitted" | "running" | "waiting"),
                    "unexpected original Run: {work}"
                );
            }
            _ => panic!("original message/Run became unavailable: {work}"),
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn publish_workspace_checkpoint(client: &Client, session: &str, expected: Value) -> Value {
    let preview = call(
        client,
        "agent",
        "previewHistoryCheckpoint",
        json!({"sessionId":session}),
        Attachments::new(),
    )
    .await;
    let published = call(
        client,
        "agent",
        "publishCheckpoint",
        json!({
            "sessionId":session, "expectedRevision":expected,
            "confirmedSubtreeDigest":preview["subtreeDigest"],
            "workspaceConsistency":"caller_confirmed_quiescent",
        }),
        Attachments::new(),
    )
    .await;
    assert_eq!(published["state"]["kind"], "published", "{published}");
    assert_eq!(published["cleanupPending"], false);
    published["state"]["head"].clone()
}

async fn start_mainline_mock(
    nonce: String,
    shell_command: String,
    stopped: Arc<AtomicBool>,
    events: mpsc::UnboundedSender<&'static str>,
    held_closed: CancellationToken,
) -> MockAiServer {
    let proposed = Arc::new(AtomicBool::new(false));
    MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple("gpt-4.1")],
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
            assert_eq!(req.protocol, Protocol::OpenaiChatCompletions);
            let body = &req.raw_body;
            let messages = body["messages"].as_array().unwrap();
            eprintln!(
                "mainline wire: user_nonce={}, tools={}",
                messages.iter().any(|message| message["role"] == "user"
                    && message["content"].to_string().contains(&nonce)),
                body["tools"]
                    .as_array()
                    .map(|tools| tools
                        .iter()
                        .filter_map(|tool| tool["function"]["name"].as_str())
                        .collect::<Vec<_>>())
                    .unwrap_or_default()
                    .join(",")
            );
            let checkpoint_followup = format!("checkpoint-followup-{nonce}");
            if messages.iter().any(|message| {
                message["role"] == "user"
                    && message["content"]
                        .to_string()
                        .contains(&checkpoint_followup)
            }) {
                assert!(
                    stopped.load(Ordering::SeqCst),
                    "checkpoint follow-up is explicit work after reopen"
                );
                assert!(
                    messages.iter().any(|message| message["role"] == "tool"
                        && message["tool_call_id"] == format!("effect-{nonce}")),
                    "restored Session must retain its original tool result: {body}"
                );
                let _ = events.send("checkpoint-followup");
                return TurnPlan::new()
                    .with_response_id("mainline")
                    .push_text("Checkpoint follow-up completed.")
                    .with_usage(Usage::new(100, 10))
                    .finish(FinishReason::Stop);
            }
            let call_id = format!("effect-{nonce}");
            if messages
                .iter()
                .any(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
            {
                assert!(
                    !stopped.load(Ordering::SeqCst),
                    "a terminal original Run must not issue another model POST after reopen"
                );
                let result = messages
                    .iter()
                    .find(|message| message["tool_call_id"] == call_id)
                    .unwrap();
                assert!(
                    result["content"].to_string().contains(&nonce),
                    "actual process stdout must reach the model"
                );
                let _ = events.send("tool-result");
                return TurnPlan::stall()
                    .with_close_connection(true)
                    .with_on_close(held_closed.clone());
            }
            if messages.iter().any(|message| {
                message["role"] == "user" && message["content"].to_string().contains(&nonce)
            }) {
                let shell = body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tool| tool["function"]["name"] == "Shell")
                    .expect("the default product must advertise its original Shell binding");
                assert!(
                    shell["function"]["parameters"]["properties"]
                        .get("command")
                        .is_some()
                );
                assert!(!stopped.load(Ordering::SeqCst));
                assert!(
                    !proposed.swap(true, Ordering::SeqCst),
                    "this original Main must not request the effect twice"
                );
                return TurnPlan::new()
                    .with_response_id("mainline")
                    .push_tool_call(
                        call_id,
                        shell["function"]["name"].as_str().unwrap(),
                        json!({"command": shell_command, "login": false}),
                    )
                    .with_usage(Usage::new(100, 10))
                    .finish(FinishReason::ToolCalls);
            }
            // Auxiliary product requests are not counted as this Run's model attempts.
            TurnPlan::new()
                .with_response_id("mainline")
                .push_text("auxiliary complete")
                .with_usage(Usage::new(100, 10))
                .finish(FinishReason::Stop)
        })
        .start()
        .await
        .unwrap()
}

async fn identities(sandbox: &Sandbox, session: &str, run: &Value) -> Vec<Value> {
    let output = host::command(sandbox)
        .unwrap()
        .kill_on_drop(true)
        .args(["inspect", "--root"])
        .arg(&sandbox.root)
        .args(["--session", session])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "bounded canonical inspection must open and close the owned Root"
    );
    let inspection: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(inspection["truncated"], false);
    inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| {
            let record = &row["item"]["recorded"];
            let fact = &record["fact"];
            (record["run"] == *run
                && matches!(
                    fact["kind"].as_str(),
                    Some(
                        "run_admitted"
                            | "step_prepared"
                            | "model_attempt_prepared"
                            | "model_closed"
                            | "model_cleanup_observed"
                            | "tool_admitted"
                            | "tool_original_bound"
                            | "tool_result_accepted"
                            | "run_terminated"
                    )
                ))
            .then(|| {
                json!({"id":record["id"],"run":record["run"],"kind":fact["kind"],
                "step":fact.get("step"),"attempt":fact.get("attempt"),"tool":fact.get("tool"),"cleanup":fact.get("cleanup"),"outcome":fact.get("outcome")})
            })
        })
        .collect()
}

enum Restart {
    Clean,
    DuringCheckpointRestore,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cooperative_stop_then_clean_process_reopen_preserves_completed_effect() {
    exercise_reopen(Restart::Clean).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_crash_after_workspace_copy_preserves_binding_and_allows_explicit_restore() {
    exercise_reopen(Restart::DuringCheckpointRestore).await;
}

async fn exercise_reopen(restart: Restart) {
    let sandbox = Sandbox::new().await.unwrap();
    let mut hosts = Vec::new();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(180), async {
        let workspace = &sandbox.workspace;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let script = format!("import os; f=open('effects.log','ab',buffering=0); f.write(b'{nonce}\\n'); os.fsync(f.fileno()); f.close(); print('{nonce}')");
        let shell_command = format!("python3 -c \"{script}\"");
        let (events, mut observations) = mpsc::unbounded_channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let held_closed = CancellationToken::new();
        let server = start_mainline_mock(
            nonce.clone(),
            shell_command,
            stopped.clone(),
            events,
            held_closed.clone(),
        )
        .await;
        let base = server.base_url();
        hosts.push(Host::spawn(&sandbox).unwrap());
        let (mut client, address) = hosts.last_mut().unwrap().ready().await.unwrap();
        let first_epoch = client.epoch();
        let source = client.source().clone();
        let publication = serde_json::to_value(client.publication().await.unwrap()).unwrap();
        let catalog = call(&client, "settings", "connections", json!({"kind":"start"}), Attachments::new()).await;
        assert_eq!(catalog["kind"], "ready");
        let created = call(&client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],"connection":{
                "slug":"mainline","name":"Mainline loopback","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
                "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["gpt-4.1"],
                "modelOverrides":{"gpt-4.1":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}
            }}), Attachments::new()).await;
        assert_eq!(created["kind"], "committed");
        let connection = &created["connection"]["connectionId"];
        let detail = call(&client, "settings", "connection", json!({"connectionId":connection}), Attachments::new()).await;
        assert_eq!(detail["kind"], "ready");
        let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
        let saved = call(&client, "settings", "saveCredential", json!({"expected":detail["target"],"expectedCredential":null}),
            Attachments::from([("secret".into(), secret)])).await;
        assert_eq!(saved["kind"], "saved");
        let created = call(&client, "agent", "create", json!({
            "title":"Cooperative stop and clean reopen","automaticTitle":false,"labels":[],"tools":["Shell"],
            "workspace":{"kind":"directory","path":workspace},
            "backend":{"kind":"model","connectionId":connection,"modelId":"gpt-4.1","thinkingLevel":null}
        }), Attachments::new()).await;
        assert_eq!(created["kind"], "created");
        let session = created["session"]["id"].as_str().unwrap();
        let attachment = portable::upload(&client, session).await;
        let sent = call(&client, "agent", "send", json!({"sessionId":session,"message":format!("Use Shell for the one fsynced effect {nonce}."),"attachments":[attachment],"delivery":"queue"}), Attachments::new()).await;
        assert_eq!(sent["kind"], "queued");
        let target = json!({"kind":"message","messageId":sent["messageId"]});
        eprintln!("mainline stage: waiting for the actual Shell result");
        tokio::select! {
            event = observations.recv() => assert_eq!(event, Some("tool-result")),
            _ = tokio::time::sleep(Duration::from_secs(45)) => {
                server.assert_no_panics();
                let current = call(&client, "agent", "work", json!({"sessionId":session,"target":target}), Attachments::new()).await;
                panic!("actual Shell result did not reach the next original model request: {current}");
            }
        }
        server.assert_no_panics();
        assert_eq!(tokio::fs::read_to_string(workspace.join("effects.log")).await.unwrap(), format!("{nonce}\n"));
        let delivered = work(&client, session, target, None).await;
        eprintln!("mainline stage: tool completed; exact Run captured");
        assert!(matches!(delivered["execution"]["state"]["kind"].as_str(), Some("running" | "waiting")), "Main must still be pending: {delivered}");
        let run = delivered["execution"]["runId"].clone();
        let target = json!({"kind":"run","runId":run});
        let readiness = call(&client, "agent", "workReadiness", json!({"sessionId":session,"target":target}), Attachments::new()).await;
        assert_eq!(readiness["kind"], "pending");
        let queued = call(&client, "agent", "send", json!({
            "sessionId":session,"message":"This followup must be cancelled by Stop.","delivery":"queue",
        }), Attachments::new()).await;
        assert_eq!(queued["kind"], "queued");
        let queued_message = queued["messageId"].clone();
        let pending = call(&client, "agent", "work", json!({"sessionId":session,"target":{"kind":"message","messageId":queued_message}}), Attachments::new()).await;
        assert_eq!(pending["kind"], "pending");
        let stopped_reply = call(&client, "agent", "stop", json!({"sessionId":session,"runId":run}), Attachments::new()).await;
        assert_eq!(stopped_reply["requested"], true);
        let cancelled = work(&client, session, target.clone(), Some("cancelled")).await;
        eprintln!("mainline stage: original Run cancelled; await physical model EOF");
        assert_eq!(cancelled["execution"]["runId"], run);
        let queue = call(&client, "agent", "queue", json!({"sessionId":session}), Attachments::new()).await;
        let delivery = call(&client, "agent", "queueMessage", json!({
            "sessionId":session,"messageId":queued_message,"expectedRevision":queue["revision"],
        }), Attachments::new()).await;
        assert_eq!(delivery, json!({"kind":"missing","reason":"cancelled"}));
        let queued_work = call(&client, "agent", "work", json!({"sessionId":session,"target":{"kind":"message","messageId":queued_message}}), Attachments::new()).await;
        assert_eq!(queued_work["kind"], "cancelled");
        tokio::time::timeout(Duration::from_secs(30), held_closed.cancelled())
            .await
            .expect("physical model EOF must be observed after Stop");
        server.assert_no_panics();
        eprintln!("mainline stage: physical model EOF; await independent Root readiness");
        loop {
            let readiness = call(&client, "agent", "workReadiness", json!({"sessionId":session,"target":target}), Attachments::new()).await;
            match readiness["kind"].as_str().unwrap() {
                "ready" => break,
                "pending" => tokio::time::sleep(Duration::from_millis(20)).await,
                _ => panic!("original Run became unavailable: {readiness}"),
            }
        }
        let checkpoint = publish_workspace_checkpoint(&client, session, Value::Null).await;
        let recipient = Sandbox::new().await.unwrap();
        let archive = recipient.home.join("session.tar.gz");
        let restore_parent = tempfile::tempdir_in(&sandbox.home).unwrap();
        let restore = json!({
            "checkpoint":{"sessionId":session,"revision":checkpoint["revision"]},
            "parent":restore_parent.path(), "backend":{"kind":"model","connectionId":connection,"modelId":"gpt-4.1","thinkingLevel":null},
            "permissions":{"access":"workspace_write","requestPermissions":true},
            "acceptExternalWritersRisk":true,
        });
        let interrupted = match restart {
            Restart::Clean => {
                portable::export(&sandbox, session, &checkpoint, &archive).await;
                hosts[0].quit(&mut client).await.unwrap();
                None
            }
            Restart::DuringCheckpointRestore => {
                tokio::fs::write(workspace.join("effects.log"), "later local edit").await.unwrap();
                Some(restore_crash::interrupt(&sandbox, &mut hosts[0], &client, &address, &restore, &nonce).await)
            }
        };
        eprintln!("mainline stage: original Host exited; inspect canonical identities");
        let original = identities(&sandbox, session, &run).await;
        assert!(original.iter().filter(|fact| fact["kind"] == "model_attempt_prepared").count() >= 2);
        assert!(original.iter().filter(|fact| fact["kind"] == "step_prepared").count() >= 2);
        let attempts: Vec<_> = original.iter().filter(|fact| fact["kind"] == "model_attempt_prepared").map(|fact| &fact["attempt"]).collect();
        let closed: Vec<_> = original.iter().filter(|fact| fact["kind"] == "model_closed").collect();
        assert_eq!(closed.len(), 1, "Stop must not fabricate an upstream completion for the held second stream: {original:?}");
        assert_eq!(&closed[0]["attempt"], attempts[0]);
        for attempt in attempts {
            assert!(original.iter().any(|fact| fact["kind"] == "model_cleanup_observed" && &fact["attempt"] == attempt && fact["cleanup"]["kind"] == "confirmed"),
                "each original model attempt needs independent physical cleanup evidence: {original:?}");
        }
        assert_eq!(original.iter().filter(|fact| fact["kind"] == "run_admitted").count(), 1);
        assert_eq!(original.iter().filter(|fact| fact["kind"] == "run_terminated").count(), 1);
        assert_eq!(original.iter().filter(|fact| fact["kind"] == "tool_admitted").count(), 1);
        assert_eq!(original.iter().filter(|fact| fact["kind"] == "tool_result_accepted").count(), 1);
        stopped.store(true, Ordering::SeqCst);
        hosts.push(Host::spawn(&sandbox).unwrap());
        let (mut client, address) = hosts.last_mut().unwrap().ready().await.unwrap();
        assert_ne!(client.epoch(), first_epoch);
        assert_eq!(client.source(), &source);
        assert_eq!(serde_json::to_value(client.publication().await.unwrap()).unwrap(), publication);
        let reopened = work(&client, session, target, Some("cancelled")).await;
        assert_eq!(reopened["execution"]["runId"], run);
        assert_eq!(reopened["execution"]["turnId"], cancelled["execution"]["turnId"]);
        let queue = call(&client, "agent", "queue", json!({"sessionId":session}), Attachments::new()).await;
        let delivery = call(&client, "agent", "queueMessage", json!({
            "sessionId":session,"messageId":queued_message,"expectedRevision":queue["revision"],
        }), Attachments::new()).await;
        assert_eq!(delivery, json!({"kind":"missing","reason":"cancelled"}));
        if let Some(attempt) = &interrupted {
            attempt.check_recovery(&sandbox, &client, &address, &restore).await;
            assert_eq!(tokio::fs::read_to_string(attempt.path.join("effects.log")).await.unwrap(), format!("{nonce}\n"));
        } else {
            assert_eq!(tokio::fs::read_to_string(workspace.join("effects.log")).await.unwrap(), format!("{nonce}\n"));
            tokio::fs::write(workspace.join("effects.log"), "later local edit").await.unwrap();
        }
        let restored = call(&client, "agent", "restoreSessionCheckpoint", restore.clone(), Attachments::new()).await;
        if let Some(interrupted) = &interrupted {
            assert_ne!(restored["path"].as_str().unwrap(), interrupted.path.to_str().unwrap());
        }
        assert_eq!(restored["sessionId"], session);
        assert_eq!(restored["head"], checkpoint);
        let restored_path = std::path::PathBuf::from(restored["path"].as_str().unwrap());
        assert_ne!(&restored_path, workspace);
        assert_eq!(tokio::fs::read_to_string(restored_path.join("effects.log")).await.unwrap(), format!("{nonce}\n"));
        assert_eq!(tokio::fs::read_to_string(workspace.join("effects.log")).await.unwrap(), "later local edit");
        let observed = call(&client, "agent", "observe", json!({"sessionId":session}), Attachments::new()).await;
        assert_eq!(observed["session"]["workspace"]["path"], restored["path"]);
        let followup = call(&client, "agent", "send", json!({
            "sessionId":session,"message":format!("checkpoint-followup-{nonce}"),"delivery":"queue",
        }), Attachments::new()).await;
        assert_eq!(followup["kind"], "queued");
        let repeated_stop = call(&client, "agent", "stop", json!({"sessionId":session,"runId":run}), Attachments::new()).await;
        assert_eq!(repeated_stop["requested"], true, "re-observing the stopped original Run cannot stop its successor");
        let finished = work(&client, session,
            json!({"kind":"message","messageId":followup["messageId"]}), Some("completed")).await;
        assert_ne!(finished["execution"]["runId"], run);
        assert_eq!(finished["answer"]["text"], "Checkpoint follow-up completed.");
        let fork_archive = recipient.home.join("fork.tar.gz");
        let successor = match restart {
            Restart::Clean => {
                let successor = portable::advance_during_export(&client, &sandbox, session, &checkpoint).await;
                portable::check_stale(&sandbox, session, &checkpoint).await;
                portable::export_fork(&client, &sandbox, session, &fork_archive).await;
                successor
            }
            Restart::DuringCheckpointRestore => {
                restore_crash::check_stale(&sandbox, &client, &address, &restore).await;
                let successor = publish_workspace_checkpoint(&client, session, checkpoint["revision"].clone()).await;
                assert_eq!(call(&client, "agent", "historyCheckpointHead", json!({"sessionId":session}), Attachments::new()).await, successor);
                successor
            }
        };
        assert_ne!(successor["revision"], checkpoint["revision"]);
        assert_eq!(tokio::fs::read_to_string(restored_path.join("effects.log")).await.unwrap(), format!("{nonce}\n"));
        hosts.last_mut().unwrap().quit(&mut client).await.unwrap();
        assert_eq!(identities(&sandbox, session, &run).await, original);
        if matches!(restart, Restart::Clean) {
            tokio::fs::rename(&sandbox.root, sandbox.directory.path().join("offline-source")).await.unwrap();
            tokio::fs::rename(workspace, sandbox.directory.path().join("offline-project")).await.unwrap();
            portable::check(&recipient, &archive, session, &checkpoint, &nonce).await;
            portable::check_fork(&recipient, &fork_archive, session).await;
        }
        server.shutdown().await;
    })).catch_unwind().await;
    let mut cleanup = Vec::new();
    for process in &mut hosts {
        match tokio::time::timeout(Duration::from_secs(30), process.cleanup()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => cleanup.push(error),
            Err(_) => cleanup.push("deadline reaping this test's exact owned Host".into()),
        }
    }
    if !cleanup.is_empty() {
        eprintln!("mainline Host cleanup errors: {cleanup:?}");
    }
    match result {
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
        Ok(Err(error)) => panic!("bounded Host checkpoint restart: {error}; cleanup={cleanup:?}"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[path = "mainline_reopen/steering.rs"]
mod steering;

#[path = "mainline_reopen/background_compaction.rs"]
mod background_compaction;

#[path = "mainline_reopen/host_load_stress.rs"]
mod host_load_stress;

#[path = "mainline_reopen/host_nightmare_stress.rs"]
mod host_nightmare_stress;

#[path = "mainline_reopen/host_hell_stress.rs"]
mod host_hell_stress;

#[path = "mainline_reopen/host_forever_soak.rs"]
mod host_forever_soak;
