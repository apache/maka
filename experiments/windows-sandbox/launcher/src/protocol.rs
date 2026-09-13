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

use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path};

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub version: u32,
    pub request_id: String,
    pub executable: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
    #[serde(default)]
    pub exact_read_roots: Vec<String>,
    #[serde(default)]
    pub exact_write_roots: Vec<String>,
    pub network: NetworkMode,
    pub environment: BTreeMap<String, String>,
    /// Optional child-wait deadline. Appended last and skipped when absent so
    /// manifests written before this field keep an identical launch digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

pub const MIN_LAUNCH_TIMEOUT_MS: u64 = 1_000;
pub const MAX_LAUNCH_TIMEOUT_MS: u64 = 600_000;
pub const DEFAULT_LAUNCH_TIMEOUT_MS: u64 = 30_000;

/// `request_id` reserved for the internal Windows readiness probe. Its own
/// AppContainer profile/SID is derived from this exact identity, and
/// `create_readiness` best-effort *deletes* that profile before recreating it.
/// A production launch is therefore forbidden from carrying it: otherwise an
/// ordinary launch would resolve to the same profile the probe reclaims,
/// letting the two identities collide. `validate` rejects it so the readiness
/// namespace is one production requests can never enter — enforced, not merely
/// documented.
pub const RESERVED_READINESS_REQUEST_ID: &str = "readiness-probe";

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct BrokerLaunchRequest {
    pub version: u32,
    pub request_id: String,
    pub client_pid: u32,
    pub client_nonce: String,
    pub profile_digest: String,
    pub launch: LaunchRequest,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct BrokerLaunchResponse {
    pub version: u32,
    pub request_id: String,
    pub outcome: BrokerLaunchOutcome,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[allow(dead_code)]
pub enum BrokerLaunchOutcome {
    Started {
        process_id: u32,
    },
    Completed {
        #[serde(rename = "exitCode")]
        exit_code: u8,
    },
    Rejected {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Restricted,
    Enabled,
}

impl LaunchRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("unsupported protocol version".to_owned());
        }
        if self.request_id.is_empty()
            || self.request_id.len() > 128
            || !self
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err("requestId must use 1-128 safe ASCII characters".to_owned());
        }
        if self.request_id == RESERVED_READINESS_REQUEST_ID {
            return Err(format!(
                "requestId '{RESERVED_READINESS_REQUEST_ID}' is reserved for the internal readiness probe"
            ));
        }
        validate_path(&self.executable, "executable")?;
        validate_path(&self.cwd, "cwd")?;
        validate_roots(&self.read_roots, "readRoots")?;
        validate_roots(&self.write_roots, "writeRoots")?;
        validate_roots(&self.exact_read_roots, "exactReadRoots")?;
        validate_roots(&self.exact_write_roots, "exactWriteRoots")?;
        if let Some(timeout_ms) = self.timeout_ms {
            if !(MIN_LAUNCH_TIMEOUT_MS..=MAX_LAUNCH_TIMEOUT_MS).contains(&timeout_ms) {
                return Err(format!(
                    "timeoutMs must be between {MIN_LAUNCH_TIMEOUT_MS} and {MAX_LAUNCH_TIMEOUT_MS}"
                ));
            }
        }
        for (name, value) in &self.environment {
            // The CreateProcess environment block is `name=value\0...\0\0`, so
            // a name may not be empty, may not contain '=' or a control
            // character (NUL is < 0x20 and would truncate the block), and may
            // not begin with '=' — that leading form is Windows' hidden
            // per-drive cwd variable (`=C:`). Everything else, including the
            // parentheses in real names like `CommonProgramFiles(x86)`, is a
            // legitimate Windows environment name.
            if name.is_empty()
                || name.starts_with('=')
                || name.chars().any(|c| c == '=' || (c as u32) < 0x20)
            {
                return Err(format!("invalid environment name: {name}"));
            }
            if value.contains('\0') {
                return Err(format!("invalid environment value for {name}"));
            }
        }
        Ok(())
    }
}

impl BrokerLaunchRequest {
    #[allow(dead_code)]
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("unsupported broker protocol version".to_owned());
        }
        if self.request_id.is_empty() {
            return Err("requestId must be non-empty".to_owned());
        }
        if self.client_pid == 0 {
            return Err("clientPid must be non-zero".to_owned());
        }
        if !is_fixed_hex(&self.client_nonce, 32) {
            return Err("clientNonce must be 32 hexadecimal characters".to_owned());
        }
        if !is_fixed_hex(&self.profile_digest, 64) {
            return Err("profileDigest must be 64 hexadecimal characters".to_owned());
        }
        self.launch.validate()
    }
}

pub fn launch_digest(request: &LaunchRequest) -> Result<String, String> {
    let canonical = serde_json::to_vec(request)
        .map_err(|error| format!("serialize canonical launch policy failed: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

#[allow(dead_code)]
fn is_fixed_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_roots(roots: &[String], field: &str) -> Result<(), String> {
    let mut unique = HashSet::new();
    for (index, root) in roots.iter().enumerate() {
        validate_path(root, &format!("{field}[{index}]"))?;
        if !unique.insert(root.to_lowercase()) {
            return Err(format!("{field} must not contain duplicate paths"));
        }
    }
    Ok(())
}

fn validate_path(value: &str, field: &str) -> Result<(), String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(format!("{field} must be absolute"));
    }
    if value.contains('/') || (value.ends_with('\\') && !is_windows_root(value)) {
        return Err(format!("{field} must use canonical Windows separators"));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(format!("{field} must be lexically canonical"));
    }
    Ok(())
}

fn is_windows_root(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 3 && bytes[1] == b':' && bytes[2] == b'\\' && bytes[0].is_ascii_alphabetic()
}
