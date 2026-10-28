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

//! Constant-space transforms over caller-owned input and output slices.
use base64::engine::general_purpose::STANDARD;
use std::io;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Progress {
    pub consumed: usize,
    pub written: usize,
    pub finished: bool,
}
pub trait Transform {
    /// Preserve unconsumed input. `eof` applies after the supplied input.
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress>;
}
#[derive(Debug, Default)]
struct Pending {
    bytes: [u8; 6],
    offset: usize,
    len: usize,
}
impl Pending {
    fn set(&mut self, bytes: &[u8]) {
        self.bytes[..bytes.len()].copy_from_slice(bytes);
        self.offset = 0;
        self.len = bytes.len();
    }
    fn drain(&mut self, output: &mut [u8]) -> usize {
        let count = (self.len - self.offset).min(output.len());
        output[..count].copy_from_slice(&self.bytes[self.offset..self.offset + count]);
        self.offset += count;
        count
    }
    fn empty(&self) -> bool {
        self.offset == self.len
    }
}
/// JSON string content, without surrounding quotes; also quotes inner JSON bytes.
#[derive(Debug, Default)]
pub struct JsonEscape {
    pending: Pending,
}
impl JsonEscape {
    pub fn new() -> Self {
        Self::default()
    }
}
impl Transform for JsonEscape {
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress> {
        let mut p = Progress::default();
        loop {
            p.written += self.pending.drain(&mut output[p.written..]);
            if !self.pending.empty() || p.written == output.len() {
                break;
            }
            let Some(&b) = input.get(p.consumed) else {
                break;
            };
            p.consumed += 1;
            match b {
                b'"' => self.pending.set(b"\\\""),
                b'\\' => self.pending.set(b"\\\\"),
                b'\n' => self.pending.set(b"\\n"),
                b'\r' => self.pending.set(b"\\r"),
                b'\t' => self.pending.set(b"\\t"),
                8 => self.pending.set(b"\\b"),
                12 => self.pending.set(b"\\f"),
                0..=31 => {
                    const HEX: &[u8; 16] = b"0123456789abcdef";
                    self.pending.set(&[
                        b'\\',
                        b'u',
                        b'0',
                        b'0',
                        HEX[usize::from(b >> 4)],
                        HEX[usize::from(b & 15)],
                    ]);
                }
                _ => self.pending.set(&[b]),
            }
        }
        p.finished = eof && p.consumed == input.len() && self.pending.empty();
        Ok(p)
    }
}
#[derive(Clone, Copy, Debug, Default)]
enum State {
    #[default]
    Start,
    Text,
    Escape,
    Unicode {
        value: u16,
        digits: u8,
    },
    LowSlash {
        high: u16,
    },
    LowU {
        high: u16,
    },
    LowUnicode {
        high: u16,
        value: u16,
        digits: u8,
    },
    End,
}
/// Decodes a quoted JSON string without retaining a complete token.
#[derive(Debug, Default)]
pub struct JsonStringDecoder {
    state: State,
    pending: Pending,
}
impl JsonStringDecoder {
    pub fn new() -> Self {
        Self::default()
    }
    fn character(&mut self, value: u32) -> io::Result<()> {
        let c = char::from_u32(value).ok_or_else(|| invalid("invalid JSON Unicode escape"))?;
        let mut bytes = [0; 4];
        self.pending.set(c.encode_utf8(&mut bytes).as_bytes());
        Ok(())
    }
    fn accept(&mut self, b: u8) -> io::Result<()> {
        self.state = match self.state {
            State::Start if b == b'"' => State::Text,
            State::Start => return Err(invalid("JSON text source lacks opening quote")),
            State::Text => match b {
                b'"' => State::End,
                b'\\' => State::Escape,
                0..=31 => return Err(invalid("unescaped JSON control byte")),
                _ => {
                    self.pending.set(&[b]);
                    State::Text
                }
            },
            State::Escape => match b {
                b'u' => State::Unicode {
                    value: 0,
                    digits: 0,
                },
                b'"' | b'\\' | b'/' => {
                    self.pending.set(&[b]);
                    State::Text
                }
                b'b' => {
                    self.pending.set(&[8]);
                    State::Text
                }
                b'f' => {
                    self.pending.set(&[12]);
                    State::Text
                }
                b'n' => {
                    self.pending.set(b"\n");
                    State::Text
                }
                b'r' => {
                    self.pending.set(b"\r");
                    State::Text
                }
                b't' => {
                    self.pending.set(b"\t");
                    State::Text
                }
                _ => return Err(invalid("invalid JSON escape")),
            },
            State::Unicode { value, digits } => {
                let value = (value << 4) | hex(b)?;
                if digits < 3 {
                    State::Unicode {
                        value,
                        digits: digits + 1,
                    }
                } else if (0xd800..=0xdbff).contains(&value) {
                    State::LowSlash { high: value }
                } else {
                    self.character(u32::from(value))?;
                    State::Text
                }
            }
            State::LowSlash { high } if b == b'\\' => State::LowU { high },
            State::LowU { high } if b == b'u' => State::LowUnicode {
                high,
                value: 0,
                digits: 0,
            },
            State::LowUnicode {
                high,
                value,
                digits,
            } => {
                let value = (value << 4) | hex(b)?;
                if digits < 3 {
                    State::LowUnicode {
                        high,
                        value,
                        digits: digits + 1,
                    }
                } else {
                    if !(0xdc00..=0xdfff).contains(&value) {
                        return Err(invalid("invalid JSON surrogate pair"));
                    }
                    self.character(
                        0x10000 + ((u32::from(high) - 0xd800) << 10) + (u32::from(value) - 0xdc00),
                    )?;
                    State::Text
                }
            }
            State::LowSlash { .. } | State::LowU { .. } => {
                return Err(invalid("missing JSON low surrogate"));
            }
            State::End => return Err(invalid("trailing bytes after JSON string")),
        };
        Ok(())
    }
}
impl Transform for JsonStringDecoder {
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress> {
        let mut p = Progress::default();
        loop {
            p.written += self.pending.drain(&mut output[p.written..]);
            if !self.pending.empty() || p.written == output.len() {
                break;
            }
            let Some(&b) = input.get(p.consumed) else {
                break;
            };
            self.accept(b)?;
            p.consumed += 1;
        }
        let all = p.consumed == input.len();
        if eof && all && self.pending.empty() && !matches!(self.state, State::End) {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "incomplete JSON string source",
            ));
        }
        p.finished = eof && all && self.pending.empty() && matches!(self.state, State::End);
        Ok(p)
    }
}
/// Raw media to base64, carrying at most two input bytes between output groups.
#[derive(Debug, Default)]
pub struct Base64Encoder {
    carry: [u8; 3],
    carried: usize,
    pending: Pending,
    ended: bool,
}
impl Base64Encoder {
    pub fn new() -> Self {
        Self::default()
    }
    fn emit(&mut self) {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let [a, b, c] = self.carry;
        self.pending.set(&[
            A[usize::from(a >> 2)],
            A[usize::from(((a & 3) << 4) | (b >> 4))],
            if self.carried > 1 {
                A[usize::from(((b & 15) << 2) | (c >> 6))]
            } else {
                b'='
            },
            if self.carried > 2 {
                A[usize::from(c & 63)]
            } else {
                b'='
            },
        ]);
        self.carry = [0; 3];
        self.carried = 0;
    }
}
impl Transform for Base64Encoder {
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress> {
        use base64::Engine as _;

        if self.ended && !input.is_empty() {
            return Err(invalid("media bytes after base64 EOF"));
        }
        let mut p = Progress::default();
        loop {
            p.written += self.pending.drain(&mut output[p.written..]);
            if !self.pending.empty() || p.written == output.len() {
                break;
            }
            if self.carried == 0 {
                let groups = ((input.len() - p.consumed) / 3).min((output.len() - p.written) / 4);
                if groups != 0 {
                    let consumed = groups * 3;
                    let written = groups * 4;
                    STANDARD
                        .encode_slice(
                            &input[p.consumed..p.consumed + consumed],
                            &mut output[p.written..p.written + written],
                        )
                        .expect("complete base64 groups fit the calculated output slice");
                    p.consumed += consumed;
                    p.written += written;
                    continue;
                }
            }
            if p.consumed < input.len() {
                self.carry[self.carried] = input[p.consumed];
                self.carried += 1;
                p.consumed += 1;
                if self.carried == 3 {
                    self.emit();
                }
            } else if eof && !self.ended {
                self.ended = true;
                if self.carried != 0 {
                    self.emit();
                }
            } else {
                break;
            }
        }
        p.finished = eof && self.ended && p.consumed == input.len() && self.pending.empty();
        Ok(p)
    }
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn hex(b: u8) -> io::Result<u16> {
    match b {
        b'0'..=b'9' => Ok(u16::from(b - b'0')),
        b'a'..=b'f' => Ok(u16::from(b - b'a' + 10)),
        b'A'..=b'F' => Ok(u16::from(b - b'A' + 10)),
        _ => Err(invalid("invalid JSON Unicode digit")),
    }
}

/// Matches `String::from_utf8_lossy` across arbitrary input and output boundaries.
#[derive(Debug, Default)]
pub struct Utf8Lossy {
    carry: [u8; 4],
    carried: usize,
    expected: usize,
    pending: Pending,
    ended: bool,
}
impl Utf8Lossy {
    pub fn new() -> Self {
        Self::default()
    }
    fn replacement(&mut self) {
        self.pending.set("\u{fffd}".as_bytes());
        self.carried = 0;
    }
    fn continuation(&self, byte: u8) -> bool {
        if !(0x80..=0xbf).contains(&byte) {
            return false;
        }
        if self.carried != 1 {
            return true;
        }
        match self.carry[0] {
            0xe0 => byte >= 0xa0,
            0xed => byte <= 0x9f,
            0xf0 => byte >= 0x90,
            0xf4 => byte <= 0x8f,
            _ => true,
        }
    }
}
impl Transform for Utf8Lossy {
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress> {
        if self.ended && !input.is_empty() {
            return Err(invalid("media text after UTF-8 EOF"));
        }
        let mut p = Progress::default();
        loop {
            p.written += self.pending.drain(&mut output[p.written..]);
            if !self.pending.empty() || p.written == output.len() {
                break;
            }
            if let Some(&byte) = input.get(p.consumed) {
                if self.carried == 0 {
                    p.consumed += 1;
                    match byte {
                        0..=0x7f => self.pending.set(&[byte]),
                        0xc2..=0xdf => {
                            self.carry[0] = byte;
                            self.carried = 1;
                            self.expected = 2;
                        }
                        0xe0..=0xef => {
                            self.carry[0] = byte;
                            self.carried = 1;
                            self.expected = 3;
                        }
                        0xf0..=0xf4 => {
                            self.carry[0] = byte;
                            self.carried = 1;
                            self.expected = 4;
                        }
                        _ => self.replacement(),
                    }
                } else if self.continuation(byte) {
                    self.carry[self.carried] = byte;
                    self.carried += 1;
                    p.consumed += 1;
                    if self.carried == self.expected {
                        self.pending.set(&self.carry[..self.carried]);
                        self.carried = 0;
                    }
                } else {
                    self.replacement();
                }
            } else if eof && !self.ended {
                self.ended = true;
                if self.carried != 0 {
                    self.replacement();
                }
            } else {
                break;
            }
        }
        p.finished = eof && self.ended && p.consumed == input.len() && self.pending.empty();
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    fn run(
        mut transform: impl Transform,
        input: &[u8],
        input_size: usize,
        output_size: usize,
    ) -> io::Result<Vec<u8>> {
        let mut result = Vec::new();
        let mut position = 0;
        let mut end = input_size.min(input.len());
        loop {
            let mut output = vec![0; output_size];
            let progress =
                transform.transform(&input[position..end], end == input.len(), &mut output)?;
            position += progress.consumed;
            result.extend_from_slice(&output[..progress.written]);
            if progress.finished {
                return Ok(result);
            }
            if progress.consumed == 0 && progress.written == 0 {
                assert_eq!(position, end, "transform stalled before consuming input");
                assert!(end < input.len(), "transform stalled at EOF");
                end = (end + input_size).min(input.len());
            }
        }
    }
    #[test]
    fn giant_text_and_json_as_string_match_serde_with_single_byte_backpressure() {
        let controls: String = (0..32).map(|b| char::from(b as u8)).collect();
        let text = format!("{controls}中文🙂\n\"\\{}", "一\\\"\t".repeat(4096));
        let expected = serde_json::to_vec(&text).unwrap();
        let escaped = run(JsonEscape::new(), text.as_bytes(), 1, 1).unwrap();
        assert_eq!(&escaped[..], &expected[1..expected.len() - 1]);
        let value = serde_json::json!({"long":text,"later":true});
        let inner = serde_json::to_vec(&value).unwrap();
        let outer = serde_json::to_vec(&String::from_utf8(inner.clone()).unwrap()).unwrap();
        assert_eq!(
            run(JsonEscape::new(), &inner, 3, 1).unwrap(),
            outer[1..outer.len() - 1]
        );
    }
    #[test]
    fn split_escapes_surrogates_and_utf8_decode_without_token_allocation() {
        let json = br#""\uD83D\uDE42\u4e2d\n\b\f\r\t\/\\\"""#;
        let expected: String = serde_json::from_slice(json).unwrap();
        assert_eq!(
            run(JsonStringDecoder::new(), json, 1, 1).unwrap(),
            expected.as_bytes()
        );
        let text = "汉🙂".repeat(32768);
        let json = serde_json::to_vec(&text).unwrap();
        assert_eq!(
            run(JsonStringDecoder::new(), &json, 7, 3).unwrap(),
            text.as_bytes()
        );
    }
    #[test]
    fn truncated_or_invalid_surrogates_report_source_failure() {
        for json in [
            br#""\ud83d"#.as_slice(),
            br#""\ud83d\u0041""#,
            br#""\udc00""#,
        ] {
            assert!(run(JsonStringDecoder::new(), json, 1, 2).is_err());
        }
    }
    #[test]
    fn base64_final_padding_and_backpressure_match_the_codec() {
        for size in [0, 1, 2, 3, 4, 31, 32, 33, 65537] {
            let input: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();
            let expected = base64::engine::general_purpose::STANDARD.encode(&input);
            assert_eq!(
                run(Base64Encoder::new(), &input, 5, 1).unwrap(),
                expected.as_bytes(),
                "raw byte count {size}"
            );
        }
    }
    #[test]
    fn base64_bulk_groups_match_the_codec_across_input_and_output_boundaries() {
        for size in [257, 258, 259] {
            let input: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();
            let expected = STANDARD.encode(&input);
            for input_size in [1, 2, 3, 5, 64, 259] {
                for output_size in [3, 4, 5, 7, 64, 65] {
                    assert_eq!(
                        run(Base64Encoder::new(), &input, input_size, output_size).unwrap(),
                        expected.as_bytes(),
                        "raw byte count {size}, input size {input_size}, output size {output_size}"
                    );
                }
            }
        }
    }
    #[test]
    fn base64_rejects_input_after_eof_even_with_pending_padding() {
        let mut encoder = Base64Encoder::new();
        let mut output = [0; 5];
        let progress = encoder.transform(b"abcd", true, &mut output).unwrap();
        assert_eq!(progress.consumed, 4);
        assert_eq!(&output[..progress.written], b"YWJjZ");
        assert!(!progress.finished);
        assert_eq!(
            encoder.transform(b"x", true, &mut []).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let progress = encoder.transform(b"", true, &mut output).unwrap();
        assert_eq!(&output[..progress.written], b"A==");
        assert!(progress.finished);
        assert_eq!(
            encoder
                .transform(b"x", false, &mut output)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}

#[cfg(test)]
mod lossy_tests {
    use super::*;
    #[test]
    fn invalid_media_text_matches_std_across_single_byte_boundaries() {
        let cases: &[&[u8]] = &[
            b"",
            b"plain",
            "汉🙂".as_bytes(),
            &[0xff, 0xc0, 0x80, 0x61],
            &[0xe0, 0x80, 0x80],
            &[0xed, 0xa0, 0x80],
            &[0xf4, 0x90, 0x80, 0x80],
            &[0xe2, 0x82, b'X'],
            &[0xf0, 0x90, 0x80],
            &[0xf0, 0x90, 0x80, 0x80],
        ];
        for input in cases {
            let mut transform = Utf8Lossy::new();
            let mut result = Vec::new();
            let mut position = 0;
            let mut end = 1.min(input.len());
            loop {
                let mut output = [0; 1];
                let p = transform
                    .transform(&input[position..end], end == input.len(), &mut output)
                    .unwrap();
                position += p.consumed;
                result.extend_from_slice(&output[..p.written]);
                if p.finished {
                    break;
                }
                if p.consumed == 0 && p.written == 0 {
                    assert_eq!(position, end);
                    assert!(end < input.len());
                    end += 1;
                }
            }
            assert_eq!(
                result,
                String::from_utf8_lossy(input).as_bytes(),
                "raw media {input:?}"
            );
        }
    }
}
