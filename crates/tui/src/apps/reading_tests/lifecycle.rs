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

fn composed(side_by_side: bool) -> View {
    let reader = slot("reader", "reading", Value::Null);
    let sibling = slot("sibling", "stable", Value::Null);
    view(
        "Container",
        if side_by_side {
            split("root", 50, reader, sibling)
        } else {
            column("root", vec![reader, sibling])
        },
    )
}

fn settle_composed(app: &mut App, side_by_side: bool) {
    loop {
        let requests = app.apps_requests();
        if requests.is_empty() {
            break;
        }
        for request in requests {
            let key = request.key.as_ref().unwrap();
            let view = match key.method.as_str() {
                "container" => composed(side_by_side),
                "sibling" => reading("Sibling", 30, 8),
                "reader" if key.route.is_null() => reading("First", 75, 18),
                "reader" => reading("Second", 40, 18),
                method => panic!("unexpected reader {method}"),
            };
            app.apps_complete(request, Ok(Output::Reply(Reply::View { view })));
        }
    }
}

fn rows(buffer: &Buffer, area: Rect) -> Vec<String> {
    text_at(buffer, area)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect()
}

#[test]
fn one_owner_keeps_reading_when_native_wrappers_change_and_after_back() {
    let (mut app, key) = fixture(Host::Page);
    settle_composed(&mut app, false);
    let host = Host::Page;
    host.draw(&mut app, &key);
    let original = "app/body/frame/content/root/reader/example.notes:reader/body/content/root";
    let shifted =
        "app/body/frame/content/root/leading/reader/example.notes:reader/body/content/root";
    let child = app
        .navigation
        .location()
        .embedded
        .iter()
        .find(|child| child.method == "reader")
        .unwrap()
        .clone();
    host.wheel(&mut app, &key, original, 30);
    let before = host.draw(&mut app, &key);
    let expected = rows(&before, host.viewport(&app, &key, original));
    assert!(
        expected
            .iter()
            .any(|line| line.contains("Continue reading"))
    );
    app.apps
        .instances
        .get_mut(&key)
        .unwrap()
        .install(composed(true));
    app.mount_app_views();
    assert!(
        app.navigation.location().contains(&child),
        "the exact child owner did not change"
    );
    let changed = host.draw(&mut app, &key);
    assert_eq!(rows(&changed, host.viewport(&app, &key, shifted)), expected);
    let next = app.apps.instances[&key]
        .surface
        .rect(&format!("{shifted}/body/next"))
        .unwrap();
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        host.mouse(&mut app, &key, kind, next);
    }
    settle_composed(&mut app, true);
    let second = host.draw(&mut app, &key);
    assert!(text_at(&second, host.viewport(&app, &key, shifted)).contains("Second row 00"));
    // Model real document retirement while A is hidden, without resetting A's view.
    app.apps_executions();
    assert!(app.apps.instances[&child].execution.is_nil());
    app.apply(Action::Back);
    settle_composed(&mut app, true);
    app.apps_executions();
    let back = host.draw(&mut app, &key);
    assert_eq!(rows(&back, host.viewport(&app, &key, shifted)), expected);
    for side_by_side in [false, true, false] {
        app.apps
            .instances
            .get_mut(&key)
            .unwrap()
            .install(composed(side_by_side));
        app.mount_app_views();
        let buffer = host.draw(&mut app, &key);
        let path = if side_by_side { shifted } else { original };
        assert_eq!(rows(&buffer, host.viewport(&app, &key, path)), expected);
    }
    // A retained contribution can also be inspected as its own recovery page.
    app.apps.instances.get_mut(&child).unwrap().blocked = true;
    app.apps_action(Message::Recover(child.clone()));
    assert_eq!(app.navigation.current(), Route::App(child.clone()));
    let standalone = "app/body/frame/content/root";
    let recovered = host.draw(&mut app, &child);
    assert_eq!(
        rows(&recovered, host.viewport(&app, &child, standalone)),
        expected
    );
    app.apply(Action::Back);
    settle_composed(&mut app, false);
    let embedded = host.draw(&mut app, &key);
    assert_eq!(
        rows(&embedded, host.viewport(&app, &key, original)),
        expected
    );
}

#[test]
fn resetting_a_visible_owner_starts_fresh_without_moving_its_sibling() {
    for host in [Host::Inspector, Host::Settings, Host::Page] {
        let (mut app, key) = fixture(host);
        settle(&mut app, true);
        host.draw(&mut app, &key);
        let root = match host {
            Host::Inspector => format!("inspector/body/panels/{}/content/root", key.node()),
            Host::Settings => format!("settings/pane/frame/rows/{}/content/root", key.node()),
            Host::Page => "app/body/frame/content/root".into(),
        };
        let reader = format!("{root}/body/reader/example.notes:reader/body/content/root");
        let sibling = format!("{root}/body/sibling/example.notes:sibling/body/content/root");
        host.wheel(&mut app, &key, &sibling, 2);
        host.wheel(&mut app, &key, &reader, 15);
        let before = host.draw(&mut app, &key);
        let reader_area = host.viewport(&app, &key, &reader);
        let sibling_area = host.viewport(&app, &key, &sibling);
        let sibling_text = text_at(&before, sibling_area);
        assert!(text_at(&before, reader_area).contains("First row 45"));
        let child = app
            .navigation
            .location()
            .embedded
            .iter()
            .find(|child| child.method == "reader")
            .unwrap()
            .clone();
        let instance = app.apps.instances.get_mut(&child).unwrap();
        instance.arrive();
        instance.install(reading("Fresh", 40, 18));
        let fresh = host.draw(&mut app, &key);
        assert_eq!(host.viewport(&app, &key, &reader), reader_area);
        assert!(
            text_at(&fresh, reader_area).contains("Fresh row 00"),
            "{}",
            text_at(&fresh, reader_area)
        );
        assert_eq!(text_at(&fresh, sibling_area), sibling_text);
    }
}
