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
use crate::history::arena_recipes::ArenaRecipes;
use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    model::prompt_source::source::{Allocate, json},
};
use maka_event_log::context::semantic::SemanticSelection;
use sha2::Digest;

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
async fn read(source: SourceBytes, budget: Arc<dyn SourceBudget>) -> Vec<u8> {
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(127).await.unwrap();
    let mut result = Vec::new();
    loop {
        let chunk = cursor.read_chunk(buffer).await.unwrap();
        result.extend_from_slice(&chunk.buffer.as_ref()[..chunk.bytes_read]);
        buffer = chunk.buffer;
        if chunk.eof {
            return result;
        }
    }
}

#[tokio::test]
async fn numeric_leaves_preserve_original_ranges_derived_bytes_and_capture_domain() {
    let (_directory, root) = crate::test_support::root().await;
    let session = crate::test_support::session(&root, "session").await;
    let execution = session.execution_scope(None).await.unwrap().accept();
    let log = execution.store();
    let expected = "canonical 世界\n".repeat(4096);
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: expected.clone().into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    let selection = log
        .read_model_view("session", None)
        .await
        .unwrap()
        .selection;
    let captured = log.capture_source(selection.clone()).await.unwrap();
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
    let mut page = captured
        .metadata_page(None, ChargedBuffer::new(vec![0; 1024], ()))
        .await
        .unwrap();
    let row = page.row(0).unwrap();
    let payload = captured.describe_payload(&row).unwrap().unwrap();
    let source = JsonSource::new(SourceBytes::Source(captured.byte_source(&payload).unwrap()));
    let original = json::field(&source, &["User", "text"], budget.clone())
        .await
        .unwrap()
        .unwrap()
        .source;
    let text_measure = DecodedTextMeasure {
        bytes: expected.len() as u64,
        sha256: sha2::Sha256::digest(expected.as_bytes()).into(),
    };
    let original = TextSource::measured(
        original.into_bytes(),
        TextEncoding::JsonString,
        text_measure,
    );
    let json_bytes = serde_json::to_vec(&serde_json::json!({"value": 1})).unwrap();
    let json_measure = RawJsonMeasure {
        bytes: json_bytes.len() as u64,
        sha256: sha2::Sha256::digest(&json_bytes).into(),
    };
    let measured_json = JsonSource::measured(SourceBytes::Inline(json_bytes.into()), json_measure);
    let unknown_json = JsonSource::new(SourceBytes::Inline(b"null".as_slice().into()));
    let foreign_capture = log.capture_source(selection).await.unwrap();
    let foreign_payload = foreign_capture
        .metadata_page(None, ChargedBuffer::new(vec![0; 1024], ()))
        .await
        .unwrap()
        .row(0)
        .unwrap();
    let foreign = SourceBytes::Source(
        foreign_capture
            .byte_source(&foreign_capture.metadata_source(&foreign_payload).unwrap())
            .unwrap(),
    );
    let other_arena = CaptureArena::new(captured.clone(), None).await.unwrap();
    let arena = CaptureArena::new(captured.clone(), None).await.unwrap();
    let cancel = CancellationToken::new();
    let store = ArenaRecipes::new(arena.clone(), Arc::new(()));
    let text_node = store
        .text(original.clone(), budget.clone(), &cancel)
        .await
        .unwrap();
    let json_node = store
        .json(Some(measured_json), budget.clone(), &cancel)
        .await
        .unwrap();
    let unknown_json_node = store
        .json(Some(unknown_json), budget.clone(), &cancel)
        .await
        .unwrap();
    let numeric_bytes = arena
        .with_writer(|writer| Ok(writer.position()))
        .await
        .unwrap();
    assert!(
        numeric_bytes < expected.len() as u64,
        "directory must retain canonical ranges rather than their bodies"
    );
    let mut sliced = original
        .bytes()
        .slice(1..original.bytes().len().unwrap() - 1)
        .unwrap();
    let range = arena
        .retain_source(sliced.clone(), budget.clone(), &cancel)
        .await
        .unwrap();
    sliced = arena.restore_source(range, true).unwrap();
    let quoted = serde_json::to_vec(&expected).unwrap();
    assert_eq!(
        read(sliced, budget.clone()).await,
        &quoted[1..quoted.len() - 1]
    );
    assert!(
        arena
            .retain_source(foreign, budget.clone(), &cancel)
            .await
            .is_err()
    );
    assert!(
        arena
            .retain_source(other_arena.inspect(0..0), budget.clone(), &cancel)
            .await
            .is_err()
    );
    other_arena.close().await.unwrap();
    drop(other_arena);
    let derived = text::bytes(original, budget.clone());
    let derived_record = arena
        .retain_source(derived, budget.clone(), &cancel)
        .await
        .unwrap();
    let once = arena
        .with_writer(|writer| Ok(writer.position()))
        .await
        .unwrap();
    let derived = arena.restore_source(derived_record, true).unwrap();
    let reused = arena
        .retain_source(derived.clone(), budget.clone(), &cancel)
        .await
        .unwrap();
    assert_eq!(
        arena
            .with_writer(|writer| Ok(writer.position()))
            .await
            .unwrap(),
        once,
        "already materialized derived ranges must not be copied again"
    );
    assert_eq!(
        read(arena.restore_source(reused, true).unwrap(), budget.clone()).await,
        expected.as_bytes()
    );
    assert_eq!(read(derived, budget.clone()).await, expected.as_bytes());
    arena.seal().await.unwrap();
    let restored = store.read_text(text_node).await.unwrap();
    assert_eq!(restored.measure(), Some(text_measure));
    assert_eq!(
        store.read_json(json_node).await.unwrap().unwrap().measure(),
        Some(json_measure)
    );
    assert_eq!(
        store
            .read_json(unknown_json_node)
            .await
            .unwrap()
            .unwrap()
            .measure(),
        None
    );
    assert_eq!(
        read(text::bytes(restored, budget.clone()), budget.clone()).await,
        expected.as_bytes()
    );
    assert_eq!(
        read(
            store
                .read_json(json_node)
                .await
                .unwrap()
                .unwrap()
                .into_bytes(),
            budget.clone()
        )
        .await,
        serde_json::to_vec(&serde_json::json!({"value": 1})).unwrap()
    );
    let surviving = store.read_text(text_node).await.unwrap();
    drop(source);
    drop(page);
    drop(row);
    drop(payload);
    drop(captured);
    drop(foreign_capture);
    drop(store);
    arena.close().await.unwrap();
    drop(arena);
    assert_eq!(
        read(text::bytes(surviving, budget.clone()), budget).await,
        expected.as_bytes(),
        "original immutable body outlives the request arena file"
    );
    drop(log);
    execution.finish();
    root.shutdown().await.unwrap();
}

