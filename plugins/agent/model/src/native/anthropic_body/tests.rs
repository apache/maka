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

use super::*;
use maka_agent_facts::model::prompt_source::source::{
    Allocate, ChargedBuffer, SourceBudget, SourceBytes, TextEncoding, TextSource,
};
use maka_provider_protocol::input;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
struct Owner {
    bytes: Vec<u8>,
    dropped: Arc<AtomicUsize>,
}
impl AsRef<[u8]> for Owner {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
struct Cursor {
    bytes: Option<Bytes>,
    budget: Arc<dyn SourceBudget>,
    reads: Arc<AtomicUsize>,
}
impl WireCursor for Cursor {
    fn budget(&self) -> Option<Arc<dyn SourceBudget>> {
        Some(self.budget.clone())
    }
    fn next(&mut self) -> NextWire<'_> {
        Box::pin(async move {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.bytes.take().map(|bytes| WireChunk {
                bytes,
                item_start: true,
                item_end: true,
                message_index: 0,
                metadata: None,
            }))
        })
    }
}
fn opts() -> StreamOptions {
    StreamOptions {
        send_reasoning: true,
        cache_namespace: "anthropic".into(),
        tool_names: Default::default(),
        toolsets: Default::default(),
    }
}
fn identified(value: &String) -> IdentifiedText {
    IdentifiedText {
        text: TextSource {
            bytes: SourceBytes::Inline(Bytes::copy_from_slice(value.as_bytes())),
            encoding: TextEncoding::Utf8,
        },
        identity: Sha256::digest(value.as_bytes()).into(),
    }
}
#[tokio::test]
async fn source_overlay_keeps_the_original_upload_charge_until_the_last_slice() {
    let message = input::Message::Assistant {
        parts: vec![input::AssistantPart::ToolCall(input::ToolCall {
            id: "call".into(),
            name: "tool".into(),
            input: json!({"payload":"中"}),
            provider_executed: false,
            extensions: Some(std::collections::BTreeMap::from([(
                "anthropic".into(),
                json!({"caller":{"type":"code_execution_20250825","toolId":"source"},"cacheControl":{"type":"ephemeral"}}),
            )])),
        })],
        extensions: None,
    };
    let mut encoder = PreparedEncoder::new(opts());
    encoder.begin(&message).unwrap();
    let prepared = encoder.part(&message, 0).unwrap();
    let original = prepared.metadata;
    let source = original.map_sources(identified, |candidate| match candidate.directive() {
        Ok(value) => FrozenCacheCandidate::Valid(value),
        Err(_) => FrozenCacheCandidate::Invalid,
    });
    let part = Part::Source(Arc::new(source));
    let projection = part.projection();
    let mut prepass = MetadataPrepass::new(opts());
    prepass.push(0, &projection).unwrap();
    let mut replay = Replay::new(prepass.finish().context);
    replay.begin(0, &projection.message);
    let decision = replay.part(&projection, Selection::Normal).unwrap();
    let base: Vec<u8> = prepared.chunks.flatten().collect();
    let dropped = Arc::new(AtomicUsize::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let cursor = Cursor {
        bytes: Some(Bytes::from_owner(Owner {
            bytes: base.clone(),
            dropped: dropped.clone(),
        })),
        budget: Arc::new(Budget),
        reads: reads.clone(),
    };
    let mut payload = Payload::new(Box::new(cursor), &part, &decision);
    let mut output = Vec::new();
    let mut held = None;
    while let Some(bytes) = payload.next().await.unwrap() {
        output.extend_from_slice(&bytes);
        if held.is_none() && !bytes.is_empty() {
            held = Some(bytes)
        }
    }
    drop(payload);
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "an indexed block stops at its item boundary"
    );
    assert_eq!(
        dropped.load(Ordering::SeqCst),
        0,
        "last upload slice owns its source charge"
    );
    drop(held);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    let mut prepass = MetadataPrepass::new(opts());
    prepass.push(0, &original).unwrap();
    let mut replay = Replay::new(prepass.finish().context);
    replay.begin(0, &original.message);
    let decision = replay.part(&original, Selection::Normal).unwrap();
    let mut oracle = Overlay::new(&original, &decision);
    let expected = oracle.push(&base);
    oracle.finish().unwrap();
    assert_eq!(
        output, expected,
        "source caller fields preserve owned codec bytes and order"
    );
}

