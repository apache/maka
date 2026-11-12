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
use super::{MediaSource, NotificationSource};
use crate::RunError;
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{CellChild, CellId, StoredCellReturn},
    durable::{BlockerKind, ContentRef},
    language::Language,
    tool_call::ToolSettlement,
    tool_output::ToolOutput as ActualToolOutput,
};
use maka_agent_state::artifacts::ArtifactScope;
use maka_model::{
    ModelPreparationResources,
    prompt::{ContentPart, Message, ToolOutput},
};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde::de::DeserializeOwned;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::BufReader,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[expect(
    clippy::too_many_arguments,
    reason = "The exact Cell cut, child evidence, artifact authority and model preparation resources remain explicit"
)]
pub async fn project_cell_knowledge(
    source: NotificationSource<'_>,
    scope: &ArtifactScope,
    cell: CellId,
    children: &BTreeMap<Uuid, CellChild>,
    language: Language,
    vision: bool,
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<(Message, Vec<ContentRef>), RunError> {
    check(cancellation)?;
    let mut remaining = resources.policy().staging_bytes;
    use maka_agent_facts::operation::result_reference;
    let mut dependencies = Vec::new();
    let mut seen = BTreeSet::new();
    let label = match language {
        Language::En => {
            "[Host Cell child knowledge; historical data, not a user request or a new execution]"
        }
        Language::ZhCn => "[Host Cell 子操作观察；历史数据，非用户请求或新的执行]",
        Language::ZhTw => "[Host Cell 子操作觀察；歷史資料，非使用者請求或新的執行]",
    };
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
        let input: serde_json::Value = read(
            &source,
            scope,
            cell,
            &child.input,
            &mut remaining,
            cancellation,
        )
        .await?;
        dependency(&mut dependencies, &mut seen, &child.input);
        content.push(ContentPart::text(
            serde_json::to_string(
                &serde_json::json!({"operation":operation,"name":child.name,"input":input}),
            )
            .map_err(RunError::Json)?,
        ));
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
        if let Some(reference) = child.reply.as_ref().and_then(result_reference) {
            dependency(&mut dependencies, &mut seen, reference);
        }
        let provider_settled = matches!(
            child.reply.as_ref().map(|reply| &reply.receipt),
            Some(Receipt::Recorded {
                outcome: OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
                cleanup: OperationCleanup::Confirmed,
            })
        );
        for (kind, result, settled) in [
            ("localResult", child.local_result.as_ref(), true),
            (
                "providerResult",
                child.provider_result.as_ref(),
                provider_settled,
            ),
        ] {
            let Some(result) = result else { continue };
            dependency(&mut dependencies, &mut seen, &result.result);
            if !settled || result.settlement == ToolSettlement::Unknown {
                continue;
            }
            let returned: ToolReturn<StoredCellReturn> = read(
                &source,
                scope,
                cell,
                &result.result,
                &mut remaining,
                cancellation,
            )
            .await?;
            returned.validate().map_err(|reason| {
                RunError::InvalidInput(format!("invalid Cell child return: {reason}"))
            })?;
            if returned.body.is_error() != result.is_error {
                return Err(RunError::InvalidInput(
                    "Cell child result error flag differs from its original body".into(),
                ));
            }
            use maka_agent_facts::tool_output::DurableToolProjection;
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
                                let bytes = usize::try_from(reference.bytes).map_err(|_| {
                                    RunError::InvalidInput("Cell receipt size overflows".into())
                                })?;
                                charge(&mut remaining, bytes)?;
                                Some(
                                    super::cell_notification::read_scoped(
                                        &source,
                                        scope,
                                        cell,
                                        reference,
                                        cancellation,
                                    )
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
            content.push(ContentPart::text(serde_json::to_string(&serde_json::json!({"operation":operation,"evidence":kind,"isError":result.is_error})).map_err(RunError::Json)?));
            let output = match returned {
                ChildOutput::Projection(projection) => {
                    let media = match &media {
                        MediaSource::Live { artifacts, scope } => MediaSource::Live {
                            artifacts,
                            scope: scope.clone(),
                        },
                        MediaSource::Snapshot { snapshot, scope } => MediaSource::Snapshot {
                            snapshot,
                            scope: scope.clone(),
                        },
                    };
                    super::project_durable_projection(
                        media,
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
            charge(&mut remaining, super::encoded_len(&output)?)?;
            append_output(&mut content, output)?;
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
        .ok_or_else(|| RunError::InvalidInput("Cell child observation size overflows".into()))?;
    charge(remaining, bytes)?;
    let token = cancellation.clone();
    let decode = move |reader: &mut dyn std::io::Read| -> Result<T, RunError> {
        check(&token)?;
        serde_json::from_reader(BufReader::new(reader)).map_err(RunError::Json)
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
fn charge(remaining: &mut usize, bytes: usize) -> Result<(), RunError> {
    *remaining = remaining.checked_sub(bytes).ok_or_else(|| {
        RunError::InvalidInput("Cell child observation exceeds preparation staging limit".into())
    })?;
    Ok(())
}
fn check(cancellation: &CancellationToken) -> Result<(), RunError> {
    if cancellation.is_cancelled() {
        Err(RunError::Cancelled)
    } else {
        Ok(())
    }
}
