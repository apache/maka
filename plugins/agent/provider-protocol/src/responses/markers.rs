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

//! Bounded O(N) streaming sanitizer and scalar offset mapper for OpenAI
//! Responses / Codex Private Use Area inline citation and entity markers
//! (`U+E200`..`U+E204`).

const OPEN: char = '\u{E200}';
const CLOSE: char = '\u{E201}';
const SEP: char = '\u{E202}';
const SPAN_OPEN: char = '\u{E203}';
const SPAN_CLOSE: char = '\u{E204}';

/// Hard cap on a single unclosed PUA marker token so malformed streams cannot
/// grow pending memory unboundedly.
const MAX_MARKER_BYTES: usize = 8 * 1024;
/// Hard cap on mid-line horizontal whitespace held pending a following marker.
const MAX_HELD_SPACE_BYTES: usize = 64;

/// Fast UTF-8 byte scan for `U+E200..=U+E204` (`[0xEE, 0x88, 0x80..=0x84]`).
pub(crate) fn has_citation_markers(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == 0xEE && bytes[i + 1] == 0x88 && matches!(bytes[i + 2], 0x80..=0x84) {
            return true;
        }
        i += 1;
    }
    false
}

/// Incremental O(N) PUA marker sanitizer for streamed `output_text` deltas.
///
/// Confirmed removed markers are discarded immediately; pending memory is
/// strictly bounded (~8 KiB) and output concatenated across arbitrary UTF-8
/// chunk boundaries matches batch sanitization byte-for-byte.
pub(crate) struct StreamSanitizer {
    at_line_start: bool,
    state: SpaceState,
    marker: Option<MarkerBuf>,
}

impl StreamSanitizer {
    pub(crate) fn new() -> Self {
        Self {
            at_line_start: true,
            state: SpaceState::Idle,
            marker: None,
        }
    }

    pub(crate) fn push(&mut self, chunk: &str) -> String {
        if chunk.is_empty() {
            return String::new();
        }
        if self.marker.is_none()
            && matches!(self.state, SpaceState::Idle)
            && !has_citation_markers(chunk)
            && !chunk.ends_with([' ', '\t'])
        {
            update_line_start(&mut self.at_line_start, chunk);
            return chunk.to_owned();
        }
        let mut out = String::new();
        let mut clean_scalars = 0u64;
        self.feed_str(chunk, Some(&mut out), None, &mut clean_scalars);
        out
    }

    pub(crate) fn finish(&mut self) -> String {
        let mut out = String::new();
        let mut clean_scalars = 0u64;
        self.finish_into(Some(&mut out), None, &mut clean_scalars);
        out
    }

    fn feed_str(
        &mut self,
        chunk: &str,
        mut out: Option<&mut String>,
        mut map: Option<&mut Vec<u64>>,
        clean_scalars: &mut u64,
    ) {
        let mut pos = 0;
        while pos < chunk.len() {
            // Fast batch scan for normal characters while idle.
            if self.marker.is_none() && matches!(self.state, SpaceState::Idle) {
                let run_start = pos;
                while pos < chunk.len() {
                    let ch = chunk[pos..].chars().next().expect("valid char boundary");
                    if ch == OPEN
                        || is_span_delim(ch)
                        || (is_horizontal_space(ch) && !self.at_line_start)
                    {
                        break;
                    }
                    if ch == '\n' || ch == '\r' {
                        self.at_line_start = true;
                    } else if !is_horizontal_space(ch) {
                        self.at_line_start = false;
                    }
                    pos += ch.len_utf8();
                }
                if pos > run_start {
                    record_copied(&chunk[run_start..pos], &mut out, &mut map, clean_scalars);
                    continue;
                }
            }

            let ch = chunk[pos..].chars().next().expect("valid char boundary");
            pos += ch.len_utf8();
            self.feed_char(ch, &mut out, &mut map, clean_scalars);
        }
    }

