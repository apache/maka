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

use super::support::preflight::{Fixture, persistence};
use maka_agent_facts::{
    artifact::{ArtifactSource, PublishedArtifact, ToolReturn, content_digest},
    cells::{
        CellEvent, CellId, CellObservation, CellOutput, CellOwner, CellReplyState,
        CellReturnedResult, CellStatus, CellView,
    },
    composition::RequestComposition,
    durable::*,
    execution::{CodeLanguage, CollaborationMode, ModelBinding},
    input::RunInput,
    language::Language,
    model::{ModelPart, ModelToolCall, ToolInput},
    tool_call::{ToolCallIdentity, ToolOrigin, ToolSettlement},
    tool_output::{
        AcceptedToolResult, DurableToolProjection, ImageDetail, ProjectionPart, ReturnedToolResult,
        ToolOutput, ToolSuccess,
    },
    tools::{ToolError, ToolFuture},
};
use maka_agent_state::{
    Admission, Change, Commit, ContentBlob, DriverClaim, DriverDomain, Store,
    artifacts::ArtifactScope,
};
use maka_code_runtime::CellLimits;
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::{DataWriter, RootStore},
};
use maka_plugin_core::{composition::InstanceId, operation::OperationCleanup, work::WorkCustody};
use maka_tools::{
    CellAdmission, CellChange, CellContent, CellFuture, CellPersistence, CodeCells, CodeExecutor,
    PreparationFuture, PreparedEffect, ToolCallContext, ToolCatalog, ToolDefinition, ToolHandler,
    ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const GIF: &[u8] =
    b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff,\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0;";
const SOURCE: &str = "const result = await tools.read({}); image(result, 'original'); text(await tools.verify(result));";

struct ImageTools {
    state: Store,
    calls: Arc<AtomicUsize>,
}
impl ToolPreparer for ImageTools {
    fn names(&self) -> Vec<String> {
        vec!["read".into(), "verify".into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        let state = self.state.clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            Ok(PreparedEffect::new(move |_| {
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if name == "read" {
                        return Ok(
                            ToolSuccess::image(GIF.to_vec(), "image/gif".into(), None).unwrap()
                        );
                    }
                    // JS can pass this value to verify only after the original image T2 ACK.
                    assert_eq!(input["kind"], "image");
                    assert_eq!(input["mimeType"], "image/gif");
                    assert_eq!(input.as_object().unwrap().len(), 3);
                    assert_eq!(input["ref"]["kind"], "session_file");
                    let view = state.frontier(context.execution.run_id).await.unwrap();
                    assert_eq!(input["ref"]["sessionId"], view.spec.session_id);
                    let history = state.history(view.run, 0, 128).await.unwrap();
                    let returned = history
                        .iter()
                        .filter_map(|recorded| match &recorded.fact {
                            Fact::Cell {
                                event: CellEvent::LocalChildReturned { result, .. },
                            } => Some(result),
                            _ => None,
                        })
                        .collect::<Vec<_>>();
                    assert_eq!(
                        returned.len(),
                        1,
                        "only the image child has returned so far"
                    );
                    let original: ToolReturn<CellReturnedResult> = serde_json::from_slice(
                        &state.content(view.run, returned[0].clone()).await.unwrap(),
                    )
                    .unwrap();
                    assert!(matches!(original.body.output, ToolOutput::Image(_)));
                    assert_eq!(original.body.output.into_json(), input);
                    assert!(
                        matches!(original.body.projection, Some(DurableToolProjection::Content {parts}) if parts.iter().any(|part| matches!(part, ProjectionPart::Artifact {..})))
                    );
                    let id = input["ref"]["relativePath"].as_str().unwrap().to_owned();
                    let scope = ArtifactScope {
                        owner: view.spec.owner,
                        session: view.spec.session_id,
                        run: view.run,
                        through: view.revision,
                    };
                    let artifact = state
                        .artifacts()
                        .get(scope.clone(), id.clone())
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        artifact.artifact.source,
                        ArtifactSource::ToolResultProjection
                    );
                    assert_eq!(
                        state
                            .artifacts()
                            .chunk(scope, id, 0, 1024)
                            .await
                            .unwrap()
                            .unwrap()
                            .bytes,
                        GIF
                    );
                    Ok(input.into())
                })
            }))
        })
    }
}

