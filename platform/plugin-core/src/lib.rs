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

//! Shared plugin declarations and composition planning. No business or platform policy.

pub mod composition;
pub mod contract;
pub mod deployment;
pub mod json;
pub mod operation;
pub mod package;
pub mod plan;
pub mod runtime;
mod schema;
pub use schema::Schema;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid plugin declaration: {0}")]
    Declaration(String),
    #[error("invalid application composition: {0}")]
    Composition(String),
    #[error("capability contract mismatch: {0}")]
    Contract(String),
    #[error("plugin capability or activation is retired")]
    Retired,
    #[error("plugin capability is not ready: {0}")]
    NotReady(String),
    #[error("invalid plugin lifecycle transition: {0}")]
    Lifecycle(&'static str),
    #[error("plugin cleanup is pending")]
    CleanupPending,
    #[error("plugin cleanup is unconfirmed: {0:?}")]
    CleanupFailed(Vec<String>),
}

pub(crate) fn name(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(Error::Declaration(format!("invalid name: {value:?}")));
    }
    Ok(())
}

pub(crate) fn content_hash(value: &str) -> bool {
    value.strip_prefix("sha256-").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

pub(crate) fn schema(value: &serde_json::Value) -> Result<(), Error> {
    validator(value).map(|_| ())
}

/// Compile an immutable JSON schema, reusing an equivalent checked validator.
/// Validation of each value remains the caller's responsibility.
pub fn validator(
    value: &serde_json::Value,
) -> Result<std::sync::Arc<jsonschema::Validator>, Error> {
    // Packages and configurations repeat immutable public schemas. Cache compiled
    // validators by the complete schema, never by contract name/version.
    // Configuration values are still validated on every call.
    // JSON Schema is built without external file/network resolution features.
    #[derive(Default)]
    struct Checked {
        schemas: std::collections::HashMap<Schema, std::sync::Arc<jsonschema::Validator>>,
        bytes: usize,
    }
    static CHECKED: std::sync::OnceLock<std::sync::Mutex<Checked>> = std::sync::OnceLock::new();
    let checked = CHECKED.get_or_init(Default::default);
    if let Some(validator) = checked.lock().expect("schema cache").schemas.get(value) {
        return Ok(validator.clone());
    }
    let validator = std::sync::Arc::new(
        jsonschema::validator_for(value)
            .map_err(|error| Error::Declaration(format!("invalid schema: {error}")))?,
    );
    let size = serde_json::to_vec(value).expect("JSON schema value").len();
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    if size <= MAX_BYTES {
        let key = Schema::from(value.clone());
        let mut checked = checked.lock().expect("schema cache");
        if checked.bytes + size > MAX_BYTES || checked.schemas.len() >= 1024 {
            checked.schemas.clear();
            checked.bytes = 0;
        }
        if checked.schemas.insert(key, validator.clone()).is_none() {
            checked.bytes += size;
        }
    }
    Ok(validator)
}

pub(crate) fn validate_value(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Result<(), Error> {
    validator(schema)?
        .validate(value)
        .map_err(|error| Error::Composition(format!("configuration: {error}")))
}

pub mod scope;
pub mod wire_schema;

/// Validate a stable package or entry identifier.
pub fn identifier(value: &str) -> Result<(), Error> {
    if !value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        || value.split(['.', '_', ':', '-']).any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
    {
        return Err(Error::Declaration(format!(
            "invalid plugin identifier: {value:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compiled_schemas_are_reused_without_reusing_value_validation() {
        let schema = json!({"type":"integer", "minimum": 3});
        let first = validator(&schema).unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &first,
            &validator(&schema.clone()).unwrap()
        ));
        assert!(validate_value(&schema, &json!(3)).is_ok());
        assert!(validate_value(&schema, &json!(2)).is_err());
        assert!(validate_value(&schema, &json!("3")).is_err());
        let changed = json!({"type":"integer", "minimum": 4});
        assert!(validate_value(&changed, &json!(3)).is_err());
        assert!(validator(&json!({"type": "not-a-json-type"})).is_err());
    }
}
