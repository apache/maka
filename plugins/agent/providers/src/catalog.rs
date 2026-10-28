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

//! Immutable public model facts with route-specific execution controls. Network
//! and publication belong to the product owner; account observations and user
//! policy remain separate.

use maka_agent_facts::{
    configuration::{ModelInfo, validation},
    public_catalog::PublicCatalogBody,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{RwLock, mpsc, oneshot};

mod merge;
mod models_dev;
pub(crate) mod openrouter;
#[cfg(test)]
mod tests;

type Models = BTreeMap<String, BTreeMap<String, ModelInfo>>;
type RefreshCompletion = oneshot::Sender<Result<(), String>>;

/// The owner holds the write guard across its catalog SQL commit and Arc
/// publication. Readers retain the read guard while observing the SQL revision.
/// An unrecoverable commit outcome replaces the same snapshot with an error.
pub struct Catalog {
    pub snapshot: RwLock<Result<Arc<Snapshot>, String>>,
    refresh: Mutex<Option<mpsc::UnboundedSender<RefreshCompletion>>>,
}
impl Catalog {
    pub fn new(snapshot: Snapshot) -> Self {
        Self {
            snapshot: RwLock::new(Ok(Arc::new(snapshot))),
            refresh: Mutex::new(None),
        }
    }

    /// Enqueue synchronously; dropping the receipt does not retract the intent.
    /// Waiting is optional. A standalone embedding keeps its cached facts.
    pub fn request_refresh(&self) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let sender = self.refresh.lock().expect("catalog refresh lock").clone();
        let (complete, completed) = oneshot::channel();
        let Some(sender) = sender else {
            let _ = complete.send(Ok(()));
            return Ok(completed);
        };
        sender
            .send(complete)
            .map_err(|_| "public catalog refresh owner is closed".to_owned())?;
        Ok(completed)
    }

    /// Exactly one product driver owns refreshes. Its network work occurs
    /// outside the snapshot write guard; attached requests share its result.
    pub fn attach_refresh(&self) -> mpsc::UnboundedReceiver<RefreshCompletion> {
        let mut current = self.refresh.lock().expect("catalog refresh lock");
        assert!(
            current
                .as_ref()
                .is_none_or(mpsc::UnboundedSender::is_closed),
            "public catalog already has a refresh owner"
        );
        let (sender, receiver) = mpsc::unbounded_channel();
        *current = Some(sender);
        receiver
    }
}

#[derive(Debug)]
pub struct Snapshot {
    models: Models,
    shared: BTreeMap<String, ModelInfo>,
}

impl Snapshot {
    /// Compiled observations are only the floor for models absent from public
    /// sources. They do not establish an otherwise unknown provider default.
    pub fn bundled() -> Result<Self, String> {
        let mut models = Models::new();
        for (provider, facts) in crate::facts::all().map_err(|error| error.to_string())? {
            let entries = models.entry(provider.clone()).or_default();
            for (id, known) in &facts.models {
                let metadata = &known.metadata;
                let mut capabilities = metadata.capabilities.unwrap_or_default();
                capabilities.chat = capabilities
                    .chat
                    .or(Some(known.entry.can_use_as_chat_default));
                capabilities.vision = capabilities.vision.or(Some(known.entry.supports_vision));
                entries.insert(
                    id.clone(),
                    ModelInfo {
                        id: id.clone(),
                        display_name: metadata.display_name.clone(),
                        description: metadata.description.clone(),
                        context_window: metadata.context_window,
                        input_limit: metadata.input_limit,
                        max_output_tokens: metadata.max_output_tokens,
                        thinking_levels: Some(known.entry.thinking_levels.clone()),
                        knowledge_cutoff: metadata.knowledge_cutoff.clone(),
                        structured_output: metadata.structured_output,
                        last_updated: metadata.last_updated.clone(),
                        capabilities: Some(capabilities),
                        modalities: metadata.modalities.clone(),
                        ..Default::default()
                    },
                );
            }
        }
        Ok(Self {
            models,
            shared: BTreeMap::new(),
        })
    }

