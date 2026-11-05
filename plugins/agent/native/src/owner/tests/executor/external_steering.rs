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

use super::super::attachments::upload;
use super::external_support::{input_runtime, packet, record, release, setup, with_tools};
use super::*;
use futures_util::FutureExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn native_external_steering_delivers_inside_the_original_invocation_and_keeps_uploads_alive()
{
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for runtime in ["codex", "claude"] {
            let session = f.create(&format!("In-flight {runtime}")).await;
            let original = f.mutation(2, "send", input_runtime(&session, runtime, "complete"), Uuid::new_v4()).await.unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(2, 3).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            let bytes = bytes.into_inner();
            let uploaded = upload(&f, &session, "correction.png", &bytes, Uuid::new_v4()).await.unwrap();
            let correction = json!({
                "sessionId":session, "message":"改为只报告结论",
                "attachments":[uploaded["attachment"]["id"]]
            });
            let operation = Uuid::new_v4();
            let accepted = f.mutation(2, "send", correction.clone(), operation).await.unwrap();
            assert_eq!(accepted["kind"], "queued");
            let received = packet(&mut control, "steered").await;
            assert_eq!(received["pid"], opened["pid"], "additional input belongs to the original live process");
            assert_eq!(received["request"]["message"], "改为只报告结论");
            let path = std::path::PathBuf::from(received["request"]["images"][0]["path"].as_str().unwrap());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(f.mutation(2, "send", correction, operation).await.unwrap(), accepted, "receipt recovery must not submit input again");
            let proof = f.session(&session).await.steering_message(&session, accepted["messageId"].as_str().unwrap()).await.unwrap().unwrap();
            assert_eq!(proof.event.invocation.invocation_id, original["invocationId"]);
            assert!(listener.accept().now_or_never().is_none(), "steering cannot spawn a replacement invocation");
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            assert_eq!(std::fs::read(&path).unwrap(), bytes, "native terminal is not physical cleanup");
            release(&mut control).await;
            f.drained().await;
            let final_work = work(&f, &session, &original).await;
            assert_eq!(final_work["execution"]["state"], "completed", "{runtime}: {final_work}");
            let expected = if runtime == "codex" { "steering: 改为只报告结论;committed output" } else { "committed outputsteering: 改为只报告结论;" };
            assert_eq!(final_work["answer"]["text"], expected);
            let delivered = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
            assert_eq!(delivered["execution"]["invocationId"], original["invocationId"]);
            assert_eq!(delivered["execution"]["state"], "completed");
            assert!(!path.parent().unwrap().exists(), "settled native execution releases additional uploads");
            assert!(listener.accept().now_or_never().is_none());
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_steering_wrong_turn_ack_cannot_complete_or_replay_the_input() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Wrong steering target").await;
        let original = f.mutation(2, "send", input_runtime(&session, "codex", "complete"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        let request = json!({"sessionId":session,"message":"wrong-steer-ack"});
        let operation = Uuid::new_v4();
        let accepted = f.mutation(2, "send", request.clone(), operation).await.unwrap();
        packet(&mut control, "steered").await;
        f.drained().await;
        let result = work(&f, &session, &original).await;
        assert_eq!(result["execution"]["state"], "failed", "{result}");
        assert_eq!(f.mutation(2, "send", request, operation).await.unwrap(), accepted);
        let delivered = f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
        assert_eq!(delivered["execution"]["invocationId"], original["invocationId"]);
        assert_eq!(delivered["execution"]["state"], "failed");
        assert!(listener.accept().now_or_never().is_none(), "uncertain input must never be replayed");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_steering_native_completion_before_rejection_settles_without_unknown_fence()
{
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Completed native steering target").await;
        let original = f.mutation(2, "send", input_runtime(&session, "codex", "complete"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        let accepted = f.mutation(2, "send", json!({"sessionId":session,"message":"finish-before-steer"}), Uuid::new_v4()).await.unwrap();
        packet(&mut control, "steered").await;
        f.drained().await;
        let result = work(&f, &session, &original).await;
        assert_eq!(result["execution"]["state"], "failed", "the rejected input must not be reported as consumed: {result}");
        assert!(record(&f, &session).await["running"].is_null(), "the already observed native terminal must not be awaited twice or quarantined");
        let delivery = f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
        assert_eq!(delivery["execution"]["invocationId"], original["invocationId"]);
        assert_eq!(delivery["execution"]["state"], "failed");
        assert!(listener.accept().now_or_never().is_none(), "definite rejection cannot replay claimed input");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_steering_closes_obsolete_host_question_without_answering_or_replacing_it()
{
    tokio::time::timeout(Duration::from_secs(45), async {
        let (f, listener) = with_tools(
            "http://127.0.0.1:9/v1",
            Some(service_tools::Setup::questions()),
            |_| {},
        )
        .await;
        let session = f.create("Steering supersedes Host question").await;
        let original = f
            .mutation(
                2,
                "send",
                input_runtime(&session, "codex", "question"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        let mut plan = serde_json::to_vec(&json!({"calls":[{
            "callId":1,"name":"AskUserQuestion","input":{"questions":[{
                "question":"Choose obsolete output", "options":[{"label":"Brief"},{"label":"Full"}]
            }]}
        }]}))
        .unwrap();
        plan.push(b'\n');
        control.get_mut().write_all(&plan).await.unwrap();
        packet(&mut control, "responsive").await;
        let store = f.session(&session).await;
        let mut commits = store.subscribe_commits().unwrap();
        let question = loop {
            let pending = store.pending_interactions(&session).await.unwrap();
            if let Some(question) = pending.into_iter().find(|entry| {
                matches!(
                    entry.request,
                    maka_agent_facts::interaction::InteractionRequest::Question { .. }
                )
            }) {
                break question;
            }
            commits.changed().await.unwrap();
        };
        f.mutation(
            2,
            "send",
            json!({"sessionId":session,"message":"不要旧选项，改为报告结论"}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let mut received = (false, false, false);
        while received != (true, true, true) {
            let mut line = String::new();
            assert_ne!(control.read_line(&mut line).await.unwrap(), 0);
            let event: Value = serde_json::from_str(&line).unwrap();
            match event["phase"].as_str().unwrap() {
                "steered" => {
                    assert_eq!(event["request"]["message"], "不要旧选项，改为报告结论");
                    received.0 = true;
                }
                "tool_result" => {
                    assert_eq!(event["reply"]["callId"], 1);
                    received.1 = true;
                }
                "output" => received.2 = true,
                other => panic!("unexpected native phase {other}: {event}"),
            }
        }
        let closed = store
            .interaction(&question.request_id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                closed.outcome,
                Some(maka_agent_facts::interaction::InteractionOutcome::Closure {
                    reason: maka_agent_facts::interaction::ClosureReason::Steered,
                    ..
                })
            ),
            "{closed:?}"
        );
        release(&mut control).await;
        packet(&mut control, "terminal").await;
        release(&mut control).await;
        f.drained().await;
        let result = work(&f, &session, &original).await;
        assert_eq!(result["execution"]["state"], "completed", "{result}");
        assert!(
            matches!(
                result["answer"]["text"].as_str(),
                Some(
                    "steering: 不要旧选项，改为报告结论;committed output"
                        | "committed outputsteering: 不要旧选项，改为报告结论;"
                )
            ),
            "{result}"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