    fn feed_char(
        &mut self,
        ch: char,
        out: &mut Option<&mut String>,
        map: &mut Option<&mut Vec<u64>>,
        clean_scalars: &mut u64,
    ) {
        if let Some(mut m) = self.marker.take() {
            if ch == CLOSE {
                let body = &m.buf[OPEN.len_utf8()..];
                let total_scalars = m.scalars + 1;
                match classify_closed_body(body) {
                    Some(ClosedMarker::Remove) => {
                        self.on_removed_marker(total_scalars);
                    }
                    Some(ClosedMarker::Replace(display)) => {
                        self.flush_non_remove(false, out, map, clean_scalars);
                        record_replaced(total_scalars, &display, out, map, clean_scalars);
                        update_line_start(&mut self.at_line_start, &display);
                    }
                    None => {
                        self.flush_non_remove(false, out, map, clean_scalars);
                        m.buf.push(CLOSE);
                        record_copied(&m.buf, out, map, clean_scalars);
                        update_line_start(&mut self.at_line_start, &m.buf);
                    }
                }
                return;
            }

            let abort = ch == OPEN
                || ch == '\n'
                || ch == '\r'
                || m.buf.len() + ch.len_utf8() > MAX_MARKER_BYTES
                || (!m.sep_seen
                    && if ch == SEP {
                        !is_ascii_tag(&m.buf[OPEN.len_utf8()..])
                    } else {
                        !is_ascii_token_char(ch)
                    });
            if !abort {
                if ch == SEP {
                    m.sep_seen = true;
                }
                m.buf.push(ch);
                m.scalars += 1;
                self.marker = Some(m);
                return;
            }

            // Aborted marker becomes literal text, then re-process `ch` normally.
            self.flush_non_remove(false, out, map, clean_scalars);
            record_copied(&m.buf, out, map, clean_scalars);
            update_line_start(&mut self.at_line_start, &m.buf);
        }

        if ch == OPEN {
            let mut buf = String::with_capacity(32);
            buf.push(OPEN);
            self.marker = Some(MarkerBuf {
                buf,
                sep_seen: false,
                scalars: 1,
            });
            return;
        }

        if is_span_delim(ch) {
            match &mut self.state {
                SpaceState::Idle | SpaceState::SpaceOverflow => {
                    record_removed_count(1, map, *clean_scalars);
                }
                SpaceState::PreSpace { span_scalars, .. } => {
                    *span_scalars += 1;
                }
                SpaceState::InCluster {
                    cluster_scalars,
                    inter_spaces,
                    inter_span_scalars,
                    ..
                } => {
                    if inter_spaces.is_empty() {
                        *cluster_scalars += 1;
                    } else {
                        *inter_span_scalars += 1;
                    }
                }
            }
            return;
        }

        if is_horizontal_space(ch) {
            match std::mem::replace(&mut self.state, SpaceState::Idle) {
                SpaceState::Idle => {
                    if self.at_line_start {
                        record_copied_char(ch, out, map, clean_scalars);
                    } else {
                        let mut spaces = String::with_capacity(4);
                        spaces.push(ch);
                        self.state = SpaceState::PreSpace {
                            spaces,
                            space_scalars: 1,
                            span_scalars: 0,
                        };
                    }
                }
                SpaceState::SpaceOverflow => {
                    record_copied_char(ch, out, map, clean_scalars);
                    self.state = SpaceState::SpaceOverflow;
                }
                SpaceState::PreSpace {
                    mut spaces,
                    space_scalars,
                    span_scalars,
                } => {
                    if span_scalars > 0 {
                        record_copied(&spaces, out, map, clean_scalars);
                        record_removed_count(span_scalars, map, *clean_scalars);
                        let mut next = String::with_capacity(4);
                        next.push(ch);
                        self.state = SpaceState::PreSpace {
                            spaces: next,
                            space_scalars: 1,
                            span_scalars: 0,
                        };
                    } else if spaces.len() + ch.len_utf8() <= MAX_HELD_SPACE_BYTES {
                        spaces.push(ch);
                        self.state = SpaceState::PreSpace {
                            spaces,
                            space_scalars: space_scalars + 1,
                            span_scalars: 0,
                        };
                    } else {
                        record_copied(&spaces, out, map, clean_scalars);
                        record_copied_char(ch, out, map, clean_scalars);
                        self.state = SpaceState::SpaceOverflow;
                    }
                }
                SpaceState::InCluster {
                    pre_spaces,
                    pre_space_scalars,
                    cluster_scalars,
                    mut inter_spaces,
                    inter_space_scalars,
                    inter_span_scalars,
                } => {
                    if inter_span_scalars > 0 {
                        record_removed_count(
                            pre_space_scalars + cluster_scalars,
                            map,
                            *clean_scalars,
                        );
                        record_copied(&inter_spaces, out, map, clean_scalars);
                        record_removed_count(inter_span_scalars, map, *clean_scalars);
                        let mut next = String::with_capacity(4);
                        next.push(ch);
                        self.state = SpaceState::PreSpace {
                            spaces: next,
                            space_scalars: 1,
                            span_scalars: 0,
                        };
                    } else if inter_spaces.len() + ch.len_utf8() <= MAX_HELD_SPACE_BYTES {
                        inter_spaces.push(ch);
                        self.state = SpaceState::InCluster {
                            pre_spaces,
                            pre_space_scalars,
                            cluster_scalars,
                            inter_spaces,
                            inter_space_scalars: inter_space_scalars + 1,
                            inter_span_scalars: 0,
                        };
                    } else {
                        record_removed_count(
                            pre_space_scalars + cluster_scalars,
                            map,
                            *clean_scalars,
                        );
                        record_copied(&inter_spaces, out, map, clean_scalars);
                        record_copied_char(ch, out, map, clean_scalars);
                        self.state = SpaceState::SpaceOverflow;
                    }
                }
            }
            return;
        }

        let drop_trigger = ch == '\n' || ch == '\r' || is_trailing_punctuation(ch);
        self.flush_non_remove(drop_trigger, out, map, clean_scalars);
        record_copied_char(ch, out, map, clean_scalars);
        self.at_line_start = ch == '\n' || ch == '\r';
    }

