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
use futures_util::{FutureExt, StreamExt};
use maka_agent_facts::{
    interaction::{Decision, InteractionOutcome},
    native_approval::{DispatchReceipt, NativeApprovalPending},
    tools::{EstablishedApproval, ToolError},
};

struct ApprovalGates {
    established: Semaphore,
    answer: Semaphore,
    effect: Semaphore,
    effects: AtomicUsize,
    close_on_effect: Option<Arc<Semaphore>>,
}

#[derive(Clone, Copy, Debug)]
enum FairReadOwner {
    Approval,
    Preparation,
}

struct FairApprovalReads {
    owner: FairReadOwner,
    permits: Semaphore,
    first_answer_queued: Semaphore,
    second_publication_queued: Semaphore,
}

impl FairApprovalReads {
    async fn read(&self, queued: &Semaphore, notifications: usize) {
        let acquire = self.permits.acquire();
        tokio::pin!(acquire);
        let mut announced = false;
        let permit = std::future::poll_fn(|cx| {
            let result = std::future::Future::poll(acquire.as_mut(), cx);
            if result.is_pending() && !announced {
                announced = true;
                queued.add_permits(notifications);
            }
            result
        })
        .await
        .unwrap();
        drop(permit);
    }
}

struct ApprovalPreparer {
    reads: Option<Arc<FairApprovalReads>>,
    gates: Arc<ApprovalGates>,
    log: Arc<maka_event_log::root_store::SessionStore>,
}

impl ToolPreparer for ApprovalPreparer {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }

    fn prepare(
        &self,
        _: String,
        input: Value,
        context: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        let reads = self.reads.clone();
        let gates = self.gates.clone();
        let answer_gates = gates.clone();
        let log = self.log.clone();
        Box::pin(async move {
            let second = input["n"] == 1;
            if !second
                && let Some(reads) = &reads
                && matches!(reads.owner, FairReadOwner::Preparation)
            {
                reads.read(&reads.first_answer_queued, 2).await;
            }
            if second && let Some(reads) = &reads {
                reads.first_answer_queued.acquire().await.unwrap().forget();
            }
            Ok(PreparedEffect::native_approval(
                move |cancellation| {
                    Box::pin(async move {
                        if second && let Some(reads) = &reads {
                            reads.read(&reads.second_publication_queued, 1).await;
                        }
                        let stored = prefix(&log).await;
                        let dispatch = stored
                            .events
                            .iter()
                            .find(|stored| matches!(&stored.event.fact, Fact::ToolDispatched { operation_id, .. } if operation_id == &context.operation_id))
                            .expect("approval is established after its original durable T1");
                        let interaction_id = format!("fixture-approval:{}", context.operation_id);
                        let pending = NativeApprovalPending {
                            invocation: context.invocation,
                            operation_id: context.operation_id,
                            dispatch: DispatchReceipt {
                                event_id: dispatch.event.id.clone(),
                                sequence: dispatch.sequence,
                            },
                            interaction_id,
                            native: json!({}),
                        };
                        answer_gates.established.add_permits(1);
                        Ok(EstablishedApproval {
                            pending,
                            answer: Box::pin(async move {
                                if !second
                                    && let Some(reads) = &reads
                                    && matches!(reads.owner, FairReadOwner::Approval)
                                {
                                    reads.read(&reads.first_answer_queued, 2).await;
                                }
                                tokio::select! {
                                    permit = answer_gates.answer.acquire() => {
                                        permit.unwrap().forget();
                                        Ok(InteractionOutcome::ServiceApprovalDecision { decision: Decision::Allow, committed_at: 1 })
                                    }
                                    _ = cancellation.cancelled() => Err(ToolError::Failed("fixture cancelled".into())),
                                }
                            }),
                        })
                    })
                },
                move |_| {
                    Box::pin(async move {
                        gates.effects.fetch_add(1, Ordering::SeqCst);
                        gates.effect.add_permits(1);
                        if let Some(close) = &gates.close_on_effect {
                            close.add_permits(1);
                        }
                        Ok(input.into())
                    })
                },
            ))
        })
    }
}

async fn install_approval(
    fixture: &mut Fixture,
    close_on_effect: Option<Arc<Semaphore>>,
    reads: Option<Arc<FairApprovalReads>>,
) -> Arc<ApprovalGates> {
    let gates = Arc::new(ApprovalGates {
        established: Semaphore::new(0),
        answer: Semaphore::new(0),
        effect: Semaphore::new(0),
        effects: AtomicUsize::new(0),
        close_on_effect,
    });
    let catalog = ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            name: "echo".into(),
            description: "approval fixture".into(),
            input_schema: json!({"type":"object"}),
            output_schema: None,
            provider: None,
            freeform: None,
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Prepared(Arc::new(ApprovalPreparer {
            reads,
            gates: gates.clone(),
            log: fixture.inner.log.clone(),
        })),
    }])
    .unwrap();
    fixture.tools = RunTools::new(
        Language::En,
        fixture.sink.clone(),
        fixture.finalizer.snapshot().binding.invocation.clone(),
        catalog,
        ToolMode::Direct,
        CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
        maka_tools::availability::LoadedTools::temporary().unwrap(),
    );
    gates
}

