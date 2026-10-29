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

async fn completion_writer(fixture: &Fixture) -> AttemptWriter {
    let initial = fixture.finalizer.snapshot();
    fixture.inner.attempts.remove("step");
    let mut requested = prefix(&fixture.inner.log)
        .await
        .events
        .into_iter()
        .find_map(|event| match event.event.fact {
            fact @ Fact::ModelRequested { .. } => Some(fact),
            _ => None,
        })
        .unwrap();
    if let Fact::ModelRequested {
        item_acceptance,
        step_id,
        ..
    } = &mut requested
    {
        *item_acceptance = false;
        *step_id = "completion-step".into();
    }
    let sequence = fixture
        .inner
        .log
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                initial.binding.invocation.clone(),
                requested,
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut binding = initial.binding.clone();
    binding.step_id = "completion-step".into();
    let mut writer = AttemptWriter::new(binding, false).unwrap();
    writer.fenced(sequence);
    for event in events(false) {
        writer.push(event, std::time::SystemTime::now()).unwrap();
    }
    writer
}

async fn completion_retires_before_pending_preparations(all_pending: bool) {
    let fixture = Fixture::new(Fault::None, !all_pending, all_pending).await;
    let writer = completion_writer(&fixture).await;
    let part = Arc::downgrade(&writer.completed().unwrap().parts()[0].part);
    let cut = writer.snapshot();
    let weak_cut = Arc::downgrade(&cut);
    let finalizer = fixture.inner.attempts.register(cut, false);
    let mut preview = fixture.inner.attempts.subscribe();
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let (prompt, arena, execution) = backed_prompt(&fixture).await;
    let observe = async {
        if all_pending {
            fixture
                .gates
                .entered
                .acquire_many(2)
                .await
                .unwrap()
                .forget();
            while preview.borrow().is_some() {
                preview.changed().await.unwrap();
            }
            assert_eq!(dispatches(&fixture.sink), 0);
        } else {
            fixture.gates.effect.acquire().await.unwrap().forget();
            let mut batches = fixture.sink.batches.lock().unwrap();
            let first = &batches[0];
            assert!(matches!(
                &first.last().unwrap().event().fact,
                Fact::ToolDispatched { operation_id, .. }
                    if operation_id.ends_with(":call-1")
            ));
            assert!(matches!(
                &first[0].event().fact,
                Fact::ModelCompleted { step_id, .. } if step_id == "completion-step"
            ));
            // The sink's recording is an explicit external consumer of the prefix.
            batches.clear();
        }
        assert!(
            arena
                .with_writer(|builder| Ok(builder.position()))
                .await
                .is_err(),
            "confirmed terminal closes original prompt backing before tool drain"
        );
        assert!(finalizer.terminal_confirmed());
        assert!(fixture.inner.attempts.unfinished().is_empty());
        assert!(preview.borrow().is_none());
        assert!(weak_cut.upgrade().is_none(), "registered preview retired");
        assert!(
            part.upgrade().is_none(),
            "no pending sibling retains Own body"
        );
        let stored = prefix(&fixture.inner.log).await;
        let completions = stored
            .events
            .iter()
            .filter_map(|event| match &event.event.fact {
                Fact::ModelCompleted { step_id, output } if step_id == "completion-step" => {
                    Some(output)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].parts.len(), 2);
        assert_eq!(completions[0].finish_reason, ModelFinishReason::ToolCalls);
        for (n, part) in completions[0].parts.iter().enumerate() {
            let CompletionPart::Own(record) = part else {
                panic!("completion-only terminal retains canonical Own records");
            };
            assert_eq!(record.ordinal, n as u64);
            assert!(matches!(record.part.as_ref(), ModelPart::ToolCall { call }
                if call.id == format!("call-{n}") && call.input == json!({"n": n}).into()));
        }
        fixture
            .gates
            .release
            .add_permits(if all_pending { 2 } else { 1 });
    };
    let cancellation = CancellationToken::new();
    let mut retry = Some(prompt);
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            finish(
                &fixture.inner,
                writer,
                &finalizer,
                Ok(()),
                &cancellation,
                Some(&request),
                &mut retry,
            ),
            observe,
        )
    })
    .await
    .expect("model terminal must retire before pending preparation resumes");
    assert!(matches!(result, Ok(AttemptOutput::Main(_))));
    assert!(retry.is_none());
    drop(arena);
    execution.finish();
    assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 2);
    assert_eq!(
        prefix(&fixture.inner.log)
            .await
            .events
            .iter()
            .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
            .count(),
        2,
    );
    assert!(
        fixture.sink.batches.lock().unwrap().iter().all(|batch| {
            batch[..batch.len() - 1]
                .iter()
                .all(|write| !matches!(write.event().fact, Fact::ModelCompleted { .. }))
        }),
        "later siblings publish no terminal prefix"
    );
}

#[tokio::test]
async fn completion_ready_sibling_retires_model_body_before_slow_first_prepare() {
    completion_retires_before_pending_preparations(false).await;
}

#[tokio::test]
async fn completion_all_pending_retires_model_body_before_any_t1() {
    completion_retires_before_pending_preparations(true).await;
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
    let mut retry = Some(prompt);
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
    let mut retry = Some(prompt);
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

#[tokio::test]
async fn completion_unknown_t1_retains_original_terminal_without_starting_effects() {
    for fault in [Fault::CommittedUnknown, Fault::UncommittedUnknown] {
        let fixture = Fixture::new(fault, false, false).await;
        let writer = completion_writer(&fixture).await;
        let cut = writer.snapshot();
        let weak_cut = Arc::downgrade(&cut);
        let finalizer = fixture.inner.attempts.register(cut, false);
        let request = fixture
            .tools
            .capture(".", CancellationToken::new())
            .await
            .unwrap();
        let result = finish(
            &fixture.inner,
            writer,
            &finalizer,
            Ok(()),
            &CancellationToken::new(),
            Some(&request),
            &mut None,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 0);
        assert_eq!(dispatches(&fixture.sink), 1);
        assert!(!finalizer.terminal_confirmed());
        assert!(
            weak_cut.upgrade().is_some(),
            "unknown terminal retains its original body cut"
        );
        let original = finalizer
            .publication()
            .expect("unknown retains exact terminal write");
        let submitted = fixture.sink.batches.lock().unwrap()[0].clone();
        assert_eq!(original.event(), submitted[0].event());
        let stored = prefix(&fixture.inner.log).await;
        let canonical = stored.events.iter().filter(|event| matches!(&event.event.fact, Fact::ModelCompleted { step_id, .. } if step_id == "completion-step")).collect::<Vec<_>>();
        assert_eq!(
            canonical.len(),
            usize::from(matches!(fault, Fault::CommittedUnknown))
        );
        if let Some(terminal) = canonical.first() {
            assert_eq!(&terminal.event, original.event());
        }
        let sealed =
            seal_finalizer(&fixture.inner, &finalizer, crate::cleanup::unconfirmed()).await;
        assert!(sealed.is_cleanup_unconfirmed());
        assert!(finalizer.terminal_confirmed());
        let after = prefix(&fixture.inner.log).await;
        assert_eq!(
            after
                .events
                .iter()
                .filter(|event| event.event.id == original.event().id)
                .count(),
            1
        );
        assert_eq!(
            after
                .events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
                .count(),
            usize::from(matches!(fault, Fault::CommittedUnknown))
        );
        assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 0);
        assert_eq!(
            dispatches(&fixture.sink),
            1,
            "terminal confirmation never resubmits T1"
        );
    }
}
