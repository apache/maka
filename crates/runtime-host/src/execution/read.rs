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

use maka_event_log::EventLog;
use maka_fs_tools::{READ_NAME, ReadExecutor, ReadOutput};
use maka_runtime::{
    archive::ToolResultAddress,
    artifact::{ArtifactKind, ArtifactSource},
    attachment::{StorageRef, parse_resource_ref},
    read::{ReadError, ReadInput, ReadRequest},
    tool_output::{DurableToolProjection, ImageOutput, ToolOutput, ToolSuccess},
    tools::ToolError,
};
use maka_tools::{PreparationFuture, PreparedEffect, ToolCallContext, ToolPreparer};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) const DESCRIPTION: &str = maka_runtime::read::DESCRIPTION;
const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;

pub(super) fn schema() -> Value {
    maka_fs_tools::read_schema()
}

pub(super) struct SessionRead {
    access: Access,
    log: Arc<EventLog>,
}

#[derive(Clone)]
enum Access {
    Session(Arc<ReadExecutor>),
    Attachments,
}

impl SessionRead {
    pub(super) fn new(filesystem: ReadExecutor, log: Arc<EventLog>) -> Self {
        Self {
            access: Access::Session(Arc::new(filesystem)),
            log,
        }
    }

    pub(super) fn attachments(log: Arc<EventLog>) -> Self {
        Self {
            access: Access::Attachments,
            log,
        }
    }
}

impl ToolPreparer for SessionRead {
    fn names(&self) -> Vec<String> {
        vec![READ_NAME.into()]
    }

    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        _cancellation: CancellationToken,
    ) -> PreparationFuture {
        let access = self.access.clone();
        let log = self.log.clone();
        Box::pin(async move {
            // Even metadata reads belong to the journal-owned effect after T1.
            let effect: PreparedEffect = PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    cancelled(&cancellation)?;
                    if name != READ_NAME {
                        return Err(failed("unsupported tool"));
                    }
                    let input: ReadInput = serde_json::from_value(input).map_err(failed)?;
                    let request = input.resolve().map_err(failed)?;
                    match (target(request.path())?, access) {
                        (Target::File, Access::Session(filesystem)) => {
                            match filesystem.read(request, cancellation).await? {
                                ReadOutput::Text(page) => {
                                    Ok(serde_json::to_value(page).expect("ReadPage is JSON").into())
                                }
                                ReadOutput::Image { bytes, mime_type } => {
                                    ToolSuccess::image(bytes, mime_type).map_err(failed)
                                }
                            }
                        }
                        (Target::Attachment(id), _) => {
                            read_attachment(
                                &log,
                                &context.invocation.session_id,
                                id,
                                &request,
                                &cancellation,
                            )
                            .await
                        }
                        (Target::Shell(id), Access::Session(_)) => {
                            let snapshot = super::shell::read(
                                &log,
                                &context.invocation.session_id,
                                id,
                                &cancellation,
                            )
                            .await?;
                            let projection = read_projection(snapshot.read_page(&request));
                            Ok(ToolSuccess::projected(
                                ToolOutput::Json(
                                    serde_json::to_value(snapshot).expect("typed snapshot is JSON"),
                                ),
                                projection,
                            ))
                        }
                        (Target::ToolResult(address), Access::Session(_)) => {
                            super::archive::read(
                                &log,
                                &context.invocation.session_id,
                                address,
                                &request,
                                &cancellation,
                            )
                            .await
                        }
                        (_, Access::Attachments) => Err(failed(
                            "Read accepts only this conversation's attachment references",
                        )),
                    }
                })
            });
            Ok(effect)
        })
    }
}

enum Target<'a> {
    File,
    Attachment(&'a str),
    Shell(&'a str),
    ToolResult(ToolResultAddress),
}

fn target(path: &str) -> Result<Target<'_>, ToolError> {
    if path.starts_with("archive:") || path.starts_with("maka://runtime/tool-results/") {
        return ToolResultAddress::parse(path)
            .map(Target::ToolResult)
            .map_err(failed);
    }
    if let Some(id) = parse_resource_ref(path) {
        return Ok(Target::Attachment(id));
    }
    if let Some(id) = super::shell::parse_ref(path) {
        return Ok(Target::Shell(id));
    }
    if path.contains("://") {
        return Err(failed(
            "Unsupported Maka address; use a path returned by a tool",
        ));
    }
    Ok(Target::File)
}

