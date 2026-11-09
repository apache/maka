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

#![allow(dead_code)]
use maka_agent_facts::{
    composition::RequestComposition,
    durable::*,
    execution::{CollaborationMode, ModelBinding},
    input::RunInput,
    language::Language,
    model::{ModelPart, ModelToolCall, ToolInput},
};
use maka_agent_state::{Admission, Change, Commit, ContentBlob, DriverDomain, Store};
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use serde_json::json;
use std::{path::Path, sync::Arc};
pub(crate) mod imported;
pub(crate) fn owner() -> RunOwner {
    RunOwner {
        deployment: uuid::Uuid::from_u128(1),
        namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::from_u128(2)]),
    }
}
pub(crate) async fn open(path: &Path, existing: bool) -> RootStore {
    let namespaces = RootNamespaces {
        ownership: path.join("ownership"),
        control: path.join("control"),
    };
    let owner = if existing {
        RootOwner::open(&path.join("root"), &namespaces)
    } else {
        RootOwner::create(&path.join("root"), &namespaces)
    }
    .unwrap();
    let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect();
    RootStore::open(Arc::new(owner), &migrations).await.unwrap()
}
pub(crate) fn state(root: &RootStore) -> Store {
    let data = root.data_writer().unwrap();
    Store::new(data.clone(), DriverDomain::new(data).unwrap()).unwrap()
}
pub(crate) async fn create(root: &RootStore, session: &str) {
    root.create_session(session, &format!("create:{session}"), &json!({}), 1)
        .await
        .unwrap();
}
pub(crate) fn spec(session: &str, turn: &str, text: &str) -> (RunSpec, Vec<ContentBlob>) {
    let input = ContentBlob::json(&RunInput::Message {
        content: text.into(),
        request_fingerprint: None,
        source_messages: vec![],
    })
    .unwrap();
    let system = ContentBlob::json(&"").unwrap();
    let tools = ContentBlob::json(&Vec::<String>::new()).unwrap();
    let descriptor = ContentBlob::json(&json!({"model":"fixture"})).unwrap();
    let spec=RunSpec{
        schema_version:SCHEMA_VERSION,session_id:session.into(),owner:owner(),turn_id:turn.into(),origin:RunOrigin::Local,trigger:Trigger::Message{message_id:format!("message:{turn}")},workspace:"/fixture".into(),
        permission_basis:serde_json::from_value(json!({"boundaryRevision":0,"binding":{"id":uuid::Uuid::from_u128(3),"permissionEpoch":0}})).unwrap(),
        permission_ceiling:serde_json::from_value(json!({"sandbox":{"kind":"disabled"},"approval":{"kind":"never"}})).unwrap(),
        backend:BackendSpec::Model{binding:ModelBinding{connection_id:"fixture".into(),connection_slug:"fixture".into(),model:"fixture".into()},descriptor:descriptor.reference().clone()},
        collaboration:CollaborationMode::Agent,language:Language::En,tool_discovery:false,allowed_tools:None,mcp_revision:None,compaction_prompt:None,system_prompt:system.reference().clone(),tool_selection:tools.reference().clone(),input:input.reference().clone(),budget:Budget{tokens:None,retries:1,deadline:None},budget_basis:None,
    };
    (spec, vec![input, system, tools, descriptor])
}
pub(crate) async fn admit(store: &Store, session: &str, turn: &str, text: &str) -> RunId {
    let (spec, contents) = spec(session, turn, text);
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let run = admission.run();
    store.admit(admission).await.unwrap();
    run
}
pub(crate) async fn append(
    store: &Store,
    run: RunId,
    facts: Vec<Fact>,
    contents: Vec<ContentBlob>,
) -> Commit {
    let claim = store.claim(run).await.unwrap();
    let view = store.frontier(run).await.unwrap();
    store
        .append(
            &claim,
            (&view).into(),
            facts
                .into_iter()
                .map(|fact| Change::new(fact, UnixMillis(view.revision as i64 + 1)))
                .collect(),
            contents,
        )
        .await
        .unwrap()
}
pub(crate) async fn complete(store: &Store, run: RunId) {
    append(
        store,
        run,
        vec![Fact::RunTerminated {
            terminal: Terminal::Completed,
            diagnostic: None,
        }],
        vec![],
    )
    .await;
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
        step,
        summary_repair_of: None,
        compaction_recovery: None,
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
    let (mut spec, mut contents) = spec("session", "queued", "");
    let old_input = spec.input.clone();
    contents.retain(|content| content.reference() != &old_input);
    spec.input = input.reference().clone();
    spec.trigger = Trigger::Message {
        message_id: source.message.message_id.clone(),
    };
    contents.push(input);
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

pub(crate) fn adoption_spec(
    source: &maka_agent_state::session_history::snapshot::Snapshot,
    session: &str,
    turn: &str,
) -> (RunSpec, Vec<ContentBlob>) {
    let (mut spec, mut contents) = spec(session, turn, "");
    let old = spec.input.clone();
    contents.retain(|blob| blob.reference() != &old);
    let input = ContentBlob::json(&RunInput::HistorySource {
        source: source.reference().clone(),
    })
    .unwrap();
    spec.input = input.reference().clone();
    contents.push(input);
    spec.origin = RunOrigin::Imported {
        source: source.reference().clone(),
    };
    spec.trigger = Trigger::HistorySource;
    spec.backend = BackendSpec::Historical {};
    (spec, contents)
}

pub(crate) async fn admitted_tool(store: &Store) -> (RunId, ToolKey) {
    let (mut spec, contents) = spec("session", "tool-turn", "prior");
    spec.trigger = Trigger::Message {
        message_id: format!("tool-message-{}", uuid::Uuid::new_v4()),
    };
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let run = admission.run();
    store.admit(admission).await.unwrap();
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
            protocol: json!({}),
        },
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        },
        Fact::ToolDecided {
            tool: tool.clone(),
            decision: ToolDecision::Approved {
                display: ToolDisplay::default(),
                semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
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
