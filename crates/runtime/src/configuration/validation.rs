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
pub fn text(value: &str, max: usize, nonempty: bool) -> ValidationResult {
    if value.encode_utf16().count() > max || (nonempty && value.is_empty()) {
        return Err("invalid string length".into());
    }
    Ok(())
}
pub fn slug(value: &str) -> ValidationResult {
    let valid = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let b = value.as_bytes();
    if !(2..=64).contains(&b.len())
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
    text(&value.model_id, 512, true)
}
pub fn normalize_base_url(raw: &str) -> ValidationResult<String> {
    text(raw, 2048, false)?;
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
    let canonical = parsed.to_string();
    if canonical.len() > 2048 {
        return Err("connection base URL exceeds byte limit".into());
    }
    Ok(canonical)
}
pub fn model_ids(values: &[String]) -> ValidationResult {
    if values.len() > 512 {
        return Err("too many enabled models".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    for value in values {
        text(value, 512, true)?;
        if !seen.insert(value) {
            return Err("duplicate enabled model".into());
        }
    }
    Ok(())
}
pub fn profiles(values: &BTreeMap<String, ModelOverride>) -> ValidationResult {
    if values.len() > 2048 {
        return Err("too many model overrides".into());
    }
    for (id, p) in values {
        model_override(id, p)?;
    }
    Ok(())
}

pub fn model_override(id: &str, p: &ModelOverride) -> ValidationResult {
    text(id, 512, true)?;
    if let Some(adapter) = &p.adapter {
        text(adapter, 256, true)?;
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
    for value in [&p.display_name, &p.description, &p.knowledge_cutoff]
        .into_iter()
        .flatten()
    {
        text(value, 2048, false)?;
    }
    Ok(())
}
pub fn overlay(value: &Value) -> ValidationResult {
    if !value.is_object()
        || serde_json::to_vec(value)
            .map_err(|_| "invalid overlay")?
            .len()
            > 32768
    {
        return Err("invalid overlay object or size".into());
    }
    fn visit(value: &Value, depth: usize) -> ValidationResult {
        match value {
            Value::Object(o) => {
                if depth > 16 {
                    return Err("overlay nesting exceeds limit".into());
                }
                for (k, v) in o {
                    if ["__proto__", "constructor", "prototype"].contains(&k.as_str()) {
                        return Err("unsafe overlay key".into());
                    }
                    visit(v, depth + 1)?;
                }
            }
            Value::Array(a) => {
                if depth > 16 {
                    return Err("overlay nesting exceeds limit".into());
                }
                for v in a {
                    visit(v, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(value, 1)
}
pub fn normalize_draft(value: &mut ConnectionCatalogEntryDraft) -> ValidationResult {
    slug(&value.slug)?;
    text(&value.name, 256, false)?;
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
    text(&value.name, 256, false)?;
    model_ids(&value.enabled_model_ids)?;
    provider_configuration(&value.configuration)?;
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
    if !value.is_object()
        || serde_json::to_vec(value)
            .map_err(|_| "invalid provider configuration")?
            .len()
            > 64 * 1024
    {
        return Err("invalid provider configuration".into());
    }
    Ok(())
}
