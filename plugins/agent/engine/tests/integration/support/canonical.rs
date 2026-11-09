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

use super::native::NativeFixture;
use futures_util::future::BoxFuture;
use maka_agent_api::Configuration;
use maka_agent_engine::{DriverExit, Engine, ModelWitness, RunError, ports::*};
use maka_agent_facts::{
    accounting::ModelEvidence,
    composition::RequestComposition,
    context::{ModelPurpose, PreparedContextBreakdown},
    durable::*,
    execution::{CollaborationMode, ModelBinding},
    input::RunInput,
    language::Language,
};
use maka_agent_state::{
    Change, Commit, ContentBlob, Store,
    fold::{RunView, Tool},
};
use maka_plugin_core::{
    composition::InstanceId,
    operation::{OperationReply, RecoveryRef},
};
use serde_json::json;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) fn configuration() -> Configuration {
    serde_json::from_value(json!({
        "permissions": {"access": "read_only", "requestPermissions": false},
        "workspaceRoots": [], "tools": [],
    }))
    .unwrap()
}

// These were Root transaction tests, not transport tests. No port may execute
// effects, infer adapter recovery or manufacture authority from a seeded spec.
// Only the production Engine chooses charging, waiting and terminal settlement.
pub(crate) struct NoEffects(pub(crate) UnixMillis);
impl DriverPorts for NoEffects {
    fn external(&self) -> Option<Arc<dyn ExternalPorts>> {
        None
    }
    fn cells(&self) -> Option<Arc<dyn CellPorts>> {
        None
    }
    fn publication(&self) -> Option<Arc<dyn ExternalPublicationPorts>> {
        None
    }
    fn now(&self) -> UnixMillis {
        self.0
    }
    fn prepare_step<'a>(
        &'a self,
        _: &'a RunView,
        _: Preparation,
    ) -> BoxFuture<'a, Result<PreparedStep, RunError>> {
        panic!("store-boundary retry must retain its frozen request")
    }
    fn assess_recovery<'a>(
        &'a self,
        _: &'a RunView,
        _: ModelAttemptId,
        _: RequestSpec,
    ) -> BoxFuture<'a, Result<RecoveryEvidence, RunError>> {
        panic!("store-boundary retry already has original protocol evidence")
    }
    fn validate_transport_selection<'a>(
        &'a self,
        _: &'a RunView,
        _: ModelAttemptId,
        _: maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ) -> BoxFuture<'a, Result<(), RunError>> {
        panic!("immutable store seeds grant no live transport-selection capability")
    }
    fn start_model(
        &self,
        _: RunId,
        _: ModelAttemptId,
        _: RequestSpec,
        _: Vec<u8>,
        _: ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        panic!("immutable store seeds grant no model dispatch capability")
    }
    fn observe_model(
        &self,
        _: RunId,
        _: ModelAttemptId,
        _: ContentRef,
        _: u64,
        _: ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        panic!("no original transport exists in this storage-boundary test")
    }
    fn decide_tool<'a>(
        &'a self,
        _: &'a RunView,
        _: &'a Tool,
    ) -> BoxFuture<'a, Result<PreparedDecision, RunError>> {
        panic!("retry fixture has no tools")
    }
    fn validate_tool<'a>(
        &'a self,
        _: &'a RunView,
        _: &'a Tool,
    ) -> BoxFuture<'a, Result<ToolValidation, RunError>> {
        panic!("retry fixture has no tools")
    }
    fn lookup_original(
        &self,
        _: RunId,
        _: ToolKey,
    ) -> BoxFuture<'_, Result<OriginalLookup, RunError>> {
        panic!("retry fixture has no Host operations")
    }
    fn dispatch_tool(&self, _: RunId, _: Tool) -> BoxFuture<'_, Result<DispatchOutcome, RunError>> {
        panic!("retry fixture has no Host operations")
    }
    fn observe_operation(&self, _: RecoveryRef) -> BoxFuture<'_, Result<OperationReply, RunError>> {
        panic!("retry fixture has no Host operations")
    }
    fn cancel_live(&self, _: RunId) {}
    fn cancel_model(&self, _: RunId, _: ModelAttemptId) -> BoxFuture<'_, Result<(), RunError>> {
        Box::pin(async {
            Err(RunError::Internal(
                "metadata fixture has no original live model source".into(),
            ))
        })
    }
}

