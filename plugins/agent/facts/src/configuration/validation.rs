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
//! Shared Rust domain validation used by protocol ingress and persistence.
pub use super::credential_validation::*;
pub use super::model_validation::*;
use super::*;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub type ValidationResult<T = ()> = Result<T, String>;
pub fn normalize_create(
    mut value: CreateCatalogConnectionInput,
) -> ValidationResult<CreateCatalogConnectionInput> {
    revision(value.expected_catalog_revision, false)?;
    normalize_draft(&mut value.connection)?;
    Ok(value)
}
pub fn revision(value: u64, positive: bool) -> ValidationResult {
    if value > MAX_SAFE_INTEGER || (positive && value == 0) {
        return Err("invalid revision".into());
    }
    Ok(())
}
pub fn entity_id(value: &str) -> ValidationResult {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || ![8, 13, 18, 23].into_iter().all(|i| bytes[i] == b'-')
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, c)| [8, 13, 18, 23].contains(&i) || c.is_ascii_hexdigit())
        || !(b'1'..=b'8').contains(&bytes[14])
        || !b"89aAbB".contains(&bytes[19])
    {
        return Err("entity id must be a UUID".into());
    }
    Ok(())
}
pub fn text(value: &str) -> ValidationResult {
    if value.is_empty() {
        return Err("empty string".into());
    }
    Ok(())
}
pub fn slug(value: &str) -> ValidationResult {
    let valid = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let b = value.as_bytes();
    if b.is_empty()
        || !valid(b[0])
        || !valid(b[b.len() - 1])
        || !b.iter().all(|c| valid(*c) || *c == b'-')
    {
        return Err("invalid connection slug".into());
    }
    Ok(())
}
pub fn basis(value: &ConnectionVersionBasis) -> ValidationResult {
    entity_id(&value.connection_id)?;
    revision(value.revision, true)
}
pub fn target(value: &ConnectionTarget) -> ValidationResult {
    entity_id(&value.connection_id)?;
    text(&value.model_id)
}
pub fn normalize_base_url(raw: &str) -> ValidationResult<String> {
    let raw = raw.trim();
    let parsed = url::Url::parse(raw).map_err(|_| "invalid connection base URL")?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || raw.contains(['?', '#'])
    {
        return Err("invalid connection base URL".into());
    }
    Ok(parsed.to_string())
}
pub fn model_ids(values: &[String]) -> ValidationResult {
    let mut seen = std::collections::BTreeSet::new();
    for value in values {
        text(value)?;
        if !seen.insert(value) {
            return Err("duplicate enabled model".into());
        }
    }
    Ok(())
}
pub fn profiles(values: &BTreeMap<String, ModelOverride>) -> ValidationResult {
    for (id, p) in values {
        model_override(id, p)?;
    }
    Ok(())
}

pub fn model_override(id: &str, p: &ModelOverride) -> ValidationResult {
    text(id)?;
    if let Some(reference) = &p.catalog_model {
        for id in [&reference.provider, &reference.model_id] {
            text(id)?;
            if id.chars().any(char::is_control) {
                return Err("invalid catalog model reference".into());
            }
        }
    }
    if let Some(adapter) = &p.adapter {
        text(adapter)?;
        if adapter.chars().any(char::is_control) {
            return Err("invalid model adapter name".into());
        }
    }
    if let Some(levels) = &p.thinking_levels
        && (levels.is_empty()
            || levels
                .iter()
                .enumerate()
                .any(|(index, level)| levels[..index].contains(level)))
    {
        return Err("invalid relay thinking levels".into());
    }
    for n in [
        p.context_window,
        p.input_limit,
        p.compaction_threshold,
        p.max_output_tokens,
    ]
    .into_iter()
    .flatten()
    {
        revision(n, true)?;
    }
    Ok(())
}
pub fn overlay(value: &Value) -> ValidationResult {
    if !value.is_object() {
        return Err("overlay must be an object".into());
    }
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if ["__proto__", "constructor", "prototype"].contains(&key.as_str()) {
                        return Err("unsafe overlay key".into());
                    }
                    pending.push(value);
                }
            }
            Value::Array(array) => pending.extend(array),
            _ => {}
        }
    }
    Ok(())
}
pub fn normalize_draft(value: &mut ConnectionCatalogEntryDraft) -> ValidationResult {
    slug(&value.slug)?;

    model_ids(&value.enabled_model_ids)?;
    value.provider.validate()?;
    provider_configuration(&value.configuration)?;
    if let Some(v) = &value.model_overrides {
        profiles(v)?;
        if v.is_empty() {
            value.model_overrides = None;
        }
    }
    if let Some(v) = &value.request_body_overlay {
        overlay(v)?;
        if v.as_object().is_some_and(|o| o.is_empty()) {
            value.request_body_overlay = None;
        }
    }
    Ok(())
}
pub fn normalize_update(value: &mut ConnectionCatalogEntryUpdate) -> ValidationResult {
    if let Some(ids) = &value.enabled_model_ids {
        model_ids(ids)?;
    }
    if let Some(configuration) = &value.configuration {
        provider_configuration(configuration)?;
    }
    if let Patch::Set(v) = &value.model_overrides {
        profiles(v)?;
        if v.is_empty() {
            value.model_overrides = Patch::Clear;
        }
    }
    if let Patch::Set(v) = &value.request_body_overlay {
        overlay(v)?;
        if v.as_object().is_some_and(|o| o.is_empty()) {
            value.request_body_overlay = Patch::Clear;
        }
    }
    Ok(())
}

/// Stored structure is valid even while its provider is unavailable. Schema
/// validation and one-time defaults belong to the admitted provider binding.
pub fn provider_configuration(value: &Value) -> ValidationResult {
    if !value.is_object() {
        return Err("invalid provider configuration".into());
    }
    Ok(())
}
