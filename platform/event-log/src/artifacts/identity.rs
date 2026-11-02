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

use sha2::{Digest, Sha256};

pub(crate) fn artifact_hasher() -> Sha256 {
    let mut hash = Sha256::new();
    hash.update(b"maka-artifact-identity\0");
    hash
}
pub(crate) fn history_hasher() -> Sha256 {
    let mut hash = Sha256::new();
    hash.update(b"maka-history-artifact-identity\0");
    hash
}
pub(crate) fn artifact_lookup_digest(session: &str, id: &str) -> [u8; 32] {
    let mut hash = artifact_hasher();
    hash.update(session.as_bytes());
    hash.update([0]);
    hash.update(id.as_bytes());
    hash.finalize().into()
}
pub(crate) fn history_lookup_digest(owner: &str, session: &str, id: &str) -> [u8; 32] {
    let mut hash = history_hasher();
    hash.update(owner.as_bytes());
    hash.update([0]);
    hash.update(session.as_bytes());
    hash.update([0]);
    hash.update(id.as_bytes());
    hash.finalize().into()
}
