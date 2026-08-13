use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
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
    pub network: NetworkMode,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
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
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(format!("{field} must be lexically canonical"));
    }
    Ok(())
}
