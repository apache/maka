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

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

pub const CODE: &str =
    "text(await Promise.all([tools.left({value:21}), tools.right({value:42})]));";

pub async fn read_request(socket: &mut TcpStream) -> Value {
    super::http::read_request(socket).await
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
