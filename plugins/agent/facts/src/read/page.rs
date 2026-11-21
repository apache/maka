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

use super::{MAX_PAGE_CHARS, PREFIX, ReadError, ReadInput, ReadRequest, Start, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, num::NonZeroUsize};

/// JSON overhead for appending ,"tailPreview": inside a canonical archive JSON object.
pub(crate) const TAIL_PREVIEW_KEY_UTF16: usize = 15;
pub(crate) const STREAM_PREFIX_CAPTURE_BYTES: usize = 256;

/// Budget mode for TextPageScan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageBudget {
    /// Cap the entire serialized ReadPage JSON (including envelope and next),
    /// always advancing at least one scalar on non-empty input. Used by Read.
    SerializedPage(usize),
    /// Cap only the optional display body (serialized JSON UTF-16 cost of
    /// page.content plus optional tailPreview key and JSON string). Fixed
    /// protocol metadata is outside this cap, and 0 produces an empty head page
    /// with next at offset 0 so zero optional body characters leak.
    DisplayBody(usize),
}

impl PageBudget {
    fn raw_limit(self) -> usize {
        match self {
            Self::SerializedPage(limit) | Self::DisplayBody(limit) => limit,
        }
    }
}

/// Fixed-memory UTF-16 trailing ring buffer shared by pure-text archive paging,
/// mixed text+media archiving, and asynchronous Cell notification bounding.
#[derive(Clone, Debug)]
pub(crate) struct TailRing {
    ring: VecDeque<char>,
    used_utf16: usize,
    start_byte: usize,
    cap_utf16: usize,
    json_escaped: bool,
}

impl TailRing {
    pub(crate) fn new(cap_utf16: usize, json_escaped: bool) -> Self {
        Self {
            ring: VecDeque::new(),
            used_utf16: 0,
            start_byte: 0,
            cap_utf16,
            json_escaped,
        }
    }

    fn char_cost(&self, ch: char) -> usize {
        if self.json_escaped {
            json_char_utf16_len(ch)
        } else {
            ch.len_utf16()
        }
    }

    pub(crate) fn push(&mut self, ch: char, byte_offset: usize) {
        if self.cap_utf16 == 0 {
            return;
        }
        let cost = self.char_cost(ch);
        if cost > self.cap_utf16 {
            self.ring.clear();
            self.used_utf16 = 0;
            self.start_byte = byte_offset + ch.len_utf8();
            return;
        }
        if self.ring.is_empty() {
            self.start_byte = byte_offset;
        }
        self.ring.push_back(ch);
        self.used_utf16 += cost;
        while self.used_utf16 > self.cap_utf16 {
            if let Some(dropped) = self.ring.pop_front() {
                self.used_utf16 -= self.char_cost(dropped);
                self.start_byte += dropped.len_utf8();
            }
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.ring.is_empty()
    }

    pub(crate) fn used_utf16(&self) -> usize {
        self.used_utf16
    }

    /// Snap the tail to a clean newline boundary when near the front, strip any
    /// prefix overlapping bytes already kept in the head (last_kept_byte),
    /// and return the final trailing preview text.
    pub(crate) fn finish(self, last_kept_byte: usize) -> Option<String> {
        if self.ring.is_empty() {
            return None;
        }
        let mut text: String = self.ring.into_iter().collect();

        // First strip any prefix already emitted in the head page/parts.
        let overlap = last_kept_byte.saturating_sub(self.start_byte);
        if overlap >= text.len() {
            return None;
        }
        if overlap > 0 {
            let mut cut = overlap;
            while cut < text.len() && !text.is_char_boundary(cut) {
                cut += 1;
            }
            text.drain(..cut);
        }

        // Then snap to the first newline within the leading quarter for clean line alignment.
        let mut snap_window = text.len() / 4;
        while snap_window > 0 && !text.is_char_boundary(snap_window) {
            snap_window -= 1;
        }
        if let Some(nl) = text[..snap_window].find('\n') {
            let next = nl + 1;
            if next < text.len() {
                text.drain(..next);
            }
        }
        (!text.is_empty()).then_some(text)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadPage {
    pub content: String,
    pub offset: usize,
    pub returned_lines: usize,
    pub total_lines: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial_line: bool,
    pub next: Option<ReadInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<super::ReadMetadata>,
}

#[derive(Clone, Copy, Default)]
struct Position {
    byte: usize,
    utf16: usize,
    line: usize,
    line_start: usize,
    before_newline: bool,
}

/// One text scan, retaining only candidates for the requested bounded page.
/// The caller must feed the entire source before finishing, including its tail.
pub struct TextPageScan<'a> {
    request: &'a ReadRequest,
    budget: PageBudget,
    digest: Sha256,
    position: Position,
    start: Option<Position>,
    end: Option<Position>,
    content: String,
    candidates: Vec<Position>,
    full: bool,
    tail: TailRing,
    prefix: String,
}

impl ReadRequest {
    pub fn scan_with_budget(&self, budget: usize) -> TextPageScan<'_> {
        self.scan_with_page_budget(PageBudget::SerializedPage(budget), 0)
    }

    /// Stream one bounded head page under an explicit PageBudget while optionally
    /// retaining a fixed-size JSON-escaped ring buffer of trailing characters.
    pub fn scan_with_page_budget(
        &self,
        budget: PageBudget,
        tail_serialized_budget: usize,
    ) -> TextPageScan<'_> {
        let tail_content_cap = tail_serialized_budget.saturating_sub(TAIL_PREVIEW_KEY_UTF16 + 2);
        TextPageScan {
            request: self,
            budget,
            digest: Sha256::new(),
            position: Position::default(),
            start: None,
            end: None,
            content: String::new(),
            candidates: Vec::new(),
            full: false,
            tail: TailRing::new(tail_content_cap, true),
            prefix: String::new(),
        }
    }

