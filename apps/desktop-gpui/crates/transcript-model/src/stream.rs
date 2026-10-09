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

//! Folding streamed assistant text.
//!
//! Two TypeScript pieces meet here:
//!
//! - `foldRuntimeHostAssistantDelta` in
//!   `packages/runtime-host/src/adapter/session-projector.ts`: a delta names
//!   the offset its text starts at and may overlap what was already
//!   received; the overlap must agree, and only the unseen tail is appended.
//!   A delta that starts past the end is a gap.
//! - `applyStreamDelta` / `applyStreamComplete` in `packages/ui/src/stream-delta.ts`
//!   with the assistant caps from `assistant-stream.ts` and the reasoning
//!   caps from `thinking-stream.ts`: a per-delta cap (tail kept, marker in
//!   front) and a total cap. Assistant text keeps its head (marker at the
//!   end, and the buffer frozen once full): it is read top-down. Reasoning
//!   keeps its tail (marker in front): the reader follows the current chain
//!   of thought. The secondary `redactSecrets` pass is not ported yet
//!   (Phase 2).
//!
//! Offsets and caps count UTF-16 code units, because the Host and the TS
//! renderer measure with JavaScript string lengths. A cut never splits a
//! character: where TS would cut inside a surrogate pair, this cuts before it.

use thiserror::Error;

/// `ASSISTANT_MAX_DELTA_CHARS`.
pub const ASSISTANT_MAX_DELTA_UNITS: usize = 4 * 1024;
/// `ASSISTANT_MAX_TOTAL_CHARS`.
pub const ASSISTANT_MAX_TOTAL_UNITS: usize = 256 * 1024;
/// `assistantChunkTruncated` (en-US, `packages/ui/src/shared-ui-copy.ts`).
pub const ASSISTANT_CHUNK_MARKER: &str = "\n[…single delta truncated]\n";
/// `assistantTailTruncated` (en-US).
pub const ASSISTANT_TOTAL_MARKER: &str = "\n\n[…remaining output truncated]";
/// `THINKING_MAX_DELTA_CHARS` (`packages/ui/src/thinking-stream.ts`).
pub const THINKING_MAX_DELTA_UNITS: usize = 4 * 1024;
/// `THINKING_MAX_TOTAL_CHARS`.
pub const THINKING_MAX_TOTAL_UNITS: usize = 32 * 1024;
/// `thinkingChunkTruncated` (en-US).
pub const THINKING_CHUNK_MARKER: &str = "\n[…single delta truncated]\n";
/// `thinkingHeadTruncated` (en-US).
pub const THINKING_TOTAL_MARKER: &str = "[…earlier reasoning truncated]\n";

/// Which end of an over-cap buffer survives (`StreamDeltaSpec.recovery`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Keep the start, mark the end, and freeze once full (assistant text).
    Head,
    /// Keep the latest text and mark the start (reasoning).
    Tail,
}

/// Why a delta cannot be folded. Either one means the stream diverged from
/// what this client holds; the subscription must be reopened.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum FoldError {
    /// `Runtime Host assistant delta has a gap`.
    #[error("assistant delta starts at {start_offset} but only {received} units were received")]
    Gap { start_offset: u64, received: usize },
    /// `Runtime Host assistant delta conflicts with prior output`, or an
    /// offset that falls inside a character.
    #[error("assistant delta at {start_offset} conflicts with prior output")]
    Conflict { start_offset: u64 },
}

/// Accumulated text of one streamed message, with its UTF-16 length cached.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamText {
    text: String,
    units: usize,
}

impl StreamText {
    /// Text received so far.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// Length in UTF-16 code units.
    pub fn units(&self) -> usize {
        self.units
    }

    /// Starts from existing text, for example a durable assistant row.
    pub fn from_text(text: &str) -> Self {
        Self { text: text.to_owned(), units: utf16_len(text) }
    }

    /// Folds a delta (`foldRuntimeHostAssistantDelta`) and returns the tail
    /// that was new.
    pub fn fold(&mut self, start_offset: u64, delta: &str) -> Result<String, FoldError> {
        let start = usize::try_from(start_offset)
            .map_err(|_| FoldError::Gap { start_offset, received: self.units })?;
        if start > self.units {
            return Err(FoldError::Gap { start_offset, received: self.units });
        }
        let delta_units = utf16_len(delta);
        let overlap = (self.units - start).min(delta_units);
        let conflict = FoldError::Conflict { start_offset };
        let delta_split = utf16_to_byte(delta, overlap).ok_or(conflict.clone())?;
        if overlap > 0 {
            let from = utf16_to_byte(&self.text, start).ok_or(conflict.clone())?;
            let to = utf16_to_byte(&self.text, start + overlap).ok_or(conflict.clone())?;
            if self.text[from..to] != delta[..delta_split] {
                return Err(conflict);
            }
        }
        let tail = &delta[delta_split..];
        self.text.push_str(tail);
        self.units += delta_units - overlap;
        Ok(tail.to_owned())
    }
}

