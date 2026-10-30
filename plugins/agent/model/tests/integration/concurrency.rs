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

use super::provider_stream::{read_request, request};
use maka_model::{ModelEvent, ModelExecutor, ProviderKind, StepBuilder};
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_native_requests_progress_through_backpressure_and_cancellation() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let models = ModelExecutor::new(Duration::from_secs(15)).unwrap();

        let waiting = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let waiting_base = format!("http://{}/v1", waiting.local_addr().unwrap());
        let (received, ready) = oneshot::channel();
        let pending_http = tokio::spawn(async move {
            let (mut socket, _) = waiting.accept().await.unwrap();
            read_request(&mut socket).await;
            received.send(()).unwrap();
            assert_http_closed(&mut socket).await;
        });
        let held = models.stream(request(ProviderKind::OpenaiChatCompletions, waiting_base), CancellationToken::new()).await.unwrap();
        ready.await.unwrap();

        let flooding = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let flooding_base = format!("http://{}/v1", flooding.local_addr().unwrap());
        let flood_http = tokio::spawn(async move {
            let (mut socket, _) = flooding.accept().await.unwrap();
            read_request(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
            let part = json!({"id":"slow","object":"chat.completion.chunk","created":1,"model":"test-model",
                "choices":[{"index":0,"delta":{"content":"x".repeat(4096)},"finish_reason":null}]});
            let data = format!("data: {part}\n\n").repeat(256);
            // The consumer may cancel while this undrained response is still
            // being written; a closed peer is the expected cleanup outcome.
            if let Err(error) = socket.write_all(format!("{:x}\r\n{data}\r\n", data.len()).as_bytes()).await {
                assert!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted), "unexpected response write failure: {error}");
            }
            assert_http_closed(&mut socket).await;
        });
        let mut slow = models.stream(request(ProviderKind::OpenaiChatCompletions, flooding_base), CancellationToken::new()).await.unwrap();
        loop {
            if matches!(slow.next().await.unwrap().unwrap().event, ModelEvent::PartDelta { .. }) { break; }
        }
        // Leave the stream alive and undrained. More events than its bounded
        // output queue can hold must not occupy the other requests indefinitely.
        let serving = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", serving.local_addr().unwrap());
        let healthy_http = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut socket, _) = serving.accept().await.unwrap();
                read_request(&mut socket).await;
                let part = json!({"id":"healthy","object":"chat.completion.chunk","created":1,"model":"test-model",
                    "choices":[{"index":0,"delta":{"content":"alive"},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});
                let body = format!("data: {part}\n\ndata: [DONE]\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        async fn complete(models: &ModelExecutor, base: &str) {
            let mut stream = models.stream(request(ProviderKind::OpenaiChatCompletions, base.into()), CancellationToken::new()).await.unwrap();
            let mut step = StepBuilder::default();
            let mut text = String::new();
            while let Some(event) = stream.next().await {
                let event = event.unwrap().event;
                if let ModelEvent::PartDelta { text: delta, .. } = &event { text.push_str(delta); }
                step.push(event).unwrap();
            }
            assert_eq!(text, "alive");
            step.finish().unwrap();
            stream.cancel_and_wait().await.expect("actual stream cleanup");
        }
        complete(&models, &base).await;

        held.cancel_and_wait().await.expect("actual stream cleanup");
        pending_http.await.unwrap();
        // An abandoned model consumer also cancels and settles its adapter request.
        let abandoned = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let abandoned_base = format!("http://{}/v1", abandoned.local_addr().unwrap());
        let (arrived, ready) = oneshot::channel();
        let abandoned_http = tokio::spawn(async move {
            let (mut socket, _) = abandoned.accept().await.unwrap();
            read_request(&mut socket).await;
            arrived.send(()).unwrap();
            assert_http_closed(&mut socket).await;
        });
        let abandoned_models = models.clone();
        let abandoned_call = tokio::spawn(async move {
            let _stream = abandoned_models.stream(request(ProviderKind::OpenaiChatCompletions, abandoned_base), CancellationToken::new()).await.unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        abandoned_call.abort();
        assert!(abandoned_call.await.unwrap_err().is_cancelled());
        abandoned_http.await.unwrap();
        complete(&models, &base).await;

        slow.cancel_and_wait().await.expect("actual stream cleanup");
        flood_http.await.unwrap();
        complete(&models, &base).await;
        healthy_http.await.unwrap();
    }).await.expect("native adapters must make progress across independent lifetimes");
}

async fn assert_http_closed(socket: &mut TcpStream) {
    match socket.read(&mut [0]).await {
        Ok(0) => {}
        // Cancellation may reset a socket with unread response bytes. Winsock
        // also reports this as ConnectionAborted, rather than an orderly EOF.
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ) => {}
        result => panic!("cancelled HTTP connection did not close: {result:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_open_stream_does_not_reserve_capacity_for_independent_requests() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let models = ModelExecutor::new(Duration::from_secs(30)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (received, ready) = oneshot::channel();
        let http = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            assert!(read_request(&mut first).await.len() > 32 * 1024 * 1024);
            first.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            received.send(()).unwrap();
            // The first request is still physically open when the independent
            // request arrives and completes. Request size is not a stream quota.
            let (mut second, _) = listener.accept().await.unwrap();
            assert!(read_request(&mut second).await.contains("independent request"));
            let part = json!({"id":"independent","object":"chat.completion.chunk","created":1,"model":"test-model",
                "choices":[{"index":0,"delta":{"content":"while the large stream is open"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});
            let body = format!("data: {part}\n\ndata: [DONE]\n\n");
            second.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            assert_http_closed(&mut first).await;
        });
        let mut large = request(ProviderKind::OpenaiChatCompletions, base.clone());
        large.prompt = vec![maka_model::prompt::Message::user("x".repeat(33 * 1024 * 1024))].into();
        let held = models.stream(large, CancellationToken::new()).await.unwrap();
        ready.await.unwrap();
        let mut independent = request(ProviderKind::OpenaiChatCompletions, base);
        independent.prompt = vec![maka_model::prompt::Message::user("independent request")].into();
        let mut stream = models.stream(independent, CancellationToken::new()).await.unwrap();
        let mut text = String::new();
        let mut step = StepBuilder::default();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = stream.next().await {
                let event = event.unwrap().event;
                if let ModelEvent::PartDelta { text: delta, .. } = &event { text.push_str(delta); }
                step.push(event).unwrap();
            }
        }).await.expect("an open large request must not block unrelated streams");
        assert_eq!(text, "while the large stream is open");
        step.finish().unwrap();
        stream.cancel_and_wait().await.expect("independent stream cleanup");
        held.cancel_and_wait().await.expect("large stream physical cancellation");
        http.await.unwrap();
    }).await.expect("large and independent streams both settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_waiting_for_response_headers_times_out_and_closes_each_protocol() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let models = ModelExecutor::new(Duration::from_millis(400)).unwrap();
        for kind in [
            ProviderKind::OpenaiChatCompletions,
            ProviderKind::OpenaiCompatible {
                name: "fixture".into(),
            },
            ProviderKind::Anthropic,
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let http = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                assert_http_closed(&mut socket).await;
            });
            let mut stream = models
                .stream(request(kind, base), CancellationToken::new())
                .await
                .unwrap();
            let error = loop {
                match stream.next().await {
                    Some(Ok(_)) => {}
                    Some(Err(error)) => break error,
                    None => panic!("silent HTTP headers must report the actual timeout"),
                }
            };
            assert!(
                matches!(error, maka_model::ModelError::TimedOut),
                "{error:?}"
            );
            stream
                .cancel_and_wait()
                .await
                .expect("timed-out HTTP cleanup");
            http.await.unwrap();
        }
    })
    .await
    .expect("all adapter protocols bound network silence");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_output_backpressure_outlives_idle_timeout_without_losing_text() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for silent_after_resume in [false, true] {
            let models = ModelExecutor::new(Duration::from_millis(400)).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let unit = "retained 字🙂 ";
            let (resume, resumed) = oneshot::channel();
            let http = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                let part = json!({"id":"backpressure","object":"chat.completion.chunk","created":1,"model":"test-model",
                    "choices":[{"index":0,"delta":{"content":unit},"finish_reason":null}]});
                let body = format!("data: {part}\n\n").repeat(128);
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
                socket.write_all(format!("{:x}\r\n{body}\r\n",body.len()).as_bytes()).await.unwrap();
                // No further wire bytes arrive while the caller deliberately stops
                // draining the bounded event queue beyond its idle interval.
                resumed.await.unwrap();
                if silent_after_resume {
                    assert_http_closed(&mut socket).await;
                    return;
                }
                let last = json!({"id":"backpressure","object":"chat.completion.chunk","created":1,"model":"test-model",
                    "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":1,"completion_tokens":128,"total_tokens":129}});
                let body = format!("data: {last}\n\ndata: [DONE]\n\n");
                socket.write_all(format!("{:x}\r\n{body}\r\n0\r\n\r\n",body.len()).as_bytes()).await.unwrap();
            });
            let mut stream = models.stream(request(ProviderKind::OpenaiChatCompletions, base), CancellationToken::new()).await.unwrap();
            let mut step = StepBuilder::default();
            let mut text = String::new();
            let mut paused = false;
            let mut resume = Some(resume);
            let mut failure = None;
            while let Some(event) = stream.next().await {
                let event = match event {
                    Ok(event) => event.event,
                    Err(error) => { failure = Some(error); break; },
                };
                if let ModelEvent::PartDelta { text: delta, .. } = &event {
                    text.push_str(delta);
                    if !paused {
                        paused = true;
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                        resume.take().unwrap().send(()).unwrap();
                    }
                }
                step.push(event).unwrap();
            }
            assert!(paused);
            assert_eq!(text, unit.repeat(128));
            if silent_after_resume {
                assert!(
                    matches!(&failure, Some(maka_model::ModelError::Provider(failure))
                        if failure.reason() == maka_model::ProviderFailureReason::TimedOut),
                    "{failure:?}"
                );
                assert!(step.finish().is_err());
            } else {
                assert!(failure.is_none(), "{failure:?}");
                step.finish().unwrap();
            }
            stream.cancel_and_wait().await.expect("backpressured output cleanup");
            http.await.unwrap();
        }
    }).await.expect("local output backpressure preserves the complete stream");
}
