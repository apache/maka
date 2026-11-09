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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// An explicit test domain owner; drafts cannot publish through the reader.
    #[derive(Default)]
    struct Owner {
        values: Mutex<BTreeMap<String, Vec<u8>>>,
        loaded: Mutex<BTreeSet<String>>,
        unavailable: AtomicBool,
        reads: AtomicUsize,
    }
    impl Owner {
        fn session(self: &Arc<Self>) -> Session {
            Session::new(self.clone())
        }
        fn accept(&self, draft: SessionDraft) -> Result<()> {
            self.available()?;
            self.values.lock().unwrap().extend(draft.values);
            if let Some(names) = draft.loaded_tools {
                *self.loaded.lock().unwrap() = names;
            }
            Ok(())
        }
        fn available(&self) -> Result<()> {
            if self.unavailable.load(Ordering::SeqCst) {
                Err(Error::Unavailable("test owner unavailable".into()))
            } else {
                Ok(())
            }
        }
    }
    impl SessionDataReader for Owner {
        fn load(&self, key: &str) -> Result<Option<Vec<u8>>> {
            self.available()?;
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn loaded(&self) -> Result<BTreeSet<String>> {
            self.available()?;
            Ok(self.loaded.lock().unwrap().clone())
        }
    }

    #[test]
    fn draft_reads_and_publication_visit_only_accessed_keys() {
        for live_keys in [1_000, 10_000, 100_000] {
            let owner = Arc::new(Owner::default());
            *owner.values.lock().unwrap() = (0..live_keys)
                .map(|n| (format!("{n:08}"), b"0".to_vec()))
                .collect();
            let draft = owner.session().draft();
            assert_eq!(owner.reads.load(Ordering::SeqCst), 0);
            assert_eq!(draft.load("00000000").unwrap(), Some(json!(0)));
            assert_eq!(draft.load("00000000").unwrap(), Some(json!(0)));
            draft.store("00000000", &json!(1)).unwrap();
            let changes = draft.freeze().unwrap();
            assert_eq!(changes.values.len(), 1);
            owner.accept(changes).unwrap();
            assert_eq!(owner.values.lock().unwrap().len(), live_keys);
            assert_eq!(
                owner.session().draft().load("00000000").unwrap(),
                Some(json!(1))
            );
            assert_eq!(owner.reads.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn drafts_read_own_writes_and_publish_only_changed_keys() {
        let owner = Arc::new(Owner::default());
        let session = owner.session();
        let seed = session.draft();
        seed.store("a", &json!(1)).unwrap();
        owner.accept(seed.freeze().unwrap()).unwrap();
        let first = session.draft();
        // First reads, including absence, are stable within this Cell.
        assert_eq!(first.load("a").unwrap(), Some(json!(1)));
        assert_eq!(first.load("b").unwrap(), None);
        let second = session.draft();
        second.store("a", &json!(2)).unwrap();
        second.store("b", &json!(3)).unwrap();
        owner.accept(second.freeze().unwrap()).unwrap();
        assert_eq!(first.load("a").unwrap(), Some(json!(1)));
        assert_eq!(first.load("b").unwrap(), None);
        first.store("a", &json!(4)).unwrap();
        assert_eq!(first.load("a").unwrap(), Some(json!(4)));
        owner.accept(first.freeze().unwrap()).unwrap();
        assert!(matches!(first.freeze(), Err(Error::Frozen)));
        let latest = session.draft();
        assert_eq!(latest.load("a").unwrap(), Some(json!(4)));
        assert_eq!(latest.load("b").unwrap(), Some(json!(3)));
        let abandoned = session.draft();
        abandoned.store("a", &json!(99)).unwrap();
        drop(abandoned);
        assert_eq!(session.draft().load("a").unwrap(), Some(json!(4)));
    }

    #[test]
    fn old_draft_does_not_pin_canonical_intermediate_values() {
        let owner = Arc::new(Owner::default());
        let session = owner.session();
        let seed = session.draft();
        seed.store("key", &json!(0)).unwrap();
        owner.accept(seed.freeze().unwrap()).unwrap();
        let old = session.draft();
        assert_eq!(old.load("key").unwrap(), Some(json!(0)));
        for index in [1, 2] {
            let cell = session.draft();
            cell.store("key", &json!(index)).unwrap();
            owner.accept(cell.freeze().unwrap()).unwrap();
        }
        assert_eq!(old.load("key").unwrap(), Some(json!(0)));
        assert_eq!(session.draft().load("key").unwrap(), Some(json!(2)));
        assert_eq!(owner.values.lock().unwrap().len(), 1);
        drop(old);
        assert_eq!(owner.values.lock().unwrap().len(), 1);
    }

    #[test]
    fn unavailable_owner_fences_reads_and_acceptance_without_crossing_sessions() {
        let owner = Arc::new(Owner::default());
        let session = owner.session();
        let unused = session.clone();
        let old = session.draft();
        old.store("key", &json!(1)).unwrap();
        owner.unavailable.store(true, Ordering::SeqCst);
        assert!(matches!(
            unused.draft().load("missing"),
            Err(Error::Unavailable(_))
        ));
        assert!(matches!(old.load("missing"), Err(Error::Unavailable(_))));
        assert!(matches!(
            owner.accept(old.freeze().unwrap()),
            Err(Error::Unavailable(_))
        ));
        assert!(matches!(
            owner.session().draft().load("missing"),
            Err(Error::Unavailable(_))
        ));
        let other = Arc::new(Owner::default());
        let live = other.session().draft();
        live.store("key", &json!(2)).unwrap();
        drop(old);
        other.accept(live.freeze().unwrap()).unwrap();
        assert_eq!(other.session().draft().load("key").unwrap(), Some(json!(2)));
    }

    #[test]
    fn discovery_drafts_share_only_their_scope_and_publish_explicitly() {
        let first = Arc::new(Owner::default());
        let second = Arc::new(Owner::default());
        let session = first.session();
        let same_scope = session.clone();
        session
            .update_loaded(|names| {
                names.insert("search".into());
            })
            .unwrap();
        let other_session = second.session();
        other_session
            .update_loaded(|names| {
                names.insert("read".into());
            })
            .unwrap();
        assert_eq!(
            same_scope.loaded().unwrap(),
            BTreeSet::from(["search".into()])
        );
        assert!(session.fork_draft().loaded().unwrap().is_empty());
        first
            .accept(SessionDraft {
                values: BTreeMap::new(),
                loaded_tools: session.take_loaded_changes().unwrap(),
            })
            .unwrap();
        second
            .accept(SessionDraft {
                values: BTreeMap::new(),
                loaded_tools: other_session.take_loaded_changes().unwrap(),
            })
            .unwrap();
        assert_eq!(
            first.session().loaded().unwrap(),
            BTreeSet::from(["search".into()])
        );
        session.update_loaded(BTreeSet::clear).unwrap();
        first
            .accept(SessionDraft {
                values: BTreeMap::new(),
                loaded_tools: session.take_loaded_changes().unwrap(),
            })
            .unwrap();
        assert!(same_scope.loaded().unwrap().is_empty());
        assert_eq!(
            second.session().loaded().unwrap(),
            BTreeSet::from(["read".into()])
        );
    }

    #[test]
    fn concurrent_cells_merge_distinct_keys_and_order_same_key_by_acceptance() {
        let owner = Arc::new(Owner::default());
        let session = owner.session();
        let first = session.draft();
        let second = session.draft();
        assert_eq!(second.load("left").unwrap(), None);
        let (accepted, ready) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let first_owner = owner.clone();
            scope.spawn(move || {
                first.store("left", &json!(1)).unwrap();
                first.store("same", &json!("first")).unwrap();
                first_owner.accept(first.freeze().unwrap()).unwrap();
                accepted.send(()).unwrap();
            });
            let second_owner = owner.clone();
            scope.spawn(move || {
                second.store("right", &json!(2)).unwrap();
                second.store("same", &json!("second")).unwrap();
                ready.recv().unwrap();
                assert_eq!(second.load("left").unwrap(), None);
                second_owner.accept(second.freeze().unwrap()).unwrap();
            });
        });
        let final_state = session.draft();
        assert_eq!(final_state.load("left").unwrap(), Some(json!(1)));
        assert_eq!(final_state.load("right").unwrap(), Some(json!(2)));
        assert_eq!(final_state.load("same").unwrap(), Some(json!("second")));
    }

    #[test]
    fn sessions_keep_values_and_cancelled_staging_independent() {
        let first = Arc::new(Owner::default());
        let second = Arc::new(Owner::default());
        for (owner, value) in [(&first, "first"), (&second, "second")] {
            let draft = owner.session().draft();
            draft.store("key", &json!(value)).unwrap();
            owner.accept(draft.freeze().unwrap()).unwrap();
        }
        let abandoned = first.session().draft();
        abandoned.store("key", &json!("unpublished")).unwrap();
        abandoned.store("cancelled", &json!(true)).unwrap();
        drop(abandoned);
        assert_eq!(
            first.session().draft().load("key").unwrap(),
            Some(json!("first"))
        );
        assert_eq!(first.session().draft().load("cancelled").unwrap(), None);
        assert_eq!(
            second.session().draft().load("key").unwrap(),
            Some(json!("second"))
        );
        assert_eq!(first.values.lock().unwrap().len(), 1);
        assert_eq!(second.values.lock().unwrap().len(), 1);
    }

    #[test]
    fn storage_failure_is_not_a_missing_key() {
        let owner = Arc::new(Owner::default());
        let session = owner.session();
        let draft = session.draft();
        owner.unavailable.store(true, Ordering::SeqCst);
        assert!(matches!(draft.load("missing"), Err(Error::Unavailable(_))));
        drop(draft);
        assert!(matches!(
            session.draft().load("missing"),
            Err(Error::Unavailable(_))
        ));
        assert!(matches!(session.loaded(), Err(Error::Unavailable(_))));
    }
}
