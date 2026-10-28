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

//! Stream oversized summary options into the original request arena.
use super::*;
use crate::history::{
    capture_arena,
    serialize_source::{ArenaEmit, AsyncEmit},
};

fn check_cancel(context: &ProjectContext<'_>) -> io::Result<()> {
    if context.cancellation.is_cancelled() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "summary projection cancelled",
        ))
    } else {
        Ok(())
    }
}
async fn validate(
    text: &TextSource,
    state: &State,
    context: &ProjectContext<'_>,
) -> io::Result<bool> {
    let mut lengths =
        json::ArrayCursor::open(state.lengths.clone(), context.budget.clone()).await?;
    let mut raw = RawText::new(text, context).await?;
    while let Some(value) = lengths.next().await? {
        check_cancel(context)?;
        let Some(length) = number(&value, context).await? else {
            return Ok(false);
        };
        let Ok(length) = usize::try_from(length) else {
            return Ok(false);
        };
        let mut units = 0usize;
        while units < length {
            check_cancel(context)?;
            let Some(next) = raw.scalar().await? else {
                return Ok(false);
            };
            units = units.checked_add(next).ok_or_else(invalid)?;
        }
        if units != length {
            return Ok(false);
        }
    }
    Ok(raw.scalar().await?.is_none())
}
async fn emit(
    source: &SourceBytes,
    sink: &mut ArenaEmit,
    context: &ProjectContext<'_>,
) -> io::Result<()> {
    let mut cursor = source.open(context.budget.clone());
    let mut buffer = context.budget.allocate(4096).await?;
    loop {
        if context.cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "summary projection cancelled",
            ));
        }
        let read = cursor.read_chunk(buffer).await?;
        sink.write(&read.buffer.as_ref()[..read.bytes_read]).await?;
        buffer = read.buffer;
        if read.eof {
            return Ok(());
        }
        if read.bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "summary projection source made no progress",
            ));
        }
    }
}
pub(super) async fn project(
    text: &TextSource,
    state: State,
    context: &ProjectContext<'_>,
) -> io::Result<Option<Summary>> {
    if !validate(text, &state, context).await? {
        return Ok(None);
    }
    let arena = context
        .arena
        .ok_or_else(|| io::Error::other("oversized summary projection lacks its request arena"))?;
    let mut sink = ArenaEmit::new(arena.clone(), &context.budget, context.cancellation).await?;
    let start = sink.position();
    sink.write(br#"{"makaResponses":{"version":1,"profile":"#)
        .await?;
    emit(&state.profile.bytes, &mut sink, context).await?;
    sink.write(br#","itemId":"#).await?;
    emit(&state.id.bytes, &mut sink, context).await?;
    sink.write(br#","summaryPartLengths":"#).await?;
    emit(&state.lengths.bytes, &mut sink, context).await?;
    sink.write(br#"},"openResponses":{"itemId":"#).await?;
    emit(&state.id.bytes, &mut sink, context).await?;
    sink.write(br#","reasoningSummary":["#).await?;
    let mut lengths = json::ArrayCursor::open(state.lengths, context.budget.clone()).await?;
    let mut raw = RawText::new(text, context).await?;
    let mut first = true;
    while let Some(value) = lengths.next().await? {
        check_cancel(context)?;
        let length = usize::try_from(number(&value, context).await?.ok_or_else(invalid)?)
            .map_err(io::Error::other)?;
        let start = raw.position;
        let mut units = 0usize;
        while units < length {
            check_cancel(context)?;
            let next = raw.scalar().await?.ok_or_else(invalid)?;
            units = units.checked_add(next).ok_or_else(invalid)?;
        }
        if units != length {
            return Err(invalid());
        }
        if !first {
            sink.write(b",").await?;
        }
        sink.write(br#"{"type":"summary_text","text":""#).await?;
        emit(&text.bytes.slice(start..raw.position)?, &mut sink, context).await?;
        sink.write(br#""}"#).await?;
        first = false;
    }
    sink.write(br#"],"reasoningContent":null}}"#).await?;
    let end = sink.position();
    sink.finish().await?;
    Ok(Some(Summary {
        options: Some(JsonSource {
            bytes: arena.inspect(start..end),
        }),
        metadata_bytes: capture_arena::source_metadata_bytes(1)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{capture_arena::CaptureArena, measure_source};
    use maka_agent_facts::model::{PlaintextReasoningReplay, prompt_source::source::generated};
    use maka_capabilities::model_preparation::{ModelPreparationResources, PreparationPolicy};
    use maka_event_log::context::semantic::SemanticSelection;

    #[tokio::test]
    async fn streamed_summary_matches_indexed_projection_before_seal() {
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
        let arena = CaptureArena::new(captured.clone(), None).await.unwrap();
        let resources = ModelPreparationResources::new(PreparationPolicy::default()).unwrap();
        let work = resources.acquire_work().await.unwrap();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let contract = PlaintextResponses {
            reasoning_replay: PlaintextReasoningReplay::PlaintextSummary,
            compatibility: None,
        };
        let provider = ProviderKind::OpenResponses(contract);
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &provider,
            replay: None,
            captured: Some(&captured),
            payload_root: None,
            arena: Some(&arena),
            internal_arena: true,
            cancellation: &cancellation,
            budget: work.budget(),
            directory_owner: Arc::new(()),
        };
        let mut lengths = vec![3, 0, 1];
        lengths.extend(std::iter::repeat_n(0, 4096));
        let options = generated::json(&serde_json::json!({"makaResponses": {
            "version": 1, "profile": contract.profile(), "itemId": "rs_unicode",
            "summaryPartLengths": lengths,
        }}));
        let text = json::inspect(
            &generated::json(&serde_json::json!("想😀好")),
            context.budget.clone(),
        )
        .await
        .unwrap()
        .text()
        .unwrap();
        let mut ordinary = context.for_payload(None);
        ordinary.internal_arena = false;
        let expected = super::super::project(&text, &options, contract, true, &ordinary)
            .await
            .unwrap()
            .unwrap()
            .options
            .unwrap();
        let parsed_state = state(&options, contract, false, &context)
            .await
            .unwrap()
            .unwrap();
        let actual = project(&text, parsed_state, &context)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            actual.metadata_bytes,
            capture_arena::source_metadata_bytes(1).unwrap()
        );
        let mut expected_bytes = Vec::new();
        measure_source::raw_bytes(&expected.bytes, &context.budget, &cancellation, |bytes| {
            expected_bytes.extend_from_slice(bytes);
            Ok(())
        })
        .await
        .unwrap();
        let mut actual_bytes = Vec::new();
        measure_source::raw_bytes(
            &actual.options.unwrap().bytes,
            &context.budget,
            &cancellation,
            |bytes| {
                actual_bytes.extend_from_slice(bytes);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(actual_bytes, expected_bytes);
        let before = arena
            .with_writer(|writer| Ok(writer.position()))
            .await
            .unwrap();
        let invalid = generated::json(&serde_json::json!({"makaResponses": {
            "version": 1, "profile": contract.profile(), "itemId": "rs_invalid",
            "summaryPartLengths": [1, 1],
        }}));
        let emoji = json::inspect(
            &generated::json(&serde_json::json!("😀")),
            context.budget.clone(),
        )
        .await
        .unwrap()
        .text()
        .unwrap();
        let state = state(&invalid, contract, false, &context)
            .await
            .unwrap()
            .unwrap();
        assert!(project(&emoji, state, &context).await.unwrap().is_none());
        assert_eq!(
            arena
                .with_writer(|writer| Ok(writer.position()))
                .await
                .unwrap(),
            before
        );
        arena.close().await.unwrap();
        execution.finish();
    }
}