pub(crate) async fn drive(state: &Store, run: RunId, at: UnixMillis) -> DriverExit {
    Engine::new(state.clone())
        .drive(
            state.claim(run).await.unwrap(),
            Arc::new(NoEffects(at)),
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

pub(crate) async fn append(
    state: &Store,
    run: RunId,
    changes: Vec<Change>,
    contents: Vec<ContentBlob>,
) -> Result<Commit, maka_event_log::StoreError> {
    let claim = state.claim(run).await?;
    let head = (&state.frontier(run).await?).into();
    state.append(&claim, head, changes, contents).await
}

pub(crate) fn binding() -> ModelBinding {
    ModelBinding {
        connection_id: "fixture".into(),
        connection_slug: "fixture".into(),
        model: "model".into(),
    }
}

pub(crate) fn request(step: StepId) -> (RequestSpec, Vec<ContentBlob>) {
    let body =
        ContentBlob::json(&json!({"messages": [{"role": "user", "content": "frozen input"}]}))
            .unwrap();
    let provenance = ContentBlob::json(&json!({
        "breakdown": PreparedContextBreakdown::default(),
        "modelContext": null, "previousCheckpointId": null,
    }))
    .unwrap();
    let reference = body.reference().clone();
    let request = RequestSpec {
        schema_version: SCHEMA_VERSION,
        step,
        composition: RequestComposition {
            system_prompt: Some("frozen system".into()),
            dynamic_context: vec![],
            tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"[]"),
            tools: vec![],
            provider_options: None,
            max_output_tokens: None,
            sources: vec![],
        },
        source_capture: reference.clone(),
        source_digest: reference.digest.clone(),
        effective_source_digest: reference.digest.clone(),
        provenance: provenance.reference().clone(),
        projection: None,
        adjudications: vec![],
        steering: vec![],
        request: reference.clone(),
        summary_repair_of: None,
        compaction_recovery: None,
        protocol: "store-boundary-fixture".into(),
        protocol_version: 1,
        recovery_contract: reference,
        request_contents: vec![],
        accounting: ModelEvidence {
            binding: binding(),
            model_id: "model".into(),
            purpose: ModelPurpose::Main,
            quote: None,
        },
    };
    (request, vec![body, provenance])
}

pub(crate) fn spec(
    fixture: &NativeFixture,
    workspace: &Path,
    session: &str,
    turn: &str,
    text: &str,
) -> (RunSpec, Vec<ContentBlob>) {
    let input = ContentBlob::json(&RunInput::Message {
        content: text.into(),
        source_messages: vec![],
        request_fingerprint: None,
    })
    .unwrap();
    let system = ContentBlob::json(&"frozen system").unwrap();
    let tools = ContentBlob::json(&Vec::<String>::new()).unwrap();
    let descriptor = ContentBlob::json(&json!({"model": "model"})).unwrap();
    // The real SDK consumer owns this inert storage fixture. Native's provider
    // scheduler therefore cannot race the deterministic Engine clock below.
    let owner = RunOwner {
        deployment: fixture.app.source().unwrap().deployment,
        namespace: InstanceId(vec![Uuid::from_u128(2)]),
    };
    let spec = RunSpec {
        schema_version: SCHEMA_VERSION,
        session_id: session.into(),
        owner: owner.clone(),
        turn_id: turn.into(),
        origin: RunOrigin::Local,
        trigger: Trigger::Message {
            message_id: format!("message:{turn}"),
        },
        workspace: workspace.to_str().unwrap().into(),
        permission_basis: serde_json::from_value(
            json!({"boundaryRevision": 0, "binding": {"id": Uuid::new_v4(), "permissionEpoch": 0}}),
        )
        .unwrap(),
        permission_ceiling: serde_json::from_value(
            json!({"sandbox": {"kind": "disabled"}, "approval": {"kind": "never"}}),
        )
        .unwrap(),
        backend: BackendSpec::Model {
            binding: binding(),
            descriptor: descriptor.reference().clone(),
        },
        collaboration: CollaborationMode::Agent,
        language: Language::En,
        tool_discovery: false,
        allowed_tools: None,
        mcp_revision: None,
        compaction_prompt: None,
        system_prompt: system.reference().clone(),
        tool_selection: tools.reference().clone(),
        input: input.reference().clone(),
        budget: Budget {
            tokens: None,
            retries: 1,
            deadline: None,
        },
        budget_basis: None,
    };
    (spec, vec![input, system, tools, descriptor])
}

pub(crate) async fn admitted_model(state: &Store, run: RunId, at: UnixMillis) -> AgentStepLink {
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let (request, mut contents) = request(step);
    let blob = ContentBlob::json(&request).unwrap();
    contents.push(blob.clone());
    append(
        state,
        run,
        vec![
            Change::new(
                Fact::StepPrepared {
                    step,
                    request: blob.reference().clone(),
                    adjudications: vec![],
                },
                at,
            ),
            Change::new(Fact::ModelAttemptPrepared { attempt, step }, at),
            Change::new(
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: json!({"original": true}),
                },
                at,
            ),
        ],
        contents,
    )
    .await
    .unwrap();
    AgentStepLink { run, step, attempt }
}

