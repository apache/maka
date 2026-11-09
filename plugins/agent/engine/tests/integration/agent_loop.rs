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

use crate::support::{
    agent_loop::respond,
    http::read_request,
    native::{FixtureService, NativeFixture},
};
use futures_util::future::BoxFuture;
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, SendResult},
};
use maka_agent_facts::{
    durable::{Fact, RecordedFact, RequestSpec, RunId, Terminal},
    history_snapshot::RequestSource,
    input::{MessageInput, RunInput},
    model::ModelPart,
};
use maka_agent_state::{Store, queue::MessageResolution};
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::{
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::Notify};
use uuid::Uuid;

const FIRST_MESSAGE: &str = "/skill:loop question first";

async fn skill_document(root: &Path, instructions: &'static str) {
    let directory = root.join("loop");
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: loop\ndescription: Agent loop fixture\n---\n{instructions}\n",),
        )
        .unwrap();
    })
    .await
    .unwrap();
}

struct Echo {
    current: Arc<OnceLock<(Store, RunId)>>,
    attempts: Arc<AtomicUsize>,
}

impl Handler for Echo {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "echo");
        assert!(
            context.operation().is_some(),
            "Echo must cross the actual Host mutation admission"
        );
        let current = self.current.clone();
        let attempts = self.attempts.clone();
        Box::pin(async move {
            let (state, run) = current
                .get()
                .expect("first HTTP is released only after binding its actual Run");
            let facts = state.history(*run, 0, 256).await.unwrap();
            let admitted = facts
                .iter()
                .find_map(|record| match &record.fact {
                    Fact::ToolAdmitted { tool } if tool.call == "call-1" => {
                        Some((record.revision, tool))
                    }
                    _ => None,
                })
                .expect("Agent T1 must commit before Echo can execute");
            let complete = facts
                .iter()
                .find(|record| {
                    matches!(&record.fact,
                        Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. }
                            if *attempt == admitted.1.attempt && call.id == admitted.1.call
                            && call.name == "echo" && call.input.as_json() == Some(&input)
                            && !call.provider_executed,
                    )
                })
                .expect("the complete canonical call must exist before its effect");
            assert!(complete.revision < admitted.0);
            let model = facts.iter().find(|record| matches!(&record.fact,
                Fact::ModelAttemptAdmitted { attempt, .. } if *attempt == admitted.1.attempt,
            )).expect("a real admitted model attempt must precede the call");
            assert!(model.revision < complete.revision);
            attempts.fetch_add(1, Ordering::SeqCst);
            Ok(HandlerValue::Json(input))
        })
    }
}

impl NativeOwner for Echo {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

fn service(current: Arc<OnceLock<(Store, RunId)>>, attempts: Arc<AtomicUsize>) -> FixtureService {
    FixtureService::new(
        Contract {
            name: "fixture.Echo".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "echo".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: json!({"type":"object"}).into(),
                        output: json!({"type":"object"}).into(),
                        resources: BTreeMap::new(),
                        progress: None,
                    },
                )]),
            },
        },
        Arc::new(Echo { current, attempts }),
    )
}

fn configuration(workspace: &Path) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en", "skillLibrary":"skills", "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":[{
            "name":"echo", "description":"echo", "method":"echo", "nestable":true,
            "target":{"kind":"import","name":"fixture"}, "result":"json",
            "confirmation":"preapproved",
        }],
    })).unwrap()
}

fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}

fn returned(reply: &OperationReply) -> &Value {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => value,
        receipt => panic!("expected a real successful SDK receipt: {receipt:?}"),
    }
}

