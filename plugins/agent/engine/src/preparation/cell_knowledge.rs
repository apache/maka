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

//! Additional Host knowledge from a supplied immutable Cell child graph.
use super::{MediaSource, NotificationSource, cell_notification::read_scoped};
use crate::RunError;
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{CellChild, CellEvent, CellId, StoredCellReturn},
    durable::{BlockerKind, ContentRef, Fact, RunId},
    language::Language,
    tool_call::{ToolSettlement, tool_use_id},
    tool_output::{DurableToolProjection, ToolOutput as ActualToolOutput},
};
use maka_agent_ports::session::history::{HistoryField, Position, Read};
use maka_agent_state::{
    artifacts::ArtifactScope,
    session_history::{
        SessionHistory,
        source_tree::{SourceItem, SourceTree},
    },
};
use maka_model::{
    ModelPreparationResources,
    prompt::{ContentPart, Message, ToolOutput},
};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use std::collections::{BTreeMap, BTreeSet};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

// Automatic context has a bounded size. Original evidence remains pageable.
pub(super) const INLINE_BYTES: usize = 256 * 1024;

#[expect(
    clippy::too_many_arguments,
    reason = "The exact Cell cut, child evidence, artifact authority and model preparation resources remain explicit"
)]
pub async fn project_cell_knowledge(
    source: NotificationSource<'_>,
    history: &SessionHistory,
    scope: &ArtifactScope,
    cell: CellId,
    children: &BTreeMap<Uuid, CellChild>,
    language: Language,
    vision: bool,
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<(Message, Vec<ContentRef>), RunError> {
    check(cancellation)?;
    let mut remaining = INLINE_BYTES;
    let originals = OriginalChild {
        history,
        tree: OnceCell::new(),
        run: scope.run,
        cell,
    };
    use maka_agent_facts::operation::result_reference;
    let mut dependencies = Vec::new();
    let mut seen = BTreeSet::new();
    let label = maka_agent_facts::i18n::history::cell_child_knowledge_label(language);
    let mut content = vec![ContentPart::text(format!(
        "{label}\n{}",
        serde_json::json!({"cell":cell})
    ))];
    let artifacts;
    let media = match &source {
        NotificationSource::Live(store) => {
            artifacts = store.artifacts();
            MediaSource::Live {
                artifacts: &artifacts,
                scope: scope.clone().into(),
            }
        }
        NotificationSource::Snapshot(snapshot) => MediaSource::Snapshot {
            snapshot,
            scope: scope.clone().into(),
        },
    };
    for (operation, child) in children {
        check(cancellation)?;
        dependency(&mut dependencies, &mut seen, &child.input);
        let input = if child.input.bytes <= remaining as u64 {
            let input: serde_json::Value =
                read_scoped(&source, scope, &child.input, resources, cancellation).await?;
            let input = serde_json::to_string(
                &serde_json::json!({"operation":operation,"name":child.name,"input":input}),
            )
            .map_err(RunError::Json)?;
            inline(&mut remaining, input.len()).then_some(input)
        } else {
            None
        };
        content.push(ContentPart::text(match input {
            Some(input) => input,
            None => format!(
                "{}\n{}",
                serde_json::json!({"operation":operation,"name":child.name}),
                originals
                    .reference(*operation, &child.input, OriginalField::Arguments)
                    .await?,
            ),
        }));
        if let Some(rejection) = &child.rejected {
            content.push(ContentPart::text(
                serde_json::to_string(&serde_json::json!({
                    "operation":operation, "error":rejection.diagnostic,
                }))
                .map_err(RunError::Json)?,
            ));
        }
        if !child.known() {
            content.push(ContentPart::text(
                serde_json::to_string(&serde_json::json!({
                    "operation":operation, "state":"outcome_unknown",
                }))
                .map_err(RunError::Json)?,
            ));
        }
        let receipt = child.reply.as_ref().and_then(result_reference);
        if let Some(reference) = receipt {
            dependency(&mut dependencies, &mut seen, reference);
        }
        let provider_settled = matches!(
            child.reply.as_ref().map(|reply| &reply.receipt),
            Some(Receipt::Recorded {
                outcome: OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
                cleanup: OperationCleanup::Confirmed,
            })
        );
        for (kind, result, settled, field) in [
            (
                "localResult",
                child.local_result.as_ref(),
                true,
                OriginalField::LocalResult,
            ),
            (
                "providerResult",
                child.provider_result.as_ref(),
                provider_settled,
                OriginalField::ProviderResult,
            ),
        ] {
            let Some(result) = result else { continue };
            dependency(&mut dependencies, &mut seen, &result.result);
            if !settled || result.settlement == ToolSettlement::Unknown {
                continue;
            }
            content.push(ContentPart::text(serde_json::to_string(&serde_json::json!({"operation":operation,"evidence":kind,"isError":result.is_error})).map_err(RunError::Json)?));
            let source_bytes = result.result.bytes.saturating_add(
                receipt
                    .filter(|_| matches!(field, OriginalField::ProviderResult))
                    .map_or(0, |r| r.bytes),
            );
            if source_bytes > remaining as u64 {
                content.push(ContentPart::text(
                    originals
                        .reference(*operation, &result.result, field)
                        .await?,
                ));
                continue;
            }
            let returned: ToolReturn<StoredCellReturn> =
                read_scoped(&source, scope, &result.result, resources, cancellation).await?;
            returned.validate().map_err(|reason| {
                RunError::InvalidInput(format!("invalid Cell child return: {reason}"))
            })?;
            if returned.body.is_error() != result.is_error {
                return Err(RunError::InvalidInput(
                    "Cell child result error flag differs from its original body".into(),
                ));
            }
            enum ChildOutput {
                Projection(DurableToolProjection),
                Lossless(ActualToolOutput),
            }
            let returned = match returned.body {
                StoredCellReturn::Inline(body) => match body.projection {
                    Some(projection) => ChildOutput::Projection(projection),
                    None => ChildOutput::Lossless(body.output),
                },
                StoredCellReturn::Operation(body) => {
                    use maka_agent_facts::operation::resolve_reply;
                    use maka_agent_facts::tool_output::OperationProjection;
                    match body.projection {
                        OperationProjection::Inline { projection } => {
                            ChildOutput::Projection(projection)
                        }
                        projection => {
                            let stored = if let Some(reference) = result_reference(&body.operation)
                            {
                                if child.reply.as_ref().and_then(result_reference)
                                    != Some(reference)
                                {
                                    return Err(RunError::InvalidInput(
                                        "Cell Host projection differs from its original receipt"
                                            .into(),
                                    ));
                                }
                                Some(
                                    read_scoped(&source, scope, reference, resources, cancellation)
                                        .await?,
                                )
                            } else {
                                None
                            };
                            let reply = resolve_reply(body.operation, stored)
                                .map_err(|error| RunError::InvalidInput(error.into()))?;
                            ChildOutput::Projection(
                                projection
                                    .resolve(&reply)
                                    .map_err(|error| RunError::InvalidInput(error.into()))?,
                            )
                        }
                    }
                }
            };
            let output = match returned {
                ChildOutput::Projection(projection) => {
                    if !media_fits(&media, &projection, vision, remaining).await? {
                        content.push(ContentPart::text(
                            originals
                                .reference(*operation, &result.result, field)
                                .await?,
                        ));
                        continue;
                    }
                    super::project_durable_projection(
                        media.clone(),
                        &projection,
                        result.is_error,
                        language,
                        vision,
                        resources,
                        cancellation,
                    )
                    .await?
                }
                ChildOutput::Lossless(output) => lossless_output(output, result.is_error)?,
            };
            if inline(&mut remaining, super::encoded_len(&output)?) {
                append_output(&mut content, output)?;
            } else {
                content.push(ContentPart::text(
                    originals
                        .reference(*operation, &result.result, field)
                        .await?,
                ));
            }
        }
    }
    check(cancellation)?;
    Ok((
        Message::User {
            content,
            provider_options: None,
        },
        dependencies,
    ))
}

async fn media_fits(
    media: &MediaSource<'_>,
    projection: &DurableToolProjection,
    vision: bool,
    mut remaining: usize,
) -> Result<bool, RunError> {
    let DurableToolProjection::Content { parts } = projection else {
        return Ok(true);
    };
    use maka_agent_facts::{attachment::StorageRef, tool_output::ProjectionPart};
    for part in parts {
        if !vision && matches!(part, ProjectionPart::Artifact { .. }) {
            continue;
        }
        let Some((reference, _)) = part.media() else {
            continue;
        };
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = reference
        else {
            return Err(RunError::InvalidInput(
                "tool media lacks immutable Session source".into(),
            ));
        };
        if session_id != media.session() {
            return Err(RunError::InvalidInput(
                "tool media belongs to another Session".into(),
            ));
        }
        let record = media.get(relative_path.clone()).await?.ok_or_else(|| {
            RunError::InvalidInput("tool media unavailable at original cut".into())
        })?;
        let encoded = record.payload.bytes.div_ceil(3).saturating_mul(4);
        if encoded > remaining as u64 {
            return Ok(false);
        }
        remaining -= encoded as usize;
    }
    Ok(true)
}

#[derive(Clone, Copy)]
enum OriginalField {
    Arguments,
    LocalResult,
    ProviderResult,
}

struct OriginalChild<'a> {
    history: &'a SessionHistory,
    tree: OnceCell<(String, SourceTree)>,
    run: RunId,
    cell: CellId,
}

