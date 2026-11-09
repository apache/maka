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

use crate::support::{http::read_request, image_projection::*, native::NativeFixture};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::{
    attachment::{AttachmentKind, AttachmentRef, StorageRef},
    input::{MessageInput, RunInput},
    language::Language,
    tool_output::{DurableToolProjection, ImageDetail, ProjectionPart},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopened_images_preserve_complete_accepted_artifacts_and_copied_authority() {
    tokio::time::timeout(Duration::from_secs(180), async {
        let directory = tempfile::tempdir().unwrap();
        let image = png(160,160).await;
        assert!(image.len()>64*1024, "real encoded media crosses the transport quantum");
        let tiny = png(1,1).await;
        let large_bytes = png(3840,3840).await;
        assert!(large_bytes.len()>50*1024*1024, "accepted original remains above 50 MiB");
        let original_size=large_bytes.len() as u64;
        let original_digest=maka_agent_facts::artifact::content_digest(&large_bytes);
        let images=Images::new(vec![
            ("small",image.clone(),Some(ImageDetail::High)),
            ("large",large_bytes,None),
        ]);
        let f=NativeFixture::open_with_service(directory.path(),configuration(directory.path()),images.service()).await.unwrap();
        let listener=Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap());
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let model=f.configure_model(&base,"gpt-4.1","fixture").await.unwrap();
        profile(&f,&model,None).await;
        let session=f.create("historical images",directory.path(),Some(backend(&model))).await.unwrap();
        let historical=upload(&f,&session,"historical",image.clone()).await;
        let fits=upload(&f,&session,"fits",image.clone()).await;
        let tiny_upload=upload(&f,&session,"tiny",tiny.clone()).await;
        let invalid=upload(&f,&session,"invalid",vec![0;image.len()]).await;

        // Historical evidence is produced by an actual Native Run, not invented model facts.
        let setup_calls=Arc::new(AtomicUsize::new(0));
        let seed_count=setup_calls.clone();
        let seed_listener=listener.clone();
        let seed_server=tokio::spawn(async move {
            let (mut socket,_)=seed_listener.accept().await.unwrap();
            read_request(&mut socket).await;
            seed_count.fetch_add(1,Ordering::SeqCst);
            image_calls(&mut socket,"",&[("read","small"),("read-large","large")]).await;
            let (mut socket,_)=seed_listener.accept().await.unwrap();
            read_request(&mut socket).await;
            seed_count.fetch_add(1,Ordering::SeqCst);
            respond(&mut socket).await;
        });
        let seed=message(&f,&session,"historical",&[historical.id.clone()]).await;
        seed_server.await.unwrap();
        assert_eq!(setup_calls.load(Ordering::SeqCst),2,"historical setup has exactly two real HTTP requests");
        assert_eq!(images.calls.load(Ordering::SeqCst),2);
        let small_result=returned(&f,seed.run,"read").await;
        let DurableToolProjection::Content {parts}=&small_result.body.projection else {panic!("typed image projection")};
        let ProjectionPart::Artifact {image:small_image}=&parts[0] else {panic!("typed image artifact")};
        assert_eq!(small_image.detail,Some(ImageDetail::High));
        let large_result=returned(&f,seed.run,"read-large").await;
        assert_eq!(large_result.artifacts.len(),1);
        assert_eq!(large_result.artifacts[0].payload.bytes,original_size);
        assert_eq!(large_result.artifacts[0].payload.digest,original_digest);
        let (seed_through,seed_image)=image_row(&f,&session,original_size).await;
        assert_canonical_png(&f,&session,seed_through,seed_image,original_size,&original_digest).await;
        reject_malformed_inputs(&f,&seed,&historical,&invalid,&images).await;

        let observed=f.query("observe",json!({"sessionId":session})).await.unwrap();
        let copied=f.mutation_value("fork",json!({
            "sessionId":session,"expectedRevision":observed["session"]["revision"],
            "position":{"kind":"end"},"title":"branch","labels":[],
        })).await.unwrap();
        let maka_agent_api::contract::ForkResult::Forked {session:branch}=serde_json::from_value(copied).unwrap() else {
            panic!("actual End snapshot must be captured")
        };
        f.shutdown().await.unwrap();
        let f=NativeFixture::open_with_service(directory.path(),configuration(directory.path()),images.service()).await.unwrap();
        let action_calls=Arc::new(AtomicUsize::new(0));
        let count=action_calls.clone();
        let current_listener=listener.clone();
        let observed_state=f.state.clone();
        let observed_session=session.clone();
        let server=tokio::spawn(async move {
            let (mut socket,_)=current_listener.accept().await.unwrap();
            let body=read_request(&mut socket).await;
            count.fetch_add(1,Ordering::SeqCst);
            let current=observed_state.latest_run(observed_session).await.unwrap().unwrap();
            let view=observed_state.frontier(current).await.unwrap();
            assert_eq!(view.attempts.len(),1);
            let attempt=view.attempts.values().next().unwrap();
            assert!(attempt.admission.is_some(),"actual frozen request admission precedes HTTP");
            respond(&mut socket).await;
            body
        });
        let current=message(&f,&session,"current",&[fits.id,tiny_upload.id]).await;
        let body=server.await.unwrap();
        let mut urls=Vec::new();
        collect_images(&body["messages"],&mut urls);
        assert_eq!(urls.len(),5,"prior user, typed and generated Read images, and both current images reach the provider");
        for index in [0,1,3] {assert_eq!(provider_png(urls[index]),image);}
        assert_eq!(provider_png(urls[4]),tiny);
        let view_digest=assert_whole_image(provider_png(urls[2])).await;
        assert!(body["messages"].as_array().unwrap().iter().any(|message| {
            message["content"].as_array().is_some_and(|parts|parts.iter().any(|part|part["image_url"]["detail"]=="high"))
        }),"tool image detail reaches the provider after reopening");
        assert!(message_text(&body["messages"]).all(|text|!text.contains("per-request image budget")));
        drop(body);
        let canonical=serde_json::to_string(&(
            facts(&f,seed.run).await,facts(&f,current.run).await,&small_result,&large_result,
        )).unwrap();
        assert!(!canonical.contains("data:image"),"projection must not persist image bytes");
        assert!(canonical.len()<32*1024);
        let original_input:RunInput=serde_json::from_slice(&f.state.content(seed.run,seed.spec.input.clone()).await.unwrap()).unwrap();
        let RunInput::Message {content,source_messages,..}=original_input else {panic!("actual original message")};
        assert_eq!(source_messages.len(),1);
        let original=&source_messages[0].unprepared_content;
        assert_eq!(original.attachments.as_ref().unwrap()[0].storage_ref,StorageRef::SessionFile {
            session_id:session.clone(),relative_path:historical.id.clone(),
        },"rendering snapshot positions cannot rewrite canonical input");
        assert!(!serde_json::to_string(&content).unwrap().contains("history-"));
        assert!(!serde_json::to_string(original).unwrap().contains("history-"));

        // Actual Session removal exercises the frozen destination pin closure, not old alias tables.
        let observed=f.query("observe",json!({"sessionId":session})).await.unwrap();
        let removed=f.mutation_value("changeSession",json!({
            "sessionId":session,"expectedRevision":observed["session"]["revision"],"action":"remove",
        })).await.unwrap();
        assert_eq!(removed["kind"],"removed");
        f.shutdown().await.unwrap();
        let f=NativeFixture::open_with_service(directory.path(),configuration(directory.path()),images.service()).await.unwrap();
        let copied_count=action_calls.clone();
        let copied_listener=listener.clone();
        let copied_request=tokio::spawn(async move {
            let (mut socket,_)=copied_listener.accept().await.unwrap();
            let body=read_request(&mut socket).await;
            copied_count.fetch_add(1,Ordering::SeqCst);
            respond(&mut socket).await;
            body
        });
        message(&f,&branch.id,"branch current",&[]).await;
        let copied_request=copied_request.await.unwrap();
        let mut inherited_images=Vec::new();
        collect_images(&copied_request["messages"],&mut inherited_images);
        assert_eq!(inherited_images.len(),3,"copy retains the deleted user upload and both protected tool images through the destination snapshot");
        for url in &inherited_images[..2] {assert_eq!(provider_png(url),image);}
        assert_eq!(assert_whole_image(provider_png(inherited_images[2])).await,view_digest);
        let (through,position)=image_row(&f,&branch.id,original_size).await;
        assert_canonical_png(&f,&branch.id,through,position,original_size,&original_digest).await;
        let (through,position)=image_row(&f,&branch.id,image.len() as u64).await;
        assert_canonical_png(&f,&branch.id,through,position,image.len() as u64,&maka_agent_facts::artifact::content_digest(&image)).await;
        assert_eq!(images.calls.load(Ordering::SeqCst),2,"cold destination reads do not redispatch either producer");
        assert_eq!(action_calls.load(Ordering::SeqCst),2,"the original two measured HTTP actions are unchanged");
        assert_eq!(setup_calls.load(Ordering::SeqCst),2);
        f.shutdown().await.unwrap();
    }).await.expect("image projection must make bounded progress");
}

