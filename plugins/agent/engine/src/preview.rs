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

use maka_agent_facts::{context::ModelPurpose, event::EventWrite, model::assembly::AttemptCut};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

pub(crate) type Reader = watch::Receiver<Option<Arc<AttemptCut>>>;

struct State {
    latest: Arc<AttemptCut>,
    publication: Option<EventWrite>,
}

pub(crate) enum PublicationSelection {
    New(EventWrite),
    Existing(EventWrite),
}

pub(crate) struct Finalizer {
    pub(crate) item_acceptance: bool,
    state: Mutex<State>,
}

impl Finalizer {
    pub(crate) fn snapshot(&self) -> Arc<AttemptCut> {
        self.state
            .lock()
            .expect("attempt state lock poisoned")
            .latest
            .clone()
    }

    pub(crate) fn publication(&self) -> Option<EventWrite> {
        self.state
            .lock()
            .expect("attempt state lock poisoned")
            .publication
            .clone()
    }

    /// A concurrent cleanup observer must retain the original publication identity.
    pub(crate) fn prepare(&self, publication: EventWrite) -> PublicationSelection {
        let mut state = self.state.lock().expect("attempt state lock poisoned");
        if let Some(original) = &state.publication {
            PublicationSelection::Existing(original.clone())
        } else {
            state.publication = Some(publication.clone());
            PublicationSelection::New(publication)
        }
    }
}

pub(crate) struct Attempts {
    active: Mutex<HashMap<String, Arc<Finalizer>>>,
    current: watch::Sender<Option<Arc<AttemptCut>>>,
}

impl Default for Attempts {
    fn default() -> Self {
        let (current, _) = watch::channel(None);
        Self {
            active: Mutex::default(),
            current,
        }
    }
}

impl Attempts {
    pub(crate) fn subscribe(&self) -> Reader {
        self.current.subscribe()
    }

    pub(crate) fn register(&self, cut: Arc<AttemptCut>, item_acceptance: bool) -> Arc<Finalizer> {
        let finalizer = Arc::new(Finalizer {
            item_acceptance,
            state: Mutex::new(State {
                latest: cut.clone(),
                publication: None,
            }),
        });
        let previous = self
            .active
            .lock()
            .expect("active attempts lock poisoned")
            .insert(cut.binding.step_id.clone(), finalizer.clone());
        drop(previous);
        self.publish(&finalizer, cut);
        finalizer
    }

    pub(crate) fn publish(&self, finalizer: &Finalizer, cut: Arc<AttemptCut>) {
        let previous = {
            let mut state = finalizer.state.lock().expect("attempt state lock poisoned");
            if state.publication.is_some() {
                return;
            }
            let previous = std::mem::replace(&mut state.latest, cut.clone());
            let preview = if cut.binding.purpose == ModelPurpose::Main {
                self.current.send_replace(Some(cut))
            } else {
                None
            };
            (previous, preview)
        };
        drop(previous);
    }

    pub(crate) fn remove(&self, step_id: &str) {
        let removed = self
            .active
            .lock()
            .expect("active attempts lock poisoned")
            .remove(step_id);
        let previous = if let Some(finalizer) = &removed {
            let _state = finalizer.state.lock().expect("attempt state lock poisoned");
            let clear = self
                .current
                .borrow()
                .as_ref()
                .is_some_and(|cut| cut.binding.step_id == step_id);
            if clear {
                self.current.send_replace(None)
            } else {
                None
            }
        } else {
            None
        };
        drop(previous);
        drop(removed);
    }

    pub(crate) fn unfinished(&self) -> Vec<Arc<Finalizer>> {
        self.active
            .lock()
            .expect("active attempts lock poisoned")
            .values()
            .cloned()
            .collect()
    }
}
