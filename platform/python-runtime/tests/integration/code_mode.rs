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

use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{
        CellEvent, CellId, CellObservation, CellOwner, CellReturnedResult, CellStatus, CellView,
    },
    durable::{ContentRef, SCHEMA_VERSION, UnixMillis},
    execution::CodeLanguage,
    tool_call::ToolSettlement,
    tool_output::ToolOutput,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_agent_state::{
    ContentBlob,
    cells::{CellsStore, StandaloneBatch, StandaloneEvent},
};
use maka_code_runtime::{CellLimits, CellStore};
use maka_event_log::{
    StoreError,
    connection::Query,
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_plugin_core::work::WorkCustody;
use maka_tools::{
    CellAdmission, CellChange, CellContent, CellFuture, CellPersistence, CodeCells, CodeExecutor,
    ToolCatalog, ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct Echo;
impl ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo-tool".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        Box::pin(async move { Ok(input) })
    }
}

#[derive(Clone)]
struct Standalone {
    root: Arc<RootStore>,
    cells: CellsStore,
    session: String,
    cell: CellId,
    custody: Arc<dyn WorkCustody>,
}
fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}
impl CellPersistence for Standalone {
    fn owner(&self) -> CellOwner {
        CellOwner::Standalone {
            session: self.session.clone(),
        }
    }
    fn now(&self) -> UnixMillis {
        UnixMillis(1)
    }
    fn append(&self, changes: Vec<CellChange>, contents: Vec<CellContent>) -> CellFuture<'_, ()> {
        Box::pin(async move {
            let events = changes
                .into_iter()
                .map(|change| StandaloneEvent {
                    id: change.id,
                    at: change.at,
                    event: change.event,
                })
                .collect();
            let contents = contents
                .into_iter()
                .map(|content| {
                    let blob = ContentBlob::new(content.bytes);
                    if blob.reference() != &content.reference {
                        return Err(persistence("Cell content digest mismatch"));
                    }
                    Ok(blob)
                })
                .collect::<Result<Vec<_>, ToolError>>()?;
            let batch = StandaloneBatch::with_publications(self.session.clone(), events, contents)
                .map_err(persistence)?;
            self.cells
                .append_standalone(&self.root, self.custody.clone(), batch)
                .await
                .map_err(persistence)
        })
    }
    fn read(&self, cell: CellId) -> CellFuture<'_, Option<CellView>> {
        Box::pin(async move {
            self.cells
                .read(&self.session, cell)
                .await
                .map_err(persistence)
        })
    }
    fn content(&self, cell: CellId, reference: ContentRef) -> CellFuture<'_, Vec<u8>> {
        Box::pin(async move {
            self.cells
                .content(&self.session, cell, reference)
                .await
                .map_err(persistence)
        })
    }
    fn invoke(
        &self,
        cell: CellId,
        operation: Uuid,
        name: String,
        input: Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> ToolFuture<ToolOutput> {
        let port = self.clone();
        Box::pin(async move {
            let work = port
                .root
                .fork_effect(port.custody.as_ref(), &port.session)
                .map_err(persistence)?;
            let (reply, result) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let outcome = async {
                    if cell != port.cell {
                        return Err(ToolError::Failed("foreign standalone Cell".into()));
                    }
                    let view = port
                        .read(cell)
                        .await?
                        .ok_or_else(|| persistence("Cell not started"))?;
                    if !matches!(view.status, CellStatus::Running) || view.blocks_effect_admission()
                    {
                        return Err(ToolError::OutcomeUnknown(
                            "Cell no longer admits effects".into(),
                        ));
                    }
                    catalog
                        .validate(&name, &input)
                        .map_err(|error| ToolError::Failed(error.to_string()))?;
                    let semantics = catalog
                        .semantics(&name)
                        .map_err(|error| ToolError::Failed(error.to_string()))?;
                    let frozen = CellContent::json(&input)?;
                    port.append(
                        vec![CellChange::new(
                            CellEvent::ChildPrepared {
                                cell,
                                operation,
                                name: name.clone(),
                                semantics,
                                input: frozen.reference.clone(),
                                resources: vec![],
                            },
                            port.now(),
                        )],
                        vec![frozen],
                    )
                    .await?;
                    port.append(
                        vec![CellChange::new(
                            CellEvent::ChildAdmitted { cell, operation },
                            port.now(),
                        )],
                        vec![],
                    )
                    .await?;
                    let output = ToolOutput::Json(Echo.invoke(name, input, cancellation).await?);
                    let manifest = CellContent::json(&ToolReturn {
                        schema_version: SCHEMA_VERSION,
                        artifacts: vec![],
                        body: CellReturnedResult {
                            output: output.clone(),
                            projection: None,
                            is_error: false,
                        },
                    })?;
                    port.append(
                        vec![CellChange::new(
                            CellEvent::LocalChildReturned {
                                cell,
                                operation,
                                result: manifest.reference.clone(),
                                is_error: false,
                                settlement: ToolSettlement::Returned,
                            },
                            port.now(),
                        )],
                        vec![manifest],
                    )
                    .await?;
                    Ok(output)
                }
                .await;
                work.finish(Ok(()));
                let _ = reply.send(outcome);
            });
            result.await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!("local Echo worker disappeared: {error}"))
            })?
        })
    }
}

