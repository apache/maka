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

use crate::instructions::WorkspaceInstruction;
use maka_agent_facts::language::Language;

fn intro(language: Language) -> &'static str {
    match language {
        Language::En => {
            "User instructions for this workspace and session, subject to system, developer and permission rules. Global files come from the user config directory; project files come from the session cwd."
        }
        Language::ZhCn => {
            "适用于此工作区和会话的用户指令，遵循系统、开发者和权限规则。全局文件来自用户配置目录；项目文件来自会话的 cwd。"
        }
        Language::ZhTw => {
            "適用於此工作區和對話的使用者指令，遵循系統、開發者和權限規則。全域檔案來自使用者設定目錄；專案檔案來自對話的 cwd。"
        }
    }
}
const END: &str = "\n</workspace-instructions>";

pub fn render(
    global: Vec<WorkspaceInstruction>,
    project: Vec<WorkspaceInstruction>,
    language: Language,
) -> String {
    let mut output = String::new();
    for (scope, instructions) in [("global", global), ("project", project)] {
        for instruction in instructions {
            if output.is_empty() {
                output.push_str(intro(language));
            }
            let header = format!(
                "\n\n<workspace-instructions file=\"{}\" scope=\"{scope}\">\n",
                instruction.file.name()
            );
            output.push_str(&header);
            output.push_str(&instruction.text);
            output.push_str(END);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::{InstructionFile, parse_instruction_files};

    #[test]
    fn scope_order_preserves_complete_instruction_files() {
        let entry = |text: String| {
            parse_instruction_files([(InstructionFile::Agents, text)])
                .pop()
                .unwrap()
        };
        let small = render(
            vec![entry("same".into())],
            vec![entry("same".into())],
            Language::En,
        );
        assert!(small.find("scope=\"global\"").unwrap() < small.find("scope=\"project\"").unwrap());
        assert_eq!(small.matches("\nsame\n").count(), 2);
        let large = render(
            vec![entry("🦀".repeat(12_000))],
            vec![entry("🦀".repeat(12_000))],
            Language::En,
        );
        assert_eq!(large.matches("🦀").count(), 24_000);
        assert!(large.contains("scope=\"project\""));
        assert!(large.ends_with(END));
        assert!(render(vec![], vec![], Language::En).is_empty());
    }
}
