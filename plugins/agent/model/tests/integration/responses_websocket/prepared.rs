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

//! Real loopback requests whose semantic prompt cursor must never be opened.
use super::*;
use maka_agent_facts::model::prompt::{AssistantPart, Message as PromptMessage};
use maka_agent_facts::model::prompt_source::{
    Next, NextWire, PrefixIdentity, Prompt, PromptCursor, PromptSource, WireCursor, WireFormat,
    WireMetadataCursor, WireSource,
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Default)]
struct Counters {
    semantic: AtomicUsize,
    reads: AtomicUsize,
    opens: Mutex<Vec<usize>>,
    metadata_opens: Mutex<Vec<usize>>,
}
struct Forbidden(Arc<Counters>);
impl PromptSource for Forbidden {
    fn open(&self) -> Box<dyn PromptCursor> {
        self.0.semantic.fetch_add(1, Ordering::SeqCst);
        Box::new(ForbiddenCursor)
    }
}
struct ForbiddenCursor;
impl PromptCursor for ForbiddenCursor {
    fn next(&mut self) -> Next<'_> {
        Box::pin(async {
            Err(maka_model::ModelError::Adapter(
                "semantic history read forbidden".into(),
            ))
        })
    }
}
struct Stored {
    wire: Arc<dyn WireSource>,
    counters: Arc<Counters>,
}
struct Cursor {
    inner: Box<dyn WireCursor>,
    counters: Arc<Counters>,
}
impl WireCursor for Cursor {
    fn budget(
        &self,
    ) -> Option<Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudget>> {
        self.inner.budget()
    }
    fn next(&mut self) -> NextWire<'_> {
        Box::pin(async move {
            let chunk = self.inner.next().await?;
            if chunk.is_some() {
                self.counters.reads.fetch_add(1, Ordering::SeqCst);
            }
            Ok(chunk)
        })
    }
}
impl WireSource for Stored {
    fn source_identities(
        &self,
    ) -> Option<Arc<dyn maka_agent_facts::model::prompt_source::SourceIdentityLookup>> {
        self.wire.source_identities()
    }
    fn document_count(&self) -> usize {
        self.wire.document_count()
    }
    fn document(
        &self,
        index: usize,
        budget: Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudget>,
    ) -> maka_agent_facts::model::prompt_source::NextWireDocument<'_> {
        self.wire.document(index, budget)
    }
    fn budget_factory(
        &self,
    ) -> Option<Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudgetFactory>> {
        self.wire.budget_factory()
    }
    fn acquire_budget(&self) -> maka_agent_facts::model::prompt_source::AcquireWireBudget<'_> {
        self.wire.acquire_budget()
    }
    fn open(&self, start: usize) -> Box<dyn WireCursor> {
        self.counters.opens.lock().unwrap().push(start);
        Box::new(Cursor {
            inner: self.wire.open(start),
            counters: self.counters.clone(),
        })
    }
    fn open_metadata(&self, start: usize) -> Option<Box<dyn WireMetadataCursor>> {
        self.counters.metadata_opens.lock().unwrap().push(start);
        self.wire.open_metadata(start)
    }
    fn prefix_identity(&self, count: usize) -> PrefixIdentity<'_> {
        self.wire.prefix_identity(count)
    }
}
fn resources() -> maka_model::ModelPreparationResources {
    maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy {
        staging_bytes: 8 * 1024 * 1024,
        resident_bytes: 8 * 1024 * 1024,
        progress_bytes: 256 * 1024,
        work_bytes: 256 * 1024,
    })
    .unwrap()
}
async fn prepared(
    request: &ModelRequest,
    messages: Vec<PromptMessage>,
    counters: Arc<Counters>,
) -> Prompt {
    let breakdown = maka_agent_facts::context::measure::prompt_breakdown(&messages);
    let encoding = maka_model::WireEncoding::new(
        request.language,
        &request.provider,
        &request.provider_options,
        &request.tools,
    )
    .unwrap();
    let codec = encoding.codec().to_owned();
    let count = messages.len();
    let wire = encoding
        .prepare_source(
            Arc::new(
                maka_agent_facts::model::prompt_source::source::generated::GeneratedMessages::new(
                    &messages,
                ),
            ),
            resources(),
        )
        .await
        .unwrap();
    let identity = wire.identity;
    Prompt::new(
        Arc::new(Forbidden(counters.clone())),
        identity.clone(),
        count,
        breakdown,
    )
    .with_wire(
        WireFormat::Responses,
        codec,
        identity,
        Arc::new(Stored {
            wire: wire.source,
            counters,
        }),
    )
    .with_normalization(request.provider.kind.clone())
}
fn assistant(step: &maka_agent_facts::model::ModelStep) -> PromptMessage {
    let content = step
        .parts
        .iter()
        .map(|part| match part {
            maka_agent_facts::model::ModelPart::Text {
                text,
                provider_options,
                ..
            } => AssistantPart::Text {
                text: text.chunks().collect(),
                provider_options: provider_options.as_deref().cloned(),
            },
            _ => panic!("unexpected fixture output"),
        })
        .collect();
    PromptMessage::Assistant {
        content,
        provider_options: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepared_responses_http_redirect_replays_without_semantic_history() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let text = "escaped \"text\" / 中 😀\n".repeat(5000);
        let expected = text.clone();
        let server = tokio::spawn(async move {
            let (mut redirect, _) = listener.accept().await.unwrap();
            let (head, first) = crate::http_request(&mut redirect).await;
            assert!(head.starts_with("POST /v1/responses "));
            redirect.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /v1/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            drop(redirect);
            let (mut socket, _) = listener.accept().await.unwrap();
            let (head, bytes) = crate::http_request(&mut socket).await;
            assert!(head.starts_with("POST /v1/redirected "));
            assert_eq!(bytes, first, "redirect must reopen the same immutable wire view");
            assert!(head.to_ascii_lowercase().contains("transfer-encoding: chunked"));
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["input"], json!([
                {"role":"system","content":"fixed system"},
                {"role":"user","content":[{"type":"input_text","text":expected}]}
            ]));
            assert_eq!(body["model"], "test-responses");
            assert_eq!(body["max_output_tokens"], 32);
            assert_eq!(body["reasoning"], json!({"effort":"medium"}));
            assert_eq!(body["tenant"], "prepared-fixture");
            let response: String = events("prepared-http", "OK").iter().map(|event| format!("data: {event}\n\n")).collect();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        });
        let counters = Arc::new(Counters::default());
        let mut input = request(&base, "unused");
        input.provider.headers.insert("x-prepared-fixture".into(), "true".into());
        input.provider.body_overlay = Some(serde_json::from_value(json!({"tenant":"prepared-fixture"})).unwrap());
        input.provider_options["openai"]["reasoningEffort"] = json!("medium");
        input.prompt = prepared(&input, vec![
            PromptMessage::System { content:"fixed system".into(), provider_options:None },
            // Zero wire items still have a logical metadata row and cannot
            // introduce an extra comma or shift the following message offset.
            PromptMessage::Assistant { content:vec![AssistantPart::Reasoning { text:"not replayable".into(),provider_options:None }],provider_options:None },
            PromptMessage::user(text),
        ], counters.clone()).await;
        generate(&ModelExecutor::new(Duration::from_secs(10)).unwrap(), &Conversation::default(), input).await;
        server.await.unwrap();
        assert_eq!(counters.semantic.load(Ordering::SeqCst), 0);
        assert!(counters.reads.load(Ordering::SeqCst) > 10);
        let opens = counters.opens.lock().unwrap();
        assert!(opens.len() >= 2 && opens.iter().all(|start| *start == 0));
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn indexed_prefixes_repeat_deltas_and_changed_roots_force_full_replay() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut socket = accept(&listener).await;
            let first = continuation::body(&mut socket).await;
            assert!(first.get("previous_response_id").is_none());
            assert_eq!(first["input"].as_array().unwrap().len(), 1);
            socket.send(Message::Text(json!({"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"test-responses"}}).to_string().into())).await.unwrap();
            socket.send(Message::Text(json!({"type":"response.completed","response":{"id":"resp_1","output":[
                {"type":"message","id":"message-a","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"First","annotations":[]}]},
                {"type":"message","id":"message-b","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}
            ]}}).to_string().into())).await.unwrap();
            let second = continuation::body(&mut socket).await;
            assert_eq!(second["previous_response_id"], "resp_1");
            assert_eq!(
                second["input"],
                json!([{"role":"user","content":[{"type":"input_text","text":"second"}]}])
            );
            finish(&mut socket, "resp_2").await;
            let third = continuation::body(&mut socket).await;
            assert!(third.get("previous_response_id").is_none());
            assert_eq!(third["input"].as_array().unwrap().len(), 6);
            assert_eq!(third["input"][0]["content"][0]["text"], "compacted");
            assert_eq!(
                third["input"][1]["id"], "message-a",
                "accepted metadata is canonical, not a transport cache"
            );
            assert_eq!(third["input"][1]["phase"], "commentary");
            assert_eq!(third["input"][2]["id"], "message-b", "two wire items occupy one logical message");
            finish(&mut socket, "resp_3").await;
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let lane = Conversation::default();
        let counters = Arc::new(Counters::default());
        let mut input = request(&base, "unused");
        let mut messages = vec![PromptMessage::user("first")];
        input.prompt = prepared(&input, messages.clone(), counters.clone()).await;
        let first = generate_step(&executor, &lane, input).await;
        assert_eq!(first.response_id.as_deref(), Some("resp_1"));
        assert_eq!(first.parts.len(), 2, "both provider messages must survive acceptance");
        let mut input = request(&base, "unused");
        messages.push(assistant(&first));
        let confirmation = prepared(&input, messages.clone(), counters.clone()).await;
        let reads = counters.reads.load(Ordering::SeqCst);
        assert!(
            lane.confirm(&confirmation, &[], first.response_id.as_deref())
                .await
        );
        assert_eq!(counters.reads.load(Ordering::SeqCst), reads);
        messages.push(PromptMessage::user("second"));
        input.prompt = prepared(&input, messages.clone(), counters.clone()).await;
        let second = generate_step(&executor, &lane, input).await;
        let mut input = request(&base, "unused");
        messages.push(assistant(&second));
        let confirmation = prepared(&input, messages.clone(), counters.clone()).await;
        let reads = counters.reads.load(Ordering::SeqCst);
        assert!(
            lane.confirm(&confirmation, &[], second.response_id.as_deref())
                .await
        );
        assert_eq!(counters.reads.load(Ordering::SeqCst), reads);
        messages[0] = PromptMessage::user("compacted");
        messages.push(PromptMessage::user("third"));
        input.prompt = prepared(&input, messages, counters.clone()).await;
        generate(&executor, &lane, input).await;
        server.await.unwrap();
        assert_eq!(counters.semantic.load(Ordering::SeqCst), 0);
        assert_eq!(*counters.opens.lock().unwrap(), vec![0, 2, 0]);
        assert_eq!(*counters.metadata_opens.lock().unwrap(), vec![1, 3]);
    })
    .await
    .unwrap();
}
