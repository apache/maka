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

use crate::support::store::SessionFixture;
use maka_agent_engine::{Engine, RunInput};
use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::event::Invocation;
use maka_code_runtime::CellLimits;
use maka_model::ModelExecutor;
use maka_tools::CodeExecutor;
use maka_tools::ToolCatalog;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpStream};

use super::invocation;

pub fn identity(suffix: &str) -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: format!("turn-{suffix}"),
        run_id: format!("run-{suffix}"),
        invocation_id: format!("invocation-{suffix}"),
    }
}

pub fn engine() -> Engine {
    Engine::new(
        ModelExecutor::new(Duration::from_secs(30)).unwrap(),
        CodeExecutor::new(CellLimits::default()).unwrap(),
    )
    .unwrap()
}

pub fn input(base: &str, attachments: Value) -> RunInput {
    let mut input = invocation::input(
        base,
        "current",
        maka_agent_engine::RunWork::Message {
            source_messages: Vec::new(),
            message: serde_json::from_value(json!({"text":"current", "attachments":attachments}))
                .unwrap(),
            tools: ToolCatalog::new([]).unwrap(),
        },
    );
    input.supports_vision = true;
    input
}

pub fn attachment(id: &str) -> Value {
    // Deliberately unrelated to real payload length: budgeting must use storage bytes.
    json!({"kind":"image", "name":id, "mimeType":"image/png", "bytes":1,
        "ref":{"kind":"session_file", "sessionId":"session", "relativePath":id}})
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

pub async fn artifact(log: &SessionFixture, id: &str, bytes: Vec<u8>) {
    log.commit_artifact(
        Artifact {
            id: id.into(),
            session_id: "session".into(),
            turn_id: "upload".into(),
            created_at: 1,
            name: id.into(),
            kind: ArtifactKind::Image,
            size_bytes: bytes.len() as u64,
            mime_type: Some("image/png".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(&bytes)),
        },
        bytes,
    )
    .await
    .unwrap();
}

pub async fn assert_stored_png(log: &SessionFixture, id: &str, length: u64, digest: &str) {
    use sha2::{Digest, Sha256};
    let mut actual = Sha256::new();
    let mut offset = 0;
    loop {
        let chunk = log
            .read_artifact_chunk(log.id(), id, offset, 512 * 1024)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(chunk.total_bytes, length);
        assert!(!chunk.bytes.is_empty());
        actual.update(&chunk.bytes);
        offset += chunk.bytes.len() as u64;
        if offset == length {
            break;
        }
    }
    assert_eq!(format!("sha256:{}", hex::encode(actual.finalize())), digest);
}

pub async fn respond(socket: &mut TcpStream) {
    let first = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
