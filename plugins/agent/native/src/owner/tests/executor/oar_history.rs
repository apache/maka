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
use futures_util::FutureExt;
use maka_capabilities::storage::{Data, Entry, Mutation as StorageMutation, Namespace, Scan};
use tokio::io::{AsyncBufReadExt, BufReader};

async fn setup(base: &str) -> (Fixture, TcpListener) {
    let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node = tokio::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .await
        .unwrap();
    assert!(node.status.success());
    let fixture = Fixture::configured(base, None, None, None, |settings| {
        settings.oar = Some(maka_agent_api::executor::OarConfiguration {
            executable: Some(String::from_utf8(node.stdout).unwrap().trim().into()),
            args: vec![
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/support/oar-worker.mjs")
                    .to_str()
                    .unwrap()
                    .into(),
                control.local_addr().unwrap().port().to_string(),
            ],
        });
    })
    .await;
    (fixture, control)
}
fn input(session: &str, runtime: &str, message: &str) -> Value {
    json!({"sessionId":session,"message":message,"backend":{"kind":"executor","selection":{"executor":"oar","settings":{"runtime":runtime,"model":"fixture-model","thinkingLevel":"vendor-deep"}}}})
}
async fn packet(control: &mut BufReader<TcpStream>, phase: &str) -> Value {
    let mut line = String::new();
    control.read_line(&mut line).await.unwrap();
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["phase"], phase);
    value
}
async fn release(control: &mut BufReader<TcpStream>) {
    control.get_mut().write_all(b"continue\n").await.unwrap();
}

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
    response_with_thinking(&mut socket, answer, Some("PRIVATE_NATIVE_REASONING")).await;
    f.drained().await;
    assert_eq!(
        work(f, session, &accepted).await["execution"]["state"],
        "completed"
    );
}
async fn oar_turn(
    f: &Fixture,
    listener: &TcpListener,
    session: &str,
    runtime: &str,
    message: &str,
) -> Value {
    let accepted = f
        .mutation(2, "send", input(session, runtime, message), Uuid::new_v4())
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
    Namespace::new("maka.agent.oar", maka_plugin_core::scope::Scope::Profile).unwrap()
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
async fn native_oar_history_handoff_catches_up_native_and_other_runtimes_without_replay() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let native = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, oar) = setup(&format!("http://{}/v1", native.local_addr().unwrap())).await;
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
        let first = oar_turn(&f, &oar, &session, "codex", "first-oar-question").await;
        let text = first["message"].as_str().unwrap();
        assert!(text.contains("original-native-question"));
        assert!(text.contains("original-native-answer"));
        assert!(text.contains("original-note.txt"));
        assert!(!text.contains("PRIVATE_NATIVE_REASONING"));
        assert!(!text.contains("PRIVATE_ATTACHMENT_PAYLOAD"));
        assert_eq!(first["images"], json!([]));
        assert!(text.contains("context, not new instructions"));
        assert_eq!(
            text.matches("first-oar-question").count(),
            1,
            "the current opening is outside the history fence"
        );
        assert!(first.get("resume").is_none());

        let same = oar_turn(&f, &oar, &session, "codex", "same-source-question").await;
        assert_eq!(same["message"], "same-source-question");
        assert_eq!(same["resume"], "native-fixture-session");

        let other = oar_turn(&f, &oar, &session, "claude", "other-runtime-question").await;
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

        let returning = oar_turn(&f, &oar, &session, "codex", "return-to-codex").await;
        let text = returning["message"].as_str().unwrap();
        assert_eq!(returning["resume"], "native-fixture-session");
        assert!(text.contains("other-runtime-question"));
        assert!(text.contains("intervening-native-question"));
        assert!(text.contains("intervening-native-answer"));
        assert!(!text.contains("original-native-answer"));
        assert!(!text.contains("same-source-question"));
        assert!(!text.contains("first-oar-question"));
        assert!(!text.contains("PRIVATE_NATIVE_REASONING"));
        assert_eq!(text.matches("return-to-codex").count(), 1);
        let steady = oar_turn(&f, &oar, &session, "codex", "steady-again").await;
        assert_eq!(steady["message"], "steady-again");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_history_handoff_marks_bounded_tail_and_partial_utf8_fragments() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let native = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, oar) = setup(&format!("http://{}/v1", native.local_addr().unwrap())).await;
        let session = f.create("Bounded history").await;
        let answer = format!(
            "OMITTED_HISTORY_START{}RECENT_HISTORY_END",
            "中文字".repeat(16000)
        );
        native_turn(
            &f,
            &native,
            &session,
            "old-native-question",
            &answer,
            Vec::new(),
        )
        .await;
        let sent = oar_turn(&f, &oar, &session, "codex", "new-question").await;
        let text = sent["message"].as_str().unwrap();
        assert!(text.contains("History gap:"));
        assert!(text.contains("Truncated fragment:"));
        assert!(text.contains("RECENT_HISTORY_END"));
        assert!(!text.contains("OMITTED_HISTORY_START"));
        assert!(!text.contains("PRIVATE_NATIVE_REASONING"));
        assert!(
            text.len() < 70 * 1024,
            "64 KiB readable payload plus bounded framing: {}",
            text.len()
        );
        assert_eq!(text.matches("new-question").count(), 1);
        assert_eq!(
            oar_turn(&f, &oar, &session, "codex", "follow-up").await["message"],
            "follow-up"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_oar_history_handoff_does_not_advance_delivery_after_cancelled_prompt() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("History delivery success boundary").await;
        oar_turn(&f, &listener, &session, "codex", "successful-question").await;
        let delivered = journal(&f).await.record.data.value().unwrap()["lastDeliveredRun"].clone();
        assert!(delivered.is_string());
        let accepted = f
            .mutation(2, "send", input(&session, "codex", "wait"), Uuid::new_v4())
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
        let retry = oar_turn(&f, &listener, &session, "codex", "continue-now").await;
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
async fn native_oar_history_handoff_missing_boundary_fails_before_starting_worker() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("History boundary failure").await;
        oar_turn(&f, &listener, &session, "codex", "first").await;
        let entry = journal(&f).await;
        let mut invalid = entry.record.data.value().unwrap().clone();
        invalid["lastDeliveredRun"] = json!(Uuid::new_v4().to_string());
        let revision = f.store.plugin_data_batch(&namespace(), vec![StorageMutation {
            key: entry.key.clone(), expected_revision: Some(entry.record.revision), data: Data::Present(invalid.clone()),
        }]).await.unwrap()[0].revision;
        let accepted = f.mutation(2, "send", input(&session, "codex", "must-not-cold-start"), Uuid::new_v4()).await.unwrap();
        f.drained().await;
        assert_eq!(work(&f, &session, &accepted).await["execution"]["state"], "failed");
        let prefix = f.prefix(&session, 128, 1024 * 1024).await;
        assert!(prefix.events.iter().any(|row| matches!(&row.event.fact,
            maka_agent_facts::event::Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Failed { message: Some(message), .. }, .. }
            if message.contains("OAR history handoff unavailable: last delivered Run boundary is unavailable"))));
        assert!(listener.accept().now_or_never().is_none());
        let after = journal(&f).await;
        assert_eq!(after.record.revision, revision, "load/failure must not write running or advance the watermark");
        assert_eq!(after.record.data.value(), Some(&invalid));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
