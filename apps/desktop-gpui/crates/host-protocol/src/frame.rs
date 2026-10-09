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

//! Newline-delimited JSON framing for the local IPC transport.
//!
//! Source: `packages/runtime-host/src/transport/local-ipc-framing.ts`
//! (`frameLocalIpcProtocolMessage`, `LocalIpcProtocolFrameDecoder`) and
//! `encodeProtocolMessage` in `protocol/index.ts`.
//!
//! One frame is one compact JSON document followed by `\n`. The decoder splits
//! on `0x0a`, strips one trailing `0x0d`, enforces [`MAX_MESSAGE_BYTES`] while
//! bytes accumulate, and requires strict UTF-8.

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use crate::MAX_MESSAGE_BYTES;

/// A framing failure. Every variant except [`FrameError::Encode`] means the
/// byte stream can no longer be trusted and the connection must be dropped.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum FrameError {
    /// A message exceeds [`MAX_MESSAGE_BYTES`] (TS code `frame_too_large`).
    #[error("Runtime Host message exceeds the {MAX_MESSAGE_BYTES}-byte limit")]
    TooLarge,
    /// A delimiter arrived with no bytes before it (TS code `invalid_frame`).
    #[error("Runtime Host frame is empty")]
    Empty,
    /// The stream ended inside a frame (TS code `invalid_frame`).
    #[error("Runtime Host stream ended with a partial frame")]
    PartialFrame,
    /// A frame is not valid UTF-8 (TS code `invalid_utf8`).
    #[error("Runtime Host frame is not valid UTF-8")]
    InvalidUtf8,
    /// A frame is not valid JSON (TS code `invalid_json`).
    #[error("Runtime Host frame is not valid JSON")]
    InvalidJson(#[source] serde_json::Error),
    /// A value could not be serialized.
    #[error("failed to encode a Runtime Host frame")]
    Encode(#[source] serde_json::Error),
}

/// Encodes `value` as compact JSON followed by `\n`.
///
/// Fails with [`FrameError::TooLarge`] when the JSON (without the delimiter)
/// exceeds [`MAX_MESSAGE_BYTES`], matching `encodeProtocolMessage`.
pub fn encode_frame<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, FrameError> {
    let mut bytes = serde_json::to_vec(value).map_err(FrameError::Encode)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(FrameError::TooLarge);
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// Parses the text of one decoded frame.
///
/// The Host encodes frames with `JSON.stringify`, which writes an unpaired
/// UTF-16 surrogate as a `\uD8XX`–`\uDFXX` escape, and the TS client's
/// `JSON.parse` accepts it. The Host produces one whenever it cuts a string by
/// UTF-16 length inside an astral character (`withinWireLimit` in
/// `packages/core/src/model-catalog.ts`). serde_json rejects such an escape, so
/// each unpaired surrogate escape is replaced with `\uFFFD` (U+FFFD) before
/// parsing; a valid high/low pair is left alone. The replacement has the same
/// length, so the size limit, which [`FrameDecoder`] enforces on the raw bytes,
/// means the same thing.
pub fn decode_frame_json(text: &str) -> Result<Value, FrameError> {
    match replace_unpaired_surrogate_escapes(text) {
        Some(repaired) => serde_json::from_str(&repaired),
        None => serde_json::from_str(text),
    }
    .map_err(FrameError::InvalidJson)
}

/// The escape written in place of an unpaired surrogate escape. It is six
/// bytes, like the escape it replaces.
const REPLACEMENT_ESCAPE: &[u8; 6] = b"\\uFFFD";

/// Returns `text` with every unpaired `\uD800`–`\uDFFF` escape replaced by
/// [`REPLACEMENT_ESCAPE`], or `None` when it has none. Escapes are recognized
/// by scanning from each backslash, so `\\ud83d` (an escaped backslash
/// followed by the letters `ud83d`) is not mistaken for an escape. Only string
/// literals contain backslashes in valid JSON; in invalid JSON the result
/// fails to parse either way.
fn replace_unpaired_surrogate_escapes(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut repaired: Option<Vec<u8>> = None;
    let mut index = 0;
    while let Some(offset) = bytes[index..].iter().position(|&byte| byte == b'\\') {
        let escape = index + offset;
        let Some(unit) = unicode_escape_at(bytes, escape) else {
            // A two-byte escape such as `\\` or `\"`; skip both bytes so an
            // escaped backslash never starts another escape. A backslash that
            // ends the text is left for the parser to reject.
            index = (escape + 2).min(bytes.len());
            continue;
        };
        index = escape + 6;
        match unit {
            0xD800..=0xDBFF => {
                if matches!(unicode_escape_at(bytes, index), Some(0xDC00..=0xDFFF)) {
                    index += 6;
                    continue;
                }
            }
            0xDC00..=0xDFFF => {}
            _ => continue,
        }
        repaired.get_or_insert_with(|| bytes.to_vec())[escape..escape + 6]
            .copy_from_slice(REPLACEMENT_ESCAPE);
    }
    // Only ASCII bytes of complete escapes were replaced with ASCII bytes.
    repaired.map(|bytes| String::from_utf8(bytes).expect("an ASCII-for-ASCII replacement"))
}

/// The UTF-16 code unit of the `\uXXXX` escape starting at `at`, if one does.
fn unicode_escape_at(bytes: &[u8], at: usize) -> Option<u16> {
    let escape = bytes.get(at..at + 6)?;
    if escape[0] != b'\\' || escape[1] != b'u' {
        return None;
    }
    let digits = std::str::from_utf8(&escape[2..]).ok()?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(digits, 16).ok()
}

/// Incremental frame splitter. Feed it transport chunks in arrival order.
///
/// After any error the decoder state is unspecified; drop the connection.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    pending: Vec<u8>,
}

impl FrameDecoder {
    /// Creates an empty decoder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Consumes one chunk and returns the text of every frame it completes.
    ///
    /// The returned text is validated UTF-8 with the trailing `\r` removed; it
    /// has not been parsed as JSON yet (see [`decode_frame_json`]).
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, FrameError> {
        let mut frames = Vec::new();
        let mut rest = chunk;
        loop {
            let newline = rest.iter().position(|&byte| byte == b'\n');
            let segment = &rest[..newline.unwrap_or(rest.len())];
            // The limit covers everything before the delimiter, including a
            // trailing `\r`, exactly as the TS decoder counts it.
            if self.pending.len() + segment.len() > MAX_MESSAGE_BYTES {
                return Err(FrameError::TooLarge);
            }
            self.pending.extend_from_slice(segment);
            let Some(newline) = newline else {
                break;
            };
            frames.push(self.take_frame()?);
            rest = &rest[newline + 1..];
            if rest.is_empty() {
                break;
            }
        }
        Ok(frames)
    }

    /// Checks the end of the stream. Fails if a frame was left incomplete.
    pub fn finish(&self) -> Result<(), FrameError> {
        if self.pending.is_empty() { Ok(()) } else { Err(FrameError::PartialFrame) }
    }

    /// Whether bytes of an incomplete frame are buffered.
    pub fn has_partial_frame(&self) -> bool {
        !self.pending.is_empty()
    }

    fn take_frame(&mut self) -> Result<String, FrameError> {
        if self.pending.is_empty() {
            return Err(FrameError::Empty);
        }
        let mut bytes = std::mem::take(&mut self.pending);
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        String::from_utf8(bytes).map_err(|_| FrameError::InvalidUtf8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decode_all(decoder: &mut FrameDecoder, chunks: &[&[u8]]) -> Vec<String> {
        chunks.iter().flat_map(|chunk| decoder.push(chunk).expect("valid chunk")).collect()
    }

    #[test]
    fn encode_appends_newline_to_compact_json() {
        let bytes = encode_frame(&json!({"kind": "hello", "n": 1})).expect("encode");
        assert_eq!(bytes, b"{\"kind\":\"hello\",\"n\":1}\n");
    }

    #[test]
    fn encode_rejects_oversize_messages() {
        let text = "x".repeat(MAX_MESSAGE_BYTES);
        assert!(matches!(encode_frame(&text), Err(FrameError::TooLarge)));
    }

    #[test]
    fn encode_accepts_a_message_at_the_limit() {
        // A JSON string adds two quote bytes.
        let text = "x".repeat(MAX_MESSAGE_BYTES - 2);
        let bytes = encode_frame(&text).expect("at limit");
        assert_eq!(bytes.len(), MAX_MESSAGE_BYTES + 1);
    }

    #[test]
    fn partial_chunks_join_into_one_frame() {
        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(b"{\"a\":").expect("chunk").is_empty());
        assert!(decoder.has_partial_frame());
        assert!(decoder.push(b"1").expect("chunk").is_empty());
        assert_eq!(decoder.push(b"}\n").expect("chunk"), vec!["{\"a\":1}"]);
        assert!(!decoder.has_partial_frame());
        decoder.finish().expect("clean end");
    }

    #[test]
    fn multiple_frames_in_one_chunk() {
        let mut decoder = FrameDecoder::new();
        let frames = decoder.push(b"{\"a\":1}\n{\"b\":2}\n{\"c\"").expect("chunk");
        assert_eq!(frames, vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(decoder.push(b":3}\n").expect("chunk"), vec!["{\"c\":3}"]);
    }

    #[test]
    fn crlf_delimiter_is_stripped() {
        let mut decoder = FrameDecoder::new();
        let frames = decode_all(&mut decoder, &[b"{\"a\":1}\r\n", b"{\"b\":2}\r", b"\n"]);
        assert_eq!(frames, vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn only_one_trailing_carriage_return_is_stripped() {
        let mut decoder = FrameDecoder::new();
        let frames = decoder.push(b"1\r\r\n").expect("chunk");
        assert_eq!(frames, vec!["1\r"]);
    }

    #[test]
    fn multibyte_characters_split_across_chunks() {
        let text = "{\"name\":\"中文\"}\n".as_bytes();
        let mut decoder = FrameDecoder::new();
        let (left, right) = text.split_at(11);
        let frames = decode_all(&mut decoder, &[left, right]);
        assert_eq!(frames, vec!["{\"name\":\"中文\"}"]);
    }

    #[test]
    fn oversize_frame_in_one_chunk_is_rejected() {
        let mut decoder = FrameDecoder::new();
        let chunk = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        assert!(matches!(decoder.push(&chunk), Err(FrameError::TooLarge)));
    }

    #[test]
    fn oversize_frame_across_chunks_is_rejected_before_the_delimiter() {
        let mut decoder = FrameDecoder::new();
        let half = vec![b'x'; MAX_MESSAGE_BYTES / 2];
        decoder.push(&half).expect("first half");
        decoder.push(&half).expect("second half reaches the limit exactly");
        assert!(matches!(decoder.push(b"x"), Err(FrameError::TooLarge)));
    }

    #[test]
    fn frame_at_the_limit_is_accepted() {
        let mut decoder = FrameDecoder::new();
        let mut chunk = vec![b'1'; MAX_MESSAGE_BYTES];
        chunk.push(b'\n');
        let frames = decoder.push(&chunk).expect("at limit");
        assert_eq!(frames[0].len(), MAX_MESSAGE_BYTES);
    }

    #[test]
    fn carriage_return_counts_toward_the_limit() {
        let mut decoder = FrameDecoder::new();
        let mut chunk = vec![b'1'; MAX_MESSAGE_BYTES];
        chunk.extend_from_slice(b"\r\n");
        assert!(matches!(decoder.push(&chunk), Err(FrameError::TooLarge)));
    }

    #[test]
    fn empty_frame_is_rejected() {
        let mut decoder = FrameDecoder::new();
        assert!(matches!(decoder.push(b"\n"), Err(FrameError::Empty)));
        let mut decoder = FrameDecoder::new();
        assert!(matches!(decoder.push(b"{}\n\n"), Err(FrameError::Empty)));
    }

    #[test]
    fn carriage_return_only_frame_fails_as_json() {
        let mut decoder = FrameDecoder::new();
        let frames = decoder.push(b"\r\n").expect("framing accepts it");
        assert_eq!(frames, vec![""]);
        assert!(matches!(decode_frame_json(&frames[0]), Err(FrameError::InvalidJson(_))));
    }

    #[test]
    fn invalid_utf8_is_rejected() {
        let mut decoder = FrameDecoder::new();
        assert!(matches!(decoder.push(b"\"\xff\"\n"), Err(FrameError::InvalidUtf8)));
    }

    #[test]
    fn stream_end_inside_a_frame_is_rejected() {
        let mut decoder = FrameDecoder::new();
        decoder.push(b"{\"a\"").expect("chunk");
        assert!(matches!(decoder.finish(), Err(FrameError::PartialFrame)));
    }

    #[test]
    fn invalid_json_is_reported_by_decode_frame_json() {
        assert!(matches!(decode_frame_json("{not json"), Err(FrameError::InvalidJson(_))));
        assert_eq!(decode_frame_json("{\"a\":1}").expect("json"), json!({"a": 1}));
    }

    #[test]
    fn an_unpaired_high_surrogate_escape_becomes_the_replacement_character() {
        let value = decode_frame_json(r#"{"name":"cut \ud83d here"}"#).expect("json");
        assert_eq!(value, json!({"name": "cut \u{FFFD} here"}));
    }

    #[test]
    fn an_unpaired_low_surrogate_escape_becomes_the_replacement_character() {
        let value = decode_frame_json(r#"{"name":"\uDE00 tail"}"#).expect("json");
        assert_eq!(value, json!({"name": "\u{FFFD} tail"}));
    }

    #[test]
    fn a_surrogate_escape_at_the_end_of_a_string_or_frame_is_replaced() {
        let value = decode_frame_json(r#"{"a":"end\ud83d","b":"\udc00"}"#).expect("json");
        assert_eq!(value, json!({"a": "end\u{FFFD}", "b": "\u{FFFD}"}));
        // A high surrogate cut off by the end of the text is not a pair; the
        // text still fails as JSON because the string is unterminated.
        assert!(matches!(decode_frame_json(r#""\ud83d"#), Err(FrameError::InvalidJson(_))));
        assert_eq!(decode_frame_json(r#""\ud83d""#).expect("json"), json!("\u{FFFD}"));
    }

    #[test]
    fn a_valid_surrogate_pair_escape_is_kept() {
        let value = decode_frame_json(r#"{"name":"\ud83d\ude00 \uD83D\uDE00"}"#).expect("json");
        assert_eq!(value, json!({"name": "😀 😀"}));
    }

    #[test]
    fn a_high_surrogate_followed_by_another_high_surrogate_keeps_the_later_pair() {
        let value = decode_frame_json(r#""\ud83d\ud83d\ude00""#).expect("json");
        assert_eq!(value, json!("\u{FFFD}😀"));
        let value = decode_frame_json(r#""\ude00\ud83d""#).expect("json");
        assert_eq!(value, json!("\u{FFFD}\u{FFFD}"));
    }

    #[test]
    fn an_escaped_backslash_before_u_is_not_a_surrogate_escape() {
        let value = decode_frame_json(r#""\\ud83d \\\ud83d""#).expect("json");
        assert_eq!(value, json!("\\ud83d \\\u{FFFD}"));
    }

    #[test]
    fn replacing_surrogate_escapes_keeps_the_frame_length() {
        let text = r#"{"a":"\ud83d"}"#;
        let repaired = replace_unpaired_surrogate_escapes(text).expect("repaired");
        assert_eq!(repaired.len(), text.len());
        assert_eq!(repaired, r#"{"a":"\uFFFD"}"#);
        assert!(replace_unpaired_surrogate_escapes(r#"{"a":"\u00e9\ud83d\ude00"}"#).is_none());
        assert!(replace_unpaired_surrogate_escapes("\"ends with \\").is_none());
    }

    #[test]
    fn encoded_frames_decode_back() {
        let value = json!({"requestId": "r1", "operation": "host.status", "input": {}});
        let bytes = encode_frame(&value).expect("encode");
        let mut decoder = FrameDecoder::new();
        let frames = decoder.push(&bytes).expect("decode");
        assert_eq!(decode_frame_json(&frames[0]).expect("json"), value);
    }
}
