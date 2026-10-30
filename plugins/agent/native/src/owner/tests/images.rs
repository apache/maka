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
use maka_agent_facts::event::Fact;

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
    assert!(
        assembled == bytes,
        "canonical original changed: actual digest {}, expected {expected_digest}",
        content_digest(&assembled)
    );
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
        let mut pixels: Vec<u8> = (0..width * height)
            .flat_map(|index| [index as u8, (index >> 8) as u8, (index >> 16) as u8, 255])
            .collect();
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
        let mut bytes = Vec::new();
        png::PngEncoder::new_with_quality(
            &mut bytes,
            png::CompressionType::Uncompressed,
            png::FilterType::NoFilter,
        )
        .write_image(&pixels, width, height, ExtendedColorType::Rgba8)
        .unwrap();
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
            "model must receive one complete image view"
        );
        let view = image::load_from_memory_with_format(&images[0], ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!(view.dimensions(), (2000, 636));
        for (x, y, color) in [
            (0, 0, [255, 0, 0, 255]),
            (1999, 0, [0, 255, 0, 255]),
            (0, 635, [0, 0, 255, 255]),
            (1999, 635, [255, 255, 0, 255]),
        ] {
            assert_eq!(
                view.get_pixel(x, y).0,
                color,
                "whole source corner at {x},{y}"
            );
        }
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

pub(super) struct Source;
impl Source {
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
                        mode: MethodMode::Subscription,
                        input: json!({"type":"object","additionalProperties":false}).into(),
                        output: schemars::schema_for!(contract::ImageFrame).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        }
    }
    pub(super) fn javascript(&self) -> String {
        format!(
            r#"
            export function activate() {{ return {{Images:{{contract:{},service:['images']}}}}; }}
            export const images = {{ async produce(input, observation, context) {{
                await context.invoke({{operation:'emit',value:{}}});
                throw new Error('producer failed after emitting bytes');
            }} }};
        "#,
            serde_json::to_string(&self.contract()).unwrap(),
            frame(&gif(0))
        )
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
async fn image_bytes_without_producer_completion_never_reach_the_model() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = image_fixture(&listener, service_tools::Setup::images(Source)).await;
        let session = f.create("Incomplete image producer").await;
        start_image(&listener, &f, &session, json!({})).await;
        let sent = finish_image(&listener, &f).await;
        assert_eq!(model_images(&sent), Vec::<Vec<u8>>::new());
        let facts = service_tools::facts(&f, &session).await;
        assert!(
            facts.iter().any(|fact| matches!(
                fact,
                Fact::ToolSettled {
                    outcome: maka_agent_facts::event::ToolOutcome::Failed { .. },
                    ..
                }
            )),
            "incomplete stream must have a concrete failed tool result"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
