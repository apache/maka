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

//! Fixture-only prepared source. Semantic reads fail so live and loopback tests
//! cannot accidentally exercise the explicit in-memory fallback path.
use maka_agent_facts::model::prompt_source::{Next, NextWire, WireMetadataCursor, WirePosition};
use maka_model::{
    ModelError, ModelRequest,
    prompt::{Message, Prompt, PromptCursor, PromptSource, WireCursor, WireSource},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Default)]
struct Counters {
    semantic: AtomicUsize,
    wire_bytes: AtomicUsize,
}
pub(crate) struct Reads(Arc<Counters>);
impl Reads {
    pub(crate) fn assert_wire_only(&self) {
        assert_eq!(
            self.0.semantic.load(Ordering::SeqCst),
            0,
            "prepared request must never open semantic history"
        );
        assert!(
            self.0.wire_bytes.load(Ordering::SeqCst) > 0,
            "provider must consume the prepared body"
        );
    }
}
struct Source {
    wire: Arc<dyn WireSource>,
    counters: Arc<Counters>,
}
struct FailedCursor;
impl PromptSource for Source {
    fn open(&self) -> Box<dyn PromptCursor> {
        self.counters.semantic.fetch_add(1, Ordering::SeqCst);
        Box::new(FailedCursor)
    }
}
impl PromptCursor for FailedCursor {
    fn next(&mut self) -> Next<'_> {
        Box::pin(async {
            Err(ModelError::Adapter(
                "fixture semantic history must remain unread".into(),
            ))
        })
    }
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
            if let Some(chunk) = &chunk {
                self.counters
                    .wire_bytes
                    .fetch_add(chunk.bytes.len(), Ordering::SeqCst);
            }
            Ok(chunk)
        })
    }
}
impl WireSource for Source {
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
        Box::new(Cursor {
            inner: self.wire.open(start),
            counters: self.counters.clone(),
        })
    }
    fn open_at(&self, position: WirePosition) -> Option<Box<dyn WireCursor>> {
        Some(Box::new(Cursor {
            inner: self.wire.open_at(position)?,
            counters: self.counters.clone(),
        }))
    }
    fn open_metadata(&self, start: usize) -> Option<Box<dyn WireMetadataCursor>> {
        self.wire.open_metadata(start)
    }
    fn prefix_identity(
        &self,
        count: usize,
    ) -> maka_agent_facts::model::prompt_source::PrefixIdentity<'_> {
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

pub(crate) async fn prepare_input(input: &mut ModelRequest) -> Reads {
    let messages = input
        .prompt
        .memory_messages()
        .expect("synthetic fixture input")
        .to_vec();
    let messages = maka_model::reasoning::project(messages, &input.provider.kind);
    let instructions = messages
        .iter()
        .find_map(|message| match message {
            Message::System { content, .. } if !content.trim().is_empty() => Some(content.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let logical = Prompt::from_messages(messages.clone());
    let encoding = maka_model::WireEncoding::new(
        input.language,
        &input.provider,
        &input.provider_options,
        &input.tools,
    )
    .unwrap();
    let format = encoding.format();
    let codec = encoding.codec().to_owned();
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
    let counters = Arc::new(Counters::default());
    let source = Arc::new(Source {
        wire: wire.source,
        counters: counters.clone(),
    });
    input.prompt = Prompt::new(
        source.clone(),
        logical.identity(),
        logical.len(),
        logical.breakdown().clone(),
    )
    .with_normalization(input.provider.kind.clone())
    .with_wire(format, codec, wire.identity, source)
    .with_instructions(instructions);
    Reads(counters)
}
