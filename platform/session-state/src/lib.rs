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

//! Synchronous SessionData reads and private Cell drafts. Canonical publication
//! belongs to the domain owner and its Root transaction, never this crate.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, MutexGuard},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("session state JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session draft is frozen")]
    Frozen,
    #[error("session state unavailable: {0}")]
    Unavailable(String),
}
pub type Result<T> = std::result::Result<T, Error>;

/// A session-bound read port. Implementations read canonical JSON bytes and
/// discovery facts. Blocking adapters must only be called on dedicated VM or
/// blocking threads, not on async executor workers.
pub trait SessionDataReader: Send + Sync {
    fn load(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn loaded(&self) -> Result<BTreeSet<String>>;
}

#[derive(Clone)]
pub struct Session(Arc<SessionInner>);

struct SessionInner {
    reader: Arc<dyn SessionDataReader>,
    loaded: Mutex<Option<BTreeSet<String>>>,
}

/// Serialized JSON write set, not a published snapshot. The owner must append
/// these values and completion acceptance in the same canonical transaction.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SessionDraft {
    pub values: BTreeMap<String, Vec<u8>>,
    pub loaded_tools: Option<BTreeSet<String>>,
}

pub struct Draft {
    reader: Arc<dyn SessionDataReader>,
    state: Mutex<Option<DraftState>>,
}

#[derive(Default)]
struct DraftState {
    reads: BTreeMap<String, Option<Vec<u8>>>,
    values: BTreeMap<String, Vec<u8>>,
    loaded_tools: Option<BTreeSet<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| Error::Unavailable("session draft lock poisoned".into()))
}

fn decode(bytes: &[u8]) -> Result<Value> {
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    decoder.disable_recursion_limit();
    let value = Value::deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(value)
}

impl Session {
    pub fn new(reader: Arc<dyn SessionDataReader>) -> Self {
        Self(Arc::new(SessionInner {
            reader,
            loaded: Mutex::new(None),
        }))
    }

    /// Bind an independent discovery draft to the same canonical reader.
    /// Cloning a Session instead shares its pending discovery changes.
    pub fn fork_draft(&self) -> Self {
        Self::new(self.0.reader.clone())
    }

    pub fn draft(&self) -> Draft {
        Draft {
            reader: self.0.reader.clone(),
            state: Mutex::new(Some(DraftState::default())),
        }
    }

    pub fn loaded(&self) -> Result<BTreeSet<String>> {
        let loaded = lock(&self.0.loaded)?;
        match loaded.as_ref() {
            Some(names) => Ok(names.clone()),
            None => self.0.reader.loaded(),
        }
    }

    /// Stage only; callers own canonical acceptance and publication.
    pub fn stage_loaded(&self, names: BTreeSet<String>) -> Result<()> {
        *lock(&self.0.loaded)? = Some(names);
        Ok(())
    }

    pub fn update_loaded(&self, update: impl FnOnce(&mut BTreeSet<String>)) -> Result<()> {
        let mut loaded = lock(&self.0.loaded)?;
        if loaded.is_none() {
            *loaded = Some(self.0.reader.loaded()?);
        }
        update(loaded.as_mut().expect("loaded draft initialized"));
        Ok(())
    }

    /// Take only this discovery scope's changes. Use fork_draft before binding
    /// independent tool calls; this must not drain another Cell's staging.
    pub fn take_loaded_changes(&self) -> Result<Option<BTreeSet<String>>> {
        Ok(lock(&self.0.loaded)?.take())
    }
}

impl Draft {
    /// Read own writes first; other keys capture their first canonical read,
    /// including absence. No full-session snapshot or eager copying is needed.
    pub fn load(&self, key: &str) -> Result<Option<Value>> {
        let bytes = {
            let mut state = lock(&self.state)?;
            let state = state.as_mut().ok_or(Error::Frozen)?;
            if let Some(bytes) = state.values.get(key) {
                Some(bytes.clone())
            } else {
                if !state.reads.contains_key(key) {
                    state.reads.insert(key.into(), self.reader.load(key)?);
                }
                state.reads[key].clone()
            }
        };
        bytes.as_deref().map(decode).transpose()
    }

    pub fn store(&self, key: &str, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        let mut state = lock(&self.state)?;
        let state = state.as_mut().ok_or(Error::Frozen)?;
        state.reads.remove(key);
        state.values.insert(key.into(), bytes);
        Ok(())
    }

    /// Discovery changes must be explicitly routed to this Cell's draft, not
    /// implicitly taken from the Session shared by concurrent Cells.
    pub fn stage_loaded(&self, names: BTreeSet<String>) -> Result<()> {
        let mut state = lock(&self.state)?;
        state
            .as_mut()
            .ok_or(Error::Frozen)?
            .loaded_tools
            .get_or_insert_default()
            .extend(names);
        Ok(())
    }

    /// Seal and transfer the write set exactly once. Dropping a live or frozen
    /// draft has no external effects; there is deliberately no commit method.
    pub fn freeze(&self) -> Result<SessionDraft> {
        let state = lock(&self.state)?.take().ok_or(Error::Frozen)?;
        Ok(SessionDraft {
            values: state.values,
            loaded_tools: state.loaded_tools,
        })
    }
}

/// Explicitly ephemeral scratch for standalone interpreters and CUA. This
/// backend never publishes values; Agent sessions must use a canonical reader.
#[derive(Clone, Default)]
pub struct Backend(Arc<Mutex<BTreeMap<String, Session>>>);

struct EphemeralReader;

impl SessionDataReader for EphemeralReader {
    fn load(&self, _key: &str) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }

    fn loaded(&self) -> Result<BTreeSet<String>> {
        Ok(BTreeSet::new())
    }
}

impl Backend {
    pub fn temporary() -> Result<Self> {
        Ok(Self::default())
    }

    pub fn session(&self, id: &str) -> Session {
        self.0
            .lock()
            .expect("ephemeral session registry lock poisoned")
            .entry(id.into())
            .or_insert_with(|| Session::new(Arc::new(EphemeralReader)))
            .clone()
    }
}