    fn on_removed_marker(&mut self, marker_scalars: usize) {
        match std::mem::replace(&mut self.state, SpaceState::Idle) {
            SpaceState::Idle | SpaceState::SpaceOverflow => {
                self.state = SpaceState::InCluster {
                    pre_spaces: String::new(),
                    pre_space_scalars: 0,
                    cluster_scalars: marker_scalars,
                    inter_spaces: String::new(),
                    inter_space_scalars: 0,
                    inter_span_scalars: 0,
                };
            }
            SpaceState::PreSpace {
                spaces,
                space_scalars,
                span_scalars,
            } => {
                self.state = SpaceState::InCluster {
                    pre_spaces: spaces,
                    pre_space_scalars: space_scalars,
                    cluster_scalars: span_scalars + marker_scalars,
                    inter_spaces: String::new(),
                    inter_space_scalars: 0,
                    inter_span_scalars: 0,
                };
            }
            SpaceState::InCluster {
                pre_spaces,
                pre_space_scalars,
                cluster_scalars,
                mut inter_spaces,
                inter_space_scalars,
                inter_span_scalars,
            } => {
                inter_spaces.clear();
                self.state = SpaceState::InCluster {
                    pre_spaces,
                    pre_space_scalars,
                    cluster_scalars: cluster_scalars
                        + inter_space_scalars
                        + inter_span_scalars
                        + marker_scalars,
                    inter_spaces,
                    inter_space_scalars: 0,
                    inter_span_scalars: 0,
                };
            }
        }
    }

