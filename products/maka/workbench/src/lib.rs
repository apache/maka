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

//! The shared NSH bootstrap and native Host bindings used by each shell.
//! The deployment selects its root UI from ordinary installed packages.

mod attachment_paths;
pub mod bindings;
mod clipboard;
mod composer_input;
pub mod host;
mod live_image;
pub mod reload;

use nsh_engine::{Bundle, Capabilities, EngineConfig, Limits, Policy};
use tokio::sync::watch;

/// Whether the terminal or window the workbench shows in is in the
/// foreground; the shell puts it in the engine context. Without one the
/// workbench counts as in the background.
#[derive(Clone)]
pub struct Foreground(pub watch::Receiver<bool>);

/// Reads and previews interface scale from the shell's pixel renderer.
/// The shell puts it in the engine context.
pub struct UiScale {
    pub preview: Box<dyn Fn(f32) -> Result<(), String> + Send + Sync>,
    pub current: Box<dyn Fn() -> Result<f32, String> + Send + Sync>,
}

/// The common loader for trusted UI packages, without a product root or assets.
pub fn bootstrap_bundle() -> Bundle {
    let mut capabilities = Capabilities::all();
    capabilities.host = vec!["*".into()];
    Bundle::source(include_str!(concat!(env!("OUT_DIR"), "/bootstrap.js")).into()).with_policy(
        Policy {
            declared: Some(capabilities),
            ..Policy::development()
        },
    )
}

/// The dedicated, trusted system-permission surface; it observes original interactions.
fn system_permission_bundle() -> Bundle {
    let mut capabilities = Capabilities::all();
    capabilities.host = vec![
        "computerPermissions.close".into(),
        "appearance.textSize".into(),
    ];
    Bundle::source(include_str!(concat!(env!("OUT_DIR"), "/computer-permission-setup.js")).into())
        .with_policy(Policy {
            declared: Some(capabilities),
            ..Policy::development()
        })
}