impl OriginalChild<'_> {
    async fn reference(
        &self,
        operation: Uuid,
        reference: &ContentRef,
        field: OriginalField,
    ) -> Result<String, RunError> {
        let (session, tree) = self
            .tree
            .get_or_try_init(|| async {
                let cut = self.history.capture().await?;
                let tree = SourceTree::live(self.history, &cut).await?;
                Ok::<_, maka_event_log::StoreError>((cut.session, tree))
            })
            .await?;
        let id = tool_use_id(self.run, &format!("cell:{}:{operation}", self.cell));
        let mut after = None;
        loop {
            let rows = tree.tool_positions(&id, after, 16).await?;
            for row in &rows {
                let SourceItem::Canonical(item) = tree.item(&row.address).await? else {
                    continue;
                };
                let source = match (field, item.recorded.fact) {
                    (
                        OriginalField::Arguments,
                        Fact::Cell {
                            event: CellEvent::ChildPrepared { input, .. },
                        },
                    ) => input,
                    (
                        OriginalField::LocalResult,
                        Fact::Cell {
                            event: CellEvent::LocalChildReturned { result, .. },
                        },
                    )
                    | (
                        OriginalField::ProviderResult,
                        Fact::Cell {
                            event: CellEvent::ChildResultRecorded { result, .. },
                        },
                    ) => result,
                    _ => continue,
                };
                if &source == reference {
                    let request = Read {
                        session_id: session.clone(),
                        // The root coordinate is the live row or the snapshot's mount.
                        through: row.order.path.first().copied(),
                        position: Position::Row {
                            position: row.address.clone(),
                            field: HistoryField::Body,
                        },
                        include_thinking: false,
                    };
                    request
                        .validate()
                        .map_err(|error| RunError::InvalidInput(error.to_string()))?;
                    let pointer = serde_json::json!({
                        "sessionId": session,
                        "row": {
                            "through": request.through,
                            "position": row.address,
                            "field": "body",
                        }
                    });
                    return Ok(format!(
                        "Original ({} bytes): SessionRead({})",
                        reference.bytes,
                        serde_json::to_string(&pointer).map_err(RunError::Json)?
                    ));
                }
            }
            let Some(last) = rows.last() else {
                return Err(RunError::InvalidInput(
                    "original Cell child history row is unavailable".into(),
                ));
            };
            after = Some(last.address.clone());
        }
    }
}

