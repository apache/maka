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

use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, MountBatch, MountItem, NodeId,
    desktop::{
        DesktopCommand, Display, DisplayId, WindowEvent, WindowFrame, WindowMode, WindowPlacement,
        WindowRequest, WindowState,
    },
    element::Instance,
    geometry::{Bounds, point, px, size},
    platform::{Environment, Idiom, Os},
};
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
use std::{path::Path, sync::mpsc, time::Duration};

#[nsh_core::element::class]
struct LocaleHost;
#[nsh_core::element::class]
impl LocaleHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
}
struct Sink(mpsc::Sender<MountBatch>);
impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        self.0.send(batch).unwrap();
    }
}

// Use the engine without Headless's automatic window-state acknowledgements.
fn drain(engine: &Engine, rx: &mpsc::Receiver<MountBatch>) -> Vec<MountItem> {
    let (tx, done) = mpsc::channel();
    engine.control().flush(move |idle| tx.send(idle).unwrap());
    assert!(
        done.recv_timeout(Duration::from_secs(10)).unwrap(),
        "fixture did not settle"
    );
    rx.try_iter().flat_map(|batch| batch.items).collect()
}
fn commands(items: &[MountItem]) -> Vec<(NodeId, DesktopCommand)> {
    items
        .iter()
        .filter_map(|item| match item {
            MountItem::Command {
                id,
                command: Command::Desktop(command),
            } => Some((*id, command.as_ref().clone())),
            _ => None,
        })
        .collect()
}
fn opened(items: &[MountItem]) -> NodeId {
    let commands = commands(items);
    let windows: Vec<_> = commands
        .iter()
        .filter_map(|(id, cmd)| match cmd {
            DesktopCommand::OpenWindow(options) => {
                assert_eq!(options.options.attributes.activate, Some(false));
                Some(*id)
            }
            _ => None,
        })
        .collect();
    assert_eq!(windows.len(), 1, "{commands:?}");
    assert!(
        commands
            .iter()
            .all(|(_, cmd)| !matches!(cmd, DesktopCommand::Request(WindowRequest::Focus)))
    );
    windows[0]
}
fn removed(items: &[MountItem], window: NodeId) {
    assert!(
        items
            .iter()
            .any(|item| matches!(item, MountItem::Remove { id } if *id == window)),
        "window root was not removed: {window}"
    );
}
fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<nsh_core::Points> {
    Bounds::new(point(px(x), px(y)), size(px(w), px(h)))
}
fn state(bounds: Bounds<nsh_core::Points>) -> WindowState {
    let mut state = WindowState::new(bounds, WindowPlacement::new(WindowMode::Normal, bounds));
    state.display = Some(DisplayId(1));
    state
}
fn report(engine: &Engine, id: NodeId, state: WindowState) {
    engine.control().dispatch_event(
        id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::State(Box::new(state)))),
    );
}
fn resized(items: &[MountItem], id: NodeId, bounds: Bounds<nsh_core::Points>) {
    assert_eq!(
        commands(items),
        vec![(
            id,
            DesktopCommand::Request(WindowRequest::SetBounds(WindowFrame {
                x: Some(bounds.origin.x),
                y: Some(bounds.origin.y),
                width: Some(bounds.size.width),
                height: Some(bounds.size.height),
                ..WindowFrame::default()
            }))
        )]
    );
}
fn status(items: &[MountItem], expected: &str) {
    assert!(
        items
            .iter()
            .any(|item| matches!(item, MountItem::Text { text, .. } if text.text == expected)),
        "missing {expected}: {items:?}"
    );
}

