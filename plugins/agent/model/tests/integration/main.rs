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

mod adapters;
mod concurrency;
mod context_overflow;
mod live_search;
mod openrouter;
mod provider_compatible;
mod provider_ingress;
mod provider_responses;
mod provider_stream;
mod provider_tools;
mod responses_websocket;
mod wire_encoding;

// Mutable builders exist only in fixtures; production requests carry immutable views.
fn edit_prompt(
    prompt: &mut maka_model::prompt::Prompt,
    edit: impl FnOnce(&mut Vec<maka_model::prompt::Message>),
) {
    let mut messages = prompt
        .memory_messages()
        .expect("fixture memory source")
        .to_vec();
    edit(&mut messages);
    *prompt = messages.into();
}

async fn http_request(socket: &mut tokio::net::TcpStream) -> (String, Vec<u8>) {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.unwrap());
        assert!(head.len() < 64 * 1024);
    }
    // HTTP header values may contain Latin-1 bytes; keep every byte intact for assertions.
    let head: String = head.into_iter().map(char::from).collect();
    let body = http_body(socket, &head, Vec::new()).await;
    (head, body)
}

// Decode either real chunked streaming uploads or explicitly buffered fixture input.
async fn http_body(socket: &mut tokio::net::TcpStream, head: &str, buffered: Vec<u8>) -> Vec<u8> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let mut reader = tokio::io::BufReader::new(std::io::Cursor::new(buffered).chain(socket));
    let length = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().unwrap())
    });
    let mut body = Vec::new();
    if let Some(length) = length {
        body.resize(length, 0);
        reader.read_exact(&mut body).await.unwrap();
    } else if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let length = usize::from_str_radix(line.trim().split(';').next().unwrap(), 16).unwrap();
            if length == 0 {
                loop {
                    line.clear();
                    reader.read_line(&mut line).await.unwrap();
                    if line == "\r\n" {
                        break;
                    }
                }
                break;
            }
            let start = body.len();
            body.resize(start + length, 0);
            reader.read_exact(&mut body[start..]).await.unwrap();
            let mut ending = [0; 2];
            reader.read_exact(&mut ending).await.unwrap();
            assert_eq!(&ending, b"\r\n");
        }
    }
    body
}