fn read_projection(page: Result<impl serde::Serialize, ReadError>) -> DurableToolProjection {
    match page {
        Ok(page) => DurableToolProjection::Json {
            value: serde_json::to_value(page).expect("typed page is JSON"),
        },
        Err(error) => DurableToolProjection::Text {
            text: error.to_string(),
        },
    }
}

async fn read_attachment(
    log: &EventLog,
    session_id: &str,
    id: &str,
    request: &ReadRequest,
    cancellation: &CancellationToken,
) -> Result<ToolSuccess, ToolError> {
    let record = log
        .get_artifact(session_id, id)
        .await
        .map_err(failed)?
        .record
        .filter(|record| {
            record.source == ArtifactSource::UserUpload && record.session_id == session_id
        })
        .ok_or_else(|| failed("Attachment was not found in this Session"))?;
    cancelled(cancellation)?;
    match record.kind {
        ArtifactKind::Image => Ok(ToolOutput::Image(ImageOutput {
            detail: None,
            mime_type: record
                .mime_type
                .ok_or_else(|| failed("Attachment image has no media type"))?,
            reference: StorageRef::SessionFile {
                session_id: session_id.into(),
                relative_path: id.into(),
            },
        })
        .into()),
        ArtifactKind::Pdf => Err(failed("PDF attachments cannot be decoded by Read")),
        _ => {
            if record.size_bytes > MAX_TEXT_BYTES as u64 {
                return Err(too_large());
            }
            let chunk = log
                .read_artifact_chunk(session_id, id, 0, MAX_TEXT_BYTES + 1)
                .await
                .map_err(failed)?
                .ok_or_else(|| failed("Attachment was not found in this Session"))?;
            cancelled(cancellation)?;
            if chunk.total_bytes > MAX_TEXT_BYTES as u64 {
                return Err(too_large());
            }
            let text = String::from_utf8(chunk.bytes)
                .map_err(|_| failed("Read cannot decode this binary attachment as UTF-8 text"))?;
            if text.contains('\0') {
                return Err(failed("Read cannot decode this binary attachment as text"));
            }
            let projection = read_projection(request.page(&text));
            Ok(ToolSuccess::projected(ToolOutput::Text(text), projection))
        }
    }
}

fn too_large() -> ToolError {
    failed("Attachment exceeds Read's 10 MiB text limit")
}
fn cancelled(cancellation: &CancellationToken) -> Result<(), ToolError> {
    if cancellation.is_cancelled() {
        Err(failed("Read cancelled"))
    } else {
        Ok(())
    }
}
fn failed(message: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unified_paths_reject_resource_aliases_and_preserve_continuation_targets() {
        for path in [
            "file",
            "C:\\work\\file",
            "maka://runtime/attachments/item",
            "maka://runtime/background-tasks/shell_1",
        ] {
            let input: ReadInput = serde_json::from_value(json!({"path":path})).unwrap();
            let next = input
                .resolve()
                .unwrap()
                .page(&"x".repeat(20_000))
                .unwrap()
                .next
                .unwrap();
            let request = next.resolve().unwrap();
            assert_eq!(request.path(), path);
            match target(request.path()).unwrap() {
                Target::File => assert!(!path.starts_with("maka:")),
                Target::Attachment(id) => assert_eq!(id, "item"),
                Target::Shell(id) => assert_eq!(id, "shell_1"),
                Target::ToolResult(_) => panic!("unexpected archive"),
            }
        }
        for path in [
            "maka://runtime/attachments/%69tem",
            "maka://runtime/attachments/item?x=1",
            "MAKA://runtime/attachments/item",
            "maka://runtime/background-tasks/%73hell",
            "maka://runtime/background-tasks/shell?x=1",
            "maka://runtime/background-tasks/shell/other",
        ] {
            assert!(target(path).is_err(), "{path}");
        }
        assert!(
            serde_json::from_value::<ReadInput>(json!({"ref":"maka://runtime/attachments/item"}))
                .is_err()
        );
    }
}
