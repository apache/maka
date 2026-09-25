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

use super::{App, Key, Placement, Route};

impl App {
    /// Reads discover mounts in the current location; they never push history.
    pub(crate) fn mount_app_views(&mut self) {
        let mut location = self.navigation.location().clone();
        if location.recovery || !self.apps.loaded || self.apps.failed {
            return;
        }
        let roots: Vec<Key> = match &location.route {
            Route::App(key) => vec![key.clone()],
            Route::Settings => self
                .apps
                .settings_views()
                .into_iter()
                .map(|(key, _)| key)
                .collect(),
            Route::Session(session) => [Placement::Panel, Placement::Status]
                .iter()
                .flat_map(|placement| self.apps.session_views(placement))
                .filter_map(|entry| Key::of(entry, Some(session)))
                .collect(),
            _ => Vec::new(),
        };
        let mut wanted = Vec::new();
        for root in roots {
            let selected = location.mount(root);
            if !wanted.contains(&selected) {
                wanted.push(selected);
            }
        }
        let mut index = 0;
        let mut waiting = Vec::new();
        let mut active_hosts = Vec::new();
        while let Some(host) = wanted.get(index).cloned() {
            index += 1;
            let active = match host.placement {
                Placement::Panel => location.inspector,
                Placement::Settings => {
                    self.settings.single || location.settings_pane() == Some(&host)
                }
                _ => true,
            };
            if !active {
                waiting.push(host);
                continue;
            }
            active_hosts.push(host.clone());
            let Some(view) = self
                .apps
                .instances
                .get(&host)
                .filter(|instance| {
                    instance.live.is_some() && !instance.blocked && instance.review.is_none()
                })
                .and_then(|instance| instance.view.as_ref())
            else {
                waiting.push(host);
                continue;
            };
            let slots = super::tree::slots(view);
            for (wire, name, _) in slots {
                for (key, _) in self.apps.filling(&host, &name, &wire) {
                    let selected = location.mount(key);
                    if !wanted.contains(&selected) {
                        wanted.push(selected);
                    }
                }
            }
        }
        location.embedded.retain(|key| {
            wanted.contains(key) || waiting.iter().any(|parent| key.descends_from(parent))
        });
        // Parent-first order also makes a checkpoint independently verifiable.
        location.embedded.sort_by_key(Key::depth);
        if &location != self.navigation.location() {
            let mut navigation = self.navigation.clone();
            if !navigation.replace(location)
                || !self.admit_state(Some((&navigation, false, None)), 0)
            {
                return;
            }
            self.navigation = navigation;
        }
        for host in active_hosts {
            self.apps.open(&host);
            if let Some(instance) = self.apps.instances.get_mut(&host)
                && instance.idle()
                && !instance.keeps()
                && instance.stale
                && instance.message.is_none()
            {
                instance.read(&self.apps.locale);
            }
        }
        self.apps.prune(&wanted);
    }

    pub(super) fn session_keys(&self, session: &str, placement: &Placement) -> Vec<Key> {
        self.apps
            .session_views(placement)
            .into_iter()
            .filter_map(|entry| Key::of(entry, Some(session)))
            .filter_map(|initial| self.navigation.location().selected(&initial).cloned())
            .filter(|key| self.apps.instances.contains_key(key))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::Action,
        apps::{Command, Input, Message, Output, Work},
        navigation::Location,
    };
    use maka_plugins::terminal_ui::{
        Context,
        view::{Reply, build::slot},
    };
    use serde_json::json;