    fn flush_non_remove(
        &mut self,
        drop_trigger: bool,
        out: &mut Option<&mut String>,
        map: &mut Option<&mut Vec<u64>>,
        clean_scalars: &mut u64,
    ) {
        match std::mem::replace(&mut self.state, SpaceState::Idle) {
            SpaceState::Idle | SpaceState::SpaceOverflow => {}
            SpaceState::PreSpace {
                spaces,
                span_scalars,
                ..
            } => {
                record_copied(&spaces, out, map, clean_scalars);
                record_removed_count(span_scalars, map, *clean_scalars);
            }
            SpaceState::InCluster {
                pre_spaces,
                pre_space_scalars,
                cluster_scalars,
                inter_spaces,
                inter_span_scalars,
                ..
            } => {
                if !inter_spaces.is_empty() {
                    record_removed_count(pre_space_scalars + cluster_scalars, map, *clean_scalars);
                    record_copied(&inter_spaces, out, map, clean_scalars);
                    record_removed_count(inter_span_scalars, map, *clean_scalars);
                } else if drop_trigger {
                    record_removed_count(
                        pre_space_scalars + cluster_scalars + inter_span_scalars,
                        map,
                        *clean_scalars,
                    );
                } else {
                    record_copied(&pre_spaces, out, map, clean_scalars);
                    record_removed_count(cluster_scalars + inter_span_scalars, map, *clean_scalars);
                }
            }
        }
    }

    fn finish_into(
        &mut self,
        mut out: Option<&mut String>,
        mut map: Option<&mut Vec<u64>>,
        clean_scalars: &mut u64,
    ) {
        if let Some(m) = self.marker.take() {
            let tail = &m.buf[OPEN.len_utf8()..];
            if m.sep_seen || tail.is_empty() || is_ascii_tag(tail) {
                self.on_removed_marker(m.scalars);
            } else {
                self.flush_non_remove(false, &mut out, &mut map, clean_scalars);
                record_copied(&m.buf, &mut out, &mut map, clean_scalars);
                update_line_start(&mut self.at_line_start, &m.buf);
            }
        }
        self.flush_non_remove(true, &mut out, &mut map, clean_scalars);
    }
}

/// Build a `raw_scalar -> clean_scalar` table (length `raw_scalars + 1`) when
/// `text` contains OpenAI PUA markers. Returns `None` when `text` is clean.
pub(crate) fn raw_to_clean_scalar_map(text: &str) -> Option<Vec<u64>> {
    if !has_citation_markers(text) {
        return None;
    }
    let mut map = Vec::with_capacity(text.len() + 1);
    let mut sanitizer = StreamSanitizer::new();
    let mut clean_scalars = 0u64;
    sanitizer.feed_str(text, None, Some(&mut map), &mut clean_scalars);
    sanitizer.finish_into(None, Some(&mut map), &mut clean_scalars);
    map.push(clean_scalars);
    Some(map)
}

struct MarkerBuf {
    buf: String,
    sep_seen: bool,
    scalars: usize,
}

enum SpaceState {
    Idle,
    PreSpace {
        spaces: String,
        space_scalars: usize,
        span_scalars: usize,
    },
    SpaceOverflow,
    InCluster {
        pre_spaces: String,
        pre_space_scalars: usize,
        cluster_scalars: usize,
        inter_spaces: String,
        inter_space_scalars: usize,
        inter_span_scalars: usize,
    },
}

enum ClosedMarker {
    Remove,
    Replace(String),
}

fn is_ascii_tag(s: &str) -> bool {
    let mut bytes = s.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn is_ascii_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '-' | '.' | '/')
}

fn is_ascii_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(is_ascii_token_char)
}

fn is_horizontal_space(ch: char) -> bool {
    matches!(ch, ' ' | '\t')
}

fn is_span_delim(ch: char) -> bool {
    matches!(ch, SPAN_OPEN | SPAN_CLOSE)
}

