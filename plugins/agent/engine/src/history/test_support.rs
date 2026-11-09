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

//! Real canonical admission and request resources shared by model preparation tests.
use super::{
    capture_arena::CaptureArena, preparation::RequestPreparation, preparation_io::PreparationIo,
};
use crate::prepared_prompt::PreparedPrompt;
use maka_agent_facts::{
    composition::RequestComposition,
    durable::*,
    execution::{CollaborationMode, ModelBinding},
    input::{MessageInput, RunInput},
    language::Language,
    model::{ModelPart, ModelToolCall, ToolInput},
};
use maka_agent_state::{Admission, Change, ContentBlob, DriverDomain, Store};
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionStore, SessionWorkLease, WorkEffects},
};
use maka_model::{ModelPreparationResources, prompt::Message};
use serde_json::json;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(crate) fn catalog() -> Vec<maka_event_log::migration::Migration> {
    maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect()
}
pub(crate) async fn open(path: &Path, existing: bool) -> RootStore {
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let owner = if existing {
        RootOwner::open_existing(&path.join("root"), &namespaces)
    } else {
        RootOwner::create(&path.join("root"), &namespaces)
    }
    .unwrap();
    RootStore::open(Arc::new(owner), &catalog()).await.unwrap()
}
pub(crate) async fn work(root: &RootStore) -> (Arc<SessionStore>, SessionWorkLease, WorkEffects) {
    let session = root.session("session").await.unwrap();
    let (work, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    (Arc::new(work.store()), work, effects)
}
pub(crate) fn state(root: &RootStore) -> Store {
    let data = root.data_writer().unwrap();
    Store::new(data.clone(), DriverDomain::new(data).unwrap()).unwrap()
}
pub(crate) fn owner() -> RunOwner {
    RunOwner {
        deployment: uuid::Uuid::from_u128(1),
        namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::from_u128(2)]),
    }
}
pub(crate) fn spec(input: ContentBlob, message_id: &str) -> (RunSpec, Vec<ContentBlob>) {
    let system = ContentBlob::json(&"").unwrap();
    let tools = ContentBlob::json(&Vec::<String>::new()).unwrap();
    let descriptor = ContentBlob::json(&json!({"model":"fixture"})).unwrap();
    let spec = RunSpec {
        schema_version: SCHEMA_VERSION, session_id: "session".into(), owner: owner(), turn_id: "turn".into(),
        origin: RunOrigin::Local, trigger: Trigger::Message { message_id: message_id.into() }, workspace: "/fixture".into(),
        permission_basis: serde_json::from_value(json!({"boundaryRevision":0,"binding":{"id":uuid::Uuid::from_u128(3),"permissionEpoch":0}})).unwrap(),
        permission_ceiling: serde_json::from_value(json!({"sandbox":{"kind":"disabled"},"approval":{"kind":"never"}})).unwrap(),
        backend: BackendSpec::Model { binding: ModelBinding { connection_id: "fixture".into(), connection_slug: "fixture".into(), model: "fixture".into() }, descriptor: descriptor.reference().clone() },
        collaboration: CollaborationMode::Agent, language: Language::En, tool_discovery: false, allowed_tools: None, mcp_revision: None, compaction_prompt: None,
        system_prompt: system.reference().clone(), tool_selection: tools.reference().clone(), input: input.reference().clone(),
        budget: Budget { tokens: None, retries: 1, deadline: None },
        budget_basis: None,
    };
    (spec, vec![input, system, tools, descriptor])
}
pub(crate) fn request(steering: Vec<ContentRef>) -> (StepId, ContentBlob, Vec<ContentBlob>) {
    request_with_contents(steering, vec![])
}
pub(crate) fn request_with_contents(
    steering: Vec<ContentRef>,
    request_contents: Vec<ContentRef>,
) -> (StepId, ContentBlob, Vec<ContentBlob>) {
    request_with_composition(
        steering,
        request_contents,
        RequestComposition {
            system_prompt: None,
            dynamic_context: vec![],
            tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"[]"),
            tools: vec![],
            provider_options: None,
            max_output_tokens: None,
            sources: vec![],
        },
    )
}
pub(crate) fn request_with_composition(
    steering: Vec<ContentRef>,
    request_contents: Vec<ContentRef>,
    composition: RequestComposition,
) -> (StepId, ContentBlob, Vec<ContentBlob>) {
    let step = StepId::new();
    let evidence = ContentBlob::json(&json!({"fixture":"frozen request"})).unwrap();
    let reference = evidence.reference().clone();
    let request = ContentBlob::json(&RequestSpec {
        schema_version: SCHEMA_VERSION,
        summary_repair_of: None,
        compaction_recovery: None,
        step,
        composition,
        source_capture: reference.clone(),
        source_digest: reference.digest.clone(),
        effective_source_digest: reference.digest.clone(),
        provenance: reference.clone(),
        projection: None,
        adjudications: vec![],
        steering,
        request: reference.clone(),
        protocol: "fixture".into(),
        protocol_version: 1,
        recovery_contract: reference,
        request_contents,
        accounting: maka_agent_facts::accounting::ModelEvidence {
            binding: ModelBinding {
                connection_id: "fixture".into(),
                connection_slug: "fixture".into(),
                model: "fixture".into(),
            },
            model_id: "fixture".into(),
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            quote: None,
        },
    })
    .unwrap();
    (step, request.clone(), vec![evidence, request])
}
pub(crate) async fn admit(store: &Store, content: MessageInput) -> RunId {
    let input = ContentBlob::json(&RunInput::Message {
        content,
        request_fingerprint: None,
        source_messages: vec![],
    })
    .unwrap();
    let (spec, contents) = spec(input, &uuid::Uuid::new_v4().to_string());
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let run = admission.run();
    store.admit(admission).await.unwrap();
    run
}
pub(crate) async fn admit_tool(store: &Store) -> (RunId, ToolKey) {
    let run = admit(store, "prior".into()).await;
    let claim = store.claim(run).await.unwrap();
    let view = store.frontier(run).await.unwrap();
    let (step, request, mut contents) = request(vec![]);
    let input = ContentBlob::json(&json!({})).unwrap();
    contents.push(input.clone());
    let attempt = ModelAttemptId::new();
    let tool = ToolKey {
        attempt,
        call: "call".into(),
    };
    let facts = vec![
        Fact::StepPrepared {
            step,
            request: request.reference().clone(),
            adjudications: vec![],
        },
        Fact::ModelAttemptPrepared { attempt, step },
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: json!({"fixture":"admitted"}),
        },
        Fact::ModelObserved {
            attempt,
            index: 0,
            part: ModelPart::ToolCall {
                call: ModelToolCall {
                    id: tool.call.clone(),
                    name: "Read".into(),
                    input: ToolInput::Json(json!({})),
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
            protocol: serde_json::to_value(maka_agent_facts::context::ModelClosureProtocol {
                finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
                compaction: None,
                summary: None,
            })
            .unwrap(),
        },
        Fact::ToolDecided {
            tool: tool.clone(),
            decision: ToolDecision::Approved {
                semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                display: Default::default(),
                input: input.reference().clone(),
                resources: vec![],
                approval: None,
            },
        },
        Fact::ToolAdmitted { tool: tool.clone() },
    ];
    store
        .append(
            &claim,
            (&view).into(),
            facts
                .into_iter()
                .map(|fact| Change::new(fact, UnixMillis(2)))
                .collect(),
            contents,
        )
        .await
        .unwrap();
    (run, tool)
}

/// Stop before media planning so tests can exercise rejection and peak admission separately.
pub(crate) async fn capture(
    log: &SessionStore,
    messages: Vec<Message>,
    resources: ModelPreparationResources,
) -> PreparedPrompt {
    let io = PreparationIo::new(log).unwrap();
    let metadata = CaptureArena::metadata_bytes() + RequestPreparation::metadata_bytes();
    let preparation = RequestPreparation::new(resources.reserve_staging(metadata).await.unwrap());
    let arena = CaptureArena::new(io, None).await.unwrap();
    let mut builder = super::canonical_prompt::Builder::new(
        arena.clone(),
        resources.clone(),
        preparation.clone(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    for message in messages {
        builder.append(message).await.unwrap();
    }
    let captured = builder.finish_captured().await.unwrap();
    PreparedPrompt::from_canonical(
        captured.prompt,
        arena,
        resources,
        preparation,
        captured.resident_bytes,
    )
}

pub(crate) async fn enqueue(
    store: &Store,
    source: maka_agent_facts::message::RootSourceMessage,
    sources: Vec<maka_agent_facts::message::RootSourceMessage>,
    placement: maka_agent_state::queue::Placement,
) -> maka_agent_state::queue::PreparedRequest {
    use maka_agent_state::queue::{PreparedRequest, QueueCommand, QueueEdit, RequestId};
    let content =
        maka_agent_facts::message::aggregate(sources.iter().map(|source| &source.message.content));
    let input = ContentBlob::json(&RunInput::Message {
        content,
        request_fingerprint: None,
        source_messages: sources,
    })
    .unwrap();
    let (spec, mut contents) = spec(input, &source.message.message_id);
    let source_blob = ContentBlob::json(&source).unwrap();
    let resources = ContentBlob::json(&Vec::<String>::new()).unwrap();
    let request = PreparedRequest {
        id: RequestId(source.message.message_id.clone()),
        message_id: source.message.message_id,
        spec,
        source: source_blob.reference().clone(),
        resources: resources.reference().clone(),
        required_tools: Default::default(),
    };
    contents.extend([source_blob, resources]);
    let queue = store.queue();
    let revision = queue.read("session".into()).await.unwrap().revision;
    queue
        .execute(
            "session".into(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(1),
                expected_revision: revision,
                edit: QueueEdit::Enqueue {
                    request: Box::new(request.clone()),
                    placement,
                },
            },
            contents,
        )
        .await
        .unwrap();
    request
}
