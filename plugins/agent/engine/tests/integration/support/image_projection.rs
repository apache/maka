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
use maka_model::{ModelExecutor, ProviderConfig, ProviderKind};
use maka_tools::CodeExecutor;
use maka_tools::ToolCatalog;
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
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
    RunInput {
        model_source: None,
        model_revision: None,
        provider_id: "fixture".into(),
        main_output_limit: None,
        context: None,
        invocation: identity("current"),
        request_fingerprint: None,
        provider: ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            kind: ProviderKind::OpenaiChatCompletions,
            model: "test".into(),
            base_url: base.into(),
            auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
            headers: BTreeMap::new(),
            network: Default::default(),
            body_overlay: None,
        },
        provider_options: json!({}),
        supports_vision: true,
        configuration: invocation::configuration(maka_tools::ToolMode::Direct),
        work: maka_agent_engine::RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: serde_json::from_value(json!({"text":"current", "attachments":attachments}))
                .unwrap(),
            tools: ToolCatalog::new([]).unwrap(),
        },
    }
}

pub fn attachment(id: &str) -> Value {
    // Deliberately unrelated to real payload length: budgeting must use storage bytes.
    json!({"kind":"image", "name":id, "mimeType":"image/png", "bytes":1,
        "ref":{"kind":"session_file", "sessionId":"session", "relativePath":id}})
}

pub async fn artifact(log: &SessionFixture, id: &str, size: usize, valid: bool) {
    let mut bytes = vec![0; size];
    if valid {
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    }
    log.commit_artifact(
        Artifact {
            id: id.into(),
            session_id: "session".into(),
            turn_id: "upload".into(),
            created_at: 1,
            name: id.into(),
            kind: ArtifactKind::Image,
            size_bytes: size as u64,
            mime_type: Some("image/png".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(&bytes)),
        },
        bytes,
    )
    .await
    .unwrap();
}

pub async fn request(socket: &mut TcpStream) -> Value {
    // Two 50 MiB images, three 4 MiB images, and a tiny overflow image
    // are sent together. Account for base64 and allow 1 MiB of JSON metadata.
    let fixture_media_bytes: usize = (2 * 50 + 3 * 4) * 1024 * 1024 + 9;
    let max_body_bytes = fixture_media_bytes.div_ceil(3) * 4 + 1024 * 1024;
    super::http::read_request_bounded(socket, max_body_bytes).await
}

pub async fn respond(socket: &mut TcpStream) {
    let first = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
