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
        app.wait_for("label:File reading: On").unwrap();
        assert!(!app.screen().matches("label:Terminal tools: On").unwrap());
        app.press("role:button[Standard Session tools]").unwrap();
        app.wait_for("label:Install and manage plugins: Off")
            .unwrap();
        app.press("label:Extensions and other tools: On").unwrap();
        app.press("label:Terminal tools: On").unwrap();
        app.press("label:Conversations and memory: On").unwrap();
        app.wait_for("text:/Read and its aliases can also open existing references/")
            .unwrap();
        app.press("label:File reading: On").unwrap();
        app.wait_for("label:File reading: Off").unwrap();
        assert!(
            !app.screen()
                .matches("text:/Read and its aliases can also open existing references/")
                .unwrap()
        );
        app.press("label:File reading: Off").unwrap();
        app.press("role:button[Show selected tools]").unwrap();
        app.wait_for("text:DiscoveryComplete · Read · WebFetch · Write")
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
        app.wait_for("label:Terminal tools: Off").unwrap();
        app.press("role:button[Approve and resume]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.wait_for("role:button[Edit plan]").unwrap();
        app.press("role:button[Edit plan]").unwrap();
        app.press("role:button[Read-only tools]").unwrap();
        app.wait_for("label:File reading: On").unwrap();
        app.press("role:button[Standard Session tools]").unwrap();
        app.wait_for("text:3 of 7 groups selected").unwrap();
        app.type_text(
            "label:Investigation direction (optional)",
            "Review the release",
        )
        .unwrap();
        app.clear("label:Interval (minutes)").unwrap();
        app.wait_for("text:Enter a positive whole number of minutes.")
            .unwrap();
        app.type_text("label:Interval (minutes)", "45").unwrap();
        app.press("role:combobox[Check schedule]").unwrap();
        app.press("role:option[Fixed interval]").unwrap();
        app.press("role:combobox[Investigation model]").unwrap();
        app.press("role:option[Replacement model]").unwrap();
        app.wait_for("text:3 of 7 groups selected").unwrap();
        app.wait_for("role:button[Approve and save]").unwrap();
        app.press("role:button[Approve and save]").unwrap();
        app.wait_for("role:button[Close]").unwrap();
        app.press("role:button[Close]").unwrap();
        app.wait_for("text:Action update fixed 2700 replacement Review the release DiscoveryComplete · Read · WebFetch · Write").unwrap();
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
    fn discovery_draft_preserves_group_choices_when_switching_tool_presets() {
        let mut app = headless_fixture(
            "tests/fixtures/discovery.tsx",
            Size::new(px(1100.0), px(900.0)),
            false,
        );
        app.wait_for("role:button[Proactive discovery]").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.press("label:Conversations and memory: On").unwrap();
        app.press("role:button[Standard Session tools]").unwrap();
        app.wait_for("label:Terminal tools: On").unwrap();
        app.press("label:File reading: On").unwrap();
        app.press("role:button[Read-only tools]").unwrap();
        app.press("role:button[Approve and enable]").unwrap();

        app.wait_for("role:button[Edit plan]").unwrap();
        app.press("role:button[Edit plan]").unwrap();
        app.press("role:button[Show selected tools]").unwrap();
        app.wait_for("text:/^DiscoveryComplete$/").unwrap();

        app.press("role:button[Standard Session tools]").unwrap();
        app.wait_for("label:Extensions and other tools: Off")
            .unwrap();
        app.press("label:Extensions and other tools: Off").unwrap();
        app.press("label:Install and manage plugins: Off").unwrap();
        app.press("role:button[Approve and save]").unwrap();
        app.wait_for("role:button[Edit plan]").unwrap();
        app.press("role:button[Edit plan]").unwrap();
        app.wait_for("label:Install and manage plugins: On")
            .unwrap();
        app.press("role:button[Show selected tools]").unwrap();
        app.wait_for("text:DiscoveryComplete · PluginConfigure · mcp__sample__lookup")
            .unwrap();

        app.press("role:button[Cancel]").unwrap();
        app.wait_for("role:button[New plan]").unwrap();
        app.press("role:button[New plan]").unwrap();
        app.wait_for("text:2 of 2 groups selected").unwrap();
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
        app.wait_for("role:combobox[Investigation model]").unwrap();
        app.press("role:combobox[Investigation model]").unwrap();
        app.press("role:option[Replacement model]").unwrap();
        app.wait_for("label:File reading: Partially enabled (1/2)")
            .unwrap();
        app.press("role:button[Approve and resume]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.press("role:button[Close]").unwrap();
        app.wait_for("text:Action approved replacement DiscoveryComplete · DiscoveryMemory · Read")
            .unwrap();

        // A previously revoked preset can lack both an active grant and a saved selection.
        app.press_key("mod+shift+b").unwrap();
        app.press_key("mod+shift+r").unwrap();
        app.press("role:button[Proactive discovery]").unwrap();
        app.press("role:button[View background follow-ups]")
            .unwrap();
        app.wait_for("role:button[Review permissions]").unwrap();
        app.press("role:button[Review permissions]").unwrap();
        app.wait_for("text:Submit investigation results only")
            .unwrap();
        app.press("role:button[Standard Session tools]").unwrap();
        app.wait_for("label:File reading: Off").unwrap();
        app.press("label:File reading: Off").unwrap();
        app.press("role:button[Approve and resume]").unwrap();
        app.wait_for("role:button[Pause]").unwrap();
        app.press("role:button[Close]").unwrap();
        app.wait_for("text:Action approved replacement DiscoveryComplete · NewReader · Read")
            .unwrap();
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

    #[test]
    fn request_metrics_toggle_token_counts_independently() {
        let mut app = headless_fixture(
            "tests/fixtures/request-metrics.tsx",
            Size::new(px(460.0), px(420.0)),
            false,
        );
        app.wait_for("text:1h 43m 4s").unwrap();
        app.wait_for("text:325 ms").unwrap();
        app.wait_for("text:984").unwrap();
        app.wait_for("role:button[Context window (tokens): 4m · Show exact token count]")
            .unwrap();

        app.press("role:button[Estimated input tokens: 3.1k · Show exact token count]")
            .unwrap();
        app.wait_for("role:button[Estimated input tokens: 3,125 · Show compact token count]")
            .unwrap();
        assert!(app.shows("4m"));
        app.press("role:button[Context window (tokens): 4m · Show exact token count]")
            .unwrap();
        app.wait_for("text:4,000,000").unwrap();
        app.press("role:button[Estimated input tokens: 3,125 · Show compact token count]")
            .unwrap();
        app.wait_for("role:button[Estimated input tokens: 3.1k · Show exact token count]")
            .unwrap();
        assert!(app.shows("4,000,000"));
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
    fn stopping_an_agent_terminal_requires_confirmation() {
        let mut app = fixture("terminal-sidebar.tsx");
        app.set_viewport(Size::new(px(480.0), px(420.0))).unwrap();
        app.wait_for("role:button[View terminal]").unwrap();
        app.press("role:button[View terminal]").unwrap();
        app.wait_for("label:Back to Agent terminals").unwrap();
        app.press("label:Back to Agent terminals").unwrap();
        app.wait_for("label:Open terminal cargo test").unwrap();
        app.press("label:Open terminal cargo test").unwrap();

        app.wait_for("label:Stop terminal process").unwrap();
        app.press("label:Stop terminal process").unwrap();
        app.wait_for("text:Stop this agent command?").unwrap();
        app.press("role:button[Cancel]").unwrap();
        app.wait_for("text:/running.*Read only/").unwrap();
        app.press("label:Stop terminal process").unwrap();
        app.press("label:Confirm stop terminal process").unwrap();
        app.wait_for("text:/cancelled.*Read only/").unwrap();
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
    fn inline_dictation_cancels_or_inserts_at_the_original_caret() {
        let mut app = fixture("inline-dictation.tsx");
        app.wait_for("label:Microphone").unwrap();
        let bounds = |app: &nsh_testing::Headless, selector: &str| {
            let screen = app.screen();
            let id = screen.id(selector).unwrap();
            screen
                .layout_nodes()
                .into_iter()
                .find(|n| n.id == id)
                .unwrap()
                .bounds
        };
        let plus = bounds(&app, "label:Add to message").center();
        app.press("label:Microphone").unwrap();
        app.wait_for("text:Recording").unwrap();
        app.press("label:Cancel dictation").unwrap();
        app.wait_for("text:周五开会").unwrap();
        app.press("label:Microphone").unwrap();
        app.wait_for("label:Finish and transcribe").unwrap();
        assert_eq!(bounds(&app, "id:recording-dot").center(), plus);
        let cancel = bounds(&app, "label:Cancel dictation").origin;
        let status = bounds(&app, "text:Recording").origin;
        app.press("label:Finish and transcribe").unwrap();
        app.wait_for("text:Transcribing…").unwrap();
        assert_eq!(bounds(&app, "label:Transcribing…").center(), plus);
        assert_eq!(bounds(&app, "label:Cancel dictation").origin, cancel);
        assert_eq!(bounds(&app, "text:Transcribing…").origin, status);
        app.press("label:Release transcription").unwrap();
        app.wait_for("text:Transcription failed").unwrap();
        app.press("label:Retry transcription").unwrap();
        app.wait_for("text:周五下午开会").unwrap();
        app.wait_for("text:Unsent").unwrap();
        app.press("label:Microphone").unwrap();
        app.wait_for("label:Transcribe and send").unwrap();
        app.press("label:Transcribe and send").unwrap();
        app.wait_for("text:Sent: 周五下午下午开会").unwrap();
        app.wait_for("label:Microphone").unwrap();
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

    mod computer_stage {
        use super::*;
        use nsh_core::JsonValue;
        use serde_json::json;

        fn start() -> nsh_testing::Headless {
            start_with_reduce_motion(true)
        }

        fn start_with_reduce_motion(reduce_motion: bool) -> nsh_testing::Headless {
            start_with_clock(reduce_motion, nsh_core::time::Clock::default())
        }

        fn start_with_clock(
            reduce_motion: bool,
            clock: nsh_core::time::Clock,
        ) -> nsh_testing::Headless {
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
                ..Default::default()
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
                clock,
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
        fn a_presentation_action_reads_new_window_geometry_before_the_settle_deadline() {
            use nsh_core::{
                Bounds, EventKind, EventPayload,
                desktop::{WindowMode, WindowPlacement, WindowState},
                geometry::{point, size},
            };
            let mut app = start_with_clock(
                true,
                nsh_core::time::Clock::manual(std::time::SystemTime::UNIX_EPOCH),
            );
            let button = app.screen().id("label:Read native placement").unwrap();
            for x in [10., 350.] {
                let bounds = Bounds::new(point(px(x as f32), px(20.)), size(px(900.), px(720.)));
                let mut state =
                    WindowState::new(bounds, WindowPlacement::new(WindowMode::Normal, bounds));
                let mut native = nsh_core::desktop::NativeDesktopBounds::default();
                native.x = (x as f32).into();
                native.y = 20_f32.into();
                native.width = 900_f32.into();
                native.height = 720_f32.into();
                state.native_content_bounds = Some(native);
                let control = app.engine().control();
                control.set_environment(Environment {
                    os: Os::MacOs,
                    reduce_motion: true,
                    window_state: Some(state),
                    ..Environment::default()
                });
                control.dispatch_event(button, EventKind::Press, EventPayload::None);
                app.wait_for(&format!("text:Placement {x}")).unwrap();
            }
        }

        #[test]
        fn stage_rear_selects_and_front_presents_current_target_without_changing_pin() {
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
            for (index, id) in ["a", "b"].into_iter().enumerate() {
                load(&mut app, id, index, 1200, 800);
                decode(&mut app, id, true);
            }
            app.hover("label:Target a").unwrap();
            app.press("label:Pin target").unwrap();
            app.press("label:Target b").unwrap();
            app.wait_for("text:Selected b pinned true").unwrap();
            app.wait_for("text:Frame b presented true image-b").unwrap();
            app.wait_for("text:Presented none").unwrap();
            streams(&mut app, 1, 1);
            app.press("label:Target b").unwrap();
            app.wait_for("text:Presented none").unwrap();
            app.wait_for("text:Fault none").unwrap();
            load(&mut app, "b", 2, 1200, 800);
            decode(&mut app, "b", true);
            app.press("label:Target b").unwrap();
            app.wait_for("text:Presented b@1:binding:feed-2").unwrap();
            app.wait_for("text:Selected b pinned true").unwrap();
            send(
                &mut app,
                json!({"kind":"notice", "targetId":"b", "sequences":[2]}),
            );
            send(
                &mut app,
                json!({"kind":"resolve", "index":3, "sequence":2, "revision":1,
                "marker":"updated-b", "width":1200, "height":800}),
            );
            app.wait_for("text:Frame b presented true updated-b")
                .unwrap();
            app.wait_for("text:Selected b pinned true").unwrap();
            app.wait_for("text:Lifetimes a:1/0,b:1/0").unwrap();
            app.press("label:Target b").unwrap();
            app.wait_for("text:Presented b@1:binding:feed-2,b@1:binding:feed-2")
                .unwrap();
            app.wait_for("text:Selected b pinned true").unwrap();
            streams(&mut app, 1, 1);
            app.wait_for("text:Reads 4 maxBusy 1 after 0,0,0,1")
                .unwrap();
            app.wait_for("text:Fault none").unwrap();
        }

        #[test]
        fn stage_presentations_require_fresh_frames_after_target_binding_source_and_visibility_boundaries()
         {
            for boundary in ["removal", "revision", "binding", "source", "visibility"] {
                let mut app = start();
                stage(&mut app, "session-1", "binding", 1, &["a"], Some("a"), 1);
                streams(&mut app, 1, 1);
                load(&mut app, "a", 0, 800, 1200);
                decode(&mut app, "a", true);
                app.wait_for("text:Frame a presented true image-a").unwrap();
                app.press("label:Target a").unwrap();
                app.wait_for("text:Presented a@1:binding:feed-1").unwrap();
                match boundary {
                    "removal" => stage(&mut app, "session-1", "binding", 2, &[], None, 1),
                    "revision" => stage(&mut app, "session-1", "binding", 2, &["a"], Some("a"), 2),
                    "binding" => stage(
                        &mut app,
                        "session-1",
                        "new-binding",
                        1,
                        &["a"],
                        Some("a"),
                        1,
                    ),
                    "source" => send(&mut app, json!({"kind":"source", "sessionId":"session-2"})),
                    "visibility" => send(&mut app, json!({"kind":"visible", "value":false})),
                    _ => unreachable!(),
                }
                pixels(&mut app, "none");
                assert!(
                    app.press("label:Target a").is_err(),
                    "{boundary} exposed a retired target action"
                );
                app.wait_for("text:Presented a@1:binding:feed-1").unwrap();
                if boundary == "removal" {
                    stage(&mut app, "session-1", "binding", 3, &["a"], Some("a"), 1);
                    load(&mut app, "a", 1, 800, 1200);
                    decode(&mut app, "a", true);
                    app.wait_for("text:Frame a presented true image-a").unwrap();
                    app.wait_for("text:Presented a@1:binding:feed-1").unwrap();
                    app.press("label:Target a").unwrap();
                    app.wait_for("text:Presented a@1:binding:feed-1,a@1:binding:feed-2")
                        .unwrap();
                }
            }
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
        fn stage_tracks_the_session_content_corner_when_the_pane_moves_and_resizes() {
            for (source_width, source_height) in [(1200, 800), (800, 1200)] {
                for count in [1, 5] {
                    let mut app = start();
                    app.set_viewport(Size::new(px(1600.), px(1200.))).unwrap();
                    let ids = ["a", "b", "c", "d", "e"];
                    stage(
                        &mut app,
                        "session-1",
                        "binding",
                        1,
                        &ids[..count],
                        Some("a"),
                        1,
                    );
                    streams(&mut app, 1, 1);
                    for (index, id) in ids[..count].iter().enumerate() {
                        load(&mut app, id, index, source_width, source_height);
                        decode(&mut app, id, true);
                    }
                    if count == 5 {
                        app.hover("label:Target a").unwrap();
                        app.press("label:Pin target").unwrap();
                    }
                    for (left, top, width, height, long_edge) in [
                        (240., 120., 550., 500., 240.),
                        (100., 40., 780., 650., 327.6),
                        (80., 20., 1480., 1000., 480.),
                        (140., 80., 700., 420., 252.),
                        (240., 120., 550., 500., 240.),
                        (240., 120., 550., 280., if count == 5 { 136. } else { 192. }),
                    ] {
                        send(
                            &mut app,
                            json!({"kind":"pane", "left":left, "top":top, "width":width, "height":height}),
                        );
                        let cards = measured(&mut app);
                        assert_eq!(cards.len(), count);
                        let front = cards.iter().find(|card| card.0 == "a").unwrap();
                        assert!(
                            (front.1 + front.3 - (left + width - 24.)).abs() < 0.6,
                            "{front:?}"
                        );
                        assert!((front.2 - (top + 24.)).abs() < 0.6, "{front:?}");
                        assert!(
                            (front.3.max(front.4) - long_edge).abs() < 0.6,
                            "resize must change the card: {front:?}, expected {long_edge}"
                        );
                        for card in &cards {
                            assert!(
                                (card.3 / card.4 - source_width as f64 / source_height as f64)
                                    .abs()
                                    < 0.01
                            );
                            assert!(
                                card.1 >= left
                                    && card.2 >= top
                                    && card.1 + card.3 <= left + width
                                    && card.2 + card.4 <= top + height,
                                "card escaped its pane: {card:?}"
                            );
                        }
                        app.wait_for("text:Frame a presented true image-a").unwrap();
                        app.wait_for(&format!("text:Selected a pinned {}", count == 5))
                            .unwrap();
                        app.wait_for("text:Streams 1/1 closed 0").unwrap();
                        let lifetimes = ids[..count]
                            .iter()
                            .map(|id| format!("{id}:1/0"))
                            .collect::<Vec<_>>()
                            .join(",");
                        app.wait_for(&format!("text:Lifetimes {lifetimes}"))
                            .unwrap();
                    }
                    assert!(
                        !app.screen().commands().iter().any(|(_, command)| matches!(command, nsh_core::Command::Desktop(value) if matches!(value.as_ref(), nsh_core::desktop::DesktopCommand::OpenWindow(_))))
                    );
                }
            }
        }

        #[test]
        fn stage_docks_at_all_four_corners_and_keeps_the_chosen_corner_on_resize_hide_and_cancel() {
            use nsh_core::{EventKind, EventPayload, geometry::point};
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
            load(&mut app, "a", 0, 1200, 800);
            decode(&mut app, "a", true);
            load(&mut app, "b", 1, 800, 1200);
            decode(&mut app, "b", true);
            app.hover("label:Target a").unwrap();
            app.press("label:Pin target").unwrap();
            let anchored =
                |app: &nsh_testing::Headless, left: bool, bottom: bool, width: f32, height: f32| {
                    let screen = app.screen();
                    let id = screen.id("label:Computer").unwrap();
                    let node = screen
                        .layout_nodes()
                        .into_iter()
                        .find(|node| node.id == id)
                        .unwrap();
                    let bounds = node.bounds;
                    let horizontal = if left {
                        bounds.origin.x.0 - 140.
                    } else {
                        140. + width - bounds.origin.x.0 - bounds.size.width.0
                    };
                    let vertical = if bottom {
                        80. + height - bounds.origin.y.0 - bounds.size.height.0
                    } else {
                        bounds.origin.y.0 - 80.
                    };
                    assert!(
                        (horizontal - 8.).abs() < 0.6 && (vertical - 8.).abs() < 0.6,
                        "corner did not stay anchored: {bounds:?}, left={left}, bottom={bottom}"
                    );
                };
            anchored(&app, false, false, 700., 600.);
            for (dx, dy, left, bottom) in [
                (-500., 0., true, false),
                (0., 450., true, true),
                (500., 0., false, true),
                (0., -450., false, false),
                (-500., 450., true, true),
            ] {
                app.drag_and_hold("label:Target b", point(px(dx), px(dy)))
                    .unwrap();
                app.drop_held().unwrap();
                anchored(&app, left, bottom, 700., 600.);
                app.wait_for("text:Selected a pinned true").unwrap();
                app.wait_for("text:Presented none").unwrap();
                let screen = app.screen();
                let nodes = screen.layout_nodes();
                let bounds = |label| {
                    let id = screen.id(label).unwrap();
                    nodes.iter().find(|node| node.id == id).unwrap().bounds
                };
                let card = bounds("label:Target a");
                for label in ["label:Unpin target", "label:Hide live view"] {
                    let control = bounds(label);
                    assert!(
                        control.origin.x.0 >= card.origin.x.0 - 0.6
                            && control.origin.y.0 >= card.origin.y.0 - 0.6
                            && control.origin.x.0 + control.size.width.0
                                <= card.origin.x.0 + card.size.width.0 + 0.6
                            && control.origin.y.0 + control.size.height.0
                                <= card.origin.y.0 + card.size.height.0 + 0.6,
                        "{label} escaped the front card after docking: {control:?} in {card:?}"
                    );
                }
            }
            send(
                &mut app,
                json!({"kind":"pane","left":140,"top":80,"width":600,"height":520}),
            );
            anchored(&app, true, true, 600., 520.);
            let node = app.screen().id("label:Computer").unwrap();
            app.engine().control().dispatch_event(
                node,
                EventKind::PanEnd,
                EventPayload::PanCancelled {
                    translation: point(px(500.), px(-450.)),
                    velocity_x: 0.,
                    velocity_y: 0.,
                    value_x: None,
                    value_y: None,
                },
            );
            app.next_frame(std::time::Duration::from_millis(16))
                .unwrap();
            anchored(&app, true, true, 600., 520.);
            app.press("label:Hide live view").unwrap();
            app.press("label:Show live view").unwrap();
            streams(&mut app, 1, 1);
            load(&mut app, "a", 2, 1200, 800);
            decode(&mut app, "a", true);
            load(&mut app, "b", 3, 800, 1200);
            decode(&mut app, "b", true);
            anchored(&app, true, true, 600., 520.);
            app.wait_for("text:Selected a pinned true").unwrap();
            app.wait_for("text:Presented none").unwrap();
            app.wait_for("text:Fault none").unwrap();
        }

        #[test]
        fn stage_drag_holds_its_offset_until_release_then_returns_home_without_selecting() {
            use nsh_core::{MountItem, animation::Animator, geometry::point};
            use std::sync::{Arc, Mutex};
            for (reduced, pinned) in [(false, false), (true, false), (false, true)] {
                let mut app = start_with_clock(
                    reduced,
                    nsh_core::time::Clock::manual(std::time::SystemTime::UNIX_EPOCH),
                );
                send(&mut app, json!({"kind":"mounted", "value":false}));
                let samples = Arc::new(Mutex::new(Vec::<MountItem>::new()));
                let observed = samples.clone();
                app.observe(move |_, batch| {
                    observed.lock().unwrap().extend(batch.items.iter().cloned())
                });
                send(&mut app, json!({"kind":"mounted", "value":true}));
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
                load(&mut app, "a", 0, 800, 600);
                decode(&mut app, "a", true);
                app.wait_for("text:Frame a presented true image-a").unwrap();
                load(&mut app, "b", 1, 800, 600);
                decode(&mut app, "b", true);
                app.wait_for("text:Frame b presented false image-b")
                    .unwrap();
                if pinned {
                    app.hover("label:Target a").unwrap();
                    app.press("label:Pin target").unwrap();
                }
                app.wait_for(&format!("text:Selected a pinned {pinned}"))
                    .unwrap();
                let node = app.screen().id("label:Computer").unwrap();
                let mut native = Animator::default();
                let mut consumed = 0;
                let apply = |native: &mut Animator, consumed: &mut usize| {
                    let items = samples.lock().unwrap();
                    for item in &items[*consumed..] {
                        native.apply(item);
                    }
                    *consumed = items.len();
                };
                apply(&mut native, &mut consumed);
                native.tick(0.);
                // The renderer drives the same native pan bindings as the headless pointer.
                native.pan_began(node);
                native.pan_moved(node, point(px(-120.), px(60.)));
                app.drag_and_hold("label:Target b", point(px(-120.), px(60.)))
                    .unwrap();
                apply(&mut native, &mut consumed);
                native.tick(1.);
                assert_eq!(native.pan_values(node), (Some(-120.), Some(60.)));
                app.run_for(std::time::Duration::from_millis(500)).unwrap();
                apply(&mut native, &mut consumed);
                native.tick(2.);
                assert_eq!(native.pan_values(node), (Some(-120.), Some(60.)));
                app.drop_held().unwrap();
                apply(&mut native, &mut consumed);
                native.tick(2.);
                if !reduced {
                    native.tick(2.1);
                    let (x, y) = native.pan_values(node);
                    assert!(x.unwrap() > -120. && x.unwrap() < 0.);
                    assert!(y.unwrap() > 0. && y.unwrap() < 60.);
                    native.tick(4.);
                }
                let (x, y) = native.pan_values(node);
                assert!(x.unwrap().abs() < 0.01 && y.unwrap().abs() < 0.01);
                app.wait_for(&format!("text:Selected a pinned {pinned}"))
                    .unwrap();
                app.press("label:Target b").unwrap();
                app.wait_for(&format!("text:Selected b pinned {pinned}"))
                    .unwrap();
                app.wait_for("text:Fault none").unwrap();
            }
        }

        #[test]
        fn stage_long_title_toolbar_stays_inside_the_front_card_when_hovered_and_pinned() {
            for (width, height) in [(1200, 800), (800, 1200)] {
                let mut app = start();
                app.set_viewport(Size::new(px(1600.), px(1200.))).unwrap();
                let ids = ["a", "b", "c", "d", "e"];
                let title = |id: &str| {
                    format!(
                        "http://127.0.0.1:51128/fixture#owned=stage-long-title-3adaef0fdfce4beeb2bce62e0d43801a&target={id}"
                    )
                };
                let targets: Vec<_> = ids
                    .iter()
                    .map(|id| {
                        json!({
                            "id": id, "title": title(id), "kind": "browser", "revision": 1,
                        })
                    })
                    .collect();
                send(
                    &mut app,
                    json!({"kind":"stage", "value": {
                        "sessionId":"session-1", "bindingId":"binding", "revision":1,
                        "targets":targets, "activeTargetId":"a",
                    }}),
                );
                streams(&mut app, 1, 1);
                for (index, id) in ids.iter().enumerate() {
                    load(&mut app, id, index, width, height);
                    decode(&mut app, id, true);
                }
                app.wait_for("text:Frame a presented true image-a").unwrap();
                app.hover(&format!("label:{}", title("a"))).unwrap();

                let check = |app: &mut nsh_testing::Headless, pinned: bool| {
                    let front = measured(app)
                        .into_iter()
                        .find(|card| card.0 == "a")
                        .unwrap();
                    let screen = app.screen();
                    let nodes = screen.layout_nodes();
                    let pin = screen
                        .id(if pinned {
                            "label:Unpin target"
                        } else {
                            "label:Pin target"
                        })
                        .unwrap();
                    let hide = screen.id("label:Hide live view").unwrap();
                    let pin_node = nodes.iter().find(|node| node.id == pin).unwrap();
                    let toolbar = nodes
                        .iter()
                        .find(|node| node.id == pin_node.parent)
                        .unwrap();
                    let title_node = nodes
                        .iter()
                        .find(|node| {
                            node.parent == toolbar.id
                                && node
                                    .text
                                    .as_ref()
                                    .is_some_and(|text| text.text.text == title("a"))
                        })
                        .unwrap();
                    if front.3 >= 240. {
                        let title_width = title_node.text.as_ref().unwrap().content.size.width.0;
                        assert!(
                            title_width > 40.,
                            "wide cards must leave readable title space: {title_node:?}, toolbar={toolbar:?}"
                        );
                    }
                    let mut visible = vec![toolbar.id, title_node.id, pin, hide];
                    if pinned {
                        visible.push(screen.id("label:Follow agent").unwrap());
                    }
                    for id in visible {
                        let node = nodes.iter().find(|node| node.id == id).unwrap();
                        let left = f64::from(node.bounds.origin.x.0);
                        let right = left + f64::from(node.bounds.size.width.0);
                        let top = f64::from(node.bounds.origin.y.0);
                        let bottom = top + f64::from(node.bounds.size.height.0);
                        if id != toolbar.id {
                            let bar_left = f64::from(toolbar.bounds.origin.x.0);
                            let bar_top = f64::from(toolbar.bounds.origin.y.0);
                            assert!(
                                left >= bar_left - 0.6
                                    && right
                                        <= bar_left + f64::from(toolbar.bounds.size.width.0) + 0.6
                                    && top >= bar_top - 0.6
                                    && bottom
                                        <= bar_top + f64::from(toolbar.bounds.size.height.0) + 0.6,
                                "control escaped toolbar background: {node:?}, toolbar={toolbar:?}"
                            );
                        }
                        assert!(
                            left >= front.1 - 0.6
                                && right <= front.1 + front.3 + 0.6
                                && top >= front.2 - 0.6
                                && bottom <= front.2 + front.4 + 0.6,
                            "toolbar and its controls must fit the front card: {node:?}, front={front:?}, toolbar={toolbar:?}"
                        );
                    }
                    let toolbar_right =
                        f64::from(toolbar.bounds.origin.x.0 + toolbar.bounds.size.width.0);
                    assert!((toolbar_right - (front.1 + front.3 - 8.)).abs() < 0.6);
                };
                for (width, height) in [(550, 500), (1150, 900), (700, 600), (550, 280)] {
                    send(
                        &mut app,
                        json!({"kind":"pane", "left":140, "top":80, "width":width, "height":height}),
                    );
                    app.hover(&format!("label:{}", title("a"))).unwrap();
                    check(&mut app, false);
                }
                app.press("label:Pin target").unwrap();
                app.wait_for("label:Unpin target").unwrap();
                app.wait_for("label:Follow agent").unwrap();
                for (width, height) in [(550, 500), (1150, 900), (700, 600), (550, 280)] {
                    send(
                        &mut app,
                        json!({"kind":"pane", "left":140, "top":80, "width":width, "height":height}),
                    );
                    check(&mut app, true);
                }
                app.press("label:Follow agent").unwrap();
                app.wait_for("text:Selected a pinned false").unwrap();
                app.press("label:Hide live view").unwrap();
                streams(&mut app, 1, 0);
            }
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
                            (293.5..=294.5).contains(&long),
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
                            (card.1 - front.1 + depth as f64 * 18.0).abs() < 0.6,
                            "wrong horizontal stack offset: {cards:?}"
                        );
                        assert!(
                            (card.2 - front.2 - depth as f64 * 14.0).abs() < 0.6,
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
            assert_eq!(app.screen().count("label:Computer").unwrap(), 0);
            assert!(!app.shows("Live view unavailable"));
            stage(&mut app, "session-1", "binding", 1, &[], None, 1);
            assert_eq!(app.screen().count("label:Computer").unwrap(), 0);
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
            assert_eq!(app.screen().count("label:Computer").unwrap(), 0);
            assert!(!app.shows("Live view unavailable"));

            send(&mut app, json!({"kind":"source", "sessionId":"session-3"}));
            stage(&mut app, "session-3", "binding-3", 1, &["a"], Some("a"), 1);
            streams(&mut app, 1, 1);
            load(&mut app, "a", 2, 800, 600);
            decode(&mut app, "a", true);
            app.wait_for("text:Frame a presented true image-a").unwrap();
            send(
                &mut app,
                json!({"kind":"failure", "method":"presentTarget", "reason":"Window presentation refused"}),
            );
            app.press("label:Target a").unwrap();
            app.wait_for("text:Window presentation refused").unwrap();
            stage(&mut app, "session-3", "binding-3", 2, &[], None, 1);
            streams(&mut app, 1, 0);
            assert_eq!(app.screen().count("label:Computer").unwrap(), 0);
            assert!(!app.shows("Live view unavailable"));
            assert!(!app.shows("Window presentation refused"));
        }
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

        assert!(!app.screen().matches("text:Speed").unwrap());
        app.press("label:Use Sol · ChatGPT").unwrap();
        app.wait_for("label:Ultrafast").unwrap();
        app.press("label:Ultrafast").unwrap();
        app.wait_for("text: · Ultrafast").unwrap();
        app.press("label:Choose reasoning effort").unwrap();
        app.press("label:Use effort high").unwrap();
        app.wait_for("text: · high · Ultrafast").unwrap();
        app.press("label:Fast").unwrap();
        app.wait_for("text: · high · Fast").unwrap();
        app.press("label:Default").unwrap();
        app.wait_for("text: · high").unwrap();
        app.press("label:Use Plain model · DeepSeek").unwrap();
        app.wait_for("text:Unsupported").unwrap();
        assert!(!app.screen().matches("text:Speed").unwrap());

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
        assert!(!app.screen().matches("label:Support effort high").unwrap());
        app.press("label:Use provider reasoning efforts: On")
            .unwrap();
        app.wait_for("label:Use provider reasoning efforts: Off")
            .unwrap();
        assert!(app.screen().enabled("label:Support effort high").unwrap());
        app.wait_for("text:Save").unwrap();

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
