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
    platform::{Environment, Idiom, Os},
    prelude::px,
};
use nsh_testing::Headless;

#[nsh_core::element::class]
struct PresetHost;
#[nsh_core::element::class]
impl PresetHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
}
fn start(idiom: Idiom) -> Headless {
    let mut registry = crate::bindings::ui_registry();
    registry.value("host", || Instance::new(PresetHost));
    let sets = vec![nsh_base::registry(), registry];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: std::path::Path::new("tests/fixtures/subagent-settings.tsx")
            .canonicalize()
            .unwrap(),
        minify: false,
        split: false,
        ui_sets: sets
            .iter()
            .flat_map(nsh_core::element::Registry::sets)
            .map(Into::into)
            .collect(),
        asset_root_from: Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")),
        ..Default::default()
    })
    .unwrap();
    let config = nsh_engine::EngineConfig {
        viewport: Size::new(px(400.0), px(800.0)),
        environment: Environment {
            os: Os::MacOs,
            idiom,
            ..Environment::default()
        },
        ui_sets: sets,
        ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
    };
    config.host.handle("fixture.outcome", |call| {
        call.resolve(serde_json::Value::Null);
    });
    Headless::start(config).unwrap()
}
#[test]
fn subagent_settings_desktop_and_terminal_keep_conflicting_drafts() {
    for idiom in [Idiom::Desktop, Idiom::Terminal] {
        let mut app = start(idiom);
        app.wait_for("text:No subagent presets.").unwrap();
        app.press("id:new").unwrap();
        app.type_text("label:Subagent name", "Reviewer").unwrap();
        app.type_text("label:Description", "Review Rust").unwrap();
        app.type_text(
            "label:Role instruction",
            "# Review\nPreserve complete instructions",
        )
        .unwrap();
        app.press("role:button[Choose model]").unwrap();
        app.wait_for("label:Search models and sources").unwrap();
        app.press("role:button[Test model]").unwrap();
        assert!(!app.screen().shows("Search models and sources"));
        app.press("role:button[Save subagent]").unwrap();
        app.wait_for("text:Reviewer").unwrap();
        app.press("role:button[Reviewer]").unwrap();
        app.wait_for("label:Role instruction").unwrap();
        assert_eq!(
            app.screen().input_text("label:Role instruction").unwrap(),
            Some("# Review\nPreserve complete instructions")
        );
        app.press("id:conflict").unwrap();
        app.type_text("label:Description", " locally edited")
            .unwrap();
        app.press("role:button[Save subagent]").unwrap();
        app.wait_for("text:These settings changed elsewhere. Reload before saving again.")
            .unwrap();
        assert!(
            app.screen()
                .input_text("label:Description")
                .unwrap()
                .unwrap()
                .contains("locally edited")
        );
        app.press("id:zh").unwrap();
        app.wait_for("label:子 Agent 名称").unwrap();
        app.press("id:tw").unwrap();
        app.wait_for("label:子 Agent 名稱").unwrap();
    }
}

#[test]
fn applied_subagent_details_keep_the_creation_snapshot_after_source_deletion() {
    let mut app = start(Idiom::Desktop);
    app.wait_for("text:No subagent presets.").unwrap();
    app.host()
        .send("fixture.details", serde_json::json!({}))
        .unwrap();
    app.wait_for("text:/Initial model: local / test/").unwrap();
    app.wait_for("text:/Current model: other / switched/")
        .unwrap();
    app.wait_for("text:/保留完整的角色指令/").unwrap();
    assert!(app.screen().shows("Reviewer"));
}
