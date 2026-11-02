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

async fn backed_prompt(
    fixture: &Fixture,
) -> (
    PreparedPrompt,
    crate::history::capture_arena::CaptureArena,
    maka_event_log::root_store::SessionExecutionLease,
) {
    let execution = fixture
        ._root
        .session("session")
        .await
        .unwrap()
        .execution_scope(None)
        .await
        .unwrap()
        .accept();
    let captured = execution
        .store()
        .capture_source(maka_event_log::context::semantic::SemanticSelection {
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
    let arena = crate::history::capture_arena::CaptureArena::new(captured, None)
        .await
        .unwrap();
    arena
        .with_writer(|builder| builder.append_bytes(b"frozen request backing"))
        .await
        .unwrap();
    let prompt = PreparedPrompt::new(maka_model::prompt::Prompt::from_messages(vec![
        maka_model::prompt::Message::user("request"),
    ]))
    .with_arena(arena.clone());
    (prompt, arena, execution)
}

#[tokio::test]
async fn item_acceptance_retires_before_pending_preparations() {
    let mut fixture = Fixture::new(Fault::None, false, true).await;
    let (prompt, arena, execution) = backed_prompt(&fixture).await;
    let observed_arena = arena.clone();
    let gates = fixture.gates.clone();
    let inner = fixture.inner.clone();
    let finalizer = fixture.finalizer.clone();
    let close_gate = Arc::new(Semaphore::new(0));
    let provider_gate = close_gate.clone();
    let mut preview = inner.attempts.subscribe();
    let observe = async move {
        gates.entered.acquire_many(2).await.unwrap().forget();
        let weak_cut = {
            let current = preview.borrow();
            let cut = current.as_ref().expect("provider still physically open");
            assert!(cut.revision > 0, "observe the current received cut");
            Arc::downgrade(cut)
        };
        provider_gate.add_permits(1);
        while preview.borrow().is_some() {
            preview.changed().await.unwrap();
        }
        assert!(
            observed_arena
                .with_writer(|builder| Ok(builder.position()))
                .await
                .is_err(),
            "retired prompt backing closes before tool approval resolves"
        );
        assert!(finalizer.terminal_confirmed());
        assert!(inner.attempts.unfinished().is_empty());
        assert!(weak_cut.upgrade().is_none());
        let stored = prefix(&inner.log).await;
        let terminal = stored
            .events
            .iter()
            .filter_map(|event| match &event.event.fact {
                Fact::ModelCompleted { output, .. } => Some(output),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].parts.len(), 2);
        assert!(
            terminal[0]
                .parts
                .iter()
                .all(|part| matches!(part, CompletionPart::Ref(_)))
        );
        assert_eq!(gates.effects.load(Ordering::SeqCst), 0);
        gates.release.add_permits(2);
    };
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let cancellation = CancellationToken::new();
    let mut retry = Some(RetryPrompt::Materialized(Box::new(prompt)));
    let mut progressed = false;
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            super::super::receive(
                &fixture.inner,
                fixture.writer.take().unwrap(),
                &fixture.finalizer,
                stream::ready_with_close_gate(events(false), close_gate).await,
                Some(request.into_step("step")),
                &mut progressed,
                &cancellation,
                &mut retry,
                None
            ),
            observe
        )
    })
    .await
    .expect("item-acceptance terminal must retire before gated preparations");
    assert!(matches!(result, Ok(AttemptOutput::Main(_))));
    assert!(retry.is_none());
    drop(arena);
    execution.finish();
    assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 2);
    assert_eq!(dispatches(&fixture.sink), 2);
}

#[tokio::test]
async fn unconfirmed_stream_cleanup_never_reports_model_completion() {
    let mut fixture = Fixture::new(Fault::None, false, true).await;
    let (prompt, arena, execution) = backed_prompt(&fixture).await;
    let mut retry = Some(RetryPrompt::Materialized(Box::new(prompt)));
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let result = super::super::receive(
        &fixture.inner,
        fixture.writer.take().unwrap(),
        &fixture.finalizer,
        stream::ready_with_cleanup_error(events(false)).await,
        Some(request.into_step("step")),
        &mut false,
        &CancellationToken::new(),
        &mut retry,
        None,
    )
    .await;
    assert!(
        result
            .err()
            .expect("cleanup failure must propagate")
            .is_cleanup_unconfirmed()
    );
    assert!(
        retry.is_some(),
        "original retry custody retains unconfirmed request backing"
    );
    assert_eq!(
        arena
            .with_writer(|builder| Ok(builder.position()))
            .await
            .unwrap(),
        b"frozen request backing".len() as u64
    );
    close_retry(&mut retry).await.unwrap();
    drop(arena);
    execution.finish();
    let stored = prefix(&fixture.inner.log).await;
    assert!(
        !stored
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ModelCompleted { .. }))
    );
    assert_eq!(
        stored
            .events
            .iter()
            .filter(|event| matches!(event.event.fact, Fact::ModelInterrupted { .. }))
            .count(),
        1
    );
    assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 0);
    assert_eq!(dispatches(&fixture.sink), 0);
}