    pub fn page(&self, text: &str) -> Result<ReadPage, ReadError> {
        self.page_with_budget(text, MAX_PAGE_CHARS)
    }

    /// Target serialized UTF-16 length, including the original continuation.
    /// One complete scalar or an empty completed range always progresses.
    /// Callers adding execution metadata reserve its serialized size here.
    pub fn page_with_budget(&self, text: &str, budget: usize) -> Result<ReadPage, ReadError> {
        let mut scan = self.scan_with_budget(budget);
        scan.push(text);
        scan.finish()
    }

    pub fn page_with_page_budget(
        &self,
        text: &str,
        budget: PageBudget,
        tail_serialized_budget: usize,
    ) -> Result<(ReadPage, Option<String>), ReadError> {
        let mut scan = self.scan_with_page_budget(budget, tail_serialized_budget);
        scan.push(text);
        scan.finish_with_tail(tail_serialized_budget)
    }
}

impl TextPageScan<'_> {
    fn select_start(&mut self) {
        if self.start.is_some() {
            return;
        }
        let matches = match self.request.start {
            Start::Line(line) => {
                self.position.line == line && self.position.byte == self.position.line_start
            }
            Start::Continuation { position, .. } => self.position.utf16 == position,
        };
        if matches {
            self.start = Some(self.position);
            self.candidates.push(self.position);
            if matches!(self.budget, PageBudget::DisplayBody(0)) {
                self.full = true;
            }
        }
    }

    pub fn push(&mut self, text: &str) {
        self.digest.update(text.as_bytes());
        let raw_limit = self.budget.raw_limit();
        let require_one_scalar = matches!(self.budget, PageBudget::SerializedPage(_));
        for character in text.chars() {
            if self.position.byte == self.prefix.len()
                && self.prefix.len() + character.len_utf8() <= STREAM_PREFIX_CAPTURE_BYTES
            {
                self.prefix.push(character);
            }
            self.select_start();
            self.position.before_newline = character == '\n';
            if let Some(last) = self.candidates.last_mut()
                && last.byte == self.position.byte
            {
                last.before_newline = self.position.before_newline;
            }
            if let Some(start) = self.start {
                if self.end.is_none()
                    && character == '\n'
                    && self.request.limit.is_some_and(|limit| {
                        self.position.line + 1 == start.line.saturating_add(limit.get())
                    })
                {
                    self.end = Some(self.position);
                }
                if self.end.is_none() && !self.full {
                    let fits_raw =
                        self.position.utf16 - start.utf16 + character.len_utf16() <= raw_limit;
                    if fits_raw || (require_one_scalar && self.content.is_empty()) {
                        self.content.push(character);
                    } else {
                        self.full = true;
                    }
                }
            }
            self.tail.push(character, self.position.byte);
            self.position.byte += character.len_utf8();
            self.position.utf16 += character.len_utf16();
            if character == '\n' {
                self.position.line += 1;
                self.position.line_start = self.position.byte;
            }
            self.position.before_newline = false;
            if self.start.is_some() && self.end.is_none() && !self.full {
                self.candidates.push(self.position);
            }
        }
    }

    pub fn finish(self) -> Result<ReadPage, ReadError> {
        self.finish_with_tail(0).map(|(page, _)| page)
    }

    /// Finish scanning and, when the page truncates the source and budget permits,
    /// return a non-overlapping trailing preview whose serialized JSON overhead fits
    /// within tail_serialized_budget (deducted from the page budget).
    pub fn finish_with_tail(
        self,
        tail_serialized_budget: usize,
    ) -> Result<(ReadPage, Option<String>), ReadError> {
        self.finish_with_tail_and_prefix(tail_serialized_budget)
            .map(|(page, tail, _)| (page, tail))
    }

    pub(crate) fn finish_with_tail_and_prefix(
        mut self,
        tail_serialized_budget: usize,
    ) -> Result<(ReadPage, Option<String>, String), ReadError> {
        self.select_start();
        let digest = hex::encode(self.digest.finalize());
        let digest = &digest[..32];
        if let Start::Continuation {
            digest: expected, ..
        } = &self.request.start
        {
            if digest != expected {
                return Err(ReadError::ContentChanged);
            }
            if self.start.is_none() {
                return Err(ReadError::InvalidPosition);
            }
        }
        let start = self.start.unwrap_or(self.position);
        if self.candidates.is_empty() {
            self.candidates.push(start);
        }
        let offset = match self.request.start {
            Start::Line(offset) => offset,
            Start::Continuation { .. } => start.line,
        };
        let total_lines = self.position.line + 1;
        let last_line = offset
            .saturating_add(self.request.limit.map_or(total_lines, NonZeroUsize::get))
            .min(total_lines);
        let end = self.end.unwrap_or(self.position);
        let make_page = |stop: Position| {
            let complete = stop.byte >= end.byte;
            let next_line = offset.max(stop.line);
            let boundary = stop.before_newline && stop.line == next_line;
            let partial = !complete && !boundary;
            let returned_lines = if offset >= total_lines {
                0
            } else if complete {
                last_line - offset
            } else {
                next_line - offset + usize::from(!partial)
            };
            ReadPage {
                metadata: None,
                content: self.content[..stop.byte.saturating_sub(start.byte)].into(),
                offset,
                returned_lines,
                total_lines,
                partial_line: partial || (offset < total_lines && start.byte > start.line_start),
                next: (!complete).then(|| ReadInput {
                    path: format!(
                        "{PREFIX}{}?at={}&sha={digest}",
                        URL_SAFE_NO_PAD.encode(&self.request.path),
                        stop.utf16 + usize::from(!partial)
                    ),
                    offset: None,
                    limit: self.request.limit.map(|limit| {
                        NonZeroUsize::new(limit.get() - returned_lines)
                            .expect("incomplete line range")
                    }),
                }),
            }
        };
        let empty_incomplete_page = || ReadPage {
            metadata: None,
            content: String::new(),
            offset,
            returned_lines: 0,
            total_lines,
            partial_line: offset < total_lines && start.byte > start.line_start,
            next: Some(ReadInput {
                path: format!(
                    "{PREFIX}{}?at={}&sha={digest}",
                    URL_SAFE_NO_PAD.encode(&self.request.path),
                    start.utf16
                ),
                offset: None,
                limit: self.request.limit,
            }),
        };

        if let PageBudget::DisplayBody(0) = self.budget {
            if start.byte >= end.byte {
                return Ok((make_page(end), None, self.prefix));
            }
            return Ok((empty_incomplete_page(), None, self.prefix));
        }

        let fits = |page: &ReadPage, limit: usize| match self.budget {
            PageBudget::SerializedPage(_) => {
                serde_json::to_string(page)
                    .expect("ReadPage contains only JSON fields")
                    .encode_utf16()
                    .count()
                    <= limit
            }
            PageBudget::DisplayBody(_) => json_string_body_utf16_len(&page.content) <= limit,
        };

        let total_budget = self.budget.raw_limit();
        if end.utf16.saturating_sub(start.utf16) <= total_budget {
            let page = make_page(end);
            if fits(&page, total_budget) {
                return Ok((page, None, self.prefix));
            }
        }

        let force_one_scalar = matches!(self.budget, PageBudget::SerializedPage(_));
        let select_stop = |limit: usize| -> (usize, Position) {
            let (mut low, mut high) = (0, self.candidates.len() - 1);
            while low < high {
                let middle = low + (high - low).div_ceil(2);
                if fits(&make_page(self.candidates[middle]), limit) {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }
            if low == 0 {
                if force_one_scalar {
                    return (0, self.candidates[usize::from(self.candidates.len() > 1)]);
                }
                return (0, start);
            }
            let mut stop = self.candidates[low];
            let span = stop.byte - start.byte;
            if let Some(relative) = self.content[..span]
                .rfind('\n')
                .filter(|relative| *relative * 2 >= span && !stop.before_newline)
            {
                stop = *self
                    .candidates
                    .iter()
                    .find(|candidate| candidate.byte == start.byte + relative)
                    .expect("retained scalar boundary");
            }
            (low, stop)
        };

        let tail_enabled =
            tail_serialized_budget > TAIL_PREVIEW_KEY_UTF16 + 2 && !self.tail.is_empty();
        let reserved_tail_cost = if tail_enabled {
            TAIL_PREVIEW_KEY_UTF16 + 2 + self.tail.used_utf16()
        } else {
            0
        };
        let mut keep_tail = tail_enabled && reserved_tail_cost < total_budget;
        let head_budget = if keep_tail {
            total_budget.saturating_sub(reserved_tail_cost)
        } else {
            total_budget
        };
        let (low, mut stop) = select_stop(head_budget);
        if low == 0 && keep_tail {
            // When space is tight, drop tailPreview first and give the full budget to head.
            keep_tail = false;
            stop = select_stop(total_budget).1;
        }
        if !force_one_scalar && stop.byte <= start.byte && end.byte > start.byte {
            return Ok((empty_incomplete_page(), None, self.prefix));
        }
        let page = make_page(stop);
        let tail_preview = if page.next.is_none() || !keep_tail {
            None
        } else {
            self.tail.finish(stop.byte)
        };
        Ok((page, tail_preview, self.prefix))
    }
}

