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
use futures_util::FutureExt;
use maka_agent_facts::input::InputReceipt;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Scope;
use maka_host_runtime::application::NativeServices;
use maka_skills_api::contract::{Preparation, PreparationRecord, Prepare, SkillToolRequest};
use std::{collections::BTreeSet, panic::AssertUnwindSafe};

const SOURCE: &str = "maka.agent.skills";
#[derive(Serialize)]
struct Selected {
    import: String,
    binding: String,
}
pub(super) struct Library {
    selected: Selected,
    services: NativeServices,
    source: SourceRevision,
    load: Option<String>,
    search: Option<String>,
}
pub(super) enum Input {
    Ready {
        message: MessageInput,
        required_tools: BTreeSet<String>,
    },
    Rejected {
        reason: SendRejection,
        skills: Option<maka_skills::SkillInvocationResult>,
    },
}
impl Library {
    pub fn select(
        context: &NativeContext,
        settings: &Configuration,
        mut source: SourceRevision,
    ) -> Result<Option<Self>, String> {
        let Some(import) = &settings.skill_library else {
            return Ok(None);
        };
        let services = context.services();
        let bindings = services
            .imports()
            .find(|(name, _)| *name == import)
            .map(|(_, bindings)| bindings)
            .ok_or("agent_skill_import_unavailable")?;
        let [binding] = bindings else {
            return Err("agent_skill_import_ambiguous".into());
        };
        if binding.contract() != &maka_skills_api::contract() {
            return Err("agent_skill_contract_invalid".into());
        }
        let name = |method: &str| {
            settings
                .tools
                .iter()
                .find(|tool| {
                    tool.input == ToolInput::Skill
                        && tool.method == method
                        && services.imports().any(|(name, targets)| {
                            matches!(&tool.target, maka_host_runtime::application::ServiceTarget::Import { name: import } if name == import)
                                && targets.len() == 1
                                && targets[0].execution_basis() == binding.execution_basis()
                        })
                })
                .map(|tool| tool.name.clone())
        };
        let load = name("load");
        let search = name("search");
        let selected = Selected {
            import: import.clone(),
            binding: binding.execution_basis().into(),
        };
        source.kind = SourceKind::Input;
        source.name = SOURCE.into();
        Ok(Some(Self {
            selected,
            services,
            source,
            load,
            search,
        }))
    }
}
impl Owner {
    pub(super) fn skill_tool_names(
        &self,
        session: &str,
        basis: &CapturedRun,
        editing: Option<maka_agent_facts::execution::EditingTools>,
    ) -> Result<Vec<String>, String> {
        match &basis.executor {
            Some(executor) if executor.selection.executor == "external" => Ok(self
                .selected_tools(session, basis, None)?
                .names()
                .into_iter()
                .filter(|name| self.host_tools.contains(name))
                .collect()),
            Some(_) => Ok(Vec::new()),
            None => Ok(self.selected_tools(session, basis, editing)?.names()),
        }
    }
    pub(crate) async fn skill_candidates(
        &self,
        input: SkillCandidatesRead,
        parent: &Scope,
    ) -> Result<SkillCandidates, String> {
        let (session, draft_workspace) = match &input.target {
            CompletionTarget::Session { session_id } => {
                (Some(self.scoped_session(parent, session_id).await?), None)
            }
            CompletionTarget::Draft { workspace } => (
                None,
                self.draft_completion_workspace(workspace.as_ref(), parent)
                    .await?,
            ),
        };
        let Some(library) = &self.skills else {
            return Ok(SkillCandidates::default());
        };
        let (editing, external) = match input.backend {
            BackendPreference::Model {
                connection_id,
                model_id,
                thinking_level,
            } => {
                match crate::model::candidate_editing_tools(
                    &self.configuration,
                    &self.catalog,
                    maka_agent_facts::configuration::ModelSelection {
                        connection_id,
                        model_id,
                    },
                    thinking_level,
                )
                .await
                {
                    Ok(editing) => (Some(editing), false),
                    Err(_) => return Ok(SkillCandidates::default()),
                }
            }
            BackendPreference::Executor { selection } if selection.executor == "external" => {
                match self.executors.select(selection) {
                    Ok(_) => (None, true),
                    Err(_) => return Ok(SkillCandidates::default()),
                }
            }
            BackendPreference::Executor { .. } => return Ok(SkillCandidates::default()),
        };
        let tool_names = |selected: crate::tools::Declarations| {
            selected
                .names()
                .into_iter()
                .filter(|name| !external || self.host_tools.contains(name))
                .collect::<Vec<_>>()
        };
        let (method, payload) = match &input.target {
            CompletionTarget::Session { session_id } => {
                let session = session.expect("session target has its scoped configuration");
                workspace::validate(
                    &self.workspace_roots,
                    &session.configuration.workspace,
                    &self.managed_worktrees,
                )
                .await?;
                let catalog = if external {
                    self.mcp_projects.base.clone()
                } else {
                    self.mcp_projects
                        .observed(Some(&session.configuration.workspace))
                        .await?
                };
                let catalog = self.mcp_projects.with_client(session_id, catalog)?;
                let allowed_tools = self.admitted_tools(session_id, &session.configuration.tools);
                let tools = tool_names(self.select_catalog_tools(
                    &catalog.tools,
                    Some(session_id),
                    allowed_tools.as_deref(),
                    editing,
                ));
                (
                    "search",
                    serde_json::to_value(SkillToolRequest {
                        workspace: Some(session.configuration.workspace),
                        tools,
                        input: maka_skills_api::contract::ModelSearch {
                            query: input.query,
                            limit: None,
                        },
                    }),
                )
            }
            CompletionTarget::Draft { .. } => {
                let catalog = if external {
                    self.mcp_projects.base.clone()
                } else {
                    self.mcp_projects
                        .observed(
                            draft_workspace
                                .as_ref()
                                .and_then(|workspace| workspace.workspace()),
                        )
                        .await?
                };
                let tools =
                    tool_names(self.select_catalog_tools(&catalog.tools, None, None, editing));
                (
                    "candidates",
                    serde_json::to_value(maka_skills_api::contract::CandidatesRead {
                        directory: draft_workspace
                            .as_ref()
                            .map(|workspace| workspace.directory()),
                        tools,
                        query: input.query,
                    }),
                )
            }
        };
        let payload = payload.map_err(|_| "agent_skill_query_invalid")?;
        let import = library.selected.import.clone();
        let services = library.services.select_import_method(&import, 0, method)?;
        let mut ticket = parent
            .resources
            .reserve()
            .map_err(|_| "agent_skill_call_closed")?;
        let request = match parent.work_custody() {
            Some(custody) => services.request_with_work(
                parent.identity.clone(),
                parent.cancellation.child_token(),
                custody.clone(),
            ),
            None => services.request(parent.identity.clone(), parent.cancellation.child_token()),
        }?
        .with_sandbox_floor(parent.sandbox_floor())?;
        let result = self
            .workers
            .spawn(async move {
                ticket.start();
                let result = AssertUnwindSafe(async {
                    request
                        .call(&import, 0, method.into(), payload, Attachments::default())?
                        .await
                })
                .catch_unwind()
                .await;
                let cleanup = request.finish().await;
                ticket.complete(cleanup.clone());
                cleanup?;
                result.map_err(|_| "agent_skill_query_panicked".to_owned())
            })
            .await
            .map_err(|_| "agent_skill_query_lost")???;
        if parent.cancellation.is_cancelled() {
            return Err("agent_skill_call_cancelled".into());
        }
        if let CompletionTarget::Draft { workspace } = &input.target
            && self
                .draft_completion_workspace(workspace.as_ref(), parent)
                .await?
                != draft_workspace
        {
            return Err("agent_completion_workspace_changed".into());
        }
        candidates(result)
    }

