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
use super::validation::*;
use super::*;
pub fn catalog_entry(value: &ConnectionCatalogEntry) -> ValidationResult {
    entity_id(&value.connection_id)?;
    revision(value.revision, true)?;
    let mut draft = ConnectionCatalogEntryDraft {
        slug: value.slug.clone(),
        name: value.name.clone(),
        provider: value.provider.clone(),
        configuration: value.configuration.clone(),
        enabled: value.enabled,
        enabled_model_ids: value.enabled_model_ids.clone(),
        model_overrides: value.model_overrides.clone(),
        request_body_overlay: value.request_body_overlay.clone(),
    };
    normalize_draft(&mut draft)?;
    if draft.model_overrides != value.model_overrides
        || draft.request_body_overlay != value.request_body_overlay
    {
        return Err("stored connection must be canonical".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for model in &value.models {
        model.validate()?;
        if !ids.insert(&model.id) {
            return Err("duplicate stored model".into());
        }
    }
    if value.model_source.is_some() != value.models_fetched_at.is_some()
        || (value.model_source.is_none() && !value.models.is_empty())
    {
        return Err("model discovery metadata mismatch".into());
    }
    if let Some(t) = value.models_fetched_at {
        revision(t, false)?;
    }
    if let Some(test) = &value.last_test {
        text(&test.checked_at)?;
    }
    Ok(())
}
