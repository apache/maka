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

use super::native::{FixtureService, NativeFixture};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, ImageFrame, WorkReadiness},
};
use maka_agent_facts::{
    artifact::{ToolReturn, content_digest},
    configuration::{
        ApiProtocol, CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis,
        ImageInput, ModelOverride, Patch, UpdateCatalogConnectionInput,
    },
    durable::{Fact, RecordedFact, RunId},
    tool_output::{ImageDetail, ReturnedToolResult},
};
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeOwner, NativeRetirement,
};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{io::AsyncWriteExt, net::TcpStream};

pub fn configuration(workspace: &Path) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en","workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":[{
            "name":"InspectImage","description":"Read the selected complete fixture image.",
            "method":"produce","target":{"kind":"import","name":"fixture"},
            "result":"image","confirmation":"preapproved","nestable":false
        }]
    }))
    .unwrap()
}
pub fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}
pub async fn profile(f: &NativeFixture, model: &ModelSelection, window: Option<u64>) {
    let row = f
        .config
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == model.connection_id)
        .unwrap();
    let result = f
        .config
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: row.connection_id,
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: None,
                configuration: None,
                enabled: None,
                enabled_model_ids: None,
                model_overrides: Patch::Set(BTreeMap::from([(
                    model.model_id.clone(),
                    ModelOverride {
                        code_mode: Some(false),
                        vision: Some(true),
                        api_protocol: Some(ApiProtocol::OpenaiChatCompletions),
                        context_window: window,
                        image_input: Some(ImageInput {
                            max_width: Some(2000),
                            max_height: Some(2000),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )])),
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
}

pub struct Images {
    source: BTreeMap<&'static str, (Arc<[u8]>, Option<ImageDetail>)>,
    pub calls: AtomicUsize,
}
impl Images {
    pub fn new(images: Vec<(&'static str, Vec<u8>, Option<ImageDetail>)>) -> Arc<Self> {
        Arc::new(Self {
            source: images
                .into_iter()
                .map(|(name, bytes, detail)| (name, (bytes.into(), detail)))
                .collect(),
            calls: AtomicUsize::new(0),
        })
    }
    pub fn service(self: &Arc<Self>) -> FixtureService {
        FixtureService::new(Contract {
            name:"fixture.Images".into(), version:1, transport:Transport::Remote,
            interface:Interface::Service {methods:BTreeMap::from([("produce".into(),Method {
                mode:MethodMode::Subscription,
                input:json!({"type":"object","properties":{"image":{"type":"string"}},"required":["image"],"additionalProperties":false}).into(),
                output:schemars::schema_for!(ImageFrame).into(),
                resources:BTreeMap::new(),progress:None,
            })])},
        }, self.clone())
    }
}
impl Handler for Images {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "produce");
        assert!(
            context.scope().identity.agent().is_some(),
            "the actual Native caller owns this read"
        );
        assert!(context.work_custody().is_some());
        let (bytes, detail) = self
            .source
            .get(input["image"].as_str().unwrap())
            .expect("selected image")
            .clone();
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            for (index, chunk) in bytes.chunks(maka_agent_api::IMAGE_CHUNK_BYTES).enumerate() {
                let frame = ImageFrame::Chunk {
                    mime_type: "image/png".into(),
                    total_bytes: bytes.len(),
                    offset: index * maka_agent_api::IMAGE_CHUNK_BYTES,
                    data: STANDARD.encode(chunk),
                };
                context
                    .emit(serde_json::to_value(frame).unwrap())
                    .await
                    .map_err(HandlerError::from)?;
            }
            Ok(HandlerValue::Json(
                serde_json::to_value(ImageFrame::Complete { detail }).unwrap(),
            ))
        })
    }
}
impl NativeOwner for Images {
    fn prepare_retirement(&self) -> Option<Box<dyn NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

pub async fn settled(
    f: &NativeFixture,
    session: &str,
    run: RunId,
) -> maka_agent_state::fold::RunView {
    let mut catalog = f
        .app
        .client()
        .subscribe(
            f.binding().await.unwrap(),
            "catalog".into(),
            json!({"filter":"all","position":{"kind":"start"}}),
            f.scope(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    loop {
        catalog
            .recv()
            .await
            .expect("Native catalog remains observable");
        let readiness: WorkReadiness = serde_json::from_value(
            f.query(
                "workReadiness",
                json!({
                    "sessionId":session,"target":{"kind":"run","runId":run}
                }),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        match readiness {
            WorkReadiness::Ready => break,
            WorkReadiness::Pending => {}
            WorkReadiness::Unavailable => panic!("original Native work became unavailable"),
        }
    }
    catalog.completion().await.cleanup.unwrap();
    f.state.frontier(run).await.unwrap()
}

pub async fn facts(f: &NativeFixture, run: RunId) -> Vec<RecordedFact> {
    let mut rows = Vec::new();
    let mut after = 0;
    loop {
        let page = f.state.history(run, after, 256).await.unwrap();
        let full = page.len() == 256;
        if let Some(last) = page.last() {
            after = last.revision;
        }
        rows.extend(page);
        if !full {
            return rows;
        }
    }
}
pub async fn returned(f: &NativeFixture, run: RunId, call: &str) -> ToolReturn<ReturnedToolResult> {
    for row in facts(f, run).await {
        if let Fact::LocalToolReturned {
            tool,
            result,
            is_error,
            ..
        } = row.fact
            && tool.call == call
        {
            assert!(!is_error);
            return serde_json::from_slice(&f.state.content(run, result).await.unwrap()).unwrap();
        }
    }
    panic!("original accepted image result {call} is missing")
}
pub async fn image_row(f: &NativeFixture, session: &str, length: u64) -> (u64, Value) {
    let through = f
        .query("observe", json!({"sessionId":session}))
        .await
        .unwrap()["through"]
        .as_u64()
        .unwrap();
    let mut position = json!({"kind":"start"});
    loop {
        let page = f
            .query(
                "history",
                json!({"sessionId":session,"through":through,"position":position}),
            )
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready");
        for row in
            page["chunks"].as_array().unwrap().iter().filter(|row| {
                row["role"] == "tool_result" && row["tool"]["result"]["image"] == true
            })
        {
            let image = f
                .query(
                    "toolImage",
                    json!({
                        "sessionId":session,"through":through,"position":row["position"],"offset":0,
                    }),
                )
                .await
                .unwrap();
            assert_eq!(image["kind"], "ready");
            if image["totalBytes"] == length {
                return (through, row["position"].clone());
            }
        }
        assert!(
            !page["after"].is_null(),
            "original tool image of {length} bytes must exist"
        );
        position = json!({"kind":"after","cursor":page["after"]});
    }
}
pub async fn image_calls(socket: &mut TcpStream, text: &str, calls: &[(&str, &str)]) {
    let tool_calls: Vec<_> = calls
        .iter()
        .enumerate()
        .map(|(index, (id, image))| {
            json!({
                "index":index,"id":id,"type":"function",
                "function":{"name":"InspectImage","arguments":json!({"image":image}).to_string()}
            })
        })
        .collect();
    let first = json!({"id":"seed","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{"content":text,"tool_calls":tool_calls},"finish_reason":null}]});
    let last = json!({"id":"seed","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

pub async fn upload(
    fixture: &NativeFixture,
    session: &str,
    name: &str,
    bytes: Vec<u8>,
) -> maka_agent_api::contract::Attachment {
    use maka_capabilities::call::{Attachments, immutable_bytes};
    use maka_plugin_core::operation::{OperationOutcome, OperationResult, Receipt};
    let input = json!({
        "sessionId":session,"name":name,"bytes":bytes.len(),"digest":content_digest(&bytes),
    });
    let resources = Attachments::from([("file".into(), immutable_bytes(name.into(), bytes))]);
    let client = fixture.app.client();
    let prepared = client
        .prepare_mutation(
            fixture.binding().await.unwrap(),
            "uploadAttachment".into(),
            input.clone(),
            fixture.scope(),
            uuid::Uuid::new_v4(),
            resources.into(),
        )
        .await
        .unwrap();
    let reply = client
        .mutate_owned(prepared, input)
        .await
        .unwrap()
        .result()
        .await;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = reply.receipt
    else {
        panic!("immutable upload must return its original successful receipt")
    };
    let maka_agent_api::contract::AttachmentUploadResult::Uploaded { attachment } =
        serde_json::from_value(value).unwrap()
    else {
        panic!("actual immutable upload was rejected")
    };
    assert_eq!(attachment.session_id, session);
    attachment
}

pub async fn message(
    fixture: &NativeFixture,
    session: &str,
    text: &str,
    attachments: &[String],
) -> maka_agent_state::fold::RunView {
    use maka_agent_api::contract::SendResult;
    use maka_agent_state::queue::MessageResolution;
    let mut changes = fixture.state.subscribe().unwrap();
    let sent = fixture
        .mutation_value(
            "send",
            json!({
                "sessionId":session,"message":text,"attachments":attachments,"delivery":"queue",
            }),
        )
        .await
        .unwrap();
    let sent: SendResult = serde_json::from_value(sent).unwrap();
    let run = match sent {
        SendResult::Started { run_id, .. } => run_id,
        SendResult::Queued { message_id, .. } => loop {
            changes.borrow_and_update();
            match fixture
                .state
                .queue()
                .resolve_message(session.into(), message_id.clone())
                .await
                .unwrap()
            {
                MessageResolution::Delivered { run, .. } => break run,
                MessageResolution::Pending => changes.changed().await.unwrap(),
                other => panic!("original queued message did not deliver: {other:?}"),
            }
        },
        other => panic!(
            "SDK send was not admitted: {}",
            serde_json::to_string(&other).unwrap()
        ),
    };
    let view = settled(fixture, session, run).await;
    assert_eq!(
        view.terminal,
        Some(maka_agent_facts::durable::Terminal::Completed)
    );
    view
}

pub async fn compact(
    fixture: &NativeFixture,
    session: &str,
    model: &maka_agent_api::ModelSelection,
) -> maka_agent_state::fold::RunView {
    let value = fixture
        .mutation_value("compact", json!({"sessionId":session,"model":model}))
        .await
        .unwrap();
    let maka_agent_api::contract::CompactResult::Started { execution } =
        serde_json::from_value(value).unwrap()
    else {
        panic!("real SDK compaction must admit its original Summary Run")
    };
    let view = settled(fixture, session, execution.run_id).await;
    assert_eq!(
        view.terminal,
        Some(maka_agent_facts::durable::Terminal::Completed)
    );
    view
}

pub async fn assert_canonical_png(
    fixture: &NativeFixture,
    session: &str,
    through: u64,
    position: Value,
    length: u64,
    digest: &str,
) {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut offset = 0;
    while offset < length {
        let page = fixture
            .query(
                "toolImage",
                json!({
                    "sessionId":session,"through":through,"position":position,"offset":offset,
                }),
            )
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready");
        assert_eq!(page["offset"], offset);
        assert_eq!(page["totalBytes"], length);
        assert_eq!(page["mimeType"], "image/png");
        assert_eq!(page["digest"], digest);
        let bytes = STANDARD.decode(page["data"].as_str().unwrap()).unwrap();
        assert!(!bytes.is_empty() && bytes.len() <= maka_agent_api::IMAGE_CHUNK_BYTES);
        offset += bytes.len() as u64;
        assert!(offset <= length);
        hash.update(&bytes);
    }
    assert_eq!(offset, length);
    assert_eq!(format!("sha256:{}", hex::encode(hash.finalize())), digest);
}

pub async fn png(width: u32, height: u32) -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        use image::{
            ImageEncoder,
            codecs::png::{CompressionType, FilterType, PngEncoder},
        };
        let mut pixels = vec![0; width as usize * height as usize * 4];
        fastrand::Rng::with_seed(42).fill(&mut pixels);
        if width >= 64 && height >= 64 {
            for (x, y, color) in [
                (0, 0, [255, 0, 0, 255]),
                (width - 32, 0, [0, 255, 0, 255]),
                (0, height - 32, [0, 0, 255, 255]),
                (width - 32, height - 32, [255, 255, 0, 255]),
            ] {
                for row in y..y + 32 {
                    for column in x..x + 32 {
                        let offset = (row as usize * width as usize + column as usize) * 4;
                        pixels[offset..offset + 4].copy_from_slice(&color);
                    }
                }
            }
        }
        let mut encoded = Vec::new();
        PngEncoder::new_with_quality(&mut encoded, CompressionType::Fast, FilterType::NoFilter)
            .write_image(&pixels, width, height, image::ExtendedColorType::Rgba8)
            .unwrap();
        encoded
    })
    .await
    .unwrap()
}

pub async fn respond(socket: &mut TcpStream) {
    let first = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
