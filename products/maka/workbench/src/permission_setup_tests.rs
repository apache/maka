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
    Size,
    element::Instance,
    platform::{ColorScheme, Environment, Os, Renderer},
    prelude::px,
};

#[nsh_core::element::class]
struct LocaleHost;
#[nsh_core::element::class]
impl LocaleHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
}

fn setup(color_scheme: ColorScheme) -> nsh_testing::Headless {
    setup_with_native_drag(color_scheme, false)
}

fn setup_with_native_drag(color_scheme: ColorScheme, native_drag: bool) -> nsh_testing::Headless {
    let mut registry = nsh_core::element::Registry::ui_set("maka/host");
    registry.value("host", || Instance::new(LocaleHost));
    let sets = vec![nsh_base::registry(), registry];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: std::path::Path::new("tests/fixtures/computer-permission-setup.tsx")
            .canonicalize()
            .unwrap(),
        minify: false,
        split: false,
        ui_sets: sets.iter().map(Into::into).collect(),
    })
    .unwrap();
    let host = nsh_engine::HostChannel::new();
    host.set_params(serde_json::Map::from_iter([
        ("nativeApplicationDrag".into(), native_drag.into()),
        ("permissionRequestDenied".into(), native_drag.into()),
    ]));
    nsh_testing::Headless::start(nsh_engine::EngineConfig {
        viewport: if native_drag {
            Size::new(px(480.0), px(520.0))
        } else {
            Size::new(px(560.0), px(700.0))
        },
        host,
        environment: Environment {
            os: Os::MacOs,
            renderer: Renderer::Native,
            native_focus_scopes: true,
            color_scheme,
            ..Environment::default()
        },
        ui_sets: sets,
        ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
    })
    .unwrap()
}

#[test]
fn permission_setup_advances_only_after_host_observation_and_done_never_cancels() {
    for appearance in [ColorScheme::Light, ColorScheme::Dark] {
        let mut app = setup(appearance);
        app.wait_for("role:button[Enable Accessibility…]").unwrap();
        app.wait_for("text:/requests=0 cancellations=0 closed=false/")
            .unwrap();
        app.press_key("enter").unwrap();
        app.wait_for("text:/requests=1 cancellations=0 closed=false/")
            .unwrap();
        app.wait_for("text:/Waiting for macOS/").unwrap();
        app.press("role:button[Approve OS prompt]").unwrap();
        app.wait_for("role:button[Enable Screen & System Audio Recording…]")
            .unwrap();
        app.press("role:button[Enable Screen & System Audio Recording…]")
            .unwrap();
        app.wait_for("text:/requests=2 cancellations=0 closed=false/")
            .unwrap();
        app.press("role:button[Approve OS prompt]").unwrap();
        app.wait_for("text:/Computer access is ready/").unwrap();
        app.press("role:button[Done]").unwrap();
        app.wait_for("text:/requests=2 cancellations=0 closed=true/")
            .unwrap();
    }
}

#[test]
fn permission_setup_can_close_during_os_request_without_cancelling_it() {
    let mut app = setup(ColorScheme::Light);
    app.wait_for("role:button[Enable Accessibility…]").unwrap();
    app.press("role:button[Enable Accessibility…]").unwrap();
    app.wait_for("text:/requests=1 cancellations=0 closed=false/")
        .unwrap();
    app.press_key("escape").unwrap();
    app.wait_for("text:/requests=1 cancellations=0 closed=true/")
        .unwrap();
    app.press("role:button[Approve OS prompt]").unwrap();
    app.wait_for("text:/requests=1 cancellations=0 closed=true/")
        .unwrap();
}

#[test]
fn native_drag_footer_stays_visible_at_minimum_size_and_errors_can_be_retried() {
    use nsh_core::{EventKind, EventPayload, MountItem};
    use std::sync::{Arc, Mutex};
    for appearance in [ColorScheme::Light, ColorScheme::Dark] {
        let mut app = setup_with_native_drag(appearance, true);
        let native = Arc::new(Mutex::new(None));
        let observed = native.clone();
        app.observe(move |_, batch| {
            for item in &batch.items {
                if let MountItem::Component { id, name } = item
                    && name.as_ref() == "maka.permissionApplication"
                {
                    *observed.lock().unwrap() = Some(*id);
                }
            }
        });
        app.wait_for("role:button[Enable Accessibility…]").unwrap();
        app.press("role:button[Enable Accessibility…]").unwrap();
        let tile =
            "label:Drag the app into the Accessibility list in System Settings, then turn it on.";
        app.wait_for(tile).unwrap();
        let node = native
            .lock()
            .unwrap()
            .expect("the real NativeNode was mounted");
        let failure = "Couldn’t start dragging. Try dragging the app again.";
        let diagnostic = "/private/test-only/application.app: dragging session was nil";
        app.engine().control().dispatch_event(
            node,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: "dragError".into(),
                data: serde_json::json!({ "message": diagnostic }),
            },
        );
        app.wait_for(&format!("text:{failure}")).unwrap();
        assert!(
            !app.screen()
                .texts()
                .iter()
                .any(|text| text.contains(diagnostic))
        );
        assert!(app.screen().matches(tile).unwrap());
        assert!(
            app.screen()
                .matches("role:button[Open Accessibility settings…]")
                .unwrap()
        );
        assert!(app.screen().matches("role:button[Close window]").unwrap());
        app.press("role:button[Open Accessibility settings…]")
            .unwrap();
        app.engine().control().dispatch_event(
            node,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: "dragStart".into(),
                data: serde_json::Value::Null,
            },
        );
        app.wait_for_gone(
            &format!("text:{failure}"),
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        app.wait_for("text:/requests=1 cancellations=0 closed=false/")
            .unwrap();
        app.press("role:button[Close window]").unwrap();
        app.wait_for("text:/requests=1 cancellations=0 closed=true/")
            .unwrap();
    }
}
