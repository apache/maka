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

use super::Offer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Stable semantic offer identity, distinct from provider and registration IDs.
/// These host-owned IDs survive restarts; UI consumers also recognize the suffix.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ContractId(String);

impl ContractId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn of(offer: &Offer) -> Self {
        let mut tools: Vec<_> = offer.tools.iter().collect();
        tools.sort_by(|a, b| (&a.server_id, &a.name).cmp(&(&b.server_id, &b.name)));
        let value = serde_json::json!({
            "offerId": offer.offer_id,
            "version": offer.version,
            "affinity": offer.affinity,
            "hostPathAccess": offer.host_path_access,
            "admission": offer.admission,
            "tools": tools,
        });
        let mut canonical = String::new();
        write_canonical(&value, &mut canonical);
        let mut digest = Sha256::new();
        digest.update(b"maka.client-capability-contract.rust.v1\0");
        digest.update(canonical.as_bytes());
        let digest = hex::encode(digest.finalize());
        // Manifest admission guarantees ASCII entity IDs.
        let label: String = offer.offer_id.chars().take(96).collect();
        Self(format!("client_{}_{}", &digest[..16], label))
    }
}

fn write_canonical(value: &Value, output: &mut String) {
    match value {
        Value::Number(number) => {
            // Wire numbers are ECMAScript numbers: 1 == 1.0 and -0 == 0.
            let number = number.as_f64().expect("validated finite JSON number");
            output.push_str(ryu_js::Buffer::new().format(number));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_canonical(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort();
            output.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("string serialization"));
                output.push(':');
                write_canonical(&values[key], output);
            }
            output.push('}');
        }
        _ => output.push_str(&serde_json::to_string(value).expect("JSON primitive")),
    }
}