async fn reject_malformed_inputs(
    f: &NativeFixture,
    seed: &maka_agent_state::fold::RunView,
    historical: &maka_agent_api::contract::Attachment,
    invalid: &maka_agent_api::contract::Attachment,
    images: &Images,
) {
    use maka_agent_engine::{
        RunError,
        preparation::{MediaSource, project_input_from},
    };
    let session = &seed.spec.session_id;
    let scope = maka_agent_state::artifacts::SessionScope {
        owner: seed.spec.owner.clone(),
        session: session.clone(),
    };
    let valid = AttachmentRef {
        kind: AttachmentKind::Image,
        name: historical.name.clone(),
        mime_type: historical.mime_type.clone(),
        bytes: historical.bytes,
        storage_ref: StorageRef::SessionFile {
            session_id: session.clone(),
            relative_path: historical.id.clone(),
        },
    };
    let mut bad = valid.clone();
    bad.name = invalid.name.clone();
    bad.storage_ref = StorageRef::SessionFile {
        session_id: session.clone(),
        relative_path: invalid.id.clone(),
    };
    bad.bytes = 1;
    let mut missing = valid.clone();
    missing.name = "missing".into();
    missing.storage_ref = StorageRef::SessionFile {
        session_id: session.clone(),
        relative_path: "missing".into(),
    };
    let mut foreign = valid.clone();
    foreign.storage_ref = StorageRef::SessionFile {
        session_id: "other".into(),
        relative_path: historical.id.clone(),
    };
    let mut workspace = valid;
    workspace.name = "workspace".into();
    workspace.storage_ref = StorageRef::WorkspaceFile {
        relative_path: "historical".into(),
    };
    let before = facts(f, seed.run).await;
    let runs = f.state.runs(session.clone(), None, 256).await.unwrap();
    let calls = images.calls.load(Ordering::SeqCst);
    let artifacts = f.state.artifacts();
    // These cloned hostile descriptors are tested at the real readonly decoder, not injected into SDK admissions.
    for (attachment, cause) in [
        (
            bad,
            "Attachment metadata does not match its canonical Artifact",
        ),
        (missing, "media attachment is unavailable"),
        (foreign, "media belongs to another Session"),
        (workspace, "media lacks immutable Session source"),
    ] {
        let mut input = MessageInput::from("current");
        input.attachments = Some(vec![attachment]);
        let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
        let result = project_input_from(
            MediaSource::Live {
                artifacts: &artifacts,
                scope: scope.clone().into(),
            },
            &input,
            Language::En,
            true,
            false,
            None,
            &resources,
            &CancellationToken::new(),
        )
        .await;
        resources.close();
        let Err(RunError::InvalidInput(actual)) = result else {
            panic!("malformed media must be rejected before model dispatch")
        };
        assert_eq!(actual, cause);
        assert_eq!(
            facts(f, seed.run).await,
            before,
            "readonly rejection cannot append T1 or any other fact"
        );
        assert_eq!(
            f.state.runs(session.clone(), None, 256).await.unwrap(),
            runs
        );
        assert_eq!(
            images.calls.load(Ordering::SeqCst),
            calls,
            "rejection cannot call the image source"
        );
    }
}

