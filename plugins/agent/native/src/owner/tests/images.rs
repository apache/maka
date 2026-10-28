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
use image::{ExtendedColorType, ImageEncoder, ImageFormat, codecs::png};
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ToolSuccess;

#[tokio::test]
async fn canonical_images_use_original_agent_grants_and_bounded_base64() {
    let fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
    let session = fixture.create("Images").await;
    let invocation = Invocation {
        session_id: session.clone(),
        turn_id: "image-turn".into(),
        run_id: "image-run".into(),
        invocation_id: "image-invocation".into(),
    };
    let write = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    fixture
        .session(&session)
        .await
        .append(&write(Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "Read image".into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
        }))
        .await
        .unwrap();
    let call = ModelToolCall {
        id: "image".into(),
        name: "Read".into(),
        input: json!({}).into(),
        provider_options: None,
        provider_executed: false,
    };
    fixture
        .session(&session)
        .await
        .append(&write(Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "image-step".into(),
            model_id: "fixture-model".into(),
            source_scope: maka_agent_facts::event::LogScope::Root,
            source_high_water: 0,
            source_digest: "fixture".into(),
            effective_source_digest: None,
            input_digest: "fixture".into(),
            route_identity: "fixture".into(),
        }))
        .await
        .unwrap();
    fixture
        .session(&session)
        .await
        .append(&write(Fact::ModelObserved {
            step_id: "image-step".into(),
            event: ModelEvent::ToolCall(call.clone()),
        }))
        .await
        .unwrap();
    fixture
        .session(&session)
        .await
        .append(&write(Fact::ModelCompleted {
            step_id: "image-step".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call }],
                finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        }))
        .await
        .unwrap();
    let old = fixture
        .session(&session)
        .await
        .append(&write(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "image-step:image".into(),
            call: ToolCallIdentity::provider("image-step".into(), "image".into()),
            name: "Read".into(),
            input: json!({}),
        }))
        .await
        .unwrap();
    let mut bytes = vec![
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0,
        0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 68, 0,
    ];
    bytes.extend([0x21, 0xfe]);
    for _ in 0..160 {
        bytes.push(255);
        bytes.extend([b'x'; 255]);
    }
    bytes.extend([0, 0x3b]);
    let (result, _) = EventWrite::tool_success(
        "native-image-result".into(),
        std::time::SystemTime::now(),
        invocation.clone(),
        "image-step:image".into(),
        ToolSuccess::image(bytes.clone(), "image/gif".into()).unwrap(),
    )
    .unwrap();
    fixture
        .session(&session)
        .await
        .append(&result)
        .await
        .unwrap();
    fixture
        .session(&session)
        .await
        .append(&write(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }))
        .await
        .unwrap();
    let fence = fixture.through(&session).await;
    let mut position = json!({"kind":"start"});
    let sequence = loop {
        let page = fixture
            .query(
                "history",
                json!({"sessionId":session,"through":fence,"position":position}),
            )
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready");
        if let Some(row) = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["role"] == "tool_result")
        {
            break row["position"].clone();
        }
        assert!(
            !page["after"].is_null(),
            "image row must be discoverable by ordinary bounded history"
        );
        position = json!({"kind":"after","cursor":page["after"]});
    };
    let request = json!({"sessionId":session,"through":fence,"position":sequence,"offset":0});
    let mut assembled = Vec::new();
    loop {
        let mut input = request.clone();
        input["offset"] = json!(assembled.len());
        let page = fixture.query("toolImage", input).await.unwrap();
        assert_eq!(page["kind"], "ready");
        assert_eq!(page["through"], fence);
        assert_eq!(page["position"], sequence);
        assert_eq!(page["offset"], assembled.len());
        assert_eq!(page["totalBytes"], bytes.len());
        assert_eq!(page["mimeType"], "image/gif");
        assert_eq!(page["digest"], content_digest(&bytes));
        assert!(serde_json::to_vec(&page).unwrap().len() <= 64 * 1024);
        let data = page["data"].as_str().unwrap();
        assert!(data.len() <= 43692);
        let chunk = STANDARD.decode(data).unwrap();
        assert!(chunk.len() <= 32 * 1024);
        if assembled.is_empty() {
            assert_eq!(
                chunk.len(),
                32 * 1024,
                "whole-envelope budget must permit useful remote chunks"
            );
        }
        if chunk.is_empty() {
            break;
        }
        assembled.extend(chunk);
    }
    assert_eq!(assembled, bytes);
    for (key, value) in [
        ("sessionId", json!("foreign_session")),
        ("through", json!(fence + 1)),
        ("through", json!(old)),
        ("offset", json!(bytes.len() + 1)),
        ("artifactId", json!("guessed")),
    ] {
        let mut input = request.clone();
        input[key] = value;
        assert!(fixture.query("toolImage", input).await.is_err());
    }
    assert!(
        fixture
            .app
            .client()
            .start(
                fixture.binding(2).await,
                "toolImage".into(),
                request.clone(),
                scope(&fixture.issuer, false),
                Attachments::new().into()
            )
            .await
            .is_err()
    );
    let cancelled = scope(&fixture.issuer, true);
    cancelled.cancellation.cancel();
    if let Ok(read) = fixture
        .app
        .client()
        .start(
            fixture.binding(2).await,
            "toolImage".into(),
            request,
            cancelled,
            Attachments::new().into(),
        )
        .await
    {
        assert!(read.result().await.is_err());
    }
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn user_attachment_images_use_uploaded_identity_and_canonical_user_rows() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        enable_vision(&f).await;
        let session = f.create("User image previews").await;
        let other = f.create("Unrelated image previews").await;
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";
        let bytes = STANDARD.decode(encoded).unwrap();
        let image_name = format!("{}.png", "metadata".repeat(2400));
        // The original upload metadata is independent of the selected file's OS name.
        let selected = f._dir.path().join("image.png");
        std::fs::write(&selected, &bytes).unwrap();
        let resource = maka_ui_support::file::read_selected(
            &selected,
            &maka_ui_support::budget::NativeBudget::default(),
        ).unwrap();
        let image = f.mutation_with(
            2, "uploadAttachment",
            json!({"sessionId":session,"name":image_name,"bytes":bytes.len(),"digest":content_digest(&bytes)}),
            Uuid::new_v4(),
            BTreeMap::from([("file".into(), resource as Arc<dyn maka_capabilities::call::ReadResource>)]),
        ).await.unwrap();
        assert!(image["attachment"]["name"] == json!(format!("{}.png", "metadata".repeat(2400))), "original upload name metadata changed");
        let image_id = image["attachment"]["id"].as_str().unwrap();
        let text = attachments::upload(&f, &session, "notes.txt", b"notes\n", Uuid::new_v4())
            .await
            .unwrap();
        let uploaded = json!({"kind":"uploaded","id":image_id});
        let expected = |source: Value| json!({
            "kind":"ready","source":source,"offset":0,"totalBytes":70,
            "mimeType":"image/png",
            "digest":"sha256:9dd3ba490b98e42f0933bc132655c484bdd8682731f639aaffe8c09bfd476dca",
            "data":encoded
        });
        assert_eq!(
            f.query("attachmentImage", json!({"sessionId":session,"source":uploaded,"offset":0}))
                .await.unwrap(),
            expected(uploaded.clone())
        );
        for source in [
            json!({"kind":"uploaded","id":text["attachment"]["id"]}),
            json!({"kind":"uploaded","id":"missing"}),
        ] {
            assert!(f.query("attachmentImage", json!({"sessionId":session,"source":source,"offset":0}))
                .await.is_err());
        }
        assert!(f.query("attachmentImage", json!({"sessionId":other,"source":uploaded,"offset":0}))
            .await.is_err());
        let mut tool_only = f.session(&session).await.get_artifact(&session, image_id).await.unwrap().record.unwrap();
        tool_only.id = "tool-image-only".into();
        tool_only.source = maka_agent_facts::artifact::ArtifactSource::ToolResult;
        f.session(&session).await.commit_artifact(tool_only, bytes.clone()).await.unwrap();
        assert!(f.query("attachmentImage", json!({"sessionId":session,"source":{"kind":"uploaded","id":"tool-image-only"},"offset":0}))
            .await.is_err());

        let sent = f.mutation(2, "send", json!({"sessionId":session,"message":"Preview original attachments",
            "attachments":[text["attachment"]["id"],image_id],"model":f.selection().await}), Uuid::new_v4())
            .await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket, "Image received").await;
        f.drained().await;
        let through = f.through(&session).await;
        let history = f.query("history", json!({"sessionId":session,"through":through,"position":{"kind":"start"}}))
            .await.unwrap();
        let rows = history["chunks"].as_array().unwrap();
        let user = rows.iter().find(|row| row["role"] == "user").unwrap();
        assert_eq!(user["attachments"][1], json!({"name":format!("{}.png", "metadata".repeat(2400)),"mimeType":"image/png","bytes":70,"kind":"image"}));
        let source = json!({"kind":"history","through":through,"position":user["position"],"attachmentIndex":1});
        let read = json!({"sessionId":session,"source":source,"offset":0});
        assert_eq!(f.query("attachmentImage", read.clone()).await.unwrap(), expected(source.clone()));
        for (key, value) in [
            ("through", json!(user["position"]["sourceSequence"].as_u64().unwrap() - 1)),
            ("through", json!(through + 1)),
            ("attachmentIndex", json!(0)),
            ("attachmentIndex", json!(2)),
            ("position", rows.iter().find(|row| row["role"] == "assistant").unwrap()["position"].clone()),
        ] {
            let mut wrong = read.clone();
            wrong["source"][key] = value;
            assert!(f.query("attachmentImage", wrong).await.is_err());
        }
        let mut wrong = read.clone();
        wrong["sessionId"] = json!(other);
        assert!(f.query("attachmentImage", wrong).await.is_err());
        let mut wrong = read.clone();
        wrong["offset"] = json!(71);
        assert!(f.query("attachmentImage", wrong).await.is_err());
        let mut end = read.clone();
        end["offset"] = json!(70);
        let mut empty = expected(source.clone());
        empty["offset"] = json!(70);
        empty["data"] = json!("");
        assert_eq!(f.query("attachmentImage", end).await.unwrap(), empty);

        let turn = f.session(&session).await.invocation_boundary(&session, sent["invocationId"].as_str().unwrap())
            .await.unwrap().unwrap().0.invocation.turn_id;
        let revision = f.owner.session(&session).await.unwrap().revision;
        let fork = f.mutation(2, "fork", json!({"sessionId":session,"expectedRevision":revision,
            "position":{"kind":"through_turn","turnId":turn},"title":"Retained image preview","labels":[]}), Uuid::new_v4()).await.unwrap();
        assert_eq!(fork["kind"], "forked");
        let child = fork["session"]["id"].as_str().unwrap();
        let mut copied = read.clone();
        copied["sessionId"] = json!(child);
        assert_eq!(f.query("attachmentImage", copied.clone()).await.unwrap(), expected(source.clone()));

        // A typed row cannot change the upload's canonical descriptor.
        let mut content: maka_agent_facts::input::MessageInput = "Mismatched image metadata".into();
        content.attachments = Some(vec![maka_agent_facts::attachment::AttachmentRef {
            kind: maka_agent_facts::attachment::AttachmentKind::Image,
            name: "different.png".into(), mime_type: "image/png".into(), bytes: 70,
            storage_ref: maka_agent_facts::attachment::StorageRef::SessionFile {
                session_id: session.clone(), relative_path: image_id.into(),
            },
        }]);
        let invocation = Invocation { session_id: session.clone(), turn_id: "bad-image-turn".into(),
            run_id: "bad-image-run".into(), invocation_id: "bad-image-invocation".into() };
        let write = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
        let bad = f.session(&session).await.append(&write(Fact::InvocationOpened { configuration: None,
            input: InvocationInput::Message { content, source_messages: Vec::new(), request_fingerprint: None } }))
            .await.unwrap();
        f.session(&session).await.append(&write(Fact::InvocationEnded { outcome: InvocationOutcome::Completed })).await.unwrap();
        let bad_fence = f.through(&session).await;
        let bad_history = f.query("history", json!({"sessionId":session,"through":bad_fence,"position":{"kind":"start"}}))
            .await.unwrap();
        let bad_row = bad_history["chunks"].as_array().unwrap().iter()
            .find(|row| row["role"] == "user" && row["position"]["sourceSequence"] == bad).unwrap();
        assert_eq!(bad_row["attachments"][0]["name"], "different.png");
        assert!(f.query("attachmentImage", json!({"sessionId":session,"source":{"kind":"history",
            "through":bad_fence,"position":bad_row["position"],"attachmentIndex":0},"offset":0}))
            .await.is_err());

        // Existing uploads may be deleted; a retained branch owns its own copy.
        assert!(matches!(f.session(&session).await.delete_user_artifact(&session, image_id).await.unwrap(),
            maka_event_log::artifacts::ArtifactDeletion::Deleted));
        assert!(f.query("attachmentImage", read).await.is_err());
        assert!(f.query("attachmentImage", json!({"sessionId":session,"source":uploaded,"offset":0}))
            .await.is_err());
        assert_eq!(f.query("attachmentImage", copied).await.unwrap(), expected(source));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

