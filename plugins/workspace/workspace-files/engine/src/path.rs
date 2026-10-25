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

//! Exact Host-local workspace-relative path bytes, shared by file and Git reads.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gix::bstr::ByteSlice;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::io;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePath {
    pub bytes_base64: String,
}
impl WorkspacePath {
    pub fn from_bytes(bytes: &[u8]) -> io::Result<Self> {
        let path = Self {
            bytes_base64: STANDARD.encode(bytes),
        };
        path.validate()?;
        Ok(path)
    }
    pub fn validate(&self) -> io::Result<()> {
        self.bytes().map(|_| ())
    }
    pub(crate) fn bytes(&self) -> io::Result<Vec<u8>> {
        let bytes = STANDARD.decode(&self.bytes_base64).map_err(|_| invalid())?;
        if bytes.is_empty()
            || bytes.contains(&0)
            || bytes
                .split(|b| *b == b'/')
                .any(|p| p.is_empty() || p == b"." || p == b".." || p.eq_ignore_ascii_case(b".git"))
            || STANDARD.encode(&bytes) != self.bytes_base64
        {
            return Err(invalid());
        }
        #[cfg(windows)]
        if bytes.contains(&b'\\') {
            return Err(invalid());
        }
        let path = gix::path::from_bstr(bytes.as_bstr()).map_err(|_| invalid())?;
        if path.is_absolute()
            || !path
                .components()
                .all(|p| matches!(p, std::path::Component::Normal(_)))
        {
            return Err(invalid());
        }
        Ok(bytes)
    }
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "workspace_path_invalid")
}
