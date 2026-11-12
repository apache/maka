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

use maka_process::isolated::step_annotations::StepAnnotation;
use serde::Deserialize;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const ARG: &str = "--maka-agy-tool-hook";
const TRANSCRIPT_TAIL_BYTES: u64 = 1024 * 1024;
const THINKING_BYTES: usize = 128 * 1024;

pub(super) fn configuration(executable: &Path, directory: &Path) -> io::Result<Vec<u8>> {
    fn quote(path: &Path) -> io::Result<String> {
        let path = path
            .to_str()
            .ok_or_else(|| io::Error::other("Antigravity hook path must be UTF-8"))?;
        Ok(format!("'{}'", path.replace('\'', "'\"'\"'")))
    }
    let command = format!("{} {ARG} {}", quote(executable)?, quote(directory)?);
    Ok(serde_json::to_vec(&serde_json::json!({
        "maka-tool-summary": {
            "PreToolUse": [{
                "matcher": ".*",
                "hooks": [{ "command": command, "timeout": 5 }],
            }],
            "PostInvocation": [{ "command": command, "timeout": 5 }]
        }
    }))?)
}

#[derive(Deserialize)]
#[serde(tag = "hookEventName", rename_all_fields = "camelCase")]
enum Hook {
    PreToolUse {
        conversation_id: String,
        step_idx: u64,
        tool_call: ToolCall,
    },
    PostInvocation {
        conversation_id: String,
        initial_num_steps: u64,
        transcript_path: PathBuf,
    },
}

#[derive(Deserialize)]
struct ToolCall {
    args: Arguments,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Arguments {
    tool_summary: Option<String>,
}

#[derive(Deserialize)]
struct TranscriptStep {
    #[serde(rename = "type")]
    kind: String,
    step_index: u64,
    thinking: Option<String>,
}

fn thoughts(path: &Path, first_step: u64) -> io::Result<Vec<(u64, String)>> {
    // The hook runs after agy writes the invocation to its JSONL transcript.
    // Restrict reads to the tail so resumed conversations stay cheap.
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(io::Error::other("Antigravity transcript is not a file"));
    }
    let start = metadata.len().saturating_sub(TRANSCRIPT_TAIL_BYTES);
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::new();
    file.take(metadata.len() - start).read_to_end(&mut tail)?;
    let mut lines = tail.split(|byte| *byte == b'\n');
    if start > 0 {
        // The first record can start before the captured suffix.
        lines.next();
    }
    let mut result = Vec::new();
    for line in lines.rev().filter(|line| !line.is_empty()) {
        let row: TranscriptStep = serde_json::from_slice(line)?;
        if row.step_index < first_step {
            break;
        }
        if row.kind == "PLANNER_RESPONSE"
            && let Some(mut text) = row.thinking
            && !text.trim().is_empty()
        {
            if text.len() > THINKING_BYTES {
                text.truncate(text.floor_char_boundary(THINKING_BYTES));
                text.push('…');
            }
            result.push((row.step_index, text.replace('\0', "\\0")));
        }
    }
    result.reverse();
    Ok(result)
}

impl Hook {
    fn response(&self) -> &'static str {
        match self {
            Self::PreToolUse { .. } => r#"{"decision":"allow"}"#,
            Self::PostInvocation { .. } => "{}",
        }
    }

    fn capture(self, directory: &Path) -> io::Result<()> {
        match self {
            Self::PreToolUse {
                conversation_id,
                step_idx,
                tool_call,
            } => StepAnnotation {
                session: conversation_id,
                step: step_idx,
                title: tool_call
                    .args
                    .tool_summary
                    .as_deref()
                    .and_then(maka_agent_facts::display::Text::single_line)
                    .map(|title| title.fallback),
                thinking: None,
            }
            .record(directory),
            Self::PostInvocation {
                conversation_id,
                initial_num_steps,
                transcript_path,
            } => {
                for (step, thinking) in thoughts(&transcript_path, initial_num_steps)? {
                    StepAnnotation {
                        session: conversation_id.clone(),
                        step,
                        title: None,
                        thinking: Some(thinking),
                    }
                    .record(directory)?;
                }
                Ok(())
            }
        }
    }
}

/// Early CLI role invoked by the private Antigravity plugin.
pub fn run(directory: &Path) -> io::Result<()> {
    let response = match serde_json::from_reader::<_, Hook>(std::io::stdin().lock()) {
        Ok(hook) => {
            let response = hook.response();
            if let Err(error) = hook.capture(directory) {
                eprintln!("Maka Antigravity hook: {error}");
            }
            response
        }
        Err(error) => {
            eprintln!("Maka Antigravity hook input: {error}");
            r#"{"decision":"allow"}"#
        }
    };
    writeln!(std::io::stdout().lock(), "{response}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_reads_only_new_planner_thoughts() -> io::Result<()> {
        let mut transcript = tempfile::NamedTempFile::new()?;
        writeln!(
            transcript,
            "{}",
            concat!(
                r#"{"step_index":7,"type":"PLANNER_RESPONSE","thinking":"previous turn"}"#,
                "\n",
                r#"{"step_index":8,"type":"PLANNER_RESPONSE","thinking":"new thought"}"#,
                "\n",
                r#"{"step_index":9,"type":"GENERIC","content":"tool result"}"#,
                "\n",
                r#"{"step_index":10,"type":"PLANNER_RESPONSE","content":"response"}"#,
            )
        )?;
        assert_eq!(thoughts(transcript.path(), 8)?, [(8, "new thought".into())]);
        Ok(())
    }
}
