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

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Inspect the actual external frames, independently of the production encoder.
pub(crate) fn records(bytes: &[u8], expected: &str) -> Vec<Value> {
    use std::io::{Cursor, Read};
    let magic = b"MAKA-SESSION\0\x02";
    assert_eq!(&bytes[..magic.len()], magic);
    let mut cursor = Cursor::new(bytes);
    cursor.set_position(magic.len() as u64);
    let mut records = Vec::new();
    loop {
        let start = cursor.position() as usize;
        let mut length = [0; 4];
        cursor.read_exact(&mut length).unwrap();
        let mut json = vec![0; u32::from_be_bytes(length) as usize];
        cursor.read_exact(&mut json).unwrap();
        let record: Value = serde_json::from_slice(&json).unwrap();
        if record["kind"] == "end" {
            assert_eq!(record["digest"], expected);
            assert_eq!(record["frames"], records.len());
            assert_eq!(
                expected,
                format!("sha256:{}", hex::encode(Sha256::digest(&bytes[..start])))
            );
            assert_eq!(cursor.position(), bytes.len() as u64);
            return records;
        }
        if record["kind"] == "blob" {
            let length = if record["resource"] == "artifact" {
                record["metadata"]["sizeBytes"].as_u64()
            } else {
                record["bytes"].as_u64()
            }
            .unwrap();
            let mut payload = vec![0; length as usize];
            cursor.read_exact(&mut payload).unwrap();
            assert_eq!(
                record["digest"],
                format!("sha256:{}", hex::encode(Sha256::digest(&payload)))
            );
        }
        records.push(record);
    }
}

/// Rewrite selected canonical facts and recompute only the transport checksum.
pub(crate) fn rewrite_events(bytes: &[u8], mut change: impl FnMut(&mut Value) -> bool) -> Vec<u8> {
    rewrite_records(bytes, |record| {
        if record["kind"] != "event" {
            return true;
        }
        let mut event: Value = serde_json::from_str(record["json"].as_str().unwrap()).unwrap();
        let before = event.clone();
        if !change(&mut event) {
            return false;
        }
        if event != before {
            record["json"] = Value::String(serde_json::to_string(&event).unwrap());
        }
        true
    })
}

pub(crate) fn rewrite_records(bytes: &[u8], mut change: impl FnMut(&mut Value) -> bool) -> Vec<u8> {
    use std::io::{Cursor, Read};
    let magic = b"MAKA-SESSION\0\x02";
    let mut cursor = Cursor::new(bytes);
    cursor.set_position(magic.len() as u64);
    let mut output = magic.to_vec();
    let mut count = 0;
    loop {
        let mut length = [0; 4];
        cursor.read_exact(&mut length).unwrap();
        let mut json = vec![0; u32::from_be_bytes(length) as usize];
        cursor.read_exact(&mut json).unwrap();
        let mut record: Value = serde_json::from_slice(&json).unwrap();
        let payload_len = if record["kind"] == "blob" {
            if record["resource"] == "artifact" {
                record["metadata"]["sizeBytes"].as_u64().unwrap()
            } else {
                record["bytes"].as_u64().unwrap()
            }
        } else {
            0
        };
        let start = cursor.position() as usize;
        cursor.set_position(cursor.position() + payload_len);
        let end = record["kind"] == "end";
        if end {
            record["digest"] =
                Value::String(format!("sha256:{}", hex::encode(Sha256::digest(&output))));
            record["frames"] = Value::from(count);
        } else if !change(&mut record) {
            continue;
        }
        let json = serde_json::to_vec(&record).unwrap();
        output.extend((json.len() as u32).to_be_bytes());
        output.extend(json);
        if end {
            return output;
        }
        count += 1;
        output.extend(&bytes[start..start + payload_len as usize]);
    }
}
