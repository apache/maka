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

//! Pull-based JSON encoding. A large string never creates a second encoded buffer.
use serde_json::Value;
pub mod pull;
const CHUNK: usize = 16 * 1024;

enum Task {
    Value(Value),
    String(String, usize),
    Array(std::vec::IntoIter<Value>, bool),
    Object(serde_json::map::IntoIter, bool),
    Byte(u8),
}

pub struct JsonChunks {
    stack: Vec<Task>,
}
impl JsonChunks {
    pub fn new(value: Value) -> Self {
        Self {
            stack: vec![Task::Value(value)],
        }
    }
}
impl Iterator for JsonChunks {
    type Item = Vec<u8>;
    fn next(&mut self) -> Option<Self::Item> {
        let mut bytes = Vec::with_capacity(CHUNK);
        while bytes.len() < CHUNK - 32 {
            let Some(task) = self.stack.pop() else { break };
            match task {
                Task::Byte(byte) => bytes.push(byte),
                Task::Value(value) => match value {
                    Value::Null => bytes.extend_from_slice(b"null"),
                    Value::Bool(true) => bytes.extend_from_slice(b"true"),
                    Value::Bool(false) => bytes.extend_from_slice(b"false"),
                    Value::Number(number) => bytes.extend_from_slice(number.to_string().as_bytes()),
                    Value::String(string) => {
                        bytes.push(b'"');
                        self.stack.push(Task::String(string, 0));
                    }
                    Value::Array(values) => {
                        bytes.push(b'[');
                        self.stack.push(Task::Array(values.into_iter(), true));
                    }
                    Value::Object(values) => {
                        bytes.push(b'{');
                        self.stack.push(Task::Object(values.into_iter(), true));
                    }
                },
                Task::String(string, mut offset) => {
                    while offset < string.len() && bytes.len() < CHUNK - 32 {
                        let ch = string[offset..].chars().next().expect("UTF-8 boundary");
                        offset += ch.len_utf8();
                        match ch {
                            '"' => bytes.extend_from_slice(b"\\\""),
                            '\\' => bytes.extend_from_slice(b"\\\\"),
                            '\n' => bytes.extend_from_slice(b"\\n"),
                            '\r' => bytes.extend_from_slice(b"\\r"),
                            '\t' => bytes.extend_from_slice(b"\\t"),
                            '\u{08}' => bytes.extend_from_slice(b"\\b"),
                            '\u{0c}' => bytes.extend_from_slice(b"\\f"),
                            ch if ch <= '\u{1f}' => {
                                const HEX: &[u8] = b"0123456789abcdef";
                                let ch = ch as usize;
                                bytes.extend_from_slice(&[
                                    b'\\',
                                    b'u',
                                    b'0',
                                    b'0',
                                    HEX[ch >> 4],
                                    HEX[ch & 15],
                                ]);
                            }
                            ch => {
                                let mut utf8 = [0; 4];
                                bytes.extend_from_slice(ch.encode_utf8(&mut utf8).as_bytes());
                            }
                        }
                    }
                    if offset == string.len() {
                        bytes.push(b'"');
                    } else {
                        self.stack.push(Task::String(string, offset));
                    }
                }
                Task::Array(mut values, first) => match values.next() {
                    Some(value) => {
                        if !first {
                            bytes.push(b',');
                        }
                        self.stack.push(Task::Array(values, false));
                        self.stack.push(Task::Value(value));
                    }
                    None => bytes.push(b']'),
                },
                Task::Object(mut values, first) => match values.next() {
                    Some((key, value)) => {
                        if !first {
                            bytes.push(b',');
                        }
                        self.stack.push(Task::Object(values, false));
                        self.stack.push(Task::Value(value));
                        self.stack.push(Task::Byte(b':'));
                        self.stack.push(Task::Value(Value::String(key)));
                    }
                    None => bytes.push(b'}'),
                },
            }
        }
        (!bytes.is_empty()).then_some(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_match_json_and_bound_giant_escaped_strings() {
        let controls: String = (0u8..32).map(char::from).collect();
        let value = serde_json::json!({
            "quotes\"\\": [null, true, false, -1, 1.5, {}, [], ""],
            "large": format!("{controls}{}", "中文\n\"\\😀".repeat(100_000)),
        });
        let expected = serde_json::to_vec(&value).unwrap();
        let chunks: Vec<_> = JsonChunks::new(value).collect();
        assert!(chunks.len() > 10);
        assert!(
            chunks
                .iter()
                .all(|chunk| !chunk.is_empty() && chunk.len() <= CHUNK)
        );
        assert_eq!(chunks.concat(), expected);
    }
}
