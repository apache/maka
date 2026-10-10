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

//! What the panel's Diff shows of each file, prepared off the main thread:
//! the file's patch cut to its line cap unless it shows whole, where its
//! "Show more lines" goes, and the kit's parse of it. A file whose patch is
//! too large to hold shows its header alone.
//!
//! The kit's `DiffFile` keeps its document behind an `Arc` and is `Send`
//! (checked below), so the background executor parses every file and the
//! panel only hands the Diff the result.

use std::sync::Arc;

use gpui_kit::SharedString;
use gpui_kit::component::diff::DiffFile;
use shared::diff::{self as unified, DiffSide as UnifiedSide};

use crate::git::{DIFF_CONTEXT_LINES, FileStatus};

// A parsed file crosses from the background executor to the panel.
const _: fn() = || {
    fn sendable<T: Send>() {}
    sendable::<DiffFile>();
};

/// What a file's diff is made from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DiffSource {
    /// Its patch, or its whole text around its changes once read for
    /// "Show more lines".
    Text(Arc<str>),
    /// A patch too large to hold: the file shows its header alone.
    TooLarge,
}

/// Everything a file's diff depends on: two equal inputs give the same
/// [`ShownFile`], so a read that changes nothing keeps the Diff as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiffInput {
    /// The file's path as Git lists it: what the tree names.
    pub(crate) path: SharedString,
    pub(crate) status: FileStatus,
    pub(crate) source: DiffSource,
    /// The source is the file's whole text, read for "Show more lines".
    pub(crate) whole_text: bool,
    /// Git can give more of the file's lines than its diff carries ("Show
    /// more lines"): a Git scope's file, not a turn's.
    pub(crate) more: bool,
    /// Which of the turn's edits of the file this diff is, and of how
    /// many, when a turn's file shows its edits one after another.
    pub(crate) step: Option<(usize, usize)>,
    /// The most lines of the diff shown before its "Show all".
    pub(crate) cap: usize,
}

/// A file as the Diff holds it: its parse, cut to its cap where the cut
/// leaves its last line, and whether Git has more of its lines to show.
#[derive(Clone)]
pub(crate) struct ShownFile {
    pub(crate) input: DiffInput,
    /// The path its diff gives, which the Diff names it by.
    pub(crate) diff_path: SharedString,
    pub(crate) hidden_lines: usize,
    pub(crate) last_line: Option<(UnifiedSide, u32)>,
    /// Where "Show more lines" goes: the file's last line in the diff,
    /// when the diff does not carry the whole file.
    pub(crate) more_at: Option<(UnifiedSide, u32)>,
    pub(crate) file: DiffFile,
}

impl ShownFile {
    pub(crate) fn path(&self) -> &SharedString {
        &self.input.path
    }

    /// Its patch was too large to hold: the Diff shows its header alone.
    pub(crate) fn is_too_large(&self) -> bool {
        self.input.source == DiffSource::TooLarge
    }
}

impl std::fmt::Debug for ShownFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShownFile")
            .field("path", &self.input.path)
            .field("diff_path", &self.diff_path)
            .field("hidden_lines", &self.hidden_lines)
            .finish_non_exhaustive()
    }
}

/// What the Diff shows of `input`: its diff cut to its cap, and parsed. A
/// diff the parser rejects shows its text as it is; a file too large to
/// hold, or one whose patch is empty, has no rows of its own.
pub(crate) fn prepare(input: DiffInput) -> ShownFile {
    let DiffSource::Text(text) = &input.source else {
        return ShownFile {
            diff_path: input.path.clone(),
            hidden_lines: 0,
            last_line: None,
            more_at: None,
            file: DiffFile::unchanged(input.path.clone(), ""),
            input,
        };
    };
    let bounded = unified::bounded(text, input.cap);
    let extent = unified::extent(&bounded.text);
    let partial =
        matches!(input.status, FileStatus::Modified | FileStatus::Renamed | FileStatus::Copied);
    let missing =
        extent.first_line > 1 || extent.hunks > 1 || extent.trailing_context >= DIFF_CONTEXT_LINES;
    let more_at =
        (input.more && partial && !input.whole_text && bounded.hidden_lines == 0 && missing)
            .then_some(extent.last_line)
            .flatten();
    let file = DiffFile::parse(&bounded.text)
        .ok()
        .and_then(|parsed| parsed.into_iter().next())
        .unwrap_or_else(|| DiffFile::unchanged(input.path.clone(), &bounded.text));
    ShownFile {
        diff_path: file.path().clone(),
        hidden_lines: bounded.hidden_lines,
        last_line: bounded.last_line,
        more_at,
        file,
        input,
    }
}
