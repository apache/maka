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
use std::collections::BTreeSet;

fn populated(count: usize) -> App {
    let mut app = app();
    let view = View {
        version: VERSION,
        title: "Reader capacity".into(),
        revision: "original".into(),
        fields: vec![],
        actions: vec![],
        root: Node::Column {
            key: "root".into(),
            gap: 0,
            children: (0..count)
                .map(|index| Node::Transcript {
                    key: format!("reader-{index:03}"),
                    resource: wire::Resource {
                        route: serde_json::json!({"reader":index}),
                        ..resource("shared")
                    },
                })
                .collect(),
        },
    };
    view.validate().unwrap();
    instance_mut(&mut app).view = Some(view);
    app
}
fn path(index: usize) -> String {
    format!("root/reader-{index:03}")
}
fn content(index: usize) -> String {
    format!("Reader content {index:03}")
}

#[test]
fn more_than_thirty_two_readers_have_distinct_exact_tokens_and_content() {
    for count in [5, 32, 33, 64] {
        let mut app = populated(count);
        let mounts = app.apps_transcript_mounts();
        assert_eq!(mounts.len(), count);
        assert_eq!(
            mounts
                .iter()
                .map(|mount| mount.token)
                .collect::<BTreeSet<_>>()
                .len(),
            count
        );
        for (index, mount) in mounts.iter().enumerate() {
            assert!(!mount.token.is_nil());
            assert_eq!(mount.resource.route, serde_json::json!({"reader":index}));
            assert_eq!(mount.owner, instance_mut(&mut app).execution);
            assert_eq!(
                &mount.parent,
                &instance_mut(&mut app).entry.as_ref().unwrap().target
            );
            assert_eq!(
                app.apps.readers.token(&key(), &path(index)),
                Some(mount.token)
            );
            page(&mut app, mount.token, &content(index));
            assert_eq!(
                app.apps.readers.mounts[&(key(), path(index))]
                    .source
                    .blocks()[0]
                    .content
                    .text,
                content(index)
            );
        }
        let mut screen = draw(&mut app, 140, 512);
        instance_mut(&mut app)
            .surface
            .move_focus(format!("app/body/frame/content/{}", path(0)));
        for index in 0..count {
            let target = format!("app/body/frame/content/{}", path(index));
            assert_eq!(
                instance_mut(&mut app).surface.focused(),
                Some(target.as_str())
            );
            // Reader admission is independent of viewport capacity. Tab must
            // reveal every reader when their intrinsic heights need scrolling.
            if !screen.contains(&content(index)) {
                screen = draw(&mut app, 140, 512);
            }
            assert!(screen.contains(&content(index)), "reader {index}: {screen}");
            if index + 1 < count {
                app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
            }
        }
        assert_eq!(
            app.apps_transcript_mounts(),
            mounts,
            "ordinary reconcile never rebinds a reader"
        );
    }
}

#[test]
fn many_readers_keep_exact_tokens_when_a_hidden_node_is_replaced() {
    let count = 33;
    let mut app = populated(count);
    let admitted = app.apps_transcript_mounts();
    assert_eq!(admitted.len(), count);
    for (index, mount) in admitted.iter().enumerate() {
        page(&mut app, mount.token, &content(index));
    }
    assert_eq!(
        app.apps.readers.token(&key(), &path(32)),
        Some(admitted[32].token)
    );
    let screen = draw(&mut app, 140, 512);
    assert!(screen.contains(&content(32)), "{screen}");
    assert!(!screen.contains(&app.i18n.text("extensions-loading")));
    assert_eq!(app.apps_transcript_mounts(), admitted);

    let view = instance_mut(&mut app).view.as_mut().unwrap();
    view.revision = "first-hidden".into();
    let Node::Column { children, .. } = &mut view.root else {
        unreachable!()
    };
    children.remove(0);
    children.push(Node::Transcript {
        key: format!("reader-{count:03}"),
        resource: wire::Resource {
            route: serde_json::json!({"reader":count}),
            ..resource("shared")
        },
    });
    view.validate().unwrap();
    let replacement = app.apps_transcript_mounts();
    assert_eq!(replacement.len(), count);
    assert_eq!(app.apps.readers.token(&key(), &path(0)), None);
    for (index, previous) in admitted.iter().enumerate().skip(1) {
        assert_eq!(
            app.apps.readers.token(&key(), &path(index)),
            Some(previous.token)
        );
    }
    let fresh = app.apps.readers.token(&key(), &path(count)).unwrap();
    assert!(admitted.iter().all(|mount| mount.token != fresh));
    assert_eq!(
        replacement.last().unwrap().resource.route,
        serde_json::json!({"reader":count})
    );
    assert!(!app.apps_transcript_delivery(transport::Delivery {
        token: admitted[0].token,
        output: transport::Output::Event(wire::Event::Invalidated),
    }));
    page(&mut app, fresh, &content(count));
    let screen = draw(&mut app, 140, 512);
    assert!(screen.contains(&content(count)), "{screen}");
    assert!(
        !screen.contains(&content(0)),
        "the hidden reader cannot remain attached"
    );
}

#[test]
fn an_unmounted_reader_keeps_unavailable_feedback_without_claiming_a_count_limit() {
    let mut app = populated(1);
    let screen = draw(&mut app, 140, 40);
    assert!(
        screen.contains(&app.i18n.text("transcript-failed")),
        "{screen}"
    );
    let mount = app.apps_transcript_mounts().pop().unwrap();
    page(&mut app, mount.token, &content(0));
    let screen = draw(&mut app, 140, 40);
    assert!(screen.contains(&content(0)), "{screen}");
    assert!(!screen.contains(&app.i18n.text("transcript-failed")));
}