fn is_trailing_punctuation(ch: char) -> bool {
    matches!(
        ch,
        ',' | '.'
            | ';'
            | ':'
            | '!'
            | '?'
            | ')'
            | ']'
            | '}'
            | '，'
            | '。'
            | '；'
            | '：'
            | '！'
            | '？'
            | '、'
            | '）'
            | '】'
            | '》'
            | '」'
            | '』'
            | '”'
            | '’'
    )
}

fn update_line_start(at_line_start: &mut bool, slice: &str) {
    for ch in slice.chars() {
        if ch == '\n' || ch == '\r' {
            *at_line_start = true;
        } else if !is_horizontal_space(ch) {
            *at_line_start = false;
        }
    }
}

fn extract_entity_display(payload: &str) -> Option<String> {
    let json_slice = payload.split(SEP).next().unwrap_or(payload);
    let value: serde_json::Value = serde_json::from_str(json_slice).ok()?;
    let display = value.as_array()?.get(1)?.as_str()?;
    (!display.is_empty()).then(|| display.to_owned())
}

fn classify_closed_body(body: &str) -> Option<ClosedMarker> {
    if let Some((tag, payload)) = body.split_once(SEP) {
        if !is_ascii_tag(tag) {
            return None;
        }
        if tag == "entity"
            && let Some(display) = extract_entity_display(payload)
        {
            return Some(ClosedMarker::Replace(display));
        }
        return Some(ClosedMarker::Remove);
    }
    is_ascii_token(body).then_some(ClosedMarker::Remove)
}

fn record_copied(
    slice: &str,
    out: &mut Option<&mut String>,
    map: &mut Option<&mut Vec<u64>>,
    clean_scalars: &mut u64,
) {
    if let Some(out) = out.as_deref_mut() {
        out.push_str(slice);
    }
    if let Some(map) = map.as_deref_mut() {
        for _ in slice.chars() {
            map.push(*clean_scalars);
            *clean_scalars += 1;
        }
    }
}

fn record_copied_char(
    ch: char,
    out: &mut Option<&mut String>,
    map: &mut Option<&mut Vec<u64>>,
    clean_scalars: &mut u64,
) {
    if let Some(out) = out.as_deref_mut() {
        out.push(ch);
    }
    if let Some(map) = map.as_deref_mut() {
        map.push(*clean_scalars);
        *clean_scalars += 1;
    }
}

fn record_removed_count(count: usize, map: &mut Option<&mut Vec<u64>>, clean_scalars: u64) {
    if let Some(map) = map.as_deref_mut() {
        map.resize(map.len() + count, clean_scalars);
    }
}