    #[test]
    fn restored_locations_wait_for_the_directory_and_parent_read_before_mounting_children() {
        for settings in [false, true] {
            let mut app = crate::apps::tests::app();
            let mut entry = app.apps.directory[0].clone();
            entry.descriptor.context = if settings {
                Context::Application
            } else {
                Context::Session
            };
            entry.descriptor.placement = if settings {
                Placement::Settings
            } else {
                Placement::Panel
            };
            let parent = Key::of(&entry, Some("session"))
                .unwrap()
                .at(json!({"parent": 7}));
            let mut filler = entry.clone();
            filler.package_id = "example.child".into();
            filler.descriptor.placement = Placement::Slot {
                name: "detail".into(),
            };
            let child = Key {
                package: filler.package_id.clone(),
                method: filler.method.clone(),
                placement: filler.descriptor.placement.clone(),
                session: parent.session.clone(),
                within: Some(Box::new((parent.clone(), "detail".into()))),
                origin: json!({"entity":7}),
                route: json!({"child":"detail"}),
            };
            let mut location = Location::from(if settings {
                Route::Settings
            } else {
                Route::Session("session".into())
            });
            location.inspector = !settings;
            location.mount(parent.clone());
            location.mount(child.clone());
            app.navigation.visit(location.clone());
            let saved = serde_json::to_vec(&app.navigation).unwrap();
            app.navigation = serde_json::from_slice(&saved).unwrap();
            app.apps = super::super::Apps::new("en");
            // Failed first pages and failed continuations are not empty directories.
            for partial in [false, true] {
                let first = app.apps_requests().pop().unwrap();
                let failed = if partial {
                    app.apps_complete(
                        first,
                        Ok(Output::Directory(maka_protocol::plugin::Page {
                            items: vec![entry.clone()],
                            next_cursor: Some("next".into()),
                        })),
                    );
                    app.apps_requests().pop().unwrap()
                } else {
                    first
                };
                app.apps_complete(failed, Err(super::super::io::Failure { unknown: false }));
                assert!(app.apps_requests().is_empty());
                assert_eq!(app.navigation.location(), &location);
                assert!(app.apps.instances.is_empty());
                app.apps.reload();
            }
            let first = app.apps_requests().pop().unwrap();
            assert!(first.key.is_none());
            assert_eq!(app.navigation.location(), &location);
            app.apps_complete(
                first,
                Ok(Output::Directory(maka_protocol::plugin::Page {
                    items: vec![entry.clone()],
                    next_cursor: Some("next".into()),
                })),
            );
            let next = app.apps_requests().pop().unwrap();
            assert!(next.key.is_none());
            assert_eq!(app.navigation.location(), &location);
            app.apps_complete(
                next,
                Ok(Output::Directory(maka_protocol::plugin::Page {
                    items: vec![filler],
                    next_cursor: None,
                })),
            );
            if settings {
                assert!(
                    app.apps_requests().is_empty(),
                    "unselected pane stays dormant"
                );
                assert_eq!(app.navigation.location(), &location);
                app.apply(Action::Settings(crate::pages::settings::Message::Pane(
                    parent.clone(),
                )));
            }
            let read = app.apps_requests().pop().unwrap();
            assert_eq!(read.key.as_ref(), Some(&parent));
            assert!(
                matches!(&read.work, Work::Call { input: Input::Read { route, .. }, .. } if route == &parent.route)
            );
            assert!(app.navigation.location().contains(&child));
            assert!(
                !app.apps.instances.contains_key(&child),
                "parent read must confirm the slot first"
            );
            let mut view = crate::apps::tests::form();
            view.root = slot("detail", "detail", child.origin.clone());
            app.apps_complete(read, Ok(Output::Reply(Reply::View { view })));
            let read = app.apps_requests().pop().unwrap();
            assert_eq!(read.key.as_ref(), Some(&child));
            assert!(
                matches!(&read.work, Work::Call { input: Input::Read { route, .. }, .. } if route == &child.route)
            );
            app.apps_complete(
                read,
                Ok(Output::Reply(Reply::View {
                    view: crate::apps::tests::form(),
                })),
            );
            // A new parent binding cannot reuse the previous binding's slot tree.
            let previous = app.apps.directory[0].target.clone();
            app.apps.directory[0].target.registration = uuid::Uuid::new_v4();
            app.apps.directory[0].target.activation = uuid::Uuid::new_v4().to_string();
            app.apps.bind();
            assert_ne!(app.apps.instances[&parent].live.as_ref(), Some(&previous));
            assert!(app.apps.instances[&parent].view.is_none());
            app.mount_app_views();
            assert!(app.navigation.location().contains(&child));
            assert!(!app.app_selected(&child));
            app.apps.instances.remove(&child);
            let reads = app.apps_requests();
            assert_eq!(reads.len(), 1, "only the rebound parent may read");
            assert_eq!(reads[0].key.as_ref(), Some(&parent));
            assert!(!app.apps.instances.contains_key(&child));
            let mut view = crate::apps::tests::form();
            view.root = slot("detail", "detail", child.origin.clone());
            app.apps_complete(
                reads.into_iter().next().unwrap(),
                Ok(Output::Reply(Reply::View { view })),
            );
            let read = app.apps_requests().pop().unwrap();
            assert_eq!(read.key.as_ref(), Some(&child));
            app.apps_complete(
                read,
                Ok(Output::Reply(Reply::View {
                    view: crate::apps::tests::form(),
                })),
            );
            // A live dirty parent may still compose its child. A blocked parent may not.
            app.apps
                .instances
                .get_mut(&parent)
                .unwrap()
                .drafts
                .insert("enabled".into(), json!(false));
            app.mount_app_views();
            app.apps.inspector_visible = true;
            assert!(app.app_selected(&child));
            assert!(
                app.apps_enabled(&Message::Instance(
                    child.clone(),
                    Command::View(super::super::Intent::Submit("save".into()))
                )),
                "live dirty parents keep normal child controls"
            );
            app.apps.instances.get_mut(&parent).unwrap().blocked = true;
            app.mount_app_views();
            assert!(app.navigation.location().contains(&child));
            assert!(!app.app_visible(&child));
            assert!(!app.apps_enabled(&Message::Instance(
                child.clone(),
                Command::View(super::super::Intent::Submit("save".into()))
            )));
            app.apps.instances.remove(&child);
            assert!(
                app.apps_requests().is_empty(),
                "blocked old trees cannot instantiate children"
            );
            app.apps.instances.get_mut(&parent).unwrap().blocked = false;
            app.apps.instances.get_mut(&parent).unwrap().live = None;
            app.mount_app_views();
            assert!(!app.apps.instances.contains_key(&child));
            assert!(app.navigation.location().contains(&child));
            app.apps.directory.clear();
            app.apps.failed = false;
            app.mount_app_views();
            assert!(
                app.navigation.location().embedded.is_empty(),
                "a successfully empty directory is authoritative"
            );
            assert_eq!(
                app.apps.instances[&parent].drafts["enabled"],
                json!(false),
                "retirement keeps the owning draft"
            );
        }
    }
}
