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
use std::{io, path::Path};

pub const ARG: &str = "--maka-agy-tool-hook";

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
                "matcher": "^run_command$",
                "hooks": [{ "command": command, "timeout": 5 }],
            }]
        }
    }))?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hook {
    conversation_id: String,
    step_idx: u64,
    tool_call: ToolCall,
}

#[derive(Deserialize)]
struct ToolCall {
    name: String,
    args: Arguments,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Arguments {
    tool_summary: Option<String>,
}

/// Early CLI role invoked by the private Antigravity plugin.
pub fn run(directory: &Path) -> io::Result<()> {
    let result = (|| -> io::Result<()> {
        let hook: Hook = serde_json::from_reader(std::io::stdin().lock())?;
        if hook.tool_call.name == "run_command" {
            StepAnnotation {
                session: hook.conversation_id,
                step: hook.step_idx,
                title: hook
                    .tool_call
                    .args
                    .tool_summary
                    .as_deref()
                    .and_then(maka_agent_facts::display::Text::single_line)
                    .map(|title| title.fallback),
            }
            .record(directory)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("Maka Antigravity tool title: {error}");
    }
    use std::io::Write;
    writeln!(std::io::stdout().lock(), r#"{{"decision":"allow"}}"#)
}
