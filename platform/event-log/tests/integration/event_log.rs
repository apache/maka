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

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::CommitFuture;
use maka_agent_facts::event::EventSink;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::TerminalStatus;
use maka_agent_facts::tools::JournaledTools;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_event_log::{EventLog, StoreError};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn invocation() -> Invocation {
    Invocation {
        session_id: "session-1".into(),
        turn_id: "turn-1".into(),
        run_id: "run-1".into(),
        invocation_id: "invocation-1".into(),
    }
}

fn opening() -> RuntimeEvent {
    RuntimeEvent::new(
        invocation(),
        Fact::InvocationOpened {
            configuration: None,
            input: maka_agent_facts::input::InvocationInput::Code {
                source: "test".into(),
            },
        },
    )
}

#[tokio::test]
async fn settled_uncertainty_survives_reopen_without_abandoning_the_invocation() {
    use maka_agent_facts::event::ToolOutcome;
    use maka_agent_facts::tool_call::ToolCallIdentity;
    use maka_agent_facts::tools::ToolJournal;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    log.append(&EventWrite::plain(opening()).unwrap())
        .await
        .unwrap();
    let journal = ToolJournal::new(log.clone(), invocation());
    for (operation, uncertain) in [("publish", true), ("inspect", false)] {
        let result = journal
            .invoke_call_with::<Value>(
                operation.into(),
                ToolCallIdentity::standalone(operation.into()),
                operation.into(),
                Value::Null,
                None,
                CancellationToken::new(),
                move |_| {
                    Box::pin(async move {
                        if uncertain {
                            Err(ToolError::OutcomeUnknown(
                                "rename finished; directory sync failed".into(),
                            ))
                        } else {
                            Ok(json!({"published": true}))
                        }
                    })
                },
            )
            .await;
        if uncertain {
            assert!(matches!(result, Err(ToolError::OutcomeUnknown(_))));
        } else {
            assert_eq!(result.unwrap(), json!({"published":true}));
        }
    }
    drop(journal);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let prefix = reopened.prefix(10, 16_384).await.unwrap();
    assert!(
        prefix
            .project_invocation("invocation-1")
            .uncertain_operations
            .is_empty(),
        "settled uncertainty is a recorded result, not a missing worker"
    );
    assert!(prefix.events.iter().any(|row| matches!(&row.event.fact,
        Fact::ToolSettled { operation_id, outcome: ToolOutcome::Unknown { message, .. } }
            if operation_id == "publish" && message.contains("directory sync failed")
    )));
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn committed_prefix_survives_reopen_with_exact_replay_and_terminal_sealing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    assert!(matches!(
        EventLog::open(&path).await,
        Err(StoreError::WriterBusy)
    ));
    #[cfg(unix)]
    {
        let alias = directory.path().join("alias.sqlite");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(matches!(
            EventLog::open(&alias).await,
            Err(StoreError::WriterBusy)
        ));
        let dangling = directory.path().join("dangling.sqlite");
        std::os::unix::fs::symlink(directory.path().join("missing.sqlite"), &dangling).unwrap();
        assert!(EventLog::open(&dangling).await.is_err());
        assert!(!directory.path().join("missing.sqlite").exists());
    }
    let opening = opening();
    let first_sequence = log
        .append(&EventWrite::plain((opening).clone()).unwrap())
        .await
        .unwrap();
    log.append(
        &EventWrite::plain(
            (RuntimeEvent::new(
                invocation(),
                Fact::ToolDispatched {
                    presentation: None,
                    title: None,
                    operation_id: "effect-1".into(),
                    call: maka_agent_facts::tool_call::ToolCallIdentity::standalone(
                        "effect-1-call".into(),
                    ),
                    name: "write_file".into(),
                    input: json!({"path":"example"}),
                },
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let before = log.prefix(10, 16_384).await.unwrap();
    assert_eq!(
        before
            .project_invocation("invocation-1")
            .uncertain_operations,
        ["effect-1"]
    );
    assert!(matches!(
        log.prefix(1, 16_384).await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert!(matches!(
        log.prefix(10, 1).await,
        Err(StoreError::PrefixTooLarge)
    ));
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let reopened = log.prefix(10, 16_384).await.unwrap();
    assert_eq!(before.digest, reopened.digest);
    assert_eq!(before.high_water, reopened.high_water);
    assert_eq!(reopened.events[0].event.recorded_at, opening.recorded_at);
    let mut retimed = opening.clone();
    retimed.recorded_at += std::time::Duration::from_millis(1);
    assert!(
        log.append(&EventWrite::plain((retimed).clone()).unwrap())
            .await
            .is_err(),
        "replay cannot rewrite factual event time"
    );
    assert_eq!(
        log.append(&EventWrite::plain((opening).clone()).unwrap())
            .await
            .unwrap(),
        first_sequence
    );
    assert!(
        log.append(
            &EventWrite::plain(
                (RuntimeEvent::new(
                    invocation(),
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed
                    },
                ))
                .clone()
            )
            .unwrap()
        )
        .await
        .is_err(),
        "an unresolved effect cannot be sealed as successful"
    );
    log.append(
        &EventWrite::plain(
            (RuntimeEvent::new(
                invocation(),
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Failed {
                        model_failure: None,
                        class: "tool_outcome_unknown".into(),
                        message: Some("tool outcome was not committed".into()),
                    },
                },
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        log.append(&EventWrite::plain((opening).clone()).unwrap())
            .await
            .unwrap(),
        first_sequence
    );
    let mut conflicting = opening.clone();
    conflicting.fact = Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Code {
            source: "different intent".into(),
        },
    };
    assert!(
        log.append(&EventWrite::plain((conflicting).clone()).unwrap())
            .await
            .is_err()
    );
    assert!(
        log.append(
            &EventWrite::plain(
                (RuntimeEvent::new(
                    invocation(),
                    Fact::ToolDispatched {
                        presentation: None,
                        title: None,
                        operation_id: "effect-2".into(),
                        call: maka_agent_facts::tool_call::ToolCallIdentity::standalone(
                            "effect-2-call".into()
                        ),
                        name: "write_file".into(),
                        input: Value::Null,
                    }
                ))
                .clone()
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    let view = log
        .prefix(10, 16_384)
        .await
        .unwrap()
        .project_invocation("invocation-1");
    assert_eq!(view.terminal, Some(TerminalStatus::Failed));
    assert_eq!(view.uncertain_operations, ["effect-1"]);
    assert_eq!(
        before.high_water, 2,
        "a previously read prefix is immutable"
    );
    log.close().await.unwrap();
}

struct FaultSink {
    log: Arc<EventLog>,
    kind: &'static str,
    commit_before_error: bool,
}

impl EventSink for FaultSink {
    fn commit(self: Arc<Self>, event: EventWrite) -> CommitFuture {
        Box::pin(async move {
            self.commit_with_prefix(&[], event)
                .await
                .map(|receipt| receipt.last_sequence)
        })
    }

    fn commit_with_prefix(
        self: Arc<Self>,
        prefix: &[EventWrite],
        last: EventWrite,
    ) -> maka_agent_facts::event::PrefixCommitFuture {
        let mut events = prefix.to_vec();
        events.push(last);
        Box::pin(async move {
            if events
                .last()
                .expect("last event is present")
                .event()
                .fact
                .kind()
                == self.kind
            {
                if self.commit_before_error {
                    self.log.append_batch(&events).await?;
                }
                return Err(CommitError::OutcomeUnknown(
                    "injected commit failure".into(),
                ));
            }
            self.log
                .append_batch(&events)
                .await
                .map(maka_agent_facts::event::PrefixReceipt::from_sequences)
        })
    }
}

struct Effect {
    log: Arc<EventLog>,
    count: Arc<AtomicUsize>,
}

impl ToolExecutor for Effect {
    fn names(&self) -> Vec<String> {
        vec!["write_file".into()]
    }
    fn invoke(&self, _name: String, _input: Value, _cancel: CancellationToken) -> ToolFuture {
        let log = self.log.clone();
        let count = self.count.clone();
        Box::pin(async move {
            let view = log
                .prefix(10, 16_384)
                .await
                .unwrap()
                .project_invocation("invocation-1");
            assert_eq!(
                view.uncertain_operations.len(),
                1,
                "dispatch is committed before the effect starts"
            );
            count.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"bytes": 3}))
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ambiguous_commits_do_not_trigger_effect_retries_or_false_success() {
    for kind in ["tool_dispatched", "tool_settled"] {
        for commit_before_error in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let log = Arc::new(
                EventLog::open(&directory.path().join("events.sqlite"))
                    .await
                    .unwrap(),
            );
            log.append(&EventWrite::plain((opening()).clone()).unwrap())
                .await
                .unwrap();
            let count = Arc::new(AtomicUsize::new(0));
            let tools = JournaledTools::new(
                Arc::new(FaultSink {
                    log: log.clone(),
                    kind,
                    commit_before_error,
                }),
                invocation(),
                Arc::new(Effect {
                    log: log.clone(),
                    count: count.clone(),
                }),
            );
            let result = tools
                .invoke("write_file".into(), Value::Null, CancellationToken::new())
                .await;
            if kind == "tool_dispatched" {
                assert!(matches!(result, Err(ToolError::Persistence(_))));
                assert_eq!(count.load(Ordering::SeqCst), 0);
            } else {
                assert!(matches!(result, Err(ToolError::Persistence(_))));
                assert_eq!(count.load(Ordering::SeqCst), 1);
            }
            let pending = log
                .prefix(10, 16_384)
                .await
                .unwrap()
                .project_invocation("invocation-1")
                .uncertain_operations
                .len();
            assert_eq!(
                pending,
                match (kind, commit_before_error) {
                    ("tool_dispatched", false) | ("tool_settled", true) => 0,
                    _ => 1,
                }
            );
            drop(tools);
            let log = match Arc::try_unwrap(log) {
                Ok(log) => log,
                Err(_) => panic!("all tool handles must be released before close"),
            };
            log.close().await.unwrap();
            let reopened = EventLog::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap();
            let prefix = reopened.prefix(10, 16_384).await.unwrap();
            if kind == "tool_settled" && commit_before_error {
                let outcome = prefix.events.last().unwrap();
                let raw = reopened
                    .resolve_tool_result(&outcome.event.invocation.session_id, &outcome.event.id)
                    .await
                    .unwrap();
                assert_eq!(raw.clone().into_json(), json!({"bytes":3}));
                let Fact::ToolSettled { operation_id, .. } = &outcome.event.fact else {
                    panic!()
                };
                let replay = EventWrite::tool_success(
                    outcome.event.id.clone(),
                    outcome.event.recorded_at,
                    outcome.event.invocation.clone(),
                    operation_id.clone(),
                    raw.into(),
                )
                .unwrap()
                .0;
                assert_eq!(reopened.append(&replay).await.unwrap(), outcome.sequence);
                assert_eq!(count.load(Ordering::SeqCst), 1);
            }
            reopened.close().await.unwrap();
        }
    }
}
