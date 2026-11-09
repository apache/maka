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
use super::external_support::{input, packet, release, setup};
use super::*;
use futures_util::FutureExt;
use std::path::PathBuf;
use tokio::io::BufReader;

fn png() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
fn image_path(packet: &Value, bytes: &[u8]) -> PathBuf {
    let images = packet["request"]["images"].as_array().unwrap();
    assert_eq!(images.len(), 1);
    assert_eq!(images[0]["mediaType"], "image/png");
    let path = PathBuf::from(images[0]["path"].as_str().unwrap());
    assert!(path.is_absolute());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    path
}

#[tokio::test]
async fn native_external_attachments_deliver_immutable_utf8_and_images_to_private_successors() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External uploads").await;
        let request_permissions = f.owner.session(&session).await.unwrap().configuration.permissions.request_permissions;
        super::super::files::change(&f, &session, "danger_full_access", request_permissions, false).await;
        let text = "Original UTF-8 attachment: 中文\n".repeat(3000);
        let note = upload(&f, &session, "notes.md", text.as_bytes(), Uuid::new_v4()).await.unwrap();
        let bytes = png();
        let image = upload(&f, &session, "image.png", &bytes, Uuid::new_v4()).await.unwrap();
        // The selected paths are not the admitted input. Only the immutable uploads are.
        std::fs::write(f._dir.path().join("notes.md"), "changed after upload").unwrap();
        std::fs::write(f._dir.path().join("image.png"), b"changed after upload").unwrap();
        let store = f.owner.durable.artifacts();
        let scope = maka_agent_state::artifacts::SessionScope {owner:f.owner.run_owner(),session:session.clone()};
        let record = store.get(scope.clone(), note["attachment"]["id"].as_str().unwrap().to_owned()).await.unwrap().unwrap().artifact;
        let mut replacement = record.clone();
        replacement.summary = Some(maka_agent_facts::artifact::content_digest(b"replacement"));
        replacement.size_bytes = 11;
        let logical=record.turn_id.strip_prefix("upload_").unwrap().to_owned();
        assert!(store.upload(maka_agent_state::artifacts::Upload::new(scope.clone(),Uuid::new_v4().to_string(),logical,replacement,b"replacement".to_vec())).await.is_err());
        let mut previous = None;
        for index in 0..2 {
            let mut request = input(&session, "inspect");
            request["attachments"] = if index == 0 {
                json!([note["attachment"]["id"], image["attachment"]["id"]])
            } else {
                json!([image["attachment"]["id"]])
            };
            let accepted = f.mutation(2, "send", request, Uuid::new_v4()).await.unwrap();
            assert_eq!(accepted["kind"], "queued");
            assert_eq!(accepted["sessionId"], session);
            assert!(accepted["messageId"].is_string());
            let run = f.delivered_run(&accepted).await;
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            let path = image_path(&opened, &bytes);
            if index == 0 {
                assert_eq!(super::external_support::current_message(&opened), format!("inspect\n\n--- Attachment \"notes.md\" (text/markdown) ---\n{text}\n--- End attachment ---"));
                assert!(opened["request"].get("resume").is_none());
            } else {
                assert_eq!(super::external_support::current_message(&opened), "inspect", "do not replay historical attachment bytes into the current user input");
                assert!(opened["request"].get("resume").is_none());assert!(opened["request"]["canonicalHistory"]["text"].as_str().unwrap().contains("notes.md"));assert!(!opened["request"]["canonicalHistory"]["text"].as_str().unwrap().contains(&text));
                assert_ne!(previous.as_ref(), Some(&path), "fresh task materializes only its current request's uploads");
            }
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            assert_eq!(std::fs::read(&path).unwrap(), bytes, "a result is not root-process exit");
            release(&mut control).await;
            f.drained().await;
            let mut changes = f.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &accepted).await;
                assert_eq!(observed["execution"]["runId"], json!(run));
                assert_eq!(observed["execution"]["sessionId"], session);
                if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"], "completed");
            assert!(path.parent().unwrap().exists(), "Root settlement is not permission to delete an unproven private tree");assert_eq!(std::fs::read(&path).unwrap(),bytes);
            previous = Some(path);
        }
        assert_eq!(store.get(scope,record.id.clone()).await.unwrap().unwrap().artifact, record);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_attachments_stop_retains_images_until_disposal_and_root_exit() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External stop with image").await;
        let request_permissions = f
            .owner
            .session(&session)
            .await
            .unwrap()
            .configuration
            .permissions
            .request_permissions;
        super::super::files::change(
            &f,
            &session,
            "danger_full_access",
            request_permissions,
            false,
        )
        .await;
        let bytes = png();
        let image = upload(&f, &session, "image.png", &bytes, Uuid::new_v4())
            .await
            .unwrap();
        let mut request = input(&session, "wait");
        request["attachments"] = json!([image["attachment"]["id"]]);
        let accepted = f
            .mutation(2, "send", request, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "queued");
        assert_eq!(accepted["sessionId"], session);
        assert!(accepted["messageId"].is_string());
        let run = f.delivered_run(&accepted).await;
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let path = image_path(&packet(&mut control, "opened").await, &bytes);
        release(&mut control).await;
        packet(&mut control, "output").await;
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"runId":run}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        packet(&mut control, "terminal").await;
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        release(&mut control).await;
        f.drained().await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            assert_eq!(observed["execution"]["runId"], json!(run));
            assert_eq!(observed["execution"]["sessionId"], session);
            if !matches!(
                observed["execution"]["state"]["kind"].as_str(),
                Some("admitted" | "running" | "waiting")
            ) {
                break observed;
            }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"], "cancelled");
        assert!(
            path.parent().unwrap().exists(),
            "private material remains outside settled Root resources"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_attachments_unconfirmed_cleanup_keeps_materials_and_original_receipt() {
    let mut escaped_pid = None;
    let result =
        std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(40), async {
            let (f, listener) = setup("http://127.0.0.1:9/v1").await;
            let session = f.create("External uncertain image custody").await;
            let request_permissions = f
                .owner
                .session(&session)
                .await
                .unwrap()
                .configuration
                .permissions
                .request_permissions;
            super::super::files::change(
                &f,
                &session,
                "danger_full_access",
                request_permissions,
                false,
            )
            .await;
            let bytes = png();
            let image = upload(&f, &session, "image.png", &bytes, Uuid::new_v4())
                .await
                .unwrap();
            let mut request = input(&session, "pipe-holder-crash");
            request["attachments"] = json!([image["attachment"]["id"]]);
            let operation = Uuid::new_v4();
            let accepted = f
                .mutation(2, "send", request.clone(), operation)
                .await
                .unwrap();
            assert_eq!(accepted["kind"], "queued");
            assert_eq!(accepted["sessionId"], session);
            assert!(accepted["messageId"].is_string());
            let run = f.delivered_run(&accepted).await;
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let path = image_path(&packet(&mut control, "opened").await, &bytes);
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            let escaped = packet(&mut control, "escaped").await;
            escaped_pid = Some(escaped["pid"].as_u64().unwrap().to_string());
            f.drained().await;
            let mut changes = f.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &accepted).await;
                assert_eq!(observed["execution"]["runId"], json!(run));
                assert_eq!(observed["execution"]["sessionId"], session);
                if !matches!(
                    observed["execution"]["state"]["kind"].as_str(),
                    Some("admitted" | "running" | "waiting")
                ) {
                    break observed;
                }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"], "blocked");
            let original = super::external_support::native_task(&f, &session).await;
            assert_eq!(original.execution.run_id, run);
            assert_eq!(original.execution.session_id, session);
            assert!(original.state.closed.is_none());
            assert_eq!(
                original.state.cleanup,
                maka_plugin_core::operation::OperationCleanup::Unconfirmed
            );
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(
                f.mutation(2, "send", request, operation).await.unwrap(),
                accepted
            );
            assert!(listener.accept().now_or_never().is_none());
            assert!(
                !f.app.shutdown_if_idle().await.unwrap(),
                "the original live I/O custodian must keep retirement busy"
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                bytes,
                "a busy idle-retirement attempt must not delete uncertain materials"
            );
            let cleanup_error = f.app.shutdown().await.unwrap_err();
            assert!(
                cleanup_error.contains("agent_cleanup_unconfirmed"),
                "{cleanup_error}"
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                bytes,
                "forced retirement must retain uncertain materials"
            );
            f.config.shutdown().await.unwrap();
            (f, path)
        }))
        .catch_unwind()
        .await;
    if let Some(pid) = escaped_pid {
        assert!(
            tokio::process::Command::new("/bin/kill")
                .args(["-KILL", &pid])
                .status()
                .await
                .unwrap()
                .success()
        );
    }
    match result {
        Ok(result) => {
            let (_f, path) = result.unwrap();
            // Only the test knows the escaped fixture is now gone.
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test]
async fn native_external_attachments_reject_unsupported_media_and_non_upload_sources() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External attachment refusals").await;
        let request_permissions = f.owner.session(&session).await.unwrap().configuration.permissions.request_permissions;
        super::super::files::change(&f, &session, "danger_full_access", request_permissions, false).await;
        for (name, bytes, mime) in [
            ("binary.bin", &b"\xff\x00binary"[..], "application/octet-stream"),
            ("document.pdf", &b"%PDF-1.7\n\x00binary"[..], "application/pdf"),
        ] {
            let uploaded = upload(&f, &session, name, bytes, Uuid::new_v4()).await.unwrap();
            assert_eq!(uploaded["attachment"]["mimeType"], mime);
            let mut request = input(&session, "must not drop attachment");
            request["attachments"] = json!([uploaded["attachment"]["id"]]);
            let accepted = f.mutation(2, "send", request, Uuid::new_v4()).await.unwrap();
            assert_eq!(accepted["kind"], "queued");
            assert_eq!(accepted["sessionId"], session);
            assert!(accepted["messageId"].is_string());
            let run = f.delivered_run(&accepted).await;
            f.drained().await;
            let mut changes = f.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &accepted).await;
                assert_eq!(observed["execution"]["runId"], json!(run));
                assert_eq!(observed["execution"]["sessionId"], session);
                if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"], "failed");
            let prefix: Vec<_> = f.recorded_facts(&session).await.into_iter().filter(|row| row.run == run).collect();
            let expected = format!("External agent attachment media unsupported: {mime}");
            assert!(prefix.iter().any(|row| matches!(&row.fact,
                maka_agent_facts::durable::Fact::RunTerminated { terminal:maka_agent_facts::durable::Terminal::Failed, diagnostic:Some(message) }
                if message.contains(&expected))));
        }
        let uploaded = upload(&f, &session, "text.txt", b"owned", Uuid::new_v4()).await.unwrap();
        let store = f.owner.durable.artifacts();
        let scope=maka_agent_state::artifacts::SessionScope {owner:f.owner.run_owner(),session:session.clone()};
        let mut generated = store.get(scope.clone(),uploaded["attachment"]["id"].as_str().unwrap().to_owned()).await.unwrap().unwrap().artifact;
        generated.id = Uuid::new_v4().to_string();
        generated.source = maka_agent_facts::artifact::ArtifactSource::SessionEffect;
        let operation=Uuid::new_v4().to_string();
        let provenance=maka_agent_state::ContentBlob::json(&json!({"kind":"native_test_session_effect","operation":operation})).unwrap();
        let generated = store.register(maka_agent_state::artifacts::SessionArtifactWrite::new(scope,operation,generated,b"owned".to_vec(),provenance)).await.unwrap().artifact;
        let other = f.create("Other owner").await;
        for (target, id) in [(&session, json!(generated.id)), (&other, uploaded["attachment"]["id"].clone())] {
            let mut request = input(target, "cannot attach");
            request["attachments"] = json!([id]);
            assert!(f.mutation(2, "send", request, Uuid::new_v4()).await.is_err());
        }
        assert!(listener.accept().now_or_never().is_none(), "unsupported materials never launch the worker");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_claude_private_pipe_preserves_large_images_on_fresh_tasks() {
    use super::external_support::{configured, input_runtime, native_task};
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings
                .external
                .as_mut()
                .unwrap()
                .commands
                .claude
                .as_mut()
                .unwrap()
                .env
                .insert("MAKA_NATIVE_FIXTURE_TRUST".into(), "1".into());
        })
        .await;
        let session = f.create("Claude native multi-image input").await;
        let request_permissions = f.owner.session(&session).await.unwrap().configuration.permissions.request_permissions;
        super::super::files::change(&f, &session, "danger_full_access", request_permissions, false).await;

        let mut noisy = image::RgbImage::new(1536, 1536);
        let mut state = 0x9179_3375u32;
        for byte in noisy.as_flat_samples_mut().samples {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *byte = state as u8;
        }
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(noisy)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let one = encoded.into_inner();
        assert!(
            one.len() * 4 / 3 > 8 * 1024 * 1024,
            "native base64 JSONL must exceed the old limit"
        );
        let mut second = image::RgbImage::new(3, 2);
        second.fill(123);
        let mut two = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(second)
            .write_to(&mut two, image::ImageFormat::Png)
            .unwrap();
        let two = two.into_inner();
        let first = upload(&f, &session, "first.png", &one, Uuid::new_v4())
            .await
            .unwrap();
        let second = upload(&f, &session, "second.png", &two, Uuid::new_v4())
            .await
            .unwrap();
        let text = "current attachment context 中文\n".repeat(4096);
        let note = upload(&f, &session, "context.txt", text.as_bytes(), Uuid::new_v4())
            .await
            .unwrap();
        let mut original = None;
        for turn in 0..2 {
            let mut input = input_runtime(&session, "claude", "inspect both images");
            input["attachments"] = if turn == 0 {
                json!([
                    first["attachment"]["id"],
                    second["attachment"]["id"],
                    note["attachment"]["id"]
                ])
            } else {
                json!([second["attachment"]["id"], first["attachment"]["id"]])
            };
            let accepted = f.mutation(2, "send", input, Uuid::new_v4()).await.unwrap();
            assert_eq!(accepted["kind"], "queued");
            assert_eq!(accepted["sessionId"], session);
            assert!(accepted["messageId"].is_string());
            let run = f.delivered_run(&accepted).await;
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            assert_eq!(opened["stdio"]["inputIsTty"],false);assert_eq!(opened["stdio"]["outputIsTty"],false);
            let home=std::path::Path::new(opened["home"].as_str().unwrap());let config=std::path::Path::new(opened["configDirectory"].as_str().unwrap());assert!(config.starts_with(home));assert_ne!(home,f.workspace);
            let images = opened["request"]["images"].as_array().unwrap();
            assert_eq!(images.len(), 2);
            let expected = if turn == 0 {
                [&one, &two]
            } else {
                [&two, &one]
            };
            for (image, bytes) in images.iter().zip(expected) {
                assert_eq!(image["mediaType"], "image/png");
                assert_eq!(
                    {use base64::Engine as _;base64::engine::general_purpose::STANDARD.decode(image["data"].as_str().unwrap()).unwrap()},
                    *bytes
                );
            }
            let message = super::external_support::current_message(&opened);
            assert!(message.starts_with("inspect both images"));
            if turn == 0 {
                assert!(message.contains(&text));
            } else {
                assert_eq!(message, "inspect both images");
            }
            let journal = native_task(&f,&session).await;
            assert_eq!(journal.execution.run_id, run);
            assert_eq!(journal.execution.session_id, session);
            assert!(journal.state.admitted, "original Claude Task must be admitted");
            let original_task = journal.state.task;
            let mut changes = f.owner.durable.subscribe().unwrap();
            loop {
                changes.borrow_and_update();
                let head = f.owner.durable.frontier(run).await.unwrap();
                assert_eq!(head.run, run);
                assert_eq!(head.spec.session_id, session);
                assert_eq!(head.spec.owner, f.owner.run_owner());
                let task = head.external.as_ref().expect("original admitted Claude Task");
                assert_eq!(task.task, original_task);
                assert!(task.admitted, "original Claude Task remains admitted");
                if task.binding.is_some() {
                    break;
                }
                assert!(head.terminal.is_none() && head.blockers.is_empty() && task.closed.is_none(), "original Claude Task ended or blocked before its canonical binding ACK");
                changes.changed().await.unwrap();
            }
            let journal = native_task(&f,&session).await;
            assert_eq!(journal.execution.run_id, run);
            assert_eq!(journal.execution.session_id, session);
            assert_eq!(journal.state.task, original_task);
            let binding=journal.binding.as_ref().unwrap();
            assert!(matches!(&binding.task,crate::executor::external::NativeTask::ClaudeStream{session,input} if session==journal.native_address().unwrap() && Some(input.as_str())==opened["request"]["uuid"].as_str()));
            let resource=binding.resource.resource_ref.clone();if let Some(previous)=&original {assert_ne!(&resource,previous);}original=Some(resource.clone());assert!(opened["request"].get("resume").is_none());
            let mut paths=Vec::new();for entry in std::fs::read_dir(resource.join("inputs")).unwrap() {let path=entry.unwrap().path();if path.is_dir() {for entry in std::fs::read_dir(path).unwrap() {let path=entry.unwrap().path();if path.extension().is_some_and(|e|e=="png") {paths.push(path);}}}}
            paths.sort();assert_eq!(paths.len(),2);for (path,expected) in paths.iter().zip(expected) {assert_eq!(std::fs::read(path).unwrap(),*expected);}
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            for path in &paths {assert!(path.exists(),"business result is not private process closure");}
            release(&mut control).await;
            f.drained().await;
            let mut changes = f.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &accepted).await;
                assert_eq!(observed["execution"]["runId"], json!(run));
                assert_eq!(observed["execution"]["sessionId"], session);
                if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"], "completed");
            for path in &paths {assert!(path.exists(),"confirmed Root cleanup does not prove all private writers are gone");}
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_claude_stop_before_ack_keeps_original_input_and_successor_is_fresh() {
    let (mut diagnostics, _capture) = log_capture();
    use super::external_support::{configured, input_runtime, native_task};
    tokio::time::timeout(Duration::from_secs(60), async {
        for stage in ["startup", "image", "text"] {
            let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
                settings
                    .external
                    .as_mut()
                    .unwrap()
                    .commands
                    .claude
                    .as_mut()
                    .unwrap()
                    .env
                    .insert("MAKA_NATIVE_FIXTURE_PAUSE_INPUT".into(), stage.into());
            })
            .await;
            let session = f.create("Claude original pipe input custody").await;
            let request_permissions = f
                .owner
                .session(&session)
                .await
                .unwrap()
                .configuration
                .permissions
                .request_permissions;
            super::super::files::change(
                &f,
                &session,
                "danger_full_access",
                request_permissions,
                false,
            )
            .await;
            let bytes = png();
            let uploaded = upload(&f, &session, "held.png", &bytes, Uuid::new_v4())
                .await
                .unwrap();
            let mut input = input_runtime(
                &session,
                "claude",
                "an image awaiting native acknowledgement",
            );
            input["attachments"] = json!([uploaded["attachment"]["id"]]);
            let accepted = f
                .mutation(2, "send", input.clone(), Uuid::new_v4())
                .await
                .unwrap();
            assert_eq!(accepted["kind"], "queued");
            assert_eq!(accepted["sessionId"], session);
            assert!(accepted["messageId"].is_string());
            let run = f.delivered_run(&accepted).await;
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let paused_packet = packet(&mut control, stage).await;
            let original = native_task(&f, &session).await;
            assert_eq!(original.execution.run_id, run);
            assert_eq!(original.execution.session_id, session);
            assert!(
                original.binding.is_none(),
                "no native UUID binding before the original replay ACK"
            );
            assert!(original.state.admitted);
            let resource = original.resource.resource_ref.clone();
            assert!(resource.join("inputs").is_dir());
            if stage == "startup" {
                let actual_cwd = std::path::Path::new(paused_packet["cwd"].as_str().unwrap());
                assert_eq!(std::fs::canonicalize(actual_cwd).unwrap(),
                    std::fs::canonicalize(resource.join("workspace")).unwrap(),
                    "the startup gate must belong to the accepted original resource");
            }
            f.mutation(
                2,
                "stop",
                json!({"sessionId":session,"runId":run}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            release(&mut control).await;
            f.drained().await;
            let stopped = f.owner.durable.frontier(run).await.unwrap();
            assert!(stopped.stopped);
            let mut changes = f.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &accepted).await;
                assert_eq!(observed["execution"]["runId"], json!(run));
                assert_eq!(observed["execution"]["sessionId"], session);
                if !matches!(
                    observed["execution"]["state"]["kind"].as_str(),
                    Some("admitted" | "running" | "waiting")
                ) {
                    break observed;
                }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"], "cancelled");
            let mut physical = f.owner.physical_changes();
            loop {
                physical.borrow_and_update();
                if !f.owner.runs.state().await.retained_cleanup.contains_key(&session) {
                    break;
                }
                physical.changed().await.unwrap();
            }
            let sent = std::fs::read_to_string(resource.join("owner/stdin.bin")).unwrap();
            let frames: Vec<Value> = sent
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(
                frames.iter().filter(|row| row["type"] == "user").count(),
                1,
                "original input must not be resent after uncertain ACK"
            );
            let next = match f.mutation(2, "send", input, Uuid::new_v4()).await {
                Ok(next) => next,
                Err(error) => {
                    let current = native_task(&f, &session).await;
                    let control0 = tokio::fs::read(resource.join("owner/control-0")).await;
                    let control1 = tokio::fs::read(resource.join("owner/control-1")).await;
                    let started: Value = serde_json::from_slice(&tokio::fs::read(resource.join("owner/started.json")).await.unwrap()).unwrap();
                    let helper = started["helperPid"].as_u64().unwrap();
                    let runtime = paused_packet["pid"].as_u64().unwrap();
                    let process_state = tokio::process::Command::new("/bin/ps")
                        .args(["-o", "pid=,ppid=,pgid=,stat=", "-p", &format!("{helper},{runtime}")])
                        .output().await.map(|output| String::from_utf8_lossy(&output.stdout).into_owned());
                    let proof = maka_process::isolated::cleanup_evidence(&original.resource).await
                        .map(|proof| match proof {
                            None => "missing",
                            Some(maka_process::isolated::CleanupEvidence::NeverLaunched { .. }) => "never_launched",
                            Some(maka_process::isolated::CleanupEvidence::GroupClosed { .. }) => "group_closed",
                        });
                    let runs = f.owner.runs.state().await;
                    let diagnostics = log_text(&mut diagnostics);
                    panic!("successor admission failed at {stage}: {error}; run={run}; cleanup={:?}; physical={proof:?}; helper_started={}; child_exited={}; controls={}; preparing={}; retained_scopes={}; control0={control0:?}; control1={control1:?}; owned_process_state={process_state:?}; logs={diagnostics}",
                        current.state.cleanup, resource.join("owner/started.json").is_file(), resource.join("owner/exited.json").is_file(),
                        runs.controls.contains_key(&session), runs.preparing.contains_key(&session),
                        runs.retained_cleanup.get(&session).map_or(0, Vec::len));
                }
            };
            assert_eq!(next["kind"], "queued");
            assert_eq!(next["sessionId"], session);
            assert!(next["messageId"].is_string());
            let next_run = f.delivered_run(&next).await;
            let mut next_control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut next_control, stage).await;
            release(&mut next_control).await;
            let opened = packet(&mut next_control, "opened").await;
            assert!(opened["request"].get("resume").is_none());
            let next_task = native_task(&f, &session).await;
            assert_eq!(next_task.execution.run_id, next_run);
            assert_eq!(next_task.execution.session_id, session);
            assert_ne!(next_task.state.task, original.state.task);
            assert_ne!(next_task.resource.resource_ref, resource);
            let images = opened["request"]["images"].as_array().unwrap();
            assert_eq!(images.len(), 1);
            use base64::Engine as _;
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(images[0]["data"].as_str().unwrap())
                    .unwrap(),
                bytes
            );
            release(&mut next_control).await;
            packet(&mut next_control, "output").await;
            release(&mut next_control).await;
            packet(&mut next_control, "terminal").await;
            release(&mut next_control).await;
            f.drained().await;
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &next).await;
                assert_eq!(observed["execution"]["runId"], json!(next_run));
                assert_eq!(observed["execution"]["sessionId"], session);
                if !matches!(
                    observed["execution"]["state"]["kind"].as_str(),
                    Some("admitted" | "running" | "waiting")
                ) {
                    break observed;
                }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"], "completed");
            assert_eq!(
                std::fs::read_to_string(resource.join("owner/stdin.bin")).unwrap(),
                sent,
                "new task cannot append to original protected evidence"
            );
            loop {
                physical.borrow_and_update();
                if !f.owner.runs.state().await.retained_cleanup.contains_key(&session) {
                    break;
                }
                physical.changed().await.unwrap();
            }
            if let Err(error) = f.app.shutdown().await {
                let logs = log_text(&mut diagnostics);
                panic!("original and successor shutdown failed at {stage}: {error}; logs={logs}");
            }
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_agy_image_paths_preserve_upload_order_until_physical_settlement() {
    use super::external_support::input_runtime;
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("agy image paths").await;
        let request_permissions = f
            .owner
            .session(&session)
            .await
            .unwrap()
            .configuration
            .permissions
            .request_permissions;
        super::super::files::change(
            &f,
            &session,
            "danger_full_access",
            request_permissions,
            false,
        )
        .await;
        let one = png();
        let mut second = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(1, 2)
            .write_to(&mut second, image::ImageFormat::Png)
            .unwrap();
        let two = second.into_inner();
        let first = upload(&f, &session, "first.png", &one, Uuid::new_v4())
            .await
            .unwrap();
        let second = upload(&f, &session, "second.png", &two, Uuid::new_v4())
            .await
            .unwrap();
        let mut input = input_runtime(&session, "antigravity", "比较图片");
        input["attachments"] = json!([first["attachment"]["id"], second["attachment"]["id"]]);
        let accepted = f.mutation(2, "send", input, Uuid::new_v4()).await.unwrap();
        assert_eq!(accepted["kind"], "queued");
        assert_eq!(accepted["sessionId"], session);
        assert!(accepted["messageId"].is_string());
        let run = f.delivered_run(&accepted).await;
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut control, "opened").await;
        assert_eq!(
            super::external_support::current_message(&opened),
            "比较图片"
        );
        let images = opened["request"]["images"].as_array().unwrap();
        assert_eq!(images.len(), 2);
        let paths: Vec<_> = images
            .iter()
            .map(|image| {
                assert_eq!(image["mediaType"], "image/png");
                PathBuf::from(image["path"].as_str().unwrap())
            })
            .collect();
        assert_eq!(std::fs::read(&paths[0]).unwrap(), one);
        assert_eq!(std::fs::read(&paths[1]).unwrap(), two);
        release(&mut control).await;
        packet(&mut control, "output").await;
        release(&mut control).await;
        packet(&mut control, "terminal").await;
        assert_eq!(std::fs::read(&paths[0]).unwrap(), one);
        assert_eq!(std::fs::read(&paths[1]).unwrap(), two);
        release(&mut control).await;
        f.drained().await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            assert_eq!(observed["execution"]["runId"], json!(run));
            assert_eq!(observed["execution"]["sessionId"], session);
            if !matches!(
                observed["execution"]["state"]["kind"].as_str(),
                Some("admitted" | "running" | "waiting")
            ) {
                break observed;
            }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"], "completed");
        assert!(
            paths.iter().all(|path| path.exists()),
            "Root is settled; private-tree quiescence remains Unknown"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