#[tokio::test]
async fn source_lanes_match_owned_request_bytes_across_signed_boundaries() {
    use crate::prompt::{AssistantPart, Message};
    use maka_agent_facts::model::ToolInput;
    let cache = Some(json!({"anthropic":{"cacheControl":{"type":"ephemeral"}}}));
    let messages = vec![
        Message::System {
            content: "system 中".into(),
            provider_options: cache.clone(),
        },
        Message::user("question"),
        Message::Assistant {
            content: vec![
                AssistantPart::ToolCall {
                    tool_call_id: "first".into(),
                    tool_name: "local".into(),
                    input: ToolInput::Json(json!({"z":"中","a":1})),
                    provider_executed: None,
                    provider_options: cache.clone(),
                },
                AssistantPart::Text {
                    text: "before ".into(),
                    provider_options: cache.clone(),
                },
                AssistantPart::Reasoning {
                    text: "signed reasoning".into(),
                    provider_options: Some(json!({"anthropic":{"signature":"signature-中"}})),
                },
                AssistantPart::ToolCall {
                    tool_call_id: "second".into(),
                    tool_name: "local".into(),
                    input: ToolInput::Json(json!({})),
                    provider_executed: None,
                    provider_options: cache,
                },
                AssistantPart::Text {
                    text: "  final 中\n".into(),
                    provider_options: Some(
                        json!({"anthropic":{"citations":[{"opaque":"untouched"}]}}),
                    ),
                },
            ],
            provider_options: None,
        },
    ];
    let actual = source_request_bytes(&messages).await;
    assert_eq!(actual, owned_request_bytes(messages));
}

async fn source_request_bytes(messages: &[crate::prompt::Message]) -> Vec<u8> {
    use crate::{
        ModelPreparationResources, PreparationPolicy, ProviderAuth, ProviderConfig, ProviderKind,
        native::wire::WireEncoding,
    };
    use futures_util::StreamExt;
    use maka_agent_facts::model::prompt_source::source::generated::GeneratedMessages;
    let provider = ProviderConfig {
        adapter: None,
        capabilities: Default::default(),
        network: Default::default(),
        kind: ProviderKind::Anthropic,
        model: "model".into(),
        base_url: "https://example.invalid".into(),
        auth: ProviderAuth::ApiKey("fixture".into()),
        headers: Default::default(),
        body_overlay: None,
    };
    let encoding =
        WireEncoding::new(Language::En, &provider, &serde_json::Value::Null, &[]).unwrap();
    let resources = ModelPreparationResources::new(PreparationPolicy {
        staging_bytes: 1024 * 1024,
        resident_bytes: 1024 * 1024,
        progress_bytes: 256 * 1024,
        work_bytes: 256 * 1024,
    })
    .unwrap();
    let frozen = encoding
        .prepare_source(Arc::new(GeneratedMessages::new(messages)), resources)
        .await
        .unwrap();
    let wire = PreparedWire {
        format: WireFormat::Anthropic,
        codec: encoding.codec().into(),
        identity: frozen.identity.into(),
        source: frozen.source,
    };
    let context = metadata(&wire, opts()).await.unwrap().context;
    let mut stream = body(json!({"model":"model"}), wire, context)
        .unwrap()
        .into_stream();
    let mut actual = Vec::new();
    while let Some(bytes) = stream.next().await {
        actual.extend_from_slice(&bytes.unwrap());
    }
    actual
}
fn owned_request_bytes(messages: Vec<crate::prompt::Message>) -> Vec<u8> {
    use maka_provider_protocol::anthropic::{
        CacheBudget,
        prompt::{PreparedPrompt, PromptOptions},
    };
    let input = crate::native::prompt::messages(messages).unwrap();
    let options = opts();
    let owned = PreparedPrompt::encode(
        &input,
        PromptOptions {
            send_reasoning: options.send_reasoning,
            cache_namespace: &options.cache_namespace,
            tool_names: &options.tool_names,
            toolsets: &options.toolsets,
        },
        &mut CacheBudget::default(),
    )
    .unwrap();
    let mut expected = json!({"model":"model"});
    for (key, value) in serde_json::to_value(owned).unwrap().as_object().unwrap() {
        expected
            .as_object_mut()
            .unwrap()
            .insert(key.clone(), value.clone());
    }
    serde_json::to_vec(&expected).unwrap()
}

#[tokio::test]
async fn indexed_caller_membership_preserves_present_sources_and_prunes_missing_sources() {
    use crate::prompt::{AssistantPart, Message};
    use maka_agent_facts::model::ToolInput;
    for present in [false, true] {
        let mut content = Vec::new();
        if present {
            content.push(AssistantPart::ToolCall {
                tool_call_id: "source".into(),
                tool_name: "code_execution".into(),
                input: ToolInput::Json(json!({})),
                provider_executed: Some(true),
                provider_options: None,
            });
        }
        content.push(AssistantPart::ToolCall{tool_call_id:"local".into(),tool_name:"local".into(),input:ToolInput::Json(json!({})),provider_executed:None,provider_options:Some(json!({"anthropic":{"caller":{"type":"code_execution_20250825","toolId":"source"}}}))});
        let messages = vec![
            Message::Assistant {
                content,
                provider_options: None,
            },
            Message::user("later user"),
        ];
        let actual = source_request_bytes(&messages).await;
        let value: serde_json::Value = serde_json::from_slice(&actual).unwrap();
        let local = value["messages"][0]["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|block| block["id"] == "local")
            .unwrap();
        assert_eq!(local.get("caller").is_some(), present);
        assert_eq!(actual, owned_request_bytes(messages));
    }
}
