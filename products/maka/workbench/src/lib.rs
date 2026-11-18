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
        Points, Size,
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

    fn fixture(entry: &str) -> nsh_testing::Headless {
        headless_fixture(
            &format!("tests/fixtures/{entry}"),
            Size::new(px(480.0), px(200.0)),
            true,
        )
    }

    #[test]
    fn discovery_panel_approves_scope_controls_runs_and_rejects_stale_edits() {
        let mut app = headless_fixture(
            "tests/fixtures/discovery.tsx",
            Size::new(px(1100.0), px(900.0)),
            false,
        );
        app.wait_for("text:Earlier discovery").unwrap();
        app.wait_for("text:Please stop this recommendation.")
            .unwrap();
        app.wait_for("role:button[View investigation]").unwrap();
        app.press("role:button[View investigation] >> nth=0")
            .unwrap();
        app.wait_for("text:Opened original-worker").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.wait_for("text:/sample-command-code/").unwrap();
        app.wait_for("text:/isolated.sample/").unwrap();
        app.wait_for("text:/Investigation permissions.*Read-only tools/")
            .unwrap();
        app.press("role:button[Standard Session tools]").unwrap();
        app.wait_for("role:button[Choose tool groups]").unwrap();
        app.press("role:button[Choose tool groups]").unwrap();
        app.press("label:Terminal tools: On").unwrap();
        app.press("role:button[Show selected tools]").unwrap();
        app.wait_for("text:DiscoveryComplete · DiscoveryMemory · Read · WebFetch · Write")
            .unwrap();
        app.press("role:button[Approve and enable]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.wait_for("text:/Next check.*15:59:58/").unwrap();
        app.wait_for("text:/Last check.*15:49:27/").unwrap();
        app.press("role:button[Pause]").unwrap();
        app.wait_for("role:button[Resume]").unwrap();
        app.press("role:button[Resume]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.press_key("mod+shift+r").unwrap();
        app.wait_for("text:Needs renewed approval").unwrap();
        app.press("role:button[Review permissions]").unwrap();
        app.wait_for("role:button[Choose tool groups]").unwrap();
        app.press("role:button[Choose tool groups]").unwrap();
        app.wait_for("label:Terminal tools: Off").unwrap();
        app.press("role:button[Approve and resume]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.wait_for("role:button[Edit plan]").unwrap();
        app.press("role:button[Edit plan]").unwrap();
        app.press("role:button[Fixed interval]").unwrap();
        app.wait_for("role:button[Approve and save]").unwrap();
        app.press("role:button[Approve and save]").unwrap();
        app.wait_for("role:button[Close]").unwrap();
        app.press("role:button[Close]").unwrap();
        app.wait_for("text:Action update fixed 1800").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.wait_for("role:button[Edit plan]").unwrap();
        app.press("role:button[Edit plan]").unwrap();
        app.wait_for("role:button[Approve and save]").unwrap();
        app.press_key("mod+u").unwrap();
        app.press("role:button[Approve and save]").unwrap();
        app.wait_for("text:/The plan changed/").unwrap();
        app.press("role:button[Cancel]").unwrap();
        app.wait_for("role:button[Close]").unwrap();
        app.press("role:button[Close]").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.wait_for("role:button[Check now]").unwrap();
        app.press("role:button[Check now]").unwrap();
        app.wait_for("text:Investigating").unwrap();
        app.wait_for("text:/Next check.*Scheduled when this check ends/")
            .unwrap();
        app.press("role:button[View investigation] >> nth=0")
            .unwrap();
        app.press("role:button[Close]").unwrap();
        app.wait_for("text:Opened original-worker").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.wait_for("text:Investigating").unwrap();
        app.press_key("mod+shift+f").unwrap();
        app.wait_for("text:/Could not load the discovery plan/")
            .unwrap();
        app.press_key("mod+shift+e").unwrap();
        app.wait_for("text:Completed").unwrap();
        app.press("role:button[Delete]").unwrap();
        app.wait_for("text:Delete this plan?").unwrap();
        app.press("role:button[Delete] >> nth=1").unwrap();
        app.wait_for("role:button[Approve and enable]").unwrap();
    }

    #[test]
    fn discovery_panel_keeps_lone_background_followups_manageable_and_offers_a_replacement_model() {
        let mut app = headless_fixture(
            "tests/fixtures/discovery.tsx",
            Size::new(px(1100.0), px(900.0)),
            false,
        );
        app.wait_for("role:button[Proactive discovery]").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.wait_for("role:button[Approve and enable]").unwrap();
        app.press("role:button[Approve and enable]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.press_key("mod+shift+b").unwrap();
        app.press("role:button[Close]").unwrap();
        app.wait_for("role:button[Proactive discovery]").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.wait_for("role:button[View background follow-ups]")
            .unwrap();
        assert!(
            !app.screen()
                .matches("role:button[Approve and enable]")
                .unwrap()
        );
        app.press("role:button[View background follow-ups]")
            .unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.press("role:button[Hide background follow-ups]")
            .unwrap();
        app.wait_for("role:button[View background follow-ups]")
            .unwrap();
        app.press("role:button[View background follow-ups]")
            .unwrap();
        app.press("role:button[Pause]").unwrap();
        app.wait_for("role:button[Resume]").unwrap();
        app.press_key("mod+shift+m").unwrap();
        app.press("role:button[Resume]").unwrap();
        app.wait_for("role:button[Change model]").unwrap();
        app.press("role:button[Change model]").unwrap();
        app.wait_for("text:Opened models").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.wait_for("role:button[View background follow-ups]")
            .unwrap();
        app.press("role:button[View background follow-ups]")
            .unwrap();
        app.wait_for("role:button[Resume]").unwrap();
        app.press("role:button[Resume]").unwrap();
        app.wait_for("role:button[Approve and resume]").unwrap();
        app.press("role:button[Approve and resume]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.press("role:button[Close]").unwrap();
        app.wait_for("text:Action approved replacement").unwrap();
    }

    #[test]
    fn fullscreen_composer_removes_and_sends_quotes_without_typed_text() {
        let mut app = fixture("stage-quotes.tsx");
        app.wait_for("text:First selected passage").unwrap();
        app.press("role:button[Remove quote] >> nth=0").unwrap();
        assert!(!app.screen().matches("text:First selected passage").unwrap());
        app.wait_for("text:Second selected passage").unwrap();
        app.press("role:button[Send message]").unwrap();
        app.wait_for("text:Sent Second selected passage").unwrap();
        assert!(!app.screen().matches("role:button[Remove quote]").unwrap());
    }

    fn headless_fixture(
        entry: &str,
        viewport: Size<Points>,
        native_focus_scopes: bool,
    ) -> nsh_testing::Headless {
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", || Instance::new(CompletionHost));
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new(entry).canonicalize().unwrap(),
            minify: false,
            split: false,
            ui_sets: sets
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .map(Into::into)
                .collect(),
            asset_root_from: Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."),
            ),
            ..Default::default()
        })
        .unwrap();
        nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport,
            environment: Environment {
                os: Os::MacOs,
                native_focus_scopes,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap()
    }

    #[test]
    fn terminal_sidebar_restores_the_personal_shell_and_opens_the_exact_agent_resource() {
        let mut app = fixture("terminal-sidebar.tsx");
        app.set_viewport(Size::new(px(480.0), px(420.0))).unwrap();
        app.wait_for("role:button[View terminal]").unwrap();
        app.press("role:button[View terminal]").unwrap();
        app.wait_for("text:cargo fmt").unwrap();
        app.wait_for("text:/completed.*Read only/").unwrap();
        assert!(
            !app.screen()
                .matches("label:Terminal keyboard input")
                .unwrap()
        );

        app.press("label:Show conversation terminals").unwrap();
        app.wait_for("text:/maka/").unwrap();
        assert!(!app.screen().matches("text:cargo test").unwrap());
        app.press("label:New terminal").unwrap();
        app.wait_for("text:Shell 1").unwrap();
        app.wait_for("label:Terminal keyboard input").unwrap();
        app.press_key("enter").unwrap();
        app.wait_for("text:1: Enter reached shell-1").unwrap();
        app.press_key("ctrl+c").unwrap();
        app.wait_for("text:Interrupt reached shell-1").unwrap();
        app.paste(
            "label:Terminal keyboard input",
            &nsh_core::PasteEvent::new("printf demo"),
        )
        .unwrap();
        app.wait_for("text:Pasted into shell-1: printf demo")
            .unwrap();

        app.press("label:New terminal").unwrap();
        app.wait_for("text:Shell 2").unwrap();
        app.press("text:Shell 1").unwrap();
        app.press("role:button[Agent terminals]").unwrap();
        app.wait_for("text:cargo test").unwrap();
        assert!(!app.screen().matches("text:cargo fmt").unwrap());
        app.press_key("ctrl+c").unwrap();
        app.wait_for("text:Workbench interrupt").unwrap();
        app.press("role:button[Finished commands]").unwrap();
        app.wait_for("text:cargo fmt").unwrap();
        app.press("label:Open terminal cargo fmt").unwrap();
        app.wait_for("text:/completed.*Read only/").unwrap();
        assert!(
            !app.screen()
                .matches("label:Terminal keyboard input")
                .unwrap()
        );
        app.press("label:Show conversation terminals").unwrap();
        app.wait_for("label:Terminal keyboard input").unwrap();
        app.press_key("enter").unwrap();
        app.wait_for("text:2: Enter reached shell-1").unwrap();
    }

    #[test]
    fn original_tool_arguments_show_freeform_script_and_reject_another_tool() {
        let mut app = fixture("tool-source.tsx");
        app.wait_for(r"text:/const word = '雪'; text\(word\);/")
            .unwrap();
        app.wait_for("text:The original tool source could not be verified.")
            .unwrap();
    }

    #[test]
    fn recycled_completion_cells_refresh_labels_and_press_actions() {
        let mut app = fixture("composer-completion.tsx");
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
        let mut app = fixture("composer-completion.tsx");
        app.wait_for("text:Open new chat").unwrap();
        app.press("id:pending").unwrap();
        app.wait_for("label:New chat").unwrap();
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
            ui_sets: sets
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .map(Into::into)
                .collect(),
            asset_root_from: Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."),
            ),
            ..Default::default()
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

    #[test]
    fn model_select_switches_in_place_and_cascades_reasoning_effort() {
        let mut app = fixture("model-select.tsx");
        app.set_viewport(Size::new(px(640.0), px(480.0))).unwrap();
        app.wait_for("label:Choose model and effort").unwrap();
        app.press("label:Choose model and effort").unwrap();
        app.wait_for("label:Search models and sources").unwrap();
        app.wait_for("label:Manage models").unwrap();
        app.wait_for("text:Unsupported").unwrap();

        let bounds_of = |app: &nsh_testing::Headless, selector: &str| {
            let id = app.screen().id(selector).unwrap();
            app.screen()
                .layout_nodes()
                .into_iter()
                .find(|node| node.id == id)
                .unwrap()
                .bounds
        };
        let search_before = bounds_of(&app, "label:Search models and sources");
        let manage_before = bounds_of(&app, "label:Manage models");

        app.press_key("f6").unwrap();
        app.press("label:Use Reasoning model · OpenAI").unwrap();
        assert!(
            !app.screen()
                .enabled("label:Use Plain model · DeepSeek")
                .unwrap()
        );
        assert!(
            !app.screen()
                .enabled("label:Choose reasoning effort")
                .unwrap()
        );
        assert!(!app.screen().enabled("label:Manage models").unwrap());
        assert!(!app.screen().matches("text:Saving selection…").unwrap());

        app.press_key("f7").unwrap();
        assert!(
            app.screen()
                .matches("label:Search models and sources")
                .unwrap()
        );
        app.wait_for("text: · medium").unwrap();
        assert!(
            app.screen()
                .enabled("label:Choose reasoning effort")
                .unwrap()
        );
        assert_eq!(
            bounds_of(&app, "label:Search models and sources"),
            search_before
        );
        assert_eq!(bounds_of(&app, "label:Manage models"), manage_before);

        app.press("label:Choose reasoning effort").unwrap();
        app.wait_for("label:Use effort high").unwrap();
        app.press("label:Use effort high").unwrap();
        app.wait_for("text: · high").unwrap();
        assert!(!app.screen().matches("label:Use effort high").unwrap());
        assert!(
            app.screen()
                .matches("label:Search models and sources")
                .unwrap()
        );

        app.press("label:Use Plain model · DeepSeek").unwrap();
        app.wait_for("text:Unsupported").unwrap();
        assert!(
            !app.screen()
                .enabled("label:Choose reasoning effort")
                .unwrap()
        );
        assert!(
            app.screen()
                .matches("label:Search models and sources")
                .unwrap()
        );
        assert_eq!(bounds_of(&app, "label:Manage models"), manage_before);

        app.press("label:Manage models").unwrap();
        app.wait_for("text:Managed:1").unwrap();
        assert!(
            !app.screen()
                .matches("label:Search models and sources")
                .unwrap()
        );
    }

    #[test]
    fn models_settings_unifies_sources_without_inline_layout_jumps() {
        let mut app = fixture("models-settings.tsx");
        app.set_viewport(Size::new(px(1040.0), px(900.0))).unwrap();
        app.wait_for("label:Edit connection OpenAI").unwrap();
        app.wait_for("label:Checking external agents…").unwrap();

        app.press_key("f7").unwrap();
        app.wait_for("label:Disable Codex").unwrap();
        app.wait_for("text:0.42.0 · 5 models available").unwrap();
        app.wait_for("label:Enable Claude Code").unwrap();
        assert!(
            !app.screen()
                .matches("label:Checking external agents…")
                .unwrap()
        );
        assert!(!app.screen().matches("text:Details").unwrap());

        let y_of = |app: &nsh_testing::Headless, selector: &str| {
            let id = app.screen().id(selector).unwrap();
            app.screen()
                .layout_nodes()
                .into_iter()
                .find(|node| node.id == id)
                .unwrap()
                .bounds
                .origin
                .y
        };
        let codex_y = y_of(&app, "label:Disable Codex");

        app.press_key("f6").unwrap();
        app.set_environment("background", |env| {
            env.lifecycle = nsh_core::platform::Lifecycle::Background;
        })
        .unwrap();
        app.set_environment("active", |env| {
            env.lifecycle = nsh_core::platform::Lifecycle::Active;
        })
        .unwrap();
        assert!(app.screen().matches("label:Disable Codex").unwrap());
        assert!(!app.screen().enabled("label:Disable Codex").unwrap());
        assert!(
            !app.screen()
                .matches("label:Checking external agents…")
                .unwrap()
        );
        assert_eq!(y_of(&app, "label:Disable Codex"), codex_y);

        app.press_key("f7").unwrap();
        assert!(app.settle());
        assert!(app.screen().enabled("label:Disable Codex").unwrap());
        assert_eq!(y_of(&app, "label:Disable Codex"), codex_y);

        app.press("label:Enable Claude Code").unwrap();
        app.wait_for("text:Confirm permissions and enable").unwrap();
        app.press("label:Cancel enabling external agents").unwrap();
        app.wait_for("label:Edit connection OpenAI").unwrap();

        app.press("label:Edit connection OpenAI").unwrap();
        app.wait_for("label:Edit model gpt-4.1").unwrap();
        let model_row_y = y_of(&app, "label:Edit model gpt-4.1");
        app.type_text("label:API key", "sk-test").unwrap();
        app.wait_for("text:Save or discard the connection changes before editing models.")
            .unwrap();
        assert_eq!(y_of(&app, "label:Edit model gpt-4.1"), model_row_y);
        app.press("label:Discard changes and reload").unwrap();
        app.wait_for("label:Edit model gpt-4.1").unwrap();

        app.press("label:Edit model gpt-4.1").unwrap();
        app.wait_for("label:Use provider reasoning efforts: On")
            .unwrap();
        assert!(!app.screen().enabled("label:Support effort high").unwrap());
        let remove_model_y = y_of(&app, "text:Remove model");
        app.press("label:Use provider reasoning efforts: On")
            .unwrap();
        app.wait_for("label:Use provider reasoning efforts: Off")
            .unwrap();
        assert!(app.screen().enabled("label:Support effort high").unwrap());
        assert_eq!(y_of(&app, "text:Remove model"), remove_model_y);

        app.press_key("f8").unwrap();
        app.wait_for("text:Discard unsaved changes?").unwrap();
        app.press("text:Discard changes").unwrap();
        app.wait_for("label:Edit connection OpenAI").unwrap();
        app.wait_for("label:Disable Codex").unwrap();
    }
}

#[cfg(test)]
mod desktop_residency_tests;

#[cfg(test)]
mod preset_settings_tests;

#[cfg(test)]
mod spec_view_tests;