pub(super) fn gif(minimum: usize) -> Vec<u8> {
    let mut bytes = vec![
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0,
        0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0,
    ];
    bytes.extend([0x21, 0xfe]);
    while bytes.len() < minimum {
        bytes.push(255);
        bytes.extend([b'x'; 255]);
    }
    bytes.extend([0, 0x3b]);
    bytes
}
pub(super) fn model_images(sent: &Value) -> Vec<Vec<u8>> {
    sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "image_url")
        .map(|part| {
            let url = part["image_url"]["url"].as_str().unwrap();
            STANDARD
                .decode(
                    url.strip_prefix("data:image/")
                        .and_then(|image| image.split_once(";base64,").map(|(_, data)| data))
                        .expect("actual image model input"),
                )
                .unwrap()
        })
        .collect()
}
pub(super) async fn enable_vision(f: &Fixture) {
    selection::edit(f, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                vision: Some(true),
                ..Default::default()
            },
        )]));
    })
    .await;
}
pub(super) async fn canonical_image(
    f: &Fixture,
    session: &str,
    bytes: &[u8],
    mime_type: &str,
) -> Value {
    let fence = f
        .query("observe", json!({"sessionId":session}))
        .await
        .unwrap()["through"]
        .as_u64()
        .unwrap();
    let mut position = json!({"kind":"start"});
    let sequence = loop {
        let page = f
            .query(
                "history",
                json!({"sessionId":session,"through":fence,"position":position}),
            )
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready");
        if let Some(row) = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["role"] == "tool_result")
        {
            break row["position"].clone();
        }
        assert!(
            !page["after"].is_null(),
            "canonical tool image row must exist"
        );
        position = json!({"kind":"after","cursor":page["after"]});
    };
    let request = json!({"sessionId":session,"through":fence,"position":sequence,"offset":0});
    let expected_digest = content_digest(bytes);
    let mut assembled = Vec::new();
    while assembled.len() < bytes.len() {
        let mut input = request.clone();
        input["offset"] = json!(assembled.len());
        let page = f.query("toolImage", input).await.unwrap();
        assert_eq!(page["kind"], "ready");
        assert_eq!(page["totalBytes"], bytes.len());
        assert_eq!(page["digest"], expected_digest);
        assert_eq!(page["mimeType"], mime_type);
        let chunk = STANDARD.decode(page["data"].as_str().unwrap()).unwrap();
        assert!(!chunk.is_empty() && chunk.len() <= 32768);
        assembled.extend(chunk);
    }
    assert_eq!(assembled, bytes);
    request
}

