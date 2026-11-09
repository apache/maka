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

use super::external_support::{configured, input, native_task, packet, release, setup};
use super::*;
use futures_util::FutureExt;
use tokio::io::BufReader;

#[tokio::test]
async fn native_external_cleanup_sql_failure_retains_original_ack_until_committed() {
    use maka_agent_facts::durable::{ExternalTaskId, Fact, RunId, Terminal};
    use maka_event_log::writeback::{Notification, Prepared, Statement};
    use maka_plugin_core::operation::{
        OperationCleanup, OperationOutcome, OperationResult, Receipt,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    type Attempt = (String, i64, i64, Vec<u8>);
    #[derive(Default)]
    struct Audit {
        first: Option<Attempt>,
        count: usize,
        mismatch: bool,
    }
    struct PermitOnDrop(Arc<AtomicBool>);
    impl Drop for PermitOnDrop {
        fn drop(&mut self) {
            // A failed assertion must not leave the fixture's original writer permanently rejected.
            self.0.store(false, Ordering::SeqCst);
        }
    }
    struct InstallFault {
        run: RunId,
        task: ExternalTaskId,
        audit: Arc<StdMutex<Audit>>,
        attempted: Arc<Notify>,
        reject: Arc<AtomicBool>,
    }
    impl Statement for InstallFault {
        type Value = ();
        type Output = ();
        fn execute(
            self,
            c: &rusqlite::Connection,
        ) -> Result<Prepared<()>, maka_event_log::StoreError> {
            c.create_scalar_function(
                "accept_original_external_cleanup",
                4,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |context| {
                    let attempt = (
                        context.get::<String>(0)?,
                        context.get::<i64>(1)?,
                        context.get::<i64>(2)?,
                        context.get::<Vec<u8>>(3)?,
                    );
                    let mut audit = self.audit.lock().unwrap();
                    audit.count += 1;
                    if let Some(first) = &audit.first {
                        let differs = first != &attempt;
                        audit.mismatch |= differs;
                    } else {
                        audit.first = Some(attempt);
                    }
                    self.attempted.notify_one();
                    Ok(!self.reject.load(Ordering::SeqCst))
                },
            )?;
            c.execute_batch(&format!(
                "CREATE TEMP TRIGGER reject_original_external_cleanup BEFORE INSERT ON main.agent_facts
                 WHEN NEW.run='{}' AND EXISTS(
                   SELECT 1 FROM contents c WHERE c.id=NEW.body_content_id
                   AND json_extract(c.payload,'$.fact.kind')='external_task_cleanup_observed'
                   AND json_extract(c.payload,'$.fact.task')='{}'
                   AND json_extract(c.payload,'$.fact.cleanup.kind')='confirmed'
                 ) AND NOT accept_original_external_cleanup(
                   NEW.id,NEW.at,NEW.schema_version,
                   (SELECT payload FROM contents WHERE id=NEW.body_content_id))
                 BEGIN SELECT RAISE(ABORT,'original cleanup ACK SQL rejection'); END;",
                self.run, self.task
            ))?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::METADATA,
            })
        }
        fn committed((): ()) {}
        fn isolated_rejection(_: &maka_event_log::StoreError) -> bool {
            false
        }
    }
    struct RemoveFault;
    impl Statement for RemoveFault {
        type Value = ();
        type Output = ();
        fn execute(
            self,
            c: &rusqlite::Connection,
        ) -> Result<Prepared<()>, maka_event_log::StoreError> {
            c.execute_batch("DROP TRIGGER temp.reject_original_external_cleanup")?;
            c.remove_function("accept_original_external_cleanup", 4)?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::METADATA,
            })
        }
        fn committed((): ()) {}
        fn isolated_rejection(_: &maka_event_log::StoreError) -> bool {
            false
        }
    }

    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.tools = vec![super::external_support::host_tool("observe", "SessionRead")];
        }).await;
        let _shutdown_on_failure = f.owner.stop.clone().drop_guard();
        let reject = Arc::new(AtomicBool::new(true));
        let _permit_on_failure = PermitOnDrop(reject.clone());
        let session = f.create("Original external cleanup SQL ACK").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        let accepted = f.mutation(2, "send", input(&session, "complete"), Uuid::new_v4()).await.unwrap();
        assert_eq!(accepted["kind"], "queued");
        let run = f.delivered_run(&accepted).await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let mut physical = f.owner.physical_changes();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        let original = loop {
            changes.borrow_and_update();
            let original = native_task(&f, &session).await;
            assert_eq!(original.execution.run_id, run);
            if original.binding.is_some() { break original; }
            assert!(original.state.closed.is_none());
            changes.changed().await.unwrap();
        };
        let task_id = original.state.task;
        let plan = json!({"calls":[{"callId":1,"name":"SessionRead","input":{"sessionId":session}}]});
        control.get_mut().write_all(format!("{plan}\n").as_bytes()).await.unwrap();
        packet(&mut control, "responsive").await;
        let reply = packet(&mut control, "tool_result").await;
        let result: Value = serde_json::from_str(reply["reply"]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(result["session"]["id"], session);
        packet(&mut control, "output").await;

        let audit = Arc::new(StdMutex::new(Audit::default()));
        let attempted = Arc::new(Notify::new());
        f.store.data_writer().unwrap().write(InstallFault {
            run, task: task_id, audit: audit.clone(), attempted: attempted.clone(), reject,
        }).await.unwrap();
        release(&mut control).await;
        packet(&mut control, "terminal").await;
        assert!(f.owner.durable.frontier(run).await.unwrap().external.unwrap().closed.is_none());
        release(&mut control).await;
        let first = loop {
            let notified = attempted.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(first) = audit.lock().unwrap().first.clone() { break first; }
            notified.await;
        };
        f.drained().await;
        let (scope, writer, pins) = loop {
            physical.borrow_and_update();
            let scopes = f.owner.runs.state().await.retained_cleanup.get(&session).cloned().unwrap_or_default();
            let Some(scope) = scopes.first() else {
                physical.changed().await.unwrap();
                continue;
            };
            let driver = match scope.original_driver_for_test(run) {
                Ok(driver) => driver,
                Err("busy") => { tokio::task::yield_now().await; continue; }
                Err(error) => panic!("original source disappeared with an unacknowledged batch: {error}"),
            };
            let crate::owner::driver::NativeBackend::Executor(executor) = &driver.backend else {
                panic!("original external driver");
            };
            if !executor.workers.is_empty() {
                let workers = executor.workers.clone();
                drop(driver);
                workers.wait().await;
                continue;
            }
            let retained = executor.retained.lock().await;
            assert!(retained.iter().all(|source| matches!(source, crate::owner::driver_executor::RetainedSource::Cleanup(_))),
                "physical Root resources must be settled before testing only the SQL ACK debt");
            assert!(retained.iter().any(|source| matches!(source,
                crate::owner::driver_executor::RetainedSource::Cleanup(publication)
                    if publication.fact_id().to_string() == first.0)));
            let writer = driver.access.data_writer().unwrap();
            let pins = f.store.observe_work_settlement(driver.access.custody().as_ref(), &session).unwrap();
            break (scope.clone(), writer, pins);
        };
        let before = f.owner.durable.frontier(run).await.unwrap();
        let task = before.external.as_ref().unwrap();
        assert_eq!(task.task, task_id);
        assert_eq!(task.cleanup, OperationCleanup::Unconfirmed);
        let closed = task.closed.clone().expect("actual native terminal before cleanup ACK");
        assert_eq!(closed.outcome, Terminal::Completed);
        assert!(!f.recorded_facts(&session).await.iter().any(|row| row.run == run &&
            matches!(&row.fact, Fact::ExternalTaskCleanupObserved { task, .. } if *task == task_id)));
        let binding = original.binding.as_ref().unwrap();
        let evidence = maka_process::isolated::closed_evidence(&binding.resource).await.unwrap()
            .expect("original tracked group and streams physically closed");
        assert_eq!(evidence.snapshot, binding.snapshot);
        drop(evidence);
        assert!(matches!(pins.wait().await.unwrap_err().underlying(), maka_event_log::StoreError::CleanupUnconfirmed(_)));
        let sdk_operation = {
            let originals = super::external_support::host_effects(&f, &session).await;
            let originals: Vec<_> = originals.iter().filter(|(descriptor, _)|
                descriptor.execution == original.execution && descriptor.name == "SessionRead").collect();
            assert_eq!(originals.len(), 1);
            let (descriptor, effect) = originals[0];
            assert!(effect.admitted && effect.rejected.is_none());
            assert_eq!(effect.cleanup, OperationCleanup::Confirmed);
            if let Some(observation) = &effect.observation {
                assert!(matches!(&observation.receipt, Receipt::Recorded {
                    outcome: OperationOutcome::Returned { result: OperationResult::Success { .. } },
                    cleanup: OperationCleanup::Confirmed,
                }));
            } else {
                assert!(effect.reference.is_none() && effect.returned.is_some());
            }
            descriptor.operation_id.clone()
        };

        writer.write(RemoveFault).await.unwrap();
        drop(writer);
        loop {
            changes.borrow_and_update();
            physical.borrow_and_update();
            let settled = f.owner.durable.frontier(run).await.unwrap();
            let task = settled.external.as_ref().unwrap();
            assert_eq!(task.task, task_id);
            assert_eq!(task.closed.as_ref(), Some(&closed));
            let retained = f.owner.runs.state().await.retained_cleanup.get(&session)
                .is_some_and(|scopes| scopes.iter().any(|candidate| Arc::ptr_eq(candidate, &scope)));
            if task.cleanup == OperationCleanup::Confirmed && !retained { break; }
            tokio::select! {
                changed = changes.changed() => changed.unwrap(),
                changed = physical.changed() => changed.unwrap(),
            }
        }
        pins.wait().await.unwrap();
        let path = f.session_database(&session);
        let rows: Vec<Attempt> = tokio::task::spawn_blocking(move || {
            let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let mut query = db.prepare(
                "SELECT f.id,f.at,f.schema_version,c.payload FROM agent_facts f JOIN contents c ON c.id=f.body_content_id
                 WHERE f.run=? AND json_extract(c.payload,'$.fact.kind')='external_task_cleanup_observed'
                 AND json_extract(c.payload,'$.fact.task')=? AND json_extract(c.payload,'$.fact.cleanup.kind')='confirmed'"
            ).unwrap();
            let rows = query.query_map(rusqlite::params![run.to_string(), task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            rows
        }).await.unwrap();
        assert_eq!(rows, vec![first]);
        let audited = audit.lock().unwrap();
        assert!(audited.count >= 1);
        assert!(!audited.mismatch, "every SQL attempt must use the first frozen id/at/schema/body");
        drop(audited);
        loop {
            changes.borrow_and_update();
            let observed = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
            assert_eq!(observed["kind"], "delivered");
            assert_eq!(observed["execution"]["runId"], json!(run));
            match observed["execution"]["state"]["kind"].as_str() {
                Some("completed") => break,
                Some("admitted" | "running" | "waiting" | "blocked") => changes.changed().await.unwrap(),
                unexpected => panic!("cleanup ACK cannot change the native Completed outcome: {unexpected:?}"),
            }
        }
        let final_id = &closed.final_message.as_ref().unwrap().message_id;
        let facts = f.recorded_facts(&session).await;
        let answer: String = facts.iter().filter_map(|row| match &row.fact {
            Fact::ExternalTaskObserved { task, output: maka_agent_facts::executor::Output::OutputDelta { message_id, text, .. }, .. }
                if row.run == run && *task == task_id && message_id == final_id => Some(text.as_str()),
            _ => None,
        }).collect();
        assert_eq!(answer, "committed output");
        assert_eq!(facts.iter().filter(|row| row.run == run && matches!(row.fact, Fact::ExternalTaskPrepared { .. })).count(), 1);
        let sdk = super::external_support::host_effects(&f, &session).await;
        assert_eq!(sdk.iter().filter(|(descriptor, _)| descriptor.execution == original.execution && descriptor.name == "SessionRead")
            .map(|(descriptor, _)| descriptor.operation_id.clone()).collect::<Vec<_>>(), vec![sdk_operation]);
        assert_eq!(f.latest_run(&session).await.execution().run_id, run);
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.expect("original external cleanup ACK must settle within its original scope");
}

#[tokio::test]
async fn native_external_eof_without_terminal_releases_root_resources() {
    use maka_agent_facts::durable::Fact;
    use maka_plugin_core::operation::OperationCleanup;
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Root EOF without native terminal").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        let operation = Uuid::new_v4();
        let request = input(&session, "exit0");
        let accepted = f.mutation(2, "send", request.clone(), operation).await.unwrap();
        assert_eq!(accepted["kind"], "queued");
        let run = f.delivered_run(&accepted).await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let mut physical = f.owner.physical_changes();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        release(&mut control).await;
        packet(&mut control, "output").await;
        let original = native_task(&f, &session).await;
        assert_eq!(original.execution.run_id, run);
        let pins = {
            let runs = f.owner.runs.state().await;
            let control = runs.controls.get(&session).unwrap();
            assert_eq!(control.execution.run_id, run);
            let access = control.access.upgrade().unwrap();
            f.store.observe_work_settlement(access.custody().as_ref(), &session).unwrap()
        };
        release(&mut control).await;
        f.drained().await;
        loop {
            physical.borrow_and_update();
            let retained = f.owner.runs.state().await.retained_cleanup.get(&session)
                .is_some_and(|scopes| !scopes.is_empty());
            if !retained && pins.wait().await.is_ok() { break; }
            physical.changed().await.unwrap();
        }
        loop {
            changes.borrow_and_update();
            let view = f.owner.durable.frontier(run).await.unwrap();
            let task = view.external.as_ref().unwrap();
            assert_eq!(task.task, original.state.task);
            assert!(task.closed.is_none(), "EOF is not a native business terminal");
            assert!(!view.stopped && view.terminal.is_none());
            if task.cleanup == OperationCleanup::Confirmed { break; }
            changes.changed().await.unwrap();
        }
        let observed = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
        assert_eq!(observed["execution"]["runId"], json!(run));
        assert_eq!(observed["execution"]["state"]["kind"], "blocked");
        assert_eq!(f.mutation(2, "send", request, operation).await.unwrap(), accepted);
        assert_eq!(f.recorded_facts(&session).await.iter().filter(|row| row.run == run && matches!(row.fact, Fact::ExternalTaskPrepared { .. })).count(), 1);
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.expect("Root custody must settle independently of an unknown native business outcome");
}

#[tokio::test]
async fn native_external_identity_persistence_failure_prevents_prompt_submission() {
    tokio::time::timeout(Duration::from_secs(40),async {
        let (f,listener)=setup("http://127.0.0.1:9/v1").await;
        let session=f.create("Task admission persistence failure").await;
        let db=rusqlite::Connection::open(f.session_database(&session)).unwrap();
        db.execute_batch("CREATE TRIGGER reject_native_admission BEFORE INSERT ON agent_facts WHEN (SELECT json_extract(CAST(payload AS TEXT), '$.kind') FROM contents WHERE id=NEW.body_content_id) = 'external_task_admitted' BEGIN SELECT RAISE(FAIL, 'injected native admission persistence failure'); END;").unwrap();
        let accepted=f.mutation(2,"send",input(&session,"must-not-be-prompted"),Uuid::new_v4()).await.unwrap();f.drained().await;
        assert!(listener.accept().now_or_never().is_none(),"failed canonical admission cannot start any native prompt producer");
        let task=native_task(&f,&session).await;assert!(!task.state.admitted);assert!(task.binding.is_none());assert_eq!(serde_json::to_value(task.execution.run_id).unwrap(),accepted["runId"]);
        let observed=work(&f,&session,&accepted).await;assert_eq!(observed["execution"]["state"],"failed","canonical admission rejection fails without invoking the native handler");
        assert!(!f.recorded_facts(&session).await.iter().any(|row|matches!(row.fact,maka_agent_facts::durable::Fact::ExternalTaskBound {..}|maka_agent_facts::durable::Fact::ExternalTaskObserved {..})));
        db.execute_batch("DROP TRIGGER reject_native_admission").unwrap();assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_external_exited_worker_with_an_escaped_stdout_holder_returns_unconfirmed_instead_of_hanging()
 {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("External inherited pipe custody").await;
        let request_permissions = f
            .owner
            .session(&session)
            .await
            .unwrap()
            .configuration
            .permissions
            .request_permissions;
        super::super::files::change(
            &f,
            &session,
            "danger_full_access",
            request_permissions,
            false,
        )
        .await;
        let accepted = f
            .mutation(
                2,
                "send",
                input(&session, "pipe-holder-crash"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "queued");
        assert_eq!(accepted["sessionId"], session);
        assert!(accepted["messageId"].is_string());
        let run = f.delivered_run(&accepted).await;
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        release(&mut control).await;
        packet(&mut control, "output").await;
        release(&mut control).await;
        let escaped = packet(&mut control, "escaped").await;
        let pid = escaped["pid"].as_u64().unwrap().to_string();
        let result = std::panic::AssertUnwindSafe(async {
            tokio::time::timeout(Duration::from_secs(8), f.drained())
                .await
                .expect("root exit must bound the protocol drain even while stdout remains open");
            assert!(
                tokio::process::Command::new("/bin/kill")
                    .args(["-0", &pid])
                    .status()
                    .await
                    .unwrap()
                    .success(),
                "the pipe holder must still exist when settlement is classified"
            );
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"]["kind"],
                "blocked"
            );
            let original = native_task(&f, &session).await;
            assert_eq!(original.execution.run_id, run);
            assert_eq!(original.execution.session_id, session);
            assert!(original.state.closed.is_none());
            assert_ne!(
                original.state.cleanup,
                maka_plugin_core::operation::OperationCleanup::Confirmed
            );
            assert!(
                !f.app.shutdown_if_idle().await.unwrap(),
                "the original live I/O custodian must keep retirement busy"
            );
        })
        .catch_unwind()
        .await;
        assert!(
            tokio::process::Command::new("/bin/kill")
                .args(["-KILL", &pid])
                .status()
                .await
                .unwrap()
                .success()
        );
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_clean_preparation_failure_does_not_reuse_or_mutate_previous_task_binding() {
    use super::external_support::{input_runtime, native_task};
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut paths = None;
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            let command = settings
                .external
                .as_mut()
                .unwrap()
                .commands
                .claude
                .as_mut()
                .unwrap();
            let node = std::path::Path::new(&command.env["PATH"]).join(&command.executable);
            let launch = settings.workspace_roots[0]
                .path
                .join("claude-fixture-launch");
            command.executable = launch.to_str().unwrap().into();
            paths = Some((node, launch));
        })
        .await;
        let (node, launch) = paths.unwrap();
        let session = f.create("Claude preparation recovery").await;
        let failed = f
            .mutation(
                2,
                "send",
                input_runtime(&session, "claude", "complete"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        f.drained().await;
        assert_eq!(
            work(&f, &session, &failed).await["execution"]["state"],
            "failed"
        );
        let original = native_task(&f, &session).await;
        assert!(original.state.admitted);
        assert!(original.binding.is_none());
        assert_eq!(
            original.state.observed, 0,
            "command resolution failure occurs before native input/ACK"
        );
        assert!(!f.recorded_facts(&session).await.iter().any(|row| matches!(
            row.fact,
            maka_agent_facts::durable::Fact::ExternalTaskBound { .. }
                | maka_agent_facts::durable::Fact::ExternalTaskObserved { .. }
        )));
        assert!(listener.accept().now_or_never().is_none());
        let mut original: Option<super::external_support::NativeTaskSource> = None;
        for resume in [false, true] {
            std::os::unix::fs::symlink(&node, &launch).unwrap();
            let accepted = f
                .mutation(
                    2,
                    "send",
                    input_runtime(&session, "claude", "complete"),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            assert!(
                opened["request"].get("resume").is_none(),
                "every admitted task starts a fresh private CLI"
            );
            assert_eq!(opened["request"]["uuid"].as_str().is_some(), true);
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            packet(&mut control, "terminal").await;
            release(&mut control).await;
            f.drained().await;
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"],
                "completed"
            );
            let record = native_task(&f, &session).await;
            if original.is_none() {
                original = Some(record);
            }
            std::fs::remove_file(&launch).unwrap();
            if !resume {
                let failed = f
                    .mutation(
                        2,
                        "send",
                        input_runtime(&session, "claude", "complete"),
                        Uuid::new_v4(),
                    )
                    .await
                    .unwrap();
                f.drained().await;
                assert_eq!(
                    work(&f, &session, &failed).await["execution"]["state"],
                    "failed"
                );
                let failed_task = native_task(&f, &session).await;
                assert!(failed_task.binding.is_none());
                assert_eq!(failed_task.state.observed, 0);
                assert_ne!(
                    failed_task.state.task,
                    original.as_ref().unwrap().state.task,
                    "failed fresh preparation cannot borrow an older Task binding"
                );
                let before = original.as_ref().unwrap();
                let unchanged = f
                    .owner
                    .durable
                    .frontier(before.execution.run_id)
                    .await
                    .unwrap()
                    .external
                    .unwrap();
                assert_eq!(
                    unchanged.binding, before.state.binding,
                    "preparation failure cannot alter an earlier original task"
                );
                assert_eq!(unchanged.closed, before.state.closed);
            }
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn claude_api_error_requires_result_and_followup_uses_a_new_private_task() {
    use super::external_support::{input_runtime, native_task};
    tokio::time::timeout(Duration::from_secs(60),async {
        let (f,listener)=setup("http://127.0.0.1:9/v1").await;let session=f.create("Claude API failure recovery").await;let mut previous=None;
        for message in ["api-error","complete"] {
            let accepted=f.mutation(2,"send",input_runtime(&session,"claude",message),Uuid::new_v4()).await.unwrap();let mut control=BufReader::new(listener.accept().await.unwrap().0);let opened=packet(&mut control,"opened").await;
            assert!(opened["request"].get("resume").is_none());release(&mut control).await;packet(&mut control,"output").await;
            let original=native_task(&f,&session).await;assert!(original.state.closed.is_none(),"assistant API error text is not a native terminal");assert_eq!(serde_json::to_value(original.execution.run_id).unwrap(),accepted["runId"]);
            release(&mut control).await;packet(&mut control,"terminal").await;release(&mut control).await;f.drained().await;
            assert_eq!(work(&f,&session,&accepted).await["execution"]["state"],if message=="api-error" {"failed"} else {"completed"});
            let original=native_task(&f,&session).await;let binding=original.binding.as_ref().expect("original native acknowledgement");
            assert_eq!(original.state.closed.as_ref().unwrap().outcome,if message=="api-error" {maka_agent_facts::durable::Terminal::Failed} else {maka_agent_facts::durable::Terminal::Completed});
            if let Some((task,resource))=&previous {assert_ne!(&original.state.task,task);assert_ne!(&binding.resource.resource_ref,resource);}previous=Some((original.state.task,binding.resource.resource_ref.clone()));
        }
        assert!(f.recorded_facts(&session).await.iter().any(|row|matches!(&row.fact,maka_agent_facts::durable::Fact::ExternalTaskClosed {outcome:maka_agent_facts::durable::Terminal::Failed,diagnostic:Some(message),..} if message.contains("FIXTURE_API_FAILURE"))));f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
