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

mod stream;

use super::*;
use maka_agent_facts::{
    event::{
        CommitError, CommitFuture, EventSink, EventWrite, Invocation, InvocationInput, LogScope,
        PrefixCommitFuture, PrefixReceipt, RuntimeEvent,
    },
    execution::ToolMode,
    language::Language,
    model::{ModelEvent, ModelFinishReason, ModelToolCall, recorded::CompletionPart},
    tools::{PreparationFuture, PreparedEffect, ToolCallContext, ToolPreparer},
};
use maka_tools::{
    CodeExecutor, RunTools, ToolCatalog, ToolDefinition, ToolHandler, ToolNesting,
    ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;

#[derive(Clone, Copy)]
enum Fault {
    None,
    CommittedUnknown,
    UncommittedUnknown,
}

struct Sink {
    log: Arc<maka_event_log::root_store::SessionStore>,
    fault: Fault,
    batches: Mutex<Vec<Vec<EventWrite>>>,
}
impl EventSink for Sink {
    fn commit(self: Arc<Self>, write: EventWrite) -> CommitFuture {
        Box::pin(async move {
            self.commit_with_prefix(&[], write)
                .await
                .map(|receipt| receipt.last_sequence)
        })
    }
    fn commit_with_prefix(
        self: Arc<Self>,
        prefix: &[EventWrite],
        last: EventWrite,
    ) -> PrefixCommitFuture {
        let mut writes = prefix.to_vec();
        let dispatch = matches!(last.event().fact, Fact::ToolDispatched { .. });
        writes.push(last);
        Box::pin(async move {
            self.batches.lock().unwrap().push(writes.clone());
            if dispatch && matches!(self.fault, Fault::UncommittedUnknown) {
                return Err(CommitError::OutcomeUnknown(
                    "T1 reply lost before commit".into(),
                ));
            }
            let sequences = self.log.append_batch(&writes).await?;
            if dispatch && matches!(self.fault, Fault::CommittedUnknown) {
                return Err(CommitError::OutcomeUnknown(
                    "T1 committed; reply lost".into(),
                ));
            }
            Ok(PrefixReceipt::from_sequences(sequences))
        })
    }
}

struct Gates {
    slow_first: bool,
    all_pending: bool,
    entered: Semaphore,
    release: Semaphore,
    effects: AtomicUsize,
    effect: Semaphore,
}
struct Preparer(Arc<Gates>);
impl ToolPreparer for Preparer {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn prepare(
        &self,
        _: String,
        input: Value,
        _: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        let gates = self.0.clone();
        Box::pin(async move {
            if gates.all_pending || (gates.slow_first && input["n"] == 0) {
                gates.entered.add_permits(1);
                gates.release.acquire().await.unwrap().forget();
            }
            Ok(PreparedEffect::new(move |_| {
                Box::pin(async move {
                    gates.effects.fetch_add(1, Ordering::SeqCst);
                    gates.effect.add_permits(1);
                    Ok(input.into())
                })
            }))
        })
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    _root: maka_event_log::root_store::RootStore,
    inner: Arc<RunContext>,
    writer: AttemptWriter,
    finalizer: Arc<crate::preview::Finalizer>,
    sink: Arc<Sink>,
    gates: Arc<Gates>,
    tools: RunTools,
}
impl Fixture {
    async fn new(fault: Fault, slow_first: bool, all_pending: bool) -> Self {
        let (directory, root) = crate::test_support::root().await;
        let store = crate::test_support::session(&root, "session").await;
        let engine = crate::Engine::new(
            maka_model::ModelExecutor::new(Duration::from_secs(30)).unwrap(),
            CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
        )
        .unwrap();
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let inner = RunContext::new(engine.0.clone(), store, &invocation).unwrap();
        let setup = [
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "request".into(),
                    request_fingerprint: None,
                },
            },
            Fact::ModelRequested {
                item_acceptance: true,
                effective_source_digest: None,
                purpose: ModelPurpose::Main,
                context: None,
                context_breakdown: None,
                checkpoint_event_id: None,
                step_id: "step".into(),
                model_id: "model".into(),
                source_scope: LogScope::Session {
                    id: "session".into(),
                },
                source_high_water: 0,
                source_digest: "source".into(),
                input_digest: "input".into(),
                route_identity: "route".into(),
            },
        ]
        .into_iter()
        .map(|fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
        .collect::<Vec<_>>();
        let sequences = inner.log.append_batch(&setup).await.unwrap();
        let mut writer = AttemptWriter::new(
            AttemptBinding {
                invocation: invocation.clone(),
                step_id: "step".into(),
                purpose: ModelPurpose::Main,
            },
            true,
        )
        .unwrap();
        writer.fenced(sequences[1]);
        let finalizer = inner.attempts.register(writer.snapshot(), true);
        let sink = Arc::new(Sink {
            log: inner.log.clone(),
            fault,
            batches: Mutex::default(),
        });
        let gates = Arc::new(Gates {
            slow_first,
            all_pending,
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            effects: AtomicUsize::new(0),
            effect: Semaphore::new(0),
        });
        let catalog = ToolCatalog::new([ToolRegistration {
            definition: ToolDefinition {
                name: "echo".into(),
                description: "echo".into(),
                input_schema: json!({"type":"object"}),
                output_schema: None,
                provider: None,
                freeform: None,
            },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(Arc::new(Preparer(gates.clone()))),
        }])
        .unwrap();
        let tools = RunTools::new(
            Language::En,
            sink.clone(),
            invocation,
            catalog,
            ToolMode::Direct,
            CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
            engine.0.loaded("session"),
        );
        Self {
            _directory: directory,
            _root: root,
            inner,
            writer,
            finalizer,
            sink,
            gates,
            tools,
        }
    }
    async fn receive(&mut self, events: Vec<ModelEvent>) -> Result<(), RunError> {
        let request = self
            .tools
            .capture(".", CancellationToken::new())
            .await
            .unwrap();
        super::receive(
            &self.inner,
            &mut self.writer,
            &self.finalizer,
            stream::ready(events).await,
            Some(request.into_step("step")),
            &mut false,
            &CancellationToken::new(),
            &mut None,
        )
        .await
    }
}
fn scope() -> LogScope {
    LogScope::Session {
        id: "session".into(),
    }
}
async fn prefix(
    log: &maka_event_log::root_store::SessionStore,
) -> maka_agent_facts::event::LogPrefix {
    log.scoped_prefix(scope(), 100, 1024 * 1024).await.unwrap()
}
fn observed(
    prefix: &maka_agent_facts::event::LogPrefix,
) -> Vec<&maka_agent_facts::event::StoredEvent> {
    prefix
        .events
        .iter()
        .filter(|event| matches!(event.event.fact, Fact::ModelObserved { .. }))
        .collect()
}

fn events(failed_tail: bool) -> Vec<ModelEvent> {
    let mut events = (0..2)
        .map(|n| {
            ModelEvent::ToolCall(ModelToolCall {
                id: format!("call-{n}"),
                name: "echo".into(),
                input: json!({"n": n}).into(),
                provider_options: None,
                provider_executed: false,
            })
        })
        .collect::<Vec<_>>();
    events.push(if failed_tail {
        ModelEvent::PartFinished {
            id: "unknown".into(),
            provider_options: None,
        }
    } else {
        ModelEvent::Finished {
            reason: ModelFinishReason::ToolCalls,
            usage: Default::default(),
            provider_options: None,
        }
    });
    events
}
fn dispatches(sink: &Sink) -> usize {
    sink.batches
        .lock()
        .unwrap()
        .iter()
        .filter(|batch| {
            matches!(
                batch.last().unwrap().event().fact,
                Fact::ToolDispatched { .. }
            )
        })
        .count()
}

#[tokio::test]
async fn receive_unknown_confirms_only_original_prefix_without_republishing_t1() {
    for (fault, confirm_unknown) in [
        (Fault::CommittedUnknown, false),
        (Fault::UncommittedUnknown, false),
        (Fault::CommittedUnknown, true),
    ] {
        let mut fixture = Fixture::new(fault, false, false).await;
        let result = fixture.receive(events(false)).await;
        let error = result.expect_err("uncertain T1 must stop receive");
        assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 0);
        assert_eq!(
            dispatches(&fixture.sink),
            1,
            "later ready call must not publish another T1"
        );
        let (_, exact) = fixture
            .finalizer
            .prefix()
            .expect("receive freezes uncertain prefix");
        let submitted = fixture.sink.batches.lock().unwrap()[0].clone();
        assert_eq!(
            exact.iter().map(|write| write.event()).collect::<Vec<_>>(),
            submitted[..submitted.len() - 1]
                .iter()
                .map(|write| write.event())
                .collect::<Vec<_>>()
        );
        let before = prefix(&fixture.inner.log).await;
        let expected = if matches!(fault, Fault::CommittedUnknown) {
            exact.len()
        } else {
            0
        };
        assert_eq!(observed(&before).len(), expected);
        let inner = &fixture.inner;
        let sealed = seal_finalizer_with(inner, &fixture.finalizer, error, |writes| async move {
            assert!(
                writes
                    .iter()
                    .all(|write| matches!(write.event().fact, Fact::ModelObserved { .. }))
            );
            if confirm_unknown {
                Err(CommitError::OutcomeUnknown("confirmation unknown".into()))
            } else {
                inner.log.append_batch(&writes).await
            }
        })
        .await;
        let after = prefix(&fixture.inner.log).await;
        let canonical_t1 = after
            .events
            .iter()
            .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
            .count();
        assert_eq!(
            canonical_t1,
            usize::from(matches!(fault, Fault::CommittedUnknown))
        );
        if confirm_unknown {
            assert!(sealed.is_cleanup_unconfirmed());
            let (_, retained) = fixture.finalizer.prefix().unwrap();
            assert!(Arc::ptr_eq(&exact, &retained));
            assert!(
                !after
                    .events
                    .iter()
                    .any(|event| matches!(event.event.fact, Fact::ModelInterrupted { .. }))
            );
        } else {
            assert!(fixture.finalizer.terminal_confirmed());
            let terminal = fixture.finalizer.publication().unwrap();
            let stored_terminal = after
                .events
                .iter()
                .find(|event| event.event.id == terminal.event().id)
                .unwrap();
            assert_eq!(&stored_terminal.event, terminal.event());
            let cut = fixture.finalizer.snapshot();
            let observed = observed(&after);
            assert_eq!(observed.len(), exact.len());
            for (stored, original) in observed.iter().zip(exact.iter()) {
                assert_eq!(&stored.event, original.event());
            }
            assert_eq!(
                cut.depends_on,
                observed.iter().map(|event| event.sequence).max().unwrap()
            );
            let partial = after
                .events
                .iter()
                .find_map(|event| match &event.event.fact {
                    Fact::ModelInterrupted { partial, .. } => partial.as_ref(),
                    _ => None,
                })
                .unwrap();
            assert!(
                partial
                    .parts
                    .iter()
                    .all(|part| matches!(part, CompletionPart::Ref(_)))
            );
            assert_eq!(partial.parts.len(), 2);
        }
        assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 0);
        assert_eq!(dispatches(&fixture.sink), 1);
    }
}

