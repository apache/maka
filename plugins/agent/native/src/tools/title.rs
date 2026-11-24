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

pub(crate) const RECALL_MATERIAL_PRESENTATION: &str = "maka.agent.Builtin@1/RecallMaterial";

use maka_agent_facts::display::Text;
use maka_agent_facts::read::{ReadInput, ReadRequest};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Read,
    Write,
    Edit,
    Patch,
    Glob,
    List,
    Fetch,
    Search,
    CreateSession,
    ForkSession,
    SendSession,
}

impl Kind {
    pub(super) fn render(self, input: &Value) -> Option<Text> {
        // ToolCatalog has validated this already parsed input against its schema.
        let patch_target;
        let target = match self {
            Self::Read | Self::Write | Self::Edit | Self::List => input["path"].as_str(),
            Self::Patch => {
                let paths = maka_fs_tools::patch_paths(input["patch"].as_str()?).ok()?;
                patch_target = match paths.as_slice() {
                    [] => return None,
                    [only] => only.clone(),
                    [first, ..] => format!("{first} (+{})", paths.len() - 1),
                };
                Some(patch_target.as_str())
            }
            Self::Glob => input["pattern"].as_str(),
            Self::Fetch => input["url"].as_str(),
            Self::CreateSession | Self::ForkSession => input["title"].as_str(),
            Self::SendSession => input["message"].as_str(),
            Self::Search => input["query"].as_str(),
        };
        let continuation = match self {
            Self::Read => ReadInput::deserialize(input)
                .ok()
                .and_then(|read| read.resolve().ok())
                .filter(ReadRequest::is_continuation),
            _ => None,
        };
        if matches!(self, Self::CreateSession)
            && input.get("forkFrom").is_some_and(Value::is_object)
        {
            return Self::ForkSession.render_target(target?, false);
        }
        let target = continuation
            .as_ref()
            .map_or(target, |read| Some(read.path()))?;
        if matches!(self, Self::SendSession) {
            let line = target.lines().find(|line| !line.trim().is_empty())?.trim();
            let mut chars = line.chars();
            let mut preview: String = chars.by_ref().take(96).collect();
            if chars.next().is_some() {
                preview.push('…');
            }
            return self.render_target(&preview, false);
        }
        self.render_target(target, continuation.is_some())
    }

    pub(crate) fn render_target(self, target: &str, continuation: bool) -> Option<Text> {
        let is_session_uri = matches!(self, Self::Read)
            && (target.starts_with("maka://session/") || target.starts_with("session:"));
        let target = Text::single_line(target)?.fallback;
        Some(Text::for_locales(|locale| {
            let action = match self {
                Self::Read if is_session_uri => {
                    maka_agent_facts::i18n::tool_title::read_session(locale)
                }
                Self::Read => maka_agent_facts::i18n::tool_title::read_file(locale),
                Self::Write => maka_agent_facts::i18n::tool_title::write_file(locale),
                Self::Edit => maka_agent_facts::i18n::tool_title::edit_file(locale),
                Self::Patch => maka_agent_facts::i18n::tool_title::patch_file(locale),
                Self::Glob => maka_agent_facts::i18n::tool_title::find_files(locale),
                Self::List => maka_agent_facts::i18n::tool_title::list_directory(locale),
                Self::Fetch => maka_agent_facts::i18n::tool_title::read_web_page(locale),
                Self::Search => maka_agent_facts::i18n::tool_title::search_web(locale),
                Self::CreateSession => {
                    maka_agent_facts::i18n::tool_title::create_conversation(locale)
                }
                Self::ForkSession => {
                    maka_agent_facts::i18n::tool_title::branch_conversation(locale)
                }
                Self::SendSession => {
                    maka_agent_facts::i18n::tool_title::send_message_to_agent(locale)
                }
            };
            if continuation {
                maka_agent_facts::i18n::tool_title::with_target_continued(locale, action, &target)
            } else {
                maka_agent_facts::i18n::tool_title::with_target(locale, action, &target)
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn continued_read_names_the_original_path() {
        let first = json!({"path": "src/main.rs"});
        assert_eq!(
            Kind::Read.render(&first).unwrap().fallback,
            "Read file · src/main.rs"
        );
        let next = json!({
            "path": "maka://read/c3JjL21haW4ucnM?at=120&sha=0123456789abcdef0123456789abcdef"
        });
        assert_eq!(
            Kind::Read.render(&next).unwrap().fallback,
            "Read file · src/main.rs · continued"
        );
    }

    #[test]
    fn patch_title_covers_single_and_multi_file_envelopes() {
        let single = json!({
            "patch": "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch"
        });
        assert_eq!(
            Kind::Patch.render(&single).unwrap().fallback,
            "Patch file · src/main.rs"
        );

        let multi = json!({
            "patch": "*** Begin Patch\n*** Add File: a.rs\n+1\n*** Update File: b.rs\n@@\n-1\n+2\n*** Update File: a.rs\n@@\n-1\n+3\n*** Delete File: c.rs\n*** End Patch"
        });
        assert_eq!(
            Kind::Patch.render(&multi).unwrap().fallback,
            "Patch file · a.rs (+2)"
        );

        assert!(Kind::Patch.render(&json!({"patch": "invalid"})).is_none());
        assert!(
            Kind::Patch
                .render(&json!({"patch": "*** Add File: src/a.rs\n+hi"}))
                .is_none()
        );
    }
}
