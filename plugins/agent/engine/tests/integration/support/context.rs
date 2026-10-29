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

use super::http;
use super::invocation;
pub use http::read_request;
use maka_agent_engine::{Engine, RunInput, RunWork};
use maka_agent_facts::execution::ModelBinding;
use maka_code_runtime::CellLimits;
use maka_model::ModelExecutor;
use maka_tools::CodeExecutor;
use serde_json::json;
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpStream};

pub const SUMMARY: &str = "## Goal\nContinue the durable task.\n## Progress\n### Done\n- Saved the original work.\n## Next Steps\n1. Verify checkpoint replay.\n## Critical Context\n- summary-marker in src/event.rs.";
pub fn engine() -> Engine {
    Engine::new(
        ModelExecutor::new(Duration::from_secs(10)).unwrap(),
        CodeExecutor::new(CellLimits::default()).unwrap(),
    )
    .unwrap()
}
pub fn input(base: &str, id: &str, compact: bool) -> RunInput {
    let mut input = invocation::input(
        base,
        id,
        if compact {
            RunWork::ContextCompact
        } else {
            RunWork::Message {
                allow_prior_unknown: false,
                source_messages: Vec::new(),
                message: format!("question-{id}").into(),
                tools: Default::default(),
            }
        },
    );
    input.configuration.model = Some(ModelBinding {
        connection_id: "connection".into(),
        connection_slug: "fixture".into(),
        model: "test".into(),
    });
    input.request_fingerprint = Some(format!(
        "{}:{id}",
        if compact {
            "context.compact"
        } else {
            "turn.start"
        }
    ));
    input
}

pub async fn respond(socket: &mut TcpStream, text: &str, reason: &str) {
    let first = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":20,"completion_tokens":50,"total_tokens":70}});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
