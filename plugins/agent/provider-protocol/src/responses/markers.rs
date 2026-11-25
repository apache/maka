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

//! Streaming sanitizer and scalar offset mapper for OpenAI Responses / Codex
//! Private Use Area inline citation and entity markers (`U+E200`..`U+E204`).

const OPEN: char = '\u{E200}';
const CLOSE: char = '\u{E201}';
const SEP: char = '\u{E202}';
const SPAN_OPEN: char = '\u{E203}';
const SPAN_CLOSE: char = '\u{E204}';

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

/// Incremental PUA marker sanitizer for streamed `output_text` deltas.
///
/// Output concatenated across arbitrary UTF-8 chunk boundaries matches batch
/// sanitization byte-for-byte.
pub(crate) struct StreamSanitizer {
    pending: String,
    at_line_start: bool,
}

impl StreamSanitizer {
    pub(crate) fn new() -> Self {
        Self {
            pending: String::new(),
            at_line_start: true,
        }
    }

    pub(crate) fn push(&mut self, chunk: &str) -> String {
        if chunk.is_empty() {
            return String::new();
        }
        if self.pending.is_empty() && !has_citation_markers(chunk) && !chunk.ends_with([' ', '\t'])
        {
            update_line_start(&mut self.at_line_start, chunk);
            return chunk.to_owned();
        }
        self.pending.push_str(chunk);
        let mut out = String::with_capacity(self.pending.len());
        let mut clean_scalars = 0u64;
        let consumed = drain(
            &self.pending,
            &mut self.at_line_start,
            false,
            &mut out,
            None,
            &mut clean_scalars,
        );
        self.pending.drain(..consumed);
        out
    }

    pub(crate) fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let mut out = String::with_capacity(self.pending.len());
        let mut clean_scalars = 0u64;
        let consumed = drain(
            &self.pending,
            &mut self.at_line_start,
            true,
            &mut out,
            None,
            &mut clean_scalars,
        );
        debug_assert_eq!(consumed, self.pending.len());
        self.pending.clear();
        out
    }
}

/// Build a `raw_scalar -> clean_scalar` table (length `raw_scalars + 1`) when
/// `text` contains OpenAI PUA markers. Returns `None` when `text` is clean.
pub(crate) fn raw_to_clean_scalar_map(text: &str) -> Option<Vec<u64>> {
    if !has_citation_markers(text) {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len() + 1);
    let mut at_line_start = true;
    let mut clean_scalars = 0u64;
    let consumed = drain(
        text,
        &mut at_line_start,
        true,
        &mut out,
        Some(&mut map),
        &mut clean_scalars,
    );
    debug_assert_eq!(consumed, text.len());
    map.push(clean_scalars);
    Some(map)
}

enum Marker {
    Remove { end: usize },
    Replace { end: usize, text: String },
}

enum MarkerParse {
    Complete(Marker),
    Incomplete,
    Invalid,
}