fn approval_events() -> Vec<ModelEvent> {
    let mut batch = events(false);
    batch.remove(1);
    batch
}

async fn assert_original_settlement(fixture: &Fixture) {
    let stored = prefix(&fixture.inner.log).await;
    let dispatches = stored
        .events
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ToolDispatched { operation_id, .. } => Some(operation_id),
            _ => None,
        })
        .collect::<Vec<_>>();
    let settlements = stored
        .events
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ToolSettled { operation_id, .. } => Some(operation_id),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(dispatches, vec!["step:call-0"]);
    assert_eq!(
        settlements, dispatches,
        "answer settles the original operation once"
    );
}

#[tokio::test]
async fn approval_answer_starts_original_effect_while_provider_remains_open() {
    let mut fixture = Fixture::new(Fault::None, false, false).await;
    let gates = install_approval(&mut fixture, None, None).await;
    let close_gate = Arc::new(Semaphore::new(0));
    let observe_gate = close_gate.clone();
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let log = fixture.inner.log.clone();
    let observe = async {
        gates.established.acquire().await.unwrap().forget();
        assert_eq!(gates.effects.load(Ordering::SeqCst), 0);
        gates.answer.add_permits(1);
        gates.effect.acquire().await.unwrap().forget();
        let stored = prefix(&log).await;
        assert!(
            stored
                .events
                .iter()
                .all(|stored| !matches!(stored.event.fact, Fact::ModelCompleted { .. })),
            "original effect starts before provider physical closure"
        );
        observe_gate.add_permits(1);
    };
    let cancellation = CancellationToken::new();
    let mut progressed = false;
    let mut retry = None;
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            super::super::receive(
                &fixture.inner,
                fixture.writer.take().unwrap(),
                &fixture.finalizer,
                stream::ready_with_close_gate(approval_events(), close_gate).await,
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
    .expect("approval answer must run before provider closure");
    let AttemptOutput::Main(response) = result.unwrap() else {
        panic!("main response")
    };
    assert!(response.approvals.is_empty());
    assert_eq!(gates.effects.load(Ordering::SeqCst), 1);
    assert_original_settlement(&fixture).await;
}

#[tokio::test]
async fn provider_waiting_for_tool_result_does_not_block_approval_execution() {
    let mut fixture = Fixture::new(Fault::None, false, false).await;
    let close_gate = Arc::new(Semaphore::new(0));
    let gates = install_approval(&mut fixture, Some(close_gate.clone()), None).await;
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let observe = async {
        gates.established.acquire().await.unwrap().forget();
        gates.answer.add_permits(1);
    };
    let cancellation = CancellationToken::new();
    let mut progressed = false;
    let mut retry = None;
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            super::super::receive(
                &fixture.inner,
                fixture.writer.take().unwrap(),
                &fixture.finalizer,
                stream::ready_with_close_gate(approval_events(), close_gate).await,
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
    .expect("provider blocked on original effect must make progress");
    let AttemptOutput::Main(response) = result.unwrap() else {
        panic!("main response")
    };
    assert!(response.approvals.is_empty());
    assert_eq!(gates.effects.load(Ordering::SeqCst), 1);
    assert_original_settlement(&fixture).await;
}

#[tokio::test]
async fn clean_response_returns_owned_unanswered_approval_without_settlement() {
    let mut fixture = Fixture::new(Fault::None, false, false).await;
    let gates = install_approval(&mut fixture, None, None).await;
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        super::super::receive(
            &fixture.inner,
            fixture.writer.take().unwrap(),
            &fixture.finalizer,
            stream::ready(approval_events()).await,
            Some(request.into_step("step")),
            &mut false,
            &CancellationToken::new(),
            &mut None,
            None,
        ),
    )
    .await
    .expect("unanswered approval must transfer to the step owner")
    .unwrap();
    let AttemptOutput::Main(mut response) = result else {
        panic!("main response")
    };
    assert!(fixture.finalizer.terminal_confirmed());
    assert_eq!(response.approvals.len(), 1);
    assert_eq!(gates.effects.load(Ordering::SeqCst), 0);
    assert!(response.approvals.next().now_or_never().is_none());
    let stored = prefix(&fixture.inner.log).await;
    assert!(
        stored
            .events
            .iter()
            .all(|stored| !matches!(stored.event.fact, Fact::ToolSettled { .. }))
    );
    let pending = response.approvals.iter().next().unwrap().pending();
    let dispatch = stored
        .events
        .iter()
        .find(|stored| stored.event.id == pending.dispatch.event_id)
        .unwrap();
    assert_eq!(dispatch.sequence, pending.dispatch.sequence);
    assert_eq!(pending.operation_id, "step:call-0");
    gates.answer.add_permits(1);
    let execution = response.approvals.next().await.unwrap();
    assert_eq!(
        gates.effects.load(Ordering::SeqCst),
        0,
        "answer polling transfers the original unstarted execution"
    );
    execution.await.unwrap();
    assert_eq!(gates.effects.load(Ordering::SeqCst), 1);
    assert_original_settlement(&fixture).await;
}

#[tokio::test]
async fn failed_model_tail_still_drives_approval_while_provider_cleanup_waits_for_effect() {
    let mut fixture = Fixture::new(Fault::None, false, false).await;
    let close_gate = Arc::new(Semaphore::new(0));
    let gates = install_approval(&mut fixture, Some(close_gate.clone()), None).await;
    let request = fixture
        .tools
        .capture(".", CancellationToken::new())
        .await
        .unwrap();
    let mut failed_tail = approval_events();
    failed_tail.push(ModelEvent::PartFinished {
        id: "after-finished".into(),
        provider_options: None,
    });
    let observe = async {
        gates.established.acquire().await.unwrap().forget();
        gates.answer.add_permits(1);
    };
    let cancellation = CancellationToken::new();
    let mut progressed = false;
    let mut retry = None;
    let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            super::super::receive(
                &fixture.inner,
                fixture.writer.take().unwrap(),
                &fixture.finalizer,
                stream::ready_with_close_gate(failed_tail, close_gate).await,
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
    .expect(
        "original approval must progress while malformed-tail provider cleanup awaits its effect",
    );
    let error = result
        .err()
        .expect("malformed model tail must remain a failure");
    assert!(
        !error.is_cleanup_unconfirmed(),
        "the original effect releases provider cleanup"
    );
    assert!(
        matches!(error, RunError::Model(ModelError::Adapter(_))),
        "preserve the original failed model tail"
    );
    assert!(fixture.finalizer.terminal_confirmed());
    assert_eq!(gates.effects.load(Ordering::SeqCst), 1);
    assert_original_settlement(&fixture).await;
}

#[tokio::test]
async fn sibling_publication_drives_queued_approval_and_preparation_read_permits() {
    for owner in [FairReadOwner::Approval, FairReadOwner::Preparation] {
        let mut fixture = Fixture::new(Fault::None, false, false).await;
        let reads = Arc::new(FairApprovalReads {
            owner,
            permits: Semaphore::new(1),
            first_answer_queued: Semaphore::new(0),
            second_publication_queued: Semaphore::new(0),
        });
        let held = reads.permits.acquire().await.unwrap();
        let gates = install_approval(&mut fixture, None, Some(reads.clone())).await;
        let request = fixture
            .tools
            .capture(".", CancellationToken::new())
            .await
            .unwrap();
        let release = async {
            reads.first_answer_queued.acquire().await.unwrap().forget();
            reads
                .second_publication_queued
                .acquire()
                .await
                .unwrap()
                .forget();
            // The fair semaphore grants this permit to the already queued sibling.
            // Publication can finish only if that original future keeps being polled.
            drop(held);
        };
        let cancellation = CancellationToken::new();
        let mut progressed = false;
        let mut retry = None;
        let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
            tokio::join!(
                super::super::receive(
                    &fixture.inner,
                    fixture.writer.take().unwrap(),
                    &fixture.finalizer,
                    stream::ready(events(false)).await,
                    Some(request.into_step("step")),
                    &mut progressed,
                    &cancellation,
                    &mut retry,
                    None,
                ),
                release,
            )
        })
        .await
        .unwrap_or_else(|error| {
            panic!("sibling publication must drive the original {owner:?} read: {error}")
        });
        let AttemptOutput::Main(mut response) = result.unwrap() else {
            panic!("main response")
        };
        assert!(fixture.finalizer.terminal_confirmed());
        assert_eq!(response.approvals.len(), 2);
        assert_eq!(gates.effects.load(Ordering::SeqCst), 0);
        gates.answer.add_permits(2);
        while let Some(execution) = response.approvals.next().await {
            execution.await.unwrap();
        }
        assert_eq!(gates.effects.load(Ordering::SeqCst), 2);
        let stored = prefix(&fixture.inner.log).await;
        let mut dispatches = Vec::new();
        let mut settlements = Vec::new();
        for event in &stored.events {
            match &event.event.fact {
                Fact::ToolDispatched { operation_id, .. } => dispatches.push(operation_id.as_str()),
                Fact::ToolSettled { operation_id, .. } => settlements.push(operation_id.as_str()),
                _ => {}
            }
        }
        dispatches.sort_unstable();
        settlements.sort_unstable();
        assert_eq!(dispatches, ["step:call-0", "step:call-1"]);
        assert_eq!(
            settlements, dispatches,
            "each answer settles its original T1 exactly once"
        );
    }
}
