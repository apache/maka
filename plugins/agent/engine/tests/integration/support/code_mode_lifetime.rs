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

use futures_util::future::BoxFuture;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeOwner, NativeRetirement,
};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Notify;

pub async fn tool(socket: &mut TcpStream, name: &str, input: Value) {
    write_delta(
        socket,
        json!({"tool_calls":[{"index":0,"id":format!("call-{name}"),"type":"function","function":{
        "name":name,"arguments":input.to_string()}}]}),
        "tool_calls",
    )
    .await;
}
async fn write_delta(socket: &mut TcpStream, delta: Value, reason: &str) {
    let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":reason}]});
    let body = format!("data: {chunk}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

#[derive(Clone, Default)]
pub struct AnswerEffect {
    pub entered: Arc<Notify>,
    pub release: Arc<Notify>,
    pub count: Arc<AtomicUsize>,
}
impl AnswerEffect {
    pub fn contract() -> Contract {
        Contract {
            name: "fixture.Answer".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: std::collections::BTreeMap::from([(
                    "slow".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: json!({"type":"object"}).into(),
                        output: json!({"type":"object"}).into(),
                        progress: None,
                        resources: std::collections::BTreeMap::new(),
                    },
                )]),
            },
        }
    }
}
impl Handler for AnswerEffect {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let effect = self.clone();
        Box::pin(async move {
            if method != "slow" {
                return Err(HandlerError::from("unknown Answer method"));
            }
            assert!(
                context.operation().is_some(),
                "the real Host mutation must precede its effect"
            );
            effect.count.fetch_add(1, Ordering::SeqCst);
            effect.entered.notify_one();
            tokio::select! {
                _=effect.release.notified()=>Ok(HandlerValue::Json(input)),
                _=context.scope().cancellation.cancelled()=>Err(HandlerError::from("answer was cancelled")),
            }
        })
    }
}
impl NativeOwner for AnswerEffect {
    fn prepare_retirement(&self) -> Option<Box<dyn NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
