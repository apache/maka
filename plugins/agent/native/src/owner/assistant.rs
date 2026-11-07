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
    pub(super) async fn capture_behavior(
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
                if let Some(home) = &home {
                    if let Ok(source) = global_instructions::selected(home)
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
