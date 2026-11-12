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
use maka_agent_api::contract::{GoalDetail, GoalView, ScheduledTarget};
use maka_event_log::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_goal::goal::{Arm, Meter, Pending, Status};
use std::sync::atomic::AtomicUsize;

struct Sql(&'static str);
impl Statement for Sql {
    type Value = ();
    type Output = ();
    fn execute(self, c: &rusqlite::Connection) -> Result<Prepared<()>, StoreError> {
        c.execute_batch(self.0)?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

async fn stop(rig: &Rig, session: &str, run: RunId) -> TestResult<Value> {
    let mut call = rig
        .client
        .as_ref()
        .unwrap()
        .call(
            "agent",
            "stop".into(),
            json!({"sessionId":session,"runId":run}),
            Attachments::new(),
        )
        .await?;
    call.start().await?;
    assert!(matches!(call.receive().await?, Reply::Prepared { .. }));
    let reply = call.confirm(json!({"test":"stop-goal"})).await?;
    let Reply::Mutation { reply, cleanup } = reply else {
        return Err("stop did not return a mutation".into());
    };
    cleanup?;
    let outcome = match reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Ok(value),
        receipt => Err(format!("stop receipt: {receipt:?}").into()),
    };
    call.close().await?;
    outcome
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_pauses_goal_even_when_it_observes_another_run() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
    let posts = Arc::new(AtomicUsize::new(0));
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let serving = tokio::spawn(model_recovery::serve(
        listener,
        posts.clone(),
        cancel.clone(),
        Some(requests),
    ));
    let outcome = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(30),
        exercise(&mut rig, &posts, &mut received),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    cancel.cancel();
    let served = serving.await;
    assert!(matches!(&outcome, Ok(Ok(Ok(())))), "{outcome:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    served??;
    Ok(())
}

async fn current(rig: &Rig, session: &str) -> TestResult<GoalDetail> {
    let value = model_recovery::call(
        rig.client.as_ref().unwrap(),
        "agent",
        "goal",
        json!({"sessionId":session}),
    )
    .await?;
    let view: GoalView = serde_json::from_value(value)?;
    assert!(view.enabled);
    view.current.ok_or_else(|| "goal missing".into())
}

async fn exercise(
    rig: &mut Rig,
    posts: &AtomicUsize,
    received: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) -> TestResult<()> {
    let session = rig
        .start_configured(None, |config| config["goals"] = json!(true))
        .await?;
    rig.assemble(&session).await?;
    let owner = rig
        .captured
        .lock()
        .unwrap()
        .clone()
        .ok_or("owner missing")?;
    let driver = rig.driver.as_ref().unwrap();
    let observed = driver.access.execution().run_id;
    let view = driver.state.frontier(observed).await?;
    let NativeBackend::Model { model, .. } = &driver.backend else {
        unreachable!()
    };
    let config = owner.mutable_session(&session).await?.configuration;
    let grant = super::super::super::notifications::BackgroundApproval {
        target: ScheduledTarget {
            session_id: session.clone(),
            workspace: config.workspace,
            permissions: config.permissions,
            boundary_revision: config.boundary_revision,
            binding: config.binding,
        },
        model: ModelSelection {
            connection_id: model.source.accepted.binding.connection_id.clone(),
            model_id: model.source.accepted.binding.model.clone(),
        },
        accepted_model: model.source.accepted.clone(),
        thinking_level: None,
        language: Language::En,
    };
    {
        let _gate = owner.goals.gate.lock().await;
        owner
            .goals
            .repository
            .arm_with(
                &session,
                Arm {
                    operation_id: Uuid::new_v4(),
                    objective: "keep working".into(),
                    grant,
                    token_budget: None,
                    start: true,
                    language: Language::En,
                },
                Meter::default(),
                Some(Pending::Existing {
                    run: observed,
                    managed: false,
                }),
                vec![],
            )
            .await?;
    }
    let mut spec = view.spec.clone();
    spec.turn_id = Uuid::new_v4().to_string();
    spec.trigger = Trigger::Message {
        message_id: Uuid::new_v4().to_string(),
    };
    let older = Admission::new(spec.clone(), at(), vec![]);
    let older_run = older.run();
    let runs = owner.runs.state().await;
    driver.state.admit(older).await?;
    let older_claim = driver.state.claim(older_run).await?;
    drop(runs);
    spec.turn_id = Uuid::new_v4().to_string();
    spec.trigger = Trigger::Message {
        message_id: Uuid::new_v4().to_string(),
    };
    let later = Admission::new(spec, at(), vec![]);
    let run = later.run();
    let runs = owner.runs.state().await;
    driver.state.admit(later).await?;
    let claim = driver.state.claim(run).await?;
    drop(runs);
    assert_eq!(
        stop(&rig, &session, older_run).await?,
        json!({"requested":true})
    );
    assert_eq!(current(rig, &session).await?.status, Status::Active);

    let writer = rig.store.as_ref().unwrap().data_writer()?;
    writer.write(Sql("CREATE TRIGGER reject_goal_pause BEFORE UPDATE ON plugin_data
            WHEN NEW.package_id = 'maka.agent.goal' AND json_extract(NEW.value_json, '$.status') = 'paused'
            BEGIN SELECT RAISE(ABORT, 'goal_pause_rejected'); END;")).await?;
    let error = stop(&rig, &session, run).await.unwrap_err();
    assert!(error.to_string().contains("goal_pause_rejected"), "{error}");
    assert!(!driver.state.frontier(run).await?.stopped);
    assert_eq!(current(rig, &session).await?.status, Status::Active);
    writer.write(Sql("DROP TRIGGER reject_goal_pause")).await?;
    assert_eq!(stop(&rig, &session, run).await?, json!({"requested":true}));
    assert!(driver.state.frontier(run).await?.stopped);
    assert!(!driver.state.frontier(observed).await?.stopped);
    assert_eq!(current(rig, &session).await?.status, Status::Paused);

    let mut changes = owner.goal_changes();
    for (ended, ended_claim) in [(older_run, &older_claim), (run, &claim)] {
        let view = driver.state.frontier(ended).await?;
        driver
            .state
            .append(
                ended_claim,
                (&view).into(),
                vec![Change::new(
                    Fact::RunTerminated {
                        terminal: Terminal::Cancelled,
                        diagnostic: None,
                    },
                    at(),
                )],
                vec![],
            )
            .await?;
    }
    drop(older_claim);
    drop(claim);
    rig.append(
        vec![Fact::RunTerminated {
            terminal: Terminal::Completed,
            diagnostic: None,
        }],
        vec![],
    )
    .await?;
    loop {
        changes.borrow_and_update();
        let goal = current(rig, &session).await?;
        assert_eq!(goal.status, Status::Paused);
        assert_eq!(goal.iterations, 1);
        if !goal.pending {
            break;
        }
        changes.changed().await?;
    }
    assert_eq!(driver.state.latest_run(session.clone()).await?, Some(run));
    assert_eq!(posts.load(Ordering::SeqCst), 0);

    let goal = current(rig, &session).await?;
    let resumed = model_recovery::call(
            rig.client.as_ref().unwrap(), "agent", "changeGoal",
            json!({"kind":"control","sessionId":session,"goalId":goal.id,"revision":goal.revision,"action":"resume"}),
        ).await?;
    assert_eq!(resumed["kind"], "committed");
    let request: Value = serde_json::from_slice(
        &tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await?
            .ok_or("model request channel closed")?,
    )?;
    assert!(
        request["messages"]
            .as_array()
            .ok_or("missing model messages")?
            .iter()
            .any(|message| message["role"] == "user"
                && message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("keep working"))),
        "resumed request lacks the Goal objective: {request:#}"
    );
    let continued = driver
        .state
        .latest_run(session.clone())
        .await?
        .ok_or("resumed run missing")?;
    assert_ne!(continued, run);
    assert!(
        matches!(driver.state.frontier(continued).await?.spec.trigger, Trigger::Goal { goal_id } if goal_id == goal.id)
    );

    // A new stop command for the stopped Run cannot undo the explicit resume.
    assert_eq!(stop(&rig, &session, run).await?, json!({"requested":true}));
    assert_eq!(current(rig, &session).await?.status, Status::Active);
    Ok(())
}
