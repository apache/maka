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
use maka_agent_facts::artifact::content_digest;
use std::collections::HashSet;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstructionFile {
    Agents,
    Claude,
    Gemini,
}

impl InstructionFile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Claude => "CLAUDE.md",
            Self::Gemini => "GEMINI.md",
        }
    }
}

#[derive(Debug)]
pub struct WorkspaceInstruction {
    pub file: InstructionFile,
    pub text: String,
}

/// Interpretation belongs to the assistant; obtaining bytes is a file capability.
pub fn parse_instruction_files(
    sources: impl IntoIterator<Item = (InstructionFile, String)>,
) -> Vec<WorkspaceInstruction> {
    let mut seen = HashSet::new();
    let mut instructions = Vec::new();
    for (file, raw) in sources {
        let cleaned: String = raw
            .trim_matches(js_space)
            .chars()
            .filter(|c| !matches!(*c as u32, 0..=8 | 11 | 12 | 14..=31 | 127))
            .collect();
        if cleaned.is_empty() || !seen.insert(content_digest(cleaned.as_bytes())) {
            continue;
        }
        instructions.push(WorkspaceInstruction {
            file,
            text: cleaned,
        });
    }
    instructions
}

fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}
