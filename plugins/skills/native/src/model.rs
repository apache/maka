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
use maka_skills::{
    Catalog, HostCapabilities, Preferences, SkillFailedReceipt, SkillInvocationMode,
    SkillInvocationReceipt,
};

fn host(tools: Vec<String>) -> Result<HostCapabilities, String> {
    if tools
        .iter()
        .any(|name| name.is_empty() || name.chars().any(char::is_control))
    {
        return Err("skills_tool_context_invalid".into());
    }
    Ok(HostCapabilities {
        tools: tools.into_iter().collect(),
        capabilities: Default::default(),
    })
}
// Page toward the archive preview target; a complete first item can exceed it.
fn fits(value: &impl serde::Serialize) -> bool {
    serde_json::to_string(value)
        .is_ok_and(|text| text.encode_utf16().count() <= maka_agent_facts::read::MAX_PAGE_CHARS)
}
impl Library {
    pub(super) async fn model(
        &self,
        method: &str,
        input: Value,
        scope: &Scope,
    ) -> Result<Value, String> {
        let request: SkillToolRequest<Value> =
            serde_json::from_value(input).map_err(|_| "skills_query_invalid")?;
        let library = self.for_workspace(request.workspace, scope).await?;
        let host = host(request.tools)?;
        let discovery = library.discover(scope).await?;
        let preferences = self.preferences.read(scope).await?;
        let preference_revision = preferences.revision;
        let preferences = Preferences::Available(preferences.entries);
        let catalog = Catalog {
            discovery: &discovery,
            preferences: &preferences,
            host: &host,
        };
        let revision = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(
                &library.workspace,
                catalog
                    .fingerprint()
                    .map_err(|_| "skills_encoding_failed")?,
                preference_revision,
            ))
            .map_err(|_| "skills_encoding_failed")?,
        );
        match method {
            "prepare" => {
                let input: Prepare =
                    serde_json::from_value(request.input).map_err(|_| "skills_query_invalid")?;
                super::preparation::prepare(&catalog, revision, input)
            }
            "search" => {
                let input: ModelSearch =
                    serde_json::from_value(request.input).map_err(|_| "skills_query_invalid")?;
                if input.limit == Some(0) {
                    return Err("skills_query_invalid".into());
                }
                let page = ModelSearchResult {
                    revision,
                    result: catalog.search(&input.query, input.limit),
                };
                encode(page)
            }
            "load" => {
                let input: ModelLoad =
                    serde_json::from_value(request.input).map_err(|_| "skills_query_invalid")?;
                if input.revision != revision {
                    return encode(ModelLoadResult::Changed);
                }
                let loaded = match catalog.load(&input.name) {
                    Ok(loaded) => loaded,
                    Err(reason) => {
                        return encode(ModelLoadResult::Unavailable {
                            receipt: SkillInvocationReceipt::Failed(SkillFailedReceipt {
                                invocation: SkillInvocationMode::ModelTool,
                                request: if input.name.is_empty() {
                                    "[invalid]".into()
                                } else {
                                    input.name.clone()
                                },
                                reason: reason.clone(),
                            }),
                            reason,
                        });
                    }
                };
                if input.resource.is_some() && input.instruction_offset.is_some() {
                    return Err("skills_query_invalid".into());
                }
                if let Some(resource) = input.resource {
                    let reference = &loaded.skill.location.reference;
                    let mut budget = maka_agent_facts::read::MAX_PAGE_CHARS;
                    loop {
                        let (path, page) = match loaded
                            .skill
                            .resources
                            .page_with_budget(reference, &resource, budget)
                        {
                            Ok(page) => page,
                            Err(reason) => {
                                return encode(ModelLoadResult::ResourceUnavailable { reason });
                            }
                        };
                        let next = page.next.map(|resource| ModelLoad {
                            name: reference.clone(),
                            revision: revision.clone(),
                            resource: Some(resource),
                            instruction_offset: None,
                        });
                        let result = ModelLoadResult::Resource {
                            revision: revision.clone(),
                            reference: reference.clone(),
                            path,
                            content: page.content,
                            offset: page.offset,
                            returned_lines: page.returned_lines,
                            total_lines: page.total_lines,
                            partial_line: page.partial_line,
                            next,
                            receipt: loaded.receipt(SkillInvocationMode::ModelTool, &input.name),
                        };
                        if fits(&result) || budget <= 1 {
                            return encode(result);
                        }
                        budget /= 2;
                    }
                }
                let declared = &loaded.skill.document.manifest.attributes.allowed_tools;
                let hints: Vec<_> = declared
                    .iter()
                    .take(16)
                    .map(|tool| bound(tool, 128))
                    .collect();
                let hints_truncated = hints.len() != declared.len()
                    || hints.iter().zip(declared).any(|(a, b)| a != b);
                let offset = input.instruction_offset.unwrap_or(0);
                let Some(remainder) = loaded.instructions.get(offset..) else {
                    return Err("skills_query_invalid".into());
                };
                let mut instructions = remainder.to_owned();
                loop {
                    let next = (instructions.len() < remainder.len()).then(|| ModelLoad {
                        name: loaded.skill.location.reference.clone(),
                        revision: revision.clone(),
                        resource: None,
                        instruction_offset: Some(offset + instructions.len()),
                    });
                    let result = ModelLoadResult::Loaded {
                        revision: revision.clone(),
                        metadata: loaded.skill.into(),
                        instructions: instructions.clone(),
                        instruction_offset: offset,
                        next,
                        relative_path: loaded.relative_path.to_string_lossy().into_owned(),
                        declared_tools: hints.clone(),
                        declared_tools_truncated: hints_truncated,
                        receipt: loaded.receipt(SkillInvocationMode::ModelTool, &input.name),
                    };
                    if fits(&result) && (!instructions.is_empty() || remainder.is_empty()) {
                        return encode(result);
                    }
                    if instructions.chars().count() <= 1 {
                        return encode(result);
                    }
                    let cut = instructions.len() / 2;
                    let end = instructions
                        .floor_char_boundary(cut)
                        .max(instructions.chars().next().map_or(0, char::len_utf8));
                    instructions.truncate(end);
                }
            }
            _ => Err("skills_method_unavailable".into()),
        }
    }
}

#[cfg(test)]
mod tests;
