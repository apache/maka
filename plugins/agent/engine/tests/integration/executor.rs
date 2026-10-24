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

use super::support::{context, invocation};
use crate::support::store::SessionFixture;
use futures_util::future::BoxFuture;
use maka_agent_engine::{ExecutorInput, RunError};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::execution::ToolMode;
use maka_agent_facts::executor::Output;
use maka_agent_ports::executor::Admitted;
use maka_agent_ports::executor::Backend;
use maka_agent_ports::executor::Context;
use maka_agent_ports::executor::Error;
use maka_agent_ports::executor::Execution;
use maka_agent_ports::executor::Outcome;
use maka_agent_ports::executor::OutputSink;
use maka_agent_ports::executor::Provider;
use maka_agent_ports::executor::Request;
use maka_agent_ports::executor::Settlement;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

struct NativeBackend(Arc<dyn Provider>);
impl Backend for NativeBackend {
    fn admit_execution(&self, request: Request) -> Result<Admitted, Error> {
        Ok(Admitted {
            identity: maka_agent_facts::executor::Binding {
                executor_id: "example".to_owned().try_into().unwrap(),
                package_id: "example".into(),
                entry_id: "example".into(),
                activation: "native-test".into(),
            },
            execution: Box::new(NativeExecution(self.0.clone(), request)),
        })
    }
}
struct NativeExecution(Arc<dyn Provider>, Request);
impl Execution for NativeExecution {
    fn execute(
        self: Box<Self>,
        _execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Settlement> {
        Box::pin(async move {
            let result = self
                .0
                .execute(
                    self.1,
                    Context {
                        cancellation,
                        output,
                        call: None,
                    },
                )
                .await;
            Settlement::new(result, self.0)
        })
    }
}

struct Adapter {
    answer: String,
    started: Arc<Semaphore>,
    retained: Arc<Mutex<Option<Context>>>,
}
impl Provider for Adapter {
    fn execute(
        &self,
        request: Request,
        context: Context,
    ) -> BoxFuture<'static, Result<Outcome, Error>> {
        let started = self.started.clone();
        let retained = self.retained.clone();
        let answer = self.answer.clone();
        Box::pin(async move {
            assert_eq!(request.settings.model.as_deref(), Some("executor-model"));
            assert_eq!(
                request.settings.thinking_level,
                Some(maka_agent_facts::execution::ThinkingLevel::Max)
            );
            context
                .output
                .emit(Output::ThinkingDelta {
                    text: "thought".into(),
                })
                .await?;
            context
                .output
                .emit(Output::OutputDelta {
                    text: "partial".into(),
                })
                .await?;
            *retained.lock().unwrap() = Some(context.clone());
            started.add_permits(1);
            if request.content.text == "wait" {
                context.cancellation.cancelled().await;
            }
            Ok(Outcome::Completed { text: answer })
        })
    }
}

