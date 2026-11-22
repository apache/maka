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

use super::{Error, Result};
use serde_json::Value;

/// Incremental SSE framing independent of TCP chunk boundaries.
#[derive(Default)]
pub struct Sse {
    line: Vec<u8>,
    data: Vec<u8>,
    cr: bool,
    first_line: bool,
}
impl Sse {
    pub fn push(&mut self, byte: u8) -> Result<Option<Value>> {
        if self.cr {
            self.cr = false;
            if byte == b'\n' {
                return Ok(None);
            }
        }
        if matches!(byte, b'\r' | b'\n') {
            self.cr = byte == b'\r';
            return self.line();
        }
        self.line.push(byte);
        Ok(None)
    }
    fn line(&mut self) -> Result<Option<Value>> {
        let line = if !self.first_line {
            self.first_line = true;
            self.line
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(&self.line)
        } else {
            &self.line
        };
        let value = if line.is_empty() {
            self.data.pop(); // SSE appends a newline after every data field.
            let value = if self.data.is_empty() || self.data == b"[DONE]" {
                None
            } else {
                Some(
                    serde_json::from_slice(&self.data)
                        .map_err(|e| Error::Invalid(format!("invalid Responses SSE JSON: {e}")))?,
                )
            };
            self.data.clear();
            value
        } else {
            if let Some(value) = line.strip_prefix(b"data:") {
                self.data
                    .extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
                self.data.push(b'\n');
            } else if line == b"data" {
                self.data.push(b'\n');
            }
            None
        };
        self.line.clear();
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_handles_split_crlf_multiline_data_and_comments() {
        let mut stream = Sse::default();
        let input =
            b"\xef\xbb\xbf:comment\r\ndata: {\rdata: \"type\": \"response.created\"}\r\n\r\n";
        let events = input
            .iter()
            .filter_map(|byte| stream.push(*byte).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events, vec![serde_json::json!({"type":"response.created"})]);
    }
}
