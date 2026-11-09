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

//! File-path display from the original TUI link resolver. No file is opened.
use maka_agent_ports::session::history::HistorySource;
use maka_agent_ports::session::history::SourceField;
use maka_agent_ports::session::history::SourceFormat;
use maka_agent_ports::session::history::SourceRole;
use maka_agent_ports::session::history::SourceSegment;
use std::path::Path;

fn valid(path: &str) -> bool {
    !path.trim().is_empty()
        && path.len() <= 4096
        && !path.contains("://")
        && !path.chars().any(|ch| ch.is_control() || matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
}
fn absolute(path: &str, cwd: &str) -> Option<String> {
    if !valid(path) {
        return None;
    }
    if Path::new(path).is_absolute() {
        return Some(path.into());
    }
    if !valid(cwd) || !Path::new(cwd).is_absolute() {
        return None;
    }
    // Preserve `..`: canonicalizing or lexical normalization changes symlinks.
    let joined = Path::new(cwd).join(path).to_str()?.to_owned();
    (valid(&joined) && Path::new(&joined).is_absolute()).then_some(joined)
}
fn selector(source: &HistorySource, expected: &[&str]) -> bool {
    source.path.as_deref().is_some_and(|path| {
        path.len() == expected.len()
            && path
                .iter()
                .zip(expected)
                .all(|(part, name)| matches!(part, SourceSegment::Key(key) if key == name))
    })
}
pub(crate) fn file_path(source: &HistorySource, workspace: &str) -> Option<String> {
    if source.format != SourceFormat::Text
        || source.offset != 0
        || source.text.len() as u64 != source.total_bytes
    {
        return None;
    }
    let tool = source.tool.as_ref()?;
    let call = tool.call.as_ref()?;
    let key = call.presentation.as_deref()?;
    let patch = match key {
        "maka.workspace.Files@1/readText"
        | "maka.workspace.Files@1/write"
        | "maka.workspace.Files@1/edit" => false,
        "maka.workspace.Files@1/applyPatch" => true,
        _ => return None,
    };
    let arguments = source.role == SourceRole::ToolCall
        && source.field == SourceField::Arguments
        && source.position == call.position
        && selector(
            source,
            if patch {
                &["operation", "path"]
            } else {
                &["path"]
            },
        );
    let result = source.role == SourceRole::ToolResult
        && source.field == SourceField::Result
        && matches!(
            key,
            "maka.workspace.Files@1/write" | "maka.workspace.Files@1/edit"
        )
        && selector(source, &["value", "path"])
        && tool
            .result
            .as_ref()
            .is_some_and(|result| result.position == source.position && !result.is_error);
    (arguments || result)
        .then(|| absolute(&source.text, workspace))
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{durable::FactId, history::HistoryRowAddress};
    use serde_json::json;
    fn source() -> HistorySource {
        let call = HistoryRowAddress::Live {
            sequence: 4,
            fact: FactId::new(),
            item_index: 0,
        };
        let result = HistoryRowAddress::Live {
            sequence: 5,
            fact: FactId::new(),
            item_index: 0,
        };
        serde_json::from_value(json!({
            "position":call,"timestamp":1,"role":"tool_call","fields":["arguments"],
            "field":"arguments","path":["path"],"format":"text","offset":0,
            "totalBytes":8,"text":"test.txt","tool":{"toolUseId":"call",
                "call":{"ancestorToolUseIds":[],"origin":"provider","position":call,"name":"arbitrary alias","title":null,"pending":false,"dispatched":true,
                    "presentation":"maka.workspace.Files@1/write"},
                "result":{"position":result,"isError":false,"image":false,"images":0,"settlement":"returned"}}
        }))
        .unwrap()
    }
    #[test]
    fn literal_paths_use_host_workspace_without_canonicalizing_or_opening() {
        let cwd = std::env::temp_dir().join("missing-host-workspace");
        let cwd = cwd.to_str().unwrap();
        let name = "目录/../it's $(literal); 🦀.rs";
        assert_eq!(
            absolute(name, cwd),
            Some(Path::new(cwd).join(name).to_str().unwrap().into())
        );
        assert_eq!(absolute(cwd, "relative"), Some(cwd.into()));
        assert_eq!(absolute(name, "relative"), None);
        for invalid in [
            "",
            "  ",
            "https://example.test/a",
            "maka://read/task",
            "a\n",
            "a\0",
            "a\u{202e}rs",
            "a\x1b[31m",
        ] {
            assert_eq!(absolute(invalid, cwd), None);
        }
        assert_eq!(absolute(&"界".repeat(1366), cwd), None);
        assert_eq!(absolute(&"x".repeat(4090), cwd), None);
    }
    #[test]
    fn only_complete_explicit_file_evidence_can_publish_a_copy_path() {
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_str().unwrap();
        let base = source();
        assert_eq!(file_path(&base, cwd), absolute("test.txt", cwd));
        for variant in 0..9 {
            let mut source = base.clone();
            match variant {
                0 => {
                    source
                        .tool
                        .as_mut()
                        .unwrap()
                        .call
                        .as_mut()
                        .unwrap()
                        .presentation = None
                }
                1 => {
                    source
                        .tool
                        .as_mut()
                        .unwrap()
                        .call
                        .as_mut()
                        .unwrap()
                        .presentation = Some("custom/files".into())
                }
                2 => source.offset = 1,
                3 => source.total_bytes += 1,
                4 => source.format = SourceFormat::Json,
                5 => source.path = None,
                6 => source.path = Some(vec![SourceSegment::Key("content".into())]),
                7 => source.field = SourceField::Result,
                _ => {
                    let HistoryRowAddress::Live { sequence, .. } = &mut source.position else {
                        unreachable!()
                    };
                    *sequence = 99;
                }
            }
            assert_eq!(file_path(&source, cwd), None, "variant {variant}");
        }
        let mut patch = base.clone();
        patch
            .tool
            .as_mut()
            .unwrap()
            .call
            .as_mut()
            .unwrap()
            .presentation = Some("maka.workspace.Files@1/applyPatch".into());
        assert_eq!(file_path(&patch, cwd), None);
        patch.path = Some(vec![
            SourceSegment::Key("operation".into()),
            SourceSegment::Key("path".into()),
        ]);
        assert_eq!(file_path(&patch, cwd), absolute("test.txt", cwd));
        let mut result = base;
        result.role = SourceRole::ToolResult;
        result.field = SourceField::Result;
        result.position = result
            .tool
            .as_ref()
            .unwrap()
            .result
            .as_ref()
            .unwrap()
            .position
            .clone();
        result.path = Some(vec![
            SourceSegment::Key("value".into()),
            SourceSegment::Key("path".into()),
        ]);
        assert_eq!(file_path(&result, cwd), absolute("test.txt", cwd));
        result
            .tool
            .as_mut()
            .unwrap()
            .result
            .as_mut()
            .unwrap()
            .is_error = true;
        assert_eq!(file_path(&result, cwd), None);
    }
}