#[tokio::test]
async fn external_backend_uses_canonical_admission_settlement_and_never_enters_model_loop() {
    let temp = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&temp.path().join("executor.sqlite"))
            .await
            .unwrap(),
    );
    let engine = context::engine();
    let started = Arc::new(Semaphore::new(0));
    let retained = Arc::new(Mutex::new(None));
    let answer = format!(
        "{}COMPLETE_EXECUTOR_FINAL",
        "External answer 原文\n".repeat(60_000)
    );
    let read_bytes = answer.len() + 1024 * 1024;
    let adapter = Arc::new(Adapter {
        answer: answer.clone(),
        started: started.clone(),
        retained: retained.clone(),
    });
    for id in ["complete", "wait"] {
        let mut configuration = invocation::configuration(ToolMode::Direct);
        configuration.model = None;
        let input = ExecutorInput {
            request: Request {
                language: configuration.language,
                invocation: Invocation {
                    session_id: "session".into(),
                    turn_id: id.into(),
                    run_id: id.into(),
                    invocation_id: id.into(),
                },
                conversation_key: "session".into(),
                settings: maka_agent_facts::executor::Settings {
                    model: Some("executor-model".into()),
                    thinking_level: Some(maka_agent_facts::execution::ThinkingLevel::Max),
                },
                content: id.into(),
                cwd: configuration.cwd.clone(),
                instructions: None,
            },
            binding: NativeBackend(adapter.clone()),
            configuration,
            request_fingerprint: Some(id.into()),
            source_messages: vec![],
        };
        let running = engine
            .start_executor(log.store(), input, CancellationToken::new())
            .await
            .unwrap();
        assert!(running.handoff().is_none());
        started.acquire().await.unwrap().forget();
        if id == "wait" {
            let call = running.cancellation();
            call.cancel();
        }
        let result = running.wait().await;
        if id == "complete" {
            result.unwrap();
        } else {
            assert!(matches!(result, Err(RunError::Cancelled)));
        }
        let old = retained.lock().unwrap().take().unwrap();
        assert!(matches!(
            old.output
                .emit(Output::OutputDelta {
                    text: "late".into()
                })
                .await,
            Err(Error::Cancelled)
        ));
    }
    engine.drain().await;
    let prefix = log.prefix(100, read_bytes).await.unwrap();
    for row in &prefix.events {
        if let Fact::ExecutorStarted { settings, .. } = &row.event.fact {
            assert_eq!(settings.model.as_deref(), Some("executor-model"));
            assert_eq!(
                settings.thinking_level,
                Some(maka_agent_facts::execution::ThinkingLevel::Max)
            );
        }
    }
    assert_eq!(
        prefix
            .events
            .iter()
            .filter(|row| matches!(row.event.fact, Fact::ExecutorCompleted { .. }))
            .count(),
        1
    );
    let completed_text = prefix
        .events
        .iter()
        .find_map(|row| match &row.event.fact {
            Fact::ExecutorCompleted { text } if row.event.invocation.turn_id == "complete" => {
                Some(text)
            }
            _ => None,
        })
        .expect("completed external result must be persisted before releasing settlement");
    assert!(
        completed_text == &answer,
        "completed external result lost original content"
    );
    assert!(
        prefix
            .events
            .iter()
            .any(|row| row.event.invocation.turn_id == "wait"
                && matches!(
                    row.event.fact,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Cancelled { .. }
                    }
                ))
    );
    assert!(!prefix.events.iter().any(|row| matches!(
        row.event.fact,
        Fact::ModelRequested { .. } | Fact::ToolDispatched { .. }
    )));

    let stream = log
        .session_stream_events("session", 0, prefix.high_water, 64, read_bytes)
        .await
        .unwrap();
    assert!(stream.events.iter().any(|event| event.invocation.turn_id == "wait"
        && matches!(&event.fact, maka_event_log::observation::StreamFact::InvocationEnded { interrupted, .. } if interrupted.len() == 1)));
    // A crash after the external dispatch cannot be downgraded to "never ran".
    // Recovery seals it without invoking the adapter or claiming cleanup.
    let crashed = Invocation {
        turn_id: "crashed".into(),
        run_id: "crashed".into(),
        invocation_id: "crashed".into(),
        session_id: "session".into(),
    };
    for stored in prefix
        .events
        .iter()
        .filter(|row| row.event.invocation.invocation_id == "complete")
    {
        if matches!(
            stored.event.fact,
            Fact::InvocationOpened { .. }
                | Fact::ExecutorStarted { .. }
                | Fact::ExecutorObserved { .. }
        ) {
            log.append(
                &maka_agent_facts::event::EventWrite::plain(
                    maka_agent_facts::event::RuntimeEvent::new(
                        crashed.clone(),
                        stored.event.fact.clone(),
                    ),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        }
    }
    assert!(
        log.invocation_recovery(&crashed, 32, 1024 * 1024)
            .await
            .unwrap()
            .unfinished_executor
    );
    assert_eq!(log.root().recover_invocations().await.unwrap(), 1);
    assert_eq!(log.root().recover_invocations().await.unwrap(), 0);
    let recovered = log.prefix(100, read_bytes).await.unwrap();
    assert!(recovered.project_invocation("crashed").unfinished_executor);
    assert!(recovered.events.iter().any(|row| row.event.invocation == crashed
        && matches!(&row.event.fact, Fact::InvocationEnded { outcome: InvocationOutcome::Failed { class, .. } } if class == "outcome_unknown")));
    assert_eq!(
        started.available_permits(),
        0,
        "recovery must not call the adapter"
    );
    log.shutdown().await.unwrap();
}

struct CleanupFault;
impl Provider for CleanupFault {
    fn execute(&self, _: Request, _: Context) -> BoxFuture<'static, Result<Outcome, Error>> {
        Box::pin(async { Err(Error::CleanupUnconfirmed) })
    }
}
async fn unconfirmed_executor(sql_failure: bool) {
    let temp = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&temp.path().join("executor.sqlite"))
            .await
            .unwrap(),
    );
    let engine = context::engine();
    if sql_failure {
        log.reject_terminal_writes();
    }
    let adapter = Arc::new(CleanupFault);
    let mut configuration = invocation::configuration(ToolMode::Direct);
    configuration.model = None;
    let running = engine
        .start_executor(
            log.store(),
            ExecutorInput {
                request: Request {
                    language: configuration.language,
                    invocation: Invocation {
                        session_id: "session".into(),
                        turn_id: "turn".into(),
                        run_id: "run".into(),
                        invocation_id: "invocation".into(),
                    },
                    conversation_key: "session".into(),
                    settings: Default::default(),
                    content: "question".into(),
                    cwd: configuration.cwd.clone(),
                    instructions: None,
                },
                binding: NativeBackend(adapter),
                configuration,
                request_fingerprint: Some("original cleanup request".into()),
                source_messages: vec![],
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let completion = running.completion().await;
    assert!(completion.result.is_err());
    if sql_failure {
        assert!(
            matches!(completion.result, Err(RunError::Commit(_))),
            "expected terminal commit failure, got {:?}",
            completion.result
        );
    }
    assert!(
        completion.cleanup.is_err(),
        "terminal SQL failure cannot clear original executor cleanup failure"
    );
    engine.drain().await;
}
#[tokio::test]
async fn executor_cleanup_failure_is_independent_of_ordinary_terminal_verdict() {
    tokio::time::timeout(Duration::from_secs(10), unconfirmed_executor(false))
        .await
        .unwrap();
}
#[tokio::test]
async fn executor_cleanup_failure_survives_terminal_sql_failure() {
    tokio::time::timeout(Duration::from_secs(10), unconfirmed_executor(true))
        .await
        .unwrap();
}