/// The caps one stream applies (`StreamDeltaSpec`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamCaps {
    pub max_delta_units: usize,
    pub max_total_units: usize,
    pub chunk_marker: &'static str,
    pub total_marker: &'static str,
    pub recovery: Recovery,
}

impl StreamCaps {
    /// The assistant text caps (`applyAssistantDelta` in `assistant-stream.ts`).
    pub const ASSISTANT: Self = Self {
        max_delta_units: ASSISTANT_MAX_DELTA_UNITS,
        max_total_units: ASSISTANT_MAX_TOTAL_UNITS,
        chunk_marker: ASSISTANT_CHUNK_MARKER,
        total_marker: ASSISTANT_TOTAL_MARKER,
        recovery: Recovery::Head,
    };

    /// The reasoning caps (`applyThinkingDelta` in `thinking-stream.ts`).
    pub const THINKING: Self = Self {
        max_delta_units: THINKING_MAX_DELTA_UNITS,
        max_total_units: THINKING_MAX_TOTAL_UNITS,
        chunk_marker: THINKING_CHUNK_MARKER,
        total_marker: THINKING_TOTAL_MARKER,
        recovery: Recovery::Tail,
    };
}

/// Appends a raw delta to displayed text (`applyStreamDelta`, without
/// redaction). Returns whether anything was truncated.
pub fn apply_stream_delta(display: &mut String, delta: &str, caps: StreamCaps) -> bool {
    let total_marker_units = utf16_len(caps.total_marker);
    if caps.recovery == Recovery::Head
        && utf16_len(display) >= caps.max_total_units
        && display.ends_with(caps.total_marker)
    {
        // Head-keep freezes the buffer once it is full.
        return true;
    }
    let mut truncated = false;
    if utf16_len(delta) > caps.max_delta_units {
        let keep = caps.max_delta_units.saturating_sub(utf16_len(caps.chunk_marker));
        display.push_str(caps.chunk_marker);
        display.push_str(utf16_suffix(delta, keep));
        truncated = true;
    } else {
        display.push_str(delta);
    }
    if utf16_len(display) > caps.max_total_units {
        let keep = caps.max_total_units.saturating_sub(total_marker_units);
        match caps.recovery {
            Recovery::Head => {
                let cut = utf16_prefix(display, keep).len();
                display.truncate(cut);
                display.push_str(caps.total_marker);
            }
            Recovery::Tail => {
                // `truncateStreamingDisplayTail`: the marker, then the
                // latest text. An earlier marker goes with the head.
                *display = format!("{}{}", caps.total_marker, utf16_suffix(display, keep));
            }
        }
        truncated = true;
    }
    truncated
}

/// Replaces displayed text with a complete payload (`applyStreamComplete`):
/// only the total cap applies. Returns the text and whether it was
/// truncated.
pub fn apply_stream_complete(text: &str, caps: StreamCaps) -> (String, bool) {
    if utf16_len(text) <= caps.max_total_units {
        return (text.to_owned(), false);
    }
    let keep = caps.max_total_units.saturating_sub(utf16_len(caps.total_marker));
    let capped = match caps.recovery {
        Recovery::Head => format!("{}{}", utf16_prefix(text, keep), caps.total_marker),
        Recovery::Tail => format!("{}{}", caps.total_marker, utf16_suffix(text, keep)),
    };
    (capped, true)
}

/// Length in UTF-16 code units (JavaScript `length`).
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte index `units` UTF-16 code units into `text`; `None` past the end
/// or inside a surrogate pair.
fn utf16_to_byte(text: &str, units: usize) -> Option<usize> {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        if count == units {
            return Some(index);
        }
        count += ch.len_utf16();
        if count > units {
            return None;
        }
    }
    (count == units).then_some(text.len())
}

/// The longest prefix of at most `units` UTF-16 code units.
fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        if count + ch.len_utf16() > units {
            return &text[..index];
        }
        count += ch.len_utf16();
    }
    text
}

