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

use super::invocation;

use maka_agent::RunInput;
use maka_event_log::EventLog;
use maka_model::{ProviderConfig, ProviderKind};
use maka_runtime::event::{Fact, Invocation};
use maka_runtime::tools::{ToolExecutor, ToolFuture};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolMode, ToolNesting, ToolRegistration,
    ToolSemantics,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Barrier;
use tokio_util::sync::CancellationToken;

pub const CODE: &str =
    "text(await Promise.all([tools.left({value:21}), tools.right({value:42})]));";

pub struct Effects {
    pub log: Arc<EventLog>,
    pub count: Arc<AtomicUsize>,
    pub together: Arc<Barrier>,
}
impl ToolExecutor for Effects {
    fn names(&self) -> Vec<String> {
        vec!["left".into(), "right".into()]
    }
    fn invoke(&self, name: String, input: Value, _: CancellationToken) -> ToolFuture {
        let log = self.log.clone();
        let count = self.count.clone();
        let together = self.together.clone();
        Box::pin(async move {
            let prefix = log.prefix(100, 128 * 1024).await.unwrap();
            let dispatches: Vec<_> =
                prefix
                    .events
                    .iter()
                    .filter_map(|event| {
                        match &event.event.fact {
                    Fact::ToolDispatched {
                        operation_id,
                        name: actual,
                        ..
                    } if actual == &name && !prefix.events.iter().any(|settled| matches!(
                        &settled.event.fact, Fact::ToolSettled { operation_id: settled_id, .. }
                        if settled_id == operation_id
                    )) => Some((operation_id, &event.event.invocation)),
                    _ => None,
                }
                    })
                    .collect();
            assert_eq!(
                dispatches.len(),
                1,
                "effect must have exactly one unsettled committed T1"
            );
            assert_eq!(dispatches[0].1.invocation_id, "invocation-first");
            assert!(!prefix.events.iter().any(|event| matches!(
                &event.event.fact, Fact::ToolSettled { operation_id, .. }
                if operation_id == dispatches[0].0
            )));
            count.fetch_add(1, Ordering::SeqCst);
            // A serial dispatcher cannot finish: both effects must be in flight.
            together.wait().await;
            Ok(input)
        })
    }
}

pub fn input(base: &str, suffix: &str, effects: Arc<Effects>) -> RunInput {
    let tools = ToolCatalog::new(["left", "right"].map(|name| ToolRegistration {
        definition: ToolDefinition {
            freeform: None, output_schema: None, provider: None,
            name: name.into(),
            description: format!("fixture {name}"),
            input_schema: json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}),
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Immediate(effects.clone()),
    })).unwrap();
    RunInput {
        model_source: None,
        model_revision: None,
        provider_id: "fixture".into(),
        main_output_limit: None,
        context: None,
        invocation: Invocation {
            session_id: "session".into(),
            turn_id: format!("turn-{suffix}"),
            run_id: format!("run-{suffix}"),
            invocation_id: format!("invocation-{suffix}"),
        },
        request_fingerprint: None,
        provider: ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            kind: ProviderKind::OpenaiChat,
            model: "test".into(),
            base_url: base.into(),
            auth: maka_model::ProviderAuth::ApiKey("fixture-secret".into()),
            headers: BTreeMap::new(),
            network: Default::default(),
            body_overlay: None,
        },
        provider_options: json!({}),
        supports_vision: false,
        configuration: invocation::configuration(ToolMode::CodeMode),
        work: maka_agent::RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: format!("question {suffix}").into(),
            tools,
            max_steps: 3,
        },
    }
}

pub async fn read_request(socket: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let boundary = loop {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 128 * 1024);
        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let length: usize = String::from_utf8_lossy(&bytes[..boundary])
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap();
    while bytes.len() < boundary + length {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
    }
    serde_json::from_slice(&bytes[boundary..boundary + length]).unwrap()
}

pub async fn respond(socket: &mut TcpStream, first: bool) {
    let arguments = json!({"code":CODE}).to_string();
    let split = arguments.len() / 2;
    let deltas = if first {
        vec![
            json!({"tool_calls":[{"index":0,"id":"exec-provider","type":"function","function":{"name":"exec","arguments":&arguments[..split]}}]}),
            json!({"tool_calls":[{"index":0,"function":{"arguments":&arguments[split..]}}]}),
        ]
    } else {
        vec![json!({"content":"done"})]
    };
    let mut frames: Vec<String> = deltas.into_iter().map(|delta| {
        let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        format!("data: {chunk}\n\n")
    }).collect();
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":if first {"tool_calls"} else {"stop"}}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
    frames.push(format!("data: {last}\n\ndata: [DONE]\n\n"));
    let length: usize = frames.iter().map(String::len).sum();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    for frame in frames {
        socket.write_all(frame.as_bytes()).await.unwrap();
        tokio::task::yield_now().await;
    }
}