#[tokio::test]
async fn selected_workspace_image_stream_reaches_model_and_immutable_canonical_reader() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::files("readImage")),
        )
        .await;
        enable_vision(&f).await;
        let session = f.create("Actual workspace image").await;
        let (width, height) = (2200, 700);
        let pixels: Vec<u8> = (0..width * height)
            .flat_map(|index| [index as u8, (index >> 8) as u8, (index >> 16) as u8, 255])
            .collect();
        let mut bytes = Vec::new();
        png::PngEncoder::new_with_quality(
            &mut bytes,
            png::CompressionType::Uncompressed,
            png::FilterType::NoFilter,
        )
        .write_image(&pixels, width, height, ExtendedColorType::Rgba8)
        .unwrap();
        let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!(decoded.dimensions(), (2200, 700));
        assert_eq!(decoded.as_raw(), &pixels);
        assert!(bytes.len() > 5 * 1024 * 1024);
        std::fs::write(f.workspace.join("large.png"), &bytes).unwrap();
        files::change(&f, &session, "read_only", false, false).await;
        f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        files::tool_response(&mut socket, json!({"path":"large.png"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let images = model_images(&sent);
        assert_eq!(
            images.len(),
            1,
            "model must receive actual image content: {sent}"
        );
        assert_eq!(images[0], bytes);
        response(&mut socket).await;
        f.drained().await;
        // The original file can change; the canonical tool image must not.
        std::fs::write(f.workspace.join("large.png"), b"source replaced").unwrap();
        let mut read = canonical_image(&f, &session, &bytes, "image/png").await;
        read["sessionId"] = json!(f.create("Other image owner").await);
        assert!(f.query("toolImage", read).await.is_err());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

pub(super) enum Source {
    JavaScript {
        frames: Vec<Value>,
        result: Option<Value>,
        query: bool,
    },
    Native(Arc<Producer>),
}
impl Source {
    pub(super) fn is_image(&self) -> bool {
        !matches!(self, Self::JavaScript { query: true, .. })
    }
    pub(super) fn contract(&self) -> maka_plugin_core::contract::Contract {
        use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
        Contract {
            name: "fixture.Images".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "produce".into(),
                    Method {
                        progress: None,
                        mode: if self.is_image() {
                            MethodMode::Subscription
                        } else {
                            MethodMode::Query
                        },
                        input: json!({"type":"object","additionalProperties":false}).into(),
                        output: schemars::schema_for!(contract::ImageFrame).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        }
    }
    pub(super) fn implementation(&self) -> Value {
        match self {
            Self::JavaScript { .. } => {
                json!({"kind":"javascript","module":"images.mjs","realm":"shared"})
            }
            Self::Native(_) => json!({"kind":"native","implementation":"fixture.images"}),
        }
    }
    pub(super) fn javascript(&self) -> Option<String> {
        let Self::JavaScript { frames, result, .. } = self else {
            return None;
        };
        let completion = match result {
            Some(value) => format!("return {value};"),
            None => "throw new Error('producer failed after emitting bytes');".into(),
        };
        Some(format!(
            r#"
            export function activate() {{ return {{Images:{{contract:{},service:['images']}}}}; }}
            export const images = {{ async produce(input, observation, context) {{
                for (const value of {}) await context.invoke({{operation:'emit',value}});
                {completion}
            }} }};
        "#,
            serde_json::to_string(&self.contract()).unwrap(),
            serde_json::to_string(frames).unwrap()
        ))
    }
    pub(super) fn provide(&self, registry: &mut NativeRegistry) {
        let Self::Native(producer) = self else {
            return;
        };
        let producer = producer.clone();
        let contract = self.contract();
        registry
            .insert(
                "fixture.images".into(),
                Arc::new(move |_, _| {
                    let producer = producer.clone();
                    let contract = contract.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Images".into(),
                                maka_plugin_core::runtime::Published {
                                    contract,
                                    value: producer.clone()
                                        as Arc<dyn maka_host_runtime::application::Handler>,
                                },
                            )])),
                            owner: producer,
                        }
                    })
                }),
            )
            .unwrap();
    }
}
#[derive(Clone, Copy)]
enum Behavior {
    HoldAfterBytes,
    CleanupFailed,
}
pub(super) struct Producer {
    behavior: Behavior,
    emitted: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Producer {
    fn new(behavior: Behavior) -> Arc<Self> {
        Arc::new(Self {
            behavior,
            emitted: Arc::new(Semaphore::new(0)),
            cancelled: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
        })
    }
}
impl maka_host_runtime::application::Handler for Producer {
    fn call(
        &self,
        _: String,
        _: Value,
        context: maka_host_runtime::application::Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let behavior = self.behavior;
        let emitted = self.emitted.clone();
        let cancelled = self.cancelled.clone();
        let release = self.release.clone();
        Box::pin(async move {
            context.emit(frame(&gif(0))).await?;
            emitted.add_permits(1);
            match behavior {
                Behavior::HoldAfterBytes => {
                    context.scope().cancellation.cancelled().await;
                    cancelled.add_permits(1);
                    release.acquire().await.unwrap().forget();
                }
                Behavior::CleanupFailed => {
                    let mut ticket = context.scope().resources.reserve().unwrap();
                    ticket.start();
                    ticket.complete(Err("image producer cleanup failed".into()));
                }
            }
            Ok(json!({"kind":"complete"}))
        })
    }
}
impl maka_host_runtime::application::NativeOwner for Producer {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn frame(bytes: &[u8]) -> Value {
    json!({"kind":"chunk","mimeType":"image/gif","totalBytes":bytes.len(),"offset":0,"data":STANDARD.encode(bytes)})
}
async fn start_image(listener: &TcpListener, f: &Fixture, session: &str, input: Value) -> Value {
    let started = f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    files::tool_response(&mut socket, input).await;
    started
}
async fn finish_image(listener: &TcpListener, f: &Fixture) -> Value {
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    response(&mut socket).await;
    f.drained().await;
    sent
}
async fn image_fixture(listener: &TcpListener, setup: service_tools::Setup) -> Fixture {
    let f = Fixture::with_services(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(setup),
    )
    .await;
    enable_vision(&f).await;
    f
}

#[tokio::test]
async fn javascript_image_stream_requires_complete_valid_bytes_and_independent_success() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let bytes = gif(0);
        let good = frame(&bytes);
        let complete = json!({"kind":"complete"});
        let mut offset = good.clone();
        offset["offset"] = json!(1);
        let mut mime = good.clone();
        mime["mimeType"] = json!("image/png");
        let mut incomplete_large = good.clone();
        incomplete_large["totalBytes"] = json!(5 * 1024 * 1024 + 1);
        let mut invalid_base64 = good.clone();
        invalid_base64["data"] = json!("bad!");
        let mut truncated = good.clone();
        truncated["totalBytes"] = json!(bytes.len() + 1);
        let mut invalid_header = good.clone();
        invalid_header["data"] = json!(STANDARD.encode(vec![0; bytes.len()]));
        let large = gif(32769);
        let first = json!({"kind":"chunk","mimeType":"image/gif","totalBytes":large.len(),"offset":0,"data":STANDARD.encode(&large[..32768])});
        let changed = json!({"kind":"chunk","mimeType":"image/png","totalBytes":large.len(),"offset":32768,"data":STANDARD.encode(&large[32768..])});
        let mut large_dimensions = bytes.clone();
        large_dimensions[6..8].copy_from_slice(&2001_u16.to_le_bytes());
        for (frames, result, query, succeeds) in [
            (vec![good.clone()], Some(complete.clone()), false, true),
            (vec![good.clone()], None, false, false),
            (vec![good.clone()], Some(good.clone()), false, false),
            (
                vec![good.clone(), complete.clone()],
                Some(complete.clone()),
                false,
                false,
            ),
            (
                vec![good.clone(), good.clone()],
                Some(complete.clone()),
                false,
                false,
            ),
            (vec![], Some(complete.clone()), false, false),
            (vec![offset], Some(complete.clone()), false, false),
            (vec![mime], Some(complete.clone()), false, false),
            (vec![incomplete_large], Some(complete.clone()), false, false),
            (vec![invalid_base64], Some(complete.clone()), false, false),
            (vec![truncated], Some(complete.clone()), false, false),
            (vec![invalid_header], Some(complete.clone()), false, false),
            (vec![first.clone()], Some(complete.clone()), false, false),
            (vec![first, changed], Some(complete.clone()), false, false),
            (vec![frame(&large_dimensions)], Some(complete.clone()), false, true),
            (vec![], Some(good.clone()), true, true),
        ] {
            let expected_bytes: Vec<u8> = if succeeds && !query {
                frames.iter().flat_map(|frame| {
                    STANDARD.decode(frame["data"].as_str().unwrap()).unwrap()
                }).collect()
            } else {
                Vec::new()
            };
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let f = image_fixture(
                &listener,
                service_tools::Setup::images(Source::JavaScript {
                    frames,
                    result,
                    query,
                }),
            )
            .await;
            let session = f.create("Dynamic image producer").await;
            start_image(&listener, &f, &session, json!({})).await;
            let sent = finish_image(&listener, &f).await;
            let images = model_images(&sent);
            assert_eq!(images.len(), usize::from(succeeds && !query), "{sent}");
            let facts = service_tools::facts(&f, &session).await;
            let outcome = facts
                .iter()
                .find_map(|fact| {
                    if let Fact::ToolSettled { outcome, .. } = fact {
                        Some(outcome)
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(
                matches!(outcome, maka_agent_facts::event::ToolOutcome::Succeeded { .. }),
                succeeds,
                "{outcome:?}"
            );
            if succeeds && !query {
                assert_eq!(images[0], expected_bytes);
                canonical_image(&f, &session, &expected_bytes, "image/gif").await;
            } else if query {
                let maka_agent_facts::event::ToolOutcome::Succeeded {
                    model_projection, ..
                } = outcome
                else {
                    unreachable!()
                };
                assert_eq!(
                    *model_projection,
                    maka_agent_facts::tool_output::DurableToolProjection::Json {
                        value: good.clone()
                    }
                );
            }
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn stop_after_image_bytes_retains_original_producer_until_cleanup() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let producer = Producer::new(Behavior::HoldAfterBytes);
        let f = image_fixture(
            &listener,
            service_tools::Setup::images(Source::Native(producer.clone())),
        )
        .await;
        let session = f.create("Stop image publication").await;
        let started = start_image(&listener, &f, &session, json!({})).await;
        producer.emitted.acquire().await.unwrap().forget();
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"invocationId":started["invocationId"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        producer.cancelled.acquire().await.unwrap().forget();
        assert_eq!(f.owner.workers.len(), 1);
        let other = f.create("Other session remains available").await;
        let admitted = f.send(&other).await.unwrap();
        f.mutation(
            2,
            "stop",
            json!({"sessionId":other,"invocationId":admitted["invocationId"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        producer.release.add_permits(1);
        f.drained().await;
        let facts = service_tools::facts(&f, &session).await;
        assert!(!facts.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. },
                ..
            }
        )));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn complete_image_with_failed_cleanup_never_settles_or_releases_owner() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let producer = Producer::new(Behavior::CleanupFailed);
        let f = image_fixture(
            &listener,
            service_tools::Setup::images(Source::Native(producer)),
        )
        .await;
        let session = f.create("Unconfirmed image cleanup").await;
        start_image(&listener, &f, &session, json!({})).await;
        f.drained().await;
        let facts = f.facts_after_failed_shutdown(&session).await;
        assert!(
            !facts
                .iter()
                .any(|fact| matches!(fact, Fact::ToolSettled { .. }))
        );
        assert_eq!(f.owner.runs.lock().await.quarantined.len(), 1);
        assert!(f.app.shutdown().await.is_err());
        assert!(!f.app.client().snapshot().closed);
        f.config.shutdown().await.unwrap();
        eprintln!("Retained failed-cleanup Root: {}", f._dir.keep().display());
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn workspace_images_require_native_grant_and_original_filesystem_boundary() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for (path, readable) in [
            ("ungranted.gif", false),
            (".git/private.gif", true),
            (".maka/private.gif", true),
            ("../root/private.gif", false),
            ("../escaped.gif", true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let setup = service_tools::Setup::files("readImage");
            let setup = if path == "ungranted.gif" {
                setup.without_grant()
            } else {
                setup
            };
            let f = image_fixture(&listener, setup).await;
            if path.starts_with(".git/") {
                let initialized = std::process::Command::new("git")
                    .args(["init", "--quiet"])
                    .arg(&f.workspace)
                    .output()
                    .unwrap();
                assert!(
                    initialized.status.success(),
                    "{}",
                    String::from_utf8_lossy(&initialized.stderr)
                );
            }
            let target = f.workspace.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, gif(0)).unwrap();
            let session = f.create("Image permission boundary").await;
            files::change(&f, &session, "read_only", false, false).await;
            start_image(&listener, &f, &session, json!({"path":path})).await;
            let sent = finish_image(&listener, &f).await;
            // Read-only allows external reads and workspace metadata; native grants
            // and Host-private state remain independent access boundaries.
            assert_eq!(
                model_images(&sent).len(),
                usize::from(readable),
                "{path}: {sent}"
            );
            let facts = service_tools::facts(&f, &session).await;
            assert!(
                facts.iter().any(|fact| match fact {
                    Fact::ToolSettled { outcome, .. } =>
                        matches!(
                            outcome,
                            maka_agent_facts::event::ToolOutcome::Succeeded { .. }
                        ) == readable,
                    _ => false,
                }),
                "{sent}"
            );
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}
