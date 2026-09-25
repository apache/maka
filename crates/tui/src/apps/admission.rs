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
    #[cfg(test)]
    pub(crate) fn kept_count(&self) -> usize {
        self.instances
            .values()
            .filter(|instance| instance.keeps())
            .count()
    }
    pub(crate) fn reserves_checkpoint(&self, key: &Key) -> bool {
        self.instances.get(key).is_some_and(|instance| {
            instance.unresolved.is_some() || instance.writing || instance.saving
        })
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
    pub(super) fn accept_app_draft(&mut self, key: &Key) -> bool {
        let candidate = self
            .apps
            .instances
            .get(key)
            .and_then(|instance| instance.draft_checkpoint(self.checkpoint_root()));
        let accepted = candidate.as_ref().is_some_and(|(checkpoint, kept)| {
            self.admit_checkpoint(key, kept.then_some(checkpoint), false)
        });
        let root = self.checkpoint_root().to_owned();
        let Some(instance) = self.apps.instances.get_mut(key) else {
            return false;
        };
        if !accepted {
            instance.message = Some(Notice::Local("extensions-capacity"));
            return false;
        }
        instance.accept_draft(&root)
    }

    pub(super) fn admit_field(&mut self, key: &Key, field: &str, value: &Value) -> bool {
        let Some(instance) = self.apps.instances.get(key) else {
            return false;
        };
        if instance.drafts.get(field) == Some(value) {
            return true;
        }
        let kept = instance.blocked
            || instance.unresolved.is_some()
            || instance.writing
            || instance.result.is_some()
            || instance.view.as_ref().is_some_and(|view| {
                view.fields.iter().any(|item| {
                    let proposed = if item.id == field {
                        Some(value)
                    } else {
                        instance.drafts.get(&item.id)
                    };
                    proposed != Some(&drafts::value(&item.control))
                })
            });
        let reserved = self.apps.reserves_checkpoint(key);
        let checkpoint = instance
            .checkpoint(self.checkpoint_root(), key, None)
            .and_then(|mut checkpoint| {
                checkpoint
                    .admit_field(field, value, &instance.drafts)
                    .then_some(checkpoint)
            });
        let accepted = checkpoint.as_ref().is_some_and(|checkpoint| {
            self.admit_checkpoint(key, kept.then_some(checkpoint), reserved)
        });
        if !accepted {
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
    /// unresolved identity. Earlier accepted writes reserve their result bytes too.
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
                Some((key.clone(), pending))
            })
            .collect();
        for (key, pending) in candidates {
            let checkpoint = self.apps.instances[&key]
                .checkpoint(self.checkpoint_root(), &key, Some(&pending))
                .filter(|checkpoint| checkpoint.capacity_bytes().is_some());
            if !checkpoint
                .as_ref()
                .is_some_and(|checkpoint| self.admit_checkpoint(&key, Some(checkpoint), true))
            {
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
