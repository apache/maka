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
    Size, ViewKind,
    element::Instance,
    platform::{Environment, Idiom, Os},
    prelude::px,
};
use nsh_testing::Headless;

#[nsh_core::element::class]
struct ProviderIconsHost;

#[nsh_core::element::class]
impl ProviderIconsHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
}

fn start(idiom: Idiom) -> Headless {
    let mut registry = crate::bindings::ui_registry();
    registry.value("host", || Instance::new(ProviderIconsHost));
    let sets = vec![nsh_base::registry(), registry];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: std::path::Path::new("tests/fixtures/provider-icons.tsx")
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
    Headless::start(nsh_engine::EngineConfig {
        viewport: Size::new(px(720.0), px(900.0)),
        environment: Environment {
            os: Os::MacOs,
            idiom,
            native_focus_scopes: true,
            ..Environment::default()
        },
        ui_sets: sets,
        ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
    })
    .unwrap()
}

#[test]
fn provider_icons_render_brand_marks_default_indicator_and_fallbacks_on_desktop_and_terminal() {
    for idiom in [Idiom::Desktop, Idiom::Terminal] {
        let mut app = start(idiom);
        app.wait_for("text:Anthropic").unwrap();
        app.wait_for("text:ChatGPT").unwrap();
        app.wait_for("text:Acme Relay").unwrap();
        app.wait_for("text:Default").unwrap();
        app.wait_for("text:Antigravity").unwrap();
        app.wait_for("text:Codex").unwrap();
        app.wait_for("text:Claude Code").unwrap();
        app.wait_for("text:Zebra CLI").unwrap();

        let canvases = app
            .screen()
            .layout_nodes()
            .into_iter()
            .filter(|node| node.kind == ViewKind::Canvas)
            .count();
        let texts = app.screen().texts();
        if idiom == Idiom::Desktop {
            assert!(
                canvases >= 5,
                "desktop settings should draw Canvas brand marks: canvases={canvases}"
            );
            assert!(
                texts.iter().any(|text| *text == "A"),
                "unknown plugin connection should fall back to SettingsMonogram: {texts:?}"
            );
            assert!(
                texts.iter().any(|text| *text == "Z"),
                "unknown external runtime should fall back to SettingsMonogram: {texts:?}"
            );
        } else {
            assert_eq!(
                canvases, 0,
                "terminal settings should not mount desktop Canvas nodes"
            );
        }

        app.press("role:button[Choose model and effort]").unwrap();
        app.wait_for("text:Gemini 4").unwrap();
        app.wait_for("text:Acme Model").unwrap();
        let menu_canvases = app
            .screen()
            .layout_nodes()
            .into_iter()
            .filter(|node| node.kind == ViewKind::Canvas)
            .count();
        if idiom == Idiom::Desktop {
            assert!(
                menu_canvases > canvases,
                "desktop model menu should draw Canvas brand/fallback icons: before={canvases} after={menu_canvases}"
            );
        } else {
            assert_eq!(
                menu_canvases, 0,
                "terminal model menu should not mount desktop Canvas nodes"
            );
        }
        app.press_key("escape").unwrap();

        app.press("role:button[Add connection]").unwrap();
        app.wait_for("text:ChatGPT Subscription").unwrap();
        app.wait_for("text:Chat Completions").unwrap();
        app.wait_for("text:Google Gemini").unwrap();
        app.wait_for("text:DeepSeek").unwrap();
        app.wait_for("text:Acme Provider").unwrap();

        let picker_canvases = app
            .screen()
            .layout_nodes()
            .into_iter()
            .filter(|node| node.kind == ViewKind::Canvas)
            .count();
        if idiom == Idiom::Desktop {
            assert!(
                picker_canvases >= 5,
                "desktop provider picker should draw Canvas brand/fallback icons: {picker_canvases}"
            );
        } else {
            assert_eq!(
                picker_canvases, 0,
                "terminal provider picker should not mount desktop Canvas nodes"
            );
        }
    }
}