    /// Each present source must be a complete valid JSON payload. Cache/fallback
    /// selection occurs before this pure boundary, without changing source IDs.
    pub fn from_sources(
        models_dev: Option<&PublicCatalogBody>,
        openrouter: Option<&PublicCatalogBody>,
    ) -> Result<Self, String> {
        let mut snapshot = Self::bundled()?;
        let entries = models_dev
            .map(models_dev::parse)
            .transpose()?
            .unwrap_or_default();
        let router = openrouter
            .map(openrouter::parse)
            .transpose()?
            .unwrap_or_default();
        let bridges: BTreeMap<_, _> = entries
            .iter()
            .filter(|entry| entry.provider == "openrouter")
            .filter_map(|entry| {
                entry
                    .canonical
                    .as_ref()
                    .map(|canonical| (entry.model.id.clone(), canonical.clone()))
            })
            .collect();
        let shared = merge::shared_metadata(&bridges, &router);
        let mut aliases = BTreeMap::<&str, Option<&str>>::new();
        let mut declare = |alias, canonical| {
            aliases
                .entry(alias)
                .and_modify(|current| {
                    if *current != Some(canonical) {
                        *current = None;
                    }
                })
                .or_insert(Some(canonical));
        };
        for model in &router {
            declare(
                model.id.as_str(),
                bridges
                    .get(&model.id)
                    .map_or(model.id.as_str(), String::as_str),
            );
        }
        for entry in &entries {
            if let Some(canonical) = entry.canonical.as_deref() {
                declare(entry.model.id.as_str(), canonical);
            }
        }
        for canonical in shared.keys() {
            declare(canonical.as_str(), canonical.as_str());
        }
        let exact: BTreeMap<_, _> = router
            .iter()
            .map(|model| (model.id.as_str(), model))
            .collect();
        snapshot.shared = aliases
            .into_iter()
            .filter_map(|(alias, canonical)| {
                let mut model = shared.get(canonical?)?.clone();
                model.id = alias.into();
                if let Some(exact) = exact.get(alias) {
                    model.display_name = exact.display_name.clone().or(model.display_name);
                    model.description = exact.description.clone().or(model.description);
                    model.knowledge_cutoff =
                        exact.knowledge_cutoff.clone().or(model.knowledge_cutoff);
                }
                Some((alias.into(), model))
            })
            .collect();
        for model in snapshot
            .models
            .values_mut()
            .flat_map(|models| models.values_mut())
        {
            if let Some(common) = snapshot.shared.get(&model.id) {
                merge::fill_metadata(model, common);
            }
        }
        for mut entry in entries {
            if entry.provider != "openrouter"
                && let Some(common) = entry.canonical.as_ref().and_then(|id| shared.get(id))
            {
                merge::fill_metadata(&mut entry.model, common);
            }
            // Exact IDs may fill omissions unless both sources explicitly bind
            // that spelling to different canonical models.
            if entry
                .canonical
                .as_ref()
                .zip(bridges.get(&entry.model.id))
                .is_none_or(|(route, gateway)| route == gateway)
                && let Some(common) = snapshot.shared.get(&entry.model.id)
            {
                merge::fill_metadata(&mut entry.model, common);
            }
            snapshot
                .models
                .entry(entry.provider)
                .or_default()
                .insert(entry.model.id.clone(), entry.model);
        }
        for model in router {
            snapshot
                .models
                .entry("openrouter".into())
                .or_default()
                .insert(model.id.clone(), model);
        }
        Ok(snapshot)
    }

    /// Shared model capacities and prose fill unknown routes through exact IDs
    /// or unambiguous public aliases. Route-specific controls stay local.
    pub fn get(&self, provider: &str, exact_model_id: &str) -> Option<&ModelInfo> {
        self.models
            .get(provider)
            .and_then(|models| models.get(exact_model_id))
            .or_else(|| self.shared.get(exact_model_id))
    }

    /// Restore the one public observation captured at admission. A captured
    /// absence must remain absent even if today's bundled/public catalog has it.
    pub fn for_model(
        provider: &str,
        exact_model_id: &str,
        record: Option<ModelInfo>,
    ) -> Result<Self, String> {
        let mut models = Models::new();
        if let Some(record) = record {
            record.validate()?;
            if record.id != exact_model_id {
                return Err("captured public model identity differs from its selection".into());
            }
            models
                .entry(provider.into())
                .or_default()
                .insert(record.id.clone(), record);
        }
        Ok(Self {
            models,
            shared: BTreeMap::new(),
        })
    }

    /// Only missing account facts are filled. An account's own effort list also
    /// owns its unknown default; catalog defaults must not reinterpret that list.
    pub fn resolve(&self, provider: &str, reported: ModelInfo) -> ModelInfo {
        match self.get(provider, &reported.id) {
            Some(public) => merge::reported(reported, public),
            None => reported,
        }
    }
}

pub(super) fn text(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err("invalid public model text".into()),
    }
}

pub(super) fn token_limit(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    (number > 0.0 && number <= validation::MAX_SAFE_INTEGER as f64 && number.fract() == 0.0)
        .then_some(number as u64)
}

pub(super) fn modalities(
    input: Option<&Value>,
    output: Option<&Value>,
) -> Result<Option<maka_agent_facts::configuration::ModelModalities>, String> {
    use maka_agent_facts::configuration::{ModelModalities, ModelModality};
    fn parse(value: Option<&Value>) -> Result<Option<Vec<ModelModality>>, String> {
        let values = match value {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::Array(values)) => values,
            _ => return Err("invalid public model modalities".into()),
        };
        let mut result = vec![];
        for value in values {
            let modality = match value.as_str() {
                Some("text") => ModelModality::Text,
                Some("image") => ModelModality::Image,
                Some("audio") => ModelModality::Audio,
                Some("pdf") => ModelModality::Pdf,
                Some("video") => ModelModality::Video,
                _ => continue,
            };
            if !result.contains(&modality) {
                result.push(modality);
            }
        }
        Ok(Some(result))
    }
    let input = parse(input)?;
    let output = parse(output)?;
    Ok(
        (input.is_some() || output.is_some()).then(|| ModelModalities {
            input: input.unwrap_or_default(),
            output: output.unwrap_or_default(),
        }),
    )
}
