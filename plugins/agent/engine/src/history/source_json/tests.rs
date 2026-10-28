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
use maka_agent_facts::model::{
    merge_provider_options,
    prompt_source::source::{Allocate, ChargedBuffer},
};
use maka_capabilities::model_preparation::{ModelPreparationResources, PreparationPolicy};
use maka_event_log::{
    context::semantic::SemanticSelection,
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionExecutionLease},
};
use std::path::Path;

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
async fn captured(path: &Path) -> (RootStore, CapturedSource, SessionExecutionLease) {
    let root = RootStore::open(Arc::new(
        RootOwner::create(
            &path.join("root"),
            &RootNamespaces {
                ownership: path.join("owners"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    ))
    .await
    .unwrap();
    root.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let session = root.session("session").await.unwrap();
    let execution = session.execution_scope(None).await.unwrap().accept();
    let source = execution
        .store()
        .capture_source(SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through: 0,
            before: 1,
            captured_through: 0,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap();
    (root, source, execution)
}
async fn output(source: SourceBytes, budget: Arc<dyn SourceBudget>) -> Vec<u8> {
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(19).await.unwrap();
    let mut bytes = Vec::new();
    loop {
        let read = cursor.read_chunk(buffer).await.unwrap();
        bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
    }
    bytes
}
async fn merge(
    inputs: &[Option<&str>],
    resident: bool,
    collision: bool,
) -> (Vec<u8>, OptionsFootprint, u64) {
    merge_mode(inputs, resident, collision, false).await
}
async fn merge_mode(
    inputs: &[Option<&str>],
    resident: bool,
    collision: bool,
    spilled: bool,
) -> (Vec<u8>, OptionsFootprint, u64) {
    let directory = tempfile::tempdir().unwrap();
    let (root, captured, execution) = captured(directory.path()).await;
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
    let mut sources = Vec::new();
    let mut counts = JsonCounts::default();
    for input in inputs.iter().flatten() {
        let source = JsonSource {
            bytes: SourceBytes::Inline(input.as_bytes().to_vec().into()),
        };
        let next = json::measure(&source, budget.clone()).await.unwrap();
        counts.objects += next.objects;
        counts.arrays += next.arrays;
        counts.members += next.members;
        counts.elements += next.elements;
        counts.leaves += next.leaves;
        sources.push(source);
    }
    let input_bytes = sources
        .iter()
        .map(|source| source.bytes.len().unwrap())
        .sum();
    let plan = footprint(
        sources.len(),
        sources.len() * mem::size_of::<Root>(),
        counts,
        input_bytes,
    )
    .unwrap();
    let plan = if spilled {
        plan.spilled().unwrap()
    } else {
        plan
    };
    let capacity = if resident {
        plan.metadata_bytes + usize::try_from(plan.backing_bytes).unwrap() + 1
    } else {
        plan.metadata_bytes + 1
    };
    let resources = ModelPreparationResources::new(PreparationPolicy {
        staging_bytes: capacity,
        resident_bytes: capacity,
        progress_bytes: 256 * 1024,
        work_bytes: 256 * 1024,
    })
    .unwrap();
    let staged = resources.reserve_staging(capacity - 1).await.unwrap();
    let active = staged.promote(capacity).await.unwrap();
    let mut lease = active.directory(capacity - 1).unwrap();
    {
        let pending = resources.reserve_staging(1).await.unwrap().promote(1);
        tokio::pin!(pending);
        assert!(
            futures_util::poll!(pending.as_mut()).is_pending(),
            "the complete active envelope retains Full admission"
        );
    }
    let arena_lease = if resident {
        Some(
            lease
                .split(usize::try_from(plan.backing_bytes).unwrap())
                .unwrap(),
        )
    } else {
        assert!(
            plan.backing_bytes > capacity as u64,
            "the individual arena is oversized, not merely busy"
        );
        let oversized = resources.reserve_staging(1).await.unwrap();
        assert_eq!(
            oversized
                .promote(usize::try_from(plan.backing_bytes).unwrap())
                .await
                .unwrap_err()
                .kind(),
            stdio::ErrorKind::InvalidInput
        );
        None
    };
    let arena = CaptureArena::new(captured.clone(), arena_lease)
        .await
        .unwrap();
    let owner: Arc<dyn Send + Sync> = Arc::new(lease);
    let cancel = CancellationToken::new();
    let mut roots = RootBuilder::new(&plan, &arena, &cancel).await.unwrap();
    for source in sources {
        let node = roots.push(source, budget.clone(), &cancel).await.unwrap();
        if collision {
            let end = record::Node::decode(&io::read::<NODE_BYTES>(&arena, node).await.unwrap())
                .unwrap()
                .last;
            let mut at = node;
            while at <= end {
                let mut record =
                    record::Node::decode(&io::read::<NODE_BYTES>(&arena, at).await.unwrap())
                        .unwrap();
                record.digest = [0; 32];
                io::write(&arena, at, record.encode()).await.unwrap();
                at += NODE_BYTES as u64;
            }
        }
    }
    if spilled {
        assert_eq!(
            roots.resident_roots(),
            0,
            "oversized roots must not grow a fat-pointer registry"
        );
    }
    let source = finish_roots(
        roots.finish().unwrap(),
        &plan,
        &arena,
        budget.clone(),
        owner.clone(),
        &cancel,
    )
    .await
    .unwrap()
    .bytes;
    let used = io::position(&arena).await.unwrap();
    assert!(
        used <= plan.backing_bytes,
        "actual arena must fit structural precharge"
    );
    arena.seal().await.unwrap();
    let first = output(source.clone(), budget.clone()).await;
    assert_eq!(
        first,
        output(source.clone(), budget.clone()).await,
        "reopen must retain the same frozen result"
    );
    if first.len() > 2 {
        assert_eq!(
            output(source.slice(1..first.len() as u64 - 1).unwrap(), budget).await,
            &first[1..first.len() - 1]
        );
    }
    drop(source);
    drop(owner);
    drop(active);
    arena.close().await.unwrap();
    drop(arena);
    drop(captured);
    execution.finish();
    root.shutdown().await.unwrap();
    (first, plan, used)
}
fn oracle(inputs: &[Option<&str>]) -> serde_json::Value {
    let mut output = None;
    for input in inputs {
        merge_provider_options(
            &mut output,
            input.map(|json| serde_json::from_str(json).unwrap()),
        );
    }
    output.unwrap()
}
async fn agrees(inputs: &[Option<&str>], resident: bool, collision: bool) {
    let (bytes, _, _) = merge(inputs, resident, collision).await;
    let expected = oracle(inputs);
    let actual: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        actual.to_string(),
        expected.to_string(),
        "recursive overlay and preserve_order must match"
    );
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
    let actual = json::measure(
        &JsonSource {
            bytes: SourceBytes::Inline(bytes.into()),
        },
        budget.clone(),
    )
    .await
    .unwrap();
    let expected = json::measure(
        &JsonSource {
            bytes: SourceBytes::Inline(expected.to_string().into_bytes().into()),
        },
        budget,
    )
    .await
    .unwrap();
    assert_eq!(
        actual.members, expected.members,
        "output objects must have unique decoded keys"
    );
}

#[tokio::test]
async fn duplicate_fields_replace_whole_value_then_layers_overlay_and_reset() {
    agrees(
        &[
            Some(r#"{"x":{"a":1},"x":{"b":2},"a":1,"tail":3,"\u0061":4}"#),
            None,
            Some(r#"{"x":{"c":3},"tail":null}"#),
        ],
        true,
        false,
    )
    .await;
    agrees(
        &[
            Some(r#"{"first":1,"x":{"old":1,"y":2},"last":3}"#),
            Some(r#"{"x":null}"#),
            Some(r#"{"x":{"fresh":4}}"#),
            Some(r#"{"x":{}}"#),
        ],
        true,
        false,
    )
    .await;
    agrees(
        &[
            Some(r#"{"x":1}"#),
            Some("[1,{\"x\":1,\"x\":{\"b\":2}}]"),
            Some(r#"{"z":true}"#),
        ],
        true,
        false,
    )
    .await;
}
#[tokio::test]
async fn arrays_replace_and_normalize_nested_duplicate_objects() {
    agrees(
        &[
            Some(r#"{"a":[1,2],"b":3}"#),
            Some(r#"{"a":[{"k":{"a":1},"k":{"b":2}}]}"#),
        ],
        true,
        false,
    )
    .await;
}
#[tokio::test]
async fn digest_collisions_still_compare_actual_unicode_keys() {
    agrees(
        &[
            Some(r#"{"z":1,"a":2,"\u0061":3,"中":4}"#),
            Some(r#"{"b":5,"z":{"t":true},"中":null}"#),
        ],
        true,
        true,
    )
    .await;
}
#[tokio::test]
async fn many_fields_merge_in_the_one_file_arena() {
    let first = format!(
        "{{{}}}",
        (0..320)
            .map(|index| format!("\"k{index:03}\":{index}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let second = r#"{"k010":{"opaque":{"signature":"keep"}},"new":true}"#;
    agrees(&[Some(&first), Some(second)], false, false).await;
}
#[tokio::test]
async fn giant_leaf_does_not_increase_resident_directory_or_copy_into_arena() {
    let small = r#"{"a":{"b":{"signature":"q"}}}"#;
    let large = format!(
        "{{\"a\":{{\"b\":{{\"signature\":\"{}\"}}}}}}",
        "q".repeat(300_000)
    );
    let (_, small_plan, small_used) = merge(&[Some(small)], true, false).await;
    let (bytes, large_plan, large_used) = merge(&[Some(&large)], true, false).await;
    assert_eq!(small_plan.metadata_bytes, large_plan.metadata_bytes);
    assert_eq!(small_plan.backing_bytes, large_plan.backing_bytes);
    assert_eq!(
        small_used, large_used,
        "opaque leaf bytes must not enter the request arena"
    );
    assert_eq!(bytes, large.as_bytes());
}

#[tokio::test]
async fn oversized_root_registry_uses_numeric_arena_roots_and_contiguous_output() {
    let layers: Vec<String> = (0..320)
        .map(|index| format!("{{\"shared\":{{\"v\":{index}}},\"kept\":true}}"))
        .collect();
    let inputs: Vec<Option<&str>> = layers.iter().map(|value| Some(value.as_str())).collect();
    let (bytes, plan, _) = merge_mode(&inputs, false, false, true).await;
    let expected = oracle(&inputs);
    let actual: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(actual.to_string(), expected.to_string());
    assert_eq!(plan.roots_metadata_bytes, 0);
    let (_, single_plan, _) = merge_mode(&[inputs[0]], false, false, true).await;
    assert_eq!(
        plan.metadata_bytes, single_plan.metadata_bytes,
        "root count must not expand resident authority storage"
    );
    assert!(
        plan.backing_bytes > single_plan.backing_bytes,
        "numeric records and copied options remain charged to the one arena"
    );
}
