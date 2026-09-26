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
use crate::{app::Action, apps::Key, state::store};
use maka_plugins::terminal_ui::Context;

#[test]
fn many_small_embedded_addresses_are_rejected_only_when_encoded_checkpoint_is_full() {
    let mut app = crate::apps::tests::app();
    app.apply(Action::Visit(Route::Settings));
    leave_capacity(&mut app, 1024);
    let before = serde_json::to_value(Snapshot::capture(&app, app.checkpoint_root())).unwrap();
    assert!(store::encode(&before).is_ok());
    let mut candidate = app.navigation.clone();
    let mut location = candidate.location().clone();
    for index in 0..257 {
        let mut entry = app.apps.directory[0].clone();
        entry.package_id = format!("example.p{index}");
        entry.descriptor.context = Context::Application;
        entry.descriptor.placement = Placement::Settings;
        location.mount(Key::of(&entry, None).unwrap());
        app.apps.directory.push(entry);
    }
    assert!(candidate.replace(location));
    assert!(
        candidate.valid(|_| true),
        "route structure is valid above 256 addresses"
    );
    let snapshot = Snapshot::candidate(&app, Some((&candidate, false, None)));
    snapshot.validate(app.checkpoint_root()).unwrap();
    assert!(
        store::encode(&snapshot).is_err(),
        "the encoded envelope is actually full"
    );
    let instances = app.apps.instances.keys().cloned().collect::<Vec<_>>();
    app.mount_app_views();
    assert!(matches!(
        app.notice,
        Some(crate::app::Notice::Local("state-capacity"))
    ));
    assert_eq!(
        serde_json::to_value(Snapshot::capture(&app, app.checkpoint_root())).unwrap(),
        before,
        "failed mount admission leaves the accepted checkpoint unchanged"
    );
    assert_eq!(
        app.apps.instances.keys().cloned().collect::<Vec<_>>(),
        instances
    );
    assert!(app.apps_requests().is_empty());
}
