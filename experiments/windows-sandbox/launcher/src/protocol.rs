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
}

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
        if self.request_id.is_empty() {
            return Err("requestId must be non-empty".to_owned());
        }
        validate_path(&self.executable, "executable")?;
        validate_path(&self.cwd, "cwd")?;
        validate_roots(&self.read_roots, "readRoots")?;
        validate_roots(&self.write_roots, "writeRoots")?;
        validate_roots(&self.exact_read_roots, "exactReadRoots")?;
        validate_roots(&self.exact_write_roots, "exactWriteRoots")?;
        for name in self.environment.keys() {
            let mut chars = name.chars();
            let valid_first = chars
                .next()
                .is_some_and(|c| c == '_' || c.is_ascii_alphabetic());
            if !valid_first || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric()) {
                return Err(format!("invalid environment name: {name}"));
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
