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
async fn native_external_attachments_deliver_immutable_utf8_and_image_bytes_on_send_and_resume() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External uploads").await;
        let text = "Original UTF-8 attachment: 中文\n".repeat(3000);
        let note = upload(&f, &session, "notes.md", text.as_bytes(), Uuid::new_v4()).await.unwrap();
        let bytes = png();
        let image = upload(&f, &session, "image.png", &bytes, Uuid::new_v4()).await.unwrap();
        // The selected paths are not the admitted input. Only the immutable uploads are.
        std::fs::write(f._dir.path().join("notes.md"), "changed after upload").unwrap();
        std::fs::write(f._dir.path().join("image.png"), b"changed after upload").unwrap();
        let store = f.session(&session).await;
        let record = store.get_artifact(&session, note["attachment"]["id"].as_str().unwrap()).await.unwrap().record.unwrap();
        let mut replacement = record.clone();
        replacement.summary = Some(maka_agent_facts::artifact::content_digest(b"replacement"));
        replacement.size_bytes = 11;
        assert!(store.commit_artifact(replacement, b"replacement").await.is_err());
        let mut previous = None;
        for index in 0..2 {
            let mut request = input(&session, "inspect");
            request["attachments"] = if index == 0 {
                json!([note["attachment"]["id"], image["attachment"]["id"]])
            } else {
                json!([image["attachment"]["id"]])
            };
            let accepted = f.mutation(2, "send", request, Uuid::new_v4()).await.unwrap();
            assert_eq!(accepted["kind"], "started", "{accepted}");
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            let path = image_path(&opened, &bytes);
            if index == 0 {
                assert_eq!(opened["request"]["message"], format!("inspect\n\n--- Attachment \"notes.md\" (text/markdown) ---\n{text}\n--- End attachment ---"));
                assert!(opened["request"].get("resume").is_none());
            } else {
                assert_eq!(opened["request"]["message"], "inspect", "do not replay historical text attachments");
                assert_eq!(opened["request"]["resume"], "native-fixture-session");
                assert_ne!(previous.as_ref(), Some(&path), "resume rematerializes only the new request's uploads");
            }
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            assert_eq!(std::fs::read(&path).unwrap(), bytes, "a result is not root-process exit");
            release(&mut control).await;
            f.drained().await;
            assert_eq!(work(&f, &session, &accepted).await["execution"]["state"], "completed");
            assert!(!path.parent().unwrap().exists(), "confirmed disposal and exit release the material directory");
            previous = Some(path);
        }
        assert_eq!(store.get_artifact(&session, &record.id).await.unwrap().record.unwrap(), record);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_attachments_stop_retains_images_until_disposal_and_root_exit() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External stop with image").await;
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
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let path = image_path(&packet(&mut control, "opened").await, &bytes);
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
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        release(&mut control).await;
        f.drained().await;
        assert_eq!(
            work(&f, &session, &accepted).await["execution"]["state"],
            "cancelled"
        );
        assert!(!path.parent().unwrap().exists());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_attachments_unconfirmed_cleanup_keeps_materials_and_original_receipt() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External uncertain image custody").await;
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
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let path = image_path(&packet(&mut control, "opened").await, &bytes);
        release(&mut control).await;
        packet(&mut control, "output").await;
        release(&mut control).await;
        let escaped = packet(&mut control, "escaped").await;
        let pid = escaped["pid"].as_u64().unwrap().to_string();
        f.drained().await;
        assert_eq!(
            work(&f, &session, &accepted).await["execution"]["state"],
            "failed"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            f.mutation(2, "send", request, operation).await.unwrap(),
            accepted
        );
        assert!(listener.accept().now_or_never().is_none());
        assert!(
            f.app
                .shutdown_if_idle()
                .await
                .unwrap_err()
                .contains("cleanup_unconfirmed")
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "retiring an owner must not delete uncertain materials"
        );
        f.config.shutdown().await.unwrap();
        assert!(
            tokio::process::Command::new("/bin/kill")
                .args(["-KILL", &pid])
                .status()
                .await
                .unwrap()
                .success()
        );
        // Only the test knows the escaped fixture is now gone.
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_attachments_reject_unsupported_media_and_non_upload_sources() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External attachment refusals").await;
        for (name, bytes, mime) in [
            ("binary.bin", &b"\xff\x00binary"[..], "application/octet-stream"),
            ("document.pdf", &b"%PDF-1.7\n\x00binary"[..], "application/pdf"),
        ] {
            let uploaded = upload(&f, &session, name, bytes, Uuid::new_v4()).await.unwrap();
            assert_eq!(uploaded["attachment"]["mimeType"], mime);
            let mut request = input(&session, "must not drop attachment");
            request["attachments"] = json!([uploaded["attachment"]["id"]]);
            let accepted = f.mutation(2, "send", request, Uuid::new_v4()).await.unwrap();
            f.drained().await;
            assert_eq!(work(&f, &session, &accepted).await["execution"]["state"], "failed");
            let prefix = f.prefix(&session, 128, 1024 * 1024).await;
            let expected = format!("External agent attachment media unsupported: {mime}");
            assert!(prefix.events.iter().any(|row| matches!(&row.event.fact,
                maka_agent_facts::event::Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Failed { message: Some(message), .. }, .. }
                if message.contains(&expected))));
        }
        let uploaded = upload(&f, &session, "text.txt", b"owned", Uuid::new_v4()).await.unwrap();
        let store = f.session(&session).await;
        let mut generated = store.get_artifact(&session, uploaded["attachment"]["id"].as_str().unwrap()).await.unwrap().record.unwrap();
        generated.id = Uuid::new_v4().to_string();
        generated.source = maka_agent_facts::artifact::ArtifactSource::ToolResult;
        let generated = store.commit_artifact(generated, b"owned").await.unwrap();
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
async fn native_external_claude_trust_and_multiple_images_use_native_input_on_send_and_resume() {
    use super::external_support::{configured, input_runtime, record_runtime};
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
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            let cwd = opened["cwd"].as_str().unwrap();
            assert_eq!(
                std::fs::read_to_string(
                    std::path::Path::new(cwd).join(".fixture-claude/fixture-trusted-workspace")
                )
                .unwrap(),
                cwd
            );
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
                    std::fs::read(image["path"].as_str().unwrap()).unwrap(),
                    *bytes
                );
            }
            let message = opened["request"]["message"].as_str().unwrap();
            assert!(message.starts_with("inspect both images"));
            if turn == 0 {
                assert!(message.contains(&text));
            } else {
                assert_eq!(message, "inspect both images");
            }
            let journal = record_runtime(&f, &session, "claude").await;
            let id = journal["nativeSession"].clone();
            if let Some(original) = &original {
                assert_eq!(&id, original);
                assert_eq!(&opened["request"]["resume"], original);
            } else {
                original = Some(id);
            }
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            for image in images {
                assert!(std::path::Path::new(image["path"].as_str().unwrap()).exists());
            }
            release(&mut control).await;
            f.drained().await;
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"],
                "completed"
            );
            for image in images {
                assert!(!std::path::Path::new(image["path"].as_str().unwrap()).exists());
            }
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_claude_cancel_before_enter_retires_images_and_allocates_a_new_native_id() {
    use super::external_support::{configured, input_runtime, record_runtime};
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
            let session = f.create("Claude pre-submission cancellation").await;
            let uploaded = upload(&f, &session, "held.png", &png(), Uuid::new_v4())
                .await
                .unwrap();
            let mut input = input_runtime(&session, "claude", "an image still being composed");
            input["attachments"] = json!([uploaded["attachment"]["id"]]);
            let accepted = f
                .mutation(2, "send", input.clone(), Uuid::new_v4())
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let checkpoint = packet(&mut control, stage).await;
            let original = record_runtime(&f, &session, "claude").await["nativeSession"].clone();
            assert!(original.is_string());
            let image = checkpoint.get("path").and_then(Value::as_str);
            if let Some(path) = image {
                assert!(std::path::Path::new(path).exists());
            }
            f.mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":accepted["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            f.drained().await;
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"],
                "cancelled"
            );
            assert!(record_runtime(&f, &session, "claude").await["nativeSession"].is_null());
            if let Some(path) = image {
                assert!(!std::path::Path::new(path).exists());
            }
            let accepted = f.mutation(2, "send", input, Uuid::new_v4()).await.unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            assert!(opened["request"].get("resume").is_none());
            assert_ne!(
                record_runtime(&f, &session, "claude").await["nativeSession"],
                original
            );
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            release(&mut control).await;
            f.drained().await;
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"],
                "completed"
            );
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}
