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

use super::Snapshot;
use crate::{
    app::{App, Focus, Notice},
    apps::{Checkpoint, Key},
    navigation::Navigation,
};
use std::collections::BTreeMap;

/// The current event's effect on the derived checkpoint accounting. Neither
/// cached sizes nor this transient classification authorize a remote write.
#[derive(Clone, Copy, Default)]
pub(crate) enum Impact {
    /// The owner replacement was checked before committing its field or write.
    LocalField,
    /// Only a plugin reader/cursor moved; legal cursor representations are covered.
    Reading,
    #[default]
    Other,
}

#[derive(Default)]
pub(crate) struct Budget {
    current: Option<Charges>,
    input: Impact,
}

struct Charges {
    shell: usize,
    owners: BTreeMap<Key, usize>,
    total: usize,
}
impl Charges {
    fn bytes(&self) -> usize {
        self.shell
            .saturating_add(self.total)
            .saturating_add(self.owners.len().saturating_sub(1))
    }
    fn replace(&mut self, key: Key, bytes: Option<usize>) {
        if let Some(previous) = self.owners.remove(&key) {
            self.total = self.total.saturating_sub(previous);
        }
        if let Some(bytes) = bytes {
            self.total = self.total.saturating_add(bytes);
            self.owners.insert(key, bytes);
        }
    }
    fn fits(&self, key: &Key, bytes: Option<usize>) -> bool {
        if !super::super::store::fits(self.shell) || self.total == usize::MAX {
            return false;
        }
        let previous = self.owners.get(key).copied();
        let count =
            self.owners.len() - usize::from(previous.is_some()) + usize::from(bytes.is_some());
        let total = self
            .shell
            .saturating_add(self.total.saturating_sub(previous.unwrap_or(0)))
            .saturating_add(bytes.unwrap_or(0))
            .saturating_add(count.saturating_sub(1));
        super::super::store::fits(total)
    }
}

#[cfg(test)]
thread_local! { static CHECKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

impl Snapshot {
    fn candidate(app: &App, navigation: Option<(&Navigation, bool, Option<Focus>)>) -> Self {
        let mut snapshot = Self::capture(app, app.checkpoint_root());
        if let Some((navigation, leaving, preserved)) = navigation {
            snapshot.navigation = navigation.clone();
            if let crate::navigation::Route::Session(id) = &navigation.location().route {
                if !snapshot.tabs.contains(id) {
                    snapshot.tabs.push(id.clone());
                }
                snapshot
                    .drafts
                    .entry(id.clone())
                    .or_insert_with(|| crate::editor::Editor::default().save());
            }
            snapshot.pages = app.saved_pages_at(navigation.location(), leaving, preserved);
        }
        snapshot
    }

    fn charges(&mut self, app: &App) -> Charges {
        let checkpoints = std::mem::take(&mut self.apps);
        let shell = serde_json::to_vec(self).map_or(usize::MAX, |bytes| bytes.len());
        let mut charges = Charges {
            shell,
            owners: BTreeMap::new(),
            total: 0,
        };
        for checkpoint in &checkpoints {
            let bytes = checkpoint.capacity_bytes().unwrap_or(usize::MAX);
            charges.replace(
                checkpoint.address().clone(),
                Some(if app.apps.reserves_checkpoint(checkpoint.address()) {
                    bytes.max(crate::apps::CHECKPOINT_MAX_BYTES)
                } else {
                    bytes
                }),
            );
        }
        self.apps = checkpoints;
        charges
    }
}

impl App {
    #[cfg(test)]
    pub(crate) fn admission_checks() -> usize {
        CHECKS.get()
    }

    pub(crate) fn checkpoint_changed(&mut self, impact: Impact) {
        if matches!(impact, Impact::Other) {
            self.checkpoint_budget.current = None;
        }
    }
    pub(crate) fn checkpoint_input_impact(&self) -> Impact {
        self.checkpoint_budget.input
    }
    pub(crate) fn checkpoint_input(&mut self, impact: Impact) {
        self.checkpoint_budget.input = impact;
    }
    pub(crate) fn calibrate_checkpoint(&mut self, snapshot: &mut Snapshot) {
        #[cfg(test)]
        CHECKS.set(CHECKS.get() + 1);
        self.checkpoint_budget.current = Some(snapshot.charges(self));
    }
    fn ensure_checkpoint_budget(&mut self) {
        if self.checkpoint_budget.current.is_none() {
            let mut snapshot = Snapshot::capture(self, self.checkpoint_root());
            self.calibrate_checkpoint(&mut snapshot);
        }
    }
    pub(crate) fn admit_checkpoint(
        &mut self,
        key: &Key,
        checkpoint: Option<&Checkpoint>,
        reserved: bool,
    ) -> bool {
        let bytes = match checkpoint {
            Some(checkpoint) => {
                let Some(bytes) = checkpoint.capacity_bytes() else {
                    return false;
                };
                Some(if reserved {
                    bytes.max(crate::apps::CHECKPOINT_MAX_BYTES)
                } else {
                    bytes
                })
            }
            None => None,
        };
        self.ensure_checkpoint_budget();
        let charges = self
            .checkpoint_budget
            .current
            .as_mut()
            .expect("calibrated budget");
        if !charges.fits(key, bytes) {
            return false;
        }
        charges.replace(key.clone(), bytes);
        self.checkpoint_input(Impact::LocalField);
        true
    }

    /// Navigation admission uses its actual candidate envelope. Field edits use
    /// one owner delta; Other changes invalidate it before the next admission.
    pub(crate) fn admit_state(
        &mut self,
        navigation: Option<(&Navigation, bool, Option<Focus>)>,
    ) -> bool {
        #[cfg(test)]
        CHECKS.set(CHECKS.get() + 1);
        let mut snapshot = Snapshot::candidate(self, navigation);
        let accepted = super::super::store::fits(snapshot.charges(self).bytes());
        // A candidate is not committed navigation. Recalibrate from the actual
        // state at the next admission, including when route preparation fails.
        self.checkpoint_changed(Impact::Other);
        if !accepted {
            self.notice = Some(Notice::Local("state-capacity"));
        } else if matches!(self.notice, Some(Notice::Local("state-capacity"))) {
            self.notice = None;
        }
        accepted
    }
}

#[cfg(test)]
mod pages;
#[cfg(test)]
mod tests;
