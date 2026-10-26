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

use super::{provider_compatible::body as read_request, provider_stream::request};
use maka_model::{ModelError, ModelEvent, ModelExecutor, ProviderKind, StepBuilder};
use serde_json::json;
use std::{io, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

const LIMIT: usize = maka_provider_protocol::sse::MAX_RECORD_BYTES;
const ERROR_BODY_LIMIT: usize = 8 * 1024 * 1024;

enum Response {
    Stream {
        body: String,
        accepted: bool,
        compatible: bool,
    },
    DeclaredBody,
    StreamingBody,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ingress_limits_close_only_offending_http_and_preserve_bounded_sse_records() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let models = ModelExecutor::new(Duration::from_secs(20)).unwrap();
        let exact_record = format!(":{}\n\n", "x".repeat(LIMIT - 3));
        let cr_records = format!(":{}\r\r", "x".repeat(LIMIT / 2)).repeat(3);
        let multiline = "data: {}\r\n".repeat(LIMIT / 10 + 1);
        for (index, response) in [
            Response::Stream { body: exact_record, accepted: true, compatible: false },
            Response::Stream { body: cr_records, accepted: true, compatible: true },
            Response::Stream { body: format!("data: {}", "x".repeat(LIMIT)), accepted: false, compatible: false },
            Response::Stream { body: multiline, accepted: false, compatible: true },
            Response::DeclaredBody,
            Response::StreamingBody,
        ].into_iter().enumerate() {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let accepted = matches!(&response, Response::Stream { accepted: true, .. });
            let compatible = matches!(&response, Response::Stream { compatible: true, .. });
            let stream_limit = matches!(&response, Response::Stream { .. });
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                match response {
                    Response::DeclaredBody => {
                        socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", ERROR_BODY_LIMIT + 1).as_bytes()).await.unwrap();
                    },
                    response => {
                        let (status, mime, mut body) = match response {
                            Response::Stream { body, .. } => (200, "text/event-stream", body),
                            Response::StreamingBody => (400, "text/plain", "x".repeat(ERROR_BODY_LIMIT + 1)),
                            Response::DeclaredBody => unreachable!(),
                        };
                        socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: {mime}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                        if accepted {
                            let part = json!({"id":"bounded","object":"chat.completion.chunk","created":1,"model":"test-model",
                                "choices":[{"index":0,"delta":{"content":"alive"},"finish_reason":"stop"}],
                                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});
                            // CRLF ends are split between HTTP chunks; standalone
                            // CR records above must not accumulate in compatibleFetch.
                            body += &format!("data: {part}\r\n\r\ndata: [DONE]\r\n\r\n");
                        }
                        if let Err(error) = chunks(&mut socket, body.as_bytes()).await {
                            assert!(!accepted && disconnected(&error), "unexpected write failure: {error}");
                            return;
                        }
                        if accepted {
                            socket.write_all(b"0\r\n\r\n").await.unwrap();
                            return;
                        }
                    },
                }
                // A model limit must cancel the incomplete response, not wait
                // for EOF or let the per-request deadline kill the shared V8.
                match socket.read(&mut [0]).await {
                    Ok(0) => {},
                    Err(error) if disconnected(&error) => {},
                    other => panic!("offending HTTP was not closed: {other:?}"),
                }
            });
            let kind = if compatible {
                ProviderKind::OpenaiCompatible { name: "bounded-fixture".into() }
            } else { ProviderKind::OpenaiChatCompletions };
            let mut request = request(kind, base);
            // Exercise the custom headers as well as the adapter default.
            request.provider.headers.insert("X-Fixture".into(), "ingress".into());
            let mut stream = models.stream(request, CancellationToken::new()).await.unwrap();
            let mut step = StepBuilder::default();
            let mut error = None;
            let mut text = String::new();
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        let event = event.event;
                        if let ModelEvent::PartDelta { text: delta, .. } = &event { text.push_str(delta); }
                        step.push(event).unwrap();
                    },
                    Err(failure) => { error = Some(failure); break; },
                }
            }
            server.await.unwrap();
            stream.cancel_and_wait().await.expect("actual stream cleanup");
            if accepted {
                assert!(error.is_none(), "legal record failed in case {index}");
                assert_eq!(text, "alive");
                step.finish().unwrap();
            } else {
                let Some(ModelError::Adapter(message)) = error else {
                    panic!("case {index}: limits must be local adapter errors, not timeout/overflow");
                };
                if stream_limit {
                    assert!(message.contains("SSE record exceeds 64 MiB"), "case {index}: {message}");
                } else {
                    assert!(message.contains("response body exceeds 8 MiB"), "case {index}: {message}");
                }
                assert!(step.finish().is_err());
            }
        }
    }).await.expect("ingress failure must settle without a shared-runtime failure");
}

fn disconnected(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
    )
}

async fn chunks(socket: &mut TcpStream, body: &[u8]) -> io::Result<()> {
    for chunk in body.chunks(64 * 1024 + 1) {
        // Force CR and LF into separate chunk writes without changing bytes.
        let boundary = chunk
            .iter()
            .rposition(|byte| *byte == b'\r')
            .map_or(chunk.len(), |at| at + 1);
        let (head, tail) = chunk.split_at(boundary);
        for piece in [head, tail] {
            if piece.is_empty() {
                continue;
            }
            socket
                .write_all(format!("{:x}\r\n", piece.len()).as_bytes())
                .await?;
            socket.write_all(piece).await?;
            socket.write_all(b"\r\n").await?;
        }
    }
    Ok(())
}
