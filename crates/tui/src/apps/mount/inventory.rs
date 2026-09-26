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
use crate::{
    app::Action,
    apps::{Command, Input, Intent, Output, Work, tests::*},
};
use maka_plugins::terminal_ui::{Context, view::Reply};
use serde_json::json;
use std::collections::BTreeSet;

#[test]
fn paginated_directory_mounts_many_small_contributions_and_preserves_unknown_writes() {
    for placement in [Placement::Panel, Placement::Status, Placement::Settings] {
        let mut app = app();
        app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
        app.apps_action(save());
        let submitted = next(&mut app).unwrap();
        assert!(submitted.needs_checkpoint());
        app.apps_complete(submitted, Err(crate::apps::io::Failure { unknown: true }));
        let retained = serde_json::to_value(app.apps.checkpoints("root")).unwrap();
        assert_eq!(retained[0]["drafts"]["enabled"], json!(false));
        assert!(!retained[0]["pending"].is_null());

        let mut directory = app.apps.directory.clone();
        let keys: BTreeSet<_> = (0..257)
            .map(|index| {
                let mut entry = directory[0].clone();
                entry.package_id = format!("example.p{index}");
                entry.target.registration = uuid::Uuid::new_v4();
                entry.target.activation = uuid::Uuid::new_v4().to_string();
                entry.descriptor.placement = placement.clone();
                entry.descriptor.context = if placement == Placement::Settings {
                    Context::Application
                } else {
                    Context::Session
                };
                let key = Key::of(&entry, Some("session")).unwrap();
                directory.push(entry);
                key
            })
            .collect();
        app.apps.reload();
        let page_count = directory.len().div_ceil(super::super::PAGE);
        for (index, page) in directory.chunks(super::super::PAGE).enumerate() {
            let mut requests = app.apps_requests();
            assert_eq!(requests.len(), 1, "each continuation must be consumed");
            let listing = requests.pop().unwrap();
            assert!(matches!(
                &listing.work,
                Work::Directory(cursor) if cursor == &(index > 0).then(|| index.to_string())
            ));
            app.apps_complete(
                listing,
                Ok(Output::Directory(maka_protocol::plugin::Page {
                    items: page.to_vec(),
                    next_cursor: (index + 1 < page_count).then(|| (index + 1).to_string()),
                })),
            );
            if index + 1 < page_count {
                assert_eq!(
                    app.apps.directory.len(),
                    1,
                    "partial lists do not retire owners"
                );
            }
        }
        assert_eq!(app.apps.directory.len(), directory.len());
        assert!(app.apps_requests().is_empty());

        app.apply(Action::Visit(if placement == Placement::Settings {
            Route::Settings
        } else {
            Route::Session("session".into())
        }));
        assert_eq!(app.navigation.location().embedded.len(), 257);
        assert!(app.navigation.valid(|_| true));
        if placement == Placement::Settings {
            assert!(
                app.apps_requests().is_empty(),
                "wide unselected panes stay dormant"
            );
            assert!(keys.iter().all(|key| !app.apps.instances.contains_key(key)));
            // Narrow Settings renders every category as a section of one list.
            draw(&mut app, 50, 40);
        } else if placement == Placement::Panel {
            assert!(
                app.apps_requests().is_empty(),
                "closed inspector stays dormant"
            );
            app.navigate(crate::navigation::Intent::Inspector(true));
        }
        let reads = app.apps_requests();
        assert_eq!(reads.len(), keys.len());
        assert_eq!(
            reads
                .iter()
                .filter_map(|read| read.key.clone())
                .collect::<BTreeSet<_>>(),
            keys
        );
        assert_eq!(
            reads
                .iter()
                .map(|read| read.execution)
                .collect::<BTreeSet<_>>()
                .len(),
            keys.len()
        );
        for read in reads {
            let key = read.key.clone().unwrap();
            assert!(matches!(
                &read.work,
                Work::Call { entry, input: Input::Read { route, .. } }
                    if key.serves(entry) && route == &key.route
            ));
            let mut view = form();
            view.title = key.package.clone();
            app.apps_complete(read, Ok(Output::Reply(Reply::View { view })));
        }
        assert!(app.apps_requests().is_empty());
        for key in &keys {
            assert_eq!(
                app.apps.instances[key].view.as_ref().unwrap().title,
                key.package
            );
        }
        assert_eq!(
            serde_json::to_value(app.apps.checkpoints("root")).unwrap(),
            retained
        );
        assert_eq!(app.navigation.location().embedded.len(), 257);
        assert!(app.admit_state(None));
        let restored: crate::navigation::Navigation =
            serde_json::from_slice(&serde_json::to_vec(&app.navigation).unwrap()).unwrap();
        assert!(restored.valid(|_| true));
        assert_eq!(restored.location(), app.navigation.location());
    }
}
