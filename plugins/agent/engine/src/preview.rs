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

use maka_agent_facts::{
    context::ModelPurpose,
    event::EventWrite,
    model::assembly::{AttemptBinding, AttemptCut},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

pub(crate) type Reader = watch::Receiver<Option<Arc<AttemptCut>>>;

enum State {
    Receiving(Arc<AttemptCut>),
    PublishingPrefix {
        latest: Arc<AttemptCut>,
        writes: Arc<[EventWrite]>,
    },
    Terminal {
        latest: Arc<AttemptCut>,
        publication: EventWrite,
    },
    Confirmed {
        binding: AttemptBinding,
        event_id: String,
        sequence: u64,
    },
}

impl State {
    fn latest(&self) -> &Arc<AttemptCut> {
        match self {
            Self::Receiving(latest)
            | Self::PublishingPrefix { latest, .. }
            | Self::Terminal { latest, .. } => latest,
            Self::Confirmed { .. } => panic!("confirmed attempt has no body snapshot"),
        }
    }
}

pub(crate) enum PublicationSelection {
    New(EventWrite),
    Existing(EventWrite),
    PrefixPending,
    Confirmed,
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
            .latest()
            .clone()
    }

    pub(crate) fn unconfirmed_snapshot(&self) -> Option<Arc<AttemptCut>> {
        let state = self.state.lock().expect("attempt state lock poisoned");
        match &*state {
            State::Confirmed { .. } => None,
            other => Some(other.latest().clone()),
        }
    }

    pub(crate) fn publication(&self) -> Option<EventWrite> {
        match &*self.state.lock().expect("attempt state lock poisoned") {
            State::Terminal { publication, .. } => Some(publication.clone()),
            _ => None,
        }
    }

    pub(crate) fn has_publication(&self) -> bool {
        !matches!(
            &*self.state.lock().expect("attempt state lock poisoned"),
            State::Receiving(_)
        )
    }

    pub(crate) fn confirmed_event_id(&self) -> Option<String> {
        match &*self.state.lock().expect("attempt state lock poisoned") {
            State::Confirmed { event_id, .. } => Some(event_id.clone()),
            _ => None,
        }
    }

    pub(crate) fn terminal_confirmed(&self) -> bool {
        matches!(
            &*self.state.lock().expect("attempt state lock poisoned"),
            State::Confirmed { .. }
        )
    }

    pub(crate) fn binding(&self) -> AttemptBinding {
        let state = self.state.lock().expect("attempt state lock poisoned");
        match &*state {
            State::Confirmed { binding, .. } => binding.clone(),
            other => other.latest().binding.clone(),
        }
    }

    pub(crate) fn receipt_terminal(&self, write: &EventWrite, sequence: u64) {
        let mut state = self.state.lock().expect("attempt state lock poisoned");
        let retired = match &*state {
            State::Terminal {
                latest,
                publication,
            } => {
                assert_eq!(
                    publication.event().id,
                    write.event().id,
                    "terminal receipt identity changed"
                );
                let confirmed = State::Confirmed {
                    binding: latest.binding.clone(),
                    event_id: write.event().id.clone(),
                    sequence,
                };
                Some(std::mem::replace(&mut *state, confirmed))
            }
            State::Confirmed {
                event_id,
                sequence: original,
                ..
            } => {
                assert_eq!(
                    event_id,
                    &write.event().id,
                    "terminal receipt identity changed"
                );
                assert_eq!(*original, sequence, "terminal receipt sequence changed");
                None
            }
            _ => panic!("terminal receipt requires an original publication"),
        };
        drop(state);
        drop(retired);
    }

    pub(crate) fn freeze_prefix(&self, latest: Arc<AttemptCut>, writes: Arc<[EventWrite]>) {
        let mut state = self.state.lock().expect("attempt state lock poisoned");
        assert!(
            matches!(&*state, State::Receiving(_)),
            "attempt already publishing"
        );
        *state = State::PublishingPrefix { latest, writes };
    }

    pub(crate) fn prefix(&self) -> Option<(Arc<AttemptCut>, Arc<[EventWrite]>)> {
        match &*self.state.lock().expect("attempt state lock poisoned") {
            State::PublishingPrefix { latest, writes } => Some((latest.clone(), writes.clone())),
            _ => None,
        }
    }

    pub(crate) fn receipt_prefix(&self, writes: &[EventWrite], latest: Arc<AttemptCut>) {
        let mut state = self.state.lock().expect("attempt state lock poisoned");
        if let State::PublishingPrefix {
            writes: original, ..
        } = &*state
        {
            assert!(
                original
                    .iter()
                    .map(|write| &write.event().id)
                    .eq(writes.iter().map(|write| &write.event().id)),
                "prefix receipt identity changed"
            );
            *state = State::Receiving(latest);
        }
    }

    /// A concurrent cleanup observer must retain the original publication identity.
    pub(crate) fn prepare(&self, publication: EventWrite) -> PublicationSelection {
        let mut state = self.state.lock().expect("attempt state lock poisoned");
        match &*state {
            State::Terminal {
                publication: original,
                ..
            } => PublicationSelection::Existing(original.clone()),
            State::PublishingPrefix { .. } => PublicationSelection::PrefixPending,
            State::Confirmed { .. } => PublicationSelection::Confirmed,
            State::Receiving(latest) => {
                *state = State::Terminal {
                    latest: latest.clone(),
                    publication: publication.clone(),
                };
                PublicationSelection::New(publication)
            }
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
            state: Mutex::new(State::Receiving(cut.clone())),
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
            let State::Receiving(latest) = &mut *state else {
                return;
            };
            let previous = std::mem::replace(latest, cut.clone());
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

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        event::{Fact, Invocation, ModelInterruption, RuntimeEvent},
        model::assembly::AttemptWriter,
    };

    fn cut(step: &str) -> Arc<AttemptCut> {
        AttemptWriter::new(
            AttemptBinding {
                invocation: Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                step_id: step.into(),
                purpose: ModelPurpose::Main,
            },
            true,
        )
        .unwrap()
        .snapshot()
    }

    #[test]
    fn confirmed_terminal_retires_registered_roots_without_clearing_newer_preview() {
        let attempts = Attempts::default();
        let original = cut("old");
        let weak = Arc::downgrade(&original);
        let finalizer = attempts.register(original.clone(), true);
        let publication = EventWrite::plain(RuntimeEvent::new(
            original.binding.invocation.clone(),
            Fact::ModelInterrupted {
                step_id: "old".into(),
                status: ModelInterruption::Cancelled,
                diagnostic: None,
                model_failure: None,
                partial: None,
            },
        ))
        .unwrap();
        let PublicationSelection::New(publication) = finalizer.prepare(publication) else {
            panic!("first publication is new");
        };
        let replacement = EventWrite::plain(RuntimeEvent::new(
            original.binding.invocation.clone(),
            publication.event().fact.clone(),
        ))
        .unwrap();
        let PublicationSelection::Existing(retained) = finalizer.prepare(replacement) else {
            panic!("unknown publication keeps original identity");
        };
        assert_eq!(retained.event().id, publication.event().id);
        drop(retained);
        let newer = cut("new");
        let _new_finalizer = attempts.register(newer.clone(), true);
        finalizer.receipt_terminal(&publication, 7);
        attempts.remove("old");
        assert!(finalizer.terminal_confirmed());
        assert!(finalizer.publication().is_none());
        assert_eq!(finalizer.binding().step_id, "old");
        assert_eq!(
            attempts
                .subscribe()
                .borrow()
                .as_ref()
                .unwrap()
                .binding
                .step_id,
            "new"
        );
        assert_eq!(
            original.binding.step_id, "old",
            "external stable cuts remain readable"
        );
        drop(original);
        assert!(
            weak.upgrade().is_none(),
            "local Finalizer retains no old cut after receipt"
        );
    }
}
