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

//! Host observations from the exact original Cell's immutable notification evidence.
use crate::RunError;
use maka_agent_facts::{
    capability::ContentBlock,
    cells::{
        CELL_NOTIFICATION_SCHEMA_VERSION, CellId, CellInterruption, CellNotification,
        CellNotificationBody, CellObservation, CellOutput, CellOwner,
    },
    durable::ContentRef,
    language::Language,
    tool_output::{CellFinalEvidence, ImageDetail},
};
use maka_agent_state::{
    Store, artifacts::ArtifactScope, cells::PendingNotification,
    session_history::snapshot::Snapshot,
};
use maka_model::{
    ModelPreparationResources,
    prompt::{ContentPart, FileData, Message},
};
use serde::de::DeserializeOwned;
use serde_json::json;
use tokio_util::sync::CancellationToken;

pub async fn project_cell_notification(
    store: &Store,
    scope: &ArtifactScope,
    notification: &PendingNotification,
    language: Language,
    vision: bool,
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<(Message, Vec<ContentRef>), RunError> {
    project_cell_notification_from(
        NotificationSource::Live(store),
        scope,
        notification,
        language,
        vision,
        resources,
        cancellation,
    )
    .await
}

pub enum NotificationSource<'a> {
    Live(&'a Store),
    Snapshot(&'a Snapshot),
}

pub async fn project_cell_notification_from(
    source: NotificationSource<'_>,
    scope: &ArtifactScope,
    notification: &PendingNotification,
    language: Language,
    vision: bool,
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<(Message, Vec<ContentRef>), RunError> {
    check(cancellation)?;
    check_source(&source, scope, notification.cell).await?;
    let mut remaining = resources.policy().staging_bytes;
    let notice: CellNotification = read(
        &source,
        scope,
        notification.cell,
        &notification.content,
        &mut remaining,
        cancellation,
    )
    .await?;
    if notice.schema_version != CELL_NOTIFICATION_SCHEMA_VERSION {
        return Err(invalid("unsupported Cell notification schema"));
    }
    let mut observation = match notice.body {
        CellNotificationBody::Text { text } => CellReport {
            report: json!({"cell":notification.cell,"state":"notification","text":text}),
            output: vec![],
            dependencies: vec![],
        },
        CellNotificationBody::Completed { result } => {
            read_final(
                &source,
                scope,
                notification.cell,
                &CellFinalEvidence::Completed { result },
                &mut remaining,
                cancellation,
            )
            .await?
        }
        CellNotificationBody::Interrupted { report } => {
            read_final(
                &source,
                scope,
                notification.cell,
                &CellFinalEvidence::Interrupted { report },
                &mut remaining,
                cancellation,
            )
            .await?
        }
    };
    observation
        .dependencies
        .insert(0, notification.content.clone());
    render(
        &source,
        scope,
        observation,
        language,
        vision,
        &mut remaining,
        cancellation,
    )
    .await
}

pub async fn project_cell_final(
    source: NotificationSource<'_>,
    scope: &ArtifactScope,
    cell: CellId,
    evidence: &CellFinalEvidence,
    language: Language,
    vision: bool,
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<(Message, Vec<ContentRef>), RunError> {
    check(cancellation)?;
    check_source(&source, scope, cell).await?;
    let mut remaining = resources.policy().staging_bytes;
    let observation =
        read_final(&source, scope, cell, evidence, &mut remaining, cancellation).await?;
    render(
        &source,
        scope,
        observation,
        language,
        vision,
        &mut remaining,
        cancellation,
    )
    .await
}

async fn check_source(
    source: &NotificationSource<'_>,
    scope: &ArtifactScope,
    cell: CellId,
) -> Result<(), RunError> {
    if let NotificationSource::Live(store) = source {
        let cell = store
            .cells()
            .read(&scope.session, cell)
            .await?
            .ok_or_else(|| invalid("Cell is absent from its original Session"))?;
        if !matches!(cell.owner, CellOwner::Agent { link, .. } if link.run == scope.run) {
            return Err(invalid("Cell belongs to another producer Run"));
        }
    }
    Ok(())
}

struct CellReport {
    report: serde_json::Value,
    output: Vec<CellOutput>,
    dependencies: Vec<ContentRef>,
}

async fn read_final(
    source: &NotificationSource<'_>,
    scope: &ArtifactScope,
    cell: CellId,
    evidence: &CellFinalEvidence,
    remaining: &mut usize,
    cancellation: &CancellationToken,
) -> Result<CellReport, RunError> {
    match evidence {
        CellFinalEvidence::Completed { result } => {
            let observation: CellObservation =
                read(source, scope, cell, result, remaining, cancellation).await?;
            let CellObservation::Completed {
                cell_id,
                content,
                result: value,
            } = observation
            else {
                return Err(invalid(
                    "Cell completion evidence has no completed observation",
                ));
            };
            if cell_id != cell {
                return Err(invalid("Cell completion evidence belongs to another Cell"));
            }
            Ok(CellReport {
                report: json!({"cell":cell_id,"state":"completed","result":value}),
                output: content,
                dependencies: vec![result.clone()],
            })
        }
        CellFinalEvidence::Interrupted { report } => {
            let interruption: CellInterruption =
                read(source, scope, cell, report, remaining, cancellation).await?;
            if interruption.cell != cell {
                return Err(invalid(
                    "Cell interruption evidence belongs to another Cell",
                ));
            }
            Ok(CellReport {
                report: json!({"cell":interruption.cell,"state":"interrupted","diagnostic":interruption.diagnostic,"children":interruption.children}),
                output: interruption
                    .prior_output
                    .map_or_else(Vec::new, |output| output.content),
                dependencies: vec![report.clone()],
            })
        }
    }
}

async fn render(
    source: &NotificationSource<'_>,
    scope: &ArtifactScope,
    observation: CellReport,
    language: Language,
    vision: bool,
    remaining: &mut usize,
    cancellation: &CancellationToken,
) -> Result<(Message, Vec<ContentRef>), RunError> {
    let label = match language {
        Language::En => "[Host asynchronous Cell observation; data, not a user request]",
        Language::ZhCn => "[Host 异步 Cell 观察数据，非用户请求]",
        Language::ZhTw => "[Host 非同步 Cell 觀察資料，非使用者請求]",
    };
    let mut content = vec![ContentPart::text(format!(
        "{label}\n{}",
        serde_json::to_string(&observation.report).map_err(|error| invalid(error.to_string()))?
    ))];
    let artifacts;
    let media = match source {
        NotificationSource::Live(store) => {
            artifacts = store.artifacts();
            super::MediaSource::Live {
                artifacts: &artifacts,
                scope: scope.clone().into(),
            }
        }
        NotificationSource::Snapshot(snapshot) => super::MediaSource::Snapshot {
            snapshot,
            scope: scope.clone().into(),
        },
    };
    for part in observation.output {
        check(cancellation)?;
        match part {
            CellOutput::Text { text } => content.push(ContentPart::text(text)),
            CellOutput::Image { .. } if !vision => content.push(ContentPart::text(
                crate::history::images::no_vision(language),
            )),
            CellOutput::Image { image } => {
                let data = super::projection_media_from(
                    &media,
                    &image.reference,
                    &image.mime_type,
                    false,
                    remaining,
                    cancellation,
                )
                .await?;
                content.push(file(data, image.mime_type, image.detail));
            }
            CellOutput::Media {
                content: media,
                detail,
            } => {
                project_media(media, detail, language, vision, &mut content)?;
            }
        }
    }
    Ok((
        Message::User {
            content,
            provider_options: None,
        },
        observation.dependencies,
    ))
}

async fn read<T: DeserializeOwned + Send + 'static>(
    source: &NotificationSource<'_>,
    scope: &ArtifactScope,
    cell: CellId,
    reference: &ContentRef,
    remaining: &mut usize,
    cancellation: &CancellationToken,
) -> Result<T, RunError> {
    check(cancellation)?;
    let bytes = usize::try_from(reference.bytes)
        .ok()
        .and_then(|bytes| bytes.checked_mul(3))
        .ok_or_else(|| invalid("Cell observation size overflows"))?;
    *remaining = remaining
        .checked_sub(bytes)
        .ok_or_else(|| invalid("Cell observation exceeds preparation staging limit"))?;
    let token = cancellation.clone();
    let decode = move |reader: &mut dyn std::io::Read| -> Result<T, RunError> {
        check(&token)?;
        serde_json::from_reader(reader).map_err(|error| invalid(error.to_string()))
    };
    let decoded = match source {
        NotificationSource::Live(store) => {
            let bytes = store
                .cells()
                .content(&scope.session, cell, reference.clone())
                .await?;
            decode(&mut std::io::Cursor::new(bytes))
        }
        NotificationSource::Snapshot(snapshot) => {
            snapshot
                .with_content(scope.run, reference, move |reader| Ok(decode(reader)))
                .await?
        }
    }?;
    check(cancellation)?;
    Ok(decoded)
}
fn file(data: String, media_type: String, detail: Option<ImageDetail>) -> ContentPart {
    ContentPart::File {
        data: FileData::Data(data),
        media_type,
        provider_options: detail.map(|detail| json!({"openai":{"imageDetail":detail}})),
    }
}
fn project_media(
    media: ContentBlock,
    detail: Option<ImageDetail>,
    language: Language,
    vision: bool,
    content: &mut Vec<ContentPart>,
) -> Result<(), RunError> {
    match media {
        ContentBlock::Text { text } => content.push(ContentPart::text(text)),
        ContentBlock::Image { data, mime_type } => {
            if !mime_type.starts_with("image/") {
                return Err(invalid("Cell image has a non-image MIME"));
            }
            validate_base64(&data)?;
            content.push(if vision {
                file(data, mime_type, detail)
            } else {
                ContentPart::text(crate::history::images::no_vision(language))
            });
        }
        ContentBlock::Audio { data, mime_type } => {
            if !maka_agent_facts::tool_output::audio::valid_mime(&mime_type) {
                return Err(invalid("Cell audio has an invalid MIME"));
            }
            validate_base64(&data)?;
            content.push(file(data, mime_type, None));
        }
        ContentBlock::Resource {
            uri,
            mime_type,
            text,
            blob,
        } => {
            content.push(ContentPart::text(
                json!({"type":"resource","uri":uri,"mimeType":mime_type}).to_string(),
            ));
            if let Some(text) = text {
                content.push(ContentPart::text(text));
            }
            if let Some(blob) = blob {
                validate_base64(&blob)?;
                match mime_type {
                    Some(mime) if mime.starts_with("image/") && !vision => content.push(
                        ContentPart::text(crate::history::images::no_vision(language)),
                    ),
                    Some(mime) => content.push(file(blob, mime, detail)),
                    None => content.push(ContentPart::text(json!({"blob":blob}).to_string())),
                }
            }
        }
        descriptor @ ContentBlock::ResourceLink { .. } => {
            content.push(ContentPart::text(
                serde_json::to_string(&descriptor).map_err(|error| invalid(error.to_string()))?,
            ));
        }
        ContentBlock::Unknown { value } => content.push(ContentPart::text(value.to_string())),
    }
    Ok(())
}
fn validate_base64(data: &str) -> Result<(), RunError> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| invalid(error.to_string()))?;
    if bytes.is_empty() {
        return Err(invalid("Cell media is empty"));
    }
    Ok(())
}
fn invalid(message: impl Into<String>) -> RunError {
    RunError::InvalidInput(message.into())
}
fn check(cancellation: &CancellationToken) -> Result<(), RunError> {
    if cancellation.is_cancelled() {
        Err(RunError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::test_support as canonical;
    use base64::Engine;
    use image::ImageEncoder;
    use maka_agent_facts::{
        artifact::{PublishedArtifact, ToolReturn},
        cells::{CellEvent, CellId, CellPriorOutput, CellVmBinding, SessionPublication},
        durable::{AgentStepLink, ExecutionIdentity, Fact, FactId, RunId, UnixMillis},
        tool_output::{DurableToolProjection, ProjectionPart, ReturnedToolResult, ToolSuccess},
    };
    use maka_agent_state::{Change, ContentBlob};
    use maka_event_log::root_store::RootStore;

    async fn fixture() -> (tempfile::TempDir, RootStore, Store, RunId, CellId) {
        fixture_with_source(ContentBlob::json(&"emit original asynchronous output").unwrap()).await
    }

    async fn fixture_with_source(
        source: ContentBlob,
    ) -> (tempfile::TempDir, RootStore, Store, RunId, CellId) {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical::open(directory.path(), false).await;
        root.create_session("session", "notification", &json!({}), 1)
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
        let claim = state.claim(run).await.unwrap();
        state
            .append(
                &claim,
                (&view).into(),
                vec![
                    Change {
                        id: cell.started_fact_id(),
                        at: UnixMillis(3),
                        fact: Fact::Cell {
                            event: CellEvent::Started {
                                cell,
                                owner: CellOwner::Agent {
                                    link,
                                    call: tool.call,
                                },
                                source: source.reference().clone(),
                            },
                        },
                    },
                    Change::new(
                        Fact::Cell {
                            event: CellEvent::VmBound {
                                cell,
                                binding: CellVmBinding {
                                    runtime: "fixture".into(),
                                    version: 1,
                                    descriptor: source.reference().clone(),
                                },
                            },
                        },
                        UnixMillis(3),
                    ),
                ],
                vec![source],
            )
            .await
            .unwrap();
        (directory, root, state, run, cell)
    }
    async fn publish(
        state: &Store,
        run: RunId,
        cell: CellId,
        event: CellEvent,
        inner: ContentBlob,
        body: CellNotificationBody,
    ) -> (PendingNotification, ArtifactScope) {
        let outer = ContentBlob::json(&CellNotification {
            schema_version: CELL_NOTIFICATION_SCHEMA_VERSION,
            body,
        })
        .unwrap();
        let id = FactId::new();
        let view = state.frontier(run).await.unwrap();
        let claim = state.claim(run).await.unwrap();
        let completed = matches!(&event, CellEvent::Completed { .. });
        let mut changes = vec![Change::new(Fact::Cell { event }, UnixMillis(4))];
        if completed {
            changes.push(Change::new(
                Fact::Cell {
                    event: CellEvent::ResultAccepted { cell },
                },
                UnixMillis(4),
            ));
        }
        changes.push(Change::new(
            Fact::Cell {
                event: CellEvent::FinalNotificationQueued {
                    cell,
                    notification: id,
                    content: outer.reference().clone(),
                },
            },
            UnixMillis(4),
        ));
        let commit = state
            .append(&claim, (&view).into(), changes, vec![inner, outer])
            .await
            .unwrap();
        let notifications = state.cells().notifications(run, None, 128).await.unwrap();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].id, id);
        (
            notifications.into_iter().next().unwrap(),
            ArtifactScope {
                owner: canonical::owner(),
                session: "session".into(),
                run,
                through: commit.head.revision,
            },
        )
    }
    fn text(part: &ContentPart) -> &str {
        let ContentPart::Text { text, .. } = part else {
            panic!("expected observation text")
        };
        text
    }

    #[tokio::test]
    async fn original_completed_media_and_interrupted_prior_output_remain_host_data() {
        for interrupted in [false, true] {
            let cancellation = CancellationToken::new();
            let (_directory, root, state, run, cell) = fixture().await;
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(&[255, 0, 0], 1, 1, image::ExtendedColorType::Rgb8)
                .unwrap();
            let view = state.frontier(run).await.unwrap();
            let key = view.tools.values().next().unwrap().key.clone();
            let normalized = ToolSuccess::image(png.clone(), "image/png".into(), None)
                .unwrap()
                .into_durable(
                    "notification-image",
                    std::time::SystemTime::UNIX_EPOCH,
                    &ExecutionIdentity {
                        session_id: "session".into(),
                        turn_id: "turn".into(),
                        run_id: run,
                    },
                )
                .unwrap();
            let image = match &normalized.projection {
                DurableToolProjection::Content { parts } => parts
                    .iter()
                    .find_map(|part| match part {
                        ProjectionPart::Artifact { image } => Some(image.clone()),
                        _ => None,
                    })
                    .expect("image artifact"),
                _ => panic!("content projection"),
            };
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
            let returned = ContentBlob::json(&ToolReturn {
                schema_version: 1,
                artifacts: manifest,
                body: ReturnedToolResult {
                    output: normalized.output,
                    projection: normalized.projection,
                    loaded_tools: normalized.loaded_tools,
                    is_error: false,
                },
            })
            .unwrap();
            state
                .observe_artifacts(
                    run,
                    vec![Change::new(
                        Fact::LocalToolReturned {
                            tool: key,
                            settlement: maka_agent_facts::tool_call::ToolSettlement::Returned,
                            result: returned.reference().clone(),
                            is_error: false,
                        },
                        UnixMillis(3),
                    )],
                    vec![returned],
                    normalized.artifacts,
                )
                .await
                .unwrap();
            let audio = base64::engine::general_purpose::STANDARD.encode(b"original audio bytes");
            let output = vec![
                CellOutput::Text {
                    text: "original stdout 中".into(),
                },
                CellOutput::Image { image },
                CellOutput::Media {
                    content: ContentBlock::Audio {
                        data: audio.clone(),
                        mime_type: "audio/wav".into(),
                    },
                    detail: None,
                },
                CellOutput::Media {
                    content: ContentBlock::Resource {
                        uri: "https://example.invalid/never-fetch".into(),
                        mime_type: Some("image/png".into()),
                        text: Some("resource text".into()),
                        blob: Some(base64::engine::general_purpose::STANDARD.encode(&png)),
                    },
                    detail: Some(ImageDetail::High),
                },
                CellOutput::Media {
                    content: ContentBlock::ResourceLink {
                        uri: "file:///descriptor-only".into(),
                        name: Some("resource link".into()),
                        description: None,
                        mime_type: Some("image/png".into()),
                    },
                    detail: None,
                },
                CellOutput::Media {
                    content: ContentBlock::Unknown {
                        value: json!({"type":"future","data":"not an image"}),
                    },
                    detail: None,
                },
            ];
            let result = json!({"nested":{"exact":"中😀"},"all":"complete result ".repeat(2000)});
            let (inner, event, body) = if interrupted {
                let inner = ContentBlob::json(&CellInterruption {
                    cell,
                    diagnostic: "original interruption".into(),
                    children: Default::default(),
                    prior_output: Some(CellPriorOutput { content: output }),
                })
                .unwrap();
                let reference = inner.reference().clone();
                (
                    inner,
                    CellEvent::Interrupted {
                        cell,
                        report: reference.clone(),
                    },
                    CellNotificationBody::Interrupted { report: reference },
                )
            } else {
                let inner = ContentBlob::json(&CellObservation::Completed {
                    cell_id: cell,
                    content: output,
                    result: result.clone(),
                })
                .unwrap();
                let reference = inner.reference().clone();
                (
                    inner,
                    CellEvent::Completed {
                        cell,
                        result: reference.clone(),
                        publication: SessionPublication {
                            values: Default::default(),
                            loaded_tools: None,
                        },
                    },
                    CellNotificationBody::Completed { result: reference },
                )
            };
            let expected_inner = inner.reference().clone();
            let (notification, scope) = publish(&state, run, cell, event, inner, body).await;
            let (message, dependencies) = project_cell_notification(
                &state,
                &scope,
                &notification,
                Language::En,
                true,
                &ModelPreparationResources::new(Default::default()).unwrap(),
                &cancellation,
            )
            .await
            .unwrap();
            let history = maka_agent_state::session_history::SessionHistory::new(
                root.data_writer().unwrap(),
                canonical::owner(),
                "session".into(),
            );
            let snapshot = history
                .capture_snapshot(
                    maka_agent_state::session_history::snapshot::CaptureRequest {
                        id: maka_agent_facts::history_snapshot::SnapshotId::new(),
                        cut: history.capture().await.unwrap(),
                    },
                    cancellation.child_token(),
                )
                .await
                .unwrap();
            let (replayed, replay_dependencies) = project_cell_notification_from(
                NotificationSource::Snapshot(&snapshot),
                &scope,
                &notification,
                Language::En,
                true,
                &ModelPreparationResources::new(Default::default()).unwrap(),
                &cancellation,
            )
            .await
            .unwrap();
            assert_eq!(replayed, message);
            assert_eq!(replay_dependencies, dependencies);

            let final_evidence = if interrupted {
                CellFinalEvidence::Interrupted {
                    report: expected_inner.clone(),
                }
            } else {
                CellFinalEvidence::Completed {
                    result: expected_inner.clone(),
                }
            };
            for source in [
                NotificationSource::Live(&state),
                NotificationSource::Snapshot(&snapshot),
            ] {
                let (recovered, recovered_dependencies) = project_cell_final(
                    source,
                    &scope,
                    cell,
                    &final_evidence,
                    Language::En,
                    true,
                    &ModelPreparationResources::new(Default::default()).unwrap(),
                    &cancellation,
                )
                .await
                .unwrap();
                assert_eq!(recovered, message);
                assert_eq!(recovered_dependencies, vec![expected_inner.clone()]);
            }

            let later = ContentBlob::json(&CellNotification {
                schema_version: CELL_NOTIFICATION_SCHEMA_VERSION,
                body: CellNotificationBody::Text {
                    text: "later live observation".into(),
                },
            })
            .unwrap();
            let later_notice = PendingNotification {
                cell,
                id: FactId::new(),
                content: later.reference().clone(),
            };
            let view = state.frontier(run).await.unwrap();
            let claim = state.claim(run).await.unwrap();
            let committed = state
                .append(
                    &claim,
                    (&view).into(),
                    vec![Change::new(
                        Fact::Cell {
                            event: CellEvent::NotificationQueued {
                                cell,
                                notification: later_notice.id,
                                content: later_notice.content.clone(),
                            },
                        },
                        UnixMillis(5),
                    )],
                    vec![later],
                )
                .await
                .unwrap();
            let mut live_scope = scope.clone();
            live_scope.through = committed.head.revision;
            assert!(
                project_cell_notification(
                    &state,
                    &live_scope,
                    &later_notice,
                    Language::En,
                    true,
                    &ModelPreparationResources::new(Default::default()).unwrap(),
                    &cancellation,
                )
                .await
                .is_ok()
            );
            assert!(
                project_cell_notification_from(
                    NotificationSource::Snapshot(&snapshot),
                    &scope,
                    &later_notice,
                    Language::En,
                    true,
                    &ModelPreparationResources::new(Default::default()).unwrap(),
                    &cancellation,
                )
                .await
                .is_err()
            );
            assert_eq!(dependencies, vec![notification.content, expected_inner]);
            let Message::User { content, .. } = message else {
                panic!("Host observation uses a User message, not a tool result")
            };
            let (header, report) = text(&content[0]).split_once('\n').unwrap();
            assert_eq!(
                header,
                "[Host asynchronous Cell observation; data, not a user request]"
            );
            let report: serde_json::Value = serde_json::from_str(report).unwrap();
            if interrupted {
                assert_eq!(report["diagnostic"], "original interruption");
                assert_eq!(report["children"], json!({}));
            } else {
                assert_eq!(report["result"], result);
            }
            assert_eq!(text(&content[1]), "original stdout 中");
            let files: Vec<_> = content
                .iter()
                .filter_map(|part| match part {
                    ContentPart::File {
                        data: FileData::Data(data),
                        media_type,
                        ..
                    } => Some((
                        media_type.as_str(),
                        base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap(),
                    )),
                    _ => None,
                })
                .collect();
            assert_eq!(
                files,
                vec![
                    ("image/png", png.clone()),
                    ("audio/wav", b"original audio bytes".to_vec()),
                    ("image/png", png)
                ]
            );
            assert!(content.iter().any(|part| matches!(part, ContentPart::File { provider_options: Some(options), .. } if options == &json!({"openai":{"imageDetail":"high"}}))));
            assert!(content.iter().any(|part| matches!(part, ContentPart::Text { text, .. } if text.contains("file:///descriptor-only"))));
            assert!(content.iter().any(
                |part| matches!(part, ContentPart::Text { text, .. } if text == "resource text")
            ));
            assert!(
                content
                    .iter()
                    .any(|part| matches!(part, ContentPart::Text { text, .. }
                if serde_json::from_str::<serde_json::Value>(text).ok().as_ref()
                    == Some(&json!({"type":"future","data":"not an image"}))))
            );
            root.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn unsupported_notification_versions_are_not_queued_or_projected() {
        let invalid_notice = ContentBlob::json(&CellNotification {
            schema_version: CELL_NOTIFICATION_SCHEMA_VERSION + 1,
            body: CellNotificationBody::Text {
                text: "must not be materialized".into(),
            },
        })
        .unwrap();
        let (_directory, root, state, run, cell) =
            fixture_with_source(invalid_notice.clone()).await;
        let view = state.frontier(run).await.unwrap();
        let claim = state.claim(run).await.unwrap();
        let id = FactId::new();
        assert!(
            state
                .append(
                    &claim,
                    (&view).into(),
                    vec![Change::new(
                        Fact::Cell {
                            event: CellEvent::NotificationQueued {
                                cell,
                                notification: id,
                                content: invalid_notice.reference().clone()
                            }
                        },
                        UnixMillis(5)
                    )],
                    vec![]
                )
                .await
                .is_err()
        );
        let scope = ArtifactScope {
            owner: canonical::owner(),
            session: "session".into(),
            run,
            through: view.revision,
        };
        let notification = PendingNotification {
            cell,
            id,
            content: invalid_notice.reference().clone(),
        };
        let result = project_cell_notification(
            &state,
            &scope,
            &notification,
            Language::En,
            true,
            &ModelPreparationResources::new(Default::default()).unwrap(),
            &CancellationToken::new(),
        )
        .await;
        assert!(
            matches!(result, Err(RunError::InvalidInput(message)) if message == "unsupported Cell notification schema")
        );
        assert!(
            state
                .cells()
                .notifications(run, None, 128)
                .await
                .unwrap()
                .is_empty()
        );
        root.shutdown().await.unwrap();
    }
}
