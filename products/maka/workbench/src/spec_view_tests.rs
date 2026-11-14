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
struct SpecHost;

#[nsh_core::element::class]
impl SpecHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
}

fn spec_app(idiom: Idiom) -> Headless {
    let mut registry = crate::bindings::ui_registry();
    registry.value("host", || Instance::new(SpecHost));
    let sets = vec![nsh_base::registry(), registry];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: std::path::Path::new("tests/fixtures/spec-view.tsx")
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
        viewport: Size::new(px(1080.0), px(1600.0)),
        environment: Environment {
            os: Os::MacOs,
            idiom,
            ..Environment::default()
        },
        ui_sets: sets,
        ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
    })
    .unwrap()
}

fn text_index(app: &Headless, needle: &str) -> usize {
    app.screen()
        .texts()
        .into_iter()
        .position(|t| t == needle)
        .unwrap_or_else(|| panic!("expected `{needle}` on screen"))
}

fn verify_interactive_spec(idiom: Idiom) {
    let mut app = spec_app(idiom);
    app.wait_for("text:/Release Readiness/").unwrap();
    app.wait_for("text:/120 ms/").unwrap();
    app.wait_for("text:/gateway/").unwrap();

    // Open uncontrolled local UI state (source disclosure + Accordion) and mutate $state
    // while the Markdown ```spec fence is still streaming.
    app.press("role:button[Show spec source]").unwrap();
    app.wait_for("role:button[Hide spec source]").unwrap();
    app.press("role:button[Release Notes]").unwrap();
    app.wait_for("text:/Zero WebView runtime/").unwrap();
    app.press("role:button[Boost Cache]").unwrap();
    app.wait_for("text:/42 ms/").unwrap();

    // Focus $bindState Input and type partial text, then stream a new chunk via mod+n
    // without touching pointer focus; verify the exact native Input NodeId stays focused
    // and accepts subsequent keystrokes in place.
    app.type_text("label:Filter", "gp").unwrap();
    app.wait_for("text:/Filter: gp/").unwrap();
    let filter_node_before = app.screen().id("label:Filter").unwrap();

    app.press_key("mod+n").unwrap();
    app.wait_for("text:/Sparkline Ready/").unwrap();
    app.wait_for("text:/RPS Trend/").unwrap();
    assert_eq!(app.screen().id("label:Filter").unwrap(), filter_node_before);
    assert!(app.shows("Hide spec source"));
    assert!(app.shows("Zero WebView runtime"));
    assert!(app.shows("42 ms"));
    assert!(!app.shows("999 ms"));

    app.press_key("u").unwrap();
    app.wait_for("text:/Filter: gpu/").unwrap();

    // Table per-column sortable: false ("Notes") is not a button, while alphabetical and
    // natural numeric-suffix sorting ("node-1" < "node-2" < "node-10") reorder rows properly.
    assert_eq!(app.screen().matches("role:button[Notes]"), Ok(false));
    assert!(text_index(&app, "worker") < text_index(&app, "api"));

    app.press("role:button[Service]").unwrap();
    assert!(text_index(&app, "api") < text_index(&app, "gateway"));
    assert!(text_index(&app, "gateway") < text_index(&app, "worker"));

    app.press("role:button[Node]").unwrap();
    assert!(text_index(&app, "node-1") < text_index(&app, "node-2"));
    assert!(text_index(&app, "node-2") < text_index(&app, "node-10"));

    // Controls tab: NumberInput draft typing above/below min=10, cyclic watch guard, and Link.
    app.press("role:tab[Controls]").unwrap();
    app.wait_for("text:/Replicas: 12/").unwrap();
    app.clear("label:Min Replicas").unwrap();
    app.type_text("label:Min Replicas", "2").unwrap();
    assert!(!app.shows("Replicas: 10"));
    app.press_key("5").unwrap();
    app.submit("label:Min Replicas").unwrap();
    app.wait_for("text:/Replicas: 25/").unwrap();

    app.clear("label:Min Replicas").unwrap();
    app.type_text("label:Min Replicas", "3").unwrap();
    app.submit("label:Min Replicas").unwrap();
    app.wait_for("text:/Replicas: 10/").unwrap();

    app.press("role:button[Trigger Cycle]").unwrap();
    app.wait_for("text:/Cycle: 17/").unwrap();

    app.press("role:button[Runbook]").unwrap();
    app.wait_for("text:/Opened: https:\\/\\/example.com\\/runbook/")
        .unwrap();

    // Tabs with value="default" must render its panel once, never twice.
    app.press("role:tab[DefaultSlot]").unwrap();
    app.wait_for("text:/Single Default Panel/").unwrap();
    assert_eq!(app.screen().count("text:Single Default Panel"), Ok(1));

    // Native charts tab (LineChart + PieChart).
    app.press("role:tab[Charts]").unwrap();
    app.wait_for("text:/Throughput/").unwrap();
    app.wait_for("text:/Traffic Mix/").unwrap();
    app.wait_for("text:/Desktop/").unwrap();

    // Tasks tab: pushState with duplicate item id ("t-1") + repeat + validateForm.
    app.press("role:tab[Tasks]").unwrap();
    app.wait_for("text:/Ship Core/").unwrap();
    app.press("role:button[Add Task]").unwrap();
    app.wait_for("text:/Verify TUI/").unwrap();
    assert!(app.shows("Ship Core"));
    app.press("role:button[Validate Form]").unwrap();
    app.wait_for("text:/Form Checked/").unwrap();

    // Complete stream with a SECOND prefix-overlapping ```spec block in the same message;
    // Block 1 must retain its title and local state alongside Block 2 ("Canary Rollout", 77 ms).
    app.press("id:finish-stream").unwrap();
    app.wait_for("text:/All checks ready/").unwrap();
    app.wait_for("text:/Canary Rollout/").unwrap();
    app.wait_for("text:/77 ms/").unwrap();
    assert!(app.shows("Release Readiness"));
    assert!(app.shows("Hide spec source"));
    assert!(app.shows("42 ms"));
    assert!(app.shows("Filter: gpu"));
    assert!(app.shows("Zero WebView runtime"));
    assert!(!app.shows("999 ms"));

    // Parse-error fallback and clean recovery.
    app.press("id:break-spec").unwrap();
    app.wait_for("text:/Interface unavailable:/").unwrap();
    app.wait_for(r#"text:/"invalid": true/"#).unwrap();

    app.press("id:repair-spec").unwrap();
    app.wait_for("text:/Release Readiness/").unwrap();
    app.wait_for("text:/Canary Rollout/").unwrap();
    assert!(!app.shows("Interface unavailable:"));
}

#[test]
fn inline_spec_streams_interactively_on_desktop() {
    verify_interactive_spec(Idiom::Desktop);
}

#[test]
fn inline_spec_streams_interactively_on_terminal() {
    verify_interactive_spec(Idiom::Terminal);
}
