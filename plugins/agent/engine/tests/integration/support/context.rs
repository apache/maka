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
pub use http::read_request;
use serde_json::json;
use tokio::{io::AsyncWriteExt, net::TcpStream};

pub const SUMMARY: &str = "## Goal\nContinue the durable task.\n## Progress\n### Done\n- Saved the original work.\n## Next Steps\n1. Verify checkpoint replay.\n## Critical Context\n- summary-marker in src/event.rs.";
pub async fn respond(socket: &mut TcpStream, text: &str, reason: &str) {
    respond_with_usage(
        socket,
        text,
        reason,
        json!({"prompt_tokens":20,"completion_tokens":50,"total_tokens":70}),
    )
    .await;
}

pub async fn respond_with_usage(
    socket: &mut TcpStream,
    text: &str,
    reason: &str,
    usage: serde_json::Value,
) {
    let first = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":usage});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