#[tokio::test]
async fn slow_first_prepare_does_not_block_ready_sibling_or_lose_failed_tail_receipts() {
    let mut fixture = Fixture::new(Fault::None, true, false).await;
    let gates = fixture.gates.clone();
    let sink = fixture.sink.clone();
    let observe = async move {
        gates.effect.acquire().await.unwrap().forget();
        let batches = sink.batches.lock().unwrap();
        let first = &batches[0];
        assert!(matches!(&first.last().unwrap().event().fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id.ends_with(":call-1")));
        let parts = first[..first.len() - 1]
            .iter()
            .filter_map(|write| match &write.event().fact {
                Fact::ModelObserved {
                    event: ModelObservation::Part(part),
                    ..
                } => Some(part.ordinal),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            parts,
            vec![0, 1],
            "ready B publishes the complete arrival-ordered prefix"
        );
        drop(batches);
        gates.release.add_permits(1);
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(fixture.receive(events(true)), observe)
    })
    .await
    .expect("slow A must not block ready B");
    assert!(matches!(result, Err(RunError::Model(_))));
    assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 2);
    assert_eq!(dispatches(&fixture.sink), 2);
    assert!(
        fixture
            .writer
            .snapshot()
            .partial()
            .unwrap()
            .parts
            .iter()
            .all(|part| matches!(part, CompletionPart::Ref(_)))
    );
}

#[tokio::test]
async fn all_pending_prepares_flush_the_prefix_before_any_t1() {
    let mut fixture = Fixture::new(Fault::None, false, true).await;
    let gates = fixture.gates.clone();
    let sink = fixture.sink.clone();
    let log = fixture.inner.log.clone();
    let mut commits = log.subscribe_session_commits("session").unwrap();
    let observe = async move {
        gates.entered.acquire_many(2).await.unwrap().forget();
        // Committed observations must be visible while both tools remain gated.
        while observed(&prefix(&log).await).len() != 3 {
            commits.changed().await.unwrap();
        }
        assert_eq!(dispatches(&sink), 0);
        gates.release.add_permits(2);
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(fixture.receive(events(false)), observe)
    })
    .await
    .expect("pending prepares must not block prefix publication");
    result.unwrap();
    assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 2);
}
