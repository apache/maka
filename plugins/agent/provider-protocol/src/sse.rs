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

use crate::{Error, Result};
use serde_json::Value;

// Only one unfinished JSON/SSE record is buffered. Keep a generous bound for
// atomic tool/media/text records (including the >32 MiB regression fixture),
// while an unterminated provider record cannot grow without limit. Completed
// records release their backing storage; total response size is unrestricted.
pub const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;

/// Raw byte accounting includes comments, field names and separators. Memory
/// belongs to one incomplete record, not to the complete response stream.
#[derive(Default)]
pub struct Decoder {
    line: Vec<u8>,
    data: Vec<u8>,
    has_data: bool,
    record_bytes: usize,
    after_cr: bool,
    bytes_at_cr: usize,
    seen_line: bool,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        let mut result = Vec::new();
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    // A CRLF is one delimiter but two bytes on the wire. The
                    // CR may already have completed and reset the record.
                    Self::check_size(self.bytes_at_cr + 1)?;
                    if self.record_bytes != 0 {
                        self.record_bytes += 1;
                    }
                    continue;
                }
            }
            self.record_bytes += 1;
            Self::check_size(self.record_bytes)?;
            match byte {
                b'\r' | b'\n' => {
                    self.bytes_at_cr = self.record_bytes;
                    self.finish_line(&mut result);
                    self.after_cr = byte == b'\r';
                }
                _ => self.line.push(byte),
            }
        }
        Ok(result)
    }

    fn check_size(bytes: usize) -> Result<()> {
        if bytes > MAX_RECORD_BYTES {
            Err(Error::invalid(
                "Provider SSE record exceeds 64 MiB.",
                Value::Null,
            ))
        } else {
            Ok(())
        }
    }

    fn finish_line(&mut self, result: &mut Vec<String>) {
        let mut line = std::mem::take(&mut self.line);
        if !self.seen_line {
            self.seen_line = true;
            if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                line.drain(..3);
            }
        }
        if line.is_empty() {
            if self.has_data {
                if self.data.last() == Some(&b'\n') {
                    self.data.pop();
                }
                let data = std::mem::take(&mut self.data);
                result.push(String::from_utf8(data).unwrap_or_else(|error| {
                    String::from_utf8_lossy(error.as_bytes()).into_owned()
                }));
            }
            self.data.clear();
            self.has_data = false;
            self.record_bytes = 0;
        } else if line == b"data" || line.starts_with(b"data:") {
            let mut value = if line.len() > 4 { &line[5..] } else { &[] };
            if value.first() == Some(&b' ') {
                value = &value[1..];
            }
            self.data.extend_from_slice(value);
            self.data.push(b'\n');
            self.has_data = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_comments_count_toward_the_record_limit_across_chunks() {
        let mut decoder = Decoder::default();
        let comment = [b':'; 1022];
        for _ in 0..MAX_RECORD_BYTES / 1024 {
            assert!(decoder.push(&comment).unwrap().is_empty());
            assert!(decoder.push(b"\r").unwrap().is_empty());
            assert!(decoder.push(b"\n").unwrap().is_empty());
        }
        assert!(decoder.push(b"\n").is_err());
    }

    #[test]
    fn utf8_and_crlf_boundaries_do_not_change_records() {
        let input = "\u{feff}:comment\r\ndata: 你好\r\ndata: world\r\n\r\ndata:\n\n";
        for width in 1..=input.len() {
            let mut decoder = Decoder::default();
            let mut records = Vec::new();
            for chunk in input.as_bytes().chunks(width) {
                records.extend(decoder.push(chunk).unwrap());
            }
            assert_eq!(records, ["你好\nworld", ""]);
        }
    }
}
