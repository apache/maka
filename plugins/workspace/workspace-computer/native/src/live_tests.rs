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

//! Product evaluation and canonical Run custody on a disposable Linux desktop.
//! The embedding below does not replace Host transport or permission UI tests.
use super::*;
use maka_agent_api::{
    contract::{Workspace, WorkspaceAccess, WorkspacePermissions},
    session::StoredSessionConfiguration,
};
use maka_agent_facts::{
    event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, LogScope, RuntimeEvent,
        StoredEvent, ToolOutcome,
    },
    execution::{
        ApprovalPolicy, CollaborationMode, InvocationConfiguration, SandboxMode, ToolComposition,
        ToolMode, WorkspaceOrigin,
    },
    interaction::{
        ClosureReason, Decision, InteractionOutcome, InteractionRecord, InteractionRequest,
    },
    language::Language,
    tool_call::{HostSdkParent, ToolCallIdentity},
    tools::ToolJournal,
    workspace::{BindingStamp, PermissionBasis},
};
use maka_capabilities::call::{Identity, Issuer};
use maka_code_runtime::CellOutput;
use maka_event_log::{
    SessionStore,
    root::{RootNamespaces, RootOwner},
    root_store::{InvocationEffects, SessionExecutionLease},
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use uuid::Uuid;

async fn capture(path: PathBuf, value: Value) {
    tokio::task::spawn_blocking(move || {
        std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    })
    .await
    .unwrap();
}

struct Window {
    child: Option<Child>,
    connection: tokio::io::BufReader<tokio::net::UnixStream>,
    _socket_directory: tempfile::TempDir,
    id: u64,
    events: Vec<Value>,
}
impl Window {
    async fn open(directory: &Path) -> Self {
        let binary = std::env::var_os("MAKA_COMPUTER_LIVE_FIXTURE_BIN")
            .expect("explicit prebuilt repl_browser fixture ELF is required");
        // C:-mapped artifact storage need not support Unix socket nodes.
        let socket_base = std::env::var_os("MAKA_COMPUTER_LIVE_SOCKET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        let socket_directory = tokio::task::spawn_blocking(move || {
            tempfile::Builder::new()
                .prefix("maka-native-live-")
                .tempdir_in(socket_base)
                .unwrap()
        })
        .await
        .unwrap();
        let socket = socket_directory.path().join("wheel.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let mut child = ChildOwner(Some(
            Command::new(binary)
                .args([
                    "--exact",
                    "linux_wheel::fixture_process",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("MAKA_WHEEL_FIXTURE_SOCKET", socket)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        ));
        let (connection, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .expect("owned fixture did not connect")
            .unwrap();
        let mut window = Self {
            child: child.0.take(),
            connection: tokio::io::BufReader::new(connection),
            _socket_directory: socket_directory,
            id: 0,
            events: vec![],
        };
        let reply = window.request(json!({"command":"Create"})).await;
        keys(&reply, &["response", "window", "pid"]);
        assert_eq!(reply["response"], "Created");
        let pid = reply["pid"].as_u64().unwrap();
        assert_eq!(pid, u64::from(window.child.as_ref().unwrap().id()));
        assert_ne!(pid, u64::from(std::process::id()));
        window.id = reply["window"].as_u64().unwrap();
        u32::try_from(window.id).unwrap();
        capture(
            directory.join("fixture.json"),
            json!({"window":window.id,"fixture_pid":pid,"runtime_pid":std::process::id()}),
        )
        .await;
        window
    }
    async fn request(&mut self, request: Value) -> Value {
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        self.connection.get_mut().write_all(&bytes).await.unwrap();
        let mut line = String::new();
        let count = tokio::time::timeout(
            Duration::from_secs(10),
            self.connection.read_line(&mut line),
        )
        .await
        .expect("owned fixture did not reply")
        .unwrap();
        assert_ne!(count, 0, "owned fixture closed its control socket");
        serde_json::from_str(&line).unwrap()
    }
    async fn observe(&mut self, run: &Run, label: &str) -> usize {
        let reply = self
            .request(json!({"command":"Events","window":self.id}))
            .await;
        keys(&reply, &["response", "events"]);
        assert_eq!(reply["response"], "Events");
        for event in reply["events"].as_array().unwrap() {
            keys(
                event,
                &[
                    "press",
                    "event",
                    "detail",
                    "event_x",
                    "event_y",
                    "response_type",
                    "time",
                ],
            );
            event["press"].as_bool().unwrap();
            u32::try_from(event["event"].as_u64().unwrap()).unwrap();
            u8::try_from(event["detail"].as_u64().unwrap()).unwrap();
            i16::try_from(event["event_x"].as_i64().unwrap()).unwrap();
            i16::try_from(event["event_y"].as_i64().unwrap()).unwrap();
            u8::try_from(event["response_type"].as_u64().unwrap()).unwrap();
            u32::try_from(event["time"].as_u64().unwrap()).unwrap();
            self.events.push(event.clone());
        }
        run.record(label, json!({"window":self.id,"events":self.events}))
            .await;
        self.events.len()
    }
    async fn finish(mut self) {
        let reply = self.request(json!({"command":"Shutdown"})).await;
        keys(&reply, &["response"]);
        assert_eq!(reply["response"], "Shutdown");
        let mut child = self.child.take().unwrap();
        assert!(
            tokio::task::spawn_blocking(move || child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }
}
fn keys(value: &Value, expected: &[&str]) {
    let actual: std::collections::BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        actual,
        expected
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
    );
}
struct ChildOwner(Option<Child>);
impl Drop for ChildOwner {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        drop(ChildOwner(self.child.take()));
    }
}

mod audio;
mod browser_clipboard;
mod browser_dialogs;

struct Run {
    owner: Arc<Computer>,
    store: SessionStore,
    invocation: Invocation,
    basis: PermissionBasis,
    issuer: Issuer,
    effects: InvocationEffects,
    lease: Option<SessionExecutionLease>,
    directory: PathBuf,
    started: Instant,
}
impl Run {
    async fn open() -> Self {
        Self::open_with_audio(false).await
    }
    async fn open_with_audio(audio: bool) -> Self {
        let base = PathBuf::from(
            std::env::var_os("MAKA_COMPUTER_LIVE_ARTIFACT_DIR")
                .expect("explicit task-owned artifact directory is required"),
        );
        let directory = base.join(format!("native-epoch-{}", Uuid::new_v4()));
        let workspace_path = directory.join("workspace");
        let path = workspace_path.clone();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(path))
            .await
            .unwrap()
            .unwrap();
        let private = directory.join("root");
        let control = directory.join("control");
        let root_owner = RootOwner::create(
            &private,
            &RootNamespaces {
                ownership: directory.join("ownership"),
                control: control.clone(),
            },
        )
        .unwrap();
        let root = Arc::new(
            maka_event_log::RootStore::open(Arc::new(root_owner))
                .await
                .unwrap(),
        );
        let (path, directory_identity) =
            maka_fs_tools::directory::capture(&workspace_path).unwrap();
        let opened = maka_fs_tools::directory::open(&path, &directory_identity).unwrap();
        let identity = maka_fs_tools::workspace::ensure_directory_identity(
            path.clone(),
            opened,
            private,
            control,
            None,
        )
        .await
        .unwrap();
        let workspace = Workspace {
            worktree: None,
            project_id: None,
            path: path.to_string_lossy().into_owned(),
            directory_identity,
            identity,
        };
        let reference = root
            .attach_workspace("fixture", &serde_json::to_value(&workspace).unwrap())
            .await
            .unwrap();
        let basis = PermissionBasis {
            boundary_revision: 0,
            binding: BindingStamp {
                id: reference.id,
                permission_epoch: reference.permission_epoch_at_attach,
            },
        };
        let configuration = StoredSessionConfiguration {
            backend: None,
            compaction_prompt: None,
            collaboration_mode: CollaborationMode::Agent,
            tools: Some(vec!["cua_repl".into(), "cua_reset".into()]),
            title: "Isolated native epoch".into(),
            title_is_manual: false,
            pinned: false,
            labels: vec![],
            workspace: reference,
            permissions: WorkspacePermissions {
                access: WorkspaceAccess::WorkspaceWrite,
                request_permissions: false,
            },
            boundary_revision: 0,
        };
        let store = root
            .create_session(
                "session",
                "fixture",
                &serde_json::to_value(configuration).unwrap(),
                maka_agent_authority::now(),
            )
            .await
            .unwrap();
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let snapshot = InvocationConfiguration {
            compaction_prompt: None,
            editing_tools: None,
            tool_discovery: false,
            tool_composition: Some(ToolComposition {
                clients: Default::default(),
                native_tools: Default::default(),
                editing_tools: Default::default(),
                private_clients: Default::default(),
                bound_tools: Some(["cua_repl".into(), "cua_reset".into()].into()),
            }),
            system_prompt: None,
            cwd: workspace.path,
            workspace_identity: Some(workspace.identity),
            workspace_binding: Some(basis.binding),
            workspace_origin: WorkspaceOrigin::Selected,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            approval_policy: ApprovalPolicy::Never,
            boundary_revision: basis.boundary_revision,
            collaboration_mode: CollaborationMode::Agent,
            orchestration_mode: Default::default(),
            tool_mode: ToolMode::Direct,
            code_language: Default::default(),
            model: None,
            thinking_level: None,
            language: Language::En,
        };
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationOpened {
                        configuration: Some(Box::new(snapshot)),
                        input: InvocationInput::Message {
                            source_messages: vec![],
                            content: "Owned Linux native epoch fixture".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .establish_run_interaction(
                &invocation,
                &InteractionRecord {
                    session_id: invocation.session_id.clone(),
                    turn_id: invocation.turn_id.clone(),
                    run_id: invocation.run_id.clone(),
                    request_id: "broad-grant".into(),
                    created_at: maka_agent_authority::now(),
                    request: InteractionRequest::ClientCapability {
                        tool_use_id: "fixture-embedding".into(),
                        target: api::target(),
                        basis: Some(basis),
                    },
                    outcome: None,
                },
            )
            .await
            .unwrap();
        assert!(
            store
                .commit_interaction_outcome(
                    "broad-grant",
                    InteractionOutcome::ClientCapabilityDecision {
                        decision: Decision::Allow,
                        committed_at: maka_agent_authority::now()
                    }
                )
                .await
                .unwrap()
                .matches
        );
        assert_eq!(
            store
                .client_capability_grant(&invocation.session_id, &api::target())
                .await
                .unwrap()
                .unwrap()
                .basis,
            Some(basis)
        );
        let (lease, effects) = store
            .execution_scope(Some(basis))
            .await
            .unwrap()
            .accept_invocation(invocation.clone(), CancellationToken::new())
            .unwrap();
        let selected = lease.store();
        let tasks = tokio_util::task::TaskTracker::new();
        let owner = Arc::new(Computer {
            popup_provenance: None,
            store: root,
            configuration: Configuration {
                desktop: maka_capabilities::computer::Desktop::Local,
                browsers: vec![],
                audio,
                browser_preparation: Default::default(),
            },
            sessions: sessions::Sessions::with_audio(audio, tasks.clone()),
            resources: Arc::default(),
            stopping: CancellationToken::new(),
            tasks,
            origin: ToolOrigin::HostSdk {
                package_id: "live-embedding".into(),
                entry_id: "computer".into(),
                activation: Uuid::new_v4().to_string(),
                parent: None,
            },
        });
        sessions::watch(&owner);
        eprintln!("MAKA_PRODUCT_NATIVE_DIRECTORY {}", directory.display());
        Self {
            owner,
            store: selected,
            invocation,
            basis,
            issuer: Issuer::default(),
            effects,
            lease: Some(lease),
            directory,
            started: Instant::now(),
        }
    }
    async fn record(&self, label: &str, value: Value) {
        let row = json!({"stage":label,"elapsed_ms":self.started.elapsed().as_secs_f64()*1000.0,"observation":value});
        eprintln!("MAKA_PRODUCT_NATIVE_STAGE {row}");
        capture(self.directory.join(format!("{label}.json")), row).await;
    }
    async fn invoke(
        &self,
        label: &str,
        method: &str,
        input: Value,
    ) -> (String, Result<Value, ToolError>) {
        let tool = if method == "reset" {
            "cua_reset"
        } else {
            "cua_repl"
        };
        api::validate(tool, &input).unwrap();
        let operation = Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        let scope = self
            .issuer
            .issue_with_execution(
                Identity::Agent {
                    invocation: self.invocation.clone(),
                    operation_id: Some(operation.clone()),
                },
                (),
                cancellation.clone(),
                self.store.execution_custody().unwrap(),
            )
            .unwrap();
        let owner = self.owner.clone();
        let interaction = owner.sessions.get(&self.invocation.session_id).unwrap();
        let basis = self.basis;
        let method = method.to_owned();
        let start = Instant::now();
        let result = ToolJournal::new(Arc::new(self.store.clone()), self.invocation.clone())
            .invoke_call_with(
                operation.clone(),
                ToolCallIdentity::standalone(Uuid::new_v4().to_string()),
                tool.into(),
                input.clone(),
                None,
                cancellation,
                move |cancel| {
                    Box::pin(async move {
                        serde_json::to_value(
                            owner
                                .evaluate(&method, input, scope.into(), basis, interaction, cancel)
                                .await?,
                        )
                        .map_err(failed)
                    })
                },
            )
            .await;
        self.record(label, json!({"outer_operation":operation,"call_ms":start.elapsed().as_secs_f64()*1000.0,"result":result.as_ref().map_err(message)})).await;
        (operation, result)
    }
    async fn text(&self, result: Value) -> String {
        assert_eq!(result["kind"], "completed", "{result}");
        let chunk = self
            .store
            .read_artifact_chunk(
                &self.invocation.session_id,
                result["artifact"].as_str().unwrap(),
                0,
                1024 * 1024,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(chunk.total_bytes, chunk.bytes.len() as u64);
        let output: Vec<CellOutput> = serde_json::from_slice(&chunk.bytes).unwrap();
        output
            .into_iter()
            .filter_map(|part| {
                if let CellOutput::Text { text } = part {
                    Some(text)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    // This is the production Engine Run barrier, not an observer/resource proxy.
    async fn close(&mut self) {
        self.effects.settle().await.unwrap();
        self.store
            .close_run_interactions(
                &self.invocation,
                ClosureReason::TurnTerminal,
                maka_agent_authority::now(),
            )
            .await
            .unwrap();
        self.store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    self.invocation.clone(),
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        self.lease.take().unwrap().finish();
    }
}

async fn facts(store: &SessionStore, session: &str) -> Vec<StoredEvent> {
    // The store returns a complete snapshot or PrefixTooLarge, never a clipped prefix.
    let prefix = store
        .scoped_prefix(LogScope::Session { id: session.into() }, 1024, 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        prefix.events.last().map_or(0, |event| event.sequence),
        prefix.high_water
    );
    prefix.events
}
fn scroll_dispatch(events: &[StoredEvent]) -> Vec<(&str, &ToolOrigin)> {
    events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::ToolDispatched {
                operation_id,
                call,
                name,
                input,
                ..
            } if name == "cua_operation"
                && input["method"] == "action"
                && input["action"]["kind"] == "scroll"
                && input["action"]["distance"]["pixels"].as_f64() == Some(5001.0) =>
            {
                Some((operation_id.as_str(), &call.origin))
            }
            _ => None,
        })
        .collect()
}
fn settled<'a>(events: &'a [StoredEvent], operation: &str) -> Option<&'a ToolOutcome> {
    events.iter().find_map(|event| match &event.event.fact {
        Fact::ToolSettled {
            operation_id,
            outcome,
        } if operation_id == operation => Some(outcome),
        _ => None,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable X11/D-Bus desktop, native-desktop SDK, explicit fixture ELF and task artifact directory"]
async fn linux_product_timeout_retires_vm_but_run_waits_for_exact_native_t2() {
    let mut run = Run::open().await;
    let mut window = Window::open(&run.directory).await;
    let warm = format!(
        "var oldBinding='old-epoch';var oldApp=await cua.getApp({{windowId:{}}});await oldApp.getScreenshot({{emit:false}});nodeRepl.write('warmed');",
        window.id
    );
    let (_, result) = run
        .invoke(
            "warm",
            "evaluate",
            json!({"code":warm,"timeout_ms":10000,"title":"Warm owned fixture"}),
        )
        .await;
    assert!(run.text(result.unwrap()).await.contains("warmed"));
    assert_eq!(window.observe(&run, "before_scroll").await, 0);
    let (outer, result) = run.invoke("timeout", "evaluate", json!({"code":"await oldApp.scroll([37,41],'down',{pixels:5001});nodeRepl.write('finished');","timeout_ms":300,"title":"Scroll owned fixture"})).await;
    assert!(result.unwrap_err().to_string().contains("REPL interrupted"));
    let count = window.observe(&run, "after_timeout").await;
    assert!(
        count > 0 && count < 100,
        "timeout must precede real completion: {count}"
    );
    let (_, result) = run.invoke("fresh_pure", "evaluate", json!({"code":"nodeRepl.write({oldBinding:typeof oldBinding,oldApp:typeof oldApp});","timeout_ms":1000,"title":"Check fresh VM"})).await;
    let observed: Value = serde_json::from_str(&run.text(result.unwrap()).await).unwrap();
    assert_eq!(
        observed,
        json!({"oldBinding":"undefined","oldApp":"undefined"})
    );
    assert!(window.observe(&run, "after_fresh_pure").await < 100);
    let marker = format!("native-inventory-{}=", Uuid::new_v4());
    let code = format!(
        "nodeRepl.write({marker:?}+String((await cua.listWindows({{emit:false}})).some(window=>window.id==={})));",
        window.id
    );
    let (_, result) = run
        .invoke(
            "fresh_inventory",
            "evaluate",
            json!({"code":code,"timeout_ms":10000,"title":"Observe owned window"}),
        )
        .await;
    let text = run.text(result.unwrap()).await;
    assert_eq!(
        text.lines().find_map(|line| line.strip_prefix(&marker)),
        Some("true"),
        "fresh documentation may precede the exact fixture observation: {text}"
    );
    assert!(window.observe(&run, "after_fresh_inventory").await < 100);
    let (_, result) = run.invoke("explicit_reset", "reset", json!({})).await;
    assert_eq!(result.unwrap()["state"], "fresh");
    assert!(window.observe(&run, "after_explicit_reset").await < 100);
    let before = facts(&run.store, &run.invocation.session_id).await;
    let dispatched = scroll_dispatch(&before);
    assert_eq!(dispatched.len(), 1);
    let inner = dispatched[0].0.to_owned();
    match dispatched[0].1 {
        ToolOrigin::HostSdk {
            parent:
                Some(HostSdkParent::EvaluationObserver {
                    operation_id,
                    epoch,
                }),
            ..
        } => {
            assert_eq!(operation_id, &outer);
            assert!(!epoch.is_empty());
        }
        origin => panic!("wrong native admission origin: {origin:?}"),
    }
    assert!(matches!(
        settled(&before, &outer),
        Some(ToolOutcome::Failed { .. })
    ));
    assert!(settled(&before, &inner).is_none());
    assert!(
        !run.effects.is_idle(),
        "the original effect still owns its Run ticket"
    );
    let sequence = |id: &str, dispatch: bool| {
        before
            .iter()
            .find_map(|event| match &event.event.fact {
                Fact::ToolDispatched { operation_id, .. } if dispatch && operation_id == id => {
                    Some(event.sequence)
                }
                Fact::ToolSettled { operation_id, .. } if !dispatch && operation_id == id => {
                    Some(event.sequence)
                }
                _ => None,
            })
            .unwrap()
    };
    assert!(
        sequence(&inner, true) < sequence(&outer, false),
        "native T1 must be durable before the observer's timeout T2"
    );
    let before_capture = serde_json::to_value(&before).unwrap();
    let session = run.invocation.session_id.clone();
    let directory = run.directory.clone();
    let root = run.owner.store.clone();
    let closing_started = Instant::now();
    let closing_started_ms = run.started.elapsed().as_secs_f64() * 1000.0;
    let mut closing = Box::pin(run.close());
    assert!(
        futures_util::poll!(&mut closing).is_pending(),
        "Run cannot close while native T2 is absent"
    );
    // Poll close continuously; waiting for T2 ourselves would hide a broken barrier.
    tokio::time::timeout(Duration::from_secs(10), &mut closing)
        .await
        .expect("Run must finish after original T2");
    drop(closing);
    let close_ms = closing_started.elapsed().as_secs_f64() * 1000.0;
    let close_returned_ms = run.started.elapsed().as_secs_f64() * 1000.0;
    capture(
        directory.join("before_run_close_ledger.json"),
        before_capture,
    )
    .await;
    run.record(
        "run_close",
        json!({"started_ms":closing_started_ms,"returned_ms":close_returned_ms,"close_ms":close_ms,"initial_poll_pending":true,"inner_operation":inner}),
    ).await;
    let after = facts(&root.session(&session).await.unwrap(), &session).await;
    assert_eq!(
        scroll_dispatch(&after).len(),
        1,
        "no replay after timeout/reset"
    );
    assert!(matches!(
        settled(&after, &inner),
        Some(ToolOutcome::Succeeded { .. })
    ));
    let native_t2 = after
        .iter()
        .find_map(|event| match &event.event.fact {
            Fact::ToolSettled { operation_id, .. } if operation_id == &inner => {
                Some(event.sequence)
            }
            _ => None,
        })
        .unwrap();
    let terminal = after
        .iter()
        .find_map(|event| {
            matches!(&event.event.fact, Fact::InvocationEnded { .. }).then_some(event.sequence)
        })
        .unwrap();
    assert!(
        native_t2 < terminal,
        "Run termination must follow the original native T2"
    );
    capture(
        directory.join("after_run_close_ledger.json"),
        serde_json::to_value(&after).unwrap(),
    )
    .await;
    assert_eq!(window.observe(&run, "after_actual_t2").await, 100);
    let (pairs, incomplete_pair) = window.events.as_chunks::<2>();
    assert!(
        incomplete_pair.is_empty(),
        "native wheel events must contain complete press/release pairs"
    );
    for pair in pairs {
        assert_eq!(
            (pair[0]["press"].as_bool(), pair[1]["press"].as_bool()),
            (Some(true), Some(false))
        );
        for event in pair {
            assert_eq!(event["event"].as_u64(), Some(window.id));
            assert_eq!(event["detail"].as_u64(), Some(5));
            assert_eq!(
                (event["event_x"].as_i64(), event["event_y"].as_i64()),
                (Some(37), Some(41))
            );
            assert_ne!(event["response_type"].as_u64().unwrap() & 0x80, 0);
        }
        assert!(
            u32::try_from(pair[1]["time"].as_u64().unwrap())
                .unwrap()
                .wrapping_sub(u32::try_from(pair[0]["time"].as_u64().unwrap()).unwrap())
                >= 36
        );
    }
    run.record("result", json!({"input_dispatches":1,"balanced_pairs":50,"outer_timeout_t2":outer,"native_t1_and_t2":inner,"scope":"Linux product evaluate and canonical Run custody; not Host transport/UI"})).await;
    NativeOwner::close(&Service(run.owner.clone()))
        .await
        .unwrap();
    root.shutdown().await.unwrap();
    window.finish().await;
}