fn provider_png(url: &str) -> Vec<u8> {
    STANDARD
        .decode(url.strip_prefix("data:image/png;base64,").unwrap())
        .unwrap()
}

async fn assert_whole_image(bytes: Vec<u8>) -> String {
    tokio::task::spawn_blocking(move || {
        let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(image.dimensions(), (2000, 2000));
        for (x, y, color) in [
            (0, 0, [255, 0, 0, 255]),
            (1999, 0, [0, 255, 0, 255]),
            (0, 1999, [0, 0, 255, 255]),
            (1999, 1999, [255, 255, 0, 255]),
        ] {
            assert_eq!(
                image.get_pixel(x, y).0,
                color,
                "whole source corner at {x},{y}"
            );
        }
        maka_agent_facts::artifact::content_digest(&bytes)
    })
    .await
    .unwrap()
}

fn message_text(messages: &Value) -> impl Iterator<Item = &str> {
    messages.as_array().unwrap().iter().flat_map(|message| {
        let content = &message["content"];
        content.as_str().into_iter().chain(
            content
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str()),
        )
    })
}

fn collect_images<'a>(value: &'a Value, urls: &mut Vec<&'a str>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_images(value, urls);
            }
        }
        Value::Object(fields) => {
            if let Some(url) = fields
                .get("image_url")
                .and_then(|value| value["url"].as_str())
            {
                urls.push(url);
            }
            for value in fields.values() {
                collect_images(value, urls);
            }
        }
        _ => {}
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_overflow_keeps_media_multipart_and_checkpoint_corrections_as_evidence() {
    use crate::support::context;
    use tokio::io::AsyncWriteExt;

    // Reported historical facts test delivery, not the quality of a mock model's summary.
    const CHECKPOINT: &str = "Goal: recover launch checklist. Failed attempt: deploy returned E42. Remote write outcome_unknown. Background task bg-17 is running; read results at tasks/bg-17.";
    const CORRECTION: &str = "User correction: stage only; retain the rollback checklist. Screenshot evidence is attached.";
    let directory = tempfile::tempdir().unwrap();
    let images = Images::new(vec![("summary", png(9, 8).await, Some(ImageDetail::High))]);
    let f = NativeFixture::open_with_service(
        directory.path(),
        configuration(directory.path()),
        images.service(),
    )
    .await
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let model = f
        .configure_model(&base, "gpt-4.1", "fixture")
        .await
        .unwrap();
    profile(&f, &model, None).await;
    let session = f
        .create("summary media", directory.path(), Some(backend(&model)))
        .await
        .unwrap();
    let evidence = upload(&f, &session, "summary-evidence", png(8, 8).await).await;
    let wire = Arc::new(AtomicUsize::new(0));
    let setup = Arc::new(AtomicUsize::new(0));
    let count = wire.clone();
    let seed_count = setup.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        count.fetch_add(1, Ordering::SeqCst);
        context::respond(&mut socket, "initial work", "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let baseline = read_request(&mut socket).await;
        count.fetch_add(1, Ordering::SeqCst);
        assert!(baseline["messages"].to_string().contains(CHECKPOINT));
        context::respond(&mut socket, CHECKPOINT, "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let recent = read_request(&mut socket).await;
        count.fetch_add(1, Ordering::SeqCst);
        assert!(recent["messages"].to_string().contains(CORRECTION));
        context::respond(&mut socket, "recent answer", "stop").await;

        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        seed_count.fetch_add(1, Ordering::SeqCst);
        image_calls(
            &mut socket,
            &"large historical log ".repeat(4000),
            &[("screenshot", "summary")],
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        seed_count.fetch_add(1, Ordering::SeqCst);
        respond(&mut socket).await;

        let (mut socket, _) = listener.accept().await.unwrap();
        let full = read_request(&mut socket).await;
        count.fetch_add(1, Ordering::SeqCst);
        let body=json!({"error":{"message":"context exceeded","type":"invalid_request_error","code":"context_length_exceeded"}}).to_string();
        socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let fitted = read_request(&mut socket).await;
        count.fetch_add(1, Ordering::SeqCst);
        context::respond(&mut socket, "continued checkpoint", "stop").await;
        (recent, full, fitted)
    });
    message(&f, &session, CHECKPOINT, &[]).await;
    compact(&f, &session, &model).await;
    message(&f, &session, CORRECTION, &[]).await;
    let media = message(&f, &session, CORRECTION, &[evidence.id]).await;
    let canonical_result =
        serde_json::to_value(returned(&f, media.run, "screenshot").await).unwrap();
    profile(&f, &model, Some(10_000)).await;
    let summary = compact(&f, &session, &model).await;
    let (recent, full, fitted) = server.await.unwrap();
    assert_eq!(
        setup.load(Ordering::SeqCst),
        2,
        "only the explicit media-history setup adds HTTP requests"
    );
    assert_eq!(
        wire.load(Ordering::SeqCst),
        5,
        "the original Main/Summary/overflow actions retain exactly five HTTP requests"
    );
    let original_prefix = recent["messages"].as_array().unwrap();
    assert_eq!(
        &full["messages"].as_array().unwrap()[..original_prefix.len()],
        original_prefix,
        "the first summary attempt retains the entire captured Main prefix for caching"
    );
    assert_eq!(full["tools"], recent["tools"]);
    assert_eq!(full["messages"][0], fitted["messages"][0]);
    assert_eq!(full["tools"], fitted["tools"]);
    assert!(fitted.to_string().len() < full.to_string().len());
    fn image_parts(value: &Value, parts: &mut Vec<Value>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    image_parts(value, parts);
                }
            }
            Value::Object(fields) => {
                if fields.get("type").and_then(Value::as_str) == Some("image_url") {
                    parts.push(value.clone());
                } else {
                    for value in fields.values() {
                        image_parts(value, parts);
                    }
                }
            }
            _ => {}
        }
    }
    let mut original_parts = Vec::new();
    let mut fitted_parts = Vec::new();
    image_parts(&full["messages"], &mut original_parts);
    image_parts(&fitted["messages"], &mut fitted_parts);
    assert!(
        original_parts
            .iter()
            .any(|part| part["image_url"]["detail"] == "high")
    );
    assert_eq!(
        fitted_parts, original_parts,
        "media detail metadata survives fitting with its payload"
    );
    let mut original_images = Vec::new();
    let mut fitted_images = Vec::new();
    collect_images(&full["messages"], &mut original_images);
    collect_images(&fitted["messages"], &mut fitted_images);
    assert_eq!(original_images.len(), 2);
    assert_eq!(
        fitted_images, original_images,
        "selected small screenshot remains an actual image part with identical payload"
    );
    let encoded_image = original_images[0]
        .strip_prefix("data:image/png;base64,")
        .unwrap();
    let mut text_parts = Vec::new();
    for message in fitted["messages"].as_array().unwrap() {
        if let Some(text) = message["content"].as_str() {
            text_parts.push(text);
        } else if let Some(parts) = message["content"].as_array() {
            text_parts.extend(parts.iter().filter_map(|part| part["text"].as_str()));
        }
    }
    let text = text_parts.join("\n");
    assert!(
        text.contains(CHECKPOINT),
        "previous checkpoint must remain available with failed, unknown and running work"
    );
    assert!(
        text.contains(CORRECTION),
        "later user correction must accompany the previous checkpoint"
    );
    assert!(
        !text.contains(encoded_image),
        "media bytes must never become historical text during fitting"
    );
    for image in original_images {
        assert!(!text.contains(image.strip_prefix("data:image/png;base64,").unwrap()));
    }
    assert_eq!(
        serde_json::to_value(returned(&f, media.run, "screenshot").await).unwrap(),
        canonical_result,
        "summary fitting leaves canonical media evidence untouched"
    );
    let baseline: maka_agent_facts::context::CompactedContext = serde_json::from_slice(
        &f.state
            .content(summary.run, summary.baseline.clone().unwrap())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        baseline.checkpoint.summary.text_value().unwrap(),
        "continued checkpoint"
    );
    assert_eq!(
        images.calls.load(Ordering::SeqCst),
        1,
        "Summary does not replay the image read"
    );
    f.shutdown().await.unwrap();
}
