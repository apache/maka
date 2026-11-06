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
        platform::{Environment, Os, Renderer},
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

    #[test]
    fn recycled_completion_cells_refresh_labels_and_press_actions() {
        let mut registry = nsh_core::element::Registry::ui_set("maka/host");
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
        let mut app = nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(480.0), px(200.0)),
            environment: Environment {
                os: Os::MacOs,
                renderer: Renderer::Native,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap();

        app.wait_for("role:button[skill-00]").unwrap();
        app.scroll("label:Skills", px(900.0)).unwrap();
        app.wait_for("text:/Description of skill-15/").unwrap();
        app.press("role:button[skill-15]").unwrap();
        app.wait_for("text:/1:skill:skill-15/").unwrap();

        app.press("id:refresh").unwrap();
        app.press("role:button[skill-15]").unwrap();
        app.wait_for("text:/2:skill:skill-15/").unwrap();
    }

    fn skill_input_fixture() -> nsh_testing::Headless {
        let mut registry = nsh_core::element::Registry::ui_set("maka/host");
        registry.value("host", || Instance::new(CompletionHost));
        registry.register::<crate::composer_input::ComposerInput>();
        registry.class::<crate::composer_input::ComposerInputState>();
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
                renderer: Renderer::Native,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap();
        app.wait_for("label:Draft").unwrap();
        app.wait_for("text:Editor ready").unwrap();
        app
    }

    #[test]
    fn skill_input_edits_and_copies_invocations_as_whole_nodes() {
        let mut app = skill_input_fixture();
        app.wait_for("text:Selection 19:19").unwrap();
        app.type_text("label:Draft", "").unwrap();
        for key in ["mod+right", "left", "left", "left"] {
            app.press_key(key).unwrap();
        }
        app.wait_for("text:Selection 4:4").unwrap();
        app.press_key("shift+right").unwrap();
        app.wait_for("text:Selection 4:17").unwrap();
        app.press_key("mod+c").unwrap();
        assert_eq!(app.screen().clipboard(), Some("/skill:review"));
        app.press_key("backspace").unwrap();
        app.wait_for(r#"text:Source "前😀  后""#).unwrap();
        app.press_key("mod+z").unwrap();
        app.wait_for(r#"text:Source "前😀 /skill:review 后""#)
            .unwrap();
        app.press_key("mod+a").unwrap();
        app.press_key("mod+c").unwrap();
        assert_eq!(app.screen().clipboard(), Some("前😀 /skill:review 后"));
        app.press_key("enter").unwrap();
        app.wait_for(r#"text:Submitted "前😀 /skill:review 后""#)
            .unwrap();
        app.press("label:Reset").unwrap();
        app.wait_for(r#"text:Source """#).unwrap();
        app.press_key("mod+z").unwrap();
        assert!(app.shows("Source \"\""));
        app.wait_for("text:Selection 0:0").unwrap();
        app.press_key("tab").unwrap();
        app.wait_for(r#"text:Source "/skill:fix ""#).unwrap();
    }

    #[test]
    fn skill_input_paste_grows_the_viewport_and_message_selection_keeps_source() {
        let mut app = skill_input_fixture();
        app.type_text("label:Draft", "").unwrap();
        app.press_key("mod+a").unwrap();
        app.paste(
            "label:Draft",
            &nsh_core::PasteEvent::new(
                "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n/skill:review",
            ),
        )
        .unwrap();
        assert_eq!(
            app.screen()
                .span_style("id:draft-field >> text:one")
                .unwrap()
                .line_height,
            px(24.0)
        );
        app.wait_for("text:Height 144").unwrap();
        app.press_key("mod+a").unwrap();
        app.press_key("mod+c").unwrap();
        assert_eq!(
            app.screen().clipboard(),
            Some("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n/skill:review")
        );
        app.type_text("label:前😀 /skill:review 后", "").unwrap();
        app.press_key("mod+a").unwrap();
        app.press_key("mod+c").unwrap();
        assert_eq!(app.screen().clipboard(), Some("前😀 /skill:review 后"));
        app.press_key("mod+n").unwrap();
        app.wait_for("text:App shortcut received").unwrap();
    }
}