fn record_replaced(
    raw_scalars: usize,
    display: &str,
    out: &mut Option<&mut String>,
    map: &mut Option<&mut Vec<u64>>,
    clean_scalars: &mut u64,
) {
    if let Some(out) = out.as_deref_mut() {
        out.push_str(display);
    }
    if let Some(map) = map.as_deref_mut() {
        let start = *clean_scalars;
        *clean_scalars += display.chars().count() as u64;
        if raw_scalars > 0 {
            map.push(start);
            map.resize(map.len() + raw_scalars - 1, *clean_scalars);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip_batch(text: &str) -> String {
        let mut s = StreamSanitizer::new();
        let mut out = s.push(text);
        out.push_str(&s.finish());
        out
    }

    fn strip_char_by_char(text: &str) -> String {
        let mut s = StreamSanitizer::new();
        let mut out = String::new();
        for ch in text.chars() {
            let mut buf = [0u8; 4];
            out.push_str(&s.push(ch.encode_utf8(&mut buf)));
        }
        out.push_str(&s.finish());
        out
    }

    #[test]
    fn streaming_matches_batch_across_every_char_boundary() {
        let overflow_spaces = format!(
            "Hello{} \u{E200}cite\u{E202}turn0search0\u{E201}.",
            " ".repeat(70)
        );
        let overflow_spaces_expected = format!("Hello{} .", " ".repeat(70));
        let oversized_marker = format!(
            "Start \u{E200}cite\u{E202}{}\u{E201} end",
            "x".repeat(MAX_MARKER_BYTES + 16)
        );
        let cases = [
            (
                "定位到了。 \u{E200}cite\u{E202}turn137145search0\u{E201}",
                "定位到了。",
            ),
            (
                "已定位根因：\u{E200}entity\u{E202}[\"software\",\"QEMU\",\"emulator\"]\u{E201} 在 AMD 宿主上开启 `hv_passthrough` 时会触发 \u{E203}STIMER0 re-arm loop\u{E204} 死锁 \u{E200}cite\u{E202}turn137145search0\u{E201} \u{E200}cite\u{E202}turn903513view0\u{E201}，导致重启卡死。",
                "已定位根因：QEMU 在 AMD 宿主上开启 `hv_passthrough` 时会触发 STIMER0 re-arm loop 死锁，导致重启卡死。",
            ),
            (
                "Hello \u{E200}cite\u{E202}turn0search0\u{E201} world and \u{E200}cite\u{E202}turn0search1\u{E201}next.",
                "Hello world and next.",
            ),
            (
                "  indented  \n    code \u{E200}cite\u{E202}turn0search0\u{E201}\n  - item",
                "  indented  \n    code\n  - item",
            ),
            (
                "Truncated tail \u{E200}cite\u{E202}turn0search",
                "Truncated tail",
            ),
            ("Truncated tag \u{E200}cite", "Truncated tag"),
            ("Truncated open \u{E200}", "Truncated open"),
            (
                "Literal \u{E200}not a marker\nnext",
                "Literal \u{E200}not a marker\nnext",
            ),
            ("Literal \u{E200}123", "Literal \u{E200}123"),
            (
                "Keep space \u{E200}cite\u{E202}turn0search0\u{E201}*.rs in command",
                "Keep space *.rs in command",
            ),
            (&overflow_spaces, &overflow_spaces_expected),
            (&oversized_marker, &oversized_marker),
        ];

        for (raw, expected) in cases {
            assert_eq!(strip_batch(raw), expected, "batch: {raw:?}");
            assert_eq!(strip_char_by_char(raw), expected, "streaming: {raw:?}");
            if let Some(map) = raw_to_clean_scalar_map(raw) {
                assert_eq!(map.len(), raw.chars().count() + 1);
                assert_eq!(*map.last().unwrap() as usize, expected.chars().count());
            }
        }
    }

    #[test]
    fn scalar_map_tracks_entities_spans_and_collapsed_markers() {
        let raw = "See \u{E200}entity\u{E202}[\"software\",\"QEMU\"]\u{E201} \u{E200}cite\u{E202}turn0search0\u{E201}.";
        let map = raw_to_clean_scalar_map(raw).expect("contains markers");
        let raw_len = raw.chars().count();
        assert_eq!(map.len(), raw_len + 1);
        assert_eq!(strip_batch(raw), "See QEMU.");
        assert_eq!((map[0], map[4]), (0, 4));
        let entity_end = raw.find('\u{E201}').unwrap() + '\u{E201}'.len_utf8();
        let entity_end_scalar = raw[..entity_end].chars().count();
        assert_eq!((map[4], map[entity_end_scalar]), (4, 8));
        assert_eq!((map[entity_end_scalar + 1], map[raw_len - 1]), (8, 8));
        assert_eq!(map[raw_len], 9);
    }

    #[test]
    fn consecutive_removed_markers_discard_immediately_without_allocations() {
        let mut s = StreamSanitizer::new();
        assert_eq!(s.push("OK"), "OK");
        let mut total_capacity = 0usize;
        for i in 0..256 {
            let out = s.push(&format!(" \u{E200}cite\u{E202}turn0search{i}\u{E201}"));
            assert!(out.is_empty());
            total_capacity += out.capacity();
        }
        assert_eq!(total_capacity, 0);
        assert_eq!(s.push("."), ".");
        assert_eq!(s.finish(), "");
    }
}
