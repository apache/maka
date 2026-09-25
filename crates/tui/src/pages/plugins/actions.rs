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
use io::Mutation;
use maka_plugins::composition::{Entry, EntryPatch, Operation};
use maka_protocol::plugin::{Apply, PackageInstall, PackagePrecondition, PackageTarget};

impl State {
    fn proposal(&self, change: Change) -> Result<Request, String> {
        let binding = self.binding.clone().ok_or("plugins-unavailable")?;
        let snapshot = self.snapshot.as_ref().ok_or("plugins-unavailable")?;
        let (mutation, place, base) = match (&self.place, change) {
            (Place::Install, Change::Install) => {
                let preview = self
                    .preview
                    .as_ref()
                    .filter(|p| p.source_path == self.path.text())
                    .ok_or("plugins-preview-first")?;
                (
                    Mutation::Install(PackageInstall {
                        source_path: preview.source_path.clone(),
                        source_digest: Some(preview.package.content_digest.clone()),
                        expected: Some(preview.expected.clone()),
                    }),
                    Place::Package(preview.package.extension_id.clone()),
                    preview.expected.base_generation,
                )
            }
            (Place::Package(id), Change::Restart | Change::Uninstall) => {
                let package = snapshot.package(id).ok_or("plugins-missing")?;
                let target = PackageTarget {
                    extension_id: id.clone(),
                    expected: Some(PackagePrecondition {
                        base_generation: package.base_generation,
                        content_digest: Some(package.content_digest.clone()),
                    }),
                };
                (
                    if change == Change::Restart {
                        Mutation::Restart(target)
                    } else {
                        Mutation::Uninstall(target)
                    },
                    self.place.clone(),
                    package.base_generation,
                )
            }
            (Place::New(package), Change::Create) => {
                snapshot.package(package).ok_or("plugins-missing")?;
                let draft = self.draft().ok_or("plugins-draft-limit")?;
                let mut entry =
                    Entry::new(draft.fields[0].text()).map_err(|_| "plugins-invalid-id")?;
                entry.package_id = Some(package.clone());
                entry.config = draft.patch(Change::Configure)?.config.unwrap_or_default();
                let place = Place::Entry(EntryKey {
                    scope: draft.scope.clone(),
                    id: entry.id.clone(),
                });
                let operation = Operation::Insert {
                    root_id: Some(draft.scope.clone()),
                    parent_id: None,
                    entry,
                    position: None,
                };
                (
                    Mutation::Apply(Apply {
                        base_generation: Some(draft.base),
                        operations: vec![operation],
                    }),
                    place,
                    draft.base,
                )
            }
            (place, change) if place.entry().is_some() => {
                let key = place.entry().expect("entry");
                let current = snapshot.entry(key).ok_or("plugins-missing")?;
                let (operation, base) = match change {
                    Change::Enable | Change::Disable => (
                        Operation::Update {
                            entry_id: key.id.clone(),
                            patch: EntryPatch {
                                disabled: Some(change == Change::Disable),
                                ..Default::default()
                            },
                        },
                        current.base_generation,
                    ),
                    Change::Remove => (
                        Operation::Remove {
                            entry_id: key.id.clone(),
                        },
                        current.base_generation,
                    ),
                    Change::Configure | Change::Services => {
                        let draft = self.draft().ok_or("plugins-draft-limit")?;
                        if draft.base != snapshot.status.authority_epoch {
                            return Err("plugins-conflict".into());
                        }
                        (
                            Operation::Update {
                                entry_id: key.id.clone(),
                                patch: draft.patch(change)?,
                            },
                            draft.base,
                        )
                    }
                    _ => return Err("plugins-missing".into()),
                };
                operation
                    .validate()
                    .map_err(|_| "plugins-invalid-services")?;
                (
                    Mutation::Apply(Apply {
                        base_generation: Some(base),
                        operations: vec![operation],
                    }),
                    Place::Entry(key.clone()),
                    base,
                )
            }
            _ => return Err("plugins-missing".into()),
        };
        Ok(Request::write(binding, mutation, change, place, base))
    }
}
impl App {
    pub(crate) fn plugins_action(&mut self, command: Command) -> Option<Action> {
        match command {
            Command::Visit(place) => return self.apply(Action::Visit(Route::Plugins(place))),
            Command::Details => self.plugins.details = !self.plugins.details,
            Command::ConfirmationDetails(_) => {
                self.plugins.confirmation_details = !self.plugins.confirmation_details
            }
            Command::Refresh => {
                self.plugins.refresh = true;
                self.plugins.error = None;
            }
            Command::Preview => {
                if self.plugins.path.text().is_empty()
                    || self.plugins.path.text().chars().any(char::is_control)
                {
                    self.plugins.error = Some("plugins-invalid-path".into());
                } else {
                    self.plugins.preview = None;
                    self.plugins.preview_requested = true;
                }
            }
            Command::Field(index) => self
                .plugins
                .surface
                .focus(format!("plugins/scroll/body/field-{index}")),
            Command::Scope(scope) => {
                if scope != Scope::Profile
                    && !matches!(&scope, Scope::Session(id) if self.sessions.items.iter().any(|session| session.id == *id))
                {
                    return None;
                }
                if let Some(draft) = self.plugins.draft_mut() {
                    draft.scope = scope;
                    draft.dirty[0] = true;
                }
            }
            Command::Review(_, change) => {
                // The immutable request, including config and preconditions, is
                // made before the Sheet is displayed. Confirm never rereads a form.
                match self.plugins.proposal(change) {
                    Ok(request) => {
                        self.plugins.defer_background_read();
                        self.plugins.confirmation_details = false;
                        self.plugins.confirmation = Some(Confirmation::Write(request));
                        self.plugins.confirmation_shown = false;
                        self.layer.close();
                    }
                    Err(error) => self.plugins.error = Some(error),
                }
            }
            Command::Confirm(token) => {
                if let Some(Confirmation::Write(request)) = self.plugins.confirmation.take()
                    && request.token == token
                {
                    self.plugins.queued = Some(request);
                    self.plugins.confirmation_shown = false;
                    self.plugins.receipt = None;
                    self.plugins.error = None;
                }
            }
            Command::ConfirmExit(token) => {
                if let Some(Confirmation::Exit {
                    token: actual,
                    detach,
                }) = self.plugins.confirmation.take()
                    && actual == token
                {
                    return Some(if detach { Action::Detach } else { Action::Quit });
                }
            }
            Command::Cancel => {
                self.plugins.confirmation = None;
                self.plugins.confirmation_shown = false;
            }
            Command::Rebase(_) => {
                if let Some(snapshot) = &self.plugins.snapshot
                    && self.plugins.draft().is_some()
                {
                    let current = self
                        .plugins
                        .place
                        .entry()
                        .and_then(|key| snapshot.entry(key))
                        .cloned()
                        .map(Box::new);
                    if self.plugins.place.entry().is_some() && current.is_none() {
                        self.plugins.error = Some("plugins-missing".into());
                        return None;
                    }
                    let draft = self.plugins.draft().expect("checked draft");
                    let mine = std::array::from_fn(|index| draft.fields[index].text().to_owned());
                    let dirty = draft.dirty;
                    let scope = draft.scope.clone();
                    let base = snapshot.status.authority_epoch;
                    self.plugins.defer_background_read();
                    self.plugins.confirmation_details = false;
                    self.plugins.confirmation = Some(Confirmation::Rebase {
                        mine,
                        dirty,
                        scope,
                        token: Uuid::new_v4(),
                        place: self.plugins.place.clone(),
                        current,
                        base,
                    });
                    self.plugins.confirmation_shown = false;
                    self.layer.close();
                }
            }
            Command::ConfirmRebase(token) => {
                if let Some(Confirmation::Rebase {
                    token: actual,
                    place,
                    current,
                    base,
                    mine,
                    dirty,
                    scope,
                }) = self.plugins.confirmation.take()
                    && actual == token
                    && place == self.plugins.place
                    && let Some(draft) = self.plugins.draft_mut()
                {
                    if draft.dirty != dirty
                        || draft.scope != scope
                        || draft
                            .fields
                            .iter()
                            .zip(&mine)
                            .any(|(field, mine)| field.text() != mine)
                    {
                        self.plugins.error = Some("plugins-conflict".into());
                        return None;
                    }
                    draft.adopt(current.map(|entry| *entry), base);
                    self.plugins.error = None;
                }
            }
            Command::Discard => self.plugins.discard_draft(),
        }
        None
    }
}
