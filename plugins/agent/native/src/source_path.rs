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
        "maka.workspace.Files@1/read"
        | "maka.workspace.Files@1/write"
        | "maka.workspace.Files@1/edit" => false,
        "maka.workspace.Files@1/applyPatch" => true,
        _ => return None,
    };
    if patch
        && source.role == SourceRole::ToolCall
        && source.field == SourceField::Arguments
        && source.position == call.position
        && selector(source, &["patch"])
    {
        let paths = maka_fs_tools::patch_paths(&source.text).ok()?;
        return match paths.as_slice() {
            [only] => absolute(only, workspace),
            _ => None,
        };
    }
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
    use serde_json::json;

    fn patch_source(path: &[&str], text: &str) -> HistorySource {
        serde_json::from_value(json!({
            "position": {
                "kind": "live",
                "sequence": 1,
                "fact": "11111111-1111-4111-8111-111111111111",
                "itemIndex": 0
            },
            "timestamp": null,
            "role": "tool_call",
            "fields": ["arguments"],
            "field": "arguments",
            "path": path,
            "format": "text",
            "offset": 0,
            "totalBytes": text.len(),
            "text": text,
            "tool": {
                "toolUseId": "call-1",
                "call": {
                    "ancestorToolUseIds": [],
                    "origin": "provider",
                    "presentation": "maka.workspace.Files@1/applyPatch",
                    "position": {
                        "kind": "live",
                        "sequence": 1,
                        "fact": "11111111-1111-4111-8111-111111111111",
                        "itemIndex": 0
                    },
                    "name": "ApplyPatch",
                    "title": null,
                    "pending": false,
                    "dispatched": true
                },
                "result": null
            }
        }))
        .unwrap()
    }

    #[test]
    fn resolves_single_multi_and_legacy_apply_patch_paths() {
        let workspace = tempfile::tempdir().unwrap();
        let workspace_str = workspace.path().to_str().unwrap();

        let single = patch_source(
            &["patch"],
            "*** Begin Patch\n*** Add File: src/a.rs\n+hi\n*** End Patch",
        );
        assert_eq!(
            file_path(&single, workspace_str),
            Some(
                workspace
                    .path()
                    .join("src/a.rs")
                    .to_str()
                    .unwrap()
                    .to_owned()
            )
        );

        let multi = patch_source(
            &["patch"],
            "*** Begin Patch\n*** Add File: src/a.rs\n+hi\n*** Delete File: src/b.rs\n*** End Patch",
        );
        assert_eq!(file_path(&multi, workspace_str), None);

        let legacy = patch_source(&["operation", "path"], "src/legacy.rs");
        assert_eq!(
            file_path(&legacy, workspace_str),
            Some(
                workspace
                    .path()
                    .join("src/legacy.rs")
                    .to_str()
                    .unwrap()
                    .to_owned()
            )
        );

        let missing_envelope = patch_source(&["patch"], "*** Add File: src/a.rs\n+hi");
        assert_eq!(file_path(&missing_envelope, workspace_str), None);
    }
}