    pub(super) async fn prepare_skills(
        &self,
        mut message: MessageInput,
        language: Language,
        workspace: Option<crate::contract::Workspace>,
        parent: &Scope,
        tools: Vec<String>,
    ) -> Result<Input, String> {
        if parent.cancellation.is_cancelled() {
            return Err("agent_skill_call_cancelled".into());
        }
        let reject = |reason, skills| Ok(Input::Rejected { reason, skills });
        let Some(library) = &self.skills else {
            let discovery = Default::default();
            let preferences = maka_skills::Preferences::Available(Default::default());
            let host = Default::default();
            let catalog = maka_skills::Catalog {
                discovery: &discovery,
                preferences: &preferences,
                host: &host,
            };
            return match catalog.prepare_invocation(&message.text, &[], language) {
                maka_skills::PreparedInvocation::Blocked(invocation) => {
                    reject(SendRejection::SkillsUnavailable, Some(invocation))
                }
                maka_skills::PreparedInvocation::Passthrough => Ok(Input::Ready {
                    message,
                    required_tools: Default::default(),
                }),
                maka_skills::PreparedInvocation::Ready { .. } => {
                    Err("agent_skill_preparation_invalid".into())
                }
            };
        };
        let input = serde_json::to_value(SkillToolRequest {
            workspace,
            tools: tools.clone(),
            input: Prepare {
                language,
                message: message.text.clone(),
                load_tool: library
                    .load
                    .as_ref()
                    .filter(|name| tools.contains(name))
                    .cloned(),
                search_tool: library
                    .search
                    .as_ref()
                    .filter(|name| tools.contains(name))
                    .cloned(),
            },
        })
        .map_err(|_| "agent_skill_preparation_invalid")?;
        let import = library.selected.import.clone();
        let services = library
            .services
            .select_import_method(&import, 0, "prepare")?;
        let mut ticket = parent
            .resources
            .reserve()
            .map_err(|_| "agent_skill_call_closed")?;
        let request = match parent.work_custody() {
            Some(custody) => services.request_with_work(
                parent.identity.clone(),
                parent.cancellation.child_token(),
                custody.clone(),
            ),
            None => services.request(parent.identity.clone(), parent.cancellation.child_token()),
        }?
        .with_sandbox_floor(parent.sandbox_floor())?;
        let result = self
            .workers
            .spawn(async move {
                ticket.start();
                let result = AssertUnwindSafe(async {
                    request
                        .call(&import, 0, "prepare".into(), input, Attachments::default())?
                        .await
                })
                .catch_unwind()
                .await;
                let cleanup = request.finish().await;
                ticket.complete(cleanup.clone());
                cleanup?;
                result.map_err(|_| "agent_skill_preparation_panicked".to_owned())
            })
            .await
            .map_err(|_| "agent_skill_preparation_lost")??;
        if parent.cancellation.is_cancelled() {
            return Err("agent_skill_call_cancelled".into());
        }
        let result = match result {
            Ok(value) => serde_json::from_value::<Preparation>(value)
                .map_err(|_| "agent_skill_preparation_invalid")?,
            Err(_) => return reject(SendRejection::SkillsUnavailable, None),
        };
        let (text, record, required_tools) = match result {
            Preparation::Ready {
                text,
                record,
                required_tools,
            } => (text, record, required_tools),
            Preparation::Blocked { invocation } => {
                return reject(SendRejection::SkillsUnavailable, Some(invocation));
            }
        };
        record
            .invocation
            .validate()
            .map_err(|_| "agent_skill_preparation_invalid")?;
        if !maka_agent_facts::archive::valid_projection_digest(&record.revision)
            || required_tools.iter().any(|tool| !tools.contains(tool))
        {
            return Err("agent_skill_preparation_invalid".into());
        }
        if let Some(text) = text {
            message.display_text = Some(message.text.clone());
            let references =
                maka_skills::inline_references(&record.invocation.receipts, &message.text);
            message.inline_references = (!references.is_empty()).then_some(references);
            message.text = text;
        }
        let mut source = library.source.clone();
        source.revision = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(&library.selected, &record))
                .map_err(|_| "agent_skill_preparation_invalid")?,
        );
        message.preparation.push(InputReceipt {
            source,
            receipt: serde_json::to_value(record).map_err(|_| "agent_skill_preparation_invalid")?,
        });
        maka_agent_facts::input::validate_receipts(&message.preparation)
            .map_err(|_| "agent_skill_preparation_invalid")?;
        Ok(Input::Ready {
            message,
            required_tools,
        })
    }
}
pub(super) fn prompt(message: &MessageInput) -> Result<Option<SystemPrompt>, String> {
    let mut receipts = message
        .preparation
        .iter()
        .filter(|receipt| receipt.source.name == SOURCE);
    let Some(receipt) = receipts.next() else {
        return Ok(None);
    };
    if receipts.next().is_some() {
        return Err("agent_skill_preparation_invalid".into());
    }
    let record: PreparationRecord = serde_json::from_value(receipt.receipt.clone())
        .map_err(|_| "agent_skill_preparation_invalid")?;
    if record.metadata_prompt.is_empty() {
        return Ok(None);
    }
    let prompt = SystemPrompt {
        text: record.metadata_prompt,
        policy_revision: 0,
        sources: vec![receipt.source.clone()],
    };
    prompt
        .validate()
        .map_err(|_| "agent_skill_preparation_invalid")?;
    Ok(Some(prompt))
}

// Deserialize only the metadata we expose; Library.search owns visibility and precedence.
fn candidates(value: serde_json::Value) -> Result<SkillCandidates, String> {
    #[derive(Deserialize)]
    struct Page {
        revision: String,
        matches: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        #[serde(rename = "ref")]
        reference: String,
        id: String,
        name: String,
        description: String,
    }
    let page: Page = serde_json::from_value(value).map_err(|_| "agent_skill_query_invalid")?;
    if !maka_agent_facts::archive::valid_projection_digest(&page.revision) {
        return Err("agent_skill_query_invalid".into());
    }
    Ok(SkillCandidates {
        revision: Some(page.revision),
        skills: page
            .matches
            .into_iter()
            .filter(|entry| {
                !entry.id.is_empty()
                    && entry
                        .id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            })
            .map(|entry| SkillCandidate {
                invocation: format!("/skill:{}", entry.id),
                reference: entry.reference,
                name: entry.name,
                description: entry.description,
            })
            .collect(),
    })
}
