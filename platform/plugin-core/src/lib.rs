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

pub mod authorization;
pub mod composition;
pub mod computer;
pub mod contract;
pub mod deployment;
pub mod http;
pub mod json;
pub mod operation;
pub mod package;
pub mod plan;
pub mod runtime;
mod schema;
pub mod scope;
pub mod shell_result;
pub mod shell_run;
pub mod storage;
pub mod terminal;
pub mod wire_schema;
pub mod work;
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

static CHECKED: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<Schema, std::sync::Weak<jsonschema::Validator>>>,
> = std::sync::OnceLock::new();

std::thread_local! {
    static VALIDATION_BATCH: std::cell::RefCell<Option<Vec<std::sync::Arc<jsonschema::Validator>>>> =
        const { std::cell::RefCell::new(None) };
}

fn checked_cache() -> &'static std::sync::Mutex<
    std::collections::HashMap<Schema, std::sync::Weak<jsonschema::Validator>>,
> {
    CHECKED.get_or_init(Default::default)
}

fn lookup_checked(value: &serde_json::Value) -> Option<std::sync::Arc<jsonschema::Validator>> {
    checked_cache()
        .lock()
        .expect("schema cache")
        .get(value)
        .and_then(std::sync::Weak::upgrade)
}

fn retain_in_batch(validator: &std::sync::Arc<jsonschema::Validator>) -> bool {
    VALIDATION_BATCH.with(|batch| {
        if let Some(entries) = batch.borrow_mut().as_mut() {
            entries.push(validator.clone());
            true
        } else {
            false
        }
    })
}

fn batch_active() -> bool {
    VALIDATION_BATCH.with(|batch| batch.borrow().is_some())
}

/// Share compiled validators across a single admission or package-loading batch
/// without pinning admission-only validators globally after the batch finishes.
pub fn with_validation_cache<T>(f: impl FnOnce() -> T) -> T {
    struct Guard(bool);
    impl Drop for Guard {
        fn drop(&mut self) {
            if !self.0 {
                return;
            }
            VALIDATION_BATCH.with(|batch| {
                batch.borrow_mut().take();
            });
            checked_cache()
                .lock()
                .expect("schema cache")
                .retain(|_, entry| entry.strong_count() > 0);
        }
    }
    let owns_batch = VALIDATION_BATCH.with(|batch| {
        let mut slot = batch.borrow_mut();
        if slot.is_none() {
            *slot = Some(Vec::new());
            true
        } else {
            false
        }
    });
    let _guard = Guard(owns_batch);
    f()
}

pub(crate) fn schema(value: &serde_json::Value) -> Result<(), Error> {
    if let Some(cached) = lookup_checked(value) {
        retain_in_batch(&cached);
        return Ok(());
    }
    if batch_active() {
        validator(value).map(|_| ())
    } else {
        jsonschema::validator_for(value)
            .map(|_| ())
            .map_err(|error| Error::Declaration(format!("invalid schema: {error}")))
    }
}

/// Compile an immutable JSON schema, reusing an equivalent live validator.
/// Validation of each value remains the caller's responsibility.
pub fn validator(
    value: &serde_json::Value,
) -> Result<std::sync::Arc<jsonschema::Validator>, Error> {
    if let Some(cached) = lookup_checked(value) {
        retain_in_batch(&cached);
        return Ok(cached);
    }
    let compiled = std::sync::Arc::new(
        jsonschema::validator_for(value)
            .map_err(|error| Error::Declaration(format!("invalid schema: {error}")))?,
    );
    let key = Schema::from(value.clone());
    let mut cache = checked_cache().lock().expect("schema cache");
    if cache.len() >= 1024 {
        cache.retain(|_, entry| entry.strong_count() > 0);
    }
    let shared = match cache.get(&key).and_then(std::sync::Weak::upgrade) {
        Some(existing) => existing,
        None => {
            cache.insert(key, std::sync::Arc::downgrade(&compiled));
            compiled
        }
    };
    drop(cache);
    retain_in_batch(&shared);
    Ok(shared)
}

pub(crate) fn validate_value(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Result<(), Error> {
    validator(schema)?
        .validate(value)
        .map_err(|error| Error::Composition(format!("configuration: {error}")))
}

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
mod validator_cache_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn admission_batch_reuses_and_releases_validators() {
        let schema_value = json!({
            "type": "object",
            "properties": { "unique_admission_batch_test": { "type": "string" } },
            "additionalProperties": false
        });
        with_validation_cache(|| {
            schema(&schema_value).unwrap();
            let first = validator(&schema_value).unwrap();
            let second = validator(&schema_value).unwrap();
            assert!(std::sync::Arc::ptr_eq(&first, &second));
        });
        assert!(lookup_checked(&schema_value).is_none());
    }

    #[test]
    fn live_service_validator_is_shared_until_dropped() {
        let schema_value = json!({
            "type": "object",
            "properties": { "unique_live_service_test": { "type": "integer" } },
            "additionalProperties": false
        });
        let held = validator(&schema_value).unwrap();
        let reused = validator(&schema_value).unwrap();
        assert!(std::sync::Arc::ptr_eq(&held, &reused));
        drop(reused);
        drop(held);
        assert!(lookup_checked(&schema_value).is_none());
    }
}
