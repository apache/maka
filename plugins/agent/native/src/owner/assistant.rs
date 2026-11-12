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
use cap_std::fs::{Dir, OpenOptions};
use maka_assistant::instructions::{
    InstructionFile, WorkspaceInstruction, parse_instruction_files,
};
use std::{io::Read, path::Path};

pub(super) fn open_home(
    configuration: Option<&AssistantConfiguration>,
) -> Result<Option<Arc<Dir>>, String> {
    configuration
        .and_then(|configuration| configuration.home.as_ref())
        .map(|home| {
            if !Path::new(home).is_absolute() {
                return Err("agent_instruction_home_invalid".into());
            }
            Dir::open_ambient_dir(home, cap_std::ambient_authority())
                .map(Arc::new)
                .map_err(|_| "agent_instruction_home_unavailable".into())
        })
        .transpose()
}

fn read(directory: &Dir, agents: bool) -> Vec<WorkspaceInstruction> {
    let mut sources = Vec::new();
    for name in [
        InstructionFile::Agents,
        InstructionFile::Claude,
        InstructionFile::Gemini,
    ]
    .into_iter()
    .filter(|name| agents || *name != InstructionFile::Agents)
    {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        // Relative capability opens cannot follow a link outside this directory.
        let Ok(file) = directory.open_with(name.name(), &options) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let length = metadata.len();
        let mut bytes = Vec::new();
        if (&file).take(length).read_to_end(&mut bytes).is_ok()
            && u64::try_from(bytes.len()).ok() == Some(length)
        {
            sources.push((name, String::from_utf8_lossy(&bytes).into_owned()));
        }
    }
    parse_instruction_files(sources)
}

impl Owner {
    /// Capture once at message acceptance. Recovery replays the persisted basis.
    /// Native CLIs own their rule files; omit the workspace to capture only Maka preferences.
    async fn capture_base_behavior(
        &self,
        workspace: Option<&Workspace>,
        snapshot: &RuntimePolicySnapshot,
        language: Language,
    ) -> Result<Option<SystemPrompt>, String> {
        if self.settings.assistant.is_none() {
            return Ok(None);
        }
        let preferences = maka_agent_ports::preferences::Snapshot {
            revision: snapshot.revision,
            personalization: snapshot.policy.personalization.clone(),
            workspace_instructions: snapshot.policy.workspace_instructions.enabled,
        };
        let (global_instruction, instructions) = if preferences.workspace_instructions {
            let workspace = workspace.cloned();
            let home = self.instruction_home.clone();
            tokio::task::spawn_blocking(move || {
                let mut global_instruction = String::new();
                if let Some(home) = &home
                    && let Ok(source) = global_instructions::selected(home)
                    && let Ok(Some(text)) = global_instructions::read_selected(home, source)
                {
                    global_instruction = parse_instruction_files([(
                        InstructionFile::Agents,
                        String::from_utf8_lossy(&text).into_owned(),
                    )])
                    .pop()
                    .map(|instruction| instruction.text)
                    .unwrap_or_default();
                }
                let Some(workspace) = workspace else {
                    return Ok((global_instruction, String::new()));
                };
                let project = maka_fs_tools::workspace::open_directory(
                    Path::new(&workspace.path),
                    &workspace.identity,
                )
                .map_err(|_| "agent_workspace_unavailable")?;
                let global = home
                    .and_then(|home| home.open_dir(".maka").ok())
                    .map(|directory| read(&directory, false))
                    .unwrap_or_default();
                Ok::<_, String>((
                    global_instruction,
                    maka_assistant::prompt::workspace::render(
                        global,
                        read(&project, true),
                        language,
                    ),
                ))
            })
            .await
            .map_err(|_| "agent_instructions_unavailable")??
        } else {
            (String::new(), String::new())
        };
        let mut prompt =
            maka_assistant::prompt::compose(preferences, language, &global_instruction);
        let mut source = self.revision.clone();
        source.kind = SourceKind::PromptSection;
        prompt.sources.push(source);
        if !instructions.is_empty() {
            prompt.text.push_str("\n\n");
            prompt.text.push_str(&instructions);
        }
        prompt.validate().map_err(|_| "agent_prompt_invalid")?;
        Ok(Some(prompt))
    }
}

