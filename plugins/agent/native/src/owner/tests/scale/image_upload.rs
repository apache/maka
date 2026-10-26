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
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::FutureExt;
use image::{ExtendedColorType, ImageEncoder, ImageFormat, codecs::png};
use maka_agent_facts::{
    artifact::{ArtifactKind, ArtifactSource, content_digest},
    attachment::StorageRef,
    context::ModelPurpose,
    event::{Fact, InvocationInput, InvocationOutcome},
    model::{ModelFinishReason, ModelPart, TextKind},
};
use maka_plugin_core::operation::OperationCleanup;
use std::{cell::Cell, io::Read, panic::AssertUnwindSafe};

const INPUT: &str = "K45 inspect these exact uploaded images";
const ANSWER: &str = "K45_EXACT_IMAGES_CONFIRMED";

#[path = "image_upload/protocol.rs"]
mod protocol;
use protocol::Options;

#[derive(Clone)]
pub(in crate::owner::tests) struct Picture {
    pub(in crate::owner::tests) name: String,
    pub(in crate::owner::tests) bytes: usize,
    pub(in crate::owner::tests) digest: String,
    rgba_digest: String,
    pub(in crate::owner::tests) descriptor: Value,
    pub(in crate::owner::tests) reference: Value,
    pub(in crate::owner::tests) operation: Uuid,
}

pub(in crate::owner::tests) fn generate(
    path: &std::path::Path,
    side: u32,
    index: usize,
) -> Picture {
    let count = (side as usize)
        .checked_mul(side as usize)
        .and_then(|n| n.checked_mul(4))
        .expect("RGBA dimensions must fit address space");
    let mut pixels = vec![0; count];
    let mut seed = 0x9e3779b97f4a7c15u64.wrapping_add(index as u64);
    for pixel in pixels.as_chunks_mut::<4>().0 {
        for channel in &mut pixel[..3] {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            *channel = seed as u8;
        }
        pixel[3] = 255;
    }
    let mut encoded = Vec::new();
    png::PngEncoder::new_with_quality(
        &mut encoded,
        png::CompressionType::Uncompressed,
        png::FilterType::NoFilter,
    )
    .write_image(&pixels, side, side, ExtendedColorType::Rgba8)
    .unwrap();
    let decoded = image::load_from_memory_with_format(&encoded, ImageFormat::Png)
        .unwrap()
        .into_rgba8();
    assert_eq!(decoded.dimensions(), (side, side));
    assert!(
        decoded.as_raw() == &pixels,
        "generated PNG pixel mismatch at image {index}"
    );
    std::fs::write(path, &encoded).unwrap();
    Picture {
        name: path.file_name().unwrap().to_str().unwrap().into(),
        bytes: encoded.len(),
        digest: content_digest(&encoded),
        rgba_digest: content_digest(&pixels),
        descriptor: Value::Null,
        reference: Value::Null,
        operation: Uuid::new_v4(),
    }
}

async fn upload(f: &Fixture, session: &str, picture: &mut Picture) -> Value {
    let snapshot = maka_ui_runtime::file::read_selected(
        &f._dir.path().join(&picture.name),
        &maka_ui_runtime::budget::NativeBudget::default(),
    )
    .unwrap();
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            f.binding(2).await,
            "uploadAttachment".into(),
            json!({"sessionId":session,"name":picture.name,"bytes":picture.bytes,"digest":picture.digest}),
            scope(&f.issuer, true),
            picture.operation,
            BTreeMap::from([(
                "file".into(),
                snapshot as Arc<dyn maka_capabilities::call::ReadResource>,
            )])
            .into(),
        )
        .await
        .unwrap();
    let reply = client.mutate_owned(prepared).await.unwrap().result().await;
    picture.reference = serde_json::to_value(&reply.reference).unwrap();
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        cleanup: OperationCleanup::Confirmed,
    } = reply.receipt
    else {
        panic!(
            "upload must retain its original Returned/Confirmed receipt: {:?}",
            reply.receipt
        )
    };
    if value["kind"] == "uploaded" {
        picture.descriptor = value["attachment"].clone();
    }
    let observation = client
        .recover(
            client.activation(&id(2)).unwrap(),
            reply.reference,
            scope(&f.issuer, true),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        observation.outcome,
        OperationOutcome::Returned {
            value: value.clone()
        }
    );
    assert_eq!(observation.cleanup, OperationCleanup::Confirmed);
    value
}