#[test]
fn stage_waits_for_native_state_and_retires_old_sources() {
    let mut registry = maka_workbench::bindings::ui_registry();
    registry.value("host", || Instance::new(LocaleHost));
    let sets = vec![nsh_base::registry(), registry];
    let module = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: Path::new("tests/fixtures/computer-stage-window.tsx")
            .canonicalize()
            .unwrap(),
        minify: false,
        split: false,
        ui_sets: sets.iter().map(Into::into).collect(),
    })
    .unwrap();
    let area = rect(0., 24., 1200., 776.);
    let mut parent = state(rect(100., 100., 800., 600.));
    parent.content_bounds = rect(110., 130., 780., 570.);
    parent.focused = true;
    let mut capabilities = nsh_engine::Capabilities::all();
    capabilities.host = vec!["*".into()];
    let bundle = Bundle::source(module.code).with_policy(nsh_engine::Policy {
        declared: Some(capabilities),
        ..nsh_engine::Policy::development()
    });
    let config = EngineConfig {
        viewport: size(px(800.), px(600.)),
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            window_state: Some(parent),
            ..Default::default()
        },
        ui_sets: sets,
        ..EngineConfig::new(bundle)
    };
    let host = config.host.clone();
    let (tx, rx) = mpsc::channel();
    let engine = Engine::start(config, || ApproxTextEngine, Sink(tx)).unwrap();
    engine.control().set_displays(vec![Display::new(
        DisplayId(1),
        rect(0., 0., 1200., 800.),
        area,
        true,
    )]);
    let first = drain(&engine, &rx);
    let old = opened(&first);
    assert!(
        !commands(&first)
            .iter()
            .any(|(_, cmd)| matches!(cmd, DesktopCommand::Request(WindowRequest::SetBounds(_))))
    );
    host.send("size", serde_json::json!({"width":257,"height":472}))
        .unwrap();
    assert!(
        commands(&drain(&engine, &rx)).is_empty(),
        "size before native state must wait"
    );
    let initial = state(rect(500., 400., 1., 1.));
    report(&engine, old, initial.clone());
    resized(&drain(&engine, &rx), old, rect(625., 138., 257., 472.));
    // Old bounds and focus reports must not re-run placement.
    for focused in [true, false] {
        let mut feedback = initial.clone();
        feedback.focused = focused;
        report(&engine, old, feedback);
        assert!(commands(&drain(&engine, &rx)).is_empty());
    }
    report(&engine, old, state(rect(300., 200., 257., 472.)));
    assert!(commands(&drain(&engine, &rx)).is_empty());
    // Desired content can shrink and return before native acknowledges either resize.
    host.send("size", serde_json::json!({"width":160,"height":72}))
        .unwrap();
    resized(&drain(&engine, &rx), old, rect(300., 200., 160., 72.));
    host.send("size", serde_json::json!({"width":257,"height":472}))
        .unwrap();
    resized(&drain(&engine, &rx), old, rect(300., 200., 257., 472.));
    host.send("size", serde_json::json!({"width":300.2,"height":400.1}))
        .unwrap();
    resized(&drain(&engine, &rx), old, rect(300., 200., 301., 401.));

    host.send("owner", serde_json::json!({"sessionId":"source-2"}))
        .unwrap();
    let replaced = drain(&engine, &rx);
    let next = opened(&replaced);
    assert_ne!(next, old);
    status(&replaced, "disposed:1;visible:true");
    removed(&replaced, old);
    report(&engine, old, initial.clone());
    host.send("late-size", serde_json::json!({"width":999,"height":999}))
        .unwrap();
    assert!(commands(&drain(&engine, &rx)).is_empty());
    report(&engine, next, initial.clone());
    resized(&drain(&engine, &rx), next, rect(581., 138., 301., 401.));
    host.send("binding", serde_json::json!("binding-2"))
        .unwrap();
    let rebound = drain(&engine, &rx);
    let last = opened(&rebound);
    assert_ne!(last, next);
    status(&rebound, "disposed:2;visible:true");
    removed(&rebound, next);
    report(&engine, last, initial);
    resized(&drain(&engine, &rx), last, rect(581., 138., 301., 401.));
    // Keep a dragged panel inside the display when its content grows.
    report(&engine, last, state(rect(1150., 790., 301., 401.)));
    assert!(commands(&drain(&engine, &rx)).is_empty());
    host.send("size", serde_json::json!({"width":400,"height":500}))
        .unwrap();
    resized(&drain(&engine, &rx), last, rect(800., 300., 400., 500.));
    host.send("owner", serde_json::Value::Null).unwrap();
    let closed = drain(&engine, &rx);
    status(&closed, "disposed:3;visible:true");
    removed(&closed, last);
}
