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

use super::service_tools::{Behavior, Counter, Setup};
use super::*;
use futures_util::FutureExt;
use maka_agent_authority::computer::{ComputerAccess, NativeCallContext};
use maka_agent_facts::{
    cells::CellEvent,
    durable::{FactId, UnixMillis},
    tools::ToolError,
};
use maka_agent_state::{Head, computer};
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeOwner,
};
use maka_plugin_core::operation::{OperationCleanup, RecoveryRef};
use std::sync::atomic::{AtomicUsize, Ordering};

const INTERRUPTED: &str = "Native input was physically interrupted in this turn";
const NO_EFFECT: &str = "Boundary-only observation finished without native input";

// The existing Computer catalog/Host binding dispatches this local observer.
// It holds the original Context but never opens an OS resource or an SDK VM.
struct ObserveComputer {
    captured: tokio::sync::mpsc::UnboundedSender<(Arc<dyn ComputerAccess>, RecoveryRef)>,
    release: Arc<Semaphore>,
}
impl Handler for ObserveComputer {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let captured = self.captured.clone();
        let release = self.release.clone();
        Box::pin(async move {
            assert_eq!(method, "evaluate");
            assert_eq!(input, json!({"code":"1"}));
            let access = context
                .native_context::<NativeCallContext>()
                .and_then(|capsule| capsule.computer())
                .expect("production selected-Computer dispatch must supply its actual capsule");
            let original = access
                .bind_original(&context)
                .await
                .map_err(|error| HandlerError::from(error.to_string()))?;
            captured
                .send((access.clone(), original))
                .unwrap_or_else(|_| panic!("Computer observer lost"));
            tokio::select! {
                permit = release.acquire() => permit.expect("original observer release").forget(),
                () = context.scope().cancellation.cancelled() => return Err("original observer cancelled".into()),
            }
            let message = match access.native_admission().await {
                Ok(()) => NO_EFFECT.to_owned(),
                Err(ToolError::Failed(message)) => message,
                Err(error) => panic!("native fence must not lose its live service: {error}"),
            };
            Ok(HandlerValue::Json(
                serde_json::to_value(maka_workspace_api::computer::ResultValue::Failed {
                    message,
                    state: maka_workspace_api::computer::ReplState::Fresh,
                })
                .unwrap(),
            ))
        })
    }
}
impl NativeOwner for ObserveComputer {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

async fn guarded_effect(
    access: &dyn ComputerAccess,
    effects: &AtomicUsize,
) -> Result<(), ToolError> {
    access.native_admission().await?;
    effects.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

fn admission_counts(facts: &[RecordedFact]) -> [usize; 4] {
    let mut counts = [0; 4];
    for recorded in facts {
        match &recorded.fact {
            Fact::ToolAdmitted { .. } => counts[0] += 1,
            Fact::ToolOriginalBound { .. } => counts[1] += 1,
            Fact::Cell {
                event: CellEvent::ChildPrepared { .. },
            } => counts[2] += 1,
            Fact::Cell {
                event: CellEvent::ChildAdmitted { .. },
            } => counts[3] += 1,
            _ => {}
        }
    }
    counts
}

#[tokio::test]
async fn actual_computer_native_gate_keeps_its_run_fence_across_rebinding_but_not_a_fresh_run() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (captured, mut received) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let observer = Arc::new(ObserveComputer {
        captured,
        release: release.clone(),
    });
    let unused_counter = Counter::new(Behavior::ComputerClosed);
    let setup = Setup::computer(unused_counter.clone())
        .named("cua_repl")
        .with_handler(observer.clone(), observer);
    let selection = setup.selection();
    assert_eq!(selection.method, "evaluate");
    assert_eq!(selection.result, contract::ToolResult::Computer);
    let fixture = Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(setup),
        |configuration| {
            configuration.permissions = WorkspacePermissions {
                access: WorkspaceAccess::DangerFullAccess,
                request_permissions: false,
            };
        },
    )
    .await;
    let result = std::panic::AssertUnwindSafe(async {
        let session = fixture.create("Actual Computer native-only fence consumer").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let advertised = request(&mut socket).await;
        assert!(advertised["tools"].as_array().unwrap().iter()
            .any(|tool| tool["function"]["name"] == "cua_repl"));
        service_tools::named_tool_response(&mut socket, "cua_repl", json!({"code":"1"})).await;
        let (original, reference) = received.recv().await.unwrap();
        let driver = fixture.live_access(&session).await;
        let execution = original.call().execution.clone();
        assert_eq!(&execution, driver.execution());
        assert!(Arc::ptr_eq(original.call().custody.as_ref().unwrap(), driver.custody()));
        assert_eq!(original.current().await.unwrap().permissions.access, WorkspaceAccess::DangerFullAccess);
        original.boundary().await.unwrap();
        original.native_admission().await.unwrap();
        let view = driver.fresh().await.unwrap();
        let maka_agent_facts::durable::AuthorizationObligation::Tool { tool: key } = original.target() else {
            panic!("actual selected Computer tool must own its original T1");
        };
        let admitted = view.tools.get(&maka_agent_state::fold::tool_key(key)).unwrap();
        assert_eq!(admitted.call.name, selection.name);
        assert_eq!(admitted.call.input.as_json().unwrap(), &json!({"code":"1"}));
        assert!(admitted.admitted && admitted.accepted.is_none());
        assert_eq!(admitted.original.as_ref(), Some(&reference));
        let before = admission_counts(&fixture.recorded_facts(&session).await);
        assert_eq!(before, [1, 1, 0, 0]);
        let computer = computer::ComputerStore::new(fixture.store.data_writer().unwrap());
        assert!(!computer.native_turn_interrupted(&execution).await.unwrap());
        let binding = FactId::new();
        let at = UnixMillis(now().try_into().unwrap());
        // Metadata is submitted under the original live claim and actual T1.
        // This does not construct an opaque SDK producer or grant authority.
        assert!(computer.append(driver.claim(), Head::from(&view), computer::Change {
            id: binding, at, fact: computer::Fact::NativeSourceBound {
                source: computer::NativeSource {
                    execution: execution.clone(), target: original.target().clone(),
                    original: reference.clone(), native_epoch: "unit-original-context".into(),
                    generation: "unit-original-generation".into(), operation: reference.operation.to_string(),
                },
            },
        }, vec![]).await.unwrap());
        assert!(computer.native_interrupted(&execution, binding, FactId::new(), at).await.unwrap());
        assert!(computer.native_turn_interrupted(&execution).await.unwrap());
        let effects = AtomicUsize::new(0);
        assert!(matches!(guarded_effect(original.as_ref(), &effects).await,
            Err(ToolError::Failed(message)) if message == INTERRUPTED));
        original.current().await.unwrap();
        original.boundary().await.unwrap();

        // Re-enter the real factory under the same still-current driver/custody.
        // A fresh caller allocation, as used by a replacement VM, cannot reset a Run fence.
        let replacement = driver.native_call(
            original.call().clone(), selection.name.clone(), CancellationToken::new(),
            selection.result == contract::ToolResult::Computer,
        ).await.unwrap().computer().unwrap();
        assert!(!Arc::ptr_eq(&original, &replacement));
        assert_eq!(replacement.call().execution, execution);
        replacement.current().await.unwrap();
        replacement.boundary().await.unwrap();
        assert!(matches!(guarded_effect(replacement.as_ref(), &effects).await,
            Err(ToolError::Failed(message)) if message == INTERRUPTED));
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        assert_eq!(unused_counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(admission_counts(&fixture.recorded_facts(&session).await), before,
            "blocked native calls cannot prepare children, admit new work or bind a new T1");
        let unchanged = driver.fresh().await.unwrap();
        let unchanged = unchanged.tools.get(&maka_agent_state::fold::tool_key(key)).unwrap();
        assert!(unchanged.admitted && unchanged.accepted.is_none());
        assert_eq!(unchanged.original.as_ref(), Some(&reference));
        release.add_permits(1);
        let (mut completion, _) = listener.accept().await.unwrap();
        request(&mut completion).await;
        response(&mut completion).await;
        fixture.drained().await;
        let observed = fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap();
        let (OperationOutcome::Returned { result: OperationResult::Success { value } }, OperationCleanup::Confirmed)
            = (observed.outcome, observed.cleanup) else { panic!("original Computer result must be known and cleaned up"); };
        assert!(matches!(serde_json::from_value::<maka_workspace_api::computer::ResultValue>(value).unwrap(),
            maka_workspace_api::computer::ResultValue::Failed { message, .. } if message == INTERRUPTED));
        assert!(fixture.owner.durable.frontier(execution.run_id).await.unwrap().terminal.is_some());
        drop(replacement);
        drop(original);
        drop(driver);

        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(&mut socket, "cua_repl", json!({"code":"1"})).await;
        let (fresh, fresh_reference) = received.recv().await.unwrap();
        assert_eq!(fresh.call().execution.session_id, session);
        assert_ne!(fresh.call().execution.run_id, execution.run_id);
        assert_ne!(fresh_reference, reference);
        fresh.current().await.unwrap();
        fresh.boundary().await.unwrap();
        fresh.native_admission().await.unwrap();
        assert!(!computer.native_turn_interrupted(&fresh.call().execution).await.unwrap());
        assert!(computer.native_turn_interrupted(&execution).await.unwrap(), "old fence remains canonical");
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        release.add_permits(1);
        let (mut completion, _) = listener.accept().await.unwrap();
        request(&mut completion).await;
        response(&mut completion).await;
        fixture.drained().await;
        drop(fresh);
    }).catch_unwind().await;
    release.add_permits(2);
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