pub(in crate::owner::tests) async fn artifact(f: &Fixture, session: &str, picture: &Picture) {
    let id = picture.descriptor["id"].as_str().unwrap();
    let path = f._dir.path().join(&picture.name);
    let picture = picture.clone();
    let session_owned = session.to_owned();
    f.session(session)
        .await
        .with_artifact(
            maka_event_log::artifacts::ArtifactReadScope::Session(session),
            id,
            move |record, reader| {
                assert_eq!(record.session_id, session_owned);
                assert_eq!(record.kind, ArtifactKind::Image);
                assert_eq!(record.source, ArtifactSource::UserUpload);
                assert_eq!(record.name, picture.name);
                assert_eq!(record.size_bytes, picture.bytes as u64);
                assert_eq!(record.mime_type.as_deref(), Some("image/png"));
                assert_eq!(record.summary.as_deref(), Some(picture.digest.as_str()));
                let mut file = std::fs::File::open(path).unwrap();
                let mut offset = 0;
                let mut actual = [0u8; 65_536];
                let mut expected = [0u8; 65_536];
                while offset < picture.bytes {
                    let length = (picture.bytes - offset).min(actual.len());
                    reader.read_exact(&mut actual[..length]).unwrap();
                    file.read_exact(&mut expected[..length]).unwrap();
                    assert_eq!(
                        actual[..length],
                        expected[..length],
                        "artifact bytes differ: {} at {offset}",
                        picture.name
                    );
                    offset += length;
                }
                assert_eq!(offset, picture.bytes);
                assert_eq!(
                    file.read(&mut expected[..1]).unwrap(),
                    0,
                    "original file gained bytes"
                );
            },
        )
        .await
        .unwrap()
        .expect("original artifact exists");
}

async fn canonical(
    f: &Fixture,
    session: &str,
) -> Result<Vec<maka_agent_facts::event::StoredEvent>, maka_event_log::StoreError> {
    let through = f.through(session).await;
    let mut after = 0;
    let mut events = Vec::new();
    loop {
        let page = f
            .session(session)
            .await
            .session_events(session, after, through, 512, usize::MAX)
            .await?;
        events.extend(page.events);
        match page.next_after {
            Some(next) => {
                assert!(next > after);
                after = next;
            }
            None => return Ok(events),
        }
    }
}

