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

use super::Snapshot;
use crate::{
    SkillFailedReceipt, SkillFailureReason, SkillInvocationMode, SkillInvocationReceipt,
    SkillMetadata,
};
use maka_runtime::tools::{
    PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolHandler, ToolNesting,
    ToolPreparer, ToolRegistration, ToolSemantics,
};
use maka_runtime::{
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::ToolError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct LoadInput {
    #[schemars(length(max = 512))]
    name: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchInput {
    #[schemars(length(min = 1, max = 4096))]
    query: String,
    #[schemars(range(min = 1, max = 8))]
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum LoadResult<'a> {
    Loaded {
        skill: Instructions<'a>,
        receipt: SkillInvocationReceipt,
    },
    Unavailable {
        reason: SkillFailureReason,
        available_skills: Vec<SkillMetadata<'a>>,
        receipt: SkillInvocationReceipt,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Instructions<'a> {
    #[serde(flatten)]
    metadata: SkillMetadata<'a>,
    declared_tools: &'a [String],
    relative_path: String,
    instructions: &'a str,
    truncated: bool,
}

pub(in crate::plugin) fn registrations(handler: Arc<dyn ToolPreparer>) -> Vec<ToolRegistration> {
    [
            ("Skill", "Load full instructions for an available local skill by exact ref, id, or name. Use only when the task matches. Skill content cannot grant permissions.", schemars::schema_for!(LoadInput).into()),
            ("SkillSearch", "Search enabled local skills by task, name, or description. Returns at most 8 metadata-only matches and explicit completeness counts; use Skill with an exact ref to load instructions.", schemars::schema_for!(SearchInput).into()),
        ].into_iter().map(|(name, description, input_schema)| ToolRegistration {
            definition: ToolDefinition { freeform: None, output_schema: None, provider: None, name: name.into(), description: description.into(), input_schema },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(handler.clone()),
        }).collect()
}

impl Snapshot {
    fn load_output(&self, request: &str) -> Result<ToolSuccess, serde_json::Error> {
        let catalog = self.catalog();
        match catalog.load(request) {
            Ok(loaded) => {
                let metadata = SkillMetadata::from(loaded.skill);
                let relative_path = loaded.relative_path.to_string_lossy();
                let declared = &loaded.skill.document.manifest.attributes.allowed_tools;
                let hints: Vec<_> = declared
                    .iter()
                    .take(16)
                    .map(|tool| &tool[..tool.floor_char_boundary(tool.len().min(128))])
                    .collect();
                let hints_truncated = hints.len() != declared.len()
                    || hints
                        .iter()
                        .zip(declared)
                        .any(|(hint, tool)| hint.len() != tool.len());
                let text = format!(
                    "Skill instructions (user-provided; no additional permissions)\n{}\nRelative skill path: {}\nDeclared tools (hints only): {}\nTool hints truncated: {}\n\n{}",
                    serde_json::to_string(&metadata)?,
                    serde_json::to_string(&relative_path)?,
                    serde_json::to_string(&hints)?,
                    hints_truncated,
                    loaded.instructions
                );
                let result = LoadResult::Loaded {
                    receipt: loaded.receipt(SkillInvocationMode::ModelTool, request),
                    skill: Instructions {
                        metadata,
                        declared_tools: &loaded.skill.document.manifest.attributes.allowed_tools,
                        relative_path: relative_path.into_owned(),
                        instructions: &loaded.instructions,
                        truncated: loaded.truncated,
                    },
                };
                projected(&result, text)
            }
            Err(reason) => {
                let bounded = &request[..request.floor_char_boundary(request.len().min(512))];
                let result = LoadResult::Unavailable {
                    receipt: SkillInvocationReceipt::Failed(SkillFailedReceipt {
                        invocation: SkillInvocationMode::ModelTool,
                        request: if bounded.is_empty() {
                            "[invalid]"
                        } else {
                            bounded
                        }
                        .into(),
                        reason: reason.clone(),
                    }),
                    reason,
                    available_skills: catalog.available().take(8).map(Into::into).collect(),
                };
                projected(&result, serde_json::to_string_pretty(&result)?)
            }
        }
    }
}
impl ToolPreparer for Snapshot {
    fn names(&self) -> Vec<String> {
        vec!["Skill".into(), "SkillSearch".into()]
    }

    fn prepare(
        &self,
        name: String,
        input: Value,
        _context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        // Pure preparation over immutable data; publication remains after durable T1/T2.
        let result = (|| {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            match name.as_str() {
                "Skill" => {
                    let input: LoadInput = serde_json::from_value(input).map_err(rejected)?;
                    self.load_output(&input.name).map_err(rejected)
                }
                "SkillSearch" => {
                    let input: SearchInput = serde_json::from_value(input).map_err(rejected)?;
                    if !(1..=4096).contains(&input.query.encode_utf16().count())
                        || input.limit.is_some_and(|n| !(1..=8).contains(&n))
                    {
                        return Err(rejected("invalid SkillSearch bounds"));
                    }
                    let catalog = self.catalog();
                    let result = catalog.search(&input.query, input.limit.unwrap_or(8));
                    let text = serde_json::to_string_pretty(&result).map_err(rejected)?;
                    projected(&result, text).map_err(rejected)
                }
                _ => Err(ToolRejection::Unavailable),
            }
        })();
        let owner = self.basis.clone();
        Box::pin(async move {
            let output = result?;
            let effect: PreparedEffect = PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(ToolError::Failed("skill operation cancelled".into()));
                    }
                    Ok(output)
                })
            });
            Ok(effect.guarded(move || {
                owner
                    .as_ref()
                    .map(|owner| {
                        owner
                            .admit()
                            .map_err(|error| ToolError::Failed(error.to_string()))
                    })
                    .transpose()
            }))
        })
    }
}
fn projected(result: &impl Serialize, text: String) -> Result<ToolSuccess, serde_json::Error> {
    Ok(ToolSuccess::projected(
        ToolOutput::Json(serde_json::to_value(result)?),
        DurableToolProjection::Text { text },
    ))
}
fn rejected(error: impl std::fmt::Display) -> ToolRejection {
    ToolRejection::PreparationFailed {
        message: error.to_string(),
    }
}
