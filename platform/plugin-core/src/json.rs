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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn direct_json_sizes_match_serialized_bytes_and_exact_limits() {
        let controls: String = (0..=31).map(char::from).collect();
        let values = [
            Value::Null,
            json!(true),
            json!(false),
            json!([]),
            json!({}),
            json!(controls),
            json!("中😀/\\\"\u{2028}\u{2029}"),
            json!(i64::MIN),
            json!(u64::MAX),
            json!(-0.0),
            json!(f64::MAX),
            json!(f64::MIN_POSITIVE),
            json!(f64::from_bits(1)),
            json!(std::f64::consts::PI),
            json!({"\n中": [1, null, false, {"x": "a\tb"}]}),
        ];
        for value in &values {
            let bytes = serde_json::to_vec(value).unwrap();
            assert_eq!(
                value_size(value, usize::MAX).unwrap(),
                bytes.len(),
                "{value}"
            );
            assert_eq!(value_size(value, bytes.len()).unwrap(), bytes.len());
            assert!(value_size(value, bytes.len() - 1).is_err());
        }
        let mut bits = 0x8f58_7a2b_69e1_c4d3_u64;
        for _ in 0..1024 {
            bits = bits.wrapping_mul(6364136223846793005).wrapping_add(1);
            if let Some(number) = serde_json::Number::from_f64(f64::from_bits(bits)) {
                let value = Value::Number(number);
                assert_eq!(
                    value_size(&value, usize::MAX).unwrap(),
                    serde_json::to_vec(&value).unwrap().len()
                );
            }
        }
        let nested = json!({"values": values});
        assert_eq!(
            value_size(&nested, usize::MAX).unwrap(),
            serde_json::to_vec(&nested).unwrap().len()
        );
        assert!(check_delivery(&json!(9_007_199_254_740_993_u64), 1024).is_err());
    }
}