#[cfg(test)]
pub(crate) fn json_string_utf16_len(text: &str) -> usize {
    2 + json_string_body_utf16_len(text)
}

pub(crate) fn json_string_body_utf16_len(text: &str) -> usize {
    text.chars().map(json_char_utf16_len).sum()
}

pub(crate) fn json_char_utf16_len(ch: char) -> usize {
    match ch {
        '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
        '\u{00}'..='\u{1f}' => 6,
        _ => ch.len_utf16(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_pages_preserve_line_ranges_unicode_and_reject_changed_content() {
        let text = (0..1_200)
            .map(|i| format!("line-{i:04}: 😀 café {}", "x".repeat(16)))
            .collect::<Vec<_>>()
            .join("\n");
        let mut request = ReadInput {
            path: "notes.txt".into(),
            offset: None,
            limit: None,
        }
        .resolve()
        .unwrap();
        let mut rebuilt = String::new();
        let mut pages = 0usize;
        loop {
            let page = request.page(&text).unwrap();
            assert!(serde_json::to_string(&page).unwrap().encode_utf16().count() <= MAX_PAGE_CHARS);
            if !rebuilt.is_empty() && !page.content.is_empty() && !page.partial_line {
                rebuilt.push('\n');
            }
            rebuilt.push_str(&page.content);
            pages += 1;
            let Some(next) = page.next else { break };
            request = next.resolve().unwrap();
        }
        assert!(pages > 1);
        assert_eq!(rebuilt, text);

        // Continuation must reject changed content.
        let first = ReadInput {
            path: "notes.txt".into(),
            offset: None,
            limit: None,
        }
        .resolve()
        .unwrap()
        .page(&text)
        .unwrap();
        let changed = format!("{text}\nchanged");
        assert_eq!(
            first.next.unwrap().resolve().unwrap().page(&changed),
            Err(ReadError::ContentChanged)
        );
    }

    #[test]
    fn soft_first_read_scalar_keeps_long_original_address_and_digest() {
        let long_path = format!("archive:{}", "a".repeat(2_000));
        let request = ReadInput {
            path: long_path,
            offset: None,
            limit: None,
        }
        .resolve()
        .unwrap();
        let page = request.page_with_budget("hello\nworld", 32).unwrap();
        assert_eq!(page.content, "h");
        assert!(page.next.is_some());
    }

    #[test]
    fn tail_preview_tracks_quotes_unicode_single_line_and_tight_budgets() {
        let req = ReadInput {
            path: "archive:evt-1".into(),
            offset: None,
            limit: None,
        }
        .resolve()
        .unwrap();

        // Heavily escaped quotes/backslashes + CJK + surrogate-pair emoji.
        let mut lines = Vec::new();
        for i in 0..400 {
            lines.push(format!(
                "line {i:03}: \"quoted\" \\path\\to\\file 中文 🔥 {}",
                "a".repeat(30)
            ));
        }
        lines.push("FINAL_DIAGNOSTIC: \"fatal\" \\err\\999 💥".into());
        let text = lines.join("\n");

        let (page, tail) = req
            .page_with_page_budget(&text, PageBudget::DisplayBody(8_000), 1_500)
            .unwrap();
        let tail = tail.expect("overflowing multi-line output should produce tailPreview");
        assert!(tail.contains("FINAL_DIAGNOSTIC: \"fatal\" \\err\\999 💥"));
        assert!(page.next.is_some());
        let serialized_body = json_string_body_utf16_len(&page.content)
            + TAIL_PREVIEW_KEY_UTF16
            + json_string_utf16_len(&tail);
        assert!(
            serialized_body <= 8_000,
            "serialized body exceeded budget: {serialized_body}"
        );
        assert!(
            TAIL_PREVIEW_KEY_UTF16 + json_string_utf16_len(&tail) <= 1_500,
            "tail exceeded tail budget"
        );

        // Single huge line without newlines should still produce non-overlapping tailPreview.
        let single_line = format!("{}END_SINGLE_LINE_MARKER", "中".repeat(5_000));
        let (sl_page, sl_tail) = req
            .page_with_page_budget(&single_line, PageBudget::DisplayBody(2_000), 400)
            .unwrap();
        let sl_tail = sl_tail.expect("single huge line should produce tailPreview");
        assert!(sl_tail.contains("END_SINGLE_LINE_MARKER"));
        assert!(!sl_page.content.contains("END_SINGLE_LINE_MARKER"));

        // Zero DisplayBody budget must leak zero optional body even on short 120-char text,
        // and its next token (at=0) must read back the complete text.
        let short = format!("SECRET_BODY_{}", "x".repeat(120));
        let (zero_page, zero_tail) = req
            .page_with_page_budget(&short, PageBudget::DisplayBody(0), 0)
            .unwrap();
        assert_eq!(zero_page.content, "");
        assert_eq!(zero_page.returned_lines, 0);
        assert!(zero_tail.is_none());
        let next_req = zero_page
            .next
            .expect("zero budget must emit continuation at offset 0")
            .resolve()
            .unwrap();
        let recovered = next_req.page(&short).unwrap();
        assert_eq!(recovered.content, short);
        assert!(recovered.next.is_none());

        // Tight non-zero DisplayBody budget (200 chars on 250-char text) must truncate at <= 200
        // rather than letting envelope slack return the full text.
        let medium = "m".repeat(250);
        let (tight_page, tight_tail) = req
            .page_with_page_budget(&medium, PageBudget::DisplayBody(200), 0)
            .unwrap();
        assert!(tight_tail.is_none());
        assert_eq!(tight_page.content.len(), 200);
        assert!(tight_page.next.is_some());
    }
}
