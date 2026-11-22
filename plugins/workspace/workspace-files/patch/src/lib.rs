// Portions adapted from OpenAI Codex under the Apache License 2.0.
// Copyright 2025 OpenAI. See SOURCE.md and the repository LICENSE/NOTICE.
// Maka modifications: pure preparation APIs, no filesystem/execution integration,
// restricted patch grammar and preserved line endings. SOURCE.md records
// the exact upstream files/revisions and file-specific changes.

//! Pure patch preparation. Paths carry no filesystem authority.
mod parser;
mod seek_sequence;
mod text_file;
mod update;

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum PatchError {
    #[error("invalid patch: {0}")]
    InvalidPatchError(String),
    #[error("invalid hunk at line {line_number}: {message}")]
    InvalidHunkError { message: String, line_number: usize },
    #[error("{0}")]
    ComputeReplacements(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum PatchOperation {
    Add {
        path: PathBuf,
        content: String,
    },
    Delete {
        path: PathBuf,
    },
    Update {
        path: PathBuf,
        chunks: Vec<UpdateChunk>,
    },
}

/// Parsed by this crate; opaque fields keep replacement indices trustworthy.
#[derive(Debug, Clone, PartialEq)]
pub struct UpdateChunk {
    change_context: Option<String>,
    old_lines: Vec<String>,
    new_lines: Vec<String>,
    context_line_indices: Vec<(usize, usize)>,
    is_end_of_file: bool,
}

impl UpdateChunk {
    fn push_context_line(&mut self, line: String) {
        self.context_line_indices
            .push((self.old_lines.len(), self.new_lines.len()));
        self.old_lines.push(line.clone());
        self.new_lines.push(line);
    }
}

/// Parse the client-executed Codex envelope. Move, shell wrappers, environment
/// directives and empty operations are unsupported. Operations retain source
/// order; callers must independently authorize and settle each mutation.
pub fn parse_patch(patch: &str) -> Result<Vec<PatchOperation>, PatchError> {
    let lines: Vec<_> = patch.trim().lines().collect();
    if lines.len() < 2
        || lines[0].trim() != "*** Begin Patch"
        || lines.last().map(|line| line.trim()) != Some("*** End Patch")
    {
        return Err(PatchError::InvalidPatchError(
            "expected Begin Patch / End Patch envelope".into(),
        ));
    }
    let mut remaining = &lines[1..lines.len() - 1];
    let mut line_number = 2;
    let mut operations = Vec::new();
    while !remaining.is_empty() {
        let (operation, consumed) = parser::parse_one_hunk(remaining, line_number)?;
        let path = match &operation {
            PatchOperation::Add { path, content } => {
                if content.is_empty() {
                    return Err(PatchError::InvalidPatchError("Add has no diff".into()));
                }
                path
            }
            PatchOperation::Delete { path } | PatchOperation::Update { path, .. } => path,
        };
        if path.as_os_str().is_empty() || path.to_string_lossy().contains('\0') {
            return Err(PatchError::InvalidPatchError(
                "invalid empty or NUL path".into(),
            ));
        }
        operations.push(operation);
        line_number += consumed;
        remaining = &remaining[consumed..];
    }
    if operations.is_empty() {
        return Err(PatchError::InvalidPatchError(
            "patch has no operations".into(),
        ));
    }
    Ok(operations)
}

/// Parse a structured OpenAI update diff using a fixed virtual path. A diff
/// cannot inject another operation or replace the virtual target.
pub fn parse_update(diff: &str) -> Result<Vec<UpdateChunk>, PatchError> {
    let diff = diff
        .strip_suffix("\r\n")
        .or_else(|| diff.strip_suffix('\n'))
        .unwrap_or(diff);
    let patch =
        format!("*** Begin Patch\n*** Update File: maka-virtual-update\n{diff}\n*** End Patch");
    let operations = parse_patch(&patch)?;
    match operations.as_slice() {
        [PatchOperation::Update { path, chunks }]
            if path == &PathBuf::from("maka-virtual-update") =>
        {
            Ok(chunks.clone())
        }
        _ => Err(PatchError::InvalidPatchError(
            "expected exactly one update diff".into(),
        )),
    }
}

/// Parse a structured OpenAI create diff. Unlike an envelope Add, this joins
/// added lines without forcing a final newline (the SDK's native contract).
pub fn parse_create(diff: &str) -> Result<String, PatchError> {
    let patch = format!(
        "*** Begin Patch\n*** Add File: maka-virtual-create\n{}\n*** End Patch",
        diff.strip_suffix("\r\n")
            .or_else(|| diff.strip_suffix('\n'))
            .unwrap_or(diff)
    );
    let operations = parse_patch(&patch)?;
    match operations.as_slice() {
        [PatchOperation::Add { path, content }]
            if path == &PathBuf::from("maka-virtual-create") =>
        {
            let mut content = content.clone();
            content.pop(); // Remove only the newline inserted by upstream Add parsing.
            Ok(content)
        }
        _ => Err(PatchError::InvalidPatchError(
            "expected exactly one create diff".into(),
        )),
    }
}

/// Apply fuzzy chunks to a snapshot, preserving original context and mixed
/// line endings. Insertions use the first source line ending (LF if absent).
/// Like upstream, updates give an unterminated final line a line ending.
/// Matching retains upstream's multiple search passes and nonlinear worst case.
pub fn apply_update(source: &str, chunks: &[UpdateChunk]) -> Result<String, PatchError> {
    if chunks.is_empty() {
        return Err(PatchError::InvalidPatchError("empty update".into()));
    }
    let mut source_file = text_file::SourceFile::parse(source);
    let lines = source_file.line_texts();
    let replacements = update::compute_replacements(&lines, "snapshot", chunks)?;
    let mut previous_end = 0usize;
    for (start, length, _) in &replacements {
        if *start < previous_end || start.saturating_add(*length) > lines.len() {
            return Err(PatchError::ComputeReplacements(
                "overlapping replacements".into(),
            ));
        }
        previous_end = start + length;
    }
    source_file.apply_replacements(&replacements);
    Ok(source_file.into_contents())
}
