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
use maka_agent_facts::tools::ToolSemantics;
use maka_agent_state::{
    ContentBlob,
    cells::{CellsStore, StandaloneBatch, StandaloneEvent},
};
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionWorkLease},
};
use maka_plugin_core::{
    composition::InstanceId,
    contract::Transport,
    deployment::DeploymentRef,
    operation::{
        OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt,
        RecoveryContract, RecoveryProtocol, RecoveryRef,
    },
};

const SESSION: &str = "cell_observation";

struct ReadPort {
    store: CellsStore,
    child_error: Mutex<Option<ToolError>>,
}
impl CellPersistence for ReadPort {
    fn owner(&self) -> CellOwner {
        CellOwner::Standalone {
            session: SESSION.into(),
        }
    }
    fn now(&self) -> UnixMillis {
        UnixMillis(1)
    }
    fn append(&self, _: Vec<CellChange>, _: Vec<CellContent>) -> CellFuture<'_, ()> {
        Box::pin(async { panic!("observation must not publish Cell facts") })
    }
    fn read(&self, cell: CellId) -> CellFuture<'_, Option<CellView>> {
        Box::pin(async move { self.store.read(SESSION, cell).await.map_err(persistence) })
    }
    fn content(&self, cell: CellId, reference: ContentRef) -> CellFuture<'_, Vec<u8>> {
        Box::pin(async move {
            self.store
                .content(SESSION, cell, reference)
                .await
                .map_err(persistence)
        })
    }
    fn invoke(
        &self,
        _: CellId,
        _: Uuid,
        _: String,
        _: Value,
        _: ToolCatalog,
        _: CancellationToken,
    ) -> ToolFuture<ToolOutput> {
        let error = self
            .child_error
            .lock()
            .unwrap()
            .take()
            .expect("unexpected child invocation");
        Box::pin(async move { Err(error) })
    }
}

struct Fixture {
    root: RootStore,
    work: SessionWorkLease,
    port: Arc<ReadPort>,
    cells: CodeCells,
    _directory: tempfile::TempDir,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let owner = RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap();
        let mut catalog = maka_event_log::ROOT_MIGRATIONS.to_vec();
        catalog.extend_from_slice(maka_agent_state::MIGRATIONS);
        catalog.sort_by_key(|migration| migration.version);
        let root = RootStore::open(Arc::new(owner), &catalog).await.unwrap();
        let session = root
            .create_session(SESSION, "cell-observation", &json!({}), 1)
            .await
            .unwrap();
        let (work, _) = session
            .work_scope(None)
            .await
            .unwrap()
            .accept(CancellationToken::new());
        let custody = work.store().work_custody().unwrap();
        let store = CellsStore::new(
            root.data_writer_for_work(custody.as_ref(), SESSION)
                .unwrap(),
        );
        let cells = CodeCells::new(
            CodeExecutor::new(Default::default()).unwrap(),
            CellStore::new(store.reader(SESSION.into(), tokio::runtime::Handle::current())),
        );
        Self {
            root,
            work,
            port: Arc::new(ReadPort {
                store,
                child_error: Mutex::default(),
            }),
            cells,
            _directory: directory,
        }
    }
    async fn append(&self, events: Vec<CellEvent>, contents: Vec<CellContent>) {
        let events = events
            .into_iter()
            .map(|event| {
                let id = if matches!(&event, CellEvent::Started { .. }) {
                    event.cell().started_fact_id()
                } else {
                    FactId::new()
                };
                StandaloneEvent {
                    id,
                    at: UnixMillis(1),
                    event,
                }
            })
            .collect();
        let batch = StandaloneBatch::with_publications(
            SESSION.into(),
            events,
            contents
                .into_iter()
                .map(|content| ContentBlob::new(content.bytes))
                .collect(),
        )
        .unwrap();
        self.port
            .store
            .append_standalone(&self.root, self.work.store().work_custody().unwrap(), batch)
            .await
            .unwrap();
    }
    async fn child(&self, reply: &OperationReply) -> CellId {
        let cell = CellId::new();
        let source = CellContent::new(b"observation fixture".to_vec());
        // Canonical binding data only; these observation tests launch no VM.
        let descriptor = CellContent::json(&json!({"fixture":"observation-only"})).unwrap();
        let input = CellContent::json(&json!({"nonce":reply.reference.operation})).unwrap();
        self.append(
            vec![
                CellEvent::Started {
                    cell,
                    owner: self.port.owner(),
                    source: source.reference.clone(),
                },
                CellEvent::VmBound {
                    cell,
                    binding: CellVmBinding {
                        runtime: maka_code_runtime::JAVASCRIPT_VM.into(),
                        version: maka_code_runtime::VM_BINDING_VERSION,
                        descriptor: descriptor.reference.clone(),
                    },
                },
                CellEvent::ChildPrepared {
                    cell,
                    operation: reply.reference.operation,
                    name: "fixture.child".into(),
                    semantics: ToolSemantics::Parallel,
                    input: input.reference.clone(),
                    resources: Vec::new(),
                },
                CellEvent::ChildAdmitted {
                    cell,
                    operation: reply.reference.operation,
                },
                CellEvent::ChildBound {
                    cell,
                    operation: reply.reference.operation,
                    reference: reply.reference.clone(),
                },
                CellEvent::ChildObserved {
                    cell,
                    operation: reply.reference.operation,
                    reply: maka_agent_facts::operation::inline_reply(reply.clone()),
                },
            ],
            vec![source, descriptor, input],
        )
        .await;
        cell
    }
    fn live(
        &self,
        cell: CellId,
        failure: Option<ToolError>,
        done: Option<Result<(), ToolError>>,
    ) -> (Arc<Live>, watch::Sender<Option<Result<(), ToolError>>>) {
        let context = CellContext::new(self.cells.0.store.clone(), Vec::new()).unwrap();
        if let Some(error) = failure {
            context.fail(error);
        }
        let (sender, done) = watch::channel(done);
        let live = Arc::new(Live {
            context,
            cancel: CancellationToken::new(),
            observer: tokio::sync::Mutex::new(()),
            done,
            output: Mutex::default(),
        });
        self.cells.0.live.lock().unwrap().insert(cell, live.clone());
        (live, sender)
    }
    async fn interrupt(&self, cell: CellId) -> CellContent {
        let prior = self.port.read(cell).await.unwrap().unwrap();
        let report = CellContent::json(&CellInterruption {
            cell,
            diagnostic: "original child still requires reconciliation".into(),
            children: prior.children,
            prior_output: None,
        })
        .unwrap();
        self.append(
            vec![CellEvent::Interrupted {
                cell,
                report: report.reference.clone(),
            }],
            vec![report.clone()],
        )
        .await;
        report
    }
    async fn observe(&self, cell: CellId) -> Result<ObservedCell, ToolError> {
        self.cells
            .observe_cell(
                cell,
                Duration::ZERO,
                false,
                self.port.clone(),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
    }
    async fn close(self) {
        self.cells.shutdown().await.unwrap();
        self.work.finish();
        self.root.shutdown().await.unwrap();
    }
}

