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

//! Opt-in native editor persistence. Recipes hold no database or worker owner.
#[cfg(test)]
mod tests;
pub mod value;
mod worker;
use crate::{
    budget::{Kind, NativeBudget, Permit},
    editor::EditorSnapshot,
};
use maka_capabilities::call::Resources;
use maka_event_log::{RootStore, applications::checkpoints::Checkpoints};
use maka_plugin_core::{composition::InstanceId, runtime::Mount};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Weak};

/// A presenter obtains this weak capability for the actual mounted provider.
#[derive(Clone)]
pub struct Scope {
    store: Weak<RootStore>,
    source: maka_event_log::applications::SourceSnapshot,
    instance: InstanceId,
    scheduler: tokio::runtime::Handle,
}
impl<V: ?Sized + 'static> crate::Application<V> {
    pub fn checkpoint_scope(&self, mount: &Mount) -> crate::Result<Option<Scope>> {
        let provider = self.provider(mount)?;
        Ok(self
            .store
            .as_ref()
            .zip(self.origins.get(&provider.epoch()))
            .map(|(store, source)| Scope {
                store: Arc::downgrade(store),
                source: source.clone(),
                instance: provider.instance().clone(),
                scheduler: self.scheduler.clone(),
            }))
    }
}
impl Scope {
    fn open(&self, store: &Arc<RootStore>) -> Result<Arc<Checkpoints>, String> {
        store
            .ui_checkpoints_from(&self.source, &self.instance)
            .map(Arc::new)
            .map_err(|error| error.to_string())
    }
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorPersistence {
    #[schemars(length(min = 1))]
    pub key: String,
    #[schemars(length(min = 1))]
    pub format: String,
    pub data_source: Value,
    pub metadata: Value,
    #[serde(default)]
    pub restore: Option<EditorRestoration>,
    #[serde(default)]
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub retry: u64,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorRestoration {
    #[schemars(length(min = 1))]
    pub owner: String,
    #[schemars(range(min = 1, max = 9_007_199_254_740_991_u64))]
    pub version: u64,
    pub clear_text: bool,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorCheckpointObservation {
    pub owner: String,
    pub state: EditorCheckpointState,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EditorCheckpointState {
    Loading,
    Restore {
        version: u64,
        snapshot: EditorSnapshot,
        metadata: Value,
    },
    Ready {
        saved: bool,
        initialized: bool,
    },
    Failed {
        diagnostic: String,
    },
}
pub fn observation_schema() -> Value {
    serde_json::to_value(schemars::schema_for!(EditorCheckpointObservation))
        .expect("editor checkpoint schema")
}
impl EditorPersistence {
    pub fn validate(&self) -> crate::Result<()> {
        if self.key.is_empty()
            || self.key.chars().any(char::is_control)
            || self.format.is_empty()
            || self.retry > (1 << 53) - 1
        {
            return Err(crate::Error::Invalid(
                "invalid editor persistence identity".into(),
            ));
        }
        Ok(())
    }
    fn same_identity(&self, other: &Self) -> bool {
        self.key == other.key
            && self.format == other.format
            && self.data_source == other.data_source
    }
    fn stored_format(&self) -> String {
        format!("maka.ui.editor@1/{}", self.format)
    }
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    snapshot: EditorSnapshot,
    metadata: Value,
}
pub struct Loaded {
    version: u64,
    saved: Saved,
    text: String,
    _memory: (Permit, Option<Permit>),
}
pub struct Restore {
    pub clear_text: bool,
    loaded: Arc<Loaded>,
}
impl Restore {
    pub fn text(&self) -> &str {
        if self.clear_text {
            ""
        } else {
            &self.loaded.text
        }
    }
    pub fn snapshot(&self) -> Option<&EditorSnapshot> {
        (!self.clear_text).then_some(&self.loaded.saved.snapshot)
    }
}
struct Save {
    sequence: u64,
    saved: Saved,
    text: Vec<u8>,
    _memory: Permit,
}
#[derive(Clone)]
enum Reply {
    Loaded(Option<Arc<Loaded>>),
    Saved(u64),
    Failed { writing: bool, diagnostic: String },
}
enum Phase {
    Loading,
    Restore(Arc<Loaded>),
    Ready,
    Failed { writing: bool, diagnostic: String },
}
/// The physical native editor owns this worker and closes it before its resource
/// group is sealed. Only immutable snapshots cross onto the database executor.
pub struct EditorCheckpoint {
    policy: EditorPersistence,
    worker: Option<worker::Worker>,
    budget: NativeBudget,
    phase: Phase,
    sequence: u64,
    saved_sequence: u64,
    last: Option<Saved>,
    observed: Option<EditorCheckpointObservation>,
    force_save: bool,
    capture_failure: Option<String>,
}
impl EditorCheckpoint {
    pub fn new(
        scope: Option<Scope>,
        policy: &EditorPersistence,
        resources: &Arc<Resources>,
        budget: NativeBudget,
    ) -> Self {
        let opened = scope
            .ok_or_else(|| "editor persistence requires an owned UI Root".to_owned())
            .and_then(|scope| {
                worker::Worker::start(scope, policy.clone(), resources, budget.clone())
            });
        let (worker, phase) = match opened {
            Ok(worker) => (Some(worker), Phase::Loading),
            Err(diagnostic) => (
                None,
                Phase::Failed {
                    writing: false,
                    diagnostic,
                },
            ),
        };
        Self {
            policy: policy.clone(),
            worker,
            budget,
            phase,
            sequence: 0,
            saved_sequence: 0,
            last: None,
            observed: None,
            force_save: false,
            capture_failure: None,
        }
    }
    pub fn accepts_input(&self) -> bool {
        self.writable() && self.saved_sequence > 0
    }
    pub fn writable(&self) -> bool {
        matches!(self.phase, Phase::Ready)
    }
    pub fn poll(&mut self, policy: &EditorPersistence) {
        if !self.policy.same_identity(policy) {
            self.phase = Phase::Failed {
                writing: false,
                diagnostic: "editor persistence identity changed on the original mount".into(),
            };
            return;
        }
        if let Some(reply) = self.worker.as_mut().and_then(worker::Worker::poll) {
            self.phase = match reply {
                Reply::Loaded(Some(loaded)) => Phase::Restore(loaded),
                Reply::Loaded(None) => Phase::Ready,
                Reply::Saved(sequence) => {
                    self.saved_sequence = sequence;
                    Phase::Ready
                }
                Reply::Failed {
                    writing,
                    diagnostic,
                } => Phase::Failed {
                    writing,
                    diagnostic,
                },
            };
        }
        // A previous write acknowledgement cannot account for a newer snapshot
        // that failed admission before it reached the worker.
        if let Some(diagnostic) = &self.capture_failure {
            self.phase = Phase::Failed {
                writing: true,
                diagnostic: diagnostic.clone(),
            };
        }
        if policy.retry > self.policy.retry {
            // Re-expose held native metadata when a product returns to this
            // draft; the native owner remains the only retained body owner.
            if matches!(self.phase, Phase::Restore(_)) {
                self.observed = None;
            }
            if let Phase::Failed { writing, .. } = self.phase {
                if writing {
                    self.capture_failure = None;
                    self.phase = Phase::Ready;
                    self.force_save = true;
                } else if let Some(worker) = &self.worker {
                    worker.load();
                    self.phase = Phase::Loading;
                }
            }
            self.policy.retry = policy.retry;
        }
    }
    pub fn restoration(&self, owner: &str, policy: &EditorPersistence) -> Option<Restore> {
        let Phase::Restore(loaded) = &self.phase else {
            return None;
        };
        let command = policy.restore.as_ref()?;
        (command.owner == owner && command.version == loaded.version).then(|| Restore {
            clear_text: command.clear_text,
            loaded: loaded.clone(),
        })
    }
    pub fn restored(&mut self) {
        self.phase = Phase::Ready;
        self.last = None;
        self.force_save = true;
    }
    pub fn reject_restore(&mut self, diagnostic: &str) {
        self.phase = Phase::Failed {
            writing: false,
            diagnostic: diagnostic.into(),
        };
    }
    pub fn needs_save(&self, snapshot: &EditorSnapshot, metadata: &Value) -> bool {
        self.writable()
            && snapshot.marked.is_none()
            && (self.force_save
                || self
                    .last
                    .as_ref()
                    .is_none_or(|saved| &saved.snapshot != snapshot || &saved.metadata != metadata))
    }
    pub fn save(&mut self, snapshot: &EditorSnapshot, text: &str, metadata: &Value) {
        self.capture(snapshot, metadata, || text.to_owned());
    }
    pub fn capture(
        &mut self,
        snapshot: &EditorSnapshot,
        metadata: &Value,
        text: impl FnOnce() -> String,
    ) {
        if !self.writable() || snapshot.marked.is_some() {
            return;
        }
        let saved = Saved {
            snapshot: snapshot.clone(),
            metadata: metadata.clone(),
        };
        if !self.force_save && self.last.as_ref() == Some(&saved) {
            return;
        }
        let result = (|| {
            let metadata_size = maka_plugin_core::json::encoded_size(&saved, usize::MAX)
                .map_err(|error| error.to_string())?;
            let size = snapshot
                .text
                .bytes
                .checked_add(metadata_size)
                .ok_or("editor checkpoint size overflow")?;
            let memory = self
                .budget
                .reserve(Kind::Encoded, size)
                .map_err(|error| error.to_string())?;
            let text = text();
            if text.len() != snapshot.text.bytes {
                return Err("native editor snapshot length changed".into());
            }
            self.sequence = self
                .sequence
                .checked_add(1)
                .ok_or("editor checkpoint sequence exhausted")?;
            let save = Save {
                sequence: self.sequence,
                saved: saved.clone(),
                text: text.into_bytes(),
                _memory: memory,
            };
            self.worker
                .as_ref()
                .ok_or("editor checkpoint writer unavailable")?
                .save(save);
            Ok::<_, String>(())
        })();
        match result {
            Ok(()) => {
                self.last = Some(saved);
                self.force_save = false;
            }
            Err(diagnostic) => {
                self.capture_failure = Some(diagnostic.clone());
                if let Some(worker) = &self.worker {
                    worker.unsaved(diagnostic.clone());
                }
                self.phase = Phase::Failed {
                    writing: true,
                    diagnostic,
                };
            }
        }
    }
    pub fn observe(&mut self, owner: &str) -> Option<EditorCheckpointObservation> {
        let state = match &self.phase {
            Phase::Loading => EditorCheckpointState::Loading,
            Phase::Restore(loaded) => EditorCheckpointState::Restore {
                version: loaded.version,
                snapshot: loaded.saved.snapshot.clone(),
                metadata: loaded.saved.metadata.clone(),
            },
            Phase::Ready => EditorCheckpointState::Ready {
                saved: self.last.is_some() && self.saved_sequence == self.sequence,
                initialized: self.saved_sequence > 0,
            },
            Phase::Failed { diagnostic, .. } => EditorCheckpointState::Failed {
                diagnostic: diagnostic.clone(),
            },
        };
        let observation = EditorCheckpointObservation {
            owner: owner.into(),
            state,
        };
        if self.observed.as_ref() == Some(&observation) {
            return None;
        }
        self.observed = Some(observation.clone());
        Some(observation)
    }
    pub fn close(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.close();
        }
    }
}
impl Drop for EditorCheckpoint {
    fn drop(&mut self) {
        self.close();
    }
}

/// Convert only exact grapheme boundaries; never relocate an invalid restored caret.
pub fn selection_bytes(text: &str, snapshot: Option<&EditorSnapshot>) -> Option<(usize, usize)> {
    use unicode_segmentation::UnicodeSegmentation;
    let Some(snapshot) = snapshot else {
        return Some((0, 0));
    };
    let mut offset = 0;
    let mut start = None;
    let mut end = None;
    for (byte, grapheme) in text
        .grapheme_indices(true)
        .chain(std::iter::once((text.len(), "")))
    {
        if offset == snapshot.selection.start {
            start = Some(byte);
        }
        if offset == snapshot.selection.end {
            end = Some(byte);
        }
        offset += grapheme.encode_utf16().count();
    }
    let (start, end) = (start?, end?);
    Some(if snapshot.reversed {
        (end, start)
    } else {
        (start, end)
    })
}
