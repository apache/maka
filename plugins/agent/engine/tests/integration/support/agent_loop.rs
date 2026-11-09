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

use serde_json::json;

pub(crate) async fn respond(socket: &mut tokio::net::TcpStream, tool: bool) {
    respond_tool(socket, tool.then_some("echo")).await;
}

pub(crate) async fn respond_tool(socket: &mut tokio::net::TcpStream, tool: Option<&str>) {
    use tokio::io::AsyncWriteExt;
    let delta = if let Some(name) = tool {
        json!({"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":name,"arguments":"{\"value\":42}"}}]})
    } else {
        json!({"content":"done"})
    };
    let first = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":if tool.is_some() {"tool_calls"} else {"stop"}}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