#[derive(Clone)]
struct AgentCellPort {
    root: Arc<RootStore>,
    custody: Arc<dyn WorkCustody>,
    data: DataWriter,
    state: Store,
    claim: DriverClaim,
    execution: ExecutionIdentity,
    link: AgentStepLink,
    parent: ToolKey,
}
impl AgentCellPort {
    fn cell(&self) -> CellId {
        CellId::for_agent(self.link, &self.parent.call)
    }
    async fn commit(
        &self,
        changes: Vec<CellChange>,
        contents: Vec<CellContent>,
    ) -> Result<Commit, ToolError> {
        if changes
            .iter()
            .any(|change| change.event.cell() != self.cell())
        {
            return Err(persistence("foreign Agent Cell source"));
        }
        let contents = tokio::task::spawn_blocking(move || {
            contents
                .into_iter()
                .map(|content| {
                    let blob = ContentBlob::new(content.bytes);
                    if blob.reference() != &content.reference {
                        return Err(persistence("Cell content digest mismatch"));
                    }
                    Ok(blob)
                })
                .collect::<Result<Vec<_>, ToolError>>()
        })
        .await
        .map_err(persistence)??;
        let changes = changes
            .into_iter()
            .map(|change| Change {
                id: change.id,
                at: change.at,
                fact: Fact::Cell {
                    event: change.event,
                },
            })
            .collect();
        let view = self
            .state
            .frontier(self.execution.run_id)
            .await
            .map_err(persistence)?;
        self.state
            .append(&self.claim, (&view).into(), changes, contents)
            .await
            .map_err(persistence)
    }
    async fn invoke_child(
        &self,
        cell: CellId,
        operation: Uuid,
        name: String,
        input: Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> Result<ToolOutput, ToolError> {
        let view = self
            .read(cell)
            .await?
            .ok_or_else(|| persistence("original Agent Cell missing"))?;
        if !matches!(view.status, CellStatus::Running) || view.blocks_effect_admission() {
            return Err(persistence("Agent Cell no longer admits effects"));
        }
        let context = ToolCallContext {
            execution: self.execution.clone(),
            operation_id: format!("cell:{cell}:{operation}"),
            call: ToolCallIdentity {
                tool_call_id: operation.to_string(),
                origin: ToolOrigin::CodeCell {
                    cell,
                    owner: self.owner(),
                    parent_operation_id: format!("{}:{}", self.parent.attempt, self.parent.call),
                    parent_tool_call_id: self.parent.call.clone(),
                },
            },
            custody: Some(self.custody.clone()),
        };
        let semantics = catalog
            .semantics(&name)
            .map_err(|error| ToolError::Failed(error.to_string()))?;
        let effect = catalog
            .prepare(name.clone(), input.clone(), context, cancellation.clone())
            .await
            .map_err(persistence)?;
        let input = CellContent::json(&input)?;
        self.append(
            vec![CellChange::new(
                CellEvent::ChildPrepared {
                    cell,
                    operation,
                    name,
                    semantics,
                    input: input.reference.clone(),
                    resources: vec![],
                },
                self.now(),
            )],
            vec![input],
        )
        .await?;
        let admitted = CellChange::new(CellEvent::ChildAdmitted { cell, operation }, self.now());
        let fact = admitted.id;
        self.append(vec![admitted], vec![]).await?;
        let sequence = self
            .data
            .query(AdmittedSequence(self.execution.run_id, fact))
            .await
            .map_err(persistence)?;
        let (custody, execute) = effect.begin(sequence, cancellation)?.execute();
        let success = execute.await?;
        let execution = self.execution.clone();
        let (blob, body, artifacts) = tokio::task::spawn_blocking(move || {
            let normalized = success
                .into_durable(
                    &format!("cell:{cell}:{operation}"),
                    SystemTime::now(),
                    &execution,
                )
                .map_err(persistence)?;
            let artifacts = normalized
                .artifacts
                .iter()
                .map(|write| {
                    let evidence = write.evidence();
                    PublishedArtifact {
                        artifact: write.artifact().clone(),
                        payload: ContentRef {
                            digest: evidence.digest,
                            bytes: evidence.bytes,
                        },
                    }
                })
                .collect();
            let manifest = ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts,
                body: CellReturnedResult {
                    output: normalized.output,
                    projection: Some(normalized.projection),
                    is_error: normalized.is_error,
                },
            };
            let blob = ContentBlob::json(&manifest).map_err(persistence)?;
            Ok::<_, ToolError>((blob, manifest.body, normalized.artifacts))
        })
        .await
        .map_err(persistence)??;
        self.state
            .observe_artifacts(
                self.execution.run_id,
                vec![Change::new(
                    Fact::Cell {
                        event: CellEvent::LocalChildReturned {
                            cell,
                            operation,
                            result: blob.reference().clone(),
                            is_error: body.is_error,
                            settlement: ToolSettlement::Returned,
                        },
                    },
                    self.now(),
                )],
                vec![blob],
                artifacts,
            )
            .await
            .map_err(persistence)?;
        drop(custody);
        Ok(body.output)
    }
}
impl CellPersistence for AgentCellPort {
    fn owner(&self) -> CellOwner {
        CellOwner::Agent {
            link: self.link,
            call: self.parent.call.clone(),
        }
    }
    fn now(&self) -> UnixMillis {
        UnixMillis(3)
    }
    fn append(&self, changes: Vec<CellChange>, contents: Vec<CellContent>) -> CellFuture<'_, ()> {
        Box::pin(async move { self.commit(changes, contents).await.map(|_| ()) })
    }
    fn read(&self, cell: CellId) -> CellFuture<'_, Option<CellView>> {
        Box::pin(async move {
            if cell != self.cell() {
                return Err(persistence("foreign Agent Cell"));
            }
            self.state
                .cells()
                .read(&self.execution.session_id, cell)
                .await
                .map_err(persistence)
        })
    }
    fn content(&self, cell: CellId, reference: ContentRef) -> CellFuture<'_, Vec<u8>> {
        Box::pin(async move {
            if cell != self.cell() {
                return Err(persistence("foreign Agent Cell"));
            }
            self.state
                .cells()
                .content(&self.execution.session_id, cell, reference)
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
                .fork_effect(port.custody.as_ref(), &port.execution.session_id)
                .map_err(persistence)?;
            let (send, receive) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let result = port
                    .invoke_child(cell, operation, name, input, catalog, cancellation)
                    .await;
                work.finish(result.as_ref().map(|_| ()).map_err(ToString::to_string));
                let _ = send.send(result);
            });
            receive.await.map_err(persistence)?
        })
    }
}
struct AdmittedSequence(RunId, FactId);
impl Query for AdmittedSequence {
    type Output = u64;
    fn execute(self, connection: &rusqlite::Connection) -> Result<u64, StoreError> {
        let sequence: i64 = connection.query_row(
            "SELECT sequence FROM agent_facts WHERE run=? AND id=?",
            rusqlite::params![self.0.to_string(), self.1.to_string()],
            |row| row.get(0),
        )?;
        u64::try_from(sequence).map_err(|error| StoreError::InvalidTransition(error.to_string()))
    }
}

