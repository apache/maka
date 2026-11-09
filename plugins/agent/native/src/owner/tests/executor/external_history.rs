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

use super::external_support::{input_runtime, native_task, packet, release, setup};
use super::*;
use futures_util::FutureExt;
use tokio::io::BufReader;

async fn native_turn(
    f: &Fixture,
    listener: &TcpListener,
    session: &str,
    message: &str,
    answer: &str,
    attachments: Vec<Value>,
) {
    let accepted = f
        .mutation(
            2,
            "send",
            json!({
                "sessionId":session, "message":message,
                "backend":model_backend(&f.selection().await), "attachments":attachments,
            }),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(accepted["kind"], "started", "{accepted}");
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    let observed = f
        .query("observe", json!({"sessionId":session}))
        .await
        .unwrap();
    assert_eq!(observed["run"]["backend"], "model");
    response_with_thinking(&mut socket, answer, Some("PRIVATE_NATIVE_REASONING")).await;
    f.drained().await;
    assert_eq!(
        work(f, session, &accepted).await["execution"]["state"],
        "completed"
    );
}
async fn external_turn(
    f: &Fixture,
    listener: &TcpListener,
    session: &str,
    runtime: &str,
    message: &str,
) -> Value {
    let accepted = f
        .mutation(
            2,
            "send",
            input_runtime(session, runtime, message),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(accepted["kind"], "started", "{accepted}");
    let mut control = BufReader::new(listener.accept().await.unwrap().0);
    let opened = packet(&mut control, "opened").await;
    release(&mut control).await;
    packet(&mut control, "output").await;
    release(&mut control).await;
    packet(&mut control, "terminal").await;
    release(&mut control).await;
    f.drained().await;
    assert_eq!(
        work(f, session, &accepted).await["execution"]["state"],
        "completed"
    );
    opened["request"].clone()
}
fn history_text(request: &Value) -> &str {
    request["canonicalHistory"]["text"]
        .as_str()
        .expect("fixture read the actual private readonly history file")
}
fn current_message(request: &Value) -> &str {
    request["message"]
        .as_str()
        .unwrap()
        .split_once("\n\n--- Current user message ---\n")
        .expect("current input is separate from the history file reference")
        .1
}

#[tokio::test]
async fn native_external_history_handoff_catches_up_native_and_other_runtimes_without_replay() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let native = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, control) = setup(&format!("http://{}/v1", native.local_addr().unwrap())).await;
        let session = f.create("Cross-source readable history").await;
        let upload = super::super::attachments::upload(
            &f,
            &session,
            "original-note.txt",
            b"PRIVATE_ATTACHMENT_PAYLOAD",
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        native_turn(
            &f,
            &native,
            &session,
            "original-native-question",
            "original-native-answer",
            vec![upload["attachment"]["id"].clone()],
        )
        .await;
        let first = external_turn(&f, &control, &session, "codex", "first-external-question").await;
        let text = history_text(&first);
        assert!(text.contains("original-native-question"));
        assert!(text.contains("original-native-answer"));
        assert!(!text.contains("first-external-question"));
        assert!(text.contains("original-note.txt"));
        assert!(!text.contains("PRIVATE_NATIVE_REASONING"));
        assert!(!text.contains("PRIVATE_ATTACHMENT_PAYLOAD"));
        assert_eq!(first["images"], json!([]));
        assert!(
            first["canonicalHistory"]["path"]
                .as_str()
                .unwrap()
                .ends_with("canonical-history.md")
        );
        assert_eq!(
            current_message(&first)
                .matches("first-external-question")
                .count(),
            1,
            "the current opening is outside the history fence"
        );
        assert!(first.get("resume").is_none());

        let same = external_turn(&f, &control, &session, "codex", "same-source-question").await;
        assert_eq!(current_message(&same), "same-source-question");
        assert!(history_text(&same).contains("first-external-question"));
        assert!(same.get("resume").is_none());
        assert_ne!(
            same["canonicalHistory"]["path"],
            first["canonicalHistory"]["path"]
        );

        let other = external_turn(&f, &control, &session, "claude", "other-runtime-question").await;
        assert!(history_text(&other).contains("same-source-question"));
        assert!(history_text(&other).contains("original-native-answer"));
        assert!(other.get("resume").is_none());
        native_turn(
            &f,
            &native,
            &session,
            "intervening-native-question",
            "intervening-native-answer",
            Vec::new(),
        )
        .await;

        let returning = external_turn(&f, &control, &session, "codex", "return-to-codex").await;
        let text = history_text(&returning);
        assert!(returning.get("resume").is_none());
        assert!(text.contains("other-runtime-question"));
        assert!(text.contains("intervening-native-question"));
        assert!(text.contains("intervening-native-answer"));
        assert!(text.contains("original-native-answer"));
        assert!(text.contains("same-source-question"));
        assert!(text.contains("first-external-question"));
        assert!(!text.contains("PRIVATE_NATIVE_REASONING"));
        assert_eq!(current_message(&returning), "return-to-codex");
        assert!(!text.contains("return-to-codex"));
        let steady = external_turn(&f, &control, &session, "codex", "steady-again").await;
        assert_eq!(current_message(&steady), "steady-again");
        assert!(history_text(&steady).contains("return-to-codex"));
        assert!(steady.get("resume").is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_history_handoff_streams_complete_utf8_without_inline_tail_truncation() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let native = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, control) = setup(&format!("http://{}/v1", native.local_addr().unwrap())).await;
        let session = f.create("Bounded history").await;
        let answer = format!(
            "OMITTED_HISTORY_START{}RECENT_HISTORY_END",
            "中文字".repeat(1_000_000)
        );
        // Seed a large canonical UTF-8 field, then switch native runtimes.
        external_turn(&f, &control, &session, "antigravity", &answer).await;
        let sent = external_turn(&f, &control, &session, "codex", "new-question").await;
        let text = history_text(&sent);
        assert!(!text.contains("History gap:"));
        assert!(!text.contains("Truncated fragment:"));
        assert!(text.contains("RECENT_HISTORY_END"));
        assert!(text.contains("OMITTED_HISTORY_START"));
        assert!(
            text.len() >= answer.len(),
            "the streaming file must not discard a large canonical UTF-8 field: {}",
            text.len()
        );
        assert_eq!(text.matches("中文字").count(), 1_000_000);
        assert_eq!(current_message(&sent), "new-question");
        assert!(!text.contains("new-question"));
        assert!(sent["message"].as_str().unwrap().len() < 4096);
        let follow = external_turn(&f, &control, &session, "codex", "follow-up").await;
        assert_eq!(current_message(&follow), "follow-up");
        assert!(history_text(&follow).contains("RECENT_HISTORY_END"));
        assert!(history_text(&follow).contains("new-question"));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_history_handoff_preserves_cancelled_task_and_rebuilds_fresh_context() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("History delivery success boundary").await;
        external_turn(&f, &listener, &session, "codex", "successful-question").await;
        let delivered = native_task(&f, &session).await;
        assert_eq!(
            delivered.state.closed.as_ref().unwrap().outcome,
            maka_agent_facts::durable::Terminal::Completed
        );
        let accepted = f
            .mutation(
                2,
                "send",
                input_runtime(&session, "codex", "wait"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut control, "opened").await;
        assert_eq!(current_message(&opened["request"]), "wait");
        let waiting = native_task(&f, &session).await;
        assert_ne!(waiting.state.task, delivered.state.task);
        release(&mut control).await;
        packet(&mut control, "output").await;
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"runId":accepted["runId"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        packet(&mut control, "terminal").await;
        release(&mut control).await;
        f.drained().await;
        assert_eq!(
            work(&f, &session, &accepted).await["execution"]["state"],
            "cancelled"
        );
        let cancelled = f
            .owner
            .durable
            .frontier(waiting.execution.run_id)
            .await
            .unwrap()
            .external
            .unwrap();
        assert_eq!(cancelled.task, waiting.state.task);
        assert_eq!(cancelled.descriptor, waiting.state.descriptor);
        assert_eq!(
            cancelled.closed.as_ref().unwrap().outcome,
            maka_agent_facts::durable::Terminal::Cancelled
        );
        let retry = external_turn(&f, &listener, &session, "codex", "continue-now").await;
        assert!(
            history_text(&retry).contains("wait"),
            "a cancelled original input remains part of canonical context"
        );
        assert!(history_text(&retry).contains("successful-question"));
        assert_eq!(current_message(&retry), "continue-now");
        assert!(retry.get("resume").is_none());
        let fresh = native_task(&f, &session).await;
        assert_ne!(fresh.state.task, waiting.state.task);
        let original = f
            .owner
            .durable
            .frontier(waiting.execution.run_id)
            .await
            .unwrap()
            .external
            .unwrap();
        assert_eq!(original.closed, cancelled.closed);
        assert_eq!(original.descriptor, cancelled.descriptor);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

struct ReadOnlyObservation {
    retired: tokio_util::sync::CancellationToken,
}
impl maka_agent_ports::executor::OutputSink for ReadOnlyObservation {
    fn emit(
        &self,
        _: maka_agent_facts::executor::Output,
    ) -> futures_util::future::BoxFuture<'_, Result<(), maka_agent_ports::executor::Error>> {
        Box::pin(async { panic!("invalid original material must not publish output") })
    }
}
impl crate::executor::external::TaskBinding for ReadOnlyObservation {
    fn observation_retired(&self) -> tokio_util::sync::CancellationToken {
        self.retired.clone()
    }
    fn admitted_steering_batches(
        &self,
    ) -> futures_util::future::BoxFuture<'_, Result<u64, maka_agent_ports::executor::Error>> {
        Box::pin(async { panic!("invalid original material must not request input proof") })
    }
    fn stop_requested(
        &self,
    ) -> futures_util::future::BoxFuture<'_, Result<bool, maka_agent_ports::executor::Error>> {
        Box::pin(async { panic!("read-only rejection must not request process control") })
    }
    fn bound(
        &self,
        _: crate::executor::external::NativeBinding,
    ) -> futures_util::future::BoxFuture<'_, Result<(), maka_agent_ports::executor::Error>> {
        Box::pin(async { panic!("read-only rejection must not bind a new job") })
    }
    fn closed(
        &self,
        _: maka_agent_ports::executor::Outcome,
    ) -> futures_util::future::BoxFuture<'_, Result<(), maka_agent_ports::executor::Error>> {
        Box::pin(async { panic!("invalid original material cannot prove business closure") })
    }
    fn cleanup(
        &self,
        _: maka_plugin_core::operation::OperationCleanup,
    ) -> futures_util::future::BoxFuture<'_, Result<(), maka_agent_ports::executor::Error>> {
        Box::pin(async { panic!("invalid original material cannot prove original cleanup") })
    }
}
async fn observe_original_rejection(
    f: &Fixture,
    original: &super::external_support::NativeTaskSource,
    binding: &crate::executor::external::NativeBinding,
) -> crate::executor::external::NativeTaskObservation {
    let reader = f
        .owner
        .executors
        .captured_external()
        .expect("original captured external reader");
    let observer = Arc::new(ReadOnlyObservation {
        retired: tokio_util::sync::CancellationToken::new(),
    });
    reader
        .observe_task(
            &original.request,
            binding,
            original.state.descriptor.clone(),
            original.state.observed,
            None,
            observer.clone(),
            observer,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn native_external_history_missing_original_material_blocks_without_a_replacement_worker() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Original evidence failure").await;
        external_turn(&f, &listener, &session, "codex", "first").await;
        let original = native_task(&f, &session).await;
        let before = f
            .owner
            .durable
            .frontier(original.execution.run_id)
            .await
            .unwrap();
        let mut missing = original.binding.clone().unwrap();
        let absent = tempfile::tempdir().unwrap();
        missing.resource.resource_ref = absent.path().join("missing-original-resource");
        let observed = observe_original_rejection(&f, &original, &missing).await;
        let crate::executor::external::NativeTaskObservation::Blocked {
            reason: maka_agent_facts::durable::BlockerKind::ExternalTaskUnobservable { descriptor },
            diagnostic,
        } = observed
        else {
            panic!("missing original material must block observation")
        };
        assert_eq!(descriptor, original.state.descriptor);
        assert!(diagnostic.contains("Original isolated"), "{diagnostic}");
        assert!(
            listener.accept().now_or_never().is_none(),
            "missing evidence must not cold-start a replacement producer"
        );
        let after = f
            .owner
            .durable
            .frontier(original.execution.run_id)
            .await
            .unwrap();
        assert_eq!(
            after.revision, before.revision,
            "read-only failure must not advance the canonical prefix"
        );
        assert_eq!(
            after.external, before.external,
            "original task identity, result and input remain unchanged"
        );
        assert_eq!(
            native_task(&f, &session).await.state.task,
            original.state.task
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_unsupported_original_binding_keeps_task_identity_and_revision_fence() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Unsupported original binding fence").await;
        external_turn(&f, &listener, &session, "codex", "first").await;
        let original = native_task(&f, &session).await;
        let before = f
            .owner
            .durable
            .frontier(original.execution.run_id)
            .await
            .unwrap();
        let mut legacy = original.binding.clone().unwrap();
        legacy.adapter_version = 1;
        let observed = observe_original_rejection(&f, &original, &legacy).await;
        let crate::executor::external::NativeTaskObservation::Blocked {
            reason: maka_agent_facts::durable::BlockerKind::ExternalTaskUnobservable { descriptor },
            diagnostic,
        } = observed
        else {
            panic!("unsupported original protocol must not restart its producer")
        };
        assert_eq!(descriptor, original.state.descriptor);
        assert!(diagnostic.contains("protocol"), "{diagnostic}");
        let after = f
            .owner
            .durable
            .frontier(original.execution.run_id)
            .await
            .unwrap();
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.external, before.external);
        assert_eq!(
            serde_json::to_value(native_task(&f, &session).await.binding).unwrap(),
            serde_json::to_value(&original.binding).unwrap()
        );
        assert!(
            listener.accept().now_or_never().is_none(),
            "legacy protocol cannot be upgraded by replaying old work"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_message_boundaries_keep_live_and_refreshed_text_tool_text_order() {
    fn send_value(reply: &maka_plugin_core::operation::OperationReply) -> Value {
        use maka_plugin_core::operation::{OperationOutcome, OperationResult, Receipt};
        match &reply.receipt {
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Success { value },
                    },
                ..
            } => value.clone(),
            _ => panic!("original SDK send receipt: {reply:?}"),
        }
    }
    async fn frozen_run(
        f: &Fixture,
        session: &str,
        run: maka_agent_facts::durable::RunId,
    ) -> (
        maka_agent_state::session_history::RunSource,
        Vec<(maka_agent_facts::durable::ContentRef, Vec<u8>)>,
    ) {
        let source = f.history(session).run_source(run).await.unwrap();
        let task = f
            .owner
            .durable
            .frontier(run)
            .await
            .unwrap()
            .external
            .unwrap();
        let mut refs = vec![source.spec.input.clone(), task.descriptor];
        refs.extend(task.binding);
        let mut contents = Vec::new();
        for reference in refs {
            let bytes = f
                .owner
                .durable
                .content(run, reference.clone())
                .await
                .unwrap();
            contents.push((reference, bytes));
        }
        (source, contents)
    }
    fn live_rows(events: &[maka_agent_facts::durable::RecordedFact]) -> Vec<Value> {
        use maka_agent_facts::{durable::Fact, executor::Output};
        let mut rows = Vec::<Value>::new();
        for event in events {
            match &event.fact {
                Fact::ExternalTaskObserved {
                    output:
                        output @ (Output::OutputDelta { message_id, text }
                        | Output::ThinkingDelta { message_id, text }),
                    ..
                } => {
                    let id = maka_presentation::executor_message_id(event.run, message_id);
                    let field = if matches!(output, Output::OutputDelta { .. }) {
                        "body"
                    } else {
                        "thinking"
                    };
                    if let Some(row) = rows
                        .iter_mut()
                        .find(|row| row["messageId"] == id && row["field"] == field)
                    {
                        let joined = format!("{}{text}", row["text"].as_str().unwrap());
                        row["text"] = joined.into();
                    } else {
                        rows.push(json!({"messageId":id,"field":field,"text":text}));
                    }
                }
                Fact::ExternalTaskObserved {
                    output: Output::ToolStart { .. },
                    ..
                } => rows.push(json!({"field":"tool"})),
                _ => {}
            }
        }
        rows
    }
    fn history_rows(history: &Value) -> Vec<Value> {
        let mut tools = std::collections::BTreeSet::new();
        history["chunks"].as_array().unwrap().iter().filter_map(|chunk| {
            if chunk["role"] == "user" { return None; }
            if !chunk["tool"].is_null() {
                return tools.insert(chunk["tool"]["toolUseId"].as_str().unwrap()).then(|| json!({"field":"tool"}));
            }
            if chunk["text"] == "" { return None; }
            Some(json!({"messageId":chunk["messageId"],"field":chunk["field"],"text":chunk["text"]}))
        }).collect()
    }
    fn assert_order(rows: &[Value], thinking: bool) {
        let before = rows
            .iter()
            .position(|row| row["text"] == "before tool")
            .unwrap();
        let tool = rows.iter().position(|row| row["field"] == "tool").unwrap();
        let after = rows
            .iter()
            .position(|row| row["text"] == "after tool")
            .unwrap();
        assert!(before < tool && tool < after, "{rows:?}");
        assert_ne!(rows[before]["messageId"], rows[after]["messageId"]);
        let bodies: Vec<_> = rows
            .iter()
            .filter(|row| row["field"] == "body")
            .map(|row| row["text"].as_str().unwrap())
            .collect();
        assert_eq!(bodies, ["before tool", "after tool"]);
        let thoughts: Vec<_> = rows
            .iter()
            .filter(|row| row["field"] == "thinking")
            .map(|row| row["text"].as_str().unwrap())
            .collect();
        if thinking {
            assert_eq!(thoughts, ["native summary", "native snapshot"]);
        } else {
            assert!(thoughts.is_empty());
        }
    }
    tokio::time::timeout(Duration::from_secs(90), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for runtime in ["codex", "antigravity", "claude"] {
            let session = f.create(&format!("Native message boundaries {runtime}")).await;
            let accepted = f.mutation(2, "send", input_runtime(&session, runtime, "boundaries"), Uuid::new_v4()).await.unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "opened").await;
            let mut commits = f.owner.durable.subscribe().unwrap();
            control.get_mut().write_all(b"{\"messageBoundaries\":true}\n").await.unwrap();
            packet(&mut control, "output").await;
            let thinking = runtime != "antigravity";
            let live = loop {
                commits.borrow_and_update();
                let facts = f.recorded_facts(&session).await;
                let rows = live_rows(&facts);
                let last = if thinking { "native snapshot" } else { "after tool" };
                if rows.iter().any(|row| row["text"] == last) { break rows; }
                commits.changed().await.unwrap();
            };
            assert_order(&live, thinking);
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            release(&mut control).await;
            f.drained().await;
            let result = work(&f, &session, &accepted).await;
            assert_eq!(result["execution"]["state"], "completed", "{runtime}: {result}");
            assert_eq!(result["answer"]["text"], "after tool");
            let refreshed = f.query("history", json!({"sessionId":session,"position":{"kind":"start"},"view":"conversation","includeThinking":true})).await.unwrap();
            let rows = history_rows(&refreshed);
            assert_order(&rows, thinking);
            assert_eq!(rows, live, "{runtime}: {refreshed}");
            let final_texts: Vec<_> = refreshed["chunks"].as_array().unwrap().iter().filter(|chunk| chunk["finalOutput"] == true).map(|chunk| chunk["text"].as_str().unwrap()).collect();
            assert_eq!(final_texts, ["after tool"]);
        }
        let mut saved=Vec::new();
        for runtime in ["claude","codex"] {
            for client_first in [true,false] {
                use maka_agent_facts::{executor::Output,input::RunInput};
                let session=f.create(&format!("SDK tool namespace {runtime} client-first={client_first}")).await;
                let client=f.app.client();
                let mut input=input_runtime(&session,runtime,"original SDK client input🙂");
                input["delivery"]=json!("queue");
                let prepared=client.prepare_mutation(f.binding(2).await,"send".into(),input.clone(),scope(&f.issuer,true),Uuid::new_v4(),Attachments::new().into()).await.unwrap();
                let reference=prepared.reference().clone();
                let client_id=format!("m_{}",f.owner.operation_id(&reference));
                let mut prepared=Some(prepared);
                let mut client_accepted=None;
                let boundary=if client_first {
                    let completion=client.mutate_owned(prepared.take().unwrap(),json!({"reference":reference})).await.unwrap().completion().await;
                    completion.cleanup.unwrap();assert_eq!(completion.reply.reference,reference);
                    let value=send_value(&completion.reply);assert_eq!(value["kind"],"started");assert_eq!(value["messageId"],client_id);
                    client_accepted=Some(value.clone());value
                } else {
                    f.mutation(2,"send",input_runtime(&session,runtime,"tool before original SDK client"),Uuid::new_v4()).await.unwrap()
                };
                let boundary_run=f.delivered_run(&boundary).await;
                let mut control=BufReader::new(listener.accept().await.unwrap().0);
                packet(&mut control,"opened").await;
                let before=frozen_run(&f,&session,boundary_run).await;
                let mut commits=f.owner.durable.subscribe().unwrap();
                let plan=json!({"messageBoundaries":true,"boundaryToolCallId":client_id});
                control.get_mut().write_all(format!("{plan}\n").as_bytes()).await.unwrap();
                packet(&mut control,"output").await;
                let observed=loop {
                    commits.borrow_and_update();let facts=f.recorded_facts(&session).await;
                    let rows=live_rows(&facts);
                    if rows.iter().any(|row|row["text"]=="native snapshot") {assert_order(&rows,true);break facts;}
                    commits.changed().await.unwrap();
                };
                let starts:Vec<_>=observed.iter().filter_map(|fact|match &fact.fact {
                    Fact::ExternalTaskObserved {task,output:Output::ToolStart {tool_call_id,input,..},..}=>Some((fact,*task,tool_call_id,input)),_=>None,
                }).collect();
                assert_eq!(starts.len(),1);
                let (tool_fact,task,provider_id,provider_input)=starts[0];
                assert_ne!(tool_fact.id.to_string(),client_id);
                if runtime=="claude" {assert_eq!(provider_id.as_bytes(),client_id.as_bytes());}
                else {assert!(provider_id.ends_with(&format!(":{client_id}")));assert_eq!(provider_input["id"].as_str().unwrap().as_bytes(),client_id.as_bytes());}
                let results:Vec<_>=observed.iter().filter_map(|fact|match &fact.fact {
                    Fact::ExternalTaskObserved {output:Output::ToolResult {tool_call_id,text,..},..} if tool_call_id==provider_id=>Some(text),_=>None,
                }).collect();
                assert_eq!(results.len(),1);
                if runtime=="codex" {assert_eq!(serde_json::from_str::<Value>(results[0]).unwrap()["id"],client_id);}
                let queued=if !client_first {
                    assert!(f.owner.durable.queue().read(session.clone()).await.unwrap().entries.is_empty());
                    let completion=client.mutate_owned(prepared.take().unwrap(),json!({"reference":reference})).await.unwrap().completion().await;
                    completion.cleanup.unwrap();assert_eq!(completion.reply.reference,reference);
                    let value=send_value(&completion.reply);assert_eq!(value["kind"],"queued");assert_eq!(value["messageId"],client_id);
                    let entries=f.owner.durable.queue().read(session.clone()).await.unwrap().entries;
                    assert_eq!(entries.len(),1);let entry=entries.into_iter().next().unwrap();assert_eq!(entry.request.message_id,client_id);
                    let source=f.owner.durable.queue().content(session.clone(),entry.request.id.clone(),entry.request.source.clone()).await.unwrap();
                    client_accepted=Some(value);Some(source)
                } else {None};
                release(&mut control).await;packet(&mut control,"terminal").await;release(&mut control).await;
                if !client_first {
                    let mut next=BufReader::new(listener.accept().await.unwrap().0);
                    let opened=packet(&mut next,"opened").await;
                    assert_eq!(current_message(&opened["request"]),"original SDK client input🙂");
                    release(&mut next).await;packet(&mut next,"output").await;
                    release(&mut next).await;packet(&mut next,"terminal").await;release(&mut next).await;
                }
                f.drained().await;
                assert_eq!(frozen_run(&f,&session,boundary_run).await,before);
                let accepted=client_accepted.unwrap();let client_run=f.delivered_run(&accepted).await;
                let client_source=frozen_run(&f,&session,client_run).await;
                let input:RunInput=serde_json::from_slice(&f.owner.durable.content(client_run,client_source.0.spec.input.clone()).await.unwrap()).unwrap();
                let RunInput::Message {source_messages,..}=input else {panic!("original SDK delivery input");};
                let original=source_messages.iter().find(|source|source.message.message_id==client_id).unwrap();
                assert_eq!(original.unprepared_content.text,"original SDK client input🙂");
                if let Some(bytes)=queued {assert_eq!(original,&serde_json::from_slice::<maka_agent_facts::message::RootSourceMessage>(&bytes).unwrap());}
                let items=f.history_items(&session).await;
                let tool_item=items.iter().find(|item|item.recorded.id==tool_fact.id).unwrap();
                if client_first {assert!(client_source.0.admission_sequence<tool_item.sequence);}else{assert!(tool_item.sequence<client_source.0.admission_sequence);}
                let facts=f.recorded_facts(&session).await;
                let ids:std::collections::BTreeSet<_>=facts.iter().map(|fact|fact.id).collect();assert_eq!(ids.len(),facts.len());
                let through=f.through(&session).await;
                let query=json!({"sessionId":session,"through":through,"position":{"kind":"start"},"view":"conversation","includeThinking":true});
                let history=f.query("history",query.clone()).await.unwrap();
                let qualified=maka_agent_facts::tool_call::tool_use_id(boundary_run,&format!("{task}:{provider_id}"));
                assert_ne!(qualified,client_id);
                let chunks=history["chunks"].as_array().unwrap();
                let tool=chunks.iter().find(|chunk|chunk["tool"]["toolUseId"]==qualified).unwrap();
                let address:maka_agent_facts::history::HistoryRowAddress=serde_json::from_value(tool["position"].clone()).unwrap();
                assert!(matches!(address,maka_agent_facts::history::HistoryRowAddress::Live {fact,..} if fact==tool_fact.id));
                assert_eq!(chunks.iter().filter(|chunk|chunk["role"]=="user"&&chunk["messageId"]==client_id&&chunk["text"]=="original SDK client input🙂").count(),1);
                let receipt=client.recover(f.binding(2).await.consumer().clone(),reference.clone(),scope(&f.issuer,true)).await.unwrap().unwrap();
                assert_eq!(receipt.reference,reference);
                assert!(matches!(&receipt.outcome,maka_plugin_core::operation::OperationOutcome::Returned {result:maka_plugin_core::operation::OperationResult::Success {value}} if value==&accepted));
                saved.push((session,reference,receipt,query,serde_json::to_vec(&history).unwrap(),facts,before,client_source));
            }
        }
        let f=super::super::model_interruption::cold_reopen(f).await;
        for (session,reference,receipt,query,history,facts,boundary,client_source) in saved {
            assert_eq!(f.recorded_facts(&session).await,facts);
            assert_eq!(frozen_run(&f,&session,boundary.0.run).await,boundary);
            assert_eq!(frozen_run(&f,&session,client_source.0.run).await,client_source);
            assert_eq!(serde_json::to_vec(&f.query("history",query).await.unwrap()).unwrap(),history);
            let reopened=f.app.client().recover(f.binding(2).await.consumer().clone(),reference,scope(&f.issuer,true)).await.unwrap().unwrap();
            assert_eq!(reopened,receipt);
        }
        assert!(listener.accept().now_or_never().is_none(),"receipt/source replay observation cannot start another native runtime");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