impl Owner {
    pub(super) async fn capture_behavior(
        &self,
        workspace: Option<&Workspace>,
        snapshot: &RuntimePolicySnapshot,
        language: Language,
        preset: Option<&maka_agent_api::preset::AppliedPreset>,
        preset_management: bool,
    ) -> Result<Option<SystemPrompt>, String> {
        let mut prompt = self
            .capture_base_behavior(workspace, snapshot, language)
            .await?;
        if preset_management {
            let prompt = prompt.get_or_insert_with(|| {
                let mut source = self.revision.clone();
                source.kind = SourceKind::PromptSection;
                SystemPrompt {
                    text: String::new(),
                    policy_revision: snapshot.revision,
                    sources: vec![source],
                }
            });
            prompt.text.push_str("\n\n");
            prompt.text.push_str(match language {
                Language::ZhCn => "可复用子 Agent 角色由 Maka 的 SubagentPresetList、SubagentPresetRead、SubagentPresetCreate、SubagentPresetUpdate、SubagentPresetDelete 服务工具管理。用户要求创建、查看、修改或删除角色时，先发现这些工具并读取说明，再调用服务；不要将角色存到工作区文件，也不要为此操作设置界面。工具未显示时，用 tool_search 搜索 SubagentPreset；若提供的是 exec，则先检查 ALL_TOOLS 中对应名称和说明。只有用户明确要求才持久化，一次性任务要求不写回角色。模型选择不明确时先澄清；只有用户要求使用当前或默认模型时才按该选择解析，不自行在多个模型间猜选。",
                Language::ZhTw => "可重用子 Agent 角色由 Maka 的 SubagentPresetList、SubagentPresetRead、SubagentPresetCreate、SubagentPresetUpdate、SubagentPresetDelete 服務工具管理。使用者要求建立、查看、修改或刪除角色時，先發現這些工具並閱讀說明，再呼叫服務；不要將角色存到工作區檔案，也不要為此操作設定介面。工具未顯示時，用 tool_search 搜尋 SubagentPreset；若提供的是 exec，則先檢查 ALL_TOOLS 中對應名稱和說明。只有使用者明確要求才持久化，一次性任務要求不寫回角色。模型選擇不明確時先釐清；只有使用者要求使用目前或預設模型時才依該選擇解析，不自行在多個模型間猜選。",
                Language::En => "Reusable subagent roles are managed by Maka service tools SubagentPresetList, SubagentPresetRead, SubagentPresetCreate, SubagentPresetUpdate and SubagentPresetDelete. When asked to create, inspect, edit or delete a role, discover these tools and read their descriptions before calling the service; do not store roles in workspace files or operate the settings UI for this. If deferred, search for SubagentPreset with tool_search; when exec is exposed instead, inspect the matching names and descriptions in ALL_TOOLS. Persist only on explicit user request; one-off task requirements do not modify roles. Clarify an unresolved model choice before saving. Resolve the current or default model only when requested; do not guess among multiple models.",
            });
            prompt.validate().map_err(|_| "agent_prompt_invalid")?;
        }
        if let Some(preset) = preset.filter(|p| !p.instruction.is_empty()) {
            let prompt = prompt.get_or_insert_with(|| {
                let mut source = self.revision.clone();
                source.kind = SourceKind::PromptSection;
                SystemPrompt {
                    text: String::new(),
                    policy_revision: snapshot.revision,
                    sources: vec![source],
                }
            });
            prompt.text.push_str("\n\n# Session role\nFollow these role instructions unless the user's explicit requirements for the current task conflict with them.\n\n");
            prompt.text.push_str(&preset.instruction);
            prompt.validate().map_err(|_| "agent_prompt_invalid")?;
        }
        Ok(prompt)
    }
}