async fn admit_agent(
    base: &Fixture,
    state: Store,
    definitions: Vec<ToolDefinition>,
) -> AgentCellPort {
    let owner = RunOwner {
        deployment: Uuid::new_v4(),
        namespace: InstanceId(vec![Uuid::new_v4()]),
    };
    let input = ContentBlob::json(&RunInput::Message {
        content: "exercise original image custody".into(),
        request_fingerprint: None,
        source_messages: vec![],
    })
    .unwrap();
    let system = ContentBlob::json(&"").unwrap();
    let tools = ContentBlob::json(&definitions).unwrap();
    let descriptor =
        ContentBlob::json(&json!({"fixture":"frozen model parts; no model transport"})).unwrap();
    let binding = ModelBinding {
        connection_id: "frozen-parts".into(),
        connection_slug: "frozen-parts".into(),
        model: "frozen-parts".into(),
    };
    // This modeled request has no OS authority. Only the accepted Root work below
    // owns effects; none of this RunSpec's serialized identities grants a Host capability.
    let spec = RunSpec {
        schema_version: SCHEMA_VERSION, session_id: base.session.clone(), owner,
        turn_id: "image-turn".into(), origin: RunOrigin::Local, trigger: Trigger::Message {message_id: "image-message".into()},
        workspace: std::env::current_dir().unwrap().to_str().unwrap().into(),
        permission_basis: serde_json::from_value(json!({"boundaryRevision":0,"binding":{"id":Uuid::new_v4(),"permissionEpoch":0}})).unwrap(),
        permission_ceiling: serde_json::from_value(json!({"sandbox":{"kind":"managed","filesystem":{"default":"deny","rules":[],"denyGlobs":[]},"network":"denied"},"approval":{"kind":"never"}})).unwrap(),
        backend: BackendSpec::Model {binding: binding.clone(), descriptor: descriptor.reference().clone()},
        collaboration: CollaborationMode::Agent, language: Language::En, tool_discovery: false, allowed_tools: None, mcp_revision: None, compaction_prompt: None,
        system_prompt: system.reference().clone(), tool_selection: tools.reference().clone(), input: input.reference().clone(), budget: Budget {tokens: None, retries: 1, deadline: None}, budget_basis: None,
    };
    let admission = Admission::new(
        spec,
        UnixMillis(1),
        vec![input, system, tools.clone(), descriptor],
    );
    let run = admission.run();
    state.admit(admission).await.unwrap();
    let claim = state.claim(run).await.unwrap();
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let parent = ToolKey {
        attempt,
        call: "exec".into(),
    };
    let evidence =
        ContentBlob::json(&json!({"fixture":"frozen synchronous model source"})).unwrap();
    let reference = evidence.reference().clone();
    let request = ContentBlob::json(&RequestSpec {
        schema_version: SCHEMA_VERSION,
        step,
        composition: RequestComposition {
            system_prompt: None,
            dynamic_context: vec![],
            tool_catalog_digest: tools.reference().digest.clone(),
            tools: definitions.into_iter().map(Arc::new).collect(),
            provider_options: None,
            max_output_tokens: None,
            sources: vec![],
        },
        summary_repair_of: None,
        compaction_recovery: None,
        source_capture: reference.clone(),
        source_digest: reference.digest.clone(),
        effective_source_digest: reference.digest.clone(),
        provenance: reference.clone(),
        projection: None,
        adjudications: vec![],
        steering: vec![],
        request: reference.clone(),
        protocol: "frozen-parts".into(),
        protocol_version: 1,
        recovery_contract: reference,
        request_contents: vec![],
        accounting: maka_agent_facts::accounting::ModelEvidence {
            binding,
            model_id: "frozen-parts".into(),
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            quote: None,
        },
    })
    .unwrap();
    let input = ContentBlob::json(&json!({"code":SOURCE})).unwrap();
    let facts = vec![
        Fact::StepPrepared {
            step,
            request: request.reference().clone(),
            adjudications: vec![],
        },
        Fact::ModelAttemptPrepared { attempt, step },
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: json!({"fixture":"frozen synchronous source"}),
        },
        Fact::ModelObserved {
            attempt,
            index: 0,
            part: ModelPart::ToolCall {
                call: ModelToolCall {
                    id: parent.call.clone(),
                    name: "exec".into(),
                    input: ToolInput::Json(json!({"code":SOURCE})),
                    provider_executed: false,
                    provider_options: None,
                },
            },
            continuation: None,
        },
        Fact::ModelClosed {
            attempt,
            outcome: maka_agent_facts::accounting::Outcome::Success,
            diagnostic: None,
            usage: Default::default(),
            protocol: json!({"fixture":"synchronous source closed"}),
        },
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: OperationCleanup::Confirmed,
        },
        Fact::ToolDecided {
            tool: parent.clone(),
            decision: ToolDecision::Approved {
                semantics: ToolSemantics::Parallel,
                input: input.reference().clone(),
                resources: vec![],
                approval: None,
                display: Default::default(),
            },
        },
        Fact::ToolAdmitted {
            tool: parent.clone(),
        },
    ];
    let view = state.frontier(run).await.unwrap();
    state
        .append(
            &claim,
            (&view).into(),
            facts
                .into_iter()
                .map(|fact| Change::new(fact, UnixMillis(2)))
                .collect(),
            vec![request, evidence, input],
        )
        .await
        .unwrap();
    let view = state.frontier(run).await.unwrap();
    AgentCellPort {
        root: base.root.clone(),
        custody: base.custody.clone(),
        data: base.data.clone(),
        execution: ExecutionIdentity {
            session_id: view.spec.session_id,
            turn_id: view.spec.turn_id,
            run_id: run,
        },
        state,
        claim,
        link: AgentStepLink { run, step, attempt },
        parent,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_image_is_committed_before_js_and_explicit_output_projects_it() {
    let directory = tempfile::tempdir().unwrap();
    let base = Fixture::open(directory.path(), "image").await;
    let state = Store::new(
        base.data.clone(),
        DriverDomain::new(base.data.clone()).unwrap(),
    )
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let tools = Arc::new(ImageTools {
        state: state.clone(),
        calls: calls.clone(),
    });
    let catalog = ToolCatalog::new(["read", "verify"].map(|name| ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: name.into(),
            description: "image fixture".into(),
            input_schema: json!({"type":"object"}),
        },
        handler: ToolHandler::Prepared(tools.clone()),
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
    }))
    .unwrap();
    let port = Arc::new(
        admit_agent(
            &base,
            state.clone(),
            CodeCells::definitions_for(&catalog, CodeLanguage::JavaScript),
        )
        .await,
    );
    let cells = base.cells(CodeExecutor::new(CellLimits::default()).unwrap());
    let admission = CellAdmission::new(SOURCE.into(), port.owner(), port.now());
    let cell = cells
        .start_cell(&admission, catalog, port.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(cell, port.cell());
    let observed = cells
        .observe_cell(
            cell,
            Duration::from_secs(10),
            false,
            port.clone(),
            CancellationToken::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let CellReplyState::Completed {
        result: original_completion,
    } = &observed.state
    else {
        panic!("image Cell did not complete")
    };
    let original_completion = original_completion.clone();
    let CellObservation::Completed {
        content, result, ..
    } = &observed.observation
    else {
        panic!("image report missing")
    };
    assert_eq!(result["ok"], true);
    assert_eq!(content.len(), 2);
    let CellOutput::Image { image: emitted } = &content[0] else {
        panic!("explicit image output lost its type")
    };
    assert_eq!(emitted.detail, Some(ImageDetail::Original));
    let CellOutput::Text { text } = &content[1] else {
        panic!("verified image descriptor missing")
    };
    let image: Value = serde_json::from_str(text).unwrap();
    assert_eq!(image["kind"], "image");
    assert_eq!(
        serde_json::to_value(&emitted.reference).unwrap(),
        image["ref"]
    );
    let artifact_id = image["ref"]["relativePath"].as_str().unwrap().to_owned();
    let normalized = CodeCells::project_observation(cell, observed, 1000)
        .into_durable("exec-result", SystemTime::now(), &port.execution)
        .unwrap();
    assert!(!normalized.is_error);
    assert!(
        normalized.loaded_tools.is_empty(),
        "a Cell observation is not a tool-search activation"
    );
    assert!(
        normalized.artifacts.is_empty(),
        "explicit image output references the original child artifact"
    );
    assert!(
        matches!(&normalized.projection, DurableToolProjection::Content {parts} if parts.iter().any(|part| matches!(part, ProjectionPart::Artifact {image} if image.detail == Some(ImageDetail::Original))))
    );
    let current = state.frontier(port.execution.run_id).await.unwrap();
    let CellStatus::Completed {
        publication,
        accepted: false,
        ..
    } = &current.cells[&cell].status
    else {
        panic!("Cell must await atomic original acceptance")
    };
    let returned = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: ReturnedToolResult {
            output: normalized.output,
            projection: normalized.projection,
            is_error: false,
            loaded_tools: normalized.loaded_tools,
        },
    })
    .unwrap();
    let accepted = ContentBlob::json(&AcceptedToolResult::Local {
        result: returned.reference().clone(),
    })
    .unwrap();
    let mut changes = vec![
        Change::new(
            Fact::LocalToolReturned {
                tool: port.parent.clone(),
                result: returned.reference().clone(),
                is_error: false,
                settlement: ToolSettlement::Returned,
            },
            UnixMillis(4),
        ),
        Change::new(
            Fact::Cell {
                event: CellEvent::ResultAccepted { cell },
            },
            UnixMillis(4),
        ),
    ];
    changes.extend(publication.values.iter().map(|(key, value)| {
        Change::new(
            Fact::Cell {
                event: CellEvent::SessionValuePublished {
                    cell,
                    key: key.clone(),
                    value: value.clone(),
                },
            },
            UnixMillis(4),
        )
    }));
    if let Some(names) = &publication.loaded_tools {
        changes.push(Change::new(
            Fact::Cell {
                event: CellEvent::LoadedToolsPublished {
                    cell,
                    names: names.clone(),
                },
            },
            UnixMillis(4),
        ));
    }
    changes.push(Change::new(
        Fact::ToolResultAccepted {
            tool: port.parent.clone(),
            result: accepted.reference().clone(),
            outcome: AcceptedResult::Succeeded,
        },
        UnixMillis(4),
    ));
    let parent_return = returned.reference().clone();
    state
        .append(
            &port.claim,
            (&current).into(),
            changes,
            vec![returned, accepted],
        )
        .await
        .unwrap();
    let view = state.frontier(port.execution.run_id).await.unwrap();
    let completed = state
        .cells()
        .read(&base.session, cell)
        .await
        .unwrap()
        .unwrap();
    assert!(!completed.pending());
    assert!(completed.physical_cleanup_confirmed());
    let scope = ArtifactScope {
        owner: view.spec.owner.clone(),
        session: view.spec.session_id.clone(),
        run: view.run,
        through: view.revision,
    };
    let mut foreign = scope.clone();
    foreign.session = "foreign".into();
    assert!(
        state
            .artifacts()
            .chunk(foreign, artifact_id.clone(), 0, 1024)
            .await
            .is_err()
    );
    let mut foreign = scope.clone();
    foreign.owner.namespace = InstanceId(vec![Uuid::new_v4()]);
    assert!(
        state
            .artifacts()
            .chunk(foreign, artifact_id.clone(), 0, 1024)
            .await
            .is_err()
    );
    cells.shutdown().await.unwrap();
    state
        .append(
            &port.claim,
            (&view).into(),
            vec![Change::new(
                Fact::RunTerminated {
                    terminal: Terminal::Completed,
                    diagnostic: None,
                },
                UnixMillis(5),
            )],
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    drop(cells);
    drop(port);
    drop(tools);
    drop(state);
    base.close().await;
    let reopened = Fixture::open(directory.path(), "image").await;
    let state = Store::new(
        reopened.data.clone(),
        DriverDomain::new(reopened.data.clone()).unwrap(),
    )
    .unwrap();
    let artifact = state
        .artifacts()
        .chunk(scope.clone(), artifact_id, 0, 1024)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(artifact.bytes, GIF);
    assert_eq!(
        artifact.record.artifact.source,
        ArtifactSource::ToolResultProjection
    );
    assert_eq!(artifact.record.payload.digest, content_digest(GIF));
    let original: CellObservation = serde_json::from_slice(
        &state
            .cells()
            .content(&scope.session, cell, original_completion)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(
        matches!(original, CellObservation::Completed {content, ..} if matches!(&content[0], CellOutput::Image {image} if image.detail == Some(ImageDetail::Original)))
    );
    let returned: ToolReturn<ReturnedToolResult> =
        serde_json::from_slice(&state.content(scope.run, parent_return).await.unwrap()).unwrap();
    assert!(
        matches!(returned.body.projection, DurableToolProjection::Content {parts} if parts.iter().any(|part| matches!(part, ProjectionPart::Artifact {image} if image.detail == Some(ImageDetail::Original))))
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "reopening reads original material without replay"
    );
    drop(state);
    reopened.close().await;
}