pub(crate) fn finished_model(link: AgentStepLink, at: UnixMillis) -> Vec<Change> {
    vec![
        Change::new(
            Fact::ModelClosed {
                attempt: link.attempt,
                outcome: maka_agent_facts::accounting::Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: json!({"finishReason": "stop"}),
            },
            at,
        ),
        Change::new(
            Fact::ModelCleanupObserved {
                attempt: link.attempt,
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            },
            at,
        ),
    ]
}

// Only a read of an original provider journal is added to the metadata ports.
// No discovery, dispatch, recovery policy or grant can be reconstructed here.
pub(crate) struct OriginalReceipts {
    pub(crate) clock: NoEffects,
    pub(crate) root: Arc<maka_event_log::root_store::RootStore>,
}
impl DriverPorts for OriginalReceipts {
    fn external(&self) -> Option<Arc<dyn ExternalPorts>> {
        self.clock.external()
    }
    fn cells(&self) -> Option<Arc<dyn CellPorts>> {
        self.clock.cells()
    }
    fn publication(&self) -> Option<Arc<dyn ExternalPublicationPorts>> {
        self.clock.publication()
    }
    fn now(&self) -> UnixMillis {
        self.clock.now()
    }
    fn prepare_step<'a>(
        &'a self,
        view: &'a RunView,
        preparation: Preparation,
    ) -> BoxFuture<'a, Result<PreparedStep, RunError>> {
        self.clock.prepare_step(view, preparation)
    }
    fn assess_recovery<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        request: RequestSpec,
    ) -> BoxFuture<'a, Result<RecoveryEvidence, RunError>> {
        self.clock.assess_recovery(view, attempt, request)
    }
    fn validate_transport_selection<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        phase: maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ) -> BoxFuture<'a, Result<(), RunError>> {
        self.clock
            .validate_transport_selection(view, attempt, phase)
    }
    fn start_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        request: RequestSpec,
        bytes: Vec<u8>,
        witness: ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        self.clock
            .start_model(run, attempt, request, bytes, witness)
    }
    fn observe_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        descriptor: ContentRef,
        after: u64,
        witness: ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        self.clock
            .observe_model(run, attempt, descriptor, after, witness)
    }
    fn decide_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<PreparedDecision, RunError>> {
        self.clock.decide_tool(view, tool)
    }
    fn validate_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<ToolValidation, RunError>> {
        self.clock.validate_tool(view, tool)
    }
    fn lookup_original(
        &self,
        run: RunId,
        key: ToolKey,
    ) -> BoxFuture<'_, Result<OriginalLookup, RunError>> {
        self.clock.lookup_original(run, key)
    }
    fn dispatch_tool(
        &self,
        run: RunId,
        tool: Tool,
    ) -> BoxFuture<'_, Result<DispatchOutcome, RunError>> {
        self.clock.dispatch_tool(run, tool)
    }
    fn observe_operation(
        &self,
        reference: RecoveryRef,
    ) -> BoxFuture<'_, Result<OperationReply, RunError>> {
        Box::pin(async move {
            let observation = self
                .root
                .operation(&reference)?
                .operation_observation()
                .await?;
            let receipt = match observation {
                Some(original) => maka_plugin_core::operation::Receipt::Recorded {
                    outcome: original.outcome,
                    cleanup: original.cleanup,
                },
                None => maka_plugin_core::operation::Receipt::NotRecorded,
            };
            Ok(OperationReply { reference, receipt })
        })
    }
    fn cancel_live(&self, run: RunId) {
        self.clock.cancel_live(run)
    }
    fn cancel_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
    ) -> BoxFuture<'_, Result<(), RunError>> {
        self.clock.cancel_model(run, attempt)
    }
}