struct Failure;
impl ByteSource for Failure {
    fn len(&self) -> Option<u64> {
        Some(1)
    }
    fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Failure)
    }
}
impl ByteCursor for Failure {
    fn read_chunk(&mut self, _: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "derived source denied",
            ))
        })
    }
}
#[tokio::test]
async fn unknown_derived_source_keeps_its_read_error() {
    let (_directory, root) = crate::test_support::root().await;
    let session = crate::test_support::session(&root, "session").await;
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
    let arena = CaptureArena::new(source, None).await.unwrap();
    let error = arena
        .retain_source(
            SourceBytes::Source(Arc::new(Failure)),
            Arc::new(Budget),
            &CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(error.to_string(), "derived source denied");
    arena.close().await.unwrap();
    drop(arena);
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn final_arena_bytes_keep_original_read_custody() {
    let (_directory, root) = crate::test_support::root().await;
    let session = crate::test_support::session(&root, "session").await;
    let execution = session.execution_scope(None).await.unwrap().accept();
    let captured = execution
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
    let arena = CaptureArena::new(captured, None).await.unwrap();
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
    let range = arena
        .append(
            SourceBytes::Inline(b"derived".to_vec().into()),
            budget.clone(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let source = arena.inspect(range);
    let mut cursor = source.open(budget.clone());
    let read = cursor
        .read_chunk(budget.allocate(16).await.unwrap())
        .await
        .unwrap();
    let bytes = read.buffer.into_bytes(read.bytes_read);
    drop(cursor);
    drop(source);
    arena.close().await.unwrap();
    drop(arena);
    execution.finish();
    assert_eq!(bytes.as_ref(), b"derived");
    let mut shutdown = Box::pin(root.shutdown());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    drop(bytes);
    shutdown.await.unwrap();
}
