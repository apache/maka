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
use super::external_support::{input_runtime, native_task, packet, release, setup, with_tools};
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
            let image=&received["request"]["images"][0];
            let path=if runtime=="claude" {
                use base64::Engine as _;assert_eq!(base64::engine::general_purpose::STANDARD.decode(image["data"].as_str().unwrap()).unwrap(),bytes);assert_eq!(image["mediaType"],"image/png");
                let task=native_task(&f,&session).await;let mut paths=Vec::new();for entry in std::fs::read_dir(task.resource.resource_ref.join("inputs")).unwrap() {let path=entry.unwrap().path();if path.is_dir() {for entry in std::fs::read_dir(path).unwrap() {let path=entry.unwrap().path();if path.extension().is_some_and(|e|e=="png") {paths.push(path);}}}}assert_eq!(paths.len(),1);paths.remove(0)
            } else {std::path::PathBuf::from(image["path"].as_str().unwrap())};
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(f.mutation(2, "send", correction, operation).await.unwrap(), accepted, "receipt recovery must not submit input again");
            let task=native_task(&f,&session).await;let steering=task.state.steering.as_ref().unwrap();assert!(steering.admitted);
            let blob=f.owner.durable.content(task.execution.run_id,steering.descriptor.clone()).await.unwrap();let proof:maka_agent_state::external_steering::ExternalSteeringSpec=serde_json::from_slice(&blob).unwrap();
            assert_eq!(serde_json::to_value(proof.execution.run_id).unwrap(),original["runId"]);assert_eq!(proof.key.task,task.state.task);
            let mut attributed=false;for source in proof.sources {let bytes=f.owner.durable.content(task.execution.run_id,source.source).await.unwrap();let message:maka_agent_facts::message::RootSourceMessage=serde_json::from_slice(&bytes).unwrap();attributed|=serde_json::to_value(message.message.message_id).unwrap()==accepted["messageId"];}
            assert!(attributed,"original Root message identity must be retained in the admitted steering descriptor");
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
            let expected = if runtime == "codex" { "committed output" } else { "steering: 改为只报告结论;" };
            let all_text = if runtime == "codex" { vec!["steering: 改为只报告结论;", "committed output"] } else { vec!["committed output", "steering: 改为只报告结论;"] };
            assert_eq!(super::external_support::assistant_texts(&f, &session).await, all_text);
            assert_eq!(final_work["answer"]["text"], expected);
            let delivered = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
            assert_eq!(delivered["execution"]["runId"], original["runId"]);
            assert_eq!(delivered["execution"]["state"], "completed");
            assert!(path.parent().unwrap().exists(), "additional uploads stay in the old private namespace until independently proven GC");assert_eq!(native_task(&f,&session).await.state.cleanup,maka_plugin_core::operation::OperationCleanup::Confirmed,"original Root resources are settled independently");
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
        assert_eq!(result["execution"]["state"], "blocked", "{result}");
        assert_eq!(f.mutation(2, "send", request, operation).await.unwrap(), accepted);
        let delivered = f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
        assert_eq!(delivered["execution"]["runId"], original["runId"]);
        assert_eq!(delivered["execution"]["state"], "blocked");
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
        assert!(native_task(&f, &session).await.state.closed.is_some(), "the already observed native terminal must not be awaited twice or quarantined");
        let delivery = f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
        assert_eq!(delivery["execution"]["runId"], original["runId"]);
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
        let store = f.owner.durable.interactions();
        let mut commits = store.subscribe().unwrap();
        let question = loop {
            let pending = store.pending(&session).await.unwrap().records;
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
            .read(&session, &question.request_id)
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
        let messages = super::external_support::assistant_texts(&f, &session).await;
        assert!(matches!(messages.as_slice(), [a, b] if
            (a == "steering: 不要旧选项，改为报告结论;" && b == "committed output") ||
            (a == "committed output" && b == "steering: 不要旧选项，改为报告结论;")
        ));
        assert_eq!(
            result["answer"]["text"].as_str(),
            messages.last().map(String::as_str),
            "{result}"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_external_agy_interrupt_starts_fresh_context_only_after_original_physical_settlement()
 {
    use super::external_support::native_task;
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("agy default interruption").await;
        let first = f.mutation(2,"send",input_runtime(&session,"antigravity","soft-interrupt"),Uuid::new_v4()).await.unwrap();
        let mut original = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut original,"opened").await;
        let native = native_task(&f,&session).await;
        release(&mut original).await;
        packet(&mut original,"output").await;
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"message":"Only the correction."});
        let next = f.mutation(2,"send",input.clone(),operation).await.unwrap();
        assert_eq!(next["kind"],"queued");
        packet(&mut original,"interrupt_requested").await;
        assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),next);
        assert!(listener.accept().now_or_never().is_none());
        release(&mut original).await;
        packet(&mut original,"terminal").await;
        let current=native_task(&f,&session).await;assert_eq!(current.state.task,native.state.task);assert_ne!(current.state.cleanup,maka_plugin_core::operation::OperationCleanup::Confirmed,"native terminal alone is not private closure");
        assert!(listener.accept().now_or_never().is_none(),"native terminal alone cannot start the successor");
        release(&mut original).await;
        let mut resumed = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut resumed,"opened").await;
        assert!(opened["request"].get("resume").is_none());let successor=native_task(&f,&session).await;assert_ne!(successor.state.task,native.state.task);assert_ne!(successor.resource.resource_ref,native.resource.resource_ref);assert!(opened["request"]["canonicalHistory"]["text"].as_str().unwrap().contains("soft-interrupt"));
        assert!(opened["request"]["message"].as_str().unwrap().contains("Only the correction."));
        assert_eq!(work(&f,&session,&first).await["execution"]["state"],"cancelled");
        release(&mut resumed).await;
        packet(&mut resumed,"output").await;
        release(&mut resumed).await;
        packet(&mut resumed,"terminal").await;
        release(&mut resumed).await;
        f.drained().await;
        let result=f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":next["messageId"]}})).await.unwrap();
        assert_eq!(result["execution"]["state"],"completed","{result}");
        assert_ne!(result["execution"]["runId"],first["runId"]);
        let previous=f.owner.durable.frontier(native.execution.run_id).await.unwrap().external.unwrap();assert_eq!(previous.binding,native.state.binding,"fresh task may not replace original native binding");
        assert!(listener.accept().now_or_never().is_none(),"original receipt cannot replay a correction");
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_external_agy_explicit_queue_does_not_interrupt_the_active_turn() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener)=setup("http://127.0.0.1:9/v1").await;
        let session=f.create("agy explicit queue").await;
        let first=f.mutation(2,"send",input_runtime(&session,"antigravity","complete"),Uuid::new_v4()).await.unwrap();
        let mut control=BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control,"opened").await;release(&mut control).await;packet(&mut control,"output").await;
        let mut input=input_runtime(&session,"antigravity","Queued explicitly.");
        input["delivery"]="queue".into();
        let queued=f.mutation(2,"send",input,Uuid::new_v4()).await.unwrap();
        assert_eq!(queued["kind"],"queued");
        release(&mut control).await;packet(&mut control,"terminal").await;release(&mut control).await;
        let mut control=BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control,"opened").await;
        assert_eq!(work(&f,&session,&first).await["execution"]["state"],"completed");
        release(&mut control).await;packet(&mut control,"output").await;release(&mut control).await;packet(&mut control,"terminal").await;release(&mut control).await;
        f.drained().await;
        let result=f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})).await.unwrap();
        assert_eq!(result["execution"]["state"],"completed");
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_external_agy_unacknowledged_interrupt_cannot_resume_or_clear_its_fence() {
    use super::external_support::native_task;
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("agy unconfirmed native interruption").await;
        let first = f
            .mutation(
                2,
                "send",
                input_runtime(&session, "antigravity", "soft-interrupt-unconfirmed"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        release(&mut control).await;
        packet(&mut control, "output").await;
        f.mutation(
            2,
            "send",
            json!({"sessionId":session,"message":"Must not replay after unknown interruption."}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        packet(&mut control, "interrupt_requested").await;
        release(&mut control).await;
        packet(&mut control, "terminal").await;
        release(&mut control).await;
        f.drained().await;
        let task = native_task(&f, &session).await;
        assert_eq!(
            serde_json::to_value(task.execution.run_id).unwrap(),
            first["runId"]
        );
        assert!(
            task.state.closed.is_none(),
            "unknown interrupt cannot manufacture native terminal"
        );
        assert!(listener.accept().now_or_never().is_none());
        assert_eq!(
            work(&f, &session, &first).await["execution"]["state"],
            "blocked",
            "unknown interruption is not a definite native failure or success"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_agy_rejects_reduced_native_permission_before_user_submission() {
    use super::external_support::configured;
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings
                .external
                .as_mut()
                .unwrap()
                .commands
                .antigravity
                .as_mut()
                .unwrap()
                .env
                .insert("MAKA_NATIVE_FIXTURE_LOW_PERMISSION".into(), "1".into());
        })
        .await;
        let session = f.create("agy applied native permission").await;
        let first = f
            .mutation(
                2,
                "send",
                input_runtime(&session, "antigravity", "must not submit"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        f.drained().await;
        assert_eq!(
            work(&f, &session, &first).await["execution"]["state"],
            "failed"
        );
        assert!(
            listener.accept().now_or_never().is_none(),
            "native task must not start without full-permission acknowledgement"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