fn is_ascii_tag(s: &str) -> bool {
    let mut bytes = s.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn is_ascii_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-' | b'.' | b'/'))
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

fn classify_closed_body(body: &str, end: usize) -> MarkerParse {
    if let Some((tag, payload)) = body.split_once(SEP) {
        if !is_ascii_tag(tag) {
            return MarkerParse::Invalid;
        }
        if tag == "entity"
            && let Some(display) = extract_entity_display(payload)
        {
            return MarkerParse::Complete(Marker::Replace { end, text: display });
        }
        return MarkerParse::Complete(Marker::Remove { end });
    }
    if is_ascii_token(body) {
        MarkerParse::Complete(Marker::Remove { end })
    } else {
        MarkerParse::Invalid
    }
}

fn parse_marker(text: &str, start: usize, eof: bool) -> MarkerParse {
    let Some(rest) = text.get(start..) else {
        return MarkerParse::Invalid;
    };
    if !rest.starts_with(OPEN) {
        return MarkerParse::Invalid;
    }
    let after_open = start + OPEN.len_utf8();
    let tail = &text[after_open..];
    for (rel, ch) in tail.char_indices() {
        match ch {
            CLOSE => {
                let body = &tail[..rel];
                let end = after_open + rel + CLOSE.len_utf8();
                return classify_closed_body(body, end);
            }
            OPEN | '\n' | '\r' => return MarkerParse::Invalid,
            _ => {}
        }
    }
    if !eof {
        let valid_prefix = match tail.split_once(SEP) {
            Some((tag, _)) => is_ascii_tag(tag),
            None => tail.is_empty() || is_ascii_token(tail),
        };
        return if valid_prefix {
            MarkerParse::Incomplete
        } else {
            MarkerParse::Invalid
        };
    }
    if tail
        .split_once(SEP)
        .is_some_and(|(tag, _)| is_ascii_tag(tag))
    {
        MarkerParse::Complete(Marker::Remove { end: text.len() })
    } else {
        MarkerParse::Invalid
    }
}

fn skip_horizontal_space(text: &str, mut pos: usize) -> usize {
    while let Some(ch) = text[pos..].chars().next() {
        if is_horizontal_space(ch) {
            pos += ch.len_utf8();
        } else {
            break;
        }
    }
    pos
}

fn skip_span_delims(text: &str, mut pos: usize) -> usize {
    while let Some(ch) = text[pos..].chars().next() {
        if is_span_delim(ch) {
            pos += ch.len_utf8();
        } else {
            break;
        }
    }
    pos
}

/// Extend a confirmed `Marker::Remove` ending at `end` across any immediately
/// following removed markers separated only by horizontal spaces or span delims.
/// Returns `None` when streaming needs more bytes to determine the cluster end.
fn extend_removed_cluster(text: &str, mut end: usize, eof: bool) -> Option<usize> {
    loop {
        let after_d1 = skip_span_delims(text, end);
        if !eof && after_d1 == text.len() {
            return None;
        }
        match parse_marker(text, after_d1, eof) {
            MarkerParse::Complete(Marker::Remove { end: next_end }) => {
                end = next_end;
                continue;
            }
            MarkerParse::Incomplete => return None,
            _ => {}
        }
        let after_sp = skip_horizontal_space(text, after_d1);
        if after_sp > after_d1 {
            let after_d2 = skip_span_delims(text, after_sp);
            if !eof && after_d2 == text.len() {
                return None;
            }
            match parse_marker(text, after_d2, eof) {
                MarkerParse::Complete(Marker::Remove { end: next_end }) => {
                    end = next_end;
                    continue;
                }
                MarkerParse::Incomplete => return None,
                _ => {}
            }
        }
        return Some(end);
    }
}

fn record_copied(
    slice: &str,
    out: &mut String,
    map: &mut Option<&mut Vec<u64>>,
    clean_scalars: &mut u64,
) {
    out.push_str(slice);
    if let Some(map) = map.as_deref_mut() {
        for _ in slice.chars() {
            map.push(*clean_scalars);
            *clean_scalars += 1;
        }
    }
}

fn record_removed(slice: &str, map: &mut Option<&mut Vec<u64>>, clean_scalars: u64) {
    if let Some(map) = map.as_deref_mut() {
        for _ in slice.chars() {
            map.push(clean_scalars);
        }
    }
}

fn record_replaced(
    raw_slice: &str,
    display: &str,
    out: &mut String,
    map: &mut Option<&mut Vec<u64>>,
    clean_scalars: &mut u64,
) {
    out.push_str(display);
    if let Some(map) = map.as_deref_mut() {
        let start = *clean_scalars;
        *clean_scalars += display.chars().count() as u64;
        let mut chars = raw_slice.chars();
        if chars.next().is_some() {
            map.push(start);
            for _ in chars {
                map.push(*clean_scalars);
            }
        }
    }
}

fn drain(
    text: &str,
    at_line_start: &mut bool,
    eof: bool,
    out: &mut String,
    mut map: Option<&mut Vec<u64>>,
    clean_scalars: &mut u64,
) -> usize {
    let mut pos = 0;
    while pos < text.len() {
        let ch = text[pos..].chars().next().expect("valid char boundary");
        if is_span_delim(ch) {
            let next = pos + ch.len_utf8();
            record_removed(&text[pos..next], &mut map, *clean_scalars);
            pos = next;
            continue;
        }

        if ch == OPEN {
            match parse_marker(text, pos, eof) {
                MarkerParse::Incomplete => break,
                MarkerParse::Complete(Marker::Replace { end, text: display }) => {
                    record_replaced(&text[pos..end], &display, out, &mut map, clean_scalars);
                    if display.chars().any(|c| !is_horizontal_space(c)) {
                        *at_line_start = display.ends_with('\n') || display.ends_with('\r');
                    }
                    pos = end;
                    continue;
                }
                MarkerParse::Complete(Marker::Remove { end }) => {
                    let Some(cluster_end) = extend_removed_cluster(text, end, eof) else {
                        break;
                    };
                    record_removed(&text[pos..cluster_end], &mut map, *clean_scalars);
                    pos = cluster_end;
                    continue;
                }
                MarkerParse::Invalid => {
                    let next = pos + OPEN.len_utf8();
                    record_copied(&text[pos..next], out, &mut map, clean_scalars);
                    *at_line_start = false;
                    pos = next;
                    continue;
                }
            }
        }

        if is_horizontal_space(ch) && !*at_line_start {
            let space_end = skip_horizontal_space(text, pos);
            let after_delims = skip_span_delims(text, space_end);
            if !eof && after_delims == text.len() {
                break;
            }
            match parse_marker(text, after_delims, eof) {
                MarkerParse::Incomplete => break,
                MarkerParse::Complete(Marker::Remove { end }) => {
                    let Some(cluster_end) = extend_removed_cluster(text, end, eof) else {
                        break;
                    };
                    let after_cluster = skip_span_delims(text, cluster_end);
                    if !eof && after_cluster == text.len() {
                        break;
                    }
                    let drop_pre_space = match text[after_cluster..].chars().next() {
                        None => true,
                        Some(c) => {
                            c == '\n'
                                || c == '\r'
                                || is_horizontal_space(c)
                                || is_trailing_punctuation(c)
                        }
                    };
                    if drop_pre_space {
                        record_removed(&text[pos..cluster_end], &mut map, *clean_scalars);
                    } else {
                        record_copied(&text[pos..space_end], out, &mut map, clean_scalars);
                        record_removed(&text[space_end..cluster_end], &mut map, *clean_scalars);
                    }
                    pos = cluster_end;
                    continue;
                }
                _ => {
                    record_copied(&text[pos..space_end], out, &mut map, clean_scalars);
                    pos = space_end;
                    continue;
                }
            }
        }

        let run_start = pos;
        loop {
            let c = text[pos..].chars().next().expect("valid char boundary");
            if c == '\n' || c == '\r' {
                *at_line_start = true;
            } else if !is_horizontal_space(c) {
                *at_line_start = false;
            }
            pos += c.len_utf8();
            let Some(next) = text[pos..].chars().next() else {
                break;
            };
            if is_span_delim(next) || next == OPEN || (is_horizontal_space(next) && !*at_line_start)
            {
                break;
            }
        }
        record_copied(&text[run_start..pos], out, &mut map, clean_scalars);
    }
    pos
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
            (
                "Literal \u{E200}not a marker\nnext",
                "Literal \u{E200}not a marker\nnext",
            ),
            (
                "Keep space \u{E200}cite\u{E202}turn0search0\u{E201}*.rs in command",
                "Keep space *.rs in command",
            ),
        ];

        for (raw, expected) in cases {
            assert_eq!(strip_batch(raw), expected, "batch: {raw:?}");
            assert_eq!(strip_char_by_char(raw), expected, "streaming: {raw:?}");
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
    fn streaming_withholds_incomplete_marker_until_closed() {
        let mut s = StreamSanitizer::new();
        assert_eq!(s.push("Answer \u{E200}ci"), "Answer");
        assert_eq!(s.push("te\u{E202}turn0search0\u{E201}"), "");
        assert_eq!(s.push("."), ".");
        assert_eq!(s.finish(), "");
    }
}