/// Runs the UI bootstrap with the admitted Host bindings on `runtime`.
/// The backend sets the viewport and environment it presents in.
pub fn configuration(
    registry: nsh_core::element::Registry,
    runtime: tokio::runtime::Handle,
) -> EngineConfig {
    EngineConfig {
        header_heights: nsh_core::NO_NATIVE_HEADER,
        limits: Limits::standalone(),
        ui_sets: vec![nsh_base::registry(), registry],
        network: Some(nsh_engine::net::network()),
        runtime: Some(runtime),
        ..EngineConfig::new(bootstrap_bundle())
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Size,
        element::Instance,
        platform::{Environment, Os},
        prelude::px,
    };

    #[nsh_core::element::class]
    struct CompletionHost;

    #[nsh_core::element::class]
    impl CompletionHost {
        #[getter]
        pub fn system_locale(&self) -> String {
            "en".into()
        }
    }

    fn completion_fixture() -> nsh_testing::Headless {
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", || Instance::new(CompletionHost));
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/composer-completion.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .unwrap();
        nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(480.0), px(200.0)),
            environment: Environment {
                os: Os::MacOs,
                native_focus_scopes: true,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap()
    }

    #[test]
    fn recycled_completion_cells_refresh_labels_and_press_actions() {
        let mut app = completion_fixture();
        app.wait_for("role:button[skill-00]").unwrap();
        app.scroll("label:Skills", px(900.0)).unwrap();
        app.wait_for("text:/Description of skill-15/").unwrap();
        app.press("role:button[skill-15]").unwrap();
        app.wait_for("text:/1:skill:skill-15/").unwrap();

        app.press("id:refresh").unwrap();
        app.press("role:button[skill-15]").unwrap();
        app.wait_for("text:/2:skill:skill-15/").unwrap();
    }

    #[test]
    fn pending_composer_selects_slash_skills_with_enter_and_tab() {
        let mut app = completion_fixture();
        app.wait_for("text:Open new chat").unwrap();
        app.press("id:pending").unwrap();
        app.type_text("label:New chat", "/skill-1").unwrap();
        app.wait_for("role:button[skill-11]").unwrap();
        app.press_key("down").unwrap();
        app.press_key("enter").unwrap();
        app.wait_for(r#"text:Draft "/skill:skill-11 ""#).unwrap();
        app.wait_for(r#"text:Submitted """#).unwrap();

        app.press_key("mod+a").unwrap();
        app.type_text("label:New chat", "/skill-15").unwrap();
        app.wait_for("role:button[skill-15]").unwrap();
        app.press_key("tab").unwrap();
        app.wait_for(r#"text:Draft "/skill:skill-15 ""#).unwrap();
        app.press_key("enter").unwrap();
        app.wait_for(r#"text:Submitted "/skill:skill-15 ""#)
            .unwrap();
    }

    #[test]
    fn skills_edit_as_units_and_sent_messages_preserve_copy_and_shortcuts() {
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", || Instance::new(CompletionHost));
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/skill-input.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .unwrap();
        let mut app = nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(640.0), px(480.0)),
            environment: Environment {
                os: Os::MacOs,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap();
        app.wait_for("text:Ready").unwrap();
        app.type_text("label:Draft", "").unwrap();
        for key in ["left", "left", "left", "shift+right", "mod+c"] {
            app.press_key(key).unwrap();
        }
        assert_eq!(app.screen().clipboard(), Some("/skill:review"));
        app.press_key("backspace").unwrap();
        app.wait_for(r#"text:Draft "前😀  后""#).unwrap();
        app.press_key("mod+z").unwrap();
        app.wait_for(r#"text:Draft "前😀 /skill:review 后""#)
            .unwrap();
        app.press_key("mod+a").unwrap();
        let mut paste = nsh_core::PasteEvent::new("a\nb");
        paste.html = "<pre>a\nb</pre>".into();
        app.paste("label:Draft", &paste).unwrap();
        app.wait_for(r#"text:Draft "a\nb""#).unwrap();
        let input = app
            .screen()
            .commands()
            .iter()
            .rev()
            .find_map(|(id, command)| matches!(command, nsh_core::Command::Focus).then_some(*id))
            .unwrap();
        let compose = |app: &mut nsh_testing::Headless, active| {
            app.engine().control().dispatch_event(
                input,
                nsh_core::EventKind::CompositionChange,
                nsh_core::EventPayload::Map(vec![
                    ("composing", nsh_core::PayloadValue::Bool(active)),
                    ("text", nsh_core::PayloadValue::Str(String::new())),
                ]),
            );
            app.wait_for(if active {
                "text:Composing"
            } else {
                "text:Idle"
            })
            .unwrap();
        };
        compose(&mut app, true);
        app.press_key("left").unwrap();
        app.wait_for("text:IME key released").unwrap();
        app.press("label:Reset").unwrap();
        app.wait_for(r#"text:Draft """#).unwrap();
        compose(&mut app, false);
        app.press_key("mod+z").unwrap();
        assert!(app.shows("Draft \"\""));
        app.press_key("mod+i").unwrap();
        app.wait_for(r#"text:Draft "/skill:fix ""#).unwrap();
        app.press_key("enter").unwrap();
        app.wait_for(r#"text:Submitted "/skill:fix ""#).unwrap();
        app.press_key("mod+a").unwrap();
        app.paste("label:Draft", &nsh_core::PasteEvent::new("ab"))
            .unwrap();
        compose(&mut app, true);
        app.press("label:Reset").unwrap();
        app.wait_for(r#"text:Draft """#).unwrap();
        app.engine().control().dispatch_event(
            input,
            nsh_core::EventKind::ChangeText,
            nsh_core::EventPayload::Text {
                text: "文".into(),
                count: 0,
            },
        );
        compose(&mut app, false);
        app.wait_for(r#"text:Draft "ab文""#).unwrap();
        assert!(app.type_text("label:前😀 /skill:review 后", "x").is_err());
        app.press("text:/前😀/").unwrap();
        app.press_key("mod+a").unwrap();
        app.press_key("mod+c").unwrap();
        assert_eq!(app.screen().clipboard(), Some("前😀 /skill:review 后"));
        app.press_key("mod+n").unwrap();
        app.wait_for("text:Shortcut received").unwrap();
    }

    mod computer_stage {
        use super::*;
        use nsh_core::JsonValue;
        use serde_json::json;

        fn start() -> nsh_testing::Headless {
            start_with_reduce_motion(true)
        }

        fn start_with_reduce_motion(reduce_motion: bool) -> nsh_testing::Headless {
            let mut registry = crate::bindings::ui_registry();
            registry.value("host", || Instance::new(CompletionHost));
            let sets = vec![nsh_base::registry(), registry];
            let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
                entry: std::path::Path::new("tests/fixtures/computer-stage.tsx")
                    .canonicalize()
                    .unwrap(),
                minify: false,
                split: false,
                ui_sets: sets.iter().map(Into::into).collect(),
            })
            .unwrap();
            let mut capabilities = nsh_engine::Capabilities::all();
            capabilities.host = vec!["*".into()];
            let bundle = nsh_engine::Bundle::source(bundle.code).with_policy(nsh_engine::Policy {
                declared: Some(capabilities),
                ..nsh_engine::Policy::development()
            });
            let mut app = nsh_testing::Headless::start(nsh_engine::EngineConfig {
                viewport: Size::new(px(900.0), px(720.0)),
                environment: Environment {
                    os: Os::MacOs,
                    reduce_motion,
                    ..Environment::default()
                },
                ui_sets: sets,
                ..nsh_engine::EngineConfig::new(bundle)
            })
            .unwrap();
            app.wait_for("text:Slots none").unwrap();
            streams(&mut app, 1, 0);
            app
        }

        fn send(app: &mut nsh_testing::Headless, command: JsonValue) {
            app.send_host_event("computer", command).unwrap();
        }

        fn stage(
            app: &mut nsh_testing::Headless,
            session: &str,
            binding: &str,
            revision: u64,
            ids: &[&str],
            active: Option<&str>,
            target_revision: u64,
        ) {
            let targets: Vec<_> = ids.iter().map(|id| json!({
                "id": id, "title": format!("Target {id}"), "kind": "browser", "revision": target_revision,
            })).collect();
            send(
                app,
                json!({"kind":"stage", "value": {
                    "sessionId": session, "bindingId": binding, "revision": revision,
                    "targets": targets, "activeTargetId": active,
                }}),
            );
        }

        fn streams(app: &mut nsh_testing::Headless, control: usize, frames: usize) {
            app.wait_for(&format!(
                "text:/^Streams {control}.{frames} closed [0-9]+$/"
            ))
            .unwrap();
        }

        fn pixels(app: &mut nsh_testing::Headless, value: &str) {
            app.wait_for(&format!("text:Pixels {value}")).unwrap();
        }

        fn notice(app: &mut nsh_testing::Headless, sequence: &[u64]) {
            send(
                app,
                json!({"kind":"notice", "targetId":"a", "sequences": sequence}),
            );
        }

        fn resolve(
            app: &mut nsh_testing::Headless,
            index: usize,
            sequence: u64,
            revision: u64,
            marker: &str,
        ) {
            send(
                app,
                json!({"kind":"resolve", "index":index, "sequence":sequence, "revision":revision, "marker":marker}),
            );
        }

        fn decode(app: &mut nsh_testing::Headless, id: &str, value: bool) {
            send(app, json!({"kind":"decode", "targetId":id, "value":value}));
        }

        fn load(app: &mut nsh_testing::Headless, id: &str, index: usize, width: u32, height: u32) {
            send(
                app,
                json!({"kind":"notice", "targetId":id, "sequences":[1]}),
            );
            app.wait_for(&format!("text:/^Reads {} maxBusy /", index + 1))
                .unwrap();
            send(
                app,
                json!({"kind":"resolve", "index":index, "sequence":1, "revision":1,
                "marker":format!("image-{id}"), "width":width, "height":height}),
            );
            app.wait_for(&format!("text:/^Pixels .*{id}:image-{id}/"))
                .unwrap();
        }

        #[test]
        fn stage_blurs_decoded_frames_on_entrance_and_clears_the_filter() {
            use nsh_core::transition::{Live, restyle};
            use std::sync::{Arc, Mutex};
            let radius = |style: &nsh_core::ViewStyle| {
                style
                    .effects
                    .as_ref()
                    .map_or(0., |effects| nsh_core::blur_radius(&effects.filters).0)
            };
            for cached_ready in [false, true] {
                let mut app = start_with_reduce_motion(false);
                send(
                    &mut app,
                    json!({"kind":"cached-ready", "value":cached_ready}),
                );
                let samples = Arc::new(Mutex::new(Vec::new()));
                let observed = samples.clone();
                app.observe(move |_, batch| {
                    for item in &batch.items {
                        if let nsh_core::MountItem::ViewStyle { id, style } = item {
                            observed.lock().unwrap().push((*id, style.clone()));
                        }
                    }
                });
                stage(&mut app, "session-1", "binding", 1, &["a"], Some("a"), 1);
                streams(&mut app, 1, 1);
                load(&mut app, "a", 0, 800, 600);
                decode(&mut app, "a", true);
                app.next_frame(std::time::Duration::from_secs(1)).unwrap();
                let samples = samples.lock().unwrap();
                let (card, initial) = samples
                    .iter()
                    .find(|(_, style)| radius(style) == 18.)
                    .expect("entrance starts blurred");
                let mut target = samples
                    .iter()
                    .rev()
                    .find(|(id, style)| id == card && radius(style) == 0.)
                    .expect("ready screenshot clears the same layer")
                    .1
                    .clone();
                // Native backends receive styles, then sample this transition themselves.
                let mut live = Live::default();
                live.restyle(restyle(initial, &mut target, false).expect("entrance must animate"));
                let mut frame = nsh_core::Bounds::default();
                live.step(0., &mut frame, &mut target);
                live.step(140., &mut frame, &mut target);
                assert!(radius(&target) > 0. && radius(&target) < 18.);
                assert!(live.step(280., &mut frame, &mut target).finished);
                assert_eq!(radius(&target), 0.);
            }
        }

        #[test]
        fn stage_auto_shows_stable_targets_and_user_pin_follow_hide_do_not_send_input() {
            let mut app = start();
            assert!(!app.shows("Computer"));
            stage(&mut app, "session-1", "binding", 1, &["a"], Some("a"), 1);
            app.wait_for("text:Slots a").unwrap();
            app.wait_for("text:Selected a pinned false").unwrap();
            streams(&mut app, 1, 1);
            load(&mut app, "a", 0, 800, 600);
            assert!(!app.shows("Frame a presented true image-a"));
            decode(&mut app, "a", true);
            app.wait_for("text:Frame a presented true image-a").unwrap();

            stage(
                &mut app,
                "session-1",
                "binding",
                2,
                &["c", "a", "b", "d", "e", "f"],
                Some("a"),
                1,
            );
            app.wait_for("text:Slots a,c,b,d,e").unwrap();
            assert!(!app.shows("Target f"));
            // Adding targets must retain the existing authorized front while they decode.
            pixels(&mut app, "a:image-a");
            app.wait_for("text:Frame a presented true image-a").unwrap();
            for (index, id) in ["c", "b", "d", "e"].into_iter().enumerate() {
                load(&mut app, id, index + 1, 800, 600);
                decode(&mut app, id, true);
            }
            app.hover("label:Target a").unwrap();
            app.press("label:Pin target").unwrap();
            stage(
                &mut app,
                "session-1",
                "binding",
                3,
                &["e", "d", "c", "b", "a", "f"],
                Some("b"),
                1,
            );
            app.wait_for("text:Slots a,c,b,d,e").unwrap();
            app.wait_for("text:Selected a pinned true").unwrap();
            app.wait_for("text:Lifetimes a:1/0,c:1/0,b:1/0,d:1/0,e:1/0")
                .unwrap();
            app.press("label:Target c").unwrap();
            app.wait_for("text:Selected c pinned true").unwrap();
            app.press("label:Follow agent").unwrap();
            app.wait_for("text:Selected b pinned false").unwrap();
            stage(
                &mut app,
                "session-1",
                "binding",
                4,
                &["f", "e", "d", "c", "b", "a"],
                Some("f"),
                1,
            );
            app.wait_for("text:Slots a,c,b,d,f").unwrap();
            app.wait_for("text:Selected f pinned false").unwrap();
            load(&mut app, "f", 5, 800, 600);
            decode(&mut app, "f", true);
            app.wait_for("text:Frame f presented true image-f").unwrap();
            notice(&mut app, &[2]);
            app.hover("label:Target f").unwrap();
            app.press("label:Hide live view").unwrap();
            streams(&mut app, 1, 0);
            pixels(&mut app, "none");
            assert!(!app.shows("Frame f presented true image-f"));
            resolve(&mut app, 6, 2, 1, "late-hidden");
            pixels(&mut app, "none");
            app.press("label:Show live view").unwrap();
            streams(&mut app, 1, 1);
            app.wait_for("text:Fault none").unwrap();
        }

        #[test]
        fn stage_latest_frames_are_bounded_and_revocation_source_visibility_and_owner_fence_late_work()
         {
            let mut app = start();
            stage(
                &mut app,
                "session-1",
                "binding",
                1,
                &["a", "b"],
                Some("a"),
                1,
            );
            streams(&mut app, 1, 1);
            notice(&mut app, &[1]);
            app.wait_for("text:Reads 1 maxBusy 1 after 0").unwrap();
            notice(&mut app, &[2, 3, 9]);
            app.wait_for("text:Reads 1 maxBusy 1 after 0").unwrap();
            resolve(&mut app, 0, 1, 1, "first");
            app.wait_for("text:Reads 2 maxBusy 1 after 0,1").unwrap();
            pixels(&mut app, "a:first");
            resolve(&mut app, 1, 9, 1, "latest");
            pixels(&mut app, "a:latest");
            app.wait_for("text:Reads 2 maxBusy 1 after 0,1").unwrap();

            // Selection is priority, not a new pixel owner: do not flash white.
            send(&mut app, json!({"kind":"select", "targetId":"b"}));
            app.wait_for("text:Selected b pinned false").unwrap();
            pixels(&mut app, "a:latest");
            notice(&mut app, &[1]); // Pending read from the now-revoked feed.
            app.wait_for("text:Reads 3 maxBusy 1 after 0,1,0").unwrap();
            // R1: same control revision and binding, but an empty revocation snapshot.
            stage(&mut app, "session-1", "binding", 1, &[], None, 1);
            app.wait_for("text:Slots none").unwrap();
            pixels(&mut app, "none");
            streams(&mut app, 1, 0);
            resolve(&mut app, 2, 1, 1, "revoked");
            pixels(&mut app, "none");

            stage(&mut app, "session-1", "binding", 2, &["a"], Some("a"), 1);
            streams(&mut app, 1, 1);
            notice(&mut app, &[1]);
            resolve(&mut app, 3, 1, 1, "origin-one");
            pixels(&mut app, "a:origin-one");
            notice(&mut app, &[2]);
            stage(&mut app, "session-1", "binding", 3, &["a"], Some("a"), 2);
            pixels(&mut app, "none");
            resolve(&mut app, 4, 2, 1, "late-origin-one");
            pixels(&mut app, "none");
            // Even a response on the new feed cannot display the old origin.
            notice(&mut app, &[1]);
            resolve(&mut app, 5, 1, 1, "wrong-origin");
            pixels(&mut app, "none");
            notice(&mut app, &[2]);
            resolve(&mut app, 6, 2, 2, "origin-two");
            pixels(&mut app, "a:origin-two");

            notice(&mut app, &[3]);
            send(&mut app, json!({"kind":"source", "sessionId":"session-1"}));
            app.wait_for("text:Slots none").unwrap();
            pixels(&mut app, "none");
            streams(&mut app, 1, 0);
            resolve(&mut app, 7, 3, 2, "old-host");
            pixels(&mut app, "none");
            stage(
                &mut app,
                "session-1",
                "new-binding",
                1,
                &["a"],
                Some("a"),
                1,
            );
            notice(&mut app, &[1]);
            send(&mut app, json!({"kind":"source", "sessionId":"session-2"}));
            resolve(&mut app, 8, 1, 1, "old-session");
            pixels(&mut app, "none");
            stage(&mut app, "session-2", "binding-2", 1, &["a"], Some("a"), 1);
            notice(&mut app, &[1]);
            send(&mut app, json!({"kind":"visible", "value":false}));
            streams(&mut app, 0, 0);
            pixels(&mut app, "none");
            resolve(&mut app, 9, 1, 1, "hidden");
            pixels(&mut app, "none");

            // Subscription admission can complete after hiding; it must be closed too.
            send(&mut app, json!({"kind":"visible", "value":true}));
            streams(&mut app, 1, 0);
            send(&mut app, json!({"kind":"hold", "method":"watchFrames"}));
            stage(&mut app, "session-2", "binding-2", 1, &["a"], Some("a"), 1);
            send(&mut app, json!({"kind":"visible", "value":false}));
            send(&mut app, json!({"kind":"release"}));
            streams(&mut app, 0, 0);
            send(&mut app, json!({"kind":"hold", "method":"watchStage"}));
            send(&mut app, json!({"kind":"visible", "value":true}));
            send(&mut app, json!({"kind":"source", "sessionId":"session-3"}));
            send(&mut app, json!({"kind":"release"}));
            streams(&mut app, 1, 0);

            stage(&mut app, "session-3", "binding-3", 1, &["a"], Some("a"), 1);
            notice(&mut app, &[1]);
            send(&mut app, json!({"kind":"mounted", "value":false}));
            streams(&mut app, 0, 0);
            app.wait_for("text:Unmounted").unwrap();
            resolve(&mut app, 10, 1, 1, "unmounted");
            send(&mut app, json!({"kind":"mounted", "value":true}));
            streams(&mut app, 1, 0);
            pixels(&mut app, "none");
            app.wait_for("text:Fault none").unwrap();
        }

        #[test]
        fn stage_requires_decode_but_pending_targets_do_not_block_healthy_frames() {
            let mut app = start();
            stage(
                &mut app,
                "session-1",
                "binding",
                1,
                &["a", "b", "c", "d", "e"],
                Some("a"),
                1,
            );
            streams(&mut app, 1, 1);
            for (index, id) in ["a", "b", "c", "d", "e"].into_iter().enumerate() {
                load(&mut app, id, index, 800, 600);
            }
            assert!(!app.shows("Frame a presented true image-a"));
            decode(&mut app, "a", true);
            app.wait_for("text:Frame a presented true image-a").unwrap();
            for id in ["b", "c", "d", "e"] {
                assert!(!app.shows(&format!("Frame {id} presented true image-{id}")));
                decode(&mut app, id, true);
                app.wait_for(&format!("text:Frame {id} presented false image-{id}"))
                    .unwrap();
            }
        }

        #[test]
        fn stage_selection_waits_for_decode_and_metadata_does_not_dispose_authorized_frames() {
            let mut app = start();
            stage(&mut app, "session-1", "binding", 1, &["a"], Some("a"), 1);
            streams(&mut app, 1, 1);
            load(&mut app, "a", 0, 800, 600);
            decode(&mut app, "a", true);
            app.wait_for("text:Frame a presented true image-a").unwrap();
            stage(
                &mut app,
                "session-1",
                "binding",
                2,
                &["a", "b"],
                Some("b"),
                1,
            );
            app.wait_for("text:Selected b pinned false").unwrap();
            pixels(&mut app, "a:image-a");
            app.wait_for("text:Frame a presented true image-a").unwrap();
            load(&mut app, "b", 1, 800, 600);
            app.wait_for("text:Frame a presented true image-a").unwrap();
            assert!(!app.shows("Frame b presented true image-b"));
            decode(&mut app, "b", true);
            app.wait_for("text:Frame b presented true image-b").unwrap();
            stage(
                &mut app,
                "session-1",
                "binding",
                3,
                &["b", "a"],
                Some("b"),
                1,
            );
            app.wait_for("text:Lifetimes a:1/0,b:1/0").unwrap();
            // A newer encoded frame must not blank the already-decoded authorized target.
            send(
                &mut app,
                json!({"kind":"notice", "targetId":"b", "sequences":[2]}),
            );
            resolve(&mut app, 2, 2, 1, "b-next");
            app.wait_for("text:Frame b presented true b-next").unwrap();
            stage(
                &mut app,
                "session-1",
                "binding",
                4,
                &["a", "b"],
                Some("b"),
                2,
            );
            pixels(&mut app, "none");
            assert!(!app.shows("Frame b presented true b-next"));
            app.wait_for("text:Lifetimes a:1/1,b:1/1").unwrap();
        }

        fn measured(app: &mut nsh_testing::Headless) -> Vec<(String, f64, f64, f64, f64)> {
            send(app, json!({"kind":"measure"}));
            app.wait_for("text:/^Bounds \\[/").unwrap();
            let text = app
                .screen()
                .texts()
                .into_iter()
                .find(|text| text.starts_with("Bounds ["))
                .unwrap();
            serde_json::from_str(text.strip_prefix("Bounds ").unwrap()).unwrap()
        }

        #[test]
        fn stage_portrait_landscape_and_two_to_five_cards_use_real_proportional_bounds() {
            for (width, height) in [(1200, 800), (800, 1200)] {
                let mut app = start();
                let ids = ["a", "b", "c", "d", "e"];
                for count in 1..=5 {
                    stage(
                        &mut app,
                        "session-1",
                        "binding",
                        count as u64,
                        &ids[..count],
                        Some("a"),
                        1,
                    );
                    streams(&mut app, 1, 1);
                    load(&mut app, ids[count - 1], count - 1, width, height);
                    decode(&mut app, ids[count - 1], true);
                    app.wait_for("text:Frame a presented true image-a").unwrap();
                    let cards = measured(&mut app);
                    assert_eq!(cards.len(), count, "all cards must remain native children");
                    let front = cards.iter().find(|card| card.0 == "a").unwrap();
                    for (depth, id) in ids[..count].iter().enumerate() {
                        let card = cards.iter().find(|card| card.0 == *id).unwrap();
                        let long = card.3.max(card.4);
                        assert!(
                            (399.0..=400.5).contains(&long),
                            "{id} became a thumbnail: {card:?}"
                        );
                        assert!(
                            (card.3 / card.4 - width as f64 / height as f64).abs() < 0.01,
                            "distorted aspect ratio: {card:?}"
                        );
                        assert!(
                            (card.3 - front.3).abs() < 0.6 && (card.4 - front.4).abs() < 0.6,
                            "back cards must not shrink: {cards:?}"
                        );
                        assert!(
                            (card.1 - front.1 + depth as f64 * 28.0).abs() < 0.6,
                            "wrong horizontal stack offset: {cards:?}"
                        );
                        assert!(
                            (card.2 - front.2 - depth as f64 * 22.0).abs() < 0.6,
                            "wrong vertical stack offset: {cards:?}"
                        );
                    }
                }
            }
        }

        #[test]
        fn stage_faults_expose_reason_and_explicit_retry_but_empty_and_normal_close_are_not_errors()
        {
            let mut app = start();
            app.wait_for("text:Content 0x0").unwrap();
            assert!(!app.shows("Live view unavailable"));
            stage(&mut app, "session-1", "binding", 1, &[], None, 1);
            app.wait_for("text:Content 0x0").unwrap();
            send(&mut app, json!({"kind":"end", "method":"watchStage"}));
            streams(&mut app, 0, 0);
            app.wait_for("text:Fault none").unwrap();
            assert!(!app.shows("Live view unavailable"));

            send(&mut app, json!({"kind":"source", "sessionId":"session-2"}));
            streams(&mut app, 1, 0);
            send(
                &mut app,
                json!({"kind":"failure", "method":"watchStage", "reason":"Control permission denied: owner revoked"}),
            );
            app.wait_for("text:Live view unavailable").unwrap();
            app.wait_for("text:Control permission denied: owner revoked")
                .unwrap();
            streams(&mut app, 0, 0);
            app.press("label:Retry live view").unwrap();
            streams(&mut app, 1, 0);
            assert!(!app.shows("Live view unavailable"));
            stage(&mut app, "session-2", "binding-2", 1, &["a"], Some("a"), 1);
            streams(&mut app, 1, 1);
            notice(&mut app, &[1]);
            send(
                &mut app,
                json!({"kind":"unavailable", "index":0, "reason":"Screen capture denied: target a"}),
            );
            app.wait_for("text:Screen capture denied: target a")
                .unwrap();
            app.press("label:Retry live view").unwrap();
            streams(&mut app, 1, 0);
            stage(&mut app, "session-2", "binding-2", 2, &["a"], Some("a"), 1);
            streams(&mut app, 1, 1);
            load(&mut app, "a", 1, 800, 600);
            decode(&mut app, "a", true);
            app.wait_for("text:Frame a presented true image-a").unwrap();
            assert!(!app.shows("Live view unavailable"));
            send(&mut app, json!({"kind":"end", "method":"watchFrames"}));
            streams(&mut app, 1, 0);
            pixels(&mut app, "none");
            assert!(!app.shows("Live view unavailable"));
            send(&mut app, json!({"kind":"end", "method":"watchStage"}));
            streams(&mut app, 0, 0);
            app.wait_for("text:Content 0x0").unwrap();
            assert!(!app.shows("Live view unavailable"));
        }
    }
}

#[cfg(test)]
mod desktop_residency_tests;