struct ReadEvents(String);
impl Query for ReadEvents {
    type Output = Vec<StandaloneEvent>;
    fn execute(self, connection: &rusqlite::Connection) -> Result<Self::Output, StoreError> {
        let mut statement = connection.prepare(
            "SELECT c.payload FROM agent_standalone_cell_events e JOIN contents c ON c.id=e.body_content_id WHERE e.session=? ORDER BY e.sequence",
        )?;
        let bytes = statement
            .query_map([self.0], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        bytes
            .into_iter()
            .map(|body| serde_json::from_slice(&body).map_err(Into::into))
            .collect()
    }
}

#[tokio::test]
async fn selected_python_runs_through_exec_grammar_catalog_and_durable_cell_source() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let owner =
            Arc::new(RootOwner::create(&directory.path().join("root"), &namespaces).unwrap());
        let migrations = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(maka_agent_state::MIGRATIONS)
            .copied()
            .collect::<Vec<_>>();
        let root = Arc::new(RootStore::open(owner, &migrations).await.unwrap());
        let session = root
            .create_session("python-session", "python-code-mode", &json!({}), 1)
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        let (lease, effects) = session
            .work_scope(None)
            .await
            .unwrap()
            .accept(cancellation.clone());
        let custody = lease.store().work_custody().unwrap();
        let data = root
            .data_writer_for_work(custody.as_ref(), session.id())
            .unwrap();
        let store = CellsStore::new(data.clone());
        let catalog = ToolCatalog::new([ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: "echo-tool".into(),
                description: "Echo an integer".into(),
                input_schema: json!({
                    "type":"object", "properties":{"n":{"type":"integer"}},
                    "required":["n"], "additionalProperties":false,
                }),
            },
            handler: ToolHandler::Immediate(Arc::new(Echo)),
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
        }])
        .unwrap();
        let executor = CodeExecutor::new(CellLimits::default())
            .unwrap()
            .with_python_worker(super::python_worker())
            .unwrap();
        let python_source = concat!(
            "# @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}\n",
            "result=await tools.echo_tool(n=7)\n",
            "store('receipt',result)\ntext(result)",
        );
        for (language, source, expected) in [
            (
                CodeLanguage::Python,
                python_source,
                json!([{"kind":"text","text":"{\"n\":7}"}]),
            ),
            (
                CodeLanguage::JavaScript,
                "text(load('receipt'));",
                json!([{"kind":"text","text":"{\"n\":7}"}]),
            ),
        ] {
            let definitions = CodeCells::definitions_for(&catalog, language);
            let definition = definitions.iter().find(|tool| tool.name == "exec").unwrap();
            if language == CodeLanguage::Python {
                assert!(definition.description.contains("Input JSON Schema"));
                assert!(
                    definition
                        .description
                        .contains("await tools.echo_tool(input)")
                );
                let grammar = serde_json::to_value(&definition.freeform)
                    .unwrap()
                    .to_string();
                assert!(grammar.contains("# @exec:"));
                assert!(!definition.description.contains("declare const tools"));
            }
            let admission = CellAdmission::new(
                source.into(),
                CellOwner::Standalone {
                    session: session.id().into(),
                },
                UnixMillis(1),
            );
            let port = Arc::new(Standalone {
                root: root.clone(),
                cells: store.clone(),
                session: session.id().into(),
                cell: admission.id(),
                custody: custody.clone(),
            });
            let reader = store.reader(session.id().into(), tokio::runtime::Handle::current());
            let cells = CodeCells::new(
                executor.clone().with_language(language),
                CellStore::new(reader),
            );
            let cell = cells
                .start_cell(
                    &admission,
                    catalog.clone(),
                    port.clone(),
                    cancellation.clone(),
                )
                .await
                .unwrap();
            let observation = loop {
                let observed = cells
                    .observe_cell(
                        cell,
                        Duration::from_secs(10),
                        false,
                        port.clone(),
                        cancellation.clone(),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                if !matches!(observed.observation, CellObservation::Running { .. }) {
                    break observed.observation;
                }
            };
            let CellObservation::Completed {
                content, result, ..
            } = observation
            else {
                panic!("Cell did not complete");
            };
            assert_eq!(result["ok"], true, "{result}");
            assert_eq!(serde_json::to_value(content).unwrap(), expected);
            let recorded = store.read(session.id(), cell).await.unwrap().unwrap();
            assert!(matches!(
                recorded.status,
                CellStatus::Completed { accepted: true, .. }
            ));
            assert!(!recorded.blocks_effect_admission());
            cells.shutdown().await.unwrap();
        }
        let events = data.query(ReadEvents(session.id().into())).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(&event.event, CellEvent::LocalChildReturned { .. },))
                .count(),
            1
        );
        assert!(events.iter().all(|event| !matches!(
            &event.event,
            CellEvent::Started {
                owner: CellOwner::Agent { .. },
                ..
            },
        )));
        effects.settle().await.unwrap();
        lease.finish();
        drop(custody);
        drop(store);
        drop(data);
        root.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
