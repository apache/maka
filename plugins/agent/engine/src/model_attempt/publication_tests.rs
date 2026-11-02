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

mod approval;
mod retirement;
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
    competition: Mutex<Option<Arc<PublicationCompetition>>>,
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
        let competition = self.competition.lock().unwrap().clone();
        let second = matches!(&last.event().fact,
            Fact::ToolDispatched { input, .. } if input["n"] == 1);
        writes.push(last);
        Box::pin(async move {
            if second && let Some(competition) = competition {
                let permit = competition.permit.acquire();
                tokio::pin!(permit);
                assert!(futures_util::poll!(&mut permit).is_pending());
                // The original first completion is ahead in this fair queue.
                // Granting it requires that same future to be polled again.
                competition.permit.add_permits(1);
                drop(permit.await.unwrap());
            }
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
    competition: Mutex<Option<Arc<PublicationCompetition>>>,
}
struct PublicationCompetition {
    permit: Semaphore,
    first_waiting: Semaphore,
    phase: CompetitionPhase,
}
#[derive(Clone, Copy)]
enum CompetitionPhase {
    Execution,
    Preparation,
}
impl PublicationCompetition {
    async fn wait_first(&self) {
        let permit = self.permit.acquire();
        tokio::pin!(permit);
        assert!(futures_util::poll!(&mut permit).is_pending());
        self.first_waiting.add_permits(1);
        drop(permit.await.unwrap());
    }
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
            let competition = gates.competition.lock().unwrap().clone();
            if input["n"] == 0
                && let Some(competition) = &competition
                && matches!(competition.phase, CompetitionPhase::Preparation)
            {
                competition.wait_first().await;
            }
            if input["n"] == 1
                && let Some(competition) = &competition
            {
                competition.first_waiting.acquire().await.unwrap().forget();
            }
            if gates.all_pending || (gates.slow_first && input["n"] == 0) {
                gates.entered.add_permits(1);
                gates.release.acquire().await.unwrap().forget();
            }
            Ok(PreparedEffect::new(move |_| {
                Box::pin(async move {
                    if input["n"] == 0
                        && let Some(competition) = competition
                        && matches!(competition.phase, CompetitionPhase::Execution)
                    {
                        competition.wait_first().await;
                    }
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
    writer: Option<AttemptWriter>,
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
                source_capture: maka_agent_facts::event::SourceCapture {
                    publication_watermark: 0,
                    prior_unknown: false,
                },
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
            competition: Mutex::default(),
        });
        let gates = Arc::new(Gates {
            slow_first,
            all_pending,
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            effects: AtomicUsize::new(0),
            effect: Semaphore::new(0),
            competition: Mutex::default(),
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
            writer: Some(writer),
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
            self.writer.take().expect("fixture attempt runs once"),
            &self.finalizer,
            stream::ready(events).await,
            Some(request.into_step("step")),
            &mut false,
            &CancellationToken::new(),
            &mut None,
            None,
        )
        .await
        .map(|_| ())
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
async fn sibling_publication_keeps_original_fair_waiter_polled() {
    publication_keeps_waiter_polled(CompetitionPhase::Execution).await;
}

#[tokio::test]
async fn sibling_publication_keeps_original_preparation_waiter_polled() {
    publication_keeps_waiter_polled(CompetitionPhase::Preparation).await;
}

async fn publication_keeps_waiter_polled(phase: CompetitionPhase) {
    let mut fixture = Fixture::new(Fault::None, false, false).await;
    let competition = Arc::new(PublicationCompetition {
        permit: Semaphore::new(0),
        first_waiting: Semaphore::new(0),
        phase,
    });
    *fixture.sink.competition.lock().unwrap() = Some(competition.clone());
    *fixture.gates.competition.lock().unwrap() = Some(competition);
    tokio::time::timeout(Duration::from_secs(30), fixture.receive(events(false)))
        .await
        .expect("sibling publication must keep polling the original granted waiter")
        .unwrap();
    assert_eq!(dispatches(&fixture.sink), 2);
    assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 2);
    let after = prefix(&fixture.inner.log).await;
    let settled = after
        .events
        .iter()
        .filter(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
        .count();
    assert_eq!(
        settled, 2,
        "both original one-shot effects have durable outcomes"
    );
    assert!(fixture.finalizer.terminal_confirmed());
    fixture.tools.shutdown().await.unwrap();
    fixture._root.shutdown().await.unwrap();
}

#[tokio::test]
async fn receive_unknown_confirms_only_original_prefix_without_republishing_t1() {
    for fault in [Fault::CommittedUnknown, Fault::UncommittedUnknown] {
        let mut fixture = Fixture::new(fault, false, false).await;
        let error = fixture
            .receive(events(false))
            .await
            .expect_err("uncertain T1 must stop receive");
        assert!(matches!(error, RunError::Tool(_)));
        assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 0);
        assert_eq!(
            dispatches(&fixture.sink),
            1,
            "confirmation must not publish another T1"
        );
        assert!(fixture.finalizer.terminal_confirmed());
        assert!(
            fixture.finalizer.publication().is_none(),
            "receipt retires the body-bearing terminal"
        );
        let submitted = fixture.sink.batches.lock().unwrap()[0].clone();
        let after = prefix(&fixture.inner.log).await;
        let observed = observed(&after);
        assert_eq!(observed.len(), submitted.len() - 1);
        for (stored, original) in observed.iter().zip(&submitted) {
            assert_eq!(
                &stored.event,
                original.event(),
                "confirmation keeps exact original prefix identities"
            );
        }
        assert_eq!(
            after
                .events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
                .count(),
            usize::from(matches!(fault, Fault::CommittedUnknown))
        );
        let partial = after
            .events
            .iter()
            .find_map(|event| match &event.event.fact {
                Fact::ModelInterrupted { partial, .. } => partial.as_ref(),
                _ => None,
            })
            .expect("unknown dispatch seals the valid model prefix");
        assert!(
            partial
                .parts
                .iter()
                .all(|part| matches!(part, CompletionPart::Ref(_)))
        );
        assert_eq!(partial.parts.len(), 2);
        let expected_refs = observed
            .iter()
            .filter_map(|stored| match &stored.event.fact {
                Fact::ModelObserved {
                    event: ModelObservation::Part(part),
                    ..
                } => Some(CompletionPart::Ref(RecordedPartRef {
                    event_id: stored.event.id.clone(),
                    ordinal: part.ordinal,
                })),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            partial.parts, expected_refs,
            "terminal keeps exact original prefix references"
        );

        assert!(fixture.inner.attempts.unfinished().is_empty());
    }
}

#[tokio::test]
async fn prefix_confirmation_unknown_keeps_original_identity_and_cut() {
    let mut fixture = Fixture::new(Fault::CommittedUnknown, false, false).await;
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let mut original_prefix = None;
    let result = receive_with_confirmation(
        &fixture.inner,
        fixture.writer.take().unwrap(),
        &fixture.finalizer,
        stream::ready(events(false)).await,
        Some(request.into_step("step")),
        &mut false,
        &CancellationToken::new(),
        &mut None,
        None,
        |writes| {
            original_prefix = Some(writes);
            async { Err(CommitError::OutcomeUnknown("confirmation unknown".into())) }
        },
    )
    .await;
    assert!(
        result
            .err()
            .expect("repeated unknown must stop the attempt")
            .is_cleanup_unconfirmed()
    );
    let (_, retained) = fixture
        .finalizer
        .prefix()
        .expect("unknown confirmation retains original prefix");
    assert!(Arc::ptr_eq(&original_prefix.unwrap(), &retained));
    let submitted = fixture.sink.batches.lock().unwrap()[0].clone();
    assert!(
        retained
            .iter()
            .map(|write| write.event())
            .eq(submitted[..submitted.len() - 1]
                .iter()
                .map(|write| write.event()))
    );
    assert!(!fixture.finalizer.terminal_confirmed());
    assert!(
        prefix(&fixture.inner.log)
            .await
            .events
            .iter()
            .all(|event| !matches!(event.event.fact, Fact::ModelInterrupted { .. }))
    );
    assert_eq!(dispatches(&fixture.sink), 1);
    assert_eq!(fixture.gates.effects.load(Ordering::SeqCst), 0);
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
    let after = prefix(&fixture.inner.log).await;
    let partial = after
        .events
        .iter()
        .find_map(|event| match &event.event.fact {
            Fact::ModelInterrupted { partial, .. } => partial.as_ref(),
            _ => None,
        })
        .expect("failed tail seals accepted prefix");
    assert!(
        partial
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
