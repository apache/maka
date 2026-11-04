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

//! Bounded JSON envelopes shared by native and JavaScript plugin boundaries.
use serde_json::Value;

/// Reject integer rounding before a value crosses an application boundary.
pub fn check_delivery(value: &Value, limit: usize) -> Result<usize, String> {
    let size = value_size(value, limit)?;
    exact_numbers(value)?;
    Ok(size)
}

/// Count the default JSON encoding directly, including UTF-8 and escapes.
/// Already-decoded values need no serializer or temporary encoded buffer.
pub fn value_size(value: &Value, limit: usize) -> Result<usize, String> {
    struct Counter {
        size: usize,
        limit: usize,
    }
    impl Counter {
        fn add(&mut self, bytes: usize) -> Result<(), String> {
            if bytes > self.limit - self.size {
                return Err("Host payload byte limit".into());
            }
            self.size += bytes;
            Ok(())
        }
        fn string(&mut self, value: &str) -> Result<(), String> {
            self.add(2)?;
            self.add(value.len())?;
            for byte in value.bytes() {
                match byte {
                    b'"' | b'\\' | b'\x08' | b'\x0c' | b'\n' | b'\r' | b'\t' => self.add(1)?,
                    0..=31 => self.add(5)?,
                    _ => {}
                }
            }
            Ok(())
        }
        fn value(&mut self, value: &Value) -> Result<(), String> {
            match value {
                Value::Null => self.add(4),
                Value::Bool(value) => self.add(if *value { 4 } else { 5 }),
                Value::Number(value) => self.add(value.to_string().len()),
                Value::String(value) => self.string(value),
                Value::Array(values) => {
                    self.add(2)?;
                    self.add(values.len().saturating_sub(1))?;
                    for value in values {
                        self.value(value)?;
                    }
                    Ok(())
                }
                Value::Object(values) => {
                    self.add(2)?;
                    self.add(values.len().saturating_sub(1))?;
                    for (key, value) in values {
                        self.string(key)?;
                        self.add(1)?;
                        self.value(value)?;
                    }
                    Ok(())
                }
            }
        }
    }
    let mut counter = Counter { size: 0, limit };
    counter.value(value)?;
    Ok(counter.size)
}

pub fn exact_numbers(value: &Value) -> Result<(), String> {
    match value {
        Value::Number(n) => {
            if inexact_integer(n) {
                return Err(
                    "JSON integer cannot be represented exactly as a JavaScript Number".into(),
                );
            }
        }
        Value::Array(items) => {
            for value in items {
                exact_numbers(value)?;
            }
        }
        Value::Object(items) => {
            for value in items.values() {
                exact_numbers(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn inexact_integer(n: &serde_json::Number) -> bool {
    if let Some(n) = n.as_i64() {
        n as f64 as i128 != n as i128
    } else if let Some(n) = n.as_u64() {
        n as f64 as u128 != n as u128
    } else {
        false
    }
}
// Count encoded bytes without allocating a second copy of a large Host result.
pub fn encoded_size<T: serde::Serialize + ?Sized>(
    value: &T,
    limit: usize,
) -> serde_json::Result<usize> {
    struct Counter {
        size: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.size) {
                return Err(std::io::Error::other("Host payload byte limit"));
            }
            self.size += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { size: 0, limit };
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.size)
}