fn child_reply(outcome: OperationOutcome, cleanup: OperationCleanup) -> OperationReply {
    let reference = RecoveryRef {
        source: DeploymentRef {
            state_domain: "1".repeat(64),
            deployment: Uuid::new_v4(),
            revision: 1,
        },
        namespace: InstanceId(vec![Uuid::new_v4()]),
        export: "fixture".into(),
        method: "child".into(),
        operation: Uuid::new_v4(),
        fingerprint: format!("sha256-{}", "2".repeat(64)),
        contract: RecoveryContract {
            name: "fixture.Child".into(),
            version: 1,
            transport: Transport::Remote,
            digest: format!("sha256-{}", "3".repeat(64)),
        },
        recovery: RecoveryProtocol::JournalV1,
    };
    reference.validate().unwrap();
    OperationReply {
        reference,
        receipt: Receipt::Recorded { outcome, cleanup },
    }
}
fn returned() -> OperationOutcome {
    OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"original":"returned"}),
        },
    }
}

#[tokio::test]
async fn learning_a_nested_tool_preserves_the_code_mode_definitions() {
    use crate::{ToolHandler, ToolNesting, ToolRegistration, availability::LoadedTools};

    struct Lookup;
    impl ToolExecutor for Lookup {
        fn names(&self) -> Vec<String> {
            vec!["Lookup".into()]
        }
        fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
            Box::pin(async { Ok(json!({"found":true})) })
        }
    }

    let fixture = Fixture::new().await;
    let catalog = ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            name: "Lookup".into(),
            description: "Look up a record by key.".into(),
            input_schema: json!({"type":"object"}),
            provider: None,
            freeform: None,
            output_schema: None,
        },
        handler: ToolHandler::Immediate(Arc::new(Lookup)),
        semantics: ToolSemantics::Parallel,
        nesting: ToolNesting::Nestable,
    }])
    .unwrap()
    .with_discovery();
    let loaded = LoadedTools::new(
        fixture
            .port
            .store
            .reader(SESSION.into(), tokio::runtime::Handle::current()),
    );
    let available = Availability::new(catalog, loaded);
    let initial = fixture.cells.definitions(&available);
    assert_eq!(
        available.snapshot().await.unwrap().names(),
        Vec::<String>::new()
    );

    let cell = fixture
        .child(&child_reply(returned(), OperationCleanup::Confirmed))
        .await;
    let result = CellContent::json(&CellObservation::Completed {
        cell_id: cell,
        content: vec![],
        result: json!({"found":true}),
    })
    .unwrap();
    fixture
        .append(
            vec![CellEvent::Completed {
                cell,
                result: result.reference.clone(),
                publication: SessionPublication {
                    values: BTreeMap::new(),
                    loaded_tools: Some(BTreeSet::from(["Lookup".into()])),
                },
            }],
            vec![result],
        )
        .await;

    assert_eq!(available.snapshot().await.unwrap().names(), ["Lookup"]);
    assert_eq!(fixture.cells.definitions(&available), initial);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_failure_observes_original_interruption_without_promoting_child_receipt() {
    let fixture = Fixture::new().await;
    for outcome in [
        returned(),
        OperationOutcome::Unknown {
            diagnostic: "original return is unresolved".into(),
        },
    ] {
        let unknown = matches!(&outcome, OperationOutcome::Unknown { .. });
        let reply = child_reply(outcome, OperationCleanup::Unconfirmed);
        let cell = fixture.child(&reply).await;
        let error = if unknown {
            ToolError::OperationUnknown {
                message: "original child outcome unresolved".into(),
                observation: Box::new(reply.clone()),
            }
        } else {
            ToolError::OperationCleanupUnconfirmed {
                message: "original child cleanup pending".into(),
                observation: Box::new(reply.clone()),
            }
        };
        let (live, done) = fixture.live(cell, None, None);
        *fixture.port.child_error.lock().unwrap() = Some(error.clone());
        let nested = Nested {
            port: fixture.port.clone(),
            cell,
            catalog: ToolCatalog::default(),
            execution: fixture.cells.0.execution.clone(),
            context: live.context.clone(),
            cell_cancel: live.cancel.clone(),
        };
        let caller_cancel = CancellationToken::new();
        let invoked = nested
            .invoke("fixture.child".into(), json!({}), caller_cancel.clone())
            .await;
        assert!(matches!(invoked,
            Err(ToolError::OperationUnknown { observation, .. } | ToolError::OperationCleanupUnconfirmed { observation, .. }) if *observation == reply
        ));
        assert!(
            live.cancel.is_cancelled(),
            "fatal child error must cancel this Cell, even if caught"
        );
        assert!(
            !caller_cancel.is_cancelled(),
            "the caller token is not the interpreter token"
        );
        assert!(matches!(live.context.failure(),
            Some(ToolError::OperationUnknown { observation, .. } | ToolError::OperationCleanupUnconfirmed { observation, .. }) if *observation == reply
        ));
        let pending = fixture.port.read(cell).await.unwrap().unwrap();
        assert_eq!(
            fixture.observe(cell).await.unwrap().state,
            CellReplyState::Running
        );
        assert_eq!(fixture.port.read(cell).await.unwrap(), Some(pending));
        let report = fixture.interrupt(cell).await;
        done.send_replace(Some(Ok(())));
        let before = fixture.port.read(cell).await.unwrap().unwrap();
        let observed = fixture.observe(cell).await.unwrap();
        assert_eq!(
            observed.state,
            CellReplyState::Interrupted {
                report: report.reference.clone()
            }
        );
        use maka_agent_facts::{durable::ExecutionIdentity, tool_output::DurableToolProjection};
        let projected = CodeCells::project_observation(cell, observed.clone(), 2000)
            .into_durable(
                "interrupted-cell",
                std::time::SystemTime::UNIX_EPOCH,
                &ExecutionIdentity {
                    session_id: "fixture".into(),
                    turn_id: "fixture".into(),
                    run_id: maka_agent_facts::durable::RunId::new(),
                },
            )
            .unwrap();
        let DurableToolProjection::Text { text } = projected.projection else {
            panic!("expected a text projection");
        };
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({"state":"interrupted","cell_id":cell,
                "diagnostic":"original child still requires reconciliation",
                "heap":"expired","bindings":"invalid"}),
        );
        let CellObservation::Interrupted {
            cell_id,
            report: actual,
        } = observed.observation
        else {
            panic!("original interruption required")
        };
        assert_eq!(cell_id, cell);
        assert_eq!(
            actual,
            serde_json::from_slice::<Value>(&report.bytes).unwrap()
        );
        assert_eq!(fixture.port.read(cell).await.unwrap(), Some(before.clone()));
        assert_eq!(
            before.children[&reply.reference.operation].reply.as_ref(),
            Some(&maka_agent_facts::operation::inline_reply(reply.clone()))
        );
        assert!(!before.physical_cleanup_confirmed());
        assert!(
            live.context.take_draft().is_err(),
            "fatal child error must still fence draft acceptance"
        );
        fixture.live(cell, None, Some(Err(error)));
        let observed = fixture.observe(cell).await.unwrap();
        assert_eq!(
            observed.state,
            CellReplyState::Interrupted {
                report: report.reference
            }
        );
        assert_eq!(fixture.port.read(cell).await.unwrap(), Some(before));
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsettled_worker_errors_remain_cell_local_without_claiming_running_success() {
    let fixture = Fixture::new().await;
    let reply = child_reply(returned(), OperationCleanup::Confirmed);
    let cell = fixture.child(&reply).await;
    let completion = CellContent::json(&CellObservation::Completed {
        cell_id: cell,
        content: Vec::new(),
        result: json!({"original":"completed"}),
    })
    .unwrap();
    fixture
        .append(
            vec![CellEvent::Completed {
                cell,
                result: completion.reference.clone(),
                publication: SessionPublication {
                    values: BTreeMap::new(),
                    loaded_tools: None,
                },
            }],
            vec![completion.clone()],
        )
        .await;
    fixture.live(
        cell,
        None,
        Some(Err(ToolError::CleanupUnconfirmed(
            "historical worker cleanup error".into(),
        ))),
    );
    let before = fixture.port.read(cell).await.unwrap().unwrap();
    let observed = fixture.observe(cell).await.unwrap();
    assert_eq!(
        observed.state,
        CellReplyState::Completed {
            result: completion.reference
        }
    );
    let CellObservation::Completed {
        cell_id, result, ..
    } = observed.observation
    else {
        panic!("canonical completion required")
    };
    assert_eq!((cell_id, result), (cell, json!({"original":"completed"})));
    assert_eq!(fixture.port.read(cell).await.unwrap(), Some(before));

    fixture.close().await;

    let unknown = child_reply(
        OperationOutcome::Unknown {
            diagnostic: "provider return missing".into(),
        },
        OperationCleanup::Unconfirmed,
    );
    let cleanup = child_reply(returned(), OperationCleanup::Unconfirmed);
    let cases = [
        (
            Some(ToolError::OperationUnknown {
                message: "original child outcome unresolved".into(),
                observation: Box::new(unknown.clone()),
            }),
            unknown,
            "outcome",
            "original child outcome unresolved",
        ),
        (
            Some(ToolError::OperationCleanupUnconfirmed {
                message: "original child cleanup pending".into(),
                observation: Box::new(cleanup.clone()),
            }),
            cleanup.clone(),
            "cleanup",
            "original child cleanup pending",
        ),
        (
            Some(ToolError::CleanupUnconfirmed(
                "original VM closure unconfirmed".into(),
            )),
            child_reply(returned(), OperationCleanup::Unconfirmed),
            "cleanup",
            "original VM closure unconfirmed",
        ),
        (
            None,
            cleanup,
            "persistence",
            "without a canonical terminal observation",
        ),
    ];
    for (error, reply, kind, reason) in cases {
        let fixture = Fixture::new().await;
        let cell = fixture.child(&reply).await;
        let original = fixture.port.read(cell).await.unwrap().unwrap();
        fixture
            .append(
                vec![CellEvent::VmCleanupUnconfirmed {
                    cell,
                    binding: original.vm,
                    diagnostic: "original VM closure remains unconfirmed".into(),
                }],
                Vec::new(),
            )
            .await;
        let before = fixture.port.read(cell).await.unwrap().unwrap();
        assert_eq!(
            fixture.observe(cell).await.unwrap().state,
            CellReplyState::Running
        );
        let (live, _done) = fixture.live(
            cell,
            None,
            Some(match &error {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }),
        );
        assert_cell_failure(fixture.observe(cell).await, kind, reason);
        assert_eq!(fixture.port.read(cell).await.unwrap(), Some(before.clone()));
        assert_eq!(
            before.children[&reply.reference.operation].reply.as_ref(),
            Some(&maka_agent_facts::operation::inline_reply(reply.clone()))
        );
        assert!(before.vm_uncertainty.is_some() && before.blocks_effect_admission());
        assert!(!before.physical_cleanup_confirmed());
        if let Some(original) = &error {
            assert!(
                matches!(&*live.done.borrow(), Some(Err(error)) if error.to_string() == original.to_string())
            );
            assert_cell_failure(fixture.cells.shutdown().await, kind, reason);
            assert_eq!(fixture.port.read(cell).await.unwrap(), Some(before));
        }
        fixture.close().await;
    }
}

fn assert_cell_failure<T>(result: Result<T, ToolError>, kind: &str, reason: &str) {
    let diagnostic = match (result, kind) {
        (Err(ToolError::OutcomeUnknown(message)), "outcome")
        | (Err(ToolError::CleanupUnconfirmed(message)), "cleanup")
        | (Err(ToolError::Persistence(message)), "persistence") => message,
        _ => panic!("expected a Cell-local {kind} failure, not a child receipt or success"),
    };
    assert!(
        diagnostic.contains(reason),
        "original cause lost: {diagnostic}"
    );
}
