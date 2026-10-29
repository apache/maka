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

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use maka_agent_facts::composition::{SourceKind, SourceRevision};
use maka_agent_facts::language::Language;
use maka_agent_ports::model::{
    Binding, Context, Error, Lifetime, ProviderAdapter, Request, Session,
};
use maka_model::{
    ModelEvent, ModelExecutor, ModelRequest, ModelStream, ProviderAuth, ProviderConfig,
    ProviderKind,
    prompt::{Message, Prompt},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

struct Batch {
    events: Vec<ModelEvent>,
    emitted: oneshot::Sender<()>,
    cleanup_error: bool,
    close_gate: Option<Arc<tokio::sync::Semaphore>>,
}

struct ReadySession(Mutex<Option<Batch>>);

impl Session for ReadySession {
    fn stream(&self, _: Request, context: Context) -> BoxFuture<'static, Result<(), Error>> {
        let batch = self
            .0
            .lock()
            .expect("fixture batch lock poisoned")
            .take()
            .expect("fixture session is used once");
        Box::pin(async move {
            for event in batch.events {
                context.events.emit(event.into()).await?;
            }
            batch
                .emitted
                .send(())
                .expect("fixture awaits emitted batch");
            if let Some(gate) = batch.close_gate {
                gate.acquire().await.expect("fixture close gate").forget();
            }
            if batch.cleanup_error {
                Err(Error::CleanupUnconfirmed)
            } else {
                Ok(())
            }
        })
    }
}

struct ReadyAdapter(Arc<ReadySession>);

impl ProviderAdapter for ReadyAdapter {
    fn supports_item_acceptance(&self) -> bool {
        true
    }

    fn open(
        &self,
        _: Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        let session: Arc<dyn Session> = self.0.clone();
        Box::pin(async move { Ok(session) })
    }
}

pub(super) async fn ready(events: Vec<ModelEvent>) -> ModelStream {
    ready_with_cleanup(events, false, None).await
}

pub(super) async fn ready_with_cleanup_error(events: Vec<ModelEvent>) -> ModelStream {
    ready_with_cleanup(events, true, None).await
}

pub(super) async fn ready_with_close_gate(
    events: Vec<ModelEvent>,
    gate: Arc<tokio::sync::Semaphore>,
) -> ModelStream {
    ready_with_cleanup(events, false, Some(gate)).await
}

async fn ready_with_cleanup(
    events: Vec<ModelEvent>,
    cleanup_error: bool,
    close_gate: Option<Arc<tokio::sync::Semaphore>>,
) -> ModelStream {
    // The real executor buffers four emissions before applying backpressure.
    assert!(events.len() <= 4, "fixture batch must fit the model stream");
    let (emitted, ready) = oneshot::channel();
    let adapter = ReadyAdapter(Arc::new(ReadySession(Mutex::new(Some(Batch {
        events,
        emitted,
        cleanup_error,
        close_gate,
    })))));
    let binding = Binding::new(
        Arc::new(adapter),
        SourceRevision {
            kind: SourceKind::ModelAdapter,
            name: "publication-fixture".into(),
            package_id: "publication-fixture".into(),
            entry_id: "publication-fixture".into(),
            activation: "publication-fixture".into(),
            revision: "1".into(),
        },
    );
    let request = ModelRequest {
        language: Language::En,
        provider: ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            network: Default::default(),
            kind: ProviderKind::OpenaiChatCompletions,
            model: "publication-fixture".into(),
            base_url: "http://unused.example/v1".into(),
            auth: ProviderAuth::ApiKey("fixture".into()),
            headers: Default::default(),
            body_overlay: None,
        },
        prompt: Prompt::from_messages(vec![Message::user("fixture")]),
        tools: Vec::new(),
        provider_options: serde_json::json!({}),
        max_output_tokens: None,
    };
    let stream = ModelExecutor::new(Duration::from_secs(30))
        .expect("fixture executor")
        .stream_with_adapter(request, CancellationToken::new(), None, binding)
        .await
        .expect("fixture model stream");
    ready.await.expect("fixture emitted the complete batch");
    stream
}
