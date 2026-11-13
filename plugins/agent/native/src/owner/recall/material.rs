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
use maka_agent_facts::{
    artifact::{ArtifactKind, ArtifactSource},
    attachment::StorageRef,
    display::Text,
    read::{MAX_PAGE_CHARS, ReadInput},
};
use maka_agent_state::artifacts::{ArtifactStore, CopyArtifact, SessionScope};

impl Recall {
    pub(super) async fn prepare_material(
        self: &Arc<Self>,
        input: search::Material,
        context: ToolCallContext,
        cancellation: CancellationToken,
        access: Arc<super::super::RunAccess>,
        semantics: ToolSemantics,
    ) -> Result<super::super::driver::PreparedTool, ToolRejection> {
        let preparation = |error: String| ToolRejection::PreparationFailed { message: error };
        access
            .check_context(&context)
            .await
            .map_err(|error| preparation(error.to_string()))?;
        if !self.enabled || !super::super::owns_session(&self.prefix, &input.session_id) {
            return Err(preparation("Recall Session unavailable".into()));
        }
        let writer = access.data_writer().map_err(preparation)?;
        self.durable
            .validate_root(&writer)
            .map_err(|error| preparation(error.to_string()))?;
        let artifacts = ArtifactStore::new(writer);
        let source = artifacts
            .copy_source(
                SessionScope {
                    owner: self.owner.clone(),
                    session: input.session_id.clone(),
                },
                input.artifact_id.clone(),
            )
            .await
            .map_err(|error| preparation(error.to_string()))?
            .ok_or_else(|| preparation("Historical user attachment unavailable".into()))?;
        let expected = source.record().clone();
        if expected.artifact.source != ArtifactSource::UserUpload {
            return Err(preparation(
                "RecallMaterial requires a historical user attachment".into(),
            ));
        }
        if expected.artifact.kind == ArtifactKind::Pdf {
            return Err(preparation(
                "PDF attachments cannot be decoded by Read".into(),
            ));
        }
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| preparation(error.to_string()))?
            .as_millis();
        let copy = CopyArtifact::new(
            source,
            SessionScope {
                owner: self.owner.clone(),
                session: context.execution.session_id.clone(),
            },
            context.operation_id.clone(),
            u64::try_from(created_at).map_err(|error| preparation(error.to_string()))?,
        );
        let path = StorageRef::SessionFile {
            session_id: context.execution.session_id.clone(),
            relative_path: copy.artifact().id.clone(),
        }
        .resource_ref()
        .ok_or_else(|| preparation("Attachment address unavailable".into()))?;
        let page = ReadInput {
            path,
            offset: input.offset,
            limit: input.limit,
        }
        .resolve()
        .map_err(|error| preparation(error.to_string()))?;
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(ToolRejection::Cancelled);
        }
        let title = Text::single_line(&expected.artifact.name).map(|filename| {
            let filename = filename.fallback;
            Text::localized(
                &format!("Read historical attachment · {filename}"),
                &format!("读取历史附件 · {filename}"),
                &format!("讀取歷史附件 · {filename}"),
            )
        });
        let recall = self.clone();
        let effect = PreparedEffect::new(move |cancellation| {
            Box::pin(async move {
                let request = recall
                    .services
                    .request_with_work(
                        maka_capabilities::call::Identity::Agent {
                            execution: context.execution,
                            operation_id: Some(context.operation_id),
                        },
                        cancellation,
                        context
                            .custody
                            .ok_or_else(|| failed("Execution custody unavailable"))?,
                    )
                    .map_err(failed)?;
                let result = recall
                    .material(request.scope().clone(), input, expected, page)
                    .await;
                request
                    .finish()
                    .await
                    .map_err(ToolError::CleanupUnconfirmed)?;
                result
            })
        })
        .presented("maka.agent.Builtin@1/RecallMaterial".into());
        Ok(super::super::driver::PreparedTool {
            effect: if let Some(title) = title {
                effect.titled(title)
            } else {
                effect
            },
            local: Some(super::super::driver::LocalCompletion::Copy(copy)),
            semantics,
        })
    }

    async fn material(
        self: &Arc<Self>,
        call: Scope,
        input: search::Material,
        expected: maka_agent_facts::artifact::PublishedArtifact,
        request: maka_agent_facts::read::ReadRequest,
    ) -> Result<ToolSuccess, ToolError> {
        self.check(&call).await?;
        let artifacts = ArtifactStore::new(self.data(&call)?);
        let cancellation = call.cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let recall = self.clone();
        let scope = call.clone();
        self.worker(&call, async move {
            recall.check(&scope).await?;
            let source_scope = SessionScope { owner: recall.owner.clone(), session: input.session_id };
            let output = artifacts.with_content(source_scope, input.artifact_id,
                move |record, source| -> Result<ToolSuccess, ToolError> {
                    if record != &expected.artifact { return Err(failed("Original attachment changed")); }
                    let mut bytes = Vec::new();
                    let mut chunk = [0u8; 64 * 1024];
                    loop {
                        if cancellation.is_cancelled() { return Err(failed("RecallMaterial cancelled")); }
                        let n = source.read(&mut chunk).map_err(failed)?;
                        if n == 0 { break; }
                        bytes.extend_from_slice(&chunk[..n]);
                    }
                    if u64::try_from(bytes.len()).map_err(failed)? != record.size_bytes {
                        return Err(failed("Attachment content length changed"));
                    }
                    if record.kind == ArtifactKind::Image {
                        let mime = record.mime_type.as_ref().ok_or_else(|| failed("Attachment media type unavailable"))?;
                        if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
                            return Err(failed("Read supports PNG, JPEG, GIF and WebP images"));
                        }
                        ToolSuccess::image(bytes, mime.clone(), None).map_err(failed)
                    } else {
                        let text = String::from_utf8(bytes).map_err(|error| failed(format!("Read cannot decode this binary attachment as UTF-8 text: {error}")))?;
                        if text.contains('\0') { return Err(failed("Read cannot decode this binary attachment as text")); }
                        let page = request.page_with_budget(&text, read_page_budget()).map_err(failed)?;
                        Ok(ToolSuccess::from(serde_json::to_value(page).map_err(failed)?))
                    }
                },
            ).await.map_err(failed)?.ok_or_else(|| failed("Original attachment unavailable"))??;
            recall.check(&scope).await?;
            Ok(output)
        }).await
    }
}

fn read_page_budget() -> usize {
    let envelope = serde_json::to_string(&ToolOutput::Json(Value::Null))
        .expect("tool output envelope")
        .len()
        - "null".len();
    MAX_PAGE_CHARS - envelope
}
