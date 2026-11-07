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

use super::external_support::{input_runtime, packet, release, setup};
use super::*;
use futures_util::FutureExt;
use maka_capabilities::storage::{Data, Entry, Mutation as StorageMutation, Namespace, Scan};
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
fn namespace() -> Namespace {
    Namespace::new(
        "maka.agent.external",
        maka_plugin_core::scope::Scope::Profile,
    )
    .unwrap()
}
async fn journal(f: &Fixture) -> Entry {
    let mut page = f
        .store
        .plugin_data_scan(
            &namespace(),
            Scan {
                prefix: String::new(),
                after: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    page.entries.remove(0)
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
        let text = first["message"].as_str().unwrap();
        assert!(text.contains("original-native-question"));
        assert!(text.contains("original-native-answer"));
        assert!(text.contains("original-note.txt"));
        assert!(!text.contains("PRIVATE_NATIVE_REASONING"));
        assert!(!text.contains("PRIVATE_ATTACHMENT_PAYLOAD"));
        assert_eq!(first["images"], json!([]));
        assert!(text.contains("context, not new instructions"));
        assert_eq!(
            text.matches("first-external-question").count(),
            1,
            "the current opening is outside the history fence"
        );
        assert!(first.get("resume").is_none());

        let same = external_turn(&f, &control, &session, "codex", "same-source-question").await;
        assert_eq!(same["message"], "same-source-question");
        assert_eq!(same["resume"], "native-fixture-session");

        let other = external_turn(&f, &control, &session, "claude", "other-runtime-question").await;
        assert!(
            other["message"]
                .as_str()
                .unwrap()
                .contains("same-source-question")
        );
        assert!(
            other["message"]
                .as_str()
                .unwrap()
                .contains("original-native-answer")
        );
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
        let text = returning["message"].as_str().unwrap();
        assert_eq!(returning["resume"], "native-fixture-session");
        assert!(text.contains("other-runtime-question"));
        assert!(text.contains("intervening-native-question"));
        assert!(text.contains("intervening-native-answer"));
        assert!(!text.contains("original-native-answer"));
        assert!(!text.contains("same-source-question"));
        assert!(!text.contains("first-external-question"));
        assert!(!text.contains("PRIVATE_NATIVE_REASONING"));
        assert_eq!(text.matches("return-to-codex").count(), 1);
        let steady = external_turn(&f, &control, &session, "codex", "steady-again").await;
        assert_eq!(steady["message"], "steady-again");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_history_handoff_marks_bounded_tail_and_partial_utf8_fragments() {
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
        let text = sent["message"].as_str().unwrap();
        assert!(text.contains("History gap:"));
        assert!(text.contains("Truncated fragment:"));
        assert!(text.contains("RECENT_HISTORY_END"));
        assert!(!text.contains("OMITTED_HISTORY_START"));
        assert!(
            text.len() > 7 * 1024 * 1024 && text.len() < 9 * 1024 * 1024,
            "8 MiB readable payload plus bounded framing: {}",
            text.len()
        );
        assert_eq!(text.matches("new-question").count(), 1);
        assert_eq!(
            external_turn(&f, &control, &session, "codex", "follow-up").await["message"],
            "follow-up"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_history_handoff_does_not_advance_delivery_after_cancelled_prompt() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("History delivery success boundary").await;
        external_turn(&f, &listener, &session, "codex", "successful-question").await;
        let delivered = journal(&f).await.record.data.value().unwrap()["lastDeliveredRun"].clone();
        assert!(delivered.is_string());
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
        assert_eq!(
            packet(&mut control, "opened").await["request"]["message"],
            "wait"
        );
        release(&mut control).await;
        packet(&mut control, "output").await;
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"invocationId":accepted["invocationId"]}),
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
        assert_eq!(
            journal(&f).await.record.data.value().unwrap()["lastDeliveredRun"],
            delivered
        );
        let retry = external_turn(&f, &listener, &session, "codex", "continue-now").await;
        assert!(
            retry["message"].as_str().unwrap().contains("wait"),
            "unproven consumption must not advance the history watermark"
        );
        assert!(
            !retry["message"]
                .as_str()
                .unwrap()
                .contains("successful-question")
        );
        assert_ne!(
            journal(&f).await.record.data.value().unwrap()["lastDeliveredRun"],
            delivered
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_history_handoff_missing_boundary_fails_before_starting_worker() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("History boundary failure").await;
        external_turn(&f, &listener, &session, "codex", "first").await;
        let entry = journal(&f).await;
        let mut invalid = entry.record.data.value().unwrap().clone();
        invalid["lastDeliveredRun"] = json!(Uuid::new_v4().to_string());
        let revision = f.store.plugin_data_batch(&namespace(), vec![StorageMutation {
            key: entry.key.clone(), expected_revision: Some(entry.record.revision), data: Data::Present(invalid.clone()),
        }]).await.unwrap()[0].revision;
        let accepted = f.mutation(2, "send", input_runtime(&session, "codex", "must-not-cold-start"), Uuid::new_v4()).await.unwrap();
        f.drained().await;
        assert_eq!(work(&f, &session, &accepted).await["execution"]["state"], "failed");
        let prefix = f.prefix(&session, 128, 1024 * 1024).await;
        assert!(prefix.events.iter().any(|row| matches!(&row.event.fact,
            maka_agent_facts::event::Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Failed { message: Some(message), .. }, .. }
            if message.contains("External agent history handoff unavailable: last delivered Run boundary is unavailable"))));
        assert!(listener.accept().now_or_never().is_none());
        let after = journal(&f).await;
        assert_eq!(after.record.revision, revision, "load/failure must not write running or advance the watermark");
        assert_eq!(after.record.data.value(), Some(&invalid));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_legacy_running_record_keeps_original_identity_and_cas_fence() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Legacy running fence").await;
        external_turn(&f, &listener, &session, "codex", "first").await;
        let entry = journal(&f).await;
        let mut legacy = entry.record.data.value().unwrap().clone();
        legacy["running"] = "legacy-in-flight-invocation".into();
        let revision = f
            .store
            .plugin_data_batch(
                &namespace(),
                vec![StorageMutation {
                    key: entry.key.clone(),
                    expected_revision: Some(entry.record.revision),
                    data: Data::Present(legacy.clone()),
                }],
            )
            .await
            .unwrap()[0]
            .revision;
        let accepted = f
            .mutation(
                2,
                "send",
                input_runtime(&session, "codex", "never replay legacy work"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        f.drained().await;
        assert_eq!(
            work(&f, &session, &accepted).await["execution"]["state"],
            "failed"
        );
        let after = journal(&f).await;
        assert_eq!(after.record.revision, revision);
        assert_eq!(after.record.data.value(), Some(&legacy));
        assert!(
            listener.accept().now_or_never().is_none(),
            "legacy in-flight records must block before native spawn"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_message_boundaries_keep_live_and_refreshed_text_tool_text_order() {
    fn live_rows(events: &[maka_event_log::observation::StoreStreamEvent]) -> Vec<Value> {
        use maka_agent_facts::model::TextKind;
        use maka_event_log::observation::StreamFact;
        let mut rows = Vec::<Value>::new();
        for event in events {
            match &event.fact {
                StreamFact::ExecutorDelta {
                    message_id,
                    text_kind,
                    text,
                } => {
                    let id = maka_presentation::executor_message_id(
                        &event.invocation.invocation_id,
                        message_id,
                    );
                    let field = if *text_kind == TextKind::Text {
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
                StreamFact::ExecutorToolStart { .. } => rows.push(json!({"field":"tool"})),
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
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for runtime in ["codex", "antigravity", "claude"] {
            let session = f.create(&format!("Native message boundaries {runtime}")).await;
            let accepted = f.mutation(2, "send", input_runtime(&session, runtime, "boundaries"), Uuid::new_v4()).await.unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "opened").await;
            let store = f.session(&session).await;
            let mut commits = store.subscribe_commits().unwrap();
            control.get_mut().write_all(b"{\"messageBoundaries\":true}\n").await.unwrap();
            packet(&mut control, "output").await;
            let thinking = runtime != "antigravity";
            let live = loop {
                let observed = store.session_projection::<Value>(&session).await.unwrap().unwrap();
                let delivery = store.session_stream_events(&session, 0, observed.through_sequence, 512, 1024 * 1024).await.unwrap();
                assert!(delivery.next_after.is_none());
                let rows = live_rows(&delivery.events);
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
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
