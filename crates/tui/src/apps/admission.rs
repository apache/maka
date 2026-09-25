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

use super::*;

impl Apps {
    pub(crate) fn kept_count(&self) -> usize {
        self.instances
            .values()
            .filter(|instance| instance.keeps())
            .count()
    }
}

impl Instance {
    pub(super) fn frozen_pending(&self, work: &Work) -> Option<saved::Pending> {
        let (input, proposal) = match work {
            Work::Call {
                input: input @ Input::Submit { .. },
                ..
            } => (input.clone(), None),
            Work::Authorize {
                input, proposal, ..
            } => (input.clone(), Some(proposal.clone())),
            _ => return None,
        };
        let recovery = match &input {
            Input::Submit { action, .. } => self
                .view
                .as_ref()
                .and_then(|view| view.action(action))
                .and_then(|action| action.recovery.clone()),
            _ => None,
        };
        Some(saved::Pending {
            input,
            proposal,
            recovery,
            withheld: false,
        })
    }
}

impl App {
    pub(super) fn admit_field(&mut self, key: &Key, field: &str, value: &Value) -> bool {
        let Some(instance) = self.apps.instances.get(key) else {
            return false;
        };
        if instance.drafts.get(field) == Some(value) {
            return true;
        }
        let first = !instance.keeps();
        let accepted = instance
            .checkpoint(self.checkpoint_root(), key, None)
            .is_some_and(|mut checkpoint| checkpoint.admit_field(field, value, &instance.drafts));
        if !accepted || first && !self.admit_state(None, 1) {
            self.apps.instances.get_mut(key).unwrap().message =
                Some(Notice::Local("extensions-capacity"));
            return false;
        }
        let instance = self.apps.instances.get_mut(key).unwrap();
        if matches!(instance.message, Some(Notice::Local("extensions-capacity"))) {
            instance.message = None;
        }
        true
    }

    /// Validate every newly frozen write before changing generation, saving or
    /// unresolved identity. Earlier accepted candidates reserve their slot too.
    pub(super) fn admit_pending_writes(&mut self) {
        let candidates: Vec<_> = self
            .apps
            .instances
            .iter()
            .filter_map(|(key, instance)| {
                if instance.busy
                    || self.apps.confirmation().is_some()
                        && self
                            .apps
                            .confirming
                            .as_ref()
                            .is_some_and(|(holder, _)| holder == key)
                {
                    return None;
                }
                let pending = instance.frozen_pending(instance.pending.as_ref()?)?;
                Some((key.clone(), pending, !instance.keeps()))
            })
            .collect();
        let mut additions = 0;
        for (key, pending, first) in candidates {
            let local = self.apps.instances[&key]
                .checkpoint(self.checkpoint_root(), &key, Some(&pending))
                .is_some_and(|checkpoint| checkpoint.admit_cursors());
            if local && self.admit_state(None, additions + usize::from(first)) {
                additions += usize::from(first);
            } else {
                let instance = self.apps.instances.get_mut(&key).unwrap();
                instance.pending = None;
                instance.message = Some(Notice::Local("extensions-capacity"));
            }
        }
    }
}

#[cfg(test)]
mod review;
#[cfg(test)]
mod tests;