async fn verify(f: &Fixture, session: &str, invocation: &str, pictures: &[Picture]) {
    let mut opened = 0;
    let mut requests = 0;
    let mut completed = 0;
    let mut terminal = 0;
    for stored in canonical(f, session).await.unwrap() {
        assert_eq!(stored.event.invocation.invocation_id, invocation);
        match stored.event.fact {
            Fact::InvocationOpened {
                input: InvocationInput::Message { content, .. },
                ..
            } => {
                opened += 1;
                assert_eq!(content.text, INPUT);
                let attachments = content.attachments.unwrap();
                assert_eq!(attachments.len(), pictures.len());
                for (attachment, picture) in attachments.iter().zip(pictures) {
                    assert_eq!(attachment.name, picture.name);
                    assert_eq!(attachment.mime_type, "image/png");
                    assert_eq!(attachment.bytes, picture.bytes as u64);
                    assert_eq!(
                        attachment.storage_ref,
                        StorageRef::SessionFile {
                            session_id: session.into(),
                            relative_path: picture.descriptor["id"].as_str().unwrap().into(),
                        }
                    );
                }
            }
            Fact::ModelRequested { purpose, .. } => {
                assert_eq!(purpose, ModelPurpose::Main, "unexpected maintenance");
                requests += 1;
            }
            Fact::ModelCompleted { output, .. } => {
                let text: String = output
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        ModelPart::Text {
                            text_kind: TextKind::Text,
                            text,
                            ..
                        } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                assert_eq!(text, ANSWER);
                assert_eq!(output.finish_reason, ModelFinishReason::Stop);
                completed += 1;
            }
            Fact::InvocationEnded { outcome } => {
                assert_eq!(outcome, InvocationOutcome::Completed);
                terminal += 1;
            }
            Fact::ContextCheckpointRecorded { .. } => panic!("unexpected maintenance checkpoint"),
            _ => {}
        }
    }
    assert_eq!((opened, requests, completed, terminal), (1, 1, 1, 1));
    let through = f.through(session).await;
    let mut input = json!({"sessionId":session,"through":through,"position":{"kind":"start"}});
    let mut user = String::new();
    let mut answer = String::new();
    let mut descriptors = Vec::new();
    loop {
        let page = f.query("history", input.clone()).await.unwrap();
        assert_eq!(page["through"], through);
        assert_eq!(page["kind"], "ready");
        for chunk in page["chunks"].as_array().unwrap() {
            if chunk["field"] != "body" {
                continue;
            }
            if chunk["role"] == "user" {
                assert_eq!(chunk["offset"], user.len());
                user.push_str(chunk["text"].as_str().unwrap());
                descriptors.extend(chunk["attachments"].as_array().unwrap().iter().cloned());
            } else if chunk["role"] == "assistant" {
                assert_eq!(chunk["offset"], answer.len());
                answer.push_str(chunk["text"].as_str().unwrap());
            }
        }
        if page["after"].is_null() {
            break;
        }
        input["position"] = json!({"kind":"after","cursor":page["after"]});
    }
    assert_eq!(user.lines().next(), Some(INPUT));
    assert_eq!(user.lines().count(), pictures.len() + 1);
    assert_eq!(answer, ANSWER);
    assert_eq!(descriptors.len(), pictures.len());
    for (descriptor, picture) in descriptors.iter().zip(pictures) {
        assert_eq!(descriptor["name"], picture.name);
        assert_eq!(descriptor["mimeType"], "image/png");
        assert_eq!(descriptor["bytes"], picture.bytes);
        assert!(descriptor.get("ref").is_none());
    }
    assert_eq!(
        f.query(
            "execution",
            json!({"sessionId":session,"invocationId":invocation})
        )
        .await
        .unwrap()["execution"]["state"],
        "completed"
    );
    assert_eq!(
        f.query("observe", json!({"sessionId":session}))
            .await
            .unwrap()["session"]["activity"],
        "idle"
    );
}

async fn run(count: usize, side: u32) {
    run_protocol(count, side, Options::DEFAULT).await;
}