async fn delivered(fixture: &NativeFixture, session: &str, message: &str) -> RunId {
    let mut changes = fixture.state.subscribe().unwrap();
    loop {
        changes.borrow_and_update();
        match fixture
            .state
            .queue()
            .resolve_message(session.into(), message.into())
            .await
            .unwrap()
        {
            MessageResolution::Delivered { run, shared: false } => return run,
            MessageResolution::Pending => changes.changed().await.unwrap(),
            other => panic!("original message was not admitted exactly once: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loop_commits_before_effects_replays_history_after_reopen_and_rejects_duplicate_admission()
{
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let received = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let server_received = received.clone();
        let server_release = release.clone();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                if index == 0 {
                    server_received.notify_one();
                    server_release.notified().await;
                }
                respond(&mut socket, index == 0).await;
            }
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let skills = tempfile::tempdir().unwrap();
        skill_document(skills.path(), "LOOP_INSTRUCTIONS_V1").await;
        let count = Arc::new(AtomicUsize::new(0));
        let current = Arc::new(OnceLock::new());
        let fixture = NativeFixture::open_with_skills(
            directory.path(), configuration(directory.path()), service(current.clone(), count.clone()),
            skills.path(),
        ).await.unwrap();
        let model = fixture.configure_model(&base, "gpt-4.1", "do-not-persist-this-secret").await.unwrap();

        for invalid_cwd in ["relative", "/invalid\0path"] {
            let rejected = fixture.mutation_value("create", json!({
                "title":"invalid", "labels":[], "backend":backend(&model),
                "workspace":{"kind":"directory","path":invalid_cwd},
            })).await.unwrap();
            assert_eq!(rejected, json!({"kind":"rejected","reason":"workspace_unavailable"}));
        }
        let session = fixture.create("Agent loop", directory.path(), Some(backend(&model))).await.unwrap();
        let invalid = fixture.mutation_value("send", json!({
            "sessionId":session, "message":"invalid-model", "delivery":"queue",
            "backend":{"kind":"model","connectionId":model.connection_id,"modelId":"not-the-dispatched-model","thinkingLevel":null},
        })).await.unwrap();
        assert_eq!(invalid, json!({"kind":"rejected","sessionId":session,"reason":"model_unavailable","skills":null}));
        assert!(fixture.state.runs(session.clone(), None, 8).await.unwrap().is_empty(), "invalid context must not publish an admission");
        assert!(fixture.state.queue().read(session.clone()).await.unwrap().entries.is_empty());
        assert_eq!(fixture.query("history", json!({"sessionId":session,"position":{"kind":"start"}})).await.unwrap()["chunks"], json!([]));
        assert_eq!(count.load(Ordering::SeqCst), 0);

        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"message":FIRST_MESSAGE,"delivery":"queue"});
        let original = fixture.mutation("send", input.clone(), operation).await.unwrap();
        let SendResult::Queued { message_id, .. } = serde_json::from_value(returned(&original).clone()).unwrap() else {
            panic!("original send must return its actual queued acknowledgment; kind={}, reason={}", returned(&original)["kind"], returned(&original)["reason"]);
        };
        let run = delivered(&fixture, &session, &message_id).await;
        current.set((fixture.state.clone(), run)).unwrap_or_else(|_| panic!("bind the one actual Run once"));
        received.notified().await;
        let before_release = fixture.state.history(run, 0, 256).await.unwrap();
        assert!(matches!(before_release[0].fact, Fact::RunAdmitted { .. }));
        assert_eq!(before_release.iter().filter(|fact| matches!(fact.fact, Fact::ModelAttemptAdmitted { .. })).count(), 1);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let (step, request_ref) = before_release.iter().find_map(|record| match &record.fact {
            Fact::StepPrepared { step, request, .. } => Some((*step, request.clone())), _ => None,
        }).unwrap();
        let request: RequestSpec = fixture.state.request(run, step).await.unwrap();
        assert_eq!(request.accounting.model_id, "gpt-4.1");
        // This actual SDK capture is immutable evidence, never a saved grant
        // or an activation/checkpoint facade used to start another effect.
        let frozen_capture = fixture.state.content(run, request.source_capture.clone()).await.unwrap();
        let source: RequestSource = serde_json::from_slice(&frozen_capture).unwrap();
        assert_eq!(source.current.session, session);
        assert_eq!(source.current_revision, 1);
        skill_document(skills.path(), "LOOP_INSTRUCTIONS_V2").await;

        // The Host returns the original receipt even while that Run is live;
        // this is not another queue command, freeze or logical admission.
        let duplicate = fixture.mutation("send", input.clone(), operation).await.unwrap();
        assert_eq!(duplicate.reference, original.reference);
        let (Receipt::Recorded { outcome: original_outcome, cleanup: original_cleanup },
            Receipt::Recorded { outcome: duplicate_outcome, cleanup: duplicate_cleanup }) = (&original.receipt, &duplicate.receipt) else {
            panic!("both sends must observe the recorded original receipt")
        };
        assert_eq!(duplicate_outcome, original_outcome);
        assert!(matches!((original_cleanup, duplicate_cleanup),
            (OperationCleanup::Unconfirmed, OperationCleanup::Unconfirmed | OperationCleanup::Confirmed)
            | (OperationCleanup::Confirmed, OperationCleanup::Confirmed)),
            "cleanup may advance independently, never regress or become failed");
        assert_eq!(fixture.state.runs(session.clone(), None, 8).await.unwrap(), vec![run]);
        assert!(fixture.state.queue().read(session.clone()).await.unwrap().entries.is_empty());
        assert_eq!(fixture.state.history(run, 0, 256).await.unwrap(), before_release);
        release.notify_one();
        let completed = fixture.wait_terminal(run).await.unwrap();
        assert_eq!(completed.terminal, Some(Terminal::Completed));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let facts: Vec<RecordedFact> = fixture.state.history(run, 0, 256).await.unwrap();
        assert_eq!(facts.iter().filter(|record| matches!(record.fact, Fact::StepPrepared { .. })).count(), 2);
        let frozen_input: RunInput = serde_json::from_slice(&fixture.state.content(run, completed.spec.input.clone()).await.unwrap()).unwrap();
        let RunInput::Message { content, source_messages, .. } = frozen_input else { panic!("actual Message input") };
        assert_eq!(content.display_text.as_deref(), Some(FIRST_MESSAGE));
        assert!(content.text.contains("LOOP_INSTRUCTIONS_V1"));
        assert!(content.text.contains("<user-message>\nquestion first\n</user-message>"));
        assert!(!content.text.contains("/skill:loop"));
        assert!(!content.text.contains("LOOP_INSTRUCTIONS_V2"));
        assert_eq!(content.preparation.len(), 1);
        assert_eq!(content.preparation[0].receipt["invocation"]["receipts"][0]["success"], true);
        let prepared_text = content.text;
        assert_eq!(source_messages.len(), 1);
        assert_eq!(source_messages[0].message.message_id, message_id);
        assert_eq!(source_messages[0].unprepared_content.text, FIRST_MESSAGE);
        assert_eq!(source_messages[0].message.submitted_content_digest, MessageInput::from(FIRST_MESSAGE).content_digest().unwrap());
        assert_eq!(fixture.state.queue().resolve_message(session.clone(), message_id.clone()).await.unwrap(),
            MessageResolution::Delivered { run, shared: false });
        assert!(fixture.state.queue().read(session.clone()).await.unwrap().entries.is_empty());
        assert!(!serde_json::to_string(&facts).unwrap().contains("do-not-persist-this-secret"));
        for reference in facts.iter().flat_map(|record| record.fact.content_refs()) {
            let payload = fixture.state.content(run, reference.clone()).await.unwrap();
            assert!(!String::from_utf8_lossy(&payload).contains("do-not-persist-this-secret"));
        }
        let owner = completed.spec.owner.clone();
        let history = fixture.state.session_history(owner.clone(), session.clone());
        let cut = history.capture().await.unwrap();
        let prefix = history.page(&cut, 0, 256).await.unwrap();
        let visible = fixture.query("history", json!({"sessionId":session,"position":{"kind":"start"}})).await.unwrap();
        assert!(visible["chunks"].as_array().unwrap().iter().any(|chunk| chunk["messageId"] == message_id && chunk["text"] == FIRST_MESSAGE));
        assert!(!visible["chunks"].as_array().unwrap().iter().any(|chunk| chunk["text"].as_str().is_some_and(|text| text.contains("LOOP_INSTRUCTIONS_V1"))));
        drop(history);
        fixture.shutdown().await.unwrap();
        drop(current);

        let fixture = NativeFixture::open_with_skills(
            directory.path(), configuration(directory.path()),
            service(Arc::new(OnceLock::new()), count.clone()),
            skills.path(),
        ).await.unwrap();
        let reopened_model = fixture.configure_model(&base, "gpt-4.1", "do-not-persist-this-secret").await.unwrap();
        assert_eq!(reopened_model, model);
        assert_eq!(fixture.state.history(run, 0, 256).await.unwrap(), facts);
        assert_eq!(fixture.state.content(run, request.source_capture.clone()).await.unwrap(), frozen_capture);
        assert_eq!(fixture.state.request(run, step).await.unwrap(), request);
        assert_eq!(fixture.state.content(run, request_ref).await.unwrap(), serde_json::to_vec(&request).unwrap());
        let history = fixture.state.session_history(owner, session.clone());
        assert_eq!(history.page(&cut, 0, 256).await.unwrap(), prefix);
        assert_eq!(fixture.query("history", json!({"sessionId":session,"position":{"kind":"start"}})).await.unwrap(), visible);
        let duplicate = fixture.mutation("send", input, operation).await.unwrap();
        assert_eq!(duplicate.reference, original.reference);
        let Receipt::Recorded { outcome, .. } = &original.receipt else {
            panic!("original send must have a recorded outcome")
        };
        assert_eq!(duplicate.receipt, Receipt::Recorded {
            outcome: outcome.clone(), cleanup: OperationCleanup::Confirmed,
        });
        assert_eq!(fixture.state.runs(session.clone(), None, 8).await.unwrap(), vec![run]);

        let SendResult::Queued { message_id: next_message, .. } = fixture.send(&session, "question next", None).await.unwrap() else {
            panic!("next message must receive an actual acknowledgment");
        };
        let next = delivered(&fixture, &session, &next_message).await;
        assert_ne!(next, run);
        assert_eq!(fixture.wait_terminal(next).await.unwrap().terminal, Some(Terminal::Completed));
        assert_eq!(count.load(Ordering::SeqCst), 1, "committed Echo results are projected, never executed again");
        assert_eq!(fixture.state.history(run, 0, 256).await.unwrap(), facts);
        assert_eq!(fixture.state.runs(session.clone(), None, 8).await.unwrap().len(), 2);
        assert!(fixture.state.queue().read(session).await.unwrap().entries.is_empty());
        drop(history);
        fixture.shutdown().await.unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        let conversation = |request: &Value| {
            request["messages"].as_array().unwrap().iter()
                .filter(|message| message["role"] != "system").cloned().collect::<Vec<_>>()
        };
        assert_eq!(conversation(&requests[0]), vec![json!({"role":"user","content":prepared_text})]);
        for request in &requests {
            let replay = serde_json::to_string(&conversation(request)).unwrap();
            assert!(!replay.contains("/skill:loop"), "display-only invocation text must never enter model conversation");
            assert!(!replay.contains("LOOP_INSTRUCTIONS_V2"), "original input remains frozen after Library changes and Root reopen");
        }
        let second = conversation(&requests[1]);
        let result = second.iter().find(|message| message["role"] == "tool").unwrap();
        assert_eq!(result["tool_call_id"], "call-1");
        assert_eq!(serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(), json!({"value":42}));
        let after_reopen = conversation(&requests[2]);
        assert_eq!(&after_reopen[..second.len()], second.as_slice());
        assert_eq!(after_reopen.last().unwrap(), &json!({"role":"user","content":"question next"}));
    }).await.expect("agent loop must make bounded progress");
}
