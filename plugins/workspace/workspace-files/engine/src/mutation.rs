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

use crate::failed;
use maka_agent_facts::tools::ToolError;
use serde::Deserialize;
use serde_json::{Value, json};

pub const WRITE_NAME: &str = "Write";
pub const WRITE_DESCRIPTION: &str = "Write complete UTF-8 content to a regular file within the Session's write roots. Parent directories must exist. Symlinks and parent (..) components are unsupported. Preserves existing inode and mode; not an atomic replacement.";
pub const EDIT_NAME: &str = "Edit";
pub const EDIT_DESCRIPTION: &str = "Replace one unique span in an existing UTF-8 regular file, trying exact, line-trimmed, whitespace-normalized, then escape-normalized matching. Ambiguous matches are rejected; new_string is written literally without reindentation. Fuzzy matching requires at least 5 trimmed UTF-16 units, text without NUL, and a proportionate span. Symlinks and parent (..) components are unsupported. Preserves existing inode and mode; not an atomic replacement.";

pub fn write_schema() -> Value {
    schemars::schema_for!(WriteInput).into()
}

pub fn edit_schema() -> Value {
    schemars::schema_for!(EditInput).into()
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriteInput {
    #[schemars(length(min = 1))]
    path: String,
    content: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditInput {
    #[schemars(length(min = 1))]
    path: String,
    #[schemars(length(min = 1))]
    old_string: String,
    new_string: String,
}

pub(crate) enum Mutation {
    Write(WriteInput),
    Edit(EditInput),
    PatchUpdate {
        path: String,
        chunks: Vec<apply_patch::UpdateChunk>,
    },
}

impl Mutation {
    pub(crate) fn parse(name: &str, input: Value) -> Result<Self, ToolError> {
        let mutation = match name {
            WRITE_NAME => {
                Self::Write(serde_json::from_value(input).map_err(|e| failed(e.to_string()))?)
            }
            EDIT_NAME => {
                Self::Edit(serde_json::from_value(input).map_err(|e| failed(e.to_string()))?)
            }
            _ => return Err(failed("unsupported tool")),
        };
        if let Self::Edit(input) = &mutation
            && (input.old_string.is_empty() || input.old_string == input.new_string)
        {
            return Err(failed("Edit requires nonempty, different old_string"));
        }
        let path = mutation.path();
        if path.is_empty() || path.contains("://") || path.contains('\0') {
            return Err(failed("mutation requires a valid filesystem path"));
        }
        Ok(mutation)
    }

    pub(crate) fn path(&self) -> &str {
        match self {
            Self::Write(input) => &input.path,
            Self::Edit(input) => &input.path,
            Self::PatchUpdate { path, .. } => path,
        }
    }

    pub(crate) fn needs_read(&self) -> bool {
        matches!(self, Self::Edit(_) | Self::PatchUpdate { .. })
    }

    pub(crate) fn complete_write(path: String, content: String) -> Self {
        Self::Write(WriteInput { path, content })
    }

    pub(crate) fn prepare(
        self,
        file: Option<&mut cap_std::fs::File>,
        output_path: &str,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(String, Value), ToolError> {
        match self {
            Self::Write(input) => {
                let mut result =
                    json!({"kind":"file_write","path":output_path,"bytes":input.content.len()});
                // Capture under the mutation lock, through the same held file
                // that will be written. A preview must not require read access
                // or turn a large/binary overwrite into a failed operation.
                if let Some(before) = write_preview(file, &input.content, cancellation)? {
                    result["previousContent"] = before.into();
                }
                Ok((input.content, result))
            }
            Self::Edit(input) => {
                let source = read_source(file, cancellation)?;
                crate::edit_match::replace(
                    &source,
                    &input.old_string,
                    &input.new_string,
                    output_path,
                )
            }
            Self::PatchUpdate { chunks, .. } => {
                let source = read_source(file, cancellation)?;
                let content = apply_patch::apply_update(&source, &chunks)
                    .map_err(|e| failed(e.to_string()))?;
                Ok((content, json!({"status":"completed"})))
            }
        }
    }
}

// Capture only the initial held-file extent. Appends cannot prolong preparation.
// Callers must restore the write position before handling any read outcome.
fn read_extent(
    file: &mut cap_std::fs::File,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<u8>, ToolError> {
    use std::io::Read;
    crate::write::check_cancelled(cancellation)?;
    let extent = file.metadata().map_err(|e| failed(e.to_string()))?.len();
    let mut reader = (&mut *file).take(extent);
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    while reader.limit() != 0 {
        crate::write::check_cancelled(cancellation)?;
        let count = reader
            .read(&mut buffer)
            .map_err(|e| failed(e.to_string()))?;
        if count == 0 {
            return Err(failed("mutation source changed within its captured extent"));
        }
        bytes
            .try_reserve(count)
            .map_err(|e| failed(e.to_string()))?;
        bytes.extend_from_slice(&buffer[..count]);
    }
    crate::write::check_cancelled(cancellation)?;
    Ok(bytes)
}
fn write_preview(
    file: Option<&mut cap_std::fs::File>,
    after: &str,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Option<String>, ToolError> {
    if after.contains('\0') {
        return Ok(None);
    }
    let Some(file) = file else {
        return Ok(Some(String::new()));
    };
    use std::io::{Seek, SeekFrom};
    let read = read_extent(file, cancellation);
    file.seek(SeekFrom::Start(0))
        .map_err(|e| failed(e.to_string()))?;
    crate::write::check_cancelled(cancellation)?;
    Ok(read
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|text| !text.contains('\0')))
}
fn read_source(
    file: Option<&mut cap_std::fs::File>,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<String, ToolError> {
    let file = file.ok_or_else(|| failed("mutation requires an existing file"))?;
    use std::io::{Seek, SeekFrom};
    let read = read_extent(file, cancellation);
    file.seek(SeekFrom::Start(0))
        .map_err(|e| failed(e.to_string()))?;
    String::from_utf8(read?).map_err(|_| failed("mutation requires UTF-8 text"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn unavailable_preview_does_not_break_write_only_targets_or_advance_the_write_offset() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("write-only");
        std::fs::write(&path, "old").unwrap();
        let mut file = cap_std::fs::File::from_std(
            std::fs::OpenOptions::new().write(true).open(&path).unwrap(),
        );
        let (content, result) = Mutation::complete_write("write-only".into(), "new".into())
            .prepare(
                Some(&mut file),
                "write-only",
                &tokio_util::sync::CancellationToken::new(),
            )
            .unwrap();
        assert!(result.get("previousContent").is_none());
        file.write_all(content.as_bytes()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }
    #[test]
    fn cancelled_previous_capture_restores_original_write_offset_and_bytes() {
        use std::io::{Seek, SeekFrom};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("original");
        std::fs::write(&path, b"original bytes").unwrap();
        let mut file = cap_std::fs::File::from_std(
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap(),
        );
        file.seek(SeekFrom::Start(4)).unwrap();
        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        assert!(write_preview(Some(&mut file), "new", &cancellation).is_err());
        assert_eq!(file.stream_position().unwrap(), 0);
        assert_eq!(std::fs::read(&path).unwrap(), b"original bytes");
    }
}
