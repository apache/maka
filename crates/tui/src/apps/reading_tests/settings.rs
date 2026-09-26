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

#[test]
fn root_settings_routes_own_their_reading_positions() {
    let mut app = tests::app();
    let mut entry = app.apps.directory[0].clone();
    entry.method = "reader".into();
    entry.descriptor.context = Context::Application;
    entry.descriptor.placement = Placement::Settings;
    entry.descriptor.title = Text::plain("Reader");
    let key = Key::of(&entry, None).unwrap();
    app.apps.directory.push(entry);
    app.apply(Action::Visit(Route::Settings));
    app.apply(Action::Settings(crate::pages::settings::Message::Pane(
        key.clone(),
    )));
    settle(&mut app, true);
    let host = Host::Settings;
    host.draw(&mut app, &key);
    let reader = format!("settings/pane/frame/rows/{}/content/root", key.node());
    host.wheel(&mut app, &key, &reader, 30);
    let before = host.draw(&mut app, &key);
    let area = host.viewport(&app, &key, &reader);
    let first = text_at(&before, area);
    assert!(first.contains("Continue reading"), "{first}");
    let next = app
        .settings
        .surface
        .rect(&format!("{reader}/body/next"))
        .unwrap();
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        host.mouse(&mut app, &key, kind, next);
    }
    settle(&mut app, true);
    let initial = text_at(&host.draw(&mut app, &key), area);
    assert!(initial.contains("Second row 00"), "{initial}");
    host.wheel(&mut app, &key, &reader, 3);
    let second = text_at(&host.draw(&mut app, &key), area);
    assert_ne!(second, initial);
    for (action, expected) in [(Action::Back, first), (Action::Forward, second)] {
        app.apply(action);
        settle(&mut app, true);
        let buffer = host.draw(&mut app, &key);
        assert_eq!(host.viewport(&app, &key, &reader), area);
        assert_eq!(text_at(&buffer, area), expected);
    }
}
