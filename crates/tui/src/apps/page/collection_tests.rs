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

const BOARD: &str = "app/body/frame/content/root/board";
const FOOTER: &str = "app/body/frame/content/root/footer";

fn view(selected: bool) -> wire::View {
    wire::View {
        version: VERSION,
        title: "Collection readers".into(),
        revision: "one".into(),
        fields: vec![line("draft", "Bottom form", 128)],
        actions: vec![],
        root: column(
            "root",
            vec![
                wire::Node::Collection {
                    key: "board".into(),
                    groups: vec![wire::CollectionGroup {
                        key: "todo".into(),
                        label: "Cards".into(),
                    }],
                    items: (0..40)
                        .map(|index| wire::CollectionItem {
                            key: index.to_string(),
                            group: "todo".into(),
                            title: format!("Card {index:02}"),
                            summary: String::new(),
                            panel: Some(Box::new(transcript(
                                "reader",
                                transcript::Resource {
                                    id: format!("card-{index}"),
                                    read: "cards.read".into(),
                                    stream: "cards.stream".into(),
                                    route: Value::from(index),
                                },
                            ))),
                        })
                        .collect(),
                    filter: Some(wire::CollectionFilter {
                        label: "Filter".into(),
                        placeholder: "Find cards".into(),
                    }),
                    initial: selected.then(|| "0".into()),
                    ratio: 50,
                    movement: None,
                },
                input("footer", "draft", "Footer"),
            ],
        ),
    }
}

fn press(app: &mut App, code: KeyCode) {
    app.input(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)));
}

fn last_card_and_footer(app: &mut App, width: u16) {
    draw(app, width, 35);
    instance_mut(app)
        .surface
        .move_focus(format!("{BOARD}/leading/list/groups/todo/0"));
    press(app, KeyCode::End);
    let screen = draw(app, width, 35);
    let last = format!("{BOARD}/leading/list/groups/todo/39");
    assert_eq!(instance(app).surface.focused(), Some(last.as_str()));
    assert!(screen.contains("Card 39"), "width {width}: {screen}");
    assert!(!instance(app).surface.rect(&last).unwrap().is_empty());
    for _ in 0..4 {
        press(app, KeyCode::Tab);
        let screen = draw(app, width, 35);
        if instance(app).surface.focused() == Some(FOOTER) {
            assert!(screen.contains("Bottom form"), "width {width}: {screen}");
            assert!(!instance(app).surface.rect(FOOTER).unwrap().is_empty());
            return;
        }
    }
    panic!("the footer must remain a reachable focus stop");
}

#[test]
fn hidden_collection_readers_keep_late_cards_and_footer_reachable() {
    for width in [170, 60] {
        let mut app = app();
        let view = view(false);
        view.validate().unwrap();
        instance_mut(&mut app).install(view);
        assert!(app.apps_transcript_mounts().is_empty());
        last_card_and_footer(&mut app, width);
    }
}

#[test]
fn selected_collection_reader_shares_viewport_with_scrollable_cards() {
    for width in [170, 60] {
        let mut app = app();
        let view = view(true);
        view.validate().unwrap();
        instance_mut(&mut app).install(view);
        let mounts = app.apps_transcript_mounts();
        assert_eq!(mounts.len(), 1, "only the selected detail mounts");
        assert_eq!(mounts[0].resource.id, "card-0");
        last_card_and_footer(&mut app, width);
        let surface = &instance(&app).surface;
        let cards = surface.viewport(&format!("{BOARD}/leading")).unwrap();
        let reader = surface.transcript_area(mounts[0].token).unwrap();
        assert!(cards.height >= 3 && reader.height >= 3);
        assert!(cards.intersection(reader).is_empty());
        assert_eq!(app.apps_transcript_mounts()[0].token, mounts[0].token);
        app.input(Event::Paste(" kept".into()));
        let draft = instance(&app).drafts["draft"].clone();
        assert!(draft.as_str().unwrap().contains("kept"));
        draw(&mut app, if width == 170 { 60 } else { 170 }, 35);
        assert_eq!(instance(&app).surface.focused(), Some(FOOTER));
        assert!(!instance(&app).surface.rect(FOOTER).unwrap().is_empty());
        assert_eq!(instance(&app).drafts["draft"], draft);
        instance_mut(&mut app)
            .surface
            .move_focus(format!("{BOARD}/leading/list/groups/todo/39"));
        press(&mut app, KeyCode::Enter);
        let changed = app.apps_transcript_mounts();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].resource.id, "card-39");
        assert_ne!(changed[0].token, mounts[0].token);
        assert!(app.apps_requests().is_empty());
    }
}

#[test]
fn selected_slot_reader_receives_height_through_contribution_wrappers() {
    for width in [170, 60] {
        let mut app = app();
        let mut view = view(true);
        let wire::Node::Column { children, .. } = &mut view.root else {
            unreachable!()
        };
        let wire::Node::Collection { items, .. } = &mut children[0] else {
            unreachable!()
        };
        let reader = items[0].panel.take().unwrap();
        items[0].panel = Some(Box::new(slot("detail", "details", Value::Null)));
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
        assert_eq!(requests.len(), 1, "only the selected detail opens");
        app.apps_complete(
            requests.pop().unwrap(),
            Ok(Output::Reply(wire::Reply::View {
                view: wire::View {
                    version: VERSION,
                    title: "Independent reader".into(),
                    revision: "one".into(),
                    fields: vec![],
                    actions: vec![],
                    root: *reader,
                },
            })),
        );
        let mounts = app.apps_transcript_mounts();
        assert_eq!(mounts.len(), 1);
        last_card_and_footer(&mut app, width);
        assert!(
            instance(&app)
                .surface
                .transcript_area(mounts[0].token)
                .unwrap()
                .height
                >= 3
        );
        assert!(
            instance(&app)
                .surface
                .viewport(&format!("{BOARD}/leading"))
                .is_some()
        );
        assert!(app.apps_requests().is_empty());
    }
}

#[test]
fn capped_reader_does_not_remove_the_page_scroll() {
    for width in [170, 60] {
        let mut app = app();
        let mut view = view(false);
        let wire::Node::Column { children, .. } = &mut view.root else {
            unreachable!()
        };
        children.insert(
            0,
            scroll(
                "bounded",
                4,
                transcript(
                    "reader",
                    transcript::Resource {
                        id: "bounded-reader".into(),
                        read: "cards.read".into(),
                        stream: "cards.stream".into(),
                        route: Value::Null,
                    },
                ),
            ),
        );
        view.validate().unwrap();
        instance_mut(&mut app).install(view);
        assert_eq!(app.apps_transcript_mounts().len(), 1);
        draw(&mut app, width, 35);
        assert!(instance(&app).surface.viewport("app/body").is_some());
        assert_eq!(
            instance(&app)
                .surface
                .viewport("app/body/frame/content/root/bounded")
                .unwrap()
                .height,
            4
        );
        last_card_and_footer(&mut app, width);
    }
}
