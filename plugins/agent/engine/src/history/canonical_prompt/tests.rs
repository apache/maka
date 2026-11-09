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
use crate::history::preparation_io::PreparationIo;
use maka_capabilities::model_preparation::PreparationPolicy;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionWorkLease, WorkEffects},
};
use serde_json::json;
struct Fixture {
    root: RootStore,
    io: PreparationIo,
    execution: SessionWorkLease,
    effects: WorkEffects,
}
impl Fixture {
    async fn new(path: &std::path::Path) -> Self {
        let namespaces = RootNamespaces {
            ownership: path.join("owners"),
            control: path.join("control"),
        };
        let root = RootStore::open(
            Arc::new(RootOwner::create(&path.join("root"), &namespaces).unwrap()),
            &crate::history::test_support::catalog(),
        )
        .await
        .unwrap();
        root.create_session("session", "create", &json!({}), 1)
            .await
            .unwrap();
        let session = root.session("session").await.unwrap();
        let (execution, effects) = session
            .work_scope(None)
            .await
            .unwrap()
            .accept(CancellationToken::new());
        let io = PreparationIo::new(&execution.store()).unwrap();
        Self {
            root,
            io,
            execution,
            effects,
        }
    }
    async fn finish(self) {
        drop(self.io);
        self.effects.settle().await.unwrap();
        self.execution.finish();
        self.root.shutdown().await.unwrap();
    }
    async fn builder(&self, resources: &ModelPreparationResources) -> (CaptureArena, Builder) {
        let staged = resources
            .reserve_staging(Builder::resident_bytes() + 4096)
            .await
            .unwrap();
        let arena = CaptureArena::new(self.io.clone(), None).await.unwrap();
        let builder = Builder::new(
            arena.clone(),
            resources.clone(),
            RequestPreparation::new(staged),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        (arena, builder)
    }
}
fn resources() -> ModelPreparationResources {
    ModelPreparationResources::new(PreparationPolicy {
        staging_bytes: 64 * 1024,
        resident_bytes: 64 * 1024,
        progress_bytes: 256 * 1024,
        work_bytes: 256 * 1024,
    })
    .unwrap()
}
async fn message(recipe: &MessageRecipe, budget: &Arc<dyn SourceBudget>) -> Message {
    let mut bytes = Vec::new();
    super::super::serialize_source::exact_message(
        recipe,
        budget,
        &CancellationToken::new(),
        &mut |chunk| {
            bytes.extend_from_slice(chunk);
            Ok(())
        },
    )
    .await
    .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
#[tokio::test]
async fn canonical_media_options_signatures_custom_inputs_and_opaque_items_roundtrip() {
    let path = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(path.path()).await;
    let resources = resources();
    let (arena, mut builder) = fixture.builder(&resources).await;
    let expected:Vec<Message>=serde_json::from_value(json!([
        {"role":"system","content":"规则\n\"escaped\"","providerOptions":{"cache":{"opaque":true}}},
        {"role":"user","content":[
            {"type":"text","text":"look"},
            {"type":"file","mediaType":"image/png","data":{"type":"data","data":"AAECAwQF"},"providerOptions":{"openai":{"imageDetail":"high"}}},
            {"type":"file","mediaType":"audio/wav","data":{"type":"data","data":"BgcICQ=="}}
        ]},
        {"role":"assistant","providerOptions":{"opaque":[1,null,"x"]},"content":[
            {"type":"reasoning","text":"thought","providerOptions":{"anthropic":{"signature":"signed+/="}}},
            {"type":"codex-compaction","item":{"type":"compaction","encrypted_content":"opaque+/=","future":{"x":[1,false]}}},
            {"type":"tool-call","toolCallId":"custom-1","toolName":"exec","input":{"kind":"json","data":"echo \"hi\"\n"},"providerOptions":{"openai":{"toolKind":"custom"}}},
            {"type":"tool-call","toolCallId":"bad-1","toolName":"run","input":{"kind":"invalid_json","data":{"raw":" {not json\n"}},"providerExecuted":false}
        ]},
        {"role":"tool","content":[{"type":"tool-result","toolCallId":"custom-1","toolName":"exec","output":{"type":"content","value":[
            {"type":"text","text":"done"},
            {"type":"file","mediaType":"audio/mpeg","data":{"type":"data","data":"CgsM"}}
        ]},"providerOptions":{"openai":{"toolKind":"custom"}}}]},
        {"role":"tool","content":[{"type":"tool-result","toolCallId":"custom-1","toolName":"exec","output":{"type":"text","value":"notification"},"providerOptions":{"maka":{"notification":true}}}]}
    ])).unwrap();
    for value in &expected {
        builder.append(value.clone()).await.unwrap();
    }
    let captured = builder.finish_captured().await.unwrap();
    let source = captured.prompt.recipes().unwrap();
    // Hold the entire progress allowance: indexed metadata and recipe opening
    // must not recursively admit another codec envelope.
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let mut cursor = source.open(0);
    for expected in &expected {
        assert_eq!(
            &message(&cursor.next().await.unwrap().unwrap(), &budget).await,
            expected
        );
    }
    assert!(cursor.next().await.unwrap().is_none());
    let metadata = source.open_metadata(2).next().await.unwrap().unwrap();
    assert_eq!(metadata.local_tool_names.len(), 2);
    assert_eq!(
        source
            .open_metadata(4)
            .next()
            .await
            .unwrap()
            .unwrap()
            .settled_tool_call_ids
            .len(),
        0
    );
    assert_eq!(
        source.prefix_identity(expected.len()).await.unwrap(),
        captured.layout.identity
    );
    assert_eq!(
        message(&source.open(3).next().await.unwrap().unwrap(), &budget).await,
        expected[3]
    );
    drop((metadata, cursor, budget, work, captured));
    arena.close().await.unwrap();
    drop(arena);
    fixture.finish().await;
}
#[tokio::test]
async fn streaming_snapshot_restore_and_refreeze_do_not_need_original_source() {
    let path = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(path.path()).await;
    let resources = resources();
    let (arena, mut builder) = fixture.builder(&resources).await;
    let expected = Message::user("retained");
    builder.append(expected.clone()).await.unwrap();
    let captured = builder.finish_captured().await.unwrap();
    let layout: Layout =
        serde_json::from_slice(&serde_json::to_vec(&captured.layout).unwrap()).unwrap();
    let cold = CaptureArena::new(fixture.io.clone(), None).await.unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    assert_eq!(
        cold.append(
            captured.bytes.clone(),
            budget.clone(),
            &CancellationToken::new()
        )
        .await
        .unwrap(),
        0..layout.byte_len
    );
    drop((budget, work, captured));
    arena.close().await.unwrap();
    drop(arena);
    let restored = restore(cold.clone(), resources.clone(), layout)
        .await
        .unwrap();
    let (refrozen_arena, mut refrozen) = fixture.builder(&resources).await;
    refrozen
        .append_recipe(
            &restored
                .recipes()
                .unwrap()
                .open(0)
                .next()
                .await
                .unwrap()
                .unwrap(),
        )
        .await
        .unwrap();
    let refrozen = refrozen.finish().await.unwrap();
    drop(restored);
    cold.close().await.unwrap();
    drop(cold);
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    assert_eq!(
        message(
            &refrozen
                .recipes()
                .unwrap()
                .open(0)
                .next()
                .await
                .unwrap()
                .unwrap(),
            &budget
        )
        .await,
        expected
    );
    drop((refrozen, budget, work));
    refrozen_arena.close().await.unwrap();
    drop(refrozen_arena);
    fixture.finish().await;
}
#[tokio::test]
async fn logical_input_and_tool_metadata_can_exceed_resident_and_staging_allowances() {
    let path = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(path.path()).await;
    let resources = resources();
    let (arena, mut builder) = fixture.builder(&resources).await;
    for _ in 0..32 {
        builder
            .append(Message::user("x".repeat(4096)))
            .await
            .unwrap();
    }
    let calls=(0..512).map(|i|json!({"type":"tool-call","toolCallId":format!("id-{i}"),"toolName":format!("tool-{i}"),"input":{"kind":"json","data":{}},"providerExecuted":false})).collect::<Vec<_>>();
    builder
        .append(serde_json::from_value(json!({"role":"assistant","content":calls})).unwrap())
        .await
        .unwrap();
    let captured = builder.finish_captured().await.unwrap();
    assert!(captured.layout.byte_len > resources.policy().resident_bytes as u64);
    assert!(captured.resident_bytes < resources.policy().resident_bytes);
    let source = captured.prompt.recipes().unwrap();
    assert_eq!(source.len(), 33);
    let metadata = source.open_metadata(32).next().await.unwrap().unwrap();
    assert_eq!(metadata.local_tool_names.len(), 512);
    assert!(
        metadata
            .local_tool_names
            .open(511)
            .next()
            .await
            .unwrap()
            .is_some()
    );
    drop((metadata, captured));
    arena.close().await.unwrap();
    drop(arena);
    fixture.finish().await;
}

#[tokio::test]
async fn recipe_capture_streams_large_media_options_and_rejects_nonobject_merge_targets() {
    let path = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(path.path()).await;
    let resources = resources();
    let (arena, mut builder) = fixture.builder(&resources).await;
    let opaque = "v".repeat(128 * 1024);
    let options = json!({"opaque":opaque,"openai":{"imageDetail":"low","other":{"keep":true}}});
    let recipe = MessageRecipe::User {
        content: Arc::new(generated::GeneratedRecipes::new(vec![
            ContentRecipe::Media {
                media: MediaSource {
                    bytes: SourceBytes::Inline(bytes::Bytes::from_static(b"raw-media")),
                    media_type: generated::text("image/png"),
                    detail: Some(generated::text("high")),
                },
                provider_options: Some(JsonSource::new(SourceBytes::Inline(bytes::Bytes::from(
                    options.to_string(),
                )))),
            },
        ])),
        provider_options: None,
    };
    builder.append_recipe(&recipe).await.unwrap();
    let prompt = builder.finish().await.unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let actual = message(
        &prompt
            .recipes()
            .unwrap()
            .open(0)
            .next()
            .await
            .unwrap()
            .unwrap(),
        &budget,
    )
    .await;
    let actual = serde_json::to_value(actual).unwrap();
    assert_eq!(
        actual["content"][0]["providerOptions"],
        json!({"opaque":opaque,"openai":{"imageDetail":"high","other":{"keep":true}}})
    );
    for options in [json!(false), json!({"openai":[]})] {
        let bad = MessageRecipe::User {
            content: Arc::new(generated::GeneratedRecipes::new(vec![
                ContentRecipe::Media {
                    media: MediaSource {
                        bytes: SourceBytes::Inline(bytes::Bytes::new()),
                        media_type: generated::text("image/png"),
                        detail: Some(generated::text("high")),
                    },
                    provider_options: Some(JsonSource::new(SourceBytes::Inline(
                        bytes::Bytes::from(options.to_string()),
                    ))),
                },
            ])),
            provider_options: None,
        };
        let error = super::super::serialize_source::exact_message(
            &bad,
            &budget,
            &CancellationToken::new(),
            &mut |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
    drop((actual, recipe, prompt, budget, work));
    arena.close().await.unwrap();
    drop(arena);
    fixture.finish().await;
}
