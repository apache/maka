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
use crate::history::test_support as canonical;
use base64::Engine;
use image::ImageEncoder;
use maka_agent_facts::{
    artifact::PublishedArtifact,
    cells::{CellEvent, CellInterruption, CellOwner},
    durable::{AgentStepLink, ExecutionIdentity, Fact, SCHEMA_VERSION, UnixMillis},
    history_snapshot::SnapshotId,
    tool_output::{CellFinalEvidence, DurableToolProjection, ToolSuccess},
};
use maka_agent_state::{Change, ContentBlob, session_history::snapshot::CaptureRequest};
use maka_plugin_core::{
    composition::InstanceId,
    contract::Transport,
    deployment::DeploymentRef,
    operation::{OperationReply, OperationResult, RecoveryContract, RecoveryProtocol, RecoveryRef},
};
use serde_json::json;

fn event(event: CellEvent) -> Change {
    Change::new(Fact::Cell { event }, UnixMillis(3))
}
fn text(part: &ContentPart) -> &str {
    match part {
        ContentPart::Text { text, .. } => text,
        _ => panic!("expected Host observation text"),
    }
}

#[tokio::test]
async fn interrupted_unknown_graph_keeps_known_media_without_projecting_unsettled_returns() {
    let directory = tempfile::tempdir().unwrap();
    let root = canonical::open(directory.path(), false).await;
    root.create_session("session", "knowledge", &json!({}), 1)
        .await
        .unwrap();
    let state = canonical::state(&root);
    let (run, tool) = canonical::admit_tool(&state).await;
    let view = state.frontier(run).await.unwrap();
    let link = AgentStepLink {
        run,
        step: view.current_step.unwrap(),
        attempt: tool.attempt,
    };
    let cell = CellId::for_agent(link, &tool.call);
    let code = ContentBlob::json(&"interrupted asynchronous Cell").unwrap();
    let input_value = json!({"actual":"original args 中😀", "nested":[1,{"value":true}]});
    let input = ContentBlob::json(&input_value).unwrap();
    let known = Uuid::from_u128(11);
    let unknown = Uuid::from_u128(12);
    let provider = Uuid::from_u128(13);
    let reference = RecoveryRef {
        source: DeploymentRef {
            state_domain: "1".repeat(64),
            deployment: Uuid::from_u128(1),
            revision: 1,
        },
        namespace: InstanceId(vec![Uuid::from_u128(2)]),
        export: "fixture".into(),
        method: "write".into(),
        operation: provider,
        fingerprint: format!("sha256-{}", "3".repeat(64)),
        contract: RecoveryContract {
            name: "fixture.Write".into(),
            version: 1,
            transport: Transport::Local,
            digest: format!("sha256-{}", "4".repeat(64)),
        },
        recovery: RecoveryProtocol::JournalV1,
    };
    let reply = OperationReply {
        reference: reference.clone(),
        receipt: Receipt::Recorded {
            outcome: OperationOutcome::Returned {
                result: OperationResult::Success {
                    value: json!({"originalReceipt":"business value retained as raw Host data"}),
                },
            },
            cleanup: OperationCleanup::Unconfirmed,
        },
    };
    let mut changes = vec![Change {
        id: cell.started_fact_id(),
        at: UnixMillis(3),
        fact: Fact::Cell {
            event: CellEvent::Started {
                cell,
                owner: CellOwner::Agent {
                    link,
                    call: tool.call,
                },
                source: code.reference().clone(),
            },
        },
    }];
    for (operation, name) in [
        (known, "known-image"),
        (unknown, "unknown-local"),
        (provider, "partial-provider"),
    ] {
        changes.push(event(CellEvent::ChildPrepared {
            cell,
            operation,
            semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
            name: name.into(),
            input: input.reference().clone(),
            resources: vec![],
        }));
        changes.push(event(CellEvent::ChildAdmitted { cell, operation }));
    }
    changes.push(event(CellEvent::ChildBound {
        cell,
        operation: provider,
        reference,
    }));
    changes.push(event(CellEvent::ChildObserved {
        cell,
        operation: provider,
        reply: reply.clone(),
    }));
    let claim = state.claim(run).await.unwrap();
    state
        .append(&claim, (&view).into(), changes, vec![code, input.clone()])
        .await
        .unwrap();

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 0, 0], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    let normalized = ToolSuccess::image(png.clone(), "image/png".into(), None)
        .unwrap()
        .into_durable(
            "known-image",
            std::time::SystemTime::UNIX_EPOCH,
            &ExecutionIdentity {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: run,
            },
        )
        .unwrap();
    let manifest = normalized
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
    let rich = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: manifest,
        body: CellReturnedResult {
            output: normalized.output,
            projection: Some(normalized.projection),
            is_error: false,
        },
    })
    .unwrap();
    let unknown_result = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: CellReturnedResult {
            output: ActualToolOutput::Text("unsettled local material".into()),
            projection: Some(DurableToolProjection::Text {
                text: "UNKNOWN_LOCAL_MUST_NOT_PROJECT".into(),
            }),
            is_error: false,
        },
    })
    .unwrap();
    let partial_result = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: CellReturnedResult {
            output: ActualToolOutput::Operation(Box::new(reply)),
            projection: Some(DurableToolProjection::Text {
                text: "UNCONFIRMED_PROVIDER_MUST_NOT_PROJECT".into(),
            }),
            is_error: false,
        },
    })
    .unwrap();
    state
        .observe_artifacts(
            run,
            vec![
                event(CellEvent::LocalChildReturned {
                    cell,
                    operation: known,
                    result: rich.reference().clone(),
                    is_error: false,
                    settlement: ToolSettlement::Returned,
                }),
                event(CellEvent::LocalChildReturned {
                    cell,
                    operation: unknown,
                    result: unknown_result.reference().clone(),
                    is_error: false,
                    settlement: ToolSettlement::Unknown,
                }),
                event(CellEvent::ChildResultRecorded {
                    cell,
                    operation: provider,
                    result: partial_result.reference().clone(),
                    is_error: false,
                }),
            ],
            vec![rich.clone(), unknown_result.clone(), partial_result.clone()],
            normalized.artifacts,
        )
        .await
        .unwrap();

    let view = state.frontier(run).await.unwrap();
    let children = view.cells[&cell].children.clone();
    let report = ContentBlob::json(&CellInterruption {
        cell,
        diagnostic: "original interruption with unknown obligations".into(),
        children: children.clone(),
        prior_output: None,
    })
    .unwrap();
    let evidence = CellFinalEvidence::Interrupted {
        report: report.reference().clone(),
    };
    let committed = state
        .append(
            &claim,
            (&view).into(),
            vec![event(CellEvent::Interrupted {
                cell,
                report: report.reference().clone(),
            })],
            vec![report],
        )
        .await
        .unwrap();
    let through = committed.head.revision;
    let scope = ArtifactScope {
        owner: canonical::owner(),
        session: "session".into(),
        run,
        through,
    };
    let resources = ModelPreparationResources::new(Default::default()).unwrap();
    let cancellation = CancellationToken::new();
    let (original_notice, _) = super::super::project_cell_final(
        NotificationSource::Live(&state),
        &scope,
        cell,
        &evidence,
        Language::En,
        true,
        &resources,
        &cancellation,
    )
    .await
    .unwrap();
    assert!(
        serde_json::to_string(&original_notice)
            .unwrap()
            .contains("original interruption with unknown obligations")
    );
    let history = state.session_history(canonical::owner(), "session".into());
    let snapshot = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::new(),
                cut: history.capture().await.unwrap(),
            },
            cancellation.child_token(),
        )
        .await
        .unwrap();

    // Later evidence changes the live graph, never the supplied historical observation.
    let view = state.frontier(run).await.unwrap();
    let child = &children[&provider];
    let mut confirmed = child.reply.clone().unwrap();
    if let Receipt::Recorded { cleanup, .. } = &mut confirmed.receipt {
        *cleanup = OperationCleanup::Confirmed;
    }
    state
        .append(
            &claim,
            (&view).into(),
            vec![
                event(CellEvent::LocalChildReturned {
                    cell,
                    operation: unknown,
                    result: unknown_result.reference().clone(),
                    is_error: false,
                    settlement: ToolSettlement::Returned,
                }),
                event(CellEvent::ChildObserved {
                    cell,
                    operation: provider,
                    reply: confirmed,
                }),
            ],
            vec![],
        )
        .await
        .unwrap();

    let (message, dependencies) = project_cell_knowledge(
        NotificationSource::Live(&state),
        &scope,
        cell,
        through,
        &children,
        Language::En,
        true,
        &resources,
        &cancellation,
    )
    .await
    .unwrap();
    let (replayed, replay_dependencies) = project_cell_knowledge(
        NotificationSource::Snapshot(&snapshot),
        &scope,
        cell,
        through,
        &children,
        Language::En,
        true,
        &resources,
        &cancellation,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&message).unwrap(),
        serde_json::to_value(&replayed).unwrap()
    );
    assert_eq!(dependencies, replay_dependencies);
    assert_eq!(
        dependencies.into_iter().collect::<BTreeSet<_>>(),
        [
            input.reference().clone(),
            rich.reference().clone(),
            unknown_result.reference().clone(),
            partial_result.reference().clone()
        ]
        .into_iter()
        .collect()
    );
    let Message::User { content, .. } = message else {
        panic!("Host observation must remain User data")
    };
    let graph: serde_json::Value =
        serde_json::from_str(text(&content[0]).split_once('\n').unwrap().1).unwrap();
    assert_eq!(graph["children"], serde_json::to_value(&children).unwrap());
    assert_eq!(graph["through"], through);
    let projected_inputs: Vec<serde_json::Value> = content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text, .. } => serde_json::from_str::<serde_json::Value>(text).ok(),
            _ => None,
        })
        .filter_map(|value| value.get("input").cloned())
        .collect();
    assert_eq!(projected_inputs, vec![input_value; children.len()]);
    let serialized = serde_json::to_string(&content).unwrap();
    assert!(!serialized.contains("UNKNOWN_LOCAL_MUST_NOT_PROJECT"));
    assert!(!serialized.contains("UNCONFIRMED_PROVIDER_MUST_NOT_PROJECT"));
    let images: Vec<_> = content
        .iter()
        .filter_map(|part| match part {
            ContentPart::File {
                data: maka_model::prompt::FileData::Data(data),
                media_type,
                ..
            } if media_type == "image/png" => Some(data),
            _ => None,
        })
        .collect();
    assert_eq!(images.len(), 1);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(images[0])
        .unwrap();
    assert_eq!(
        image::load_from_memory(&bytes)
            .unwrap()
            .to_rgb8()
            .into_raw(),
        vec![255, 0, 0]
    );
    root.shutdown().await.unwrap();
}
