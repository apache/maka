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

/// Derive the durable Room post ID from the compact JSON encoding of the
/// admitted operation reference. The Host sends those same bytes in Prepared.
pub fn room_post(session: &str, encoded_reference: &[u8]) -> Option<String> {
    use sha2::{Digest, Sha256};

    let (namespace, local) = session.rsplit_once('_')?;
    if local.len() != 32 || !local.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let digest = hex::encode(Sha256::digest(encoded_reference));
    Some(format!("m_{namespace}_{}", &digest[..32]))
}
