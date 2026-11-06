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

//! Mixed Session writes, history/catalog reads, attachments and checkpoints.
use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    tool_call::ToolCallIdentity,
    tool_output::ToolOutput,
};
use maka_agent_ports::session::history::Position;
use maka_event_log::{
    checkpoints::{LoadOperation, PublicationRequest, PublicationState, Scope},
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
    transcript::HistoryLimits,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;
type Error = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, Error>;
fn sample(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn distribution(mut values: Vec<f64>) -> Value {
    values.sort_by(f64::total_cmp);
    let percentile = |fraction: f64| {
        values
            .get(((values.len().saturating_sub(1)) as f64 * fraction) as usize)
            .copied()
    };
    json!({"samples":values.len(),"p50_ms":percentile(0.50),"p95_ms":percentile(0.95),"p99_ms":percentile(0.99),"max_ms":values.last()})
}
fn event(invocation: &Invocation, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap()
}
fn disk(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                disk(&entry.path())
            } else {
                entry.metadata().unwrap().len()
            }
        })
        .sum()
}
#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let count = |key: &str, default: usize| -> usize {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].parse().unwrap())
            .unwrap_or(default)
    };
    let agents = count("--agents", 16);
    let calls = count("--calls", 20);
    let bytes = count("--bytes", 65536);
    assert!(agents > 0 && calls > 0);
    let directory = tempfile::tempdir()?;
    let owner = Arc::new(RootOwner::create(
        &directory.path().join("root"),
        &RootNamespaces {
            ownership: directory.path().join("ownership"),
            control: directory.path().join("control"),
        },
    )?);
    let root = Arc::new(RootStore::open(owner.clone()).await?);
    let mut sessions = Vec::with_capacity(agents);
    for index in 0..agents {
        let id = format!("agent-{index}");
        sessions.push(
            root.create_session(&id, &id, &json!({"title":id}), 1)
                .await?,
        );
    }
    let done = Arc::new(AtomicBool::new(false));
    let reading = root.clone();
    let selected = sessions[0].clone();
    let stop = done.clone();
    let reader = tokio::spawn(async move {
        let mut catalog = Vec::new();
        let mut history = Vec::new();
        let mut errors = Vec::new();
        while !stop.load(Ordering::Acquire) {
            let start = Instant::now();
            if let Err(error) = reading.list_sessions::<Value>(None, None, 32).await {
                errors.push(error.to_string());
            }
            catalog.push(sample(start));
            let through = selected.committed_sequence().await.unwrap();
            let start = Instant::now();
            if let Err(error) = selected
                .history_text(
                    selected.id(),
                    through,
                    Position::Tail,
                    false,
                    HistoryLimits {
                        max_bytes: 1024,
                        max_chunks: None,
                        max_json_bytes: 8192,
                    },
                )
                .await
            {
                errors.push(error.to_string());
            }
            history.push(sample(start));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        (catalog, history, errors)
    });
    let text: Arc<str> = "Storage payload\n".repeat(bytes / 16 + 1)[..bytes]
        .to_owned()
        .into();
    let begin = Instant::now();
    let mut workers = Vec::with_capacity(agents);
    for (index, session) in sessions.iter().cloned().enumerate() {
        let text = text.clone();
        workers.push(tokio::spawn(async move {
            let invocation = Invocation {
                session_id: session.id().into(),
                turn_id: format!("turn-{index}"),
                run_id: format!("run-{index}"),
                invocation_id: format!("invocation-{index}"),
            };
            session
                .append(&event(
                    &invocation,
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            content: "storage benchmark".into(),
                            source_messages: Vec::new(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .await?;
            let mut writes = Vec::with_capacity(calls);
            for call in 0..calls {
                let step = format!("step-{index}-{call}");
                let source=session.read_model_view(session.id(),Some(&invocation.invocation_id)).await?;
                session.append(&event(&invocation,Fact::ModelRequested {
                    source_capture:maka_agent_facts::event::SourceCapture {publication_watermark:source.selection.captured_through,prior_unknown:false},
                    context_breakdown:None,item_acceptance:false,purpose:maka_agent_facts::context::ModelPurpose::Main,
                    context:None,checkpoint_event_id:source.baseline.map(|v|v.event_id),step_id:step.clone(),model_id:"benchmark".into(),
                    source_scope:source.source_evidence.scope,source_high_water:source.source_evidence.high_water,
                    source_digest:source.source_evidence.digest,effective_source_digest:Some(source.effective_source_digest),
                    input_digest:"benchmark".into(),route_identity:format!("sha256:{}","a".repeat(64)),
                })).await?;
                use maka_agent_facts::model::{assembly::{AttemptWriter,AttemptBinding},ModelEvent,ModelFinishReason};
                let mut writer=AttemptWriter::new(AttemptBinding {invocation:invocation.clone(),step_id:step.clone(),purpose:maka_agent_facts::context::ModelPurpose::Main},false)?;
                let time=std::time::SystemTime::now();
                writer.push(ModelEvent::ToolCall(serde_json::from_value(json!({"id":step,"name":"Read","input":{"kind":"json","data":{}},"provider_executed":false}))?),time)?;
                for observation in writer.push(ModelEvent::Finished {compaction:None,reason:ModelFinishReason::ToolCalls,usage:Default::default(),provider_options:None},time)? {
                    session.append(&event(&invocation,Fact::ModelObserved {step_id:step.clone(),event:observation})).await?;
                }
                session.append(&event(&invocation,Fact::ModelCompleted {step_id:step.clone(),output:writer.completed()?.completion()})).await?;
                let operation=format!("{step}:{step}");
                session.append(&event(&invocation,Fact::ToolDispatched {
                    operation_id:operation.clone(),call:ToolCallIdentity::provider(step.clone(),step),name:"Read".into(),input:json!({}),presentation:None,title:None,
                })).await?;
                let result=EventWrite::tool_success(format!("result-{index}-{call}"),time,invocation.clone(),operation,ToolOutput::Text(text.to_string()).into())?.0;
                let start=Instant::now(); session.append(&result).await?; writes.push(sample(start));
            }
            session
                .append(&event(
                    &invocation,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ))
                .await?;
            Ok::<_, Error>(writes)
        }));
    }
    let mut writes = Vec::with_capacity(agents * calls);
    for worker in workers {
        writes.extend(worker.await??);
    }
    let elapsed_ms = sample(begin);
    done.store(true, Ordering::Release);
    let (catalog, history, read_errors) = reader.await?;
    let payload = vec![17; 8 * 1024 * 1024];
    let start = Instant::now();
    sessions[0]
        .commit_artifact(
            maka_agent_facts::artifact::Artifact {
                id: "upload".into(),
                session_id: "agent-0".into(),
                turn_id: "upload".into(),
                created_at: 1,
                name: "input.bin".into(),
                kind: maka_agent_facts::artifact::ArtifactKind::File,
                size_bytes: payload.len() as u64,
                mime_type: None,
                source: maka_agent_facts::artifact::ArtifactSource::UserUpload,
                summary: Some(maka_agent_facts::artifact::content_digest(&payload)),
            },
            payload,
        )
        .await?;
    let artifact_ms = sample(start);
    let inventory = root.preview_bundle("agent-0").await?;
    let checkpoints = root
        .history_checkpoints(
            "agent-0",
            Scope {
                state_domain: "a".repeat(64),
                deployment: Uuid::from_u128(1),
                namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::from_u128(2)]),
            },
        )
        .await?;
    let start = Instant::now();
    let publication = checkpoints
        .publish(PublicationRequest {
            operation: Uuid::new_v4(),
            fingerprint: "b".repeat(64),
            expected_revision: None,
            confirmed_subtree_digest: inventory.subtree_digest,
            workspace: None,
        })
        .await?;
    let PublicationState::Published { head } = publication.state else {
        return Err("checkpoint did not publish".into());
    };
    let checkpoint_ms = sample(start);
    let start = Instant::now();
    for _ in 0..3 {
        checkpoints
            .load_exact(LoadOperation {
                operation: Uuid::new_v4(),
                fingerprint: "c".repeat(64),
                revision: head.revision,
            })
            .await?;
    }
    let load_ms = sample(start);
    let resources = root.sqlite_resource_stats().await?;
    root.shutdown().await?;
    let failed = !read_errors.is_empty();
    println!(
        "{}",
        json!({"agents":agents,"calls_per_agent":calls,"requested_bytes":bytes,"write_elapsed_ms":elapsed_ms,"tool_settlements":distribution(writes),"catalog":distribution(catalog),"history":distribution(history),"read_errors":read_errors,"artifact_ms":artifact_ms,"checkpoint_ms":checkpoint_ms,"three_loads_ms":load_ms,"sql_owners":resources.len(),"disk_bytes":disk(&directory.path().join("root")),"profile":if cfg!(debug_assertions){"debug"}else{"release"}})
    );
    if failed {
        return Err("concurrent history/catalog read failed".into());
    }
    Ok(())
}
