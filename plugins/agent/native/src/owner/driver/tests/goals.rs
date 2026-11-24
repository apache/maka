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
    let serving = model_recovery::serve(listener, posts.clone(), Some(requests)).await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(30),
        exercise(&mut rig, &posts, &mut received),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    serving.shutdown().await;
    assert!(matches!(&outcome, Ok(Ok(Ok(())))), "{outcome:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
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

/// Arm a Goal that observes the Rig's current Run as its first iteration.
async fn arm(
    owner: &Arc<Owner>,
    driver: &NativeDriver,
    session: &str,
    observed: RunId,
) -> TestResult<()> {
    let NativeBackend::Model { model, .. } = &driver.backend else {
        unreachable!()
    };
    let config = owner.mutable_session(session).await?.configuration;
    let grant = super::super::super::notifications::BackgroundApproval {
        target: ScheduledTarget {
            session_id: session.into(),
            workspace: config.workspace,
            permissions: config.permissions,
            boundary_revision: config.boundary_revision,
            binding: config.binding,
        },
        model: ModelSelection {
            service_tier: None,
            connection_id: model.source.accepted.binding.connection_id.clone(),
            model_id: model.source.accepted.binding.model.clone(),
        },
        accepted_model: model.source.accepted.clone(),
        thinking_level: None,
        language: Language::EN,
        sandbox_ceiling: None,
    };
    let _gate = owner.goals.gate.lock().await;
    owner
        .goals
        .repository
        .arm_with(
            session,
            Arm {
                operation_id: Uuid::new_v4(),
                objective: "keep working".into(),
                grant: crate::owner::scheduler::BackgroundGrant::Model(grant),
                token_budget: None,
                start: true,
                language: Language::EN,
            },
            Meter::default(),
            Some(Pending::Existing {
                run: observed,
                managed: false,
            }),
            vec![],
        )
        .await?;
    Ok(())
}

async fn exercise(
    rig: &mut Rig,
    posts: &AtomicUsize,
    received: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
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
    arm(&owner, driver, &session, observed).await?;
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
    // A worker notice queued before the user's Stop waits for the next Run.
    let source = driver.access.execution().clone();
    let route = owner.return_route(&source).await?;
    let notice = owner
        .prepare_notification(
            &source,
            &route,
            "held-worker-notice",
            |_| "WORKER_NOTICE_WHILE_STOPPED".into(),
            maka_agent_facts::message::MessageOrigin::BotWorker {
                session_id: "worker".into(),
            },
        )
        .await?
        .ok_or("worker notice was not queued")?;
    assert_eq!(
        stop(rig, &session, older_run).await?,
        json!({"requested":true})
    );
    assert_eq!(current(rig, &session).await?.status, Status::Active);

    let writer = rig.store.as_ref().unwrap().data_writer()?;
    writer.write(Sql("CREATE TRIGGER reject_goal_pause BEFORE UPDATE ON plugin_data
            WHEN NEW.package_id = 'maka.agent.goal' AND json_extract(NEW.value_json, '$.status') = 'paused'
            BEGIN SELECT RAISE(ABORT, 'goal_pause_rejected'); END;")).await?;
    let error = stop(rig, &session, run).await.unwrap_err();
    assert!(error.to_string().contains("goal_pause_rejected"), "{error}");
    assert!(!driver.state.frontier(run).await?.stopped);
    assert_eq!(current(rig, &session).await?.status, Status::Active);
    writer.write(Sql("DROP TRIGGER reject_goal_pause")).await?;
    assert_eq!(stop(rig, &session, run).await?, json!({"requested":true}));
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
    let queue = owner.durable.queue();
    assert_eq!(
        queue.read(session.clone()).await?.entries,
        [maka_agent_state::queue::QueueEntry {
            request: notice,
            placement: maka_agent_state::queue::Placement::Held,
        }]
    );

    let goal = current(rig, &session).await?;
    let resumed = model_recovery::call(
            rig.client.as_ref().unwrap(), "agent", "changeGoal",
            json!({"kind":"control","sessionId":session,"goalId":goal.id,"revision":goal.revision,"action":"resume"}),
        ).await?;
    assert_eq!(resumed["kind"], "committed");
    let request = tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await?
        .ok_or("model request channel closed")?;
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
    // Resuming the Goal is not blocked by the held notice; its Run reads it.
    assert!(
        request.to_string().contains("WORKER_NOTICE_WHILE_STOPPED"),
        "resumed request lacks the held notice: {request:#}"
    );
    assert!(queue.read(session.clone()).await?.entries.is_empty());
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
    assert_eq!(stop(rig, &session, run).await?, json!({"requested":true}));
    assert_eq!(current(rig, &session).await?.status, Status::Active);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_tells_the_next_iteration_why_one_failed_and_pauses_after_two() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let serving = MockAiBuilder::new()
        .handler_fn(move |req, _| {
            let _ = requests.send(req.raw_body.clone());
            TurnPlan::http_error(HttpErrorSpec::new(
                400,
                "invalid_request_error",
                "fixture rejected the goal",
            ))
        })
        .start_with_listener(listener)
        .await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
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
        arm(&owner, driver, &session, driver.access.execution().run_id).await?;
        let mut changes = owner.goal_changes();
        rig.append(
            vec![Fact::RunTerminated {
                terminal: Terminal::Failed,
                diagnostic: Some("fixture failure one".into()),
            }],
            vec![],
        )
        .await?;
        let request = received
            .recv()
            .await
            .ok_or("Goal iteration request missing")?;
        let messages = request["messages"]
            .as_array()
            .ok_or("Goal request messages missing")?;
        let failure_mentions = messages
            .iter()
            .filter(|message| message["content"].to_string().contains("fixture failure one"))
            .count();
        assert_eq!(
            failure_mentions, 1,
            "previous iteration failure must appear once via turn replay without Goal prompt duplication: {request:#}"
        );
        let goal = loop {
            changes.borrow_and_update();
            let goal = current(&rig, &session).await?;
            if goal.status != Status::Active && !goal.pending {
                break goal;
            }
            changes.changed().await?;
        };
        assert_eq!(goal.status, Status::Paused);
        // The observed Run is the first iteration; one dispatched iteration followed.
        assert_eq!(goal.iterations, 2);
        assert!(
            goal.note.contains("fixture rejected the goal"),
            "{}",
            goal.note
        );
        assert!(
            received.try_recv().is_err(),
            "a paused Goal sent another request"
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    serving.shutdown().await;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_wakeups_and_continuation_preserve_inherited_skill_catalog() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let serving = MockAiBuilder::new()
        .handler_fn(move |req, ctx| {
            let _ = requests.send(req.raw_body.clone());
            let tool = |id, name, args| {
                TurnPlan::new()
                    .push_tool_call(id, name, args)
                    .with_usage(Usage::new(100, 10))
                    .finish(FinishReason::ToolCalls)
            };
            let text = |s| {
                TurnPlan::new()
                    .push_text(s)
                    .with_usage(Usage::new(100, 5))
                    .finish(FinishReason::Stop)
            };
            match ctx.global_turn {
                1 => tool("call-compact", "CompactContext", json!({})),
                2 => text("Compacted checkpoint summary."),
                3 => tool(
                    "call-post-compact",
                    "exec",
                    json!({"code":r#"text("post-compact")"#}),
                ),
                _ => text("Continued after compaction"),
            }
        })
        .start_with_listener(listener)
        .await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let session = rig
            .start_configured(None, |config| config["todo"] = json!(true))
            .await?;
        rig.assemble(&session).await?;
        let driver = rig.driver.as_ref().unwrap();
        let seed = driver.access.execution().run_id;
        let base_spec = driver.state.frontier(seed).await?.spec;
        rig.append(
            vec![Fact::RunTerminated {
                terminal: Terminal::Completed,
                diagnostic: None,
            }],
            vec![],
        )
        .await?;

        let skill_receipt = |prompt: &str, rev: &str| maka_agent_facts::input::InputReceipt {
            source: maka_agent_facts::composition::SourceRevision {
                kind: maka_agent_facts::composition::SourceKind::Input,
                name: "maka.agent.skills".into(),
                package_id: "maka.skills".into(),
                entry_id: "skills".into(),
                activation: "act".into(),
                revision: rev.into(),
            },
            receipt: serde_json::to_value(maka_skills_api::contract::PreparationRecord {
                revision: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .into(),
                metadata_prompt: prompt.into(),
                invocation: Default::default(),
            })
            .unwrap(),
        };
        let message_input = |text: &str, preparation| maka_agent_facts::input::RunInput::Message {
            content: maka_agent_facts::input::MessageInput {
                text: text.into(),
                display_text: None,
                inline_references: None,
                directory_references: None,
                quotes: None,
                attachments: None,
                preparation,
            },
            request_fingerprint: None,
            source_messages: Vec::new(),
        };
        let admit_sealed = |driver: &NativeDriver,
                            base: &maka_agent_facts::durable::RunSpec,
                            trigger: Trigger,
                            input: maka_agent_facts::input::RunInput,
                            terminal: Terminal| {
            let state = driver.state.clone();
            let mut spec = base.clone();
            async move {
                let blob = ContentBlob::json(&input)?;
                spec.turn_id = Uuid::new_v4().to_string();
                spec.trigger = trigger;
                spec.input = blob.reference().clone();
                let admission = Admission::new(spec, at(), vec![blob]);
                let run = admission.run();
                state.admit(admission).await?;
                let claim = state.claim(run).await?;
                let view = state.frontier(run).await?;
                let diagnostic =
                    (terminal == Terminal::Failed).then(|| "scheduled run failed".into());
                state
                    .append(
                        &claim,
                        (&view).into(),
                        vec![Change::new(
                            Fact::RunTerminated {
                                terminal,
                                diagnostic,
                            },
                            at(),
                        )],
                        vec![],
                    )
                    .await?;
                Ok::<_, Box<dyn Error + Send + Sync>>(run)
            }
        };

        // 1. User message with a prepared non-empty skills catalog.
        admit_sealed(
            driver,
            &base_spec,
            Trigger::Message {
                message_id: Uuid::new_v4().to_string(),
            },
            message_input("start", vec![skill_receipt("SKILL_CATALOG_ALPHA", "rev-1")]),
            Terminal::Completed,
        )
        .await?;

        // 2. 18 consecutive background wakeups (> old 16-run cap) without skill receipts;
        // the 18th fails and is continued via continueRun.
        let mut last_bg = seed;
        for i in 0..18 {
            let terminal = if i == 17 {
                Terminal::Failed
            } else {
                Terminal::Completed
            };
            last_bg = admit_sealed(
                driver,
                &base_spec,
                Trigger::Schedule {
                    schedule_id: format!("sched-{i}"),
                },
                message_input(&format!("tick {i}"), vec![]),
                terminal,
            )
            .await?;
        }
        let failed_view = driver.state.frontier(last_bg).await?;
        let NativeBackend::Model { model, .. } = &driver.backend else {
            unreachable!()
        };
        let connection_id = &model.source.accepted.binding.connection_id;
        let model_id = &model.source.accepted.binding.model;
        let continued = model_recovery::call(
            rig.client.as_ref().unwrap(),
            "agent",
            "continueRun",
            json!({
                "sessionId": session,
                "sourceRunId": last_bg,
                "sourceHighWater": failed_view.revision,
                "model": {"connectionId": connection_id, "modelId": model_id}
            }),
        )
        .await?;
        assert_eq!(continued["kind"], "started", "{continued}");

        // Continuation must pass replay-signature verification, compact in-run,
        // execute a post-compaction tool call (entering view.baseline.is_some()),
        // and deliver the inherited skills catalog exactly once on every Main step.
        let mut captured: Vec<Value> = Vec::new();
        for i in 0..4 {
            let req = match tokio::time::timeout(Duration::from_secs(5), received.recv()).await {
                Ok(Some(req)) => req,
                other => {
                    let work = model_recovery::call(
                        rig.client.as_ref().unwrap(),
                        "agent",
                        "work",
                        json!({"sessionId":session,"target":{"kind":"run","runId":continued["execution"]["runId"]}}),
                    ).await?;
                    return Err(format!("step {i} stopped ({other:?}); received={} work={work}", captured.len()).into());
                }
            };
            captured.push(req);
        }
        for step in [0_usize, 2, 3] {
            let system = captured[step]["messages"]
                .as_array()
                .and_then(|m| m.iter().find(|msg| msg["role"] == "system"))
                .and_then(|msg| msg["content"].as_str())
                .ok_or("system message missing")?;
            assert_eq!(
                system.matches("SKILL_CATALOG_ALPHA").count(),
                1,
                "step {step} system prompt should inherit SKILL_CATALOG_ALPHA once: {system}"
            );
        }

        let continued_target = json!({"kind":"run","runId":continued["execution"]["runId"]});
        loop {
            let work = model_recovery::call(
                rig.client.as_ref().unwrap(),
                "agent",
                "work",
                json!({"sessionId":session,"target":continued_target}),
            )
            .await?;
            match work["execution"]["state"]["kind"].as_str() {
                Some("completed") => break,
                Some("failed" | "cancelled") => {
                    return Err(format!("continuation failed: {work}").into());
                }
                _ => tokio::task::yield_now().await,
            }
        }

        // 3. An interactive user turn without any skill receipt (e.g. unconfigured
        // skill library) does not inherit prior skills and terminates inheritance
        // for subsequent background wakeups.
        let bare_user = admit_sealed(
            driver,
            &base_spec,
            Trigger::Message {
                message_id: Uuid::new_v4().to_string(),
            },
            message_input("bare user turn", vec![]),
            Terminal::Completed,
        )
        .await?;
        let bare_view = driver.state.frontier(bare_user).await?;
        let bare_input = message_input("bare user turn", vec![]);
        let mut system = None;
        super::super::super::driver_model::resolve_input_skills(
            &driver.state,
            &bare_view,
            &bare_input,
            &mut system,
        )
        .await?;
        assert!(
            system.is_none(),
            "interactive user turn without receipt must not inherit prior skills: {system:?}"
        );

        let after_bare = admit_sealed(
            driver,
            &base_spec,
            Trigger::Schedule {
                schedule_id: "sched-after-bare".into(),
            },
            message_input("tick after bare user", vec![]),
            Terminal::Completed,
        )
        .await?;
        let after_bare_view = driver.state.frontier(after_bare).await?;
        let after_bare_input = message_input("tick after bare user", vec![]);
        let mut system = None;
        super::super::super::driver_model::resolve_input_skills(
            &driver.state,
            &after_bare_view,
            &after_bare_input,
            &mut system,
        )
        .await?;
        assert!(
            system.is_none(),
            "background wakeup after interactive user turn without skills must not resurrect old skills: {system:?}"
        );

        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    serving.shutdown().await;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}