async fn run_protocol(count: usize, side: u32, options: Options) {
    assert!(count > 0 && side > 0);
    let whole = Instant::now();
    let whole_cpu = usage().0;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::configured_provider(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |_| {},
        options.provider(),
    )
    .await;
    let stage = Cell::new("setup");
    let mut session = None;
    let mut invocation = None;
    let mut pictures = Vec::new();
    let progress = Arc::new(StdMutex::new(json!({"http_requests":0,"actual_images":0})));
    let mut server = None;
    let mut metrics = json!({});
    let checked = tokio::time::timeout(Duration::from_secs(600), AssertUnwindSafe(async {
        options.configure(&f).await;
        session = Some(f.create("K45 real image upload").await);
        let session = session.as_deref().unwrap();
        let mut generation_ms = 0.0;
        let mut generation_cpu = 0.0;
        let mut upload_ms = 0.0;
        let mut upload_cpu = 0.0;
        let mut verification_ms = 0.0;
        for index in 0..count {
            metrics["current_image_index"] = json!(index);
            stage.set("generate_decode");
            let started = Instant::now();
            let cpu = usage().0;
            let picture = generate(&f._dir.path().join(format!("image-{index}.png")), side, index);
            pictures.push(picture);
            let picture = pictures.last_mut().unwrap();
            generation_ms += started.elapsed().as_secs_f64() * 1000.0;
            generation_cpu += usage().0 - cpu;
            stage.set("upload");
            let started = Instant::now();
            let cpu = usage().0;
            let uploaded = upload(&f, session, picture).await;
            metrics["last_upload_outcome"] = uploaded.clone();
            assert_eq!(uploaded["kind"], "uploaded");
            upload_ms += started.elapsed().as_secs_f64() * 1000.0;
            upload_cpu += usage().0 - cpu;
            assert_eq!(picture.descriptor["sessionId"], session);
            assert_eq!(picture.descriptor["name"], picture.name);
            assert_eq!(picture.descriptor["mimeType"], "image/png");
            assert_eq!(picture.descriptor["bytes"], picture.bytes);
            stage.set("artifact_validation");
            let started = Instant::now();
            artifact(&f, session, picture).await;
            verification_ms += started.elapsed().as_secs_f64() * 1000.0;
        }
        metrics = json!({"generation_decode_wall_ms":generation_ms,"generation_decode_process_cpu_seconds":generation_cpu,"upload_capture_wall_ms":upload_ms,
            "upload_capture_process_cpu_seconds":upload_cpu,"artifact_validation_wall_ms":verification_ms});
        let expected = pictures.clone();
        let directory = f._dir.path().to_owned();
        let server_progress = progress.clone();
        let store = f.session(session).await;
        let server_session = session.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        let turn = Instant::now();
        let cpu = usage().0;
        server = Some(tokio::spawn(async move {
            let result = AssertUnwindSafe(async {
                let mut attempts = Vec::new();
                let mut exact_all = true;
                let mut normalized_bytes = 0;
                for attempt in 0..=usize::from(options.retry) {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let sent = options.request(&mut socket).await;
                    normalized_bytes += serde_json::to_vec(&sent).unwrap().len();
                    let mut report = json!({"http_requests":attempt+1,"arrival_ms":turn.elapsed().as_secs_f64()*1000.0,
                        "normalized_request_json_bytes":normalized_bytes,"actual_images":0,
                        "exact_images":false,"substitution_text":[]});
                    let through = *store.subscribe_commits().unwrap().borrow();
                    let mut after = 0;
                    let mut purpose = None;
                    loop {
                        let page = store.session_events(&server_session, after, through, 512, usize::MAX).await.unwrap();
                        for fact in page.events {
                            if let Fact::ModelRequested { purpose: value, .. } = fact.event.fact { purpose = Some(value); }
                        }
                        match page.next_after { Some(next) => after = next, None => break }
                    }
                    report["purpose"] = json!(purpose);
                    *server_progress.lock().unwrap() = report.clone();
                    assert_eq!(purpose, Some(ModelPurpose::Main), "unexpected maintenance request");
                    let parts = options.parts(&sent);
                    let image_parts: Vec<_> = parts.iter().filter_map(|part| options.image(part)).collect();
                    report["actual_images"] = json!(image_parts.len());
                    let texts: Vec<_> = parts.iter().filter_map(|part| part["text"].as_str()).collect();
                    report["substitution_text"] = json!(texts.iter().filter(|text| text.contains("could not be loaded")).collect::<Vec<_>>());
                    *server_progress.lock().unwrap() = report.clone();
                    assert!(texts.iter().any(|text| text.contains(INPUT)), "original user marker");
                    let mut exact = image_parts.len() == expected.len();
                    for (encoded, picture) in image_parts.iter().zip(&expected) {
                        let bytes = STANDARD.decode(*encoded).unwrap();
                        exact &= bytes.len() == picture.bytes && content_digest(&bytes) == picture.digest;
                        let mut file = std::fs::File::open(directory.join(&picture.name)).unwrap();
                        for chunk in bytes.chunks(65_536) {
                            let mut original = vec![0; chunk.len()];
                            file.read_exact(&mut original).unwrap();
                            exact &= original == chunk;
                        }
                    }
                    exact_all &= exact;
                    attempts.push(json!({"attempt":attempt+1,"actual_images":image_parts.len(),"exact_images":exact,
                        "stream_options_present":sent.get("stream_options").is_some()}));
                    report["attempts"] = json!(&attempts);
                    report["exact_images"] = json!(exact_all);
                    *server_progress.lock().unwrap() = report;
                    if options.retry {
                        assert_eq!(sent.get("stream_options").is_some(), attempt == 0);
                        if attempt == 0 {
                            options.reject_stream_options(&mut socket).await;
                            continue;
                        }
                    }
                    options.response(&mut socket).await;
                }

            }).catch_unwind().await;
            let _ = send.send(result);
        }));
        stage.set("send");
        let sent = f.mutation(2, "send", json!({"sessionId":session,"message":INPUT,
            "attachments":pictures.iter().map(|picture| picture.descriptor["id"].clone()).collect::<Vec<_>>(),
            "model":f.selection().await}), Uuid::new_v4()).await;
        metrics["send_outcome"] = json!(&sent);
        let sent = sent.unwrap();
        assert_eq!(sent["kind"], "started");
        invocation = Some(sent["invocationId"].as_str().unwrap().to_owned());
        metrics["admission_ms"] = json!(turn.elapsed().as_secs_f64()*1000.0);
        stage.set("model_http");
        let mut commits = f.session(session).await.subscribe_commits().unwrap();
        let terminal_failure = async {
            loop {
                commits.borrow_and_update();
                for stored in canonical(&f, session).await.unwrap() {
                    if stored.event.invocation.invocation_id != invocation.as_deref().unwrap() {
                        continue;
                    }
                    if let Fact::InvocationEnded { outcome } = stored.event.fact {
                        assert!(matches!(outcome, InvocationOutcome::Completed),
                            "image invocation ended before HTTP completion: {outcome:?}");
                    }
                }
                commits.changed().await.unwrap();
            }
        };
        tokio::select! {
            biased;
            result = receive => result.unwrap().unwrap_or_else(|panic| std::panic::resume_unwind(panic)),
            _ = terminal_failure => unreachable!("terminal failure observer only returns by panic"),
        }
        stage.set("terminal");
        assert!(f.owner.workers.close());
        f.owner.workers.wait().await;
        assert!(f.owner.workers.reopen());
        metrics["turn_wall_ms"] = json!(turn.elapsed().as_secs_f64()*1000.0);
        metrics["turn_process_cpu_seconds"] = json!(usage().0-cpu);
        stage.set("canonical_history_validation");
        let started = Instant::now();
        let cpu = usage().0;
        verify(&f, session, invocation.as_deref().unwrap(), &pictures).await;
        metrics["canonical_history_validation_process_cpu_seconds"] = json!(usage().0-cpu);
        metrics["canonical_history_validation_wall_ms"] = json!(started.elapsed().as_secs_f64()*1000.0);
        stage.set("exact_image_acceptance");
        let exact_images = progress.lock().unwrap()["exact_images"].as_bool();
        assert_eq!(exact_images, Some(true), "provider did not receive every original image");
    }).catch_unwind()).await;
    let success = matches!(&checked, Ok(Ok(())));
    let mut stop = None;
    if !success {
        if let (Some(session), Some(invocation)) = (&session, &invocation) {
            stop = Some(
                f.mutation(
                    2,
                    "stop",
                    json!({"sessionId":session,"invocationId":invocation}),
                    Uuid::new_v4(),
                )
                .await,
            );
        }
        if let Some(server) = &server {
            server.abort();
        }
    }
    let joined = match server {
        Some(server) => Some(server.await),
        None => None,
    };
    // This fixture alone owns the tracker; await physical original-worker cleanup.
    f.owner.workers.close();
    f.owner.workers.wait().await;
    let shutdown = Instant::now();
    let shutdown_cpu = usage().0;
    let app = f.app.shutdown().await;
    let config = f.config.shutdown().await;
    let shutdown_ms = shutdown.elapsed().as_secs_f64() * 1000.0;
    let shutdown_cpu = usage().0 - shutdown_cpu;
    let controls_empty = f.owner.runs.lock().await.controls.is_empty();
    let facts = match &session {
        Some(session) => canonical(&f, session).await,
        None => Ok(Vec::new()),
    };
    let diagnostic_error = facts.as_ref().err().map(ToString::to_string);
    let facts = facts.unwrap_or_default();
    let opened_invocations: Vec<_> = facts
        .iter()
        .filter(|stored| matches!(stored.event.fact, Fact::InvocationOpened { .. }))
        .map(|stored| stored.event.invocation.invocation_id.as_str())
        .collect();
    let purposes: Vec<_> = facts
        .iter()
        .filter_map(|stored| match stored.event.fact {
            Fact::ModelRequested { purpose, .. } => Some(purpose),
            _ => None,
        })
        .collect();
    let terminals: Vec<_> = facts
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::InvocationEnded { outcome } => Some(outcome),
            _ => None,
        })
        .collect();
    let error = match &checked {
        Ok(Ok(())) => None,
        Ok(Err(panic)) => Some(
            panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).into()))
                .unwrap_or("non-string panic".into()),
        ),
        Err(error) => Some(error.to_string()),
    };
    let observed = progress.lock().unwrap().clone();
    let cleanup_ok = app.is_ok()
        && config.is_ok()
        && controls_empty
        && joined.as_ref().is_some_and(|result| result.is_ok());
    let status = if success && cleanup_ok {
        "exact_images_completed"
    } else if success {
        "cleanup_failed"
    } else if purposes.contains(&ModelPurpose::Summary) {
        "maintenance"
    } else if observed["actual_images"]
        .as_u64()
        .is_some_and(|n| n < count as u64)
        && observed["http_requests"] == 1
        && observed["substitution_text"]
            .as_array()
            .is_some_and(|texts| !texts.is_empty())
    {
        "materialization_substituted"
    } else if stage.get() == "send" {
        "send_rejected"
    } else {
        "failed"
    };
    println!(
        "MAKA_AGENT_IMAGE_SCALE {}",
        json!({"status":status,"stage":stage.get(),"error":error,
        "count_requested":count,"side":side,"protocol":options.name(),"retry_requested":options.retry,"customization_enabled":options.customized(),"rgba_bytes_per_image":u64::from(side).checked_mul(u64::from(side)).and_then(|n| n.checked_mul(4)),
        "session":session,"invocation":invocation,"confirmed_uploads":pictures.iter().filter(|picture| !picture.descriptor.is_null()).count(),
        "images":pictures.iter().map(|picture| json!({"name":picture.name,"encoded_bytes":picture.bytes,
            "digest":picture.digest,"rgba_digest":picture.rgba_digest,"attachment":picture.descriptor,"upload_reference":picture.reference,"upload_operation":picture.operation})).collect::<Vec<_>>(),
        "metrics":metrics,"http":observed,"canonical_events":facts.len(),"opened_invocations":opened_invocations,"actual_purposes":purposes,"actual_terminals":terminals,"diagnostic_error":diagnostic_error,
        "cleanup":{"stop":stop,"app_error":app.as_ref().err(),"config_error":config.as_ref().err().map(ToString::to_string),
            "server_joined":joined.is_some(),"server_join_ok":joined.as_ref().map(Result::is_ok),
            "server_cancelled":joined.as_ref().is_some_and(|result| result.as_ref().is_err_and(|error| error.is_cancelled())),"controls_empty":controls_empty},
        "shutdown_wall_ms":shutdown_ms,"shutdown_process_cpu_seconds":shutdown_cpu,"whole_wall_ms":whole.elapsed().as_secs_f64()*1000.0,
        "whole_process_cpu_seconds":usage().0-whole_cpu,
        "whole_process_peak_rss_bytes":usage().1,"driver_included":true,"product_pixel_decode_tested":false})
    );
    match checked {
        Ok(Ok(())) => {}
        Ok(Err(panic)) => std::panic::resume_unwind(panic),
        Err(error) => panic!("image probe timed out: {error}"),
    }
    app.unwrap();
    config.unwrap();
    assert!(controls_empty);
    assert!(joined.is_some_and(|joined| joined.is_ok()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn uploaded_pngs_reach_vision_http_and_complete_history() {
    run(2, 64).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn uploaded_large_png_reaches_vision_http_and_complete_history() {
    run(1, 2048).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit real upload/vision count and encoded-size probe, one case per process"]
async fn real_image_upload_vision_scale() {
    let count = std::env::var("MAKA_IMAGE_COUNT").map_or(1, |value| value.parse().unwrap());
    let side = std::env::var("MAKA_IMAGE_SIDE").map_or(512, |value| value.parse().unwrap());
    run_protocol(count, side, Options::environment()).await;
}