fn lossless_output(output: ActualToolOutput, is_error: bool) -> Result<ToolOutput, RunError> {
    Ok(match output {
        ActualToolOutput::Text(text) => {
            if is_error {
                ToolOutput::ErrorText(text)
            } else {
                ToolOutput::Text(text)
            }
        }
        ActualToolOutput::Json(value) => {
            if is_error {
                ToolOutput::ErrorJson(value)
            } else {
                ToolOutput::Json(value)
            }
        }
        ActualToolOutput::Model(_)
        | ActualToolOutput::Cell(_)
        | ActualToolOutput::Operation(_)
        | ActualToolOutput::Mcp(_)
        | ActualToolOutput::Image(_) => {
            return Err(RunError::from(BlockerKind::UnsupportedProtocol {
                protocol: "maka.cell-child-knowledge/output-without-normalized-projection".into(),
                version: 1,
            }));
        }
    })
}
fn append_output(content: &mut Vec<ContentPart>, output: ToolOutput) -> Result<(), RunError> {
    match output {
        ToolOutput::Text(text) => content.push(ContentPart::text(text)),
        ToolOutput::ErrorText(text) => {
            content.push(ContentPart::text("Child tool reported an error:"));
            content.push(ContentPart::text(text));
        }
        ToolOutput::Json(value) => content.push(ContentPart::text(
            serde_json::to_string(&value).map_err(RunError::Json)?,
        )),
        ToolOutput::ErrorJson(value) => {
            content.push(ContentPart::text("Child tool reported an error:"));
            content.push(ContentPart::text(
                serde_json::to_string(&value).map_err(RunError::Json)?,
            ));
        }
        ToolOutput::Content(parts) => content.extend(parts),
    }
    Ok(())
}
fn dependency(
    dependencies: &mut Vec<ContentRef>,
    seen: &mut BTreeSet<ContentRef>,
    reference: &ContentRef,
) {
    if seen.insert(reference.clone()) {
        dependencies.push(reference.clone());
    }
}
fn inline(remaining: &mut usize, bytes: usize) -> bool {
    if let Some(rest) = remaining.checked_sub(bytes) {
        *remaining = rest;
        true
    } else {
        false
    }
}
fn check(cancellation: &CancellationToken) -> Result<(), RunError> {
    if cancellation.is_cancelled() {
        Err(RunError::Cancelled)
    } else {
        Ok(())
    }
}
