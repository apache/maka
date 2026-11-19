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
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;
use std::io::BufReader;
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
    let notice: CellNotification = read_scoped(
        &source,
        scope,
        &notification.content,
        resources,
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
                resources,
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
                resources,
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

#[expect(
    clippy::too_many_arguments,
    reason = "Cell evidence, artifact authority and model preparation resources have independent owners"
)]
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
    let observation = read_final(&source, scope, cell, evidence, resources, cancellation).await?;
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
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<CellReport, RunError> {
    match evidence {
        CellFinalEvidence::Completed { result } => {
            let observation: CellObservation =
                read_scoped(source, scope, result, resources, cancellation).await?;
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
            let (reported_cell, diagnostic, output) =
                if report.bytes <= super::cell_knowledge::INLINE_BYTES as u64 {
                    let report: CellInterruption =
                        read_scoped(source, scope, report, resources, cancellation).await?;
                    (
                        report.cell,
                        report.diagnostic,
                        report
                            .prior_output
                            .map_or_else(Vec::new, |output| output.content),
                    )
                } else {
                    // Deserialize diagnostics without allocating the optional console/media output.
                    #[derive(Deserialize)]
                    struct Interruption {
                        cell: CellId,
                        diagnostic: String,
                    }
                    let report: Interruption =
                        read_scoped(source, scope, report, resources, cancellation).await?;
                    (report.cell, report.diagnostic, Vec::new())
                };
            if reported_cell != cell {
                return Err(invalid(
                    "Cell interruption evidence belongs to another Cell",
                ));
            }
            Ok(CellReport {
                report: json!({"cell":cell,"state":"interrupted","diagnostic":diagnostic}),
                output,
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
            CellOutput::Image { image } => {
                content.push(super::image_reference(&image.reference)?);
                if !vision {
                    content.push(ContentPart::text(crate::history::images::no_vision(
                        language,
                    )));
                    continue;
                }
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

pub(super) async fn read_scoped<T: DeserializeOwned + Send + 'static>(
    source: &NotificationSource<'_>,
    scope: &ArtifactScope,
    reference: &ContentRef,
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<T, RunError> {
    // Both sources stream the original blob through one fixed reader buffer.
    let work = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        work = resources.acquire_work() => work?,
    };
    let capacity = resources.policy().work_bytes.min(8 * 1024);
    let token = cancellation.clone();
    let decode = move |reader: &mut dyn std::io::Read| -> Result<T, RunError> {
        let _work = work;
        check(&token)?;
        serde_json::from_reader(BufReader::with_capacity(capacity, reader)).map_err(RunError::Json)
    };
    let decoded = match source {
        NotificationSource::Live(store) => {
            let history = store.session_history(scope.owner.clone(), scope.session.clone());
            let cut = history.capture().await?;
            history
                .with_content(&cut, scope.run, reference, move |reader| Ok(decode(reader)))
                .await?
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
