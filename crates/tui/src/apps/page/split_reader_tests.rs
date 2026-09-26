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
    app::App,
    apps::{
        Output,
        tests::{app, draw, instance, instance_mut},
    },
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use maka_plugins::terminal_ui::{
    Placement, VERSION, transcript,
    view::{self as wire, build::*},
};
use serde_json::Value;
use uuid::Uuid;

const FOOTER: &str = "app/body/frame/content/root/footer";
const FORM_FIELDS: usize = 30;

fn fixture(layout: impl FnOnce(wire::Node, wire::Node) -> wire::Node, capped: bool) -> (App, Uuid) {
    let mut app = app();
    let mut fields: Vec<_> = (0..FORM_FIELDS)
        .map(|index| line(index.to_string(), format!("Value {index:02}"), 128))
        .collect();
    fields.push(line("footer", "Bottom form", 128));
    let form = column(
        "form",
        (0..FORM_FIELDS)
            .map(|index| input(index.to_string(), index.to_string(), "Field"))
            .collect(),
    );
    let form = if capped {
        scroll("capped", 4, form)
    } else {
        form
    };
    let view = wire::View {
        version: VERSION,
        title: "Composed reader".into(),
        revision: "one".into(),
        fields,
        actions: vec![],
        root: column(
            "root",
            vec![
                layout(form, slot("reader", "details", Value::Null)),
                input("footer", "footer", "Footer"),
            ],
        ),
    };
    view.validate().unwrap();
    instance_mut(&mut app).install(view);
    let mut filler = app.apps.directory[0].clone();
    filler.method = "detail".into();
    filler.descriptor.placement = Placement::Slot {
        name: "details".into(),
    };
    app.apps.directory.push(filler);
    app.mount_app_views();
    let mut requests = app.apps_requests();
    assert_eq!(requests.len(), 1);
    app.apps_complete(
        requests.pop().unwrap(),
        Ok(Output::Reply(wire::Reply::View {
            view: wire::View {
                version: VERSION,
                title: "Independent reader".into(),
                revision: "one".into(),
                fields: vec![],
                actions: vec![],
                root: transcript(
                    "reader",
                    transcript::Resource {
                        id: "detail".into(),
                        read: "detail.read".into(),
                        stream: "detail.stream".into(),
                        route: Value::Null,
                    },
                ),
            },
        })),
    );
    let mounts = app.apps_transcript_mounts();
    assert_eq!(mounts.len(), 1);
    (app, mounts[0].token)
}

fn tab(app: &mut App) {
    app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
}

fn last_field(app: &mut App, path: &str, width: u16) {
    draw(app, width, 35);
    instance_mut(app).surface.move_focus(format!("{path}/0"));
    for _ in 1..FORM_FIELDS {
        tab(app);
    }
    let screen = draw(app, width, 35);
    let last = format!("{path}/{}", FORM_FIELDS - 1);
    assert_eq!(instance(app).surface.focused(), Some(last.as_str()));
    assert!(
        screen.contains(&format!("Value {:02}", FORM_FIELDS - 1)),
        "width {width}: {screen}"
    );
    assert!(!instance(app).surface.rect(&last).unwrap().is_empty());
}

fn footer(app: &mut App, width: u16) {
    for _ in 0..3 {
        tab(app);
        draw(app, width, 35);
        if instance(app).surface.focused() == Some(FOOTER) {
            break;
        }
    }
    assert_eq!(instance(app).surface.focused(), Some(FOOTER));
    assert!(draw(app, width, 35).contains("Bottom form"));
    assert!(!instance(app).surface.rect(FOOTER).unwrap().is_empty());
    assert!(app.apps_requests().is_empty());
}

#[test]
fn slot_reader_keeps_its_split_peer_fields_and_footer_reachable() {
    const PANE: &str = "app/body/frame/content/root/split/leading";
    for (width, capped) in [(170, false), (60, false), (170, true), (60, true)] {
        let (mut app, token) = fixture(|left, right| split("split", 50, left, right), capped);
        let form_path = if capped {
            format!("{PANE}/capped/form")
        } else {
            format!("{PANE}/form")
        };
        last_field(&mut app, &form_path, width);
        let surface = &instance(&app).surface;
        let form = if capped {
            let area = surface.viewport(&format!("{PANE}/capped")).unwrap();
            assert_eq!(area.height, 4);
            area
        } else {
            surface.viewport(PANE).unwrap()
        };
        let reader = surface.transcript_area(token).unwrap();
        assert!(form.height >= 3 && reader.height >= 3);
        assert!(form.intersection(reader).is_empty());
        footer(&mut app, width);
    }
}

#[test]
fn mixed_row_and_column_keep_late_fields_reader_and_footer_reachable() {
    for (width, horizontal) in [(170, false), (60, false), (170, true), (60, true)] {
        let (mut app, token) = fixture(
            |left, right| {
                if horizontal {
                    row("layout", vec![left, right])
                } else {
                    column("layout", vec![left, right])
                }
            },
            false,
        );
        last_field(&mut app, "app/body/frame/content/root/layout/form", width);
        assert!(instance(&app).surface.viewport("app/body").is_some());
        tab(&mut app);
        draw(&mut app, width, 35);
        assert!(
            instance(&app)
                .surface
                .focused()
                .unwrap()
                .ends_with("/reader")
        );
        assert!(
            instance(&app)
                .surface
                .transcript_area(token)
                .unwrap()
                .height
                >= 3
        );
        footer(&mut app, width);
    }
}
