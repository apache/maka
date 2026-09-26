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

use crate::{
    app::Action,
    apps::{
        Key, Output,
        tests::{app, draw, form},
    },
    navigation::Route,
    pages::settings::Message,
};
use maka_plugins::terminal_ui::{Context, Placement, view::Reply};

#[test]
fn cached_settings_pane_loading_keeps_existing_field_and_button_rectangles() {
    let mut app = app();
    let mut entry = app.apps.directory[0].clone();
    entry.method = "settings-status".into();
    entry.target.registration = uuid::Uuid::new_v4();
    entry.descriptor.context = Context::Application;
    entry.descriptor.placement = Placement::Settings;
    let key = Key::of(&entry, None).unwrap();
    app.apps.directory.push(entry);
    app.apply(Action::Visit(Route::Settings));
    app.apply(Action::Settings(Message::Pane(key.clone())));
    let read = app
        .apps_requests()
        .into_iter()
        .find(|request| request.key.as_ref() == Some(&key))
        .unwrap();
    app.apps_complete(read, Ok(Output::Reply(Reply::View { view: form() })));
    let ready = draw(&mut app, 120, 40);
    assert!(
        ready.contains("My notes") && !ready.contains("Loading…"),
        "{ready}"
    );
    let field = format!("settings/pane/frame/rows/{}/content/root/name", key.node());
    let button = format!(
        "settings/pane/frame/rows/{}/content/root/save/button",
        key.node()
    );
    let geometry = |app: &crate::app::App| {
        [
            app.settings.surface.rect(&field).unwrap(),
            app.settings.surface.rect(&button).unwrap(),
        ]
    };
    let original = geometry(&app);
    assert!(original.iter().all(|rect| !rect.is_empty()));
    app.apps.instances.get_mut(&key).unwrap().read("en");
    let pending = draw(&mut app, 120, 40);
    assert!(pending.contains("Loading…"), "{pending}");
    assert_eq!(
        geometry(&app),
        original,
        "queued read does not move controls"
    );
    let read = app
        .apps_requests()
        .into_iter()
        .find(|request| request.key.as_ref() == Some(&key))
        .unwrap();
    let busy = draw(&mut app, 120, 40);
    assert!(
        busy.contains("Loading…") && busy.contains("My notes"),
        "{busy}"
    );
    assert_eq!(
        geometry(&app),
        original,
        "in-flight read does not move controls"
    );
    app.apps_complete(read, Ok(Output::Reply(Reply::View { view: form() })));
    let ready = draw(&mut app, 120, 40);
    assert!(!ready.contains("Loading…"), "{ready}");
    assert_eq!(
        geometry(&app),
        original,
        "read completion does not move controls"
    );
}