/// The longest suffix of at most `units` UTF-16 code units.
fn utf16_suffix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices().rev() {
        if count + ch.len_utf16() > units {
            return &text[index + ch.len_utf8()..];
        }
        count += ch.len_utf16();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_in_order_and_trims_overlap() {
        let mut stream = StreamText::default();
        assert_eq!(stream.fold(0, "Hello").expect("fold"), "Hello");
        // A replayed delta overlapping the end only contributes its tail.
        assert_eq!(stream.fold(3, "lo, wor").expect("fold"), ", wor");
        // A fully replayed delta contributes nothing.
        assert_eq!(stream.fold(0, "Hel").expect("fold"), "");
        assert_eq!(stream.fold(10, "ld").expect("fold"), "ld");
        assert_eq!(stream.as_str(), "Hello, world");
        assert_eq!(stream.units(), 12);
    }

    #[test]
    fn a_delta_past_the_end_is_a_gap() {
        let mut stream = StreamText::from_text("abc");
        assert_eq!(stream.fold(4, "x"), Err(FoldError::Gap { start_offset: 4, received: 3 }));
        assert_eq!(stream.as_str(), "abc");
    }

    #[test]
    fn a_disagreeing_overlap_is_a_conflict() {
        let mut stream = StreamText::from_text("abc");
        assert_eq!(stream.fold(1, "Xcd"), Err(FoldError::Conflict { start_offset: 1 }));
    }

    #[test]
    fn offsets_count_utf16_units() {
        // "你好" is two BMP characters: two units, six UTF-8 bytes.
        let mut stream = StreamText::default();
        stream.fold(0, "你好").expect("fold");
        assert_eq!(stream.units(), 2);
        assert_eq!(stream.fold(1, "好，世界").expect("fold"), "，世界");
        // An astral character is two units.
        stream.fold(5, "😀").expect("fold");
        assert_eq!(stream.units(), 7);
        assert_eq!(stream.fold(7, "!").expect("fold"), "!");
        // An offset inside the surrogate pair cannot be honored.
        assert_eq!(stream.fold(6, "x"), Err(FoldError::Conflict { start_offset: 6 }));
    }

    #[test]
    fn an_empty_completion_adds_nothing() {
        let mut stream = StreamText::from_text("done");
        assert_eq!(stream.fold(4, "").expect("fold"), "");
        assert_eq!(stream.as_str(), "done");
    }

    const SMALL: StreamCaps = StreamCaps {
        max_delta_units: 8,
        max_total_units: 20,
        chunk_marker: "[c]",
        total_marker: "[t]",
        recovery: Recovery::Head,
    };

    const SMALL_TAIL: StreamCaps = StreamCaps { recovery: Recovery::Tail, ..SMALL };

    #[test]
    fn the_tail_cap_keeps_the_latest_text_behind_one_marker() {
        let mut display = String::new();
        assert!(!apply_stream_delta(&mut display, "01234567", SMALL_TAIL));
        assert!(!apply_stream_delta(&mut display, "abcdefgh", SMALL_TAIL));
        assert!(apply_stream_delta(&mut display, "ABCDEFGH", SMALL_TAIL));
        assert_eq!(display, "[t]7abcdefghABCDEFGH");
        assert_eq!(utf16_len(&display), 20);
        // It keeps sliding; the old marker goes with the head.
        assert!(apply_stream_delta(&mut display, "xy", SMALL_TAIL));
        assert_eq!(display, "[t]bcdefghABCDEFGHxy");
        let (text, truncated) = apply_stream_complete(&"x".repeat(25), SMALL_TAIL);
        assert!(truncated);
        assert_eq!(text, format!("[t]{}", "x".repeat(17)));
    }

    #[test]
    fn oversize_deltas_keep_their_tail() {
        let mut display = String::from("ab");
        assert!(apply_stream_delta(&mut display, "0123456789", SMALL));
        assert_eq!(display, "ab[c]56789");
    }

    #[test]
    fn the_total_cap_keeps_the_head_and_freezes() {
        let mut display = String::new();
        assert!(!apply_stream_delta(&mut display, "01234567", SMALL));
        assert!(!apply_stream_delta(&mut display, "abcdefgh", SMALL));
        assert!(apply_stream_delta(&mut display, "ABCDEFGH", SMALL));
        assert_eq!(display, "01234567abcdefghA[t]");
        assert_eq!(utf16_len(&display), 20);
        assert!(apply_stream_delta(&mut display, "more", SMALL));
        assert_eq!(display, "01234567abcdefghA[t]");
    }

    #[test]
    fn completion_applies_only_the_total_cap() {
        assert_eq!(apply_stream_complete("0123456789abc", SMALL), ("0123456789abc".into(), false));
        let (text, truncated) = apply_stream_complete(&"x".repeat(30), SMALL);
        assert!(truncated);
        assert_eq!(text, format!("{}[t]", "x".repeat(17)));
    }

    #[test]
    fn cuts_never_split_a_character() {
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_suffix("a😀b", 2), "b");
        assert_eq!(utf16_suffix("a😀b", 3), "😀b");
    }
}
