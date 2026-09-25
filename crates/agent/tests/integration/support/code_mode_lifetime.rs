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

use maka_runtime::tools::{ToolExecutor, ToolFuture};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct SlowEffect {
    pub entered: Arc<Notify>,
    pub cancelled: Arc<Notify>,
    pub release: Arc<Notify>,
    pub count: Arc<AtomicUsize>,
}
impl ToolExecutor for SlowEffect {
    fn names(&self) -> Vec<String> {
        vec!["slow".into()]
    }
    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let effect = self.clone();
        Box::pin(async move {
            effect.count.fetch_add(1, Ordering::SeqCst);
            effect.entered.notify_one();
            cancellation.cancelled().await;
            effect.cancelled.notify_one();
            effect.release.notified().await;
            Ok(input)
        })
    }
}
pub async fn respond(socket: &mut TcpStream, first: bool) {
    let delta = if first {
        json!({"tool_calls":[{"index":0,"id":"exec-slow","type":"function","function":{
            "name":"exec","arguments":json!({"code":"await tools.slow({value:42});"}).to_string()
        }}]})
    } else {
        json!({"content":"done"})
    };
    write_delta(socket, delta, if first { "tool_calls" } else { "stop" }).await;
}
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
impl ToolExecutor for AnswerEffect {
    fn names(&self) -> Vec<String> {
        vec!["slow".into()]
    }
    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let effect = self.clone();
        Box::pin(async move {
            effect.count.fetch_add(1, Ordering::SeqCst);
            effect.entered.notify_one();
            tokio::select! {
                _=effect.release.notified()=>Ok(input),
                _=cancellation.cancelled()=>Err(maka_runtime::tools::ToolError::Failed("answer was cancelled".into())),
            }
        })
    }
}
